package api

import (
	"testing"

	"zviewer/backend/internal/store"
)

func strPtr(v string) *string { return &v }

func TestExtractDirectTarget(t *testing.T) {
	base := func() *store.Movie {
		return &store.Movie{
			Source:     strPtr("openlist"),
			ServerURL:  strPtr("http://nas:5244"),
			Path:       strPtr("/movies/a.mkv"),
			DirectLink: true,
		}
	}

	target, ok := extractDirectTarget(base())
	if !ok {
		t.Fatal("合法直链影片应可解析")
	}
	// openlist 的 serverUrl 必须先规范化（补 /dav）再匹配挂载表，
	// 否则挂载里存的规范化地址永远匹配不上。
	if target.ServerURL != "http://nas:5244/dav" {
		t.Fatalf("openlist serverUrl 未规范化: %q", target.ServerURL)
	}
	if target.Kind != "openlist" || target.Path != "/movies/a.mkv" {
		t.Fatalf("解析结果不符: %+v", target)
	}

	// webdav 不做规范化（原样使用）
	webdavMovie := base()
	webdavMovie.Source = strPtr("webdav")
	webdavMovie.ServerURL = strPtr("https://dav.example.com")
	if target, ok := extractDirectTarget(webdavMovie); !ok || target.ServerURL != "https://dav.example.com" {
		t.Fatalf("webdav 不应改写 serverUrl: %+v, %v", target, ok)
	}

	cases := map[string]func(*store.Movie){
		"非直链影片":        func(m *store.Movie) { m.DirectLink = false },
		"非 openlist":   func(m *store.Movie) { m.Source = strPtr("emby") },
		"source 为 nil": func(m *store.Movie) { m.Source = nil },
		"缺 serverUrl":  func(m *store.Movie) { m.ServerURL = nil },
		"缺 path":       func(m *store.Movie) { m.Path = nil },
		"serverUrl 空串": func(m *store.Movie) { m.ServerURL = strPtr("  ") },
		"path 空串":      func(m *store.Movie) { m.Path = strPtr("") },
	}
	for name, mutate := range cases {
		m := base()
		mutate(m)
		if _, ok := extractDirectTarget(m); ok {
			t.Fatalf("%s 不应被当作可解析直链影片", name)
		}
	}
}

func TestDirectResolveTargetCacheKey(t *testing.T) {
	a := directResolveTarget{Kind: "openlist", ServerURL: "http://nas/dav", Path: "/a.mkv"}
	b := directResolveTarget{Kind: "openlist", ServerURL: "http://nas/dav", Path: "/a.mkv"}
	c := directResolveTarget{Kind: "webdav", ServerURL: "http://nas/dav", Path: "/a.mkv"}
	if a.cacheKey() != b.cacheKey() {
		t.Fatal("相同目标应命中同一缓存键")
	}
	if a.cacheKey() == c.cacheKey() {
		t.Fatal("不同类型必须区分缓存键（openlist 与 webdav 走不同解析分支）")
	}
}
