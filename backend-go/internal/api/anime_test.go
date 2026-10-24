package api_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// 动漫源端点的 HTTP 层验证（路由校验 + 注册表透出 + 第三方源整链路）。

// setDataSourceConfig 改写 settings 里的动漫源配置。
//
// 注册表按配置 JSON 内容做指纹，改完下一次请求即重建，无需重启。
func (e *testEnv) setDataSourceConfig(t *testing.T, config string) {
	t.Helper()
	// 设置表可能还没有行（GET 会返回内置默认值但不落库），先补一行再改。
	res, err := e.conn.Exec(`UPDATE "system_settings" SET "dataSourceConfig" = ?`, config)
	if err != nil {
		t.Fatalf("写入动漫源配置失败: %v", err)
	}
	if affected, _ := res.RowsAffected(); affected == 0 {
		if _, err := e.conn.Exec(
			`INSERT INTO "system_settings" ("dataSourceConfig") VALUES (?)`, config,
		); err != nil {
			t.Fatalf("创建设置行失败: %v", err)
		}
	}
}

func TestAnimeRequiresAuth(t *testing.T) {
	env := newTestEnv(t)
	defer env.teardown()

	for _, path := range []string{
		"/api/stream/anime/sources",
		"/api/stream/anime/search?source=x&keyword=y",
		"/api/stream/anime/episodes?source=x&identifier=y",
	} {
		resp := env.do(t, http.MethodGet, path, "", nil)
		if resp.status != http.StatusUnauthorized {
			t.Errorf("%s 期望 401，实际 %d", path, resp.status)
		}
	}

	resp := env.do(t, http.MethodPost, "/api/stream/anime/resolve", "", map[string]any{})
	if resp.status != http.StatusUnauthorized {
		t.Errorf("resolve 期望 401，实际 %d", resp.status)
	}
}

func TestAnimeSourcesBuiltin(t *testing.T) {
	env := newTestEnv(t)
	defer env.teardown()

	id := env.seedUser(t, "anime-user", "pass-1234", "user", "active")
	token := env.token(t, id, "user", "anime-user")

	resp := env.do(t, http.MethodGet, "/api/stream/anime/sources", token, nil)
	if resp.status != http.StatusOK {
		t.Fatalf("期望 200，实际 %d %s", resp.status, resp.raw)
	}
	if resp.body["success"] != true {
		t.Errorf("success = %v", resp.body["success"])
	}
	sources, ok := resp.body["sources"].([]any)
	if !ok || len(sources) == 0 {
		t.Fatalf("sources = %v", resp.body["sources"])
	}
	first, _ := sources[0].(map[string]any)
	if first["id"] != "bilibili_bangumi" || first["name"] != "哔哩哔哩番剧" {
		t.Errorf("首个数据源 = %v", first)
	}
}

