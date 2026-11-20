package room

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"zviewer/backend/internal/sio"
)

// ===========================================================================
// 解析 / 归一化
// ===========================================================================

func TestParseMusicPermission(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want MusicPermission
	}{
		{
			name: "空串按默认放行",
			raw:  "",
			want: MusicPermission{AllowMembers: true, AllowedUserIDs: []int64{}, DeniedUserIDs: []int64{}},
		},
		{
			name: "空对象按默认放行",
			raw:  "{}",
			want: MusicPermission{AllowMembers: true, AllowedUserIDs: []int64{}, DeniedUserIDs: []int64{}},
		},
		{
			name: "null 按默认放行",
			raw:  "null",
			want: MusicPermission{AllowMembers: true, AllowedUserIDs: []int64{}, DeniedUserIDs: []int64{}},
		},
		{
			name: "非法 JSON 按默认放行",
			raw:  `{not-json`,
			want: MusicPermission{AllowMembers: true, AllowedUserIDs: []int64{}, DeniedUserIDs: []int64{}},
		},
		{
			name: "字段类型非法按默认放行",
			raw:  `{"allowMembers":"yes","allowedUserIds":[1]}`,
			want: MusicPermission{AllowMembers: true, AllowedUserIDs: []int64{}, DeniedUserIDs: []int64{}},
		},
		{
			name: "只关开关",
			raw:  `{"allowMembers":false}`,
			want: MusicPermission{AllowMembers: false, AllowedUserIDs: []int64{}, DeniedUserIDs: []int64{}},
		},
		{
			name: "只配白名单时开关默认放行",
			raw:  `{"allowedUserIds":[7]}`,
			want: MusicPermission{AllowMembers: true, AllowedUserIDs: []int64{7}, DeniedUserIDs: []int64{}},
		},
		{
			name: "完整配置",
			raw:  `{"allowMembers":false,"allowedUserIds":[2,3],"deniedUserIds":[4]}`,
			want: MusicPermission{AllowMembers: false, AllowedUserIDs: []int64{2, 3}, DeniedUserIDs: []int64{4}},
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := ParseMusicPermission(c.raw)
			if !reflect.DeepEqual(got, c.want) {
				t.Fatalf("ParseMusicPermission(%q) = %+v, want %+v", c.raw, got, c.want)
			}
		})
	}
}

func TestMusicPermissionNormalized(t *testing.T) {
	got := MusicPermission{
		AllowMembers:   false,
		AllowedUserIDs: []int64{3, 0, -2, 1, 3, 2},
		DeniedUserIDs:  []int64{2, 2, 0, 4},
	}.Normalized()
	want := MusicPermission{
		AllowMembers:   false,
		AllowedUserIDs: []int64{3, 1},
		DeniedUserIDs:  []int64{2, 4},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Normalized = %+v, want %+v", got, want)
	}

	empty := MusicPermission{AllowMembers: true}.Normalized()
	if empty.AllowedUserIDs == nil || empty.DeniedUserIDs == nil {
		t.Fatalf("空名单必须归一化成空数组而非 nil: %+v", empty)
	}
}

func TestMusicPermissionJSONShape(t *testing.T) {
	encoded, err := json.Marshal(ParseMusicPermission(""))
	if err != nil {
		t.Fatalf("编码失败: %v", err)
	}
	want := `{"allowMembers":true,"allowedUserIds":[],"deniedUserIds":[]}`
	if string(encoded) != want {
		t.Fatalf("默认权限 JSON = %s, want %s", encoded, want)
	}
}

// ===========================================================================
// 判定矩阵（纯函数）
// ===========================================================================

