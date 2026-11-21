package crawler

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func newChallengeFixture(t *testing.T) (*ChallengeStore, *ChallengeSession) {
	t.Helper()
	store := NewChallengeStore(time.Hour, 10)
	rule := &Rule{
		ID:   "demo",
		Name: "示例站",
		Site: "example.com",
		Search: Search{
			Mode:    "http",
			Request: SearchRequest{URL: "https://example.com/s?q={keyword}"},
		},
	}
	session, err := store.Create(rule, "流浪地球", "room1", "guest",
		&Page{PageURL: "https://example.com/s?q=x", Status: 403},
		map[string]any{"reason": "status:403", "note": "点一下"})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	return store, session
}

func TestChallengeLifecycle(t *testing.T) {
	store, session := newChallengeFixture(t)
	if session.ID == "" || len(session.ID) != 24 {
		t.Errorf("id = %q", session.ID)
	}
	if session.Origin != "https://example.com" {
		t.Errorf("origin = %q", session.Origin)
	}
	if session.ExpiresAt <= time.Now().Unix() {
		t.Errorf("expiresAt = %d", session.ExpiresAt)
	}

	reloaded, err := store.Get(session.ID)
	if err != nil || reloaded.ID != session.ID {
		t.Fatalf("get: %v", err)
	}
	if list := store.List(false); len(list) != 1 {
		t.Fatalf("list = %d", len(list))
	}
	store.MarkCompleted(session.ID, true)
	if list := store.List(false); len(list) != 0 {
		t.Errorf("completed session should be hidden, got %d", len(list))
	}
	if list := store.List(true); len(list) != 1 {
		t.Errorf("includeCompleted should show it, got %d", len(list))
	}
	if !store.Delete(session.ID) {
		t.Error("delete failed")
	}
	if _, err := store.Get(session.ID); err == nil || ErrorCode(err) != "challenge_not_found" {
		t.Errorf("expired lookup should fail, got %v", err)
	}
}

func TestChallengeCookieRoundTrip(t *testing.T) {
	store, session := newChallengeFixture(t)
	rewritten := store.AbsorbResponseCookies(session, []string{
		"sid=abc123; Path=/; HttpOnly",
		"token=xyz; Domain=.example.com",
		"badcookie",
	})
	if len(rewritten) != 2 {
		t.Fatalf("rewritten = %v", rewritten)
	}
	prefix := "zc_" + session.ID + "_"
	if !strings.HasPrefix(rewritten[0], prefix+"sid=abc123") {
		t.Errorf("cookie not namespaced: %q", rewritten[0])
	}
	if !strings.Contains(rewritten[0], "/api/crawler/challenge/"+session.ID+"/") {
		t.Errorf("cookie path = %q", rewritten[0])
	}

	// 浏览器回传：只有带前缀的才吸收，且去前缀存原名。
	store.AbsorbBrowserCookies(session, "other=1; "+prefix+"sid=abc123")
	if store.CookieCount(session) != 2 {
		t.Fatalf("cookies = %d", store.CookieCount(session))
	}
	header := store.cookieHeader(session)
	if !strings.Contains(header, "sid=abc123") || strings.Contains(header, prefix) {
		t.Errorf("cookie header = %q", header)
	}
	if strings.Contains(header, "other=1") {
		t.Errorf("foreign cookie leaked: %q", header)
	}
}

func TestChallengeRewriteHTML(t *testing.T) {
	store, session := newChallengeFixture(t)
	html := `<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'self'"><base href="/x/"><script src="/js/app.js"></script></head>
<body><a href="https://other.com/x">外链</a><img src="//cdn.other.com/a.png"><img src="/img/a.png" srcset="/img/1.png 1x, /img/2.png 2x"></body></html>`
	out := store.RewriteHTML(session, html)
	if strings.Contains(strings.ToLower(out), "content-security-policy") {
		t.Error("CSP meta should be stripped")
	}
	if strings.Contains(strings.ToLower(out), "<base") {
		t.Error("base tag should be stripped")
	}
	base := store.ProxyBase(session)
	if !strings.Contains(out, `src="`+base+`/js/app.js"`) {
		t.Errorf("script src not proxied:\n%s", out)
	}
	if !strings.Contains(out, `src="`+base+`/img/a.png"`) {
		t.Errorf("img src not proxied:\n%s", out)
	}
	if !strings.Contains(out, `href="https://other.com/x"`) {
		t.Error("cross-origin href should stay unchanged")
	}
	if !strings.Contains(out, `src="//cdn.other.com/a.png"`) {
		t.Error("cross-origin img should stay unchanged")
	}
	if !strings.Contains(out, base+`/img/1.png 1x`) {
		t.Errorf("srcset not proxied:\n%s", out)
	}
	if !strings.Contains(out, "__crawlerProxyMap") {
		t.Error("shim script missing")
	}
	// shim 必须出现在 <head ...> 之后（在页面脚本之前生效）。
	headIndex := strings.Index(strings.ToLower(out), "<head")
	shimIndex := strings.Index(out, "__crawlerProxyMap")
	if headIndex < 0 || shimIndex < headIndex {
		t.Errorf("shim not injected after head: head=%d shim=%d", headIndex, shimIndex)
	}
}

