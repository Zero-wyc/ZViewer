package mediaapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"zviewer/backend/internal/store"
)

// issue #45 的现场复刻：非管理员账号的 Emby。
//
//   - POST /emby/Users/authenticatebyname —— 正常返回 AccessToken + User.Id；
//   - GET  /emby/Users/Me —— Emby 没有这个端点，把 "Me" 当 GUID 解析 → 500；
//   - GET  /emby/Users    —— 需要 ManageServer，普通观影账号 → 403；
//   - GET  /emby/Users/{id}/Views —— 正常。
//
// 旧实现只在「有 API Key」时才用库里存的 userId，账号密码挂载于是每次都
// 走 Me()：先吃一个 500，再撞 403，媒体库直接打不开。
type fakeEmby struct {
	*httptest.Server
	userID string
	admin  bool // /Users 是否放行（模拟 API Key / 管理员）
	mu     sync.Mutex
	paths  []string
}

func newFakeEmby(t *testing.T, userID string, admin bool) *fakeEmby {
	t.Helper()
	f := &fakeEmby{userID: userID, admin: admin}
	f.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.paths = append(f.paths, r.Method+" "+r.URL.Path)
		f.mu.Unlock()

		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/emby/Users/authenticatebyname":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"AccessToken": "tok-" + f.userID,
				"ServerId":    "srv-1",
				"User":        map[string]string{"Id": f.userID, "Name": "viewer"},
			})
		case r.URL.Path == "/emby/Users/Me":
			w.WriteHeader(http.StatusInternalServerError)
			_ = json.NewEncoder(w).Encode(map[string]string{"Message": "Unrecognized Guid format."})
		case r.URL.Path == "/emby/Users":
			if !f.admin {
				w.WriteHeader(http.StatusForbidden)
				_ = json.NewEncoder(w).Encode(map[string]string{
					"Message": "User does not have access to ManageServer feature.",
				})
				return
			}
			_ = json.NewEncoder(w).Encode([]map[string]any{
				{"Id": "admin-1", "Name": "boss", "Policy": map[string]bool{"IsAdministrator": true}},
			})
		case strings.HasPrefix(r.URL.Path, "/emby/Users/") && strings.HasSuffix(r.URL.Path, "/Views"):
			_ = json.NewEncoder(w).Encode(map[string]any{"Items": []map[string]string{}})
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(f.Server.Close)
	return f
}

// count 返回某个「方法 + 路径」被打了几次。
func (f *fakeEmby) count(methodPath string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, p := range f.paths {
		if p == methodPath {
			n++
		}
	}
	return n
}

func strPtr(v string) *string { return &v }

// 账号密码挂载 + 库里已存 userId：直接用，不发 /Users/Me，也不发 /Users。
//
// 这是 issue #45 的回归点：旧实现的判定把「有 API Key」也算进条件里，
// 账号密码挂载永远拿不到自己的 userId。
func TestResolveSessionPrefersStoredUserID(t *testing.T) {
	f := newFakeEmby(t, "u-alice", false)
	mount := &store.Mount{
		Type:       "emby",
		ServerURL:  strPtr(f.URL),
		Username:   strPtr("alice-1"),
		Password:   strPtr("pw-1"),
		EmbyUserID: strPtr("u-alice"),
	}

	session, err := ResolveSessionWithProtocol(context.Background(), mount, testProtocol)
	if err != nil {
		t.Fatalf("账号密码挂载不应因为拿 userId 失败: %v", err)
	}
	if session.UserID != "u-alice" {
		t.Errorf("应使用库里的 userId，实际 %q", session.UserID)
	}
	if got := f.count("GET /emby/Users/Me"); got != 0 {
		t.Errorf("不应请求 /Users/Me（Emby 会 500），实际 %d 次", got)
	}
	if got := f.count("GET /emby/Users"); got != 0 {
		t.Errorf("不应请求全量 /Users（普通账号会 403），实际 %d 次", got)
	}
	if got := f.count("POST /emby/Users/authenticatebyname"); got != 1 {
		t.Errorf("登录应恰好一次（随后走缓存），实际 %d 次", got)
	}
}

// 库里没有 userId（老数据）时用登录结果里的 User.Id，仍然不发 /Users。
func TestResolveSessionUsesLoginUserIDWhenRowHasNone(t *testing.T) {
	f := newFakeEmby(t, "u-bob", false)
	mount := &store.Mount{
		Type:      "emby",
		ServerURL: strPtr(f.URL),
		Username:  strPtr("bob-1"),
		Password:  strPtr("pw-1"),
	}

	session, err := ResolveSessionWithProtocol(context.Background(), mount, testProtocol)
	if err != nil {
		t.Fatalf("ResolveSession: %v", err)
	}
	if session.UserID != "u-bob" {
		t.Errorf("应使用登录返回的 userId，实际 %q", session.UserID)
	}
	if f.count("GET /emby/Users/Me") != 0 || f.count("GET /emby/Users") != 0 {
		t.Errorf("/Users* 不应被请求: %v", f.paths)
	}
}

// API Key + 库里已有 userId：一个请求都不该发。
func TestResolveSessionAPIKeyUsesStoredUserID(t *testing.T) {
	f := newFakeEmby(t, "u-carol", false)
	mount := &store.Mount{
		Type:       "emby",
		ServerURL:  strPtr(f.URL),
		APIKey:     strPtr("key-1"),
		EmbyUserID: strPtr("u-carol"),
	}

	session, err := ResolveSessionWithProtocol(context.Background(), mount, testProtocol)
	if err != nil {
		t.Fatalf("ResolveSession: %v", err)
	}
	if session.UserID != "u-carol" {
		t.Errorf("应使用库里的 userId，实际 %q", session.UserID)
	}
	if len(f.paths) != 0 {
		t.Errorf("不应产生任何上游请求，实际 %v", f.paths)
	}
}

// 「API Key + 库里没有 userId」是唯一还需要 Me() 的路径：保留兜底。
func TestResolveSessionFallsBackToUserList(t *testing.T) {
	f := newFakeEmby(t, "u-dave", true)
	mount := &store.Mount{
		Type:      "emby",
		ServerURL: strPtr(f.URL),
		APIKey:    strPtr("key-2"),
	}

	session, err := ResolveSessionWithProtocol(context.Background(), mount, testProtocol)
	if err != nil {
		t.Fatalf("ResolveSession: %v", err)
	}
	if session.UserID != "admin-1" {
		t.Errorf("应取列表里的管理员，实际 %q", session.UserID)
	}
	// testProtocol 声明了 /Users/Me，所以这里会先试一次再回退。
	if got := f.count("GET /emby/Users"); got != 1 {
		t.Errorf("/Users 应被请求一次，实际 %d", got)
	}
}
