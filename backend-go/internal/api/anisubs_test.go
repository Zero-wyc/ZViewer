package api_test

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// ani-subs 端点的 HTTP 层验证（路由校验 + 订阅注册表 + 抓站全链路）。

// 假站：搜索页 → 详情页 → 剧集页，最外层是订阅 JSON。
func newAniSubsSite(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()

	mux.HandleFunc("/sub.json", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_, _ = w.Write([]byte(`{"exportedMediaSourceDataList":{"mediaSources":[
			{"factoryId":"web-selector","version":2,"arguments":{"name":"假站","searchConfig":{
				"searchUrl":"` + siteURL(r) + `/search?wd={keyword}",
				"subjectFormatId":"a",
				"selectorSubjectFormatA":{"selectLists":"div.item > a"},
				"channelFormatId":"no-channel",
				"selectorChannelFormatNoChannel":{"selectEpisodes":".ep a","matchEpisodeSortFromName":"第\\s*(?<ep>\\d+)\\s*集"},
				"matchVideo":{"matchVideoUrl":"(?<v>https://cdn\\.example\\.com/[^\"]+\\.m3u8)"}
			}}},
			{"factoryId":"rss","arguments":{"name":"假订阅","searchConfig":{"searchUrl":"` + siteURL(r) + `/feed.xml"}}}
		]}}`))
	})
	mux.HandleFunc("/search", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(`<div class="item"><a href="/s/1">孤独摇滚</a><img src="https://cdn.example.com/1.jpg"></div>`))
	})
	mux.HandleFunc("/s/1", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(`<div class="ep"><a href="/p/1">第 1 集</a><a href="/p/2">第 2 集</a></div>`))
	})
	mux.HandleFunc("/p/1", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(`<script>const u = "https://cdn.example.com/1.m3u8";</script>`))
	})
	mux.HandleFunc("/p/2", func(w http.ResponseWriter, r *http.Request) {
		// 这一集页面里没有可播地址 → 404。
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(`<html>nothing</html>`))
	})
	mux.HandleFunc("/feed.xml", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/rss+xml; charset=utf-8")
		_, _ = w.Write([]byte(`<?xml version="1.0"?><rss version="2.0"><channel>
			<item><title>孤独摇滚 第1话</title><link>https://example.com/ep/1</link>
			<description>波奇酱</description><enclosure url="https://cdn.example.com/1.mp4"/></item>
		</channel></rss>`))
	})

	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	return server
}

// siteURL 让订阅里的地址指向假站自己。
func siteURL(r *http.Request) string {
	return "http://" + r.Host
}

func TestAniSubsRequiresAuth(t *testing.T) {
	env := newTestEnv(t)
	defer env.teardown()

	for _, path := range []string{
		"/api/stream/anisubs/sources",
		"/api/stream/anisubs/search?source=x&keyword=y",
		"/api/stream/anisubs/episodes?source=x&identifier=y",
	} {
		if resp := env.do(t, http.MethodGet, path, "", nil); resp.status != http.StatusUnauthorized {
			t.Errorf("%s 期望 401，实际 %d", path, resp.status)
		}
	}
	if resp := env.do(t, http.MethodPost, "/api/stream/anisubs/resolve", "", map[string]any{}); resp.status != http.StatusUnauthorized {
		t.Errorf("resolve 期望 401，实际 %d", resp.status)
	}
}

