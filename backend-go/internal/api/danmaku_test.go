package api_test

import (
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"zviewer/backend/internal/webfetch"
)

// 多源弹幕端点的 HTTP 层验证：鉴权、参数校验、简繁三路合并与去重。

// danmakuTransport 按「关键词」挑夹具，用来验证三路搜索的合并顺序。
type danmakuTransport struct {
	byKeyword map[string]string
}

func (d *danmakuTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	body := `<html><body></body></html>`
	if req.URL.Path == "/search.php" {
		if fixture, ok := d.byKeyword[req.URL.Query().Get("keyword")]; ok {
			body = fixture
		}
	}
	return &http.Response{
		StatusCode: http.StatusOK,
		Body:       io.NopCloser(strings.NewReader(body)),
		Header:     http.Header{"Content-Type": []string{"text/html; charset=utf-8"}},
		Request:    req,
	}, nil
}

// bahamutBlock 拼一个 theme-list-main 区块。
func bahamutBlock(sn, title string) string {
	return `<a class="theme-list-main" href="animeRef.php?sn=` + sn + `">
    <div class="theme-img"><img data-src="//cdn.test/` + sn + `.jpg" alt="` + title + `"></div>
  </a>`
}

func TestDanmakuRequiresAuth(t *testing.T) {
	env := newTestEnv(t)
	defer env.teardown()

	for _, path := range []string{
		"/api/stream/danmaku/sources",
		"/api/stream/danmaku/search?source=bahamut&keyword=x",
		"/api/stream/danmaku/episodes?source=bahamut&identifier=1",
	} {
		resp := env.do(t, http.MethodGet, path, "", nil)
		if resp.status != http.StatusUnauthorized {
			t.Errorf("%s 期望 401，实际 %d", path, resp.status)
		}
	}

	resp := env.do(t, http.MethodPost, "/api/stream/danmaku/fetch", "", map[string]any{})
	if resp.status != http.StatusUnauthorized {
		t.Errorf("fetch 期望 401，实际 %d", resp.status)
	}
}

func TestDanmakuSources(t *testing.T) {
	env := newTestEnv(t)
	defer env.teardown()

	id := env.seedUser(t, "danmaku-user", "pass-1234", "user", "active")
	token := env.token(t, id, "user", "danmaku-user")

	resp := env.do(t, http.MethodGet, "/api/stream/danmaku/sources", token, nil)
	if resp.status != http.StatusOK {
		t.Fatalf("期望 200，实际 %d %s", resp.status, resp.raw)
	}
	sources, _ := resp.body["sources"].([]any)
	if len(sources) != 4 {
		t.Fatalf("弹幕源 = %v", resp.body["sources"])
	}
	wantIDs := []string{"bilibili-video", "bilibili-bangumi", "bahamut", "dandanplay"}
	for index, want := range wantIDs {
		item, _ := sources[index].(map[string]any)
		if item["id"] != want {
			t.Errorf("第 %d 个源 = %v，期望 %s", index, item["id"], want)
		}
	}
}

func TestDanmakuSearchMergesVariants(t *testing.T) {
	// 简体关键词会被派生成「原文 + 繁体 + 简体」三路；繁体那路能搜到目标，
	// 原文那路只搜到一个同名干扰项，简体那路与原文重复。
	restore := webfetch.SetTransport(&danmakuTransport{byKeyword: map[string]string{
		"孤独摇滚": `<html><body>` + bahamutBlock("111", "无关条目") + `</body></html>`,
		"孤獨搖滾": `<html><body>` + bahamutBlock("222", "孤獨搖滾！") + bahamutBlock("111", "重複") + `</body></html>`,
	}})
	t.Cleanup(restore)

	env := newTestEnv(t)
	defer env.teardown()
	id := env.seedUser(t, "danmaku-search", "pass-1234", "user", "active")
	token := env.token(t, id, "user", "danmaku-search")

	resp := env.do(t, http.MethodGet,
		"/api/stream/danmaku/search?source=bahamut&keyword="+url.QueryEscape("孤独摇滚"), token, nil)
	if resp.status != http.StatusOK {
		t.Fatalf("期望 200，实际 %d %s", resp.status, resp.raw)
	}
	results, _ := resp.body["results"].([]any)
	if len(results) != 2 {
		t.Fatalf("结果 = %v，期望 2 条（按 id 去重）", resp.body["results"])
	}
	first, _ := results[0].(map[string]any)
	second, _ := results[1].(map[string]any)
	// 标题命中关键词变体的排在前面。
	if first["id"] != "222" {
		t.Errorf("首条 = %v，期望命中项 222", first)
	}
	if second["id"] != "111" || second["title"] != "无关条目" {
		t.Errorf("次条 = %v，期望保留首次出现的 111", second)
	}
}

func TestDanmakuParamValidation(t *testing.T) {
	env := newTestEnv(t)
	defer env.teardown()
	id := env.seedUser(t, "danmaku-validator", "pass-1234", "user", "active")
	token := env.token(t, id, "user", "danmaku-validator")

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
			path: "/api/stream/danmaku/search?keyword=x", status: 400, message: "缺少 source 参数",
		},
		{
			name: "缺 keyword", method: http.MethodGet,
			path: "/api/stream/danmaku/search?source=bahamut", status: 400, message: "缺少 keyword 参数",
		},
		{
			name: "未知弹幕源", method: http.MethodGet,
			path: "/api/stream/danmaku/search?source=nope&keyword=x", status: 400, message: "未知的弹幕源",
		},
		{
			name: "缺 identifier", method: http.MethodGet,
			path: "/api/stream/danmaku/episodes?source=bahamut", status: 400, message: "缺少 identifier 参数",
		},
		{
			name: "fetch 缺 source", method: http.MethodPost,
			path: "/api/stream/danmaku/fetch", body: map[string]any{"episode": map[string]any{}},
			status: 400, message: "缺少 source 参数",
		},
		{
			name: "fetch 缺 episode", method: http.MethodPost,
			path: "/api/stream/danmaku/fetch", body: map[string]any{"source": "bahamut"},
			status: 400, message: "缺少 episode 参数",
		},
		{
			name: "无法解析 BV 号", method: http.MethodGet,
			path:   "/api/stream/danmaku/episodes?source=bilibili-video&identifier=abc",
			status: 502, message: "无法解析 BV 号",
		},
		{
			name: "缺 cid", method: http.MethodPost,
			path: "/api/stream/danmaku/fetch",
			body: map[string]any{
				"source":  "bilibili-bangumi",
				"episode": map[string]any{"id": "x", "playbackParams": map[string]any{}},
			},
			status: 502, message: "缺少 cid 参数",
		},
		{
			name: "巴哈姆特 SN 非法", method: http.MethodGet,
			path:   "/api/stream/danmaku/episodes?source=bahamut&identifier=abc",
			status: 502, message: "无法解析巴哈姆特 SN",
		},
		{
			name: "弹弹play animeId 非法", method: http.MethodGet,
			path:   "/api/stream/danmaku/episodes?source=dandanplay&identifier=abc",
			status: 502, message: "无法解析弹弹play animeId",
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
