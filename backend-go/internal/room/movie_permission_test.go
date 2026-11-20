package room

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"
)

// ===========================================================================
// 解析 / 归一化 / JSON 形状
// ===========================================================================

func TestParseMoviePermission(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want MoviePermission
	}{
		{
			name: "空串默认关闭",
			raw:  "",
			want: MoviePermission{AllowMembers: false, AllowedUserIDs: []int64{}, DeniedUserIDs: []int64{}},
		},
		{
			name: "空对象默认关闭",
			raw:  "{}",
			want: MoviePermission{AllowMembers: false, AllowedUserIDs: []int64{}, DeniedUserIDs: []int64{}},
		},
		{
			name: "null 默认关闭",
			raw:  "null",
			want: MoviePermission{AllowMembers: false, AllowedUserIDs: []int64{}, DeniedUserIDs: []int64{}},
		},
		{
			name: "非法 JSON 默认关闭",
			raw:  "{not-json",
			want: MoviePermission{AllowMembers: false, AllowedUserIDs: []int64{}, DeniedUserIDs: []int64{}},
		},
		{
			name: "字段类型非法默认关闭",
			raw:  `{"allowMembers":"yes","allowedUserIds":[1]}`,
			want: MoviePermission{AllowMembers: false, AllowedUserIDs: []int64{}, DeniedUserIDs: []int64{}},
		},
		{
			name: "显式开启",
			raw:  `{"allowMembers":true}`,
			want: MoviePermission{AllowMembers: true, AllowedUserIDs: []int64{}, DeniedUserIDs: []int64{}},
		},
		{
			name: "只配白名单时开关仍关闭",
			raw:  `{"allowedUserIds":[7]}`,
			want: MoviePermission{AllowMembers: false, AllowedUserIDs: []int64{7}, DeniedUserIDs: []int64{}},
		},
		{
			name: "完整配置且黑名单优先",
			raw:  `{"allowMembers":true,"allowedUserIds":[5,5,-1],"deniedUserIds":[6,5]}`,
			want: MoviePermission{AllowMembers: true, AllowedUserIDs: []int64{}, DeniedUserIDs: []int64{6, 5}},
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := ParseMoviePermission(c.raw)
			if !reflect.DeepEqual(got, c.want) {
				t.Fatalf("ParseMoviePermission(%q) = %+v, want %+v", c.raw, got, c.want)
			}
		})
	}
}

func TestMoviePermissionNormalized(t *testing.T) {
	got := MoviePermission{
		AllowMembers:   true,
		AllowedUserIDs: []int64{3, 0, -2, 1, 3, 2},
		DeniedUserIDs:  []int64{2, 2, 0, 4},
	}.Normalized()
	want := MoviePermission{
		AllowMembers:   true,
		AllowedUserIDs: []int64{3, 1},
		DeniedUserIDs:  []int64{2, 4},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Normalized = %+v, want %+v", got, want)
	}

	empty := MoviePermission{}.Normalized()
	if empty.AllowedUserIDs == nil || empty.DeniedUserIDs == nil {
		t.Fatalf("空名单必须归一化成空数组而非 nil: %+v", empty)
	}
}

func TestMoviePermissionJSONShape(t *testing.T) {
	encoded, err := json.Marshal(ParseMoviePermission(""))
	if err != nil {
		t.Fatalf("编码失败: %v", err)
	}
	want := `{"allowMembers":false,"allowedUserIds":[],"deniedUserIds":[]}`
	if string(encoded) != want {
		t.Fatalf("默认权限 JSON = %s, want %s", encoded, want)
	}
}

// ===========================================================================
// 判定：黑名单优先于白名单，白名单优先于 allowMembers；游客只看 allowMembers
// ===========================================================================

func TestMoviePermissionAllowsUser(t *testing.T) {
	defaultClosed := ParseMoviePermission("")
	openToMembers := ParseMoviePermission(`{"allowMembers":true}`)
	whiteOnly := ParseMoviePermission(`{"allowMembers":false,"allowedUserIds":[5]}`)
	blackListed := ParseMoviePermission(`{"allowMembers":true,"deniedUserIds":[5]}`)
	conflict := ParseMoviePermission(`{"allowMembers":false,"allowedUserIds":[5],"deniedUserIds":[5]}`)

	five := int64(5)
	six := int64(6)
	zero := int64(0)

	cases := []struct {
		name string
		perm MoviePermission
		uid  *int64
		want bool
	}{
		{"默认关闭拒普通成员", defaultClosed, &five, false},
		{"默认关闭拒游客", defaultClosed, nil, false},
		{"开启后成员可点", openToMembers, &five, true},
		{"开启后游客可点", openToMembers, nil, true},
		{"白名单内放行", whiteOnly, &five, true},
		{"白名单外拒绝", whiteOnly, &six, false},
		{"黑名单优先于开关", blackListed, &five, false},
		{"黑名单外仍按开关", blackListed, &six, true},
		{"白黑冲突时黑名单优先", conflict, &five, false},
		{"uid<=0 视同游客", openToMembers, &zero, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := c.perm.AllowsUser(c.uid); got != c.want {
				t.Fatalf("AllowsUser(%v) = %v, want %v（配置 %+v）", c.uid, got, c.want, c.perm)
			}
		})
	}
}

