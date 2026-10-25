package api_test

import (
	"io"
	"net/http"
	"strings"
	"testing"

	"zviewer/backend/internal/webfetch"
)

// Kazumi 端点的 HTTP 层验证（鉴权 + 参数校验 + 整链路）。
//
// 规则与站点页面都走假 transport：真实规则会去打外网，测试要可重复。

// stubTransport 按「host+path」返回固定文本。
type stubTransport struct {
	routes map[string]string
}

func (s *stubTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	body, ok := s.routes[req.URL.Host+req.URL.Path]
	if !ok {
		return &http.Response{
			StatusCode: http.StatusNotFound,
			Body:       io.NopCloser(strings.NewReader("not found")),
			Header:     http.Header{"Content-Type": []string{"text/plain"}},
			Request:    req,
		}, nil
	}
	contentType := "text/html; charset=utf-8"
	if strings.HasSuffix(req.URL.Path, ".json") {
		contentType = "application/json; charset=utf-8"
	}
	return &http.Response{
		StatusCode: http.StatusOK,
		Body:       io.NopCloser(strings.NewReader(body)),
		Header:     http.Header{"Content-Type": []string{contentType}},
		Request:    req,
	}, nil
}

// kazumiRuleJSON 是一份最小可用的 XPath 规则（站点指向 site.test）。
const kazumiRuleJSON = `{
  "name": "测试规则",
  "baseURL": "https://site.test/",
  "searchURL": "https://site.test/s?wd=@keyword",
  "searchList": "//div[@class='i']",
  "searchName": ".//h3/a",
  "searchResult": ".//a",
  "chapterRoads": "//ul[@class='road']",
  "chapterResult": ".//li/a",
  "searchMode": "xpath",
  "chapterMode": "xpath",
  "referer": "https://site.test/"
}`

// setupKazumi 装好假上游并把配置指向那份规则。
func setupKazumi(t *testing.T) *testEnv {
	t.Helper()

	restore := webfetch.SetTransport(&stubTransport{routes: map[string]string{
		"rules.test/one.json": kazumiRuleJSON,
		"site.test/s": `<html><body>
<div class="i"><h3><a href="/detail/1">番剧一</a></h3></div>
<div class="i"><h3><a href="/detail/2">番剧二</a></h3></div>
</body></html>`,
		"site.test/detail/1": `<html><body><ul class="road">
<li><a href="/play/good">第1集</a></li>
<li><a href="/play/none">第2集</a></li>
</ul></body></html>`,
		"site.test/play/good": `<html><body><video src="https://cdn.test/a.m3u8"></video></body></html>`,
		"site.test/play/none": `<html><body>什么都没有</body></html>`,
	}})
	t.Cleanup(restore)

	env := newTestEnv(t)
	t.Cleanup(env.teardown)
	env.setDataSourceConfig(t, `{"kazumiRules":["https://rules.test/one.json"]}`)
	return env
}

func TestKazumiRequiresAuth(t *testing.T) {
	env := setupKazumi(t)

	for _, path := range []string{
		"/api/stream/kazumi/sources",
		"/api/stream/kazumi/search?source=kazumi_0&keyword=x",
		"/api/stream/kazumi/episodes?source=kazumi_0&identifier=y",
	} {
		resp := env.do(t, http.MethodGet, path, "", nil)
		if resp.status != http.StatusUnauthorized {
			t.Errorf("%s 期望 401，实际 %d", path, resp.status)
		}
	}

	resp := env.do(t, http.MethodPost, "/api/stream/kazumi/resolve", "", map[string]any{})
	if resp.status != http.StatusUnauthorized {
		t.Errorf("resolve 期望 401，实际 %d", resp.status)
	}
}