func TestAniSubsParamValidation(t *testing.T) {
	site := newAniSubsSite(t)

	env := newTestEnv(t)
	defer env.teardown()
	// 用假订阅：默认订阅会去真打外网，源表不可预期。
	env.setDataSourceConfig(t, `{"aniSubsSubscriptions":["`+site.URL+`/sub.json"]}`)

	id := env.seedUser(t, "anisubs-user", "pass-1234", "user", "active")
	token := env.token(t, id, "user", "anisubs-user")

	cases := []struct {
		name    string
		method  string
		path    string
		body    any
		status  int
		message string
	}{
		{
			name: "搜索缺 source", method: http.MethodGet,
			path: "/api/stream/anisubs/search?keyword=x", status: http.StatusBadRequest, message: "缺少 source 参数",
		},
		{
			name: "搜索缺 keyword", method: http.MethodGet,
			path: "/api/stream/anisubs/search?source=ani_subs_web-selector_0", status: http.StatusBadRequest, message: "缺少 keyword 参数",
		},
		{
			name: "搜索未知源", method: http.MethodGet,
			path: "/api/stream/anisubs/search?source=nope&keyword=x", status: http.StatusBadRequest, message: "未知的数据源",
		},
		{
			name: "分集缺 identifier", method: http.MethodGet,
			path: "/api/stream/anisubs/episodes?source=ani_subs_web-selector_0", status: http.StatusBadRequest, message: "缺少 identifier 参数",
		},
		{
			name: "解析缺 episode", method: http.MethodPost,
			path: "/api/stream/anisubs/resolve", body: map[string]any{"source": "ani_subs_web-selector_0"},
			status: http.StatusBadRequest, message: "缺少 episode 参数",
		},
		{
			name: "解析 episode 为布尔", method: http.MethodPost,
			path: "/api/stream/anisubs/resolve", body: map[string]any{"source": "ani_subs_web-selector_0", "episode": true},
			status: http.StatusBadRequest, message: "缺少 episode 参数",
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			resp := env.do(t, c.method, c.path, token, c.body)
			if resp.status != c.status || resp.message() != c.message {
				t.Fatalf("期望 %d %q，实际 %d %q", c.status, c.message, resp.status, resp.message())
			}
		})
	}
}

// TestAniSubsWebSelectorFlow 用假站跑通 搜索 → 分集 → 解析。
func TestAniSubsWebSelectorFlow(t *testing.T) {
	site := newAniSubsSite(t)

	env := newTestEnv(t)
	defer env.teardown()
	env.setDataSourceConfig(t, `{"aniSubsSubscriptions":["`+site.URL+`/sub.json"]}`)

	id := env.seedUser(t, "anisubs-flow", "pass-1234", "user", "active")
	token := env.token(t, id, "user", "anisubs-flow")

	// 注册表
	resp := env.do(t, http.MethodGet, "/api/stream/anisubs/sources", token, nil)
	if resp.status != http.StatusOK {
		t.Fatalf("sources 期望 200，实际 %d %s", resp.status, resp.raw)
	}
	sources, _ := resp.body["sources"].([]any)
	if len(sources) != 2 {
		t.Fatalf("数据源 = %v，期望 2 个（web-selector + rss）", sources)
	}
	first, _ := sources[0].(map[string]any)
	if first["id"] != "ani_subs_web-selector_0" || first["name"] != "假站" {
		t.Errorf("首个数据源 = %v", first)
	}

	// 搜索
	resp = env.do(t, http.MethodGet,
		"/api/stream/anisubs/search?source=ani_subs_web-selector_0&keyword=%E5%AD%A4%E7%8B%AC", token, nil)
	if resp.status != http.StatusOK {
		t.Fatalf("搜索期望 200，实际 %d %s", resp.status, resp.raw)
	}
	results, _ := resp.body["results"].([]any)
	if len(results) != 1 {
		t.Fatalf("结果 = %v", resp.body["results"])
	}
	item, _ := results[0].(map[string]any)
	if item["id"] != site.URL+"/s/1" || item["title"] != "孤独摇滚" {
		t.Errorf("搜索结果 = %v", item)
	}
	if item["cover"] != "https://cdn.example.com/1.jpg" {
		t.Errorf("封面 = %v", item["cover"])
	}

	// 分集
	resp = env.do(t, http.MethodGet,
		"/api/stream/anisubs/episodes?source=ani_subs_web-selector_0&identifier="+item["id"].(string), token, nil)
	if resp.status != http.StatusOK {
		t.Fatalf("分集期望 200，实际 %d %s", resp.status, resp.raw)
	}
	episodes, _ := resp.body["episodes"].([]any)
	if len(episodes) != 2 {
		t.Fatalf("分集 = %v", resp.body["episodes"])
	}
	second, _ := episodes[1].(map[string]any)
	if second["id"] != "第 2 集-2" || second["episodeNumber"] != float64(2) {
		t.Errorf("第二集 = %v", second)
	}

	// 解析第一集：命中地址
	resp = env.do(t, http.MethodPost, "/api/stream/anisubs/resolve", token, map[string]any{
		"source": "ani_subs_web-selector_0", "episode": episodes[0],
	})
	if resp.status != http.StatusOK {
		t.Fatalf("解析期望 200，实际 %d %s", resp.status, resp.raw)
	}
	if resp.body["url"] != "https://cdn.example.com/1.m3u8" || resp.body["format"] != "hls" {
		t.Errorf("解析结果 = %v", resp.body)
	}
	headers, _ := resp.body["headers"].(map[string]any)
	if headers["Referer"] != site.URL+"/p/1" {
		t.Errorf("headers = %v，期望回落剧集页地址", headers)
	}

	// 解析第二集：页面里没有地址 → 404
	resp = env.do(t, http.MethodPost, "/api/stream/anisubs/resolve", token, map[string]any{
		"source": "ani_subs_web-selector_0", "episode": episodes[1],
	})
	if resp.status != http.StatusNotFound || resp.message() != "无法解析播放地址" {
		t.Fatalf("期望 404 无法解析播放地址，实际 %d %q", resp.status, resp.message())
	}
}

