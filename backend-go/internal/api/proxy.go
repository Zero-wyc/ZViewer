package api

import (
	"errors"
	"net/http"
	"net/url"
	"strings"

	"zviewer/backend/internal/httpx"
	"zviewer/backend/internal/netutil"
	"zviewer/backend/internal/proxy"
)

// antileechModules 是需要防盗链代理的数据源模块。
//
// 这四个端点此前在 Node 版是三份逐字相同的拷贝（仅日志前缀不同），
// 收敛成一个处理器 + 四个挂载点：新增数据源时只加一个模块名。
var antileechModules = []string{"anime", "anisubs", "kazumi", "cms"}

// bilibiliReferer 是 B站 CDN 要求带的 Referer（缺了会 403）。
const bilibiliReferer = "https://www.bilibili.com"

// bilibiliMediaHostSuffixes / Exact 是「该不该加 B站 Referer」的判定表。
//
// 必须列表化而不是子串匹配：旧实现是子串正则，任何 URL 里含 mcdn/akamaized
// 的第三方域名都会被误加 B站 Referer，把正常请求变成一个假 403。
var bilibiliMediaHostSuffixes = []string{
	"bilibili.com",
	"bilivideo.com",
	"hdslb.com",
	"biliimg.com",
	"bstatic.com",
	"mountaintoys.cn",
	"pili-video.com",
	"boss-pgc.com",
}

// akamaized 是共享 CDN，只能精确白名单 B站 的海外边缘节点。
var bilibiliMediaHostExact = []string{"upos-hz-mirrorakam.akamaized.net"}

func isBilibiliMediaHost(hostname string) bool {
	host := strings.ToLower(hostname)
	for _, domain := range bilibiliMediaHostSuffixes {
		if host == domain || strings.HasSuffix(host, "."+domain) {
			return true
		}
	}
	for _, exact := range bilibiliMediaHostExact {
		if host == exact {
			return true
		}
	}
	return false
}

// allowedImageDomains 是 /proxy-image 的白名单（图片代理免认证，必须收紧）。
var allowedImageDomains = []string{"bilibili.com", "hdslb.com", "bilivideo.com", "biliimg.com"}

func (s *Server) registerProxyRoutes(mux *http.ServeMux) {
	for _, module := range antileechModules {
		tag := module
		mux.HandleFunc("GET /api/stream/"+module+"/proxy", s.Auth.Require(s.antileechProxy(tag)))
	}
	// 公共图片代理：img 标签带不了认证头，而 B站 图床要 Referer，
	// 所以这个端点**必须**在鉴权之外（Node 侧挂在 authenticateToken 之前）。
	mux.HandleFunc("GET /api/stream/proxy-image", s.handleStreamImageProxy)
	// 媒体代理：前端 fetch 带凭证（credentials: include），CORS 交给全局
	// 中间件反射 Origin，不能用通配。
	mux.HandleFunc("GET /api/stream/proxy", s.Auth.Require(s.handleStreamMediaProxy))
}

// handleStreamImageProxy 是 B站 图片代理（仅白名单域名）。
func (s *Server) handleStreamImageProxy(w http.ResponseWriter, r *http.Request) {
	rawURL := strings.TrimSpace(r.URL.Query().Get("url"))
	if rawURL == "" {
		httpx.BadRequest(w, "缺少 url 参数")
		return
	}
	parsed, err := url.Parse(rawURL)
	if err != nil {
		httpx.BadRequest(w, "非法的 URL")
		return
	}
	allowed := false
	host := strings.ToLower(parsed.Hostname())
	for _, domain := range allowedImageDomains {
		if host == domain || strings.HasSuffix(host, "."+domain) {
			allowed = true
			break
		}
	}
	if !allowed {
		httpx.Forbidden(w, "仅允许 B站 域名图片")
		return
	}
	proxy.ProxyHTTPUpstream(w, r, proxy.HTTPOptions{
		URL:        rawURL,
		PublicOnly: true,
		ValidateTarget: func(u *url.URL) error {
			for _, domain := range allowedImageDomains {
				host := strings.ToLower(u.Hostname())
				if host == domain || strings.HasSuffix(host, "."+domain) {
					return nil
				}
			}
			return errors.New("仅允许 B站 域名图片")
		},
		Headers: proxy.UpstreamHeaders{Referer: bilibiliReferer},
		// img 标签不携带凭证，CORS 交由全局中间件反射 Origin
		CORS:               proxy.CORSGlobal,
		DefaultContentType: "image/jpeg",
		CacheControl:       "public, max-age=3600",
		LogTag:             "stream",
		ErrorMessage:       "代理图片失败",
	})
}

