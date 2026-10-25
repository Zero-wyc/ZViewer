// Package voice 是语音聊天在服务端的那一半。
//
// 媒体面完全交给 LiveKit（独立进程/容器），这里只做三件事：
//
//   - 用 API Key/Secret 给客户端签 AccessToken（客户端连 LiveKit 的唯一凭证）；
//   - 以 admin 身份调 LiveKit 的 Twirp 接口做禁言/踢人；
//   - 告诉客户端「该连哪个地址」（同端口反代时按请求头推导）。
//
// 与 Node 版（`routes/voice.routes.ts`）的分工完全一致：不做 SFU、不碰音频。
package voice

import (
	"context"
	"net/http"
	"os"
	"strings"

	"zviewer/backend/internal/store"
)

const (
	// defaultAPIHost 是内嵌 LiveKit 的默认管理地址。
	// Node 用同一个默认值（`http://127.0.0.1:3336`），端口来自 livekit.yaml 的 http_port。
	defaultAPIHost = "http://127.0.0.1:3336"

	// defaultTokenTTL 是客户端 token 的有效期。
	// livekit-server-sdk 的默认值是 6h，直播场景够用；刷新靠前端重连时重新签。
	defaultTokenTTL = 6 * 60 * 60
)

// Service 持有 LiveKit 的连接信息。
//
// 配置全部来自环境变量，且**每次调用时现读**：桌面壳会在启动后注入这些变量，
// 启动瞬间缓存住就会拿到空值（Node 侧也是每次现读 process.env）。
type Service struct {
	Settings *store.Settings
	// HTTP 用于调 Twirp；测试可替换。
	HTTP *http.Client
}

// New 构造语音服务。
func New(settings *store.Settings) *Service {
	return &Service{Settings: settings, HTTP: &http.Client{}}
}

// APIKey / Secret / APIHost / ClientURL 都是每次现读环境变量。
func (s *Service) apiKey() string { return strings.TrimSpace(os.Getenv("LIVEKIT_API_KEY")) }

func (s *Service) secret() string { return strings.TrimSpace(os.Getenv("LIVEKIT_API_SECRET")) }

func (s *Service) apiHost() string {
	if v := strings.TrimSpace(os.Getenv("LIVEKIT_API_HOST")); v != "" {
		return strings.TrimRight(v, "/")
	}
	return defaultAPIHost
}

// Configured 判断密钥是否齐备。缺任意一个时 /token 直接 503。
func (s *Service) Configured() bool {
	return s.apiKey() != "" && s.secret() != ""
}

// ResolveClientURL 推导客户端该连的信令地址。
//
// 优先级（与 Node 的 resolveClientUrl 一致）：
//  1. 管理端基础设置的 livekitExternalUrl（运行时可配，最高优先）；
//  2. LIVEKIT_URL 环境变量（部署级显式配置，如外置 LiveKit）；
//  3. 按请求头推导：跟随页面协议与域名，HTTPS 页面自动 wss，
//     反代/CDN 场景取 x-forwarded-host / x-forwarded-proto。
//
// 刻意不「探测本机 IP」：容器/多网卡下探到的是 Docker bridge 地址，浏览器不可达。
func (s *Service) ResolveClientURL(ctx context.Context, r *http.Request) string {
	if s.Settings != nil {
		if cfg, err := s.Settings.Get(ctx); err == nil && cfg != nil {
			if configured := strings.TrimSpace(cfg.LivekitExternalURL); configured != "" {
				return configured
			}
		}
		// 读设置失败就静默回落：语音连不上比整个端点 500 更容易排查。
	}
	if explicit := strings.TrimSpace(os.Getenv("LIVEKIT_URL")); explicit != "" {
		return explicit
	}
	host := r.Header.Get("X-Forwarded-Host")
	if host == "" {
		host = r.Host
	}
	proto := r.Header.Get("X-Forwarded-Proto")
	if proto == "" {
		proto = "http"
		if r.TLS != nil {
			proto = "https"
		}
	}
	scheme := "ws"
	if strings.HasPrefix(proto, "https") {
		scheme = "wss"
	}
	return scheme + "://" + host
}

// VoiceRoomName 是 LiveKit 侧的房间名。
//
// 带 `voice:` 前缀是为了与「可能同名的其它用途房间」隔开——LiveKit 的房间名
// 是全局命名空间，直接用 roomId 会和未来任何复用同一空间的功能撞车。
func VoiceRoomName(roomID string) string {
	return "voice:" + roomID
}
