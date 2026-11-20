package api_test

import (
	"testing"
)

// TestMoviePermissionEndpoints 锁定「允许成员点片」的 HTTP 契约：
// 默认关闭、参数成对校验、仅房主可改、黑名单优先、落库后可回读。
func TestMoviePermissionEndpoints(t *testing.T) {
	e := newTestEnv(t)
	defer e.teardown()

	owner := e.seedUser(t, "movie-owner", "fixture-password", "user", "active")
	member := e.seedUser(t, "movie-member", "fixture-password", "user", "active")
	ownerToken := e.token(t, owner, "user", "movie-owner")
	memberToken := e.token(t, member, "user", "movie-member")
	e.seedRoom(t, "MOVPERM1", "active", &owner)
	// 成员要有未结束会话才读得到房间（requireRoomRead 的准入判定）。
	if _, err := e.conn.Exec(`INSERT INTO "session" ("roomId","socketId","role","userId") VALUES (?,?,?,?)`,
		"MOVPERM1", "sock-movie-member", "viewer", member); err != nil {
		t.Fatalf("插入会话失败: %v", err)
	}

	permissionOf := func(t *testing.T, got apiResponse) map[string]any {
		t.Helper()
		if got.status != 200 {
			t.Fatalf("状态码 = %d, want 200（%s）", got.status, got.raw)
		}
		perm, ok := got.body["permission"].(map[string]any)
		if !ok {
			t.Fatalf("响应缺 permission 对象: %s", got.raw)
		}
		return perm
	}

	t.Run("默认关闭且名单为空数组", func(t *testing.T) {
		perm := permissionOf(t, e.do(t, "GET", "/api/rooms/MOVPERM1/movie-permission", memberToken, nil))
		if perm["allowMembers"] != false {
			t.Fatalf("点片默认必须关闭: %v", perm)
		}
		allowed, ok := perm["allowedUserIds"].([]any)
		if !ok || len(allowed) != 0 {
			t.Fatalf("allowedUserIds 必须是空数组: %v", perm["allowedUserIds"])
		}
		denied, ok := perm["deniedUserIds"].([]any)
		if !ok || len(denied) != 0 {
			t.Fatalf("deniedUserIds 必须是空数组: %v", perm["deniedUserIds"])
		}
	})

	t.Run("成员不能修改权限", func(t *testing.T) {
		got := e.do(t, "PUT", "/api/rooms/MOVPERM1/movie-permission", memberToken, map[string]any{"allowMembers": true})
		if got.status != 403 {
			t.Fatalf("状态码 = %d, want 403（%s）", got.status, got.raw)
		}
	})

	t.Run("userId 与 allowed 必须成对", func(t *testing.T) {
		got := e.do(t, "PUT", "/api/rooms/MOVPERM1/movie-permission", ownerToken, map[string]any{"userId": member})
		if got.status != 400 || got.message() != "参数无效" {
			t.Fatalf("状态码 = %d, message = %q（%s）", got.status, got.message(), got.raw)
		}
	})

	t.Run("什么都不给视为参数无效", func(t *testing.T) {
		got := e.do(t, "PUT", "/api/rooms/MOVPERM1/movie-permission", ownerToken, map[string]any{})
		if got.status != 400 || got.message() != "参数无效" {
			t.Fatalf("状态码 = %d, message = %q", got.status, got.message())
		}
	})

	t.Run("房主开启后落库并可回读", func(t *testing.T) {
		perm := permissionOf(t, e.do(t, "PUT", "/api/rooms/MOVPERM1/movie-permission", ownerToken, map[string]any{"allowMembers": true}))
		if perm["allowMembers"] != true {
			t.Fatalf("allowMembers 应为 true: %v", perm)
		}
		perm = permissionOf(t, e.do(t, "GET", "/api/rooms/MOVPERM1/movie-permission", memberToken, nil))
		if perm["allowMembers"] != true {
			t.Fatalf("回读 allowMembers 应为 true: %v", perm)
		}
	})

	t.Run("白名单与黑名单互斥且黑名单优先", func(t *testing.T) {
		perm := permissionOf(t, e.do(t, "PUT", "/api/rooms/MOVPERM1/movie-permission", ownerToken,
			map[string]any{"userId": member, "allowed": true}))
		allowed := perm["allowedUserIds"].([]any)
		if len(allowed) != 1 || allowed[0] != float64(member) {
			t.Fatalf("白名单 = %v, want [%d]", allowed, member)
		}

		perm = permissionOf(t, e.do(t, "PUT", "/api/rooms/MOVPERM1/movie-permission", ownerToken,
			map[string]any{"userId": member, "allowed": false}))
		if allowed := perm["allowedUserIds"].([]any); len(allowed) != 0 {
			t.Fatalf("改黑后白名单应清空: %v", allowed)
		}
		denied := perm["deniedUserIds"].([]any)
		if len(denied) != 1 || denied[0] != float64(member) {
			t.Fatalf("黑名单 = %v, want [%d]", denied, member)
		}
	})

	t.Run("未知房间返回 404", func(t *testing.T) {
		got := e.do(t, "GET", "/api/rooms/NOSUCHROOM/movie-permission", ownerToken, nil)
		if got.status != 404 {
			t.Fatalf("状态码 = %d, want 404（%s）", got.status, got.raw)
		}
	})
}