func TestAnimeParamValidation(t *testing.T) {
	env := newTestEnv(t)
	defer env.teardown()

	id := env.seedUser(t, "anime-validator", "pass-1234", "user", "active")
	token := env.token(t, id, "user", "anime-validator")

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
			path: "/api/stream/anime/search?keyword=x", status: http.StatusBadRequest, message: "缺少 source 参数",
		},
		{
			name: "搜索 source 空白", method: http.MethodGet,
			path: "/api/stream/anime/search?source=%20%20&keyword=x", status: http.StatusBadRequest, message: "缺少 source 参数",
		},
		{
			name: "搜索未知 source", method: http.MethodGet,
			path: "/api/stream/anime/search?source=nope&keyword=x", status: http.StatusBadRequest, message: "未知的番剧数据源",
		},
		{
			name: "搜索缺 keyword", method: http.MethodGet,
			path: "/api/stream/anime/search?source=bilibili_bangumi", status: http.StatusBadRequest, message: "缺少 keyword 参数",
		},
		{
			name: "分集缺 source", method: http.MethodGet,
			path: "/api/stream/anime/episodes?identifier=1", status: http.StatusBadRequest, message: "缺少 source 参数",
		},
		{
			name: "分集缺 identifier", method: http.MethodGet,
			path: "/api/stream/anime/episodes?source=bilibili_bangumi", status: http.StatusBadRequest, message: "缺少 identifier 参数",
		},
		{
			name: "解析缺 source", method: http.MethodPost,
			path: "/api/stream/anime/resolve", body: map[string]any{"episode": map[string]any{}},
			status: http.StatusBadRequest, message: "缺少 source 参数",
		},
		{
			name: "解析 source 非字符串", method: http.MethodPost,
			path: "/api/stream/anime/resolve", body: map[string]any{"source": 5, "episode": map[string]any{}},
			status: http.StatusBadRequest, message: "缺少 source 参数",
		},
		{
			name: "解析缺 episode", method: http.MethodPost,
			path: "/api/stream/anime/resolve", body: map[string]any{"source": "bilibili_bangumi"},
			status: http.StatusBadRequest, message: "缺少 episode 参数",
		},
		{
			// typeof null === 'object'，但 !null 为真 → 仍然报缺参数。
			name: "解析 episode 为 null", method: http.MethodPost,
			path: "/api/stream/anime/resolve", body: map[string]any{"source": "bilibili_bangumi", "episode": nil},
			status: http.StatusBadRequest, message: "缺少 episode 参数",
		},
		{
			name: "解析 episode 为字符串", method: http.MethodPost,
			path: "/api/stream/anime/resolve", body: map[string]any{"source": "bilibili_bangumi", "episode": "x"},
			status: http.StatusBadRequest, message: "缺少 episode 参数",
		},
		{
			// B站 源在缺 bvid/cid 时报错 → 502 带上游文案。
			name: "解析缺播放参数", method: http.MethodPost,
			path:   "/api/stream/anime/resolve",
			body:   map[string]any{"source": "bilibili_bangumi", "episode": map[string]any{"id": "1", "title": "t"}},
			status: http.StatusBadGateway, message: "缺少有效的 B站 BV/CID 参数",
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

func TestAnimeBilibiliResolve(t *testing.T) {
	env := newTestEnv(t)
	defer env.teardown()

	id := env.seedUser(t, "anime-bili", "pass-1234", "user", "active")
	token := env.token(t, id, "user", "anime-bili")

	resp := env.do(t, http.MethodPost, "/api/stream/anime/resolve", token, map[string]any{
		"source": "bilibili_bangumi",
		"episode": map[string]any{
			"id":             "1-2",
			"title":          "第 2 话",
			"episodeNumber":  "2",
			"playbackParams": map[string]any{"bvid": "BV1xx411c7mD", "cid": 123},
		},
	})
	if resp.status != http.StatusOK {
		t.Fatalf("期望 200，实际 %d %s", resp.status, resp.raw)
	}
	if resp.body["url"] != "/api/stream/resolve-bilibili?url=https%3A%2F%2Fwww.bilibili.com%2Fvideo%2FBV1xx411c7mD" {
		t.Errorf("url = %v", resp.body["url"])
	}
	headers, _ := resp.body["headers"].(map[string]any)
	if headers["Referer"] != "https://www.bilibili.com" {
		t.Errorf("headers = %v", headers)
	}
}

// TestAnimeThirdPartyFlow 用假上游跑通 搜索 → 分集 → 解析 三段。
func TestAnimeThirdPartyFlow(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/search":
			if r.URL.Query().Get("keyword") != "孤独" {
				http.Error(w, `{"error":"bad keyword"}`, http.StatusBadRequest)
				return
			}
			_, _ = w.Write([]byte(`{"data":[{"animeId":"7","name":"孤独摇滚","cover":"https://cdn/a.jpg"}]}`))
		case "/episodes/7":
			_, _ = w.Write([]byte(`[{"id":"e1","title":"第一话","episodeNumber":1,"playbackParams":{"ep":"e1"}}]`))
		case "/resolve/e1":
			_, _ = w.Write([]byte(`{"url":"https://cdn.example.com/1.m3u8","headers":{"Referer":"https://up.example"}}`))
		default:
			http.Error(w, `{"error":"not found"}`, http.StatusNotFound)
		}
	}))
	defer upstream.Close()

	env := newTestEnv(t)
	defer env.teardown()
	env.setDataSourceConfig(t, `{"thirdPartySources":[{"id":"fake","name":"假源","baseUrl":"`+upstream.URL+`"}]}`)

	id := env.seedUser(t, "anime-third", "pass-1234", "user", "active")
	token := env.token(t, id, "user", "anime-third")

	// 注册表要能看到配置出来的源。
	resp := env.do(t, http.MethodGet, "/api/stream/anime/sources", token, nil)
	sources, _ := resp.body["sources"].([]any)
	if len(sources) != 2 {
		t.Fatalf("数据源 = %v，期望内置源 + 假源共 2 个", sources)
	}
	second, _ := sources[1].(map[string]any)
	if second["id"] != "third_party_fake" || second["name"] != "假源" {
		t.Errorf("第二个源 = %v", second)
	}

	// 搜索
	resp = env.do(t, http.MethodGet,
		"/api/stream/anime/search?source=third_party_fake&keyword=%E5%AD%A4%E7%8B%AC", token, nil)
	if resp.status != http.StatusOK {
		t.Fatalf("搜索期望 200，实际 %d %s", resp.status, resp.raw)
	}
	results, _ := resp.body["results"].([]any)
	if len(results) != 1 {
		t.Fatalf("结果 = %v", resp.body["results"])
	}
	item, _ := results[0].(map[string]any)
	if item["id"] != "7" || item["title"] != "孤独摇滚" || item["source"] != "third_party_fake" {
		t.Errorf("搜索结果 = %v", item)
	}

	// 分集
	resp = env.do(t, http.MethodGet,
		"/api/stream/anime/episodes?source=third_party_fake&identifier=7", token, nil)
	if resp.status != http.StatusOK {
		t.Fatalf("分集期望 200，实际 %d %s", resp.status, resp.raw)
	}
	episodes, _ := resp.body["episodes"].([]any)
	if len(episodes) != 1 {
		t.Fatalf("分集 = %v", resp.body["episodes"])
	}

	// 解析
	resp = env.do(t, http.MethodPost, "/api/stream/anime/resolve", token, map[string]any{
		"source":  "third_party_fake",
		"episode": episodes[0],
	})
	if resp.status != http.StatusOK {
		t.Fatalf("解析期望 200，实际 %d %s", resp.status, resp.raw)
	}
	if resp.body["url"] != "https://cdn.example.com/1.m3u8" {
		t.Errorf("url = %v", resp.body["url"])
	}
}

