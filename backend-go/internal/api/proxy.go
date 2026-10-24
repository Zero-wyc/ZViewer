package api

import (
	"net/http"
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

func (s *Server) registerProxyRoutes(mux *http.ServeMux) {
	for _, module := range antileechModules {
		tag := module
		mux.HandleFunc("GET /api/stream/"+module+"/proxy", s.Auth.Require(s.antileechProxy(tag)))
	}
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
