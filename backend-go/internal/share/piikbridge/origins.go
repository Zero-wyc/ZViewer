package piikbridge

import (
	"net/http"
	"net/url"
	"strings"
)

// canonicalOrigin 是交给 Piik 的来源值。
//
// Piik 的 isAllowedOrigin 只做「序列化后是否等于集合里的某一项」，集合在构造时
// 定死——它自己的部署形态（固定公网域名 + 配置文件）成立，ZViewer 不成立：
// 同一份二进制会在 127.0.0.1、内网 IP、反代域名下被访问，没有启动期可知的
// 白名单。因此判定放在本层，命中后把 Origin 换成一个固定值交给它，语义等价。
const canonicalOrigin = "https://piik.zviewer.invalid"

// Handler 挂载在 /signal 上。
func (b *Bridge) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != SignalPath {
			http.NotFound(w, r)
			return
		}
		if !b.originAllowed(r) {
			// 与 Piik 的 rejectUpgrade 同形：不回包体，直接断。
			w.Header().Set("Connection", "close")
			w.Header().Set("Content-Length", "0")
			w.WriteHeader(http.StatusForbidden)
			return
		}
		b.signal.ServeHTTP(w, withCanonicalOrigin(r))
	})
}

// originAllowed 接受三类来源：CORS_ORIGIN=*、显式列出的来源、与请求同源。
//
// 空 Origin 一律拒绝：浏览器的 WebSocket 一定带 Origin，没有的是脚本客户端，
// 它们本来就该先走 REST 拿凭证，没必要在这里放宽。
func (b *Bridge) originAllowed(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return false
	}
	parsed, err := url.Parse(origin)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return false
	}
	// 反代常把 /path 带进 Origin，这种直接不认。
	if parsed.Opaque != "" || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return false
	}
	if b.allowAll {
		return true
	}
	if _, ok := b.allowed[origin]; ok {
		return true
	}
	return strings.EqualFold(parsed.Host, r.Host) && parsed.Scheme == requestScheme(r)
}

// requestScheme 按 Go 与反代的通行约定还原浏览器看到的协议。
func requestScheme(r *http.Request) string {
	if r.TLS != nil {
		return "https"
	}
	if proto := r.Header.Get("X-Forwarded-Proto"); proto != "" {
		return strings.ToLower(strings.TrimSpace(strings.Split(proto, ",")[0]))
	}
	return "http"
}

// withCanonicalOrigin 复制请求，只改 Origin；原请求留给调用链上的日志与中间件。
func withCanonicalOrigin(r *http.Request) *http.Request {
	clone := r.Clone(r.Context())
	clone.Header = r.Header.Clone()
	clone.Header.Set("Origin", canonicalOrigin)
	return clone
}
