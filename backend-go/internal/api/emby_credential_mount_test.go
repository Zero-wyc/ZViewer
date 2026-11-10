package api_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"zviewer/backend/internal/store"
)

// issue #45 的端到端复现：账号密码挂载浏览媒体库。
//
// 上游按真实 Emby 的行为应答（非管理员账号）：
//
//   - authenticatebyname 正常，返回 User.Id；
//   - /Users/Me → 500（Emby 把 "Me" 当 GUID 解析）；
//   - /Users    → 403（需要 ManageServer 权限）；
//   - /Users/{id}/Views → 200。
//
// 修复前 ResolveSession 只在「有 API Key」时用库里的 userId，账号密码挂载
// 必然走 Me()，于是 403，浏览直接失败。
func TestEmbyCredentialMountBrowse(t *testing.T) {
	for _, tc := range []struct {
		name       string
		storedUser string // 空表示库里没有 embyUserId（老数据）
	}{
		{name: "stored-user-id", storedUser: "u-viewer"},
		{name: "row-without-user-id"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e := newTestEnv(t)
			defer e.teardown()
			owner := e.seedUser(t, "cred-owner", "fixture-password", "user", "active")
			token := e.token(t, owner, "user", "cred-owner")

			var mu sync.Mutex
			var paths []string
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				mu.Lock()
				paths = append(paths, r.URL.Path)
				mu.Unlock()

				w.Header().Set("Content-Type", "application/json")
				switch {
				case r.URL.Path == "/emby/Users/authenticatebyname":
					_ = json.NewEncoder(w).Encode(map[string]any{
						"AccessToken": "tok-viewer",
						"ServerId":    "srv-1",
						"User":        map[string]string{"Id": "u-viewer", "Name": "viewer"},
					})
				case r.URL.Path == "/emby/Users/Me":
					w.WriteHeader(http.StatusInternalServerError)
					_, _ = w.Write([]byte(`{"Message":"Unrecognized Guid format."}`))
				case r.URL.Path == "/emby/Users":
					w.WriteHeader(http.StatusForbidden)
					_, _ = w.Write([]byte(`{"Message":"User does not have access to ManageServer feature."}`))
				case strings.HasPrefix(r.URL.Path, "/emby/Users/") && strings.HasSuffix(r.URL.Path, "/Views"):
					_, _ = w.Write([]byte(`{"Items":[{"Id":"lib-1","Name":"电影","Type":"CollectionFolder"}]}`))
				default:
					http.NotFound(w, r)
				}
			}))
			defer upstream.Close()

			base, user, password := upstream.URL, "viewer", "pw"
			input := store.MountInput{
				UserID: owner, Type: "emby", Name: "客厅 NAS", ServerURL: &base,
				Username: &user, Password: &password,
			}
			if tc.storedUser != "" {
				input.EmbyUserID = &tc.storedUser
			}
			mount, err := store.NewMounts(e.conn).Create(context.Background(), input)
			if err != nil {
				t.Fatal(err)
			}

			res := e.do(t, "GET", fmt.Sprintf("/api/emby/mounts/%d/browse", mount.ID), token, nil)
			if res.status != http.StatusOK {
				t.Fatalf("浏览媒体库应成功，实际 %d: %s", res.status, res.raw)
			}
			entries, _ := res.body["entries"].([]any)
			if len(entries) != 1 {
				t.Fatalf("应返回 1 个媒体库，实际 %d: %s", len(entries), res.raw)
			}
			if first, _ := entries[0].(map[string]any); first["name"] != "电影" {
				t.Errorf("媒体库名称错误: %v", entries[0])
			}

			mu.Lock()
			defer mu.Unlock()
			for _, p := range paths {
				if p == "/emby/Users" {
					t.Errorf("不应请求全量 /Users（普通账号 403）: %v", paths)
				}
				if p == "/emby/Users/Me" {
					t.Errorf("不应请求 /Users/Me（Emby 不支持）: %v", paths)
				}
			}
		})
	}
}