func TestMusicPermissionAllowsUser(t *testing.T) {
	defaultOpen := ParseMusicPermission("")
	defaultClosed := ParseMusicPermission(`{"allowMembers":false}`)
	whiteOnly := ParseMusicPermission(`{"allowMembers":false,"allowedUserIds":[5]}`)
	blackListed := ParseMusicPermission(`{"deniedUserIds":[5]}`)

	cases := []struct {
		name string
		perm MusicPermission
		uid  *int64
		want bool
	}{
		{"默认允许成员", defaultOpen, int64p(5), true},
		{"默认允许游客", defaultOpen, nil, true},
		{"关闭后拒绝成员", defaultClosed, int64p(5), false},
		{"关闭后拒绝游客", defaultClosed, nil, false},
		{"关闭后拒绝 0 号用户", defaultClosed, int64p(0), false},
		{"白名单覆盖关闭开关", whiteOnly, int64p(5), true},
		{"白名单外仍拒绝", whiteOnly, int64p(6), false},
		{"关闭后游客仍拒绝", whiteOnly, nil, false},
		{"黑名单覆盖默认放行", blackListed, int64p(5), false},
		{"黑名单外仍放行", blackListed, int64p(6), true},
		{"黑名单不影响游客", blackListed, nil, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := c.perm.AllowsUser(c.uid); got != c.want {
				t.Fatalf("AllowsUser(%v) = %v, want %v", c.uid, got, c.want)
			}
		})
	}
}

func TestApplyMusicPermissionUpdate(t *testing.T) {
	raw := func(s string) map[string]json.RawMessage {
		t.Helper()
		var out map[string]json.RawMessage
		if err := json.Unmarshal([]byte(s), &out); err != nil {
			t.Fatalf("测试夹具 JSON 非法: %v", err)
		}
		return out
	}

	base := ParseMusicPermission(`{"allowMembers":true,"allowedUserIds":[1],"deniedUserIds":[2]}`)

	t.Run("只改开关", func(t *testing.T) {
		got, ok := applyMusicPermissionUpdate(base, raw(`{"allowMembers":false}`))
		if !ok || got.AllowMembers || !reflect.DeepEqual(got.AllowedUserIDs, []int64{1}) {
			t.Fatalf("got=%+v ok=%v", got, ok)
		}
	})
	t.Run("加白并移出黑名单", func(t *testing.T) {
		got, ok := applyMusicPermissionUpdate(base, raw(`{"userId":2,"allowed":true}`))
		if !ok || !reflect.DeepEqual(got.AllowedUserIDs, []int64{1, 2}) || !reflect.DeepEqual(got.DeniedUserIDs, []int64{}) {
			t.Fatalf("got=%+v ok=%v", got, ok)
		}
	})
	t.Run("加黑并移出白名单", func(t *testing.T) {
		got, ok := applyMusicPermissionUpdate(base, raw(`{"userId":1,"allowed":false}`))
		if !ok || !reflect.DeepEqual(got.AllowedUserIDs, []int64{}) || !reflect.DeepEqual(got.DeniedUserIDs, []int64{2, 1}) {
			t.Fatalf("got=%+v ok=%v", got, ok)
		}
	})
	t.Run("开关与名单可同时更新", func(t *testing.T) {
		got, ok := applyMusicPermissionUpdate(base, raw(`{"allowMembers":false,"userId":5,"allowed":true}`))
		if !ok || got.AllowMembers || !reflect.DeepEqual(got.AllowedUserIDs, []int64{1, 5}) {
			t.Fatalf("got=%+v ok=%v", got, ok)
		}
	})

	invalid := []string{
		`{}`,
		`{"userId":5}`,
		`{"allowed":true}`,
		`{"userId":0,"allowed":true}`,
		`{"userId":-3,"allowed":false}`,
	}
	for _, s := range invalid {
		if _, ok := applyMusicPermissionUpdate(base, raw(s)); ok {
			t.Fatalf("无效 payload 不应通过: %s", s)
		}
	}
}

// ===========================================================================
// CanRequestMusic（内存 sqlite，无网络）
// ===========================================================================

func setRoomMusicPermission(t *testing.T, env *testEnv, roomID, raw string) {
	t.Helper()
	if _, err := env.db.Exec(`UPDATE "room" SET "musicPermission" = ? WHERE "roomId" = ?`, raw, roomID); err != nil {
		t.Fatalf("设置点歌权限失败: %v", err)
	}
}

