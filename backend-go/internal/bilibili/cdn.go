package bilibili

import (
	"context"
	"log"
	"net/http"
	"net/url"
	"strings"
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

// MediaTrackCandidate 是一条待探测的媒体地址（主 + 备）。
type MediaTrackCandidate struct {
	BaseURL   string
	BackupURL []string
}

// cdnProbeClient 供 HEAD 探测复用，避免每次新建连接池。
var cdnProbeClient = &http.Client{Timeout: healthCheckTimeout}

// checkURLReachable 用 HEAD + Range 探测单条 URL。
//
// 接受 2xx 与 405：部分 CDN 不允许 HEAD（返回 405）但 GET 正常，
// 把 405 当不可达会让这些 CDN 上的资源被误判为全部失效。
func checkURLReachable(ctx context.Context, raw string) bool {
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
	return (resp.StatusCode >= 200 && resp.StatusCode < 400) || resp.StatusCode == http.StatusMethodNotAllowed
}

// FindReachableMediaURL 并行探测主地址与备用地址，返回第一个可达的 URL。
//
// 用「先到先得」而不是顺序尝试：顺序方案在全部不可达时要串行等满
// N × 3.5s，而一次解析里音视频各一轮，用户会明显感到卡顿。
func FindReachableMediaURL(ctx context.Context, candidate MediaTrackCandidate) (string, bool) {
	candidates := make([]string, 0, 1+len(candidate.BackupURL))
	if base := UpgradeURLToHTTPS(candidate.BaseURL); base != "" {
		candidates = append(candidates, base)
	}
	for _, backup := range candidate.BackupURL {
		if upgraded := UpgradeURLToHTTPS(backup); upgraded != "" {
			candidates = append(candidates, upgraded)
		}
	}
	if len(candidates) == 0 {
		return "", false
	}

	type result struct {
		url string
		ok  bool
	}
	// 缓冲满长度，避免 goroutine 在无人接收时泄漏。
	ch := make(chan result, len(candidates))

	for _, candidateURL := range candidates {
		go func(u string) {
			if checkURLReachable(ctx, u) {
				ch <- result{url: u, ok: true}
				return
			}
			ch <- result{}
		}(candidateURL)
	}

	// 兜底：超时后一律返回 false，不等待残余 goroutine。
	timer := time.NewTimer(healthCheckTimeout + 500*time.Millisecond)
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
