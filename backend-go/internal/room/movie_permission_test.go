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
			want: MoviePermission{AllowMembers: false, AllowedUserIDs: []int64{}, DeniedUserIDs: []int64{}, AllowedGuestIDs: []string{}, DeniedGuestIDs: []string{}},
		},
		{
			name: "空对象默认关闭",
			raw:  "{}",
			want: MoviePermission{AllowMembers: false, AllowedUserIDs: []int64{}, DeniedUserIDs: []int64{}, AllowedGuestIDs: []string{}, DeniedGuestIDs: []string{}},
		},
		{
			name: "null 默认关闭",
			raw:  "null",
			want: MoviePermission{AllowMembers: false, AllowedUserIDs: []int64{}, DeniedUserIDs: []int64{}, AllowedGuestIDs: []string{}, DeniedGuestIDs: []string{}},
		},
		{
			name: "非法 JSON 默认关闭",
			raw:  "{not-json",
			want: MoviePermission{AllowMembers: false, AllowedUserIDs: []int64{}, DeniedUserIDs: []int64{}, AllowedGuestIDs: []string{}, DeniedGuestIDs: []string{}},
		},
		{
			name: "字段类型非法默认关闭",
			raw:  `{"allowMembers":"yes","allowedUserIds":[1]}`,
			want: MoviePermission{AllowMembers: false, AllowedUserIDs: []int64{}, DeniedUserIDs: []int64{}, AllowedGuestIDs: []string{}, DeniedGuestIDs: []string{}},
		},
		{
			name: "显式开启",
			raw:  `{"allowMembers":true}`,
			want: MoviePermission{AllowMembers: true, AllowedUserIDs: []int64{}, DeniedUserIDs: []int64{}, AllowedGuestIDs: []string{}, DeniedGuestIDs: []string{}},
		},
		{
			name: "只配白名单时开关仍关闭",
			raw:  `{"allowedUserIds":[7]}`,
			want: MoviePermission{AllowMembers: false, AllowedUserIDs: []int64{7}, DeniedUserIDs: []int64{}, AllowedGuestIDs: []string{}, DeniedGuestIDs: []string{}},
		},
		{
			name: "完整配置且黑名单优先",
			raw:  `{"allowMembers":true,"allowedUserIds":[5,5,-1],"deniedUserIds":[6,5]}`,
			want: MoviePermission{AllowMembers: true, AllowedUserIDs: []int64{}, DeniedUserIDs: []int64{6, 5}, AllowedGuestIDs: []string{}, DeniedGuestIDs: []string{}},
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
		AllowMembers:    true,
		AllowedUserIDs:  []int64{3, 1},
		DeniedUserIDs:   []int64{2, 4},
		AllowedGuestIDs: []string{},
		DeniedGuestIDs:  []string{},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Normalized = %+v, want %+v", got, want)
	}

	empty := MoviePermission{}.Normalized()
	if empty.AllowedUserIDs == nil || empty.DeniedUserIDs == nil ||
		empty.AllowedGuestIDs == nil || empty.DeniedGuestIDs == nil {
		t.Fatalf("空名单必须归一化成空数组而非 nil: %+v", empty)
	}
}

