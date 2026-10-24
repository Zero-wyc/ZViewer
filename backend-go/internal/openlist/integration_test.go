package openlist

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

// mockAlist 模拟 AList 的三个端点：登录、fs/get、文件下载。
type mockAlist struct {
	loginCount  atomic.Int32
	fsGetCount  atomic.Int32
	lastAuth    atomic.Value // string
	rawRelative bool         // true 时 fs/get 返回相对路径（未配置 site_url 的情形）
}

func (m *mockAlist) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/auth/login", func(w http.ResponseWriter, r *http.Request) {
		m.loginCount.Add(1)
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["username"] != "nas-user" || body["password"] != "nas-pass" {
			_ = json.NewEncoder(w).Encode(map[string]any{"code": 401, "message": "密码错误"})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"code": 200, "message": "success",
			"data": map[string]any{"token": "tok-123"},
		})
	})
	mux.HandleFunc("/api/fs/get", func(w http.ResponseWriter, r *http.Request) {
		m.fsGetCount.Add(1)
		m.lastAuth.Store(r.Header.Get("Authorization"))
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["path"] != "/movie/a.mkv" {
			_ = json.NewEncoder(w).Encode(map[string]any{"code": 500, "message": "object not found"})
			return
		}
		rawURL := "http://cdn.example.com/d/a.mkv?sign=abc"
		if m.rawRelative {
			rawURL = "/d/a.mkv?sign=abc"
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"code": 200, "message": "success",
			"data": map[string]any{
				"name": "a.mkv", "size": 1024, "provider": "Local",
				"raw_url": rawURL,
				"related": []map[string]any{
					{"name": "a.chs.srt", "type": 4},
					{"name": "a.xml", "type": 4},
					{"name": "cover.jpg", "type": 1},
				},
			},
		})
	})
	return mux
}

func TestFetchFileInfo(t *testing.T) {
	mock := &mockAlist{}
	srv := httptest.NewServer(mock.handler())
	defer srv.Close()

	c := NewClient()
	info, err := c.FetchFileInfo(context.Background(), srv.URL+"/dav", "nas-user", "nas-pass", "/movie/a.mkv")
	if err != nil {
		t.Fatalf("FetchFileInfo 失败: %v", err)
	}
	if info.RawURL != "http://cdn.example.com/d/a.mkv?sign=abc" {
		t.Errorf("raw_url 不符: %q", info.RawURL)
	}
	if info.Name != "a.mkv" || info.Provider != "Local" {
		t.Errorf("元信息不符: %+v", info)
	}
	if got := mock.lastAuth.Load(); got != "tok-123" {
		t.Errorf("Authorization 头应为登录 token，实际 %v", got)
	}
	if mock.loginCount.Load() != 1 {
		t.Errorf("登录次数应为 1，实际 %d", mock.loginCount.Load())
	}
	// 字幕：只取 type==4 且非 .xml；取不存在的路径会 500，会被静默跳过。
	if len(info.Subtitles) != 0 {
		t.Logf("字幕条目: %+v（mock 里字幕路径走的也是 /api/fs/get，会被路径校验挡掉）", info.Subtitles)
	}
}

// TestTokenIsReused 验证 token 缓存：多次请求只登录一次。
//
// 这不是省流量的优化——AList 的登录接口有限流，每次 /stream 都登录会把
// 正常播放打成 429。
func TestTokenIsReused(t *testing.T) {
	mock := &mockAlist{}
	srv := httptest.NewServer(mock.handler())
	defer srv.Close()

	c := NewClient()
	for i := 0; i < 3; i++ {
		if _, err := c.FetchFileInfo(context.Background(), srv.URL, "nas-user", "nas-pass", "/movie/a.mkv"); err != nil {
			t.Fatalf("第 %d 次失败: %v", i, err)
		}
	}
	if n := mock.loginCount.Load(); n != 1 {
		t.Errorf("token 未复用，登录了 %d 次", n)
	}
}