// TestAniSubsRSSFlow RSS 源的单集链路。
func TestAniSubsRSSFlow(t *testing.T) {
	site := newAniSubsSite(t)

	env := newTestEnv(t)
	defer env.teardown()
	env.setDataSourceConfig(t, `{"aniSubsSubscriptions":["`+site.URL+`/sub.json"]}`)

	id := env.seedUser(t, "anisubs-rss", "pass-1234", "user", "active")
	token := env.token(t, id, "user", "anisubs-rss")

	resp := env.do(t, http.MethodGet,
		"/api/stream/anisubs/search?source=ani_subs_rss_1&keyword=%E5%AD%A4%E7%8B%AC", token, nil)
	if resp.status != http.StatusOK {
		t.Fatalf("搜索期望 200，实际 %d %s", resp.status, resp.raw)
	}
	results, _ := resp.body["results"].([]any)
	if len(results) != 1 {
		t.Fatalf("结果 = %v", resp.body["results"])
	}
	item, _ := results[0].(map[string]any)
	if item["id"] != "https://example.com/ep/1" {
		t.Errorf("结果 = %v", item)
	}

	resp = env.do(t, http.MethodGet,
		"/api/stream/anisubs/episodes?source=ani_subs_rss_1&identifier="+item["id"].(string), token, nil)
	if resp.status != http.StatusOK {
		t.Fatalf("分集期望 200，实际 %d %s", resp.status, resp.raw)
	}
	episodes, _ := resp.body["episodes"].([]any)
	if len(episodes) != 1 {
		t.Fatalf("分集 = %v", resp.body["episodes"])
	}

	resp = env.do(t, http.MethodPost, "/api/stream/anisubs/resolve", token, map[string]any{
		"source": "ani_subs_rss_1", "episode": episodes[0],
	})
	if resp.status != http.StatusOK || resp.body["url"] != "https://cdn.example.com/1.mp4" {
		t.Fatalf("解析 = %d %v", resp.status, resp.body)
	}
	// RSS 直链没有 headers（Node 侧同样不下发）。
	if _, exists := resp.body["headers"]; exists {
		t.Errorf("RSS 源不该下发 headers: %v", resp.body)
	}
}