func TestMoviePermissionJSONShape(t *testing.T) {
	encoded, err := json.Marshal(ParseMoviePermission(""))
	if err != nil {
		t.Fatalf("编码失败: %v", err)
	}
	want := `{"allowMembers":false,"allowedUserIds":[],"deniedUserIds":[],"allowedGuestIds":[],"deniedGuestIds":[]}`
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

// 游客没有 userId，逐人名单按 guestId 记账，与登录用户名单互不影响。
func TestMoviePermissionGuestLists(t *testing.T) {
	perm := ParseMoviePermission(`{"allowMembers":false,"allowedGuestIds":["g-allow"],"deniedGuestIds":["g-deny","g-deny"]}`)
	if !reflect.DeepEqual(perm.DeniedGuestIDs, []string{"g-deny"}) {
		t.Fatalf("游客黑名单未去重: %+v", perm.DeniedGuestIDs)
	}
	if got := perm.Allows(nil, "g-allow"); !got {
		t.Fatal("白名单里的游客应允许")
	}
	if got := perm.Allows(nil, "g-other"); got {
		t.Fatal("总开关关闭时名单外游客应拒绝")
	}

	open := ParseMoviePermission(`{"allowMembers":true,"deniedGuestIds":["g-bad"]}`)
	if got := open.Allows(nil, "g-bad"); got {
		t.Fatal("黑名单里的游客应拒绝")
	}
	if got := open.Allows(nil, "g-ok"); !got {
		t.Fatal("总开关开启时名单外游客应允许")
	}
	// 游客名单不影响登录用户
	five := int64(5)
	if got := open.Allows(&five, "g-bad"); !got {
		t.Fatal("游客黑名单不应影响到登录用户")
	}
	// userId<=0 视同游客
	zero := int64(0)
	if got := open.Allows(&zero, "g-bad"); got {
		t.Fatal("uid<=0 应按 guestId 判定")
	}
}

func TestApplyMoviePermissionGuestUpdate(t *testing.T) {
	base := ParseMoviePermission("")
	guest := "g-1"
	allow := true
	next, ok := ApplyMoviePermissionUpdate(base, MoviePermissionUpdate{
		GuestID: &guest,
		Allowed: &allow,
	})
	if !ok || !reflect.DeepEqual(next.AllowedGuestIDs, []string{"g-1"}) {
		t.Fatalf("游客白名单未写入: ok=%v perm=%+v", ok, next)
	}
	if got := next.Allows(nil, "g-1"); !got {
		t.Fatal("写入白名单后应允许")
	}

	deny := false
	next, ok = ApplyMoviePermissionUpdate(next, MoviePermissionUpdate{
		GuestID: &guest,
		Allowed: &deny,
	})
	if !ok || len(next.AllowedGuestIDs) != 0 || !reflect.DeepEqual(next.DeniedGuestIDs, []string{"g-1"}) {
		t.Fatalf("游客白转黑失败: ok=%v perm=%+v", ok, next)
	}

	empty := "  "
	if _, ok := ApplyMoviePermissionUpdate(base, MoviePermissionUpdate{GuestID: &empty, Allowed: &allow}); ok {
		t.Fatal("空 guestId 应判定为参数无效")
	}
	if _, ok := ApplyMoviePermissionUpdate(base, MoviePermissionUpdate{GuestID: &guest}); ok {
		t.Fatal("缺 allowed 应判定为参数无效")
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
			want: MoviePermission{AllowMembers: false, AllowedUserIDs: []int64{7}, DeniedUserIDs: []int64{}, AllowedGuestIDs: []string{}, DeniedGuestIDs: []string{}},
			ok:   true,
		},
		{
			name: "加白名单",
			perm: base,
			upd:  MoviePermissionUpdate{UserID: &user5, Allowed: &trueVal},
			want: MoviePermission{AllowMembers: true, AllowedUserIDs: []int64{7, 5}, DeniedUserIDs: []int64{}, AllowedGuestIDs: []string{}, DeniedGuestIDs: []string{}},
			ok:   true,
		},
		{
			name: "加黑名单",
			perm: base,
			upd:  MoviePermissionUpdate{UserID: &user5, Allowed: &falseVal},
			want: MoviePermission{AllowMembers: true, AllowedUserIDs: []int64{7}, DeniedUserIDs: []int64{5}, AllowedGuestIDs: []string{}, DeniedGuestIDs: []string{}},
			ok:   true,
		},
		{
			name: "把白名单用户改黑",
			perm: white5,
			upd:  MoviePermissionUpdate{UserID: &user5, Allowed: &falseVal},
			want: MoviePermission{AllowMembers: false, AllowedUserIDs: []int64{}, DeniedUserIDs: []int64{5}, AllowedGuestIDs: []string{}, DeniedGuestIDs: []string{}},
			ok:   true,
		},
		{
			name: "把黑名单用户洗白",
			perm: black5,
			upd:  MoviePermissionUpdate{UserID: &user5, Allowed: &trueVal},
			want: MoviePermission{AllowMembers: false, AllowedUserIDs: []int64{5}, DeniedUserIDs: []int64{}, AllowedGuestIDs: []string{}, DeniedGuestIDs: []string{}},
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
