package ncm

import (
	"context"
	"database/sql"
	"encoding/json"
	"testing"

	_ "modernc.org/sqlite"

	"zviewer/backend/internal/store"
)

func TestIsQRLoginPath(t *testing.T) {
	cases := []struct {
		rest string
		want bool
	}{
		{"/login/qr/key", true},
		{"/login/qr/create", true},
		{"/login/qr/check", true},
		{"/login/qr/check?key=abc&type=3", true},
		{"login/qr/check", true},
		{"/login/status", false},
		{"/user/account", false},
		{"", false},
	}
	for _, tc := range cases {
		if got := IsQRLoginPath(tc.rest); got != tc.want {
			t.Fatalf("IsQRLoginPath(%q) = %v, want %v", tc.rest, got, tc.want)
		}
	}
}

func TestQRCheckBodyCookies(t *testing.T) {
	body := map[string]any{"code": float64(803), "cookie": " MUSIC_U=abc; __csrf=xyz; "}
	got := qrCheckBodyCookies(body)
	if len(got) != 2 || got[0] != "MUSIC_U=abc" || got[1] != "__csrf=xyz" {
		t.Fatalf("解析 cookie 失败: %#v", got)
	}
	if got := qrCheckBodyCookies(map[string]any{"code": float64(803)}); got != nil {
		t.Fatalf("没有 cookie 字段时应返回 nil: %#v", got)
	}
	if got := qrCheckBodyCookies(map[string]any{"cookie": "  "}); got != nil {
		t.Fatalf("空白 cookie 应返回 nil: %#v", got)
	}
	if got := qrCheckBodyCookies("not-a-map"); got != nil {
		t.Fatalf("非对象响应应返回 nil: %#v", got)
	}
}

func TestQRLoginSucceeded(t *testing.T) {
	cases := []struct {
		body any
		want bool
	}{
		{map[string]any{"code": float64(803)}, true},
		{map[string]any{"code": json.Number("803")}, true},
		{map[string]any{"code": int64(803)}, true},
		{map[string]any{"code": 803}, true},
		{map[string]any{"code": "803"}, true},
		{map[string]any{"code": float64(801)}, false},
		{map[string]any{"code": "abc"}, false},
		{map[string]any{}, false},
		{nil, false},
	}
	for _, tc := range cases {
		if got := qrLoginSucceeded(tc.body); got != tc.want {
			t.Fatalf("qrLoginSucceeded(%#v) = %v, want %v", tc.body, got, tc.want)
		}
	}
}

// testRoomDDL 与 store 测试同构：roomColumns 扫到的列一个都不能少。
const testRoomDDL = `CREATE TABLE "room" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "roomId" varchar NOT NULL, "name" varchar, "password" varchar, "maxViewers" INTEGER NOT NULL DEFAULT (10), "status" varchar NOT NULL DEFAULT ('active'), "mode" varchar NOT NULL DEFAULT ('screen-share'), "shareMethod" varchar NOT NULL DEFAULT ('webrtc'), "streamKey" varchar, "requireApproval" boolean NOT NULL DEFAULT (0), "ownerUserId" INTEGER, "mutedViewers" TEXT NOT NULL DEFAULT ('[]'), "approvedViewers" TEXT NOT NULL DEFAULT ('[]'), "moderators" TEXT NOT NULL DEFAULT ('[]'), "voiceMuted" TEXT NOT NULL DEFAULT ('[]'), "voiceRelayEnabled" INTEGER NOT NULL DEFAULT (1), "voiceE2EEEnabled" INTEGER NOT NULL DEFAULT (1), "screenE2EEEnabled" INTEGER NOT NULL DEFAULT (1), "voiceEnabled" INTEGER NOT NULL DEFAULT (1), "voiceAutoJoin" INTEGER NOT NULL DEFAULT (0), "musicEnabled" INTEGER NOT NULL DEFAULT (1), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "lastAccessedAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "musicPermission" TEXT NOT NULL DEFAULT ('{}'), "moviePermission" TEXT NOT NULL DEFAULT ('{}'));`
const testCredentialDDL = `CREATE TABLE "ncm_credential" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "userId" integer NOT NULL, "cookies" text NOT NULL, "nickname" text, "avatarUrl" text, "vipType" integer, "vipStatus" integer, "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), CONSTRAINT "UQ_ncm_credential_userId" UNIQUE ("userId"));`
const testRoomAccountDDL = `CREATE TABLE "room_account" ("provider" TEXT NOT NULL, "roomId" TEXT NOT NULL, "userId" INTEGER NOT NULL, "updatedAt" TEXT NOT NULL, PRIMARY KEY ("provider", "roomId"));`

func TestCredentialForRequestRoomAccountPriority(t *testing.T) {
	conn, err := sql.Open("sqlite", "file::memory:?_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatalf("打开测试库失败: %v", err)
	}
	conn.SetMaxOpenConns(1)
	t.Cleanup(func() { conn.Close() })
	for _, ddl := range []string{testRoomDDL, testCredentialDDL, testRoomAccountDDL} {
		if _, err := conn.Exec(ddl); err != nil {
			t.Fatalf("建表失败: %v", err)
		}
	}
	service := NewService(conn)
	ctx := context.Background()
	if _, err := conn.Exec(
		"INSERT INTO " + "\"room\"" + " (\"roomId\", \"name\", \"status\", \"ownerUserId\") VALUES ('ROOM1', '房间', 'active', 9), ('ROOM2', '无绑定', 'active', 9)",
	); err != nil {
		t.Fatalf("插入房间失败: %v", err)
	}
	for _, userID := range []int64{7, 9, 42} {
		if err := service.Creds.Save(ctx, userID, "[\"MUSIC_U=user-"+"\"]", store.NcmProfilePatch{}); err != nil {
			t.Fatalf("保存凭证失败 user=%d: %v", userID, err)
		}
	}
	// 1) 房间绑定优先于房主与请求者自己。
	if err := service.RoomAccounts.SetRoomAccount(ctx, "ncm", "ROOM1", 42); err != nil {
		t.Fatalf("绑定房间共享账号失败: %v", err)
	}
	credential, err := service.CredentialForRequest(ctx, 7, "ROOM1")
	if err != nil || credential == nil || credential.UserID != 42 {
		t.Fatalf("房间绑定应优先, cred=%+v err=%v", credential, err)
	}
	// 2) 没有绑定时按「房主 → 请求者」：ROOM2 无绑定，取房主 9。
	credential, err = service.CredentialForRequest(ctx, 7, "ROOM2")
	if err != nil || credential == nil || credential.UserID != 9 {
		t.Fatalf("无绑定时应回退房主, cred=%+v err=%v", credential, err)
	}
	// 3) 绑定者凭证被清掉：继续回退房主，不让整个房间不可播。
	if err := service.RoomAccounts.SetRoomAccount(ctx, "ncm", "ROOM1", 33); err != nil {
		t.Fatalf("绑定失效账号失败: %v", err)
	}
	credential, err = service.CredentialForRequest(ctx, 7, "ROOM1")
	if err != nil || credential == nil || credential.UserID != 9 {
		t.Fatalf("绑定者无凭证时应回退房主, cred=%+v err=%v", credential, err)
	}
	// 4) 房间不存在：返回空，不报错。
	credential, err = service.CredentialForRequest(ctx, 7, "MISSING")
	if err != nil || credential != nil {
		t.Fatalf("房间不存在应返回空, cred=%+v err=%v", credential, err)
	}
}
