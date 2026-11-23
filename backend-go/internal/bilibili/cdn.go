package bilibili

import (
	"context"
	"log"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// healthCheckTimeout 是单条媒体 URL 的探测上限。
const healthCheckTimeout = 3500 * time.Millisecond

// httpsCapableDomains 是已知支持 HTTPS 的 B站 CDN 域名。
//
// 协议升级不是锦上添花：HTTPS 页面里浏览器会直接拦截 http:// 媒体资源
// （Mixed Content），表现是播放器一直转圈、控制台报 blocked。
var httpsCapableDomains = []string{
	"bilivideo.com",
	"hdslb.com",
	"biliimg.com",
	"bilibili.com",
	"upos-hz-mirrorakam.akamaized.net",
	// 视频轨道 CDN 域名（edge 节点），与前端 url-proxy 白名单保持一致
	"mountaintoys.cn",
	"pili-video.com",
	"boss-pgc.com",
	"bstatic.com",
}

// UpgradeURLToHTTPS 把 B站 CDN 的 http 地址升级为 https（非 B站 域名原样返回）。
func UpgradeURLToHTTPS(raw string) string {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "http" {
		return raw
	}
	host := strings.ToLower(parsed.Hostname())
	capable := false
	for _, domain := range httpsCapableDomains {
		if host == domain || strings.HasSuffix(host, "."+domain) {
			capable = true
			break
		}
	}
	if !capable {
		return raw
	}
	parsed.Scheme = "https"
	if parsed.Port() == "80" {
		parsed.Host = parsed.Hostname()
	}
	return parsed.String()
}

// mcdnHostSuffix 是 B站 P2P 回源节点（mcdn）的域名后缀。
//
// 这类节点靠客户端 P2P 网络回源，对「服务器 / CLI 直连」场景天然不可靠：
// 常见表现是 443/8082 不通，或上游直接回 502。而 playurl 的 baseUrl 有一定
// 概率就落在 mcdn 上——一旦跳过探测（CLI 房主直链就是这样），死链会被原样
// 交给播放器，用户看到的就是「点开 502、重新解析还是 502」。
const mcdnHostSuffix = ".mcdn.bilivideo.cn"

// isMcdnURL 判断地址是否落在 mcdn P2P 节点上。
func isMcdnURL(raw string) bool {
	parsed, err := url.Parse(raw)
	if err != nil {
		return false
	}
	host := strings.ToLower(parsed.Hostname())
	return host == strings.TrimPrefix(mcdnHostSuffix, ".") || strings.HasSuffix(host, mcdnHostSuffix)
}

// orderTrackCandidates 把主 + 备地址按「非 mcdn 优先」重排。
//
// 稳定分区而不是全排序：B站 给的候选顺序本身带优先级（同地域 upos 在前），
// 只把 mcdn 这一档整体挪到最后，其余保持原序。
func orderTrackCandidates(base string, backups []string) []string {
	all := make([]string, 0, 1+len(backups))
	if base != "" {
		all = append(all, base)
	}
	for _, backup := range backups {
		if backup != "" {
			all = append(all, backup)
		}
	}
	if len(all) == 0 {
		return nil
	}
	ordered := make([]string, 0, len(all))
	for _, candidate := range all {
		if !isMcdnURL(candidate) {
			ordered = append(ordered, candidate)
		}
	}
	for _, candidate := range all {
		if isMcdnURL(candidate) {
			ordered = append(ordered, candidate)
		}
	}
	return ordered
}

// MediaTrackCandidate 是一条待探测的媒体地址（主 + 备）。
type MediaTrackCandidate struct {
	BaseURL   string
	BackupURL []string
}

// cdnProbeClient 供 HEAD 探测复用，避免每次新建连接池。
var cdnProbeClient = &http.Client{Timeout: healthCheckTimeout}

// 探测结果缓存：同一签名地址在短时间内的重复解析不再重复 HEAD。
//
// 为什么需要：一次 playurl 要对视频/音频两条轨的主 + 备地址各探一次，而
// 同一首歌在一个会话里会被解析多次（首次播放、歌词页背景、直链失效自愈）。
// 这些解析拿到的往往是**完全相同的签名 URL**，重复 HEAD 既慢又白耗 CDN
// 侧的签名额度（B站 的签名地址是有使用次数/流量约束的消耗品）。
const (
	probeCacheTTL = 60 * time.Second
	probeCacheMax = 512
)

type probeCacheEntry struct {
	ok bool
	at time.Time
}

var probeCache = struct {
	mu    sync.Mutex
	items map[string]probeCacheEntry
}{items: make(map[string]probeCacheEntry)}

func readProbeCache(raw string) (bool, bool) {
	probeCache.mu.Lock()
	defer probeCache.mu.Unlock()
	entry, ok := probeCache.items[raw]
	if !ok {
		return false, false
	}
	if time.Since(entry.at) > probeCacheTTL {
		delete(probeCache.items, raw)
		return false, false
	}
	return entry.ok, true
}

func writeProbeCache(raw string, ok bool) {
	probeCache.mu.Lock()
	defer probeCache.mu.Unlock()
	if len(probeCache.items) >= probeCacheMax {
		for key, entry := range probeCache.items {
			if time.Since(entry.at) > probeCacheTTL {
				delete(probeCache.items, key)
			}
		}
		// 仍超量就直接重建：探测结果只是加速用，丢了最多多探一次
		if len(probeCache.items) >= probeCacheMax {
			probeCache.items = make(map[string]probeCacheEntry)
		}
	}
	probeCache.items[raw] = probeCacheEntry{ok: ok, at: time.Now()}
}

// checkURLReachable 用 HEAD + Range 探测单条 URL。
//
// 接受 2xx 与 405：部分 CDN 不允许 HEAD（返回 405）但 GET 正常，
// 把 405 当不可达会让这些 CDN 上的资源被误判为全部失效。
func checkURLReachable(ctx context.Context, raw string) bool {
	if ok, hit := readProbeCache(raw); hit {
		return ok
	}
	reqCtx, cancel := context.WithTimeout(ctx, healthCheckTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodHead, raw, nil)
	if err != nil {
		return false
	}
	req.Header.Set("Referer", "https://www.bilibili.com")
	req.Header.Set("Origin", "https://www.bilibili.com")
	req.Header.Set("User-Agent", defaultUserAgent)
	req.Header.Set("Range", "bytes=0-0")

	resp, err := cdnProbeClient.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	ok := (resp.StatusCode >= 200 && resp.StatusCode < 400) || resp.StatusCode == http.StatusMethodNotAllowed
	writeProbeCache(raw, ok)
	return ok
}

// mcdnProbeDelay 是 mcdn 候选的探测延迟：存在非 mcdn 候选时，让后者先占位。
//
// 原因：mcdn 是 P2P 边缘节点，RTT 往往比 upos 更低，并行探测时「先到先得」
// 会优先选中它——但它恰恰是最容易在服务器/CLI 侧回源失败的一档。延迟不改变
// 结论（非 mcdn 全不可达时仍会探测 mcdn），只调整优先级。
const mcdnProbeDelay = 300 * time.Millisecond

// FindReachableMediaURL 并行探测主地址与备用地址，返回第一个可达的 URL。
//
// 用「先到先得」而不是顺序尝试：顺序方案在全部不可达时要串行等满
// N × 3.5s，而一次解析里音视频各一轮，用户会明显感到卡顿。
func FindReachableMediaURL(ctx context.Context, candidate MediaTrackCandidate) (string, bool) {
	base := UpgradeURLToHTTPS(candidate.BaseURL)
	backups := make([]string, 0, len(candidate.BackupURL))
	for _, backup := range candidate.BackupURL {
		if upgraded := UpgradeURLToHTTPS(backup); upgraded != "" {
			backups = append(backups, upgraded)
		}
	}
	// 非 mcdn 优先，其余保持 B站 下发的原序。
	candidates := orderTrackCandidates(base, backups)
	if len(candidates) == 0 {
		return "", false
	}
	hasDirect := false
	for _, candidateURL := range candidates {
		if !isMcdnURL(candidateURL) {
			hasDirect = true
			break
		}
	}

	type result struct {
		url string
		ok  bool
	}
	// 缓冲满长度，避免 goroutine 在无人接收时泄漏。
	ch := make(chan result, len(candidates))

	for _, candidateURL := range candidates {
		wait := time.Duration(0)
		if hasDirect && isMcdnURL(candidateURL) {
			wait = mcdnProbeDelay
		}
		go func(u string, wait time.Duration) {
			if wait > 0 {
				select {
				case <-time.After(wait):
				case <-ctx.Done():
					ch <- result{}
					return
				}
			}
			if checkURLReachable(ctx, u) {
				ch <- result{url: u, ok: true}
				return
			}
			ch <- result{}
		}(candidateURL, wait)
	}

	// 兜底：超时后一律返回 false，不等待残余 goroutine。
	timer := time.NewTimer(healthCheckTimeout + mcdnProbeDelay + 500*time.Millisecond)
	defer timer.Stop()

	pending := len(candidates)
	for pending > 0 {
		select {
		case res := <-ch:
			if res.ok {
				log.Printf("[bilibili-cdn] 选择可达 URL: %s", res.url)
				return res.url, true
			}
			pending--
		case <-timer.C:
			return "", false
		case <-ctx.Done():
			return "", false
		}
	}
	return "", false
}

// SelectReachableTrackURL 是 FindReachableMediaURL 的语义别名（供上层按轨道调用）。
func SelectReachableTrackURL(ctx context.Context, track MediaTrackCandidate) (string, bool) {
	return FindReachableMediaURL(ctx, track)
}

// PickTrackURL 在不做连通性探测时挑一条轨道地址：非 mcdn 优先。
//
// 使用场景是「跳过后端探测、由客户端直连」：探测结果不代表客户端网络，所以
// 不做可达性判断，但也不能直接把 mcdn 死链丢出去——按候选顺序取第一个非
// mcdn 地址，全部是 mcdn 时才退回原 baseUrl。
func PickTrackURL(track *DashMediaTrack) string {
	if track == nil {
		return ""
	}
	for _, candidate := range orderTrackCandidates(track.BaseURL, track.BackupURL) {
		if upgraded := UpgradeURLToHTTPS(candidate); upgraded != "" {
			return upgraded
		}
	}
	return ""
}