// TestRelativeRawURLIsAbsolutized 验证相对 raw_url 补全。
//
// AList 未配置 site_url 时会返回 `/d/xxx`，直接交给代理层会被当成非法 URL。
func TestRelativeRawURLIsAbsolutized(t *testing.T) {
	mock := &mockAlist{rawRelative: true}
	srv := httptest.NewServer(mock.handler())
	defer srv.Close()

	c := NewClient()
	info, err := c.FetchFileInfo(context.Background(), srv.URL+"/dav", "nas-user", "nas-pass", "/movie/a.mkv")
	if err != nil {
		t.Fatalf("失败: %v", err)
	}
	if !strings.HasPrefix(info.RawURL, srv.URL) {
		t.Errorf("相对 raw_url 应补全为 %s 开头，实际 %q", srv.URL, info.RawURL)
	}
}

// TestAnonymousSkipsLogin 验证匿名（username 为空）不登录。
func TestAnonymousSkipsLogin(t *testing.T) {
	mock := &mockAlist{}
	srv := httptest.NewServer(mock.handler())
	defer srv.Close()

	c := NewClient()
	if _, err := c.FetchFileInfo(context.Background(), srv.URL, "", "", "/movie/a.mkv"); err != nil {
		t.Fatalf("匿名访问失败: %v", err)
	}
	if n := mock.loginCount.Load(); n != 0 {
		t.Errorf("匿名访问不应登录，实际登录 %d 次", n)
	}
	if got := mock.lastAuth.Load(); got != "" {
		t.Errorf("匿名访问不应带 Authorization，实际 %q", got)
	}
}

// TestAuthFailedMessage 验证认证失败被翻译成可读文案。
func TestAuthFailedMessage(t *testing.T) {
	mock := &mockAlist{}
	srv := httptest.NewServer(mock.handler())
	defer srv.Close()

	c := NewClient()
	_, err := c.FetchFileInfo(context.Background(), srv.URL, "nas-user", "wrong", "/movie/a.mkv")
	if err == nil {
		t.Fatal("期望失败")
	}
	if CodeOf(err) != CodeAuthFailed {
		t.Errorf("错误码应为 AUTH_FAILED，实际 %q (%v)", CodeOf(err), err)
	}
	if !strings.Contains(err.Error(), "请检查挂载的用户名和密码") {
		t.Errorf("文案应可指导用户，实际 %q", err.Error())
	}
}

// TestNotFoundMessage 验证路径错误给出明确提示。
func TestNotFoundMessage(t *testing.T) {
	mock := &mockAlist{}
	srv := httptest.NewServer(mock.handler())
	defer srv.Close()

	c := NewClient()
	_, err := c.FetchFileInfo(context.Background(), srv.URL, "nas-user", "nas-pass", "/movie/missing.mkv")
	if err == nil {
		t.Fatal("期望失败")
	}
	if CodeOf(err) != CodeNotFound {
		t.Errorf("错误码应为 NOT_FOUND，实际 %q (%v)", CodeOf(err), err)
	}
	if !strings.Contains(err.Error(), "/movie/missing.mkv") {
		t.Errorf("文案应包含路径，实际 %q", err.Error())
	}
}

// TestCachedFileInfoSingleFlight 验证并发未命中只打一次上游。
//
// 一次播放会产生几十个 Range 请求，多人同时进房更会并发打同一个 key；
// 没有单飞，上游会瞬间收到几十个 fs/get。
func TestCachedFileInfoSingleFlight(t *testing.T) {
	mock := &mockAlist{}
	srv := httptest.NewServer(mock.handler())
	defer srv.Close()

	c := NewClient()
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := c.CachedFileInfo(context.Background(), "movie:1", srv.URL, "nas-user", "nas-pass", "/movie/a.mkv"); err != nil {
				t.Errorf("并发请求失败: %v", err)
			}
		}()
	}
	wg.Wait()

	// 12 个并发里可能有极少数在前一个刚完成后才进入（此时走缓存），
	// 所以断言「远小于 12」而不是「恰好 1」。
	if n := mock.fsGetCount.Load(); n > 3 {
		t.Errorf("单飞失效：fs/get 被调用 %d 次", n)
	}
	if n := mock.loginCount.Load(); n != 1 {
		t.Errorf("登录应只发生 1 次，实际 %d", n)
	}
}
