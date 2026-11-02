package piikbridge

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const (
	// SiteCookie 是 /signal 的站点通行证。Path 限定在信令路径上，不跟着
	// 每个静态资源跑一遍请求头。
	SiteCookie = "zv_piik_site"
	// TTL 只覆盖「刚拿凭证 → 建连」这段；重连前重新取一次凭证即可。
	siteTicketTTL = 10 * time.Minute
)

// GrantSiteAccess 为当前浏览器签发通行证。
//
// Piik 的 site access 是它自己的门（站点密码），ZViewer 的等价物是「登录且
// 通过房间校验」，凭证下发那一步已经验过了，这里只把结论变成一枚短期 cookie，
// 供 WebSocket 升级时复述——WS 没法带 Authorization 头。
func (b *Bridge) GrantSiteAccess(w http.ResponseWriter, r *http.Request, subject string) {
	value := b.signTicket(subject, time.Now().Add(siteTicketTTL))
	http.SetCookie(w, &http.Cookie{
		Name:     SiteCookie,
		Value:    value,
		Path:     SignalPath,
		MaxAge:   int(siteTicketTTL / time.Second),
		HttpOnly: true,
		Secure:   requestScheme(r) == "https",
		SameSite: http.SameSiteLaxMode,
	})
}

// siteAccess 是 Piik 的 SiteAccessAtUpgrade 回调。
func (b *Bridge) siteAccess(r *http.Request) bool {
	cookie, err := r.Cookie(SiteCookie)
	if err != nil || cookie.Value == "" {
		// 没有 cookie 的升级请求按未登录处理：房主会被拒，观众还能靠 grant
		// 过门（Piik 自己这条分支就是给邀请链接留的）。
		return false
	}
	return b.verifyTicket(cookie.Value, time.Now())
}

func (b *Bridge) signTicket(subject string, expires time.Time) string {
	payload := strconv.FormatInt(expires.UnixMilli(), 10) + ":" + subject
	encoded := base64.RawURLEncoding.EncodeToString([]byte(payload))
	return encoded + "." + base64.RawURLEncoding.EncodeToString(b.mac(encoded))
}

func (b *Bridge) verifyTicket(value string, now time.Time) bool {
	encoded, signature, ok := strings.Cut(value, ".")
	if !ok || encoded == "" || signature == "" {
		return false
	}
	given, err := base64.RawURLEncoding.DecodeString(signature)
	if err != nil || !hmac.Equal(given, b.mac(encoded)) {
		return false
	}
	raw, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		return false
	}
	expiresText, _, ok := strings.Cut(string(raw), ":")
	if !ok {
		return false
	}
	expiresMs, err := strconv.ParseInt(expiresText, 10, 64)
	if err != nil {
		return false
	}
	return now.UnixMilli() < expiresMs
}

func (b *Bridge) mac(encoded string) []byte {
	mac := hmac.New(sha256.New, b.secret)
	mac.Write([]byte(encoded))
	return mac.Sum(nil)
}