// handleStreamMediaProxy 是 B站 CDN 媒体代理。
//
// 非 B站 的 URL（第三方 m3u8 直链）不加 B站 头：带上错误的 Referer
// 会让源站直接拒绝。
func (s *Server) handleStreamMediaProxy(w http.ResponseWriter, r *http.Request) {
	rawURL := strings.TrimSpace(r.URL.Query().Get("url"))
	if rawURL == "" {
		httpx.BadRequest(w, "缺少 url 参数")
		return
	}
	if netutil.IsInternalServerURL(rawURL) {
		httpx.Forbidden(w, "内网媒体请使用已授权影片或挂载接口")
		return
	}
	headers := proxy.UpstreamHeaders{}
	if parsed, err := url.Parse(rawURL); err == nil && isBilibiliMediaHost(parsed.Hostname()) {
		headers.Referer = bilibiliReferer
		headers.Origin = bilibiliReferer
	}
	// 按后缀推断 Content-Type：m3u8 与 ts 分片拿不到正确类型时，
	// 播放器会把它们当 mp4 处理，表现为「能加载、播不动」。
	lower := strings.ToLower(rawURL)
	contentType := "video/mp4"
	if strings.Contains(lower, ".m3u8") {
		contentType = "application/vnd.apple.mpegurl"
	} else if strings.Contains(lower, ".ts") {
		contentType = "video/mp2t"
	}
	proxy.ProxyHTTPUpstream(w, r, proxy.HTTPOptions{
		URL:                rawURL,
		PublicOnly:         true,
		Headers:            headers,
		CORS:               proxy.CORSGlobal,
		DefaultContentType: contentType,
		LogTag:             "stream",
		ErrorMessage:       "代理媒体失败",
	})
}

// antileechProxy 生成防盗链媒体代理处理器。
//
// 流程与 routes/antileech-proxy.ts 一致：
// 校验 url 参数 → 字面量 SSRF 拦截 → 带客户端声明的 Referer/Origin/UA/Cookie 转发。
// 域名解析级的 SSRF 拦截在 proxy 包内逐跳完成（PublicOnly）。
func (s *Server) antileechProxy(logTag string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rawURL := strings.TrimSpace(r.URL.Query().Get("url"))
		if rawURL == "" {
			httpx.BadRequest(w, "缺少 url 参数")
			return
		}

		// 这道检查是给"字面量内网地址"的快速拦截；公网域名解析到内网
		// 的情况由 proxy 内部逐跳的 DNS 校验兜住。
		if netutil.IsInternalServerURL(rawURL) {
			httpx.Forbidden(w, "不允许代理内网地址")
			return
		}

		q := r.URL.Query()
		proxy.ProxyHTTPUpstream(w, r, proxy.HTTPOptions{
			URL: rawURL,
			Headers: proxy.UpstreamHeaders{
				Referer:   q.Get("referer"),
				Origin:    q.Get("origin"),
				UserAgent: q.Get("userAgent"),
				Cookie:    q.Get("cookie"),
			},
			CORS: proxy.CORSWildcard,
			// 公网数据源：逐跳拒绝内网目标与内网重定向。
			// 本端点允许客户端自带任意 Cookie/Referer 转发，不设防就等于
			// 给了外部一个探测内网服务的跳板。
			PublicOnly: true,
			// 浏览器媒体缓存 6 分钟：慢源分片 seek 回看直接命中本地缓存，
			// 不必回源重拉。no-transform 由 proxy 自动追加。
			CacheControl: "private, max-age=360",
			LogTag:       logTag,
			ErrorMessage: "代理媒体失败",
		})
	}
}
