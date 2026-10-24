// Package mountutil 收编各挂载类型（webdav/ftp/emby/jellyfin/openlist）共用的
// 凭证与直链处理，对应 modules/shared/mount-utils.ts。
package mountutil

import (
	"context"
	"log"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"zviewer/backend/internal/netutil"
	"zviewer/backend/internal/store"
)

// httpsProbeTimeout 是 HTTPS 能力探测超时（毫秒级 5000）。
const httpsProbeTimeout = 5 * time.Second

// probeClient 用于 HTTPS 能力探测。
//
// 刻意**保留证书校验**：Node 侧用的是全局 fetch（undici 默认校验证书），
// 自签名证书在探测里算「不支持 HTTPS」，因此直链不会被升级成浏览器
// 连不上的 https 地址。若这里也放开校验，就会与 Node 的行为分叉：
// 自签名源站的 http 直链会被升级成 https，播放器直接报源不可用。
var probeClient = &http.Client{
	Timeout: httpsProbeTimeout,
}

// ResolveDirectLinkWithInternalCheck 对内网地址强制关闭直链。
//
// 浏览器（尤其是公网访问者）无法直连 192.168/10.x/127.0.0.1 这类地址，
// 直链模式在内网源上必然播不动，必须在保存时就改成服务器中转。
func ResolveDirectLinkWithInternalCheck(serverURL string, directLink bool) bool {
	if directLink && netutil.IsInternalServerURL(serverURL) {
		return false
	}
	return directLink
}

// ProbeHTTPSCapability 探测源站的 HTTPS 直连能力。
//
// 返回 nil 表示「不适用」（非 http/https 协议，如 ftp://）。
// 对 https:// 同端口地址发 HEAD：任何 HTTP 响应（2xx-5xx，含 401/404）
// 都证明 TLS 握手成功 → true；TLS/网络错误 → false。
func ProbeHTTPSCapability(ctx context.Context, serverURL string) *bool {
	u, err := url.Parse(strings.TrimSpace(serverURL))
	if err != nil || u.Host == "" {
		return nil
	}
	if u.Scheme == "https" {
		v := true
		return &v
	}
	if u.Scheme != "http" {
		return nil
	}

	// 与 Node 一致：直接把 "http://" 换成 "https://"（保留 path）
	httpsURL := "https://" + strings.TrimPrefix(strings.TrimSpace(serverURL), "http://")
	reqCtx, cancel := context.WithTimeout(ctx, httpsProbeTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodHead, httpsURL, nil)
	if err != nil {
		v := false
		return &v
	}
	req.Header.Set("User-Agent", "ZViewer-HttpsProbe")
	resp, err := probeClient.Do(req)
	if err != nil {
		v := false
		return &v
	}
	defer resp.Body.Close()
	v := resp.StatusCode >= 200 && resp.StatusCode < 600
	return &v
}

// MaybeUpgradeDirectURL 把 http 直链升级为 https（挂载探测通过时调用）。
func MaybeUpgradeDirectURL(directURL string, httpsDirect *bool) string {
	if httpsDirect == nil || !*httpsDirect {
		return directURL
	}
	u, err := url.Parse(directURL)
	if err != nil || u.Scheme != "http" {
		return directURL
	}
	u.Scheme = "https"
	return u.String()
}

// httpsLivenessCache 是 https 端点活性探测结果缓存（按 host，60s）。
//
// upgradeDirectURLValidated 每次直链解析都现场 HEAD 探测（最多 5s），
// 起播前白等；60s 内复用上次结果，源站 TLS 状态变化最多延迟 60s 感知
// （自愈写回只在首次探测失败时执行，缓存命中不再重复写库）。
type httpsCacheEntry struct {
	alive bool
	at    time.Time
}

var (
	httpsLivenessMu    sync.Mutex
	httpsLivenessCache = map[string]httpsCacheEntry{}
)

const httpsLivenessTTL = time.Minute

func probeHostAlive(ctx context.Context, host string) bool {
	httpsLivenessMu.Lock()
	if e, ok := httpsLivenessCache[host]; ok && time.Since(e.at) < httpsLivenessTTL {
		httpsLivenessMu.Unlock()
		return e.alive
	}
	httpsLivenessMu.Unlock()

	alive := false
	reqCtx, cancel := context.WithTimeout(ctx, httpsProbeTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodHead, "https://"+host, nil)
	if err == nil {
		req.Header.Set("User-Agent", "ZViewer-HttpsProbe")
		if resp, doErr := probeClient.Do(req); doErr == nil {
			alive = resp.StatusCode >= 200 && resp.StatusCode < 600
			resp.Body.Close()
		}
	}

	httpsLivenessMu.Lock()
	if len(httpsLivenessCache) > 500 {
		httpsLivenessCache = map[string]httpsCacheEntry{}
	}
	httpsLivenessCache[host] = httpsCacheEntry{alive: alive, at: time.Now()}
	httpsLivenessMu.Unlock()
	return alive
}

