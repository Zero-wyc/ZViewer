package auth

import (
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// cookie 常量，与 middleware/auth.ts 完全一致。
const (
	AccessCookieName  = "access_token"
	RefreshCookieName = "refresh_token"

	// access cookie 比 JWT 短 5 秒，避免边界过期
	accessCookieMaxAge  = 3600 - 5
	refreshCookieMaxAge = 30 * 24 * 60 * 60
)

// IsRequestSecure 判断当前请求是否为 HTTPS（含反代终止 TLS 的场景）。
//
// 三个判据按 Node 版顺序：直连 TLS → X-Forwarded-Proto → Origin 的 scheme。
// 第三条是内网穿透的兜底：部分隧道不转发 X-Forwarded-Proto，
// 若按 HTTP 处理就永远写不进 cookie，登录会陷入 401 死循环。
func IsRequestSecure(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	if v := r.Header.Get("X-Forwarded-Proto"); v != "" {
		if strings.EqualFold(strings.TrimSpace(strings.Split(v, ",")[0]), "https") {
			return true
		}
	}
	if origin := r.Header.Get("Origin"); strings.HasPrefix(strings.ToLower(origin), "https://") {
		return true
	}
	return false
}

// IsCrossSite 按浏览器的 schemeful same-site 规则判断跨站。
//
// 要点：**端口不影响同站判定**。前端 4173 + 后端 3333 仍属同站，
// 若误判成跨站会给出 SameSite=None，在部分代理下反而丢 cookie。
func IsCrossSite(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return false
	}

	originURL, err := url.Parse(origin)
	if err != nil || originURL.Hostname() == "" {
		return false
	}

	// 请求方视角的 scheme：反代优先 X-Forwarded-Proto，其次直连 TLS，最后跟随 Origin
	scheme := ""
	if v := r.Header.Get("X-Forwarded-Proto"); v != "" {
		scheme = strings.TrimSpace(strings.Split(v, ",")[0])
	}
	if scheme == "" {
		if r.TLS != nil {
			scheme = "https"
		} else {
			scheme = originURL.Scheme
		}
	}

	// 请求方视角的 host：反代优先 X-Forwarded-Host
	host := r.Header.Get("X-Forwarded-Host")
	if host == "" {
		host = r.Host
	}
	hostname := host
	if h, _, err := net.SplitHostPort(host); err == nil {
		hostname = h
	}
	hostname = strings.Trim(hostname, "[]")

	if !strings.EqualFold(originURL.Hostname(), hostname) {
		return true
	}
	return !strings.EqualFold(originURL.Scheme, scheme)
}

// cookiePolicy 计算 SameSite 与 Secure。
func cookiePolicy(r *http.Request) (http.SameSite, bool) {
	secure := IsRequestSecure(r)
	if secure && IsCrossSite(r) {
		// 跨站 fetch 必须 SameSite=None + Secure，否则浏览器不发送
		return http.SameSiteNoneMode, true
	}
	return http.SameSiteLaxMode, secure
}

// SetAuthCookies 写入 access/refresh cookie。
//
// 与 Node 版一致：**HTTP 请求不写 cookie**。
// 浏览器拒绝非 Secure 的 SameSite=None cookie，写半个不如不写；
// HTTP 场景由响应体返回 token，走 Authorization: Bearer。
func SetAuthCookies(w http.ResponseWriter, r *http.Request, tokens Tokens) {
	if !IsRequestSecure(r) {
		return
	}
	sameSite, secure := cookiePolicy(r)
	writeCookie(w, r, AccessCookieName, tokens.AccessToken, accessCookieMaxAge, sameSite, secure)
	writeCookie(w, r, RefreshCookieName, tokens.RefreshToken, refreshCookieMaxAge, sameSite, secure)
}

// SetAccessTokenCookie 仅续签 access cookie（refresh 不轮换）。
func SetAccessTokenCookie(w http.ResponseWriter, r *http.Request, accessToken string) {
	if !IsRequestSecure(r) {
		return
	}
	sameSite, secure := cookiePolicy(r)
	writeCookie(w, r, AccessCookieName, accessToken, accessCookieMaxAge, sameSite, secure)
}

// ClearAuthCookies 清除两个鉴权 cookie。
//
// 必须带上与写入时一致的 SameSite/Secure，否则浏览器视为不同 cookie 而拒绝删除。
func ClearAuthCookies(w http.ResponseWriter, r *http.Request) {
	sameSite, secure := cookiePolicy(r)
	clearCookie(w, r, AccessCookieName, sameSite, secure)
	clearCookie(w, r, RefreshCookieName, sameSite, secure)
}

func writeCookie(w http.ResponseWriter, r *http.Request, name, value string, maxAge int, sameSite http.SameSite, secure bool) {
	http.SetCookie(w, &http.Cookie{
		Name:     name,
		Value:    value,
		Path:     "/",
		MaxAge:   maxAge,
		HttpOnly: true,
		Secure:   secure,
		SameSite: sameSite,
	})
}

func clearCookie(w http.ResponseWriter, r *http.Request, name string, sameSite http.SameSite, secure bool) {
	http.SetCookie(w, &http.Cookie{
		Name:     name,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		Expires:  time.Unix(0, 0).UTC(),
		HttpOnly: true,
		Secure:   secure,
		SameSite: sameSite,
	})
}

// ExtractAccessToken 依次从 query、cookie、Authorization 头取 token。
//
// query 优先是为了兼容 hls.js 这类无法自定义请求头的播放器。
func ExtractAccessToken(r *http.Request) string {
	if v := r.URL.Query().Get("token"); v != "" {
		return v
	}
	if c, err := r.Cookie(AccessCookieName); err == nil && c.Value != "" {
		return c.Value
	}
	if header := r.Header.Get("Authorization"); header != "" {
		if parts := strings.SplitN(header, " ", 2); len(parts) == 2 && parts[0] == "Bearer" {
			if v := strings.TrimSpace(parts[1]); v != "" {
				return v
			}
		}
	}
	return ""
}

// ExtractRefreshToken 优先读 cookie，兼容旧客户端的 body 字段（由调用方兜底）。
func ExtractRefreshToken(r *http.Request) string {
	if c, err := r.Cookie(RefreshCookieName); err == nil {
		return c.Value
	}
	return ""
}