func TestCanRequestMusicRoomConfig(t *testing.T) {
	cases := []struct {
		name       string
		permission string
		role       string
		uid        int64
		guest      bool
		want       bool
	}{
		{"默认配置允许成员", "", RoleUser, 5, false, true},
		{"allowMembers 关闭拒绝成员", `{"allowMembers":false}`, RoleUser, 5, false, false},
		{"allowMembers 关闭拒绝游客", `{"allowMembers":false}`, RoleGuest, 0, true, false},
		{"allowMembers 开启允许游客", "", RoleGuest, 0, true, true},
		{"白名单覆盖关闭开关", `{"allowMembers":false,"allowedUserIds":[5]}`, RoleUser, 5, false, true},
		{"白名单不含该用户则拒绝", `{"allowMembers":false,"allowedUserIds":[6]}`, RoleUser, 5, false, false},
		{"黑名单覆盖开启开关", `{"deniedUserIds":[5]}`, RoleUser, 5, false, false},
		{"未命中黑名单回落到开关", `{"deniedUserIds":[6]}`, RoleUser, 5, false, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			env := newTestEnv(t)
			const roomID = "ROOMMUSIC"
			env.insertRoom(t, roomID, int64p(1), 10, false)
			if c.permission != "" {
				setRoomMusicPermission(t, env, roomID, c.permission)
			}
			data := map[string]any{"role": c.role}
			if !c.guest && c.uid > 0 {
				data["userId"] = c.uid
			}
			sc := &sio.Socket{ID: "sock-" + c.name, Data: data}

			got, err := env.svc.CanRequestMusic(context.Background(), sc, roomID)
			if err != nil {
				t.Fatalf("意外错误: %v", err)
			}
			if got != c.want {
				t.Fatalf("CanRequestMusic = %v, want %v", got, c.want)
			}
		})
	}
}

func TestCanRequestMusicMatrixBypassesRoomConfig(t *testing.T) {
	env := newTestEnv(t)
	const roomID = "ROOMMATRIX"
	env.insertRoom(t, roomID, int64p(1), 10, false)
	setRoomMusicPermission(t, env, roomID, `{"allowMembers":false}`)
	ctx := context.Background()

	root := &sio.Socket{ID: "sock-root", Data: map[string]any{"role": RoleRoot, "userId": int64(9)}}
	if got, err := env.svc.CanRequestMusic(ctx, root, roomID); err != nil || !got {
		t.Fatalf("root 应绕过房间配置: got=%v err=%v", got, err)
	}

	// 房管由 room.moderators + hub 里的 userId 判定（CanViewerPerform 的矩阵分支）。
	if _, err := env.db.Exec(`UPDATE "room" SET "moderators" = '[7]' WHERE "roomId" = ?`, roomID); err != nil {
		t.Fatalf("设置房管失败: %v", err)
	}
	env.hub.socketData["sock-mod"] = map[string]any{"userId": int64(7)}
	mod := &sio.Socket{ID: "sock-mod", Data: map[string]any{"role": RoleUser, "userId": int64(7)}}
	if got, err := env.svc.CanRequestMusic(ctx, mod, roomID); err != nil || !got {
		t.Fatalf("房管应绕过房间配置: got=%v err=%v", got, err)
	}
}

func TestMusicGetStateOKIncludesPermission(t *testing.T) {
	encoded, err := json.Marshal(musicGetStateOK{
		Success:    true,
		Queue:      []musicQueueItemPayload{},
		Permission: ParseMusicPermission(`{"allowMembers":false}`),
	})
	if err != nil {
		t.Fatalf("编码失败: %v", err)
	}
	if !strings.Contains(string(encoded), `"permission":{"allowMembers":false,"allowedUserIds":[],"deniedUserIds":[]}`) {
		t.Fatalf("get-state ack 缺少 permission 契约: %s", encoded)
	}
}