func TestKazumiFullChain(t *testing.T) {
	env := setupKazumi(t)
	id := env.seedUser(t, "kazumi-user", "pass-1234", "user", "active")
	token := env.token(t, id, "user", "kazumi-user")

	resp := env.do(t, http.MethodGet, "/api/stream/kazumi/sources", token, nil)
	if resp.status != http.StatusOK {
		t.Fatalf("sources 期望 200，实际 %d %s", resp.status, resp.raw)
	}
	sources, _ := resp.body["sources"].([]any)
	if len(sources) != 1 {
		t.Fatalf("sources = %v", resp.body["sources"])
	}
	first, _ := sources[0].(map[string]any)
	if first["id"] != "kazumi_0" || first["name"] != "测试规则" {
		t.Errorf("数据源 = %v", first)
	}

	resp = env.do(t, http.MethodGet, "/api/stream/kazumi/search?source=kazumi_0&keyword=%E7%95%AA", token, nil)
	if resp.status != http.StatusOK {
		t.Fatalf("search 期望 200，实际 %d %s", resp.status, resp.raw)
	}
	results, _ := resp.body["results"].([]any)
	if len(results) != 2 {
		t.Fatalf("搜索结果 = %v", resp.body["results"])
	}
	firstResult, _ := results[0].(map[string]any)
	if firstResult["id"] != "https://site.test/detail/1" || firstResult["source"] != "kazumi_0" {
		t.Errorf("首条结果 = %v", firstResult)
	}

	resp = env.do(t, http.MethodGet,
		"/api/stream/kazumi/episodes?source=kazumi_0&identifier="+
			"https%3A%2F%2Fsite.test%2Fdetail%2F1", token, nil)
	if resp.status != http.StatusOK {
		t.Fatalf("episodes 期望 200，实际 %d %s", resp.status, resp.raw)
	}
	episodes, _ := resp.body["episodes"].([]any)
	if len(episodes) != 2 {
		t.Fatalf("分集 = %v", resp.body["episodes"])
	}
	firstEpisode, _ := episodes[0].(map[string]any)
	if firstEpisode["title"] != "第1集" || firstEpisode["episodeNumber"].(float64) != 1 {
		t.Errorf("首集 = %v", firstEpisode)
	}

	// 直链 + Referer 透传。
	resp = env.do(t, http.MethodPost, "/api/stream/kazumi/resolve", token, map[string]any{
		"source":  "kazumi_0",
		"episode": firstEpisode,
	})
	if resp.status != http.StatusOK {
		t.Fatalf("resolve 期望 200，实际 %d %s", resp.status, resp.raw)
	}
	if resp.body["url"] != "https://cdn.test/a.m3u8" || resp.body["format"] != "hls" {
		t.Errorf("解析结果 = %v", resp.body)
	}
	headers, _ := resp.body["headers"].(map[string]any)
	if headers["Referer"] != "https://site.test/" {
		t.Errorf("请求头 = %v", headers)
	}

	// 同一集再解一次：走 6 分钟缓存。
	resp = env.do(t, http.MethodPost, "/api/stream/kazumi/resolve", token, map[string]any{
		"source":  "kazumi_0",
		"episode": firstEpisode,
	})
	if resp.status != http.StatusOK || resp.body["url"] != "https://cdn.test/a.m3u8" {
		t.Errorf("缓存后解析 = %d %v", resp.status, resp.body)
	}

	// 页面里没有可播地址 → 404（不是 502）。
	secondEpisode, _ := episodes[1].(map[string]any)
	resp = env.do(t, http.MethodPost, "/api/stream/kazumi/resolve", token, map[string]any{
		"source":  "kazumi_0",
		"episode": secondEpisode,
	})
	if resp.status != http.StatusNotFound {
		t.Errorf("无地址期望 404，实际 %d %s", resp.status, resp.raw)
	}
	if resp.body["message"] != "无法解析播放地址" {
		t.Errorf("文案 = %v", resp.body["message"])
	}
}

func TestKazumiParamValidation(t *testing.T) {
	env := setupKazumi(t)
	id := env.seedUser(t, "kazumi-validator", "pass-1234", "user", "active")
	token := env.token(t, id, "user", "kazumi-validator")

	cases := []struct {
		name    string
		method  string
		path    string
		body    any
		status  int
		message string
	}{
		{
			name: "缺 source（搜索）", method: http.MethodGet,
			path: "/api/stream/kazumi/search?keyword=x", status: 400, message: "缺少 source 参数",
		},
		{
			name: "缺 keyword", method: http.MethodGet,
			path: "/api/stream/kazumi/search?source=kazumi_0", status: 400, message: "缺少 keyword 参数",
		},
		{
			name: "未知数据源", method: http.MethodGet,
			path: "/api/stream/kazumi/search?source=kazumi_9&keyword=x", status: 400, message: "未知的数据源",
		},
		{
			name: "缺 identifier", method: http.MethodGet,
			path: "/api/stream/kazumi/episodes?source=kazumi_0", status: 400, message: "缺少 identifier 参数",
		},
		{
			name: "resolve 缺 source", method: http.MethodPost,
			path: "/api/stream/kazumi/resolve", body: map[string]any{"episode": map[string]any{}},
			status: 400, message: "缺少 source 参数",
		},
		{
			name: "resolve 缺 episode", method: http.MethodPost,
			path: "/api/stream/kazumi/resolve", body: map[string]any{"source": "kazumi_0"},
			status: 400, message: "缺少 episode 参数",
		},
		{
			name: "resolve 缺播放参数", method: http.MethodPost,
			path: "/api/stream/kazumi/resolve",
			body: map[string]any{"source": "kazumi_0", "episode": map[string]any{"id": "x"}},
			// 没有 episodeUrl 是「请求不对」，属于 502（Node 抛普通 Error）。
			status: 502, message: "缺少剧集页面地址",
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			resp := env.do(t, c.method, c.path, token, c.body)
			if resp.status != c.status {
				t.Fatalf("期望 %d，实际 %d %s", c.status, resp.status, resp.raw)
			}
			if resp.body["message"] != c.message {
				t.Errorf("文案 = %v，期望 %s", resp.body["message"], c.message)
			}
		})
	}
}