// TestAnimeThirdPartyResolveNull 上游不返回地址 → 404「无法解析播放地址」。
func TestAnimeThirdPartyResolveNull(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":{"other":1}}`))
	}))
	defer upstream.Close()

	env := newTestEnv(t)
	defer env.teardown()
	env.setDataSourceConfig(t, `{"thirdPartySources":[{"id":"nil","baseUrl":"`+upstream.URL+`"}]}`)

	id := env.seedUser(t, "anime-nil", "pass-1234", "user", "active")
	token := env.token(t, id, "user", "anime-nil")

	resp := env.do(t, http.MethodPost, "/api/stream/anime/resolve", token, map[string]any{
		"source":  "third_party_nil",
		"episode": map[string]any{"id": "x"},
	})
	if resp.status != http.StatusNotFound || resp.message() != "无法解析播放地址" {
		t.Fatalf("期望 404 无法解析播放地址，实际 %d %q", resp.status, resp.message())
	}
}

// TestAnimeThirdPartyUpstreamError 上游非 2xx → 502 带「[状态码]: 地址」。
func TestAnimeThirdPartyUpstreamError(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	defer upstream.Close()

	env := newTestEnv(t)
	defer env.teardown()
	env.setDataSourceConfig(t, `{"thirdPartySources":[{"id":"bad","baseUrl":"`+upstream.URL+`"}]}`)

	id := env.seedUser(t, "anime-bad", "pass-1234", "user", "active")
	token := env.token(t, id, "user", "anime-bad")

	resp := env.do(t, http.MethodGet,
		"/api/stream/anime/search?source=third_party_bad&keyword=x", token, nil)
	if resp.status != http.StatusBadGateway {
		t.Fatalf("期望 502，实际 %d %s", resp.status, resp.raw)
	}
	var payload map[string]any
	_ = json.Unmarshal([]byte(resp.raw), &payload)
	message, _ := payload["message"].(string)
	if message == "" || message[:len("第三方数据源请求失败")] != "第三方数据源请求失败" {
		t.Errorf("message = %q", message)
	}
}
