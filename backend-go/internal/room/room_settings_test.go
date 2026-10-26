package room

import (
	"context"
	"database/sql"
	"testing"

	"zviewer/backend/internal/store"
)

// 阶段 9：房间设置与成员管理的单元测试。
//
// 与 room_test.go 共用 testEnv / fakeHub / testRoomDDL（同包内可见）。

func TestMatrixAllow(t *testing.T) {
	settings := &store.SystemSettings{
		RoomPermissionMatrix: []byte(`{"kickViewer":{"moderator":false,"admin":true,"user":true}}`),
	}
	cases := []struct {
		name     string
		settings *store.SystemSettings
		action   string
		field    string
		want     bool
	}{
		// 矩阵整列为空：房管/admin 默认允许、user 默认拒绝
		{"空矩阵-房管", nil, "kickViewer", "moderator", true},
		{"空矩阵-admin", nil, "kickViewer", "admin", true},
		{"空矩阵-user", nil, "kickViewer", "user", false},
		// 动作未覆盖：同上默认
		{"未覆盖动作-房管", settings, "muteViewer", "moderator", true},
		{"未覆盖动作-user", settings, "muteViewer", "user", false},
		// 显式关闭房管：只有 false 才拒
		{"房管被关", settings, "kickViewer", "moderator", false},
		// user 必须显式为 true 才允许
		{"user 显式开启", settings, "kickViewer", "user", true},
		{"admin 显式开启", settings, "kickViewer", "admin", true},
	}
	for _, c := range cases {
		if got := matrixAllow(c.settings, c.action, c.field); got != c.want {
			t.Errorf("%s: matrixAllow = %v, want %v", c.name, got, c.want)
		}
	}
}

func TestCanViewerPerformByRole(t *testing.T) {
	env := newTestEnv(t)
	ctx := context.Background()
	owner := int64(1)
	env.insertRoom(t, "ROOMS001", &owner, 10, false)

	if _, err := env.svc.RegisterHost(ctx, "sock-host", "ROOMS001", owner); err != nil {
		t.Fatalf("注册房主失败: %v", err)
	}
	viewerUID := int64(9)
	env.hub.online["sock-viewer"] = true
	if _, err := env.svc.AdmitViewer(ctx, "sock-viewer", "ROOMS001", &viewerUID, nil); err != nil {
		t.Fatalf("准入观众失败: %v", err)
	}

	cases := []struct {
		name     string
		socketID string
		role     string
		want     bool
	}{
		// 房主不受矩阵约束
		{"房主", "sock-host", RoleUser, true},
		// root 一律允许
		{"root", "sock-viewer", RoleRoot, true},
		// admin 在矩阵未覆盖时默认允许
		{"admin", "sock-viewer", RoleAdmin, true},
		// user 默认拒绝
		{"user", "sock-viewer", RoleUser, false},
		// guest 一律拒绝
		{"guest", "sock-viewer", RoleGuest, false},
	}
	for _, c := range cases {
		got, err := env.svc.CanViewerPerform(ctx, c.socketID, c.role, "ROOMS001", "kickViewer")
		if err != nil {
			t.Fatalf("%s: 意外错误 %v", c.name, err)
		}
		if got != c.want {
			t.Errorf("%s: CanViewerPerform = %v, want %v", c.name, got, c.want)
		}
	}
}

func TestCanModeratorActOn(t *testing.T) {
	env := newTestEnv(t)
	ctx := context.Background()
	owner := int64(1)
	env.insertRoom(t, "ROOMS002", &owner, 10, false)
	if err := env.svc.SetModerators(ctx, "ROOMS002", []int64{5}); err != nil {
		t.Fatalf("写入房管失败: %v", err)
	}

	cases := []struct {
		name       string
		targetUID  *int64
		targetRole string
		want       string
	}{
		{"root 不可被操作", int64p(5), RoleRoot, "不能对管理员操作"},
		{"房主不可被操作", int64p(1), RoleUser, "不能对房主操作"},
		{"房管不可被操作", int64p(5), RoleUser, "不能对房管操作"},
		{"游客放行", nil, "", ""},
		{"普通观众放行", int64p(8), RoleUser, ""},
	}
	for _, c := range cases {
		got, err := env.svc.CanModeratorActOn(ctx, "ROOMS002", c.targetUID, c.targetRole)
		if err != nil {
			t.Fatalf("%s: 意外错误 %v", c.name, err)
		}
		if got != c.want {
			t.Errorf("%s: denial = %q, want %q", c.name, got, c.want)
		}
	}
}

