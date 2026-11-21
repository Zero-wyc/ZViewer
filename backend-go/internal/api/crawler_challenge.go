/**
 * 人机验证页的本地反代。
 *
 * 浏览器打开 /api/crawler/challenge/<id>/site/... 时，由本进程用会话的 Cookie
 * 回源抓页面、改写同源资源地址后再吐出去。这样 iframe 里不会出现混合内容或
 * CSP 报错，站点 Cookie 也只留在后端。找不到本地引擎时退回 3789 转发。
 */
package api

import (
	"io"
	"net/http"
	"strings"

	"zviewer/backend/internal/crawler"
	"zviewer/backend/internal/httpx"
)

func (s *Server) serveLocalChallenge(w http.ResponseWriter, r *http.Request, store *crawler.ChallengeStore) bool {
	const prefix = "/api/crawler/challenge/"
	rest := strings.TrimPrefix(r.URL.Path, prefix)
	segments := strings.Split(rest, "/")
	if len(segments) == 0 || segments[0] == "" {
		httpx.NotFound(w, "缺少验证会话")
		return true
	}
	sessionID := segments[0]
	action := ""
	if len(segments) > 1 {
		action = segments[1]
	}

	switch {
	case action == "site":
		s.proxyChallengePage(w, r, store, sessionID, segments[2:])
		return true
	case action == "" && r.Method == http.MethodGet:
		session, err := store.Get(sessionID)
		if err != nil {
			writeCrawlerError(w, err)
			return true
		}
		httpx.OK(w, map[string]any{
			"success":   true,
			"id":        session.ID,
			"site":      session.Site,
			"name":      session.Name,
			"keyword":   session.Keyword,
			"pageUrl":   session.PageURL,
			"proxyUrl":  store.ProxyBase(session),
			"reason":    session.Reason,
			"note":      session.Note,
			"status":    session.Status,
			"cookies":   store.CookieCount(session),
			"completed": session.Completed,
			"expiresAt": session.ExpiresAt,
		})
		return true
	case action == "" && r.Method == http.MethodDelete:
		deleted := store.Delete(sessionID)
		httpx.OK(w, map[string]any{"success": true, "deleted": deleted})
		return true
	case action == "verify" && r.Method == http.MethodPost:
		store.MarkCompleted(sessionID, true)
		httpx.OK(w, map[string]any{"success": true, "completed": true})
		return true
	}
	return false
}

// proxyChallengePage 回源并重写一个验证页请求。
func (s *Server) proxyChallengePage(w http.ResponseWriter, r *http.Request, store *crawler.ChallengeStore, sessionID string, rest []string) {
	session, err := store.Get(sessionID)
	if err != nil {
		writeCrawlerError(w, err)
		return
	}
	store.AbsorbBrowserCookies(session, r.Header.Get("Cookie"))
	base := store.ProxyBase(session)

	// 只打开反代根路径时，回到触发验证的那个地址（而不是站点首页）。
	if len(rest) == 0 || (len(rest) == 1 && rest[0] == "") {
		location := "/"
		if strings.HasPrefix(session.PageURL, session.Origin) {
			location = session.PageURL[len(session.Origin):]
		}
		w.Header().Set("Location", base+location)
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusFound)
		return
	}

	path := "/" + strings.Join(rest, "/")
	target := session.Origin + path
	if r.URL.RawQuery != "" {
		target += "?" + r.URL.RawQuery
	}

	var body []byte
	if r.Method == http.MethodPost || r.Method == http.MethodPut || r.Method == http.MethodPatch {
		body, _ = io.ReadAll(io.LimitReader(r.Body, 8<<20))
	}
	headers := map[string]string{
		"Accept":           r.Header.Get("Accept"),
		"Accept-Language":  r.Header.Get("Accept-Language"),
		"Content-Type":     r.Header.Get("Content-Type"),
		"X-Requested-With": r.Header.Get("X-Requested-With"),
		"User-Agent":       r.Header.Get("User-Agent"),
	}
	// Referer 从反代地址还原成站点地址，否则部分验证接口会判跨站。
	if referer := r.Header.Get("Referer"); strings.HasPrefix(referer, base) {
		headers["Referer"] = session.Origin + strings.TrimPrefix(referer, base)
	}

	response, err := store.Fetch(session, target, r.Method, headers, body, 5)
	if err != nil {
		writeCrawlerError(w, err)
		return
	}

	contentType := response.Headers.Get("Content-Type")
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	payload := response.Body
	lowered := strings.ToLower(contentType)
	if strings.HasPrefix(lowered, "text/html") {
		text := decodeChallengeText(payload, contentType)
		payload = []byte(store.RewriteHTML(session, text))
		contentType = "text/html; charset=utf-8"
	} else if strings.HasPrefix(lowered, "text/css") {
		text := decodeChallengeText(payload, contentType)
		payload = []byte(store.RewriteCSS(session, text, target))
	}

	w.Header().Set("Content-Type", contentType)
	w.Header().Set("X-Frame-Options", "ALLOWALL")
	w.Header().Set("Cache-Control", "no-store")
	// 站点 Cookie 已在 Fetch 里收进会话，这里只回写改写后的浏览器侧 Cookie。
	if cookies := response.Headers.Values("Set-Cookie"); len(cookies) > 0 {
		for _, item := range store.AbsorbResponseCookies(session, cookies) {
			w.Header().Add("Set-Cookie", item)
		}
	}
	// 站内跳转要改写成反代地址，站外跳转原样交给浏览器。
	if location := response.Headers.Get("Location"); location != "" {
		if strings.HasPrefix(location, session.Origin) {
			w.Header().Set("Location", base+strings.TrimPrefix(location, session.Origin))
		} else {
			w.Header().Set("Location", location)
		}
	}
	w.WriteHeader(response.Status)
	_, _ = w.Write(payload)
}

// decodeChallengeText 按 Content-Type 的 charset 解码页面字节。
func decodeChallengeText(payload []byte, contentType string) string {
	text, _ := crawler.DecodeText(payload, crawler.CharsetOf(contentType))
	return text
}