// 更新挂载时 userId 的两种走向：改个名字不能把它弄丢，换了账号则必须换成
// 新账号的 userId（否则浏览会去查别人的媒体库）。
func TestEmbyUpdateMountRefreshesUserIDOnlyOnCredentialChange(t *testing.T) {
	e := newTestEnv(t)
	defer e.teardown()
	owner := e.seedUser(t, "cred-owner-2", "fixture-password", "user", "active")
	token := e.token(t, owner, "user", "cred-owner-2")

	userIDs := map[string]string{"alice": "u-alice", "bob": "u-bob"}
	var mu sync.Mutex
	var paths []string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		paths = append(paths, r.URL.Path)
		mu.Unlock()

		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/emby/Users/authenticatebyname":
			var body struct {
				Username string `json:"Username"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			id, ok := userIDs[body.Username]
			if !ok {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"AccessToken": "tok-" + id,
				"ServerId":    "srv-1",
				"User":        map[string]string{"Id": id, "Name": body.Username},
			})
		case r.URL.Path == "/emby/Users":
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"Message":"User does not have access to ManageServer feature."}`))
		case strings.HasPrefix(r.URL.Path, "/emby/Users/") && strings.HasSuffix(r.URL.Path, "/Views"):
			_, _ = w.Write([]byte(`{"Items":[]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer upstream.Close()

	base, user, password, stored := upstream.URL, "alice", "pw-a", "u-alice"
	mounts := store.NewMounts(e.conn)
	mount, err := mounts.Create(context.Background(), store.MountInput{
		UserID: owner, Type: "emby", Name: "NAS", ServerURL: &base,
		Username: &user, Password: &password, EmbyUserID: &stored,
	})
	if err != nil {
		t.Fatal(err)
	}

	// 只改名字：表单会把 serverUrl / username 一并带上，密码也照填原值。
	res := e.do(t, "PUT", fmt.Sprintf("/api/emby/mounts/%d", mount.ID), token, map[string]any{
		"name": "客厅 NAS", "serverUrl": base, "username": "alice", "password": "pw-a",
	})
	if res.status != http.StatusOK {
		t.Fatalf("更新失败 %d: %s", res.status, res.raw)
	}
	if got := reloadMount(t, mounts, mount.ID, owner); got != "u-alice" {
		t.Errorf("仅改名不应改变 userId，实际 %q", got)
	}

	// 换账号：userId 必须跟着换成新账号的。
	res = e.do(t, "PUT", fmt.Sprintf("/api/emby/mounts/%d", mount.ID), token, map[string]any{
		"name": "客厅 NAS", "serverUrl": base, "username": "bob", "password": "pw-b",
	})
	if res.status != http.StatusOK {
		t.Fatalf("更新失败 %d: %s", res.status, res.raw)
	}
	if got := reloadMount(t, mounts, mount.ID, owner); got != "u-bob" {
		t.Errorf("换账号后 userId 应为 u-bob，实际 %q", got)
	}

	// 换账号之后浏览必须走新账号的媒体库，且全程不碰 /Users。
	res = e.do(t, "GET", fmt.Sprintf("/api/emby/mounts/%d/browse", mount.ID), token, nil)
	if res.status != http.StatusOK {
		t.Fatalf("浏览失败 %d: %s", res.status, res.raw)
	}
	mu.Lock()
	defer mu.Unlock()
	var sawBobViews bool
	for _, p := range paths {
		if p == "/emby/Users" {
			t.Errorf("不应请求全量 /Users: %v", paths)
		}
		if p == "/emby/Users/u-bob/Views" {
			sawBobViews = true
		}
	}
	if !sawBobViews {
		t.Errorf("浏览应使用新账号的 userId: %v", paths)
	}
}

// reloadMount 读出库里当前的 embyUserId（空串表示 NULL）。
func reloadMount(t *testing.T, mounts *store.Mounts, id, owner int64) string {
	t.Helper()
	got, err := mounts.FindOwned(context.Background(), id, owner, "emby")
	if err != nil {
		t.Fatalf("读回挂载失败: %v", err)
	}
	if got.EmbyUserID == nil {
		return ""
	}
	return *got.EmbyUserID
}