func TestTransferHostSwapsRolesAndCleansModerators(t *testing.T) {
	env := newTestEnv(t)
	ctx := context.Background()
	owner := int64(1)
	env.insertRoom(t, "ROOMS003", &owner, 10, false)
	env.db.Exec(`UPDATE room SET streamKey='old-private-publish-key' WHERE roomId='ROOMS003'`)
	// 新房主原本是房管：转交后必须从名单里移除
	if err := env.svc.SetModerators(ctx, "ROOMS003", []int64{2, 3}); err != nil {
		t.Fatalf("写入房管失败: %v", err)
	}
	if _, err := env.svc.RegisterHost(ctx, "sock-old", "ROOMS003", owner); err != nil {
		t.Fatalf("注册房主失败: %v", err)
	}
	newUID := int64(2)
	env.hub.online["sock-new"] = true
	if _, err := env.svc.AdmitViewer(ctx, "sock-new", "ROOMS003", &newUID, nil); err != nil {
		t.Fatalf("准入观众失败: %v", err)
	}

	next, err := env.svc.transferHost(ctx, "ROOMS003", "sock-new", "sock-old", newUID)
	if err != nil {
		t.Fatalf("转交失败: %v", err)
	}
	if len(next) != 1 || next[0] != 3 {
		t.Fatalf("房管名单应清理为 [3]，实际 %v", next)
	}

	var oldRole, newRole string
	if err := env.db.QueryRow(`SELECT "role" FROM "session" WHERE "socketId" = 'sock-old'`).Scan(&oldRole); err != nil {
		t.Fatalf("查询原房主会话失败: %v", err)
	}
	if err := env.db.QueryRow(`SELECT "role" FROM "session" WHERE "socketId" = 'sock-new'`).Scan(&newRole); err != nil {
		t.Fatalf("查询新房主会话失败: %v", err)
	}
	if oldRole != store.SessionRoleViewer || newRole != store.SessionRoleSharer {
		t.Fatalf("角色互换失败: old=%s new=%s", oldRole, newRole)
	}

	var newOwner sql.NullInt64
	if err := env.db.QueryRow(`SELECT "ownerUserId" FROM "room" WHERE "roomId" = 'ROOMS003'`).Scan(&newOwner); err != nil {
		t.Fatalf("查询 owner 失败: %v", err)
	}
	if !newOwner.Valid || newOwner.Int64 != 2 {
		t.Fatalf("owner 应为 2，实际 %v", newOwner)
	}
	room, err := env.svc.Rooms.FindByRoomID(ctx, "ROOMS003")
	if err != nil || room.StreamKey == nil || *room.StreamKey == "old-private-publish-key" || len(*room.StreamKey) != 8 {
		t.Fatal("owner transfer did not revoke old publisher", room, err)
	}
	if err := env.svc.Rooms.SetStatus(ctx, "ROOMS003", "closed"); err != nil {
		t.Fatal(err)
	}
	room, err = env.svc.Rooms.FindByRoomID(ctx, "ROOMS003")
	if err != nil || room.StreamKey != nil {
		t.Fatal("closed room retained publisher key", room, err)
	}
}

func TestSetMutedRoundTrip(t *testing.T) {
	env := newTestEnv(t)
	ctx := context.Background()
	owner := int64(1)
	env.insertRoom(t, "ROOMS004", &owner, 10, false)

	if err := env.svc.setMuted(ctx, "ROOMS004", 7, true); err != nil {
		t.Fatalf("禁言失败: %v", err)
	}
	// 重复禁言不应产生重复项
	if err := env.svc.setMuted(ctx, "ROOMS004", 7, true); err != nil {
		t.Fatalf("重复禁言失败: %v", err)
	}
	muted, err := env.svc.IsMuted(ctx, "ROOMS004", 7)
	if err != nil || !muted {
		t.Fatalf("应处于禁言状态: muted=%v err=%v", muted, err)
	}

	var raw string
	if err := env.db.QueryRow(`SELECT "mutedViewers" FROM "room" WHERE "roomId" = 'ROOMS004'`).Scan(&raw); err != nil {
		t.Fatalf("读禁言列失败: %v", err)
	}
	if raw != "[7]" {
		t.Fatalf("禁言列应为 [7]，实际 %q", raw)
	}

	if err := env.svc.setMuted(ctx, "ROOMS004", 7, false); err != nil {
		t.Fatalf("解禁失败: %v", err)
	}
	muted, err = env.svc.IsMuted(ctx, "ROOMS004", 7)
	if err != nil || muted {
		t.Fatalf("应已解禁: muted=%v err=%v", muted, err)
	}
}

func TestModeratorLimitAndMembership(t *testing.T) {
	env := newTestEnv(t)
	ctx := context.Background()
	owner := int64(1)
	env.insertRoom(t, "ROOMS005", &owner, 10, false)
	if _, err := env.svc.RegisterHost(ctx, "sock-host", "ROOMS005", owner); err != nil {
		t.Fatalf("注册房主失败: %v", err)
	}

	// 不在房间的用户查不到活跃会话（appoint-moderator 用它挡「目标不在房间内」）
	missing := int64(42)
	sess, err := env.svc.Sessions.FindActiveByRoomUser(ctx, "ROOMS005", missing)
	if err != nil || sess != nil {
		t.Fatalf("不在房间的用户应查不到会话: sess=%+v err=%v", sess, err)
	}

	// 房管名单写满上限后仍是 10 个，不多不少
	full := make([]int64, 0, maxModerators)
	for i := int64(100); i < 100+maxModerators; i++ {
		full = append(full, i)
	}
	if err := env.svc.SetModerators(ctx, "ROOMS005", full); err != nil {
		t.Fatalf("写入房管失败: %v", err)
	}
	if got := len(env.svc.Moderators(ctx, "ROOMS005")); got != maxModerators {
		t.Fatalf("房管数应为 %d，实际 %d", maxModerators, got)
	}
}

func TestParseAndEncodeIDList(t *testing.T) {
	if got := parseIDList(""); len(got) != 0 {
		t.Fatalf("空串应解析为空列表，实际 %v", got)
	}
	if got := parseIDList("不是 JSON"); len(got) != 0 {
		t.Fatalf("非法 JSON 应解析为空列表，实际 %v", got)
	}
	if got := parseIDList("[1,2,3]"); len(got) != 3 || got[2] != 3 {
		t.Fatalf("正常解析失败: %v", got)
	}
	if got := encodeIDList(nil); got != "[]" {
		t.Fatalf("nil 应编码为 []，实际 %q", got)
	}
	// appendID：已存在返回 nil（调用方据此跳过写库）
	if got := appendID("[1]", 1); got != nil {
		t.Fatalf("已存在应返回 nil，实际 %v", got)
	}
	if got := appendID("[1]", 2); len(got) != 2 || got[1] != 2 {
		t.Fatalf("追加失败: %v", got)
	}
}
