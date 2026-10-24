package room

import (
	"context"
	"encoding/json"
	"regexp"
	"strings"
	"testing"
	"time"

	"zviewer/backend/internal/store"
)

// ==================== 阶段 12：评论 / 弹幕 / 批注 ====================

// 评论独立窗口进来的连接没有 session，只有 panelRoomIds 标记。
// IsInRoom 必须先看这个标记并回落 canReadRoom，否则独立窗口一个字都发不出去。
func TestIsInRoomPanelBranchRequiresReadAccess(t *testing.T) {
	env := newTestEnv(t)
	ctx := context.Background()
	owner := int64(1)
	env.insertRoom(t, "ROOMP", &owner, 10, false)

	// 面板标记在、但没有在场会话 → canReadRoom 判 false
	env.hub.socketData["sock-p"] = map[string]any{
		"userId":       float64(5),
		"role":         RoleUser,
		"panelRoomIds": []any{"ROOMP"},
	}
	if ok, err := env.svc.IsInRoom(ctx, "sock-p", "ROOMP"); err != nil || ok {
		t.Fatalf("无在场会话时应判不在房: ok=%v err=%v", ok, err)
	}

	// 补上在场会话 → 同一个 socket 立刻可读
	uid := int64(5)
	if err := env.svc.Sessions.Create(ctx, &store.Session{
		RoomID: "ROOMP", SocketID: "sock-p", Role: store.SessionRoleViewer, UserID: &uid,
	}); err != nil {
		t.Fatalf("创建会话失败: %v", err)
	}
	// 上一轮已经缓存了 false，必须失效才会重算（handler 里 markPanel 后就是这么做的）
	env.svc.perm.invalidate("sock-p", "ROOMP")
	if ok, err := env.svc.IsInRoom(ctx, "sock-p", "ROOMP"); err != nil || !ok {
		t.Fatalf("有在场会话 + 面板标记应判在房: ok=%v err=%v", ok, err)
	}
}

// 面板分支不看缓存：去掉面板标记后即使会话还在，也要走正常路径（否则是反例）。
func TestIsInRoomPanelBranchTakesPrecedence(t *testing.T) {
	env := newTestEnv(t)
	ctx := context.Background()
	owner := int64(1)
	env.insertRoom(t, "ROOMQ", &owner, 10, false)

	// 房间已关闭：owner 仍可读（root/owner 先放行），普通观众不行
	if _, err := env.db.Exec(`UPDATE "room" SET "status" = 'closed' WHERE "roomId" = 'ROOMQ'`); err != nil {
		t.Fatalf("关房失败: %v", err)
	}
	env.hub.socketData["sock-g"] = map[string]any{
		"userId":       float64(9),
		"role":         RoleUser,
		"panelRoomIds": []string{"ROOMQ"},
	}
	uid := int64(9)
	if err := env.svc.Sessions.Create(ctx, &store.Session{
		RoomID: "ROOMQ", SocketID: "sock-g", Role: store.SessionRoleViewer, UserID: &uid,
	}); err != nil {
		t.Fatalf("创建会话失败: %v", err)
	}
	if ok, err := env.svc.IsInRoom(ctx, "sock-g", "ROOMQ"); err != nil || ok {
		t.Fatalf("房间已关闭时面板分支应判不可读: ok=%v err=%v", ok, err)
	}

	// 房主即便没有会话也能读
	env.hub.socketData["sock-o"] = map[string]any{
		"userId":       float64(1),
		"role":         RoleUser,
		"panelRoomIds": []string{"ROOMQ"},
	}
	if ok, err := env.svc.IsInRoom(ctx, "sock-o", "ROOMQ"); err != nil || !ok {
		t.Fatalf("房主应可读已关闭房间: ok=%v err=%v", ok, err)
	}
}

func TestCanReadRoomRules(t *testing.T) {
	env := newTestEnv(t)
	ctx := context.Background()
	owner := int64(1)
	env.insertRoom(t, "ROOMR", &owner, 10, false)

	cases := []struct {
		name string
		data map[string]any
		want bool
	}{
		{"root 无会话", map[string]any{"role": RoleRoot, "userId": float64(3)}, true},
		{"房主本人", map[string]any{"role": RoleUser, "userId": float64(1)}, true},
		{"游客无 guestId", map[string]any{"role": RoleGuest, "userId": float64(0)}, false},
		{"普通用户无会话", map[string]any{"role": RoleUser, "userId": float64(7)}, false},
		{"空 data", nil, false},
	}
	for _, c := range cases {
		got, err := env.svc.canReadRoom(ctx, "ROOMR", c.data)
		if err != nil {
			t.Fatalf("%s: 意外错误 %v", c.name, err)
		}
		if got != c.want {
			t.Errorf("%s: canReadRoom = %v, want %v", c.name, got, c.want)
		}
	}

	// 有在场会话的普通用户放行
	uid := int64(7)
	if err := env.svc.Sessions.Create(ctx, &store.Session{
		RoomID: "ROOMR", SocketID: "sock-7", Role: store.SessionRoleViewer, UserID: &uid,
	}); err != nil {
		t.Fatalf("创建会话失败: %v", err)
	}
	if ok, err := env.svc.canReadRoom(ctx, "ROOMR", map[string]any{"role": RoleUser, "userId": float64(7)}); err != nil || !ok {
		t.Fatalf("有在场会话应放行: ok=%v err=%v", ok, err)
	}

	// 房间不存在 → false（不是错误）
	if ok, err := env.svc.canReadRoom(ctx, "NOPE", map[string]any{"role": RoleRoot}); err != nil || ok {
		t.Fatalf("房间不存在应判 false 且无错误: ok=%v err=%v", ok, err)
	}
}