// EnsureHTTPSProbe 确保 httpsDirect 已探测（幂等）：有缓存值直接用，
// 没有就现场探测一次并写回（写回失败不影响返回）。
func EnsureHTTPSProbe(ctx context.Context, mounts *store.Mounts, mount *store.Mount) *bool {
	if mount.HttpsDirect != nil {
		return mount.HttpsDirect
	}
	if mount.ServerURL == nil || *mount.ServerURL == "" {
		return nil
	}
	result := ProbeHTTPSCapability(ctx, *mount.ServerURL)
	mount.HttpsDirect = result
	if mounts != nil {
		if err := mounts.SaveHTTPSDirect(ctx, mount.ID, result); err != nil {
			log.Printf("[mount-utils] 写回 HTTPS 探测结果失败: %v", err)
		}
	}
	return result
}

// UpgradeDirectURLValidated 带现场校验地升级直链协议。
//
// httpsDirect 是**配置期一次性探测的持久缓存**，仅在 serverUrl 变更时重置；
// 源站环境变化（拆反向代理、DDNS 改指、证书移除）不会让它失效。盲信陈旧的
// true 会把 http 直链升级成浏览器永远连不上的 https 地址——直链模式没有
// 回退路径，影片就此无法播放。所以升级前现场再探一次，失败即判定缓存陈旧、
// 改写 httpsDirect=false 并持久化（自愈），返回 http 直链。
func UpgradeDirectURLValidated(
	ctx context.Context,
	mounts *store.Mounts,
	mount *store.Mount,
	directURL string,
) string {
	httpsDirect := EnsureHTTPSProbe(ctx, mounts, mount)
	if httpsDirect == nil || !*httpsDirect {
		return directURL
	}
	u, err := url.Parse(directURL)
	if err != nil || u.Scheme != "http" {
		return directURL
	}
	alive := probeHostAlive(ctx, u.Host)
	if !alive {
		log.Printf("[mount-utils] httpsDirect 缓存已陈旧（%s 当前 TLS 握手失败），改写为 false 并返回 http 直链", u.Host)
		falseValue := false
		mount.HttpsDirect = &falseValue
		if mounts != nil {
			if err := mounts.SaveHTTPSDirect(ctx, mount.ID, &falseValue); err != nil {
				log.Printf("[mount-utils] 写回 httpsDirect 失败: %v", err)
			}
		}
		return directURL
	}
	return MaybeUpgradeDirectURL(directURL, httpsDirect)
}

// ProbeForMountSave 在挂载保存时探测 HTTPS 能力，返回需要提示给用户的 warning。
//
// 直链模式 + http 源：同步探测（阻塞至多 5s）——结果决定 warning：
// 源站不支持 TLS 时，https 页面下浏览器会把 http 直链升级后握手失败，
// 提示用户配置 HTTPS 或改服务器中转。其余组合异步探测（不阻塞保存）。
func ProbeForMountSave(ctx context.Context, mounts *store.Mounts, mount *store.Mount) string {
	isHTTPSource := mount.ServerURL != nil && strings.HasPrefix(*mount.ServerURL, "http://")
	if mount.DirectLink && isHTTPSource {
		probe := mount.HttpsDirect
		if probe == nil {
			probe = ProbeHTTPSCapability(ctx, *mount.ServerURL)
		}
		mount.HttpsDirect = probe
		if mounts != nil {
			if err := mounts.SaveHTTPSDirect(ctx, mount.ID, probe); err != nil {
				log.Printf("[mount-utils] 写回 HTTPS 探测结果失败: %v", err)
			}
		}
		if probe != nil && !*probe {
			host := *mount.ServerURL
			if u, err := url.Parse(*mount.ServerURL); err == nil {
				host = u.Host
			}
			return "挂载源站不支持 HTTPS（" + host + "），HTTPS 页面下直链将无法播放。请为源站配置 HTTPS（如反向代理）后重新保存，或改为服务器中转模式"
		}
		return ""
	}
	if isHTTPSource {
		// 异步探测持久化：不阻塞保存响应。这里必须用后台 context——
		// 请求结束后 r.Context() 立刻取消，探测会全部变成 ctx canceled。
		serverURL := *mount.ServerURL
		mountID := mount.ID
		go func() {
			bg, cancel := context.WithTimeout(context.Background(), httpsProbeTimeout+time.Second)
			defer cancel()
			result := ProbeHTTPSCapability(bg, serverURL)
			if result == nil || mounts == nil {
				return
			}
			_ = mounts.SaveHTTPSDirect(bg, mountID, result)
		}()
	}
	return ""
}