func TestChallengeRewriteCSS(t *testing.T) {
	store, session := newChallengeFixture(t)
	out := store.RewriteCSS(session, `body{background:url("/bg.png")} .a{background:url(https://other.com/x.png)}`, "https://example.com/style.css")
	if !strings.Contains(out, store.ProxyBase(session)+"/bg.png") {
		t.Errorf("css url not proxied: %s", out)
	}
	if !strings.Contains(out, "https://other.com/x.png") {
		t.Errorf("cross-origin css url changed: %s", out)
	}
}

func TestChallengeFetchRedirectAndOrigin(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/start", func(w http.ResponseWriter, r *http.Request) {
		http.SetCookie(w, &http.Cookie{Name: "sid", Value: "s1"})
		http.Redirect(w, r, "/final", http.StatusFound)
	})
	mux.HandleFunc("/final", func(w http.ResponseWriter, r *http.Request) {
		// 第二跳必须带上第一跳收到的 Cookie。
		if cookie, err := r.Cookie("sid"); err != nil || cookie.Value != "s1" {
			t.Errorf("cookie not forwarded, got %v", err)
		}
		_, _ = w.Write([]byte("done"))
	})
	mux.HandleFunc("/escape", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "https://evil.example.org/x", http.StatusFound)
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	store := NewChallengeStore(time.Hour, 10)
	rule := &Rule{ID: "r", Name: "站点", Site: HostOf(server.URL), Search: Search{Request: SearchRequest{URL: server.URL + "/s?q={keyword}"}}}
	session, err := store.Create(rule, "k", "", "guest", &Page{PageURL: server.URL + "/s?q=k"}, nil)
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	response, err := store.Fetch(session, server.URL+"/start", "GET", nil, nil, 5)
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if response.Status != 200 || string(response.Body) != "done" {
		t.Fatalf("status=%d body=%q", response.Status, response.Body)
	}
	if store.CookieCount(session) == 0 {
		t.Error("cookie from redirect not absorbed")
	}

	// 跨域重定向：不跟随，原样返回 302。
	escaped, err := store.Fetch(session, server.URL+"/escape", "GET", nil, nil, 5)
	if err != nil {
		t.Fatalf("fetch escape: %v", err)
	}
	if escaped.Status != http.StatusFound {
		t.Errorf("cross-origin redirect should stop, status=%d", escaped.Status)
	}

	// 跨域地址直接拒绝。
	if _, err := store.Fetch(session, "https://other.com/x", "GET", nil, nil, 5); err == nil || ErrorCode(err) != "challenge_origin_mismatch" {
		t.Errorf("other origin should be refused, got %v", err)
	}
}

func TestChallengeProxyBaseShape(t *testing.T) {
	store, session := newChallengeFixture(t)
	want := "/api/crawler/challenge/" + session.ID + "/site"
	if got := store.ProxyBase(session); got != want {
		t.Errorf("proxyBase = %q, want %q", got, want)
	}
	if got := store.ToProxy(session, "/a/b?q=1", "https://example.com/x/y"); got != want+"/a/b?q=1" {
		t.Errorf("toProxy = %q", got)
	}
	// 非同源、data:、# 锚点都原样返回。
	for _, raw := range []string{"https://other.com/z", "data:image/png;base64,xx", "#top"} {
		if got := store.ToProxy(session, raw, "https://example.com/x"); got != raw {
			t.Errorf("toProxy(%q) = %q", raw, got)
		}
	}
}