func TestAppendPanelRoom(t *testing.T) {
	cases := []struct {
		name     string
		existing any
		roomID   string
		want     []string
	}{
		{"空值", nil, "A", []string{"A"}},
		{"去重", []string{"A"}, "A", []string{"A"}},
		{"保持顺序", []string{"B", "A"}, "C", []string{"B", "A", "C"}},
		{"兼容 []any", []any{"A", 42, "B"}, "C", []string{"A", "B", "C"}},
		{"跳过空串", []string{"", "A"}, "", []string{"A"}},
	}
	for _, c := range cases {
		got := appendPanelRoom(c.existing, c.roomID)
		if len(got) != len(c.want) {
			t.Fatalf("%s: got %v, want %v", c.name, got, c.want)
		}
		for i := range got {
			if got[i] != c.want[i] {
				t.Fatalf("%s: got %v, want %v", c.name, got, c.want)
			}
		}
	}
}

func TestCommentDTOCreatedAtIsISOZulu(t *testing.T) {
	// 本地时区的时间也要输出成 UTC 的 Z 形态（Node 用 Date#toISOString）
	local := time.Date(2026, 10, 25, 9, 2, 3, 456_000_000, time.FixedZone("CST", 8*3600))
	dto := toCommentDTO(&store.Comment{
		ID: 7, RoomID: "R", Username: "u", Content: "c", IsDanmaku: true, CreatedAt: local,
	})
	if dto.CreatedAt != "2026-10-25T01:02:03.456Z" {
		t.Fatalf("createdAt = %q", dto.CreatedAt)
	}
	if !dto.IsDanmaku {
		t.Error("isDanmaku 应透传")
	}
}

func TestDanmakuEntryTimeOmittedWhenNil(t *testing.T) {
	raw, err := json.Marshal(danmakuEntry{ID: "d", Content: "c", Sender: "s"})
	if err != nil {
		t.Fatalf("序列化失败: %v", err)
	}
	if strings.Contains(string(raw), "time") {
		t.Fatalf("未提供 videoTime 时不应出现 time 键: %s", raw)
	}

	zero := 0.0
	raw, err = json.Marshal(danmakuEntry{ID: "d", Content: "c", Sender: "s", Time: &zero})
	if err != nil {
		t.Fatalf("序列化失败: %v", err)
	}
	if !strings.Contains(string(raw), `"time":0`) {
		t.Fatalf("videoTime=0 是有限数，必须保留: %s", raw)
	}
}

func TestDanmakuDTOAlwaysArrays(t *testing.T) {
	dto := toDanmakuDTO(&store.DanmakuMeta{})
	for name, raw := range map[string]json.RawMessage{
		"blockKeywords": dto.BlockKeywords,
		"deletedLog":    dto.DeletedLog,
		"realtimeLog":   dto.RealtimeLog,
	} {
		if string(raw) != "[]" {
			t.Errorf("%s 应回落成 []，实际 %s", name, raw)
		}
	}

	dto = toDanmakuDTO(&store.DanmakuMeta{RealtimeLog: `[{"id":"a"}]`})
	if string(dto.RealtimeLog) != `[{"id":"a"}]` {
		t.Errorf("合法数组应原样透传，实际 %s", dto.RealtimeLog)
	}
	// 坏数据不能让整个广播变成非法 JSON
	dto = toDanmakuDTO(&store.DanmakuMeta{BlockKeywords: "not-json"})
	if string(dto.BlockKeywords) != "[]" {
		t.Errorf("坏数据应回落成 []，实际 %s", dto.BlockKeywords)
	}
}

var danmakuIDPattern = regexp.MustCompile(`^\d{13}-[0-9a-z]{6}$`)

func TestNewDanmakuIDShape(t *testing.T) {
	id := newDanmakuID()
	if !danmakuIDPattern.MatchString(id) {
		t.Fatalf("弹幕 id 形状不符：%q", id)
	}
	// 前缀必须是当前毫秒时间戳（前端按它做本地回放的时间基准）
	prefix := strings.SplitN(id, "-", 2)[0]
	if len(prefix) != 13 {
		t.Fatalf("前缀应为 13 位毫秒时间戳：%q", prefix)
	}
}