func TestApplyMoviePermissionUpdate(t *testing.T) {
	trueVal := true
	falseVal := false
	user5 := int64(5)
	user0 := int64(0)

	base := ParseMoviePermission(`{"allowMembers":true,"allowedUserIds":[7]}`)
	white5 := ParseMoviePermission(`{"allowMembers":false,"allowedUserIds":[5]}`)
	black5 := ParseMoviePermission(`{"allowMembers":false,"deniedUserIds":[5]}`)

	cases := []struct {
		name string
		perm MoviePermission
		upd  MoviePermissionUpdate
		want MoviePermission
		ok   bool
	}{
		{
			name: "只改开关",
			perm: base,
			upd:  MoviePermissionUpdate{AllowMembers: &falseVal},
			want: MoviePermission{AllowMembers: false, AllowedUserIDs: []int64{7}, DeniedUserIDs: []int64{}},
			ok:   true,
		},
		{
			name: "加白名单",
			perm: base,
			upd:  MoviePermissionUpdate{UserID: &user5, Allowed: &trueVal},
			want: MoviePermission{AllowMembers: true, AllowedUserIDs: []int64{7, 5}, DeniedUserIDs: []int64{}},
			ok:   true,
		},
		{
			name: "加黑名单",
			perm: base,
			upd:  MoviePermissionUpdate{UserID: &user5, Allowed: &falseVal},
			want: MoviePermission{AllowMembers: true, AllowedUserIDs: []int64{7}, DeniedUserIDs: []int64{5}},
			ok:   true,
		},
		{
			name: "把白名单用户改黑",
			perm: white5,
			upd:  MoviePermissionUpdate{UserID: &user5, Allowed: &falseVal},
			want: MoviePermission{AllowMembers: false, AllowedUserIDs: []int64{}, DeniedUserIDs: []int64{5}},
			ok:   true,
		},
		{
			name: "把黑名单用户洗白",
			perm: black5,
			upd:  MoviePermissionUpdate{UserID: &user5, Allowed: &trueVal},
			want: MoviePermission{AllowMembers: false, AllowedUserIDs: []int64{5}, DeniedUserIDs: []int64{}},
			ok:   true,
		},
		{
			name: "只有 userId 缺少 allowed",
			perm: base,
			upd:  MoviePermissionUpdate{UserID: &user5},
			want: base,
			ok:   false,
		},
		{
			name: "只有 allowed 缺少 userId",
			perm: base,
			upd:  MoviePermissionUpdate{Allowed: &trueVal},
			want: base,
			ok:   false,
		},
		{
			name: "什么都没给",
			perm: base,
			upd:  MoviePermissionUpdate{},
			want: base,
			ok:   false,
		},
		{
			name: "userId 非法",
			perm: base,
			upd:  MoviePermissionUpdate{UserID: &user0, Allowed: &trueVal},
			want: base,
			ok:   false,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, ok := ApplyMoviePermissionUpdate(c.perm, c.upd)
			if ok != c.ok {
				t.Fatalf("ok = %v, want %v", ok, c.ok)
			}
			if !reflect.DeepEqual(got, c.want) {
				t.Fatalf("结果 = %+v, want %+v", got, c.want)
			}
		})
	}
}

// ===========================================================================
// CanRequestMovie：房主/root/房管恒允许，其余房间级配置决定
// ===========================================================================

func TestCanRequestMovie(t *testing.T) {
	env := newTestEnv(t)
	ctx := context.Background()

	setPermission := func(t *testing.T, roomID, raw string) {
		t.Helper()
		if _, err := env.db.Exec(`UPDATE "room" SET "moviePermission" = ? WHERE "roomId" = ?`, raw, roomID); err != nil {
			t.Fatalf("写入点片权限失败: %v", err)
		}
	}
	five := int64(5)
	six := int64(6)
	seven := int64(7)
	nine := int64(9)

	env.insertRoom(t, "ROOM0001", nil, 10, false)

	t.Run("房间不存在一律拒绝", func(t *testing.T) {
		if env.svc.CanRequestMovie(ctx, &five, RoleUser, "NOROOM") {
			t.Fatal("房间不存在必须拒绝")
		}
	})

	t.Run("默认关闭拒普通成员", func(t *testing.T) {
		setPermission(t, "ROOM0001", "{}")
		if env.svc.CanRequestMovie(ctx, &five, RoleUser, "ROOM0001") {
			t.Fatal("点片默认关闭，普通成员应被拒绝")
		}
	})

	t.Run("默认关闭拒游客", func(t *testing.T) {
		setPermission(t, "ROOM0001", "{}")
		if env.svc.CanRequestMovie(ctx, nil, RoleGuest, "ROOM0001") {
			t.Fatal("点片默认关闭，游客应被拒绝")
		}
	})

	t.Run("allowMembers 开启后成员与游客均可点", func(t *testing.T) {
		setPermission(t, "ROOM0001", `{"allowMembers":true}`)
		if !env.svc.CanRequestMovie(ctx, &five, RoleUser, "ROOM0001") {
			t.Fatal("开启后普通成员应可点")
		}
		if !env.svc.CanRequestMovie(ctx, nil, RoleGuest, "ROOM0001") {
			t.Fatal("开启后游客应可点")
		}
	})

	t.Run("白名单放行名单内用户", func(t *testing.T) {
		setPermission(t, "ROOM0001", `{"allowMembers":false,"allowedUserIds":[5]}`)
		if !env.svc.CanRequestMovie(ctx, &five, RoleUser, "ROOM0001") {
			t.Fatal("白名单内用户应可点")
		}
		if env.svc.CanRequestMovie(ctx, &six, RoleUser, "ROOM0001") {
			t.Fatal("白名单外用户应被拒绝")
		}
	})

	t.Run("黑名单优先拒绝", func(t *testing.T) {
		setPermission(t, "ROOM0001", `{"allowMembers":true,"deniedUserIds":[5]}`)
		if env.svc.CanRequestMovie(ctx, &five, RoleUser, "ROOM0001") {
			t.Fatal("黑名单用户即使开关打开也应被拒绝")
		}
		if !env.svc.CanRequestMovie(ctx, &six, RoleUser, "ROOM0001") {
			t.Fatal("黑名单外用户应可点")
		}
	})

	t.Run("房管默认矩阵放行", func(t *testing.T) {
		if _, err := env.db.Exec(`UPDATE "room" SET "moviePermission" = ?, "moderators" = ? WHERE "roomId" = ?`,
			`{"allowMembers":false}`, `[7]`, "ROOM0001"); err != nil {
			t.Fatalf("写入房管失败: %v", err)
		}
		if !env.svc.CanRequestMovie(ctx, &seven, RoleUser, "ROOM0001") {
			t.Fatal("房管应可点片")
		}
	})

	t.Run("admin 默认矩阵放行", func(t *testing.T) {
		setPermission(t, "ROOM0001", `{"allowMembers":false}`)
		if !env.svc.CanRequestMovie(ctx, &six, RoleAdmin, "ROOM0001") {
			t.Fatal("admin 默认矩阵应放行 addMovie")
		}
	})

	t.Run("房主恒允许且黑名单无效", func(t *testing.T) {
		env.insertRoom(t, "ROOM0002", &nine, 10, false)
		setPermission(t, "ROOM0002", `{"allowMembers":false,"deniedUserIds":[9]}`)
		if !env.svc.CanRequestMovie(ctx, &nine, RoleUser, "ROOM0002") {
			t.Fatal("房主必须恒允许")
		}
	})

	t.Run("root 恒允许", func(t *testing.T) {
		setPermission(t, "ROOM0001", `{"allowMembers":false,"deniedUserIds":[5]}`)
		if !env.svc.CanRequestMovie(ctx, &five, RoleRoot, "ROOM0001") {
			t.Fatal("root 必须恒允许")
		}
	})
}

// ===========================================================================
// 批量点歌共用写入 helper：顺序、归属用户、条数
// ===========================================================================

func TestMusicInsertItems(t *testing.T) {
	env := newTestEnv(t)
	ctx := context.Background()
	env.insertRoom(t, "ROOM0100", nil, 10, false)

	name, artist, album := "歌名", "歌手", "专辑"
	dur := 180000.0
	vip := false
	newItem := func(songID int64) *musicUpsertItem {
		id := songID
		return &musicUpsertItem{Name: &name, Artist: &artist, Album: &album,
			DurationMs: &dur, VIP: &vip, SongID: &id}
	}

	added, err := env.svc.musicInsertItems(ctx, "ROOM0100",
		[]*musicUpsertItem{newItem(1001), newItem(1002), newItem(1003)}, false, 42)
	if err != nil {
		t.Fatalf("批量写入失败: %v", err)
	}
	if added != 3 {
		t.Fatalf("added = %d, want 3", added)
	}

	queue, err := env.svc.musicLoadQueue(ctx, "ROOM0100")
	if err != nil {
		t.Fatalf("读取队列失败: %v", err)
	}
	if len(queue) != 3 {
		t.Fatalf("队列长度 = %d, want 3", len(queue))
	}
	for i, item := range queue {
		wantOrder := int64(i + 1)
		if item.Order != wantOrder {
			t.Fatalf("第 %d 首 order = %d, want %d", i, item.Order, wantOrder)
		}
		if item.AddedBy != 42 {
			t.Fatalf("第 %d 首 addedBy = %d, want 42", i, item.AddedBy)
		}
	}
}
