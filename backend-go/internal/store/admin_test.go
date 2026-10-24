package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	_ "modernc.org/sqlite"
)

// adminTestDDL 是管理端用到的四张表 + 房间级联删除涉及的关联表。
//
// 刻意照 TypeORM 生成的样子写（camelCase 列名、json/text 列、datetime 默认值），
// 否则测出来的行为跟真实库对不上——尤其 datetime 列的字符串格式。
const adminTestDDL = `
CREATE TABLE "system_settings" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "autoDeleteInactiveRooms" boolean NOT NULL DEFAULT (1), "autoDeleteAfterHours" INTEGER NOT NULL DEFAULT (24), "roomDefaultMusicVolume" INTEGER NOT NULL DEFAULT (50), "dataSourceConfig" json, "registrationMode" TEXT NOT NULL DEFAULT ('approval'), "roomCreationMode" TEXT NOT NULL DEFAULT ('admin-only'), "roomPermissionMatrix" json, "betaFeaturesEnabled" boolean NOT NULL DEFAULT (0), "dashDisabled" boolean NOT NULL DEFAULT (0), "bilibiliDefaultParseMode" TEXT NOT NULL DEFAULT ('mp4'), "bilibiliPgcDefaultMode" TEXT NOT NULL DEFAULT ('mp4'), "cdnAccelerate" boolean NOT NULL DEFAULT (0), "playsvideoEnabled" boolean NOT NULL DEFAULT (1), "cdnProxyUrl" TEXT NOT NULL DEFAULT ('https://gh-proxy.com'), "roomMultiInstanceLogin" boolean NOT NULL DEFAULT (0), "livekitExternalUrl" TEXT NOT NULL DEFAULT (''), "announceAutoPopupOnUpdate" boolean NOT NULL DEFAULT (1), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')));
CREATE TABLE "user" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "username" varchar NOT NULL UNIQUE, "passwordHash" varchar NOT NULL, "role" varchar NOT NULL DEFAULT ('guest'), "status" varchar NOT NULL DEFAULT ('pending'), "avatar" varchar, "tokenInvalidBefore" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')));
CREATE TABLE "room" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "roomId" varchar NOT NULL, "name" varchar, "password" varchar, "maxViewers" INTEGER NOT NULL DEFAULT (10), "status" varchar NOT NULL DEFAULT ('active'), "mode" varchar NOT NULL DEFAULT ('screen-share'), "shareMethod" varchar NOT NULL DEFAULT ('webrtc'), "streamKey" varchar, "requireApproval" boolean NOT NULL DEFAULT (0), "ownerUserId" INTEGER, "mutedViewers" TEXT NOT NULL DEFAULT ('[]'), "approvedViewers" TEXT NOT NULL DEFAULT ('[]'), "moderators" TEXT NOT NULL DEFAULT ('[]'), "voiceMuted" TEXT NOT NULL DEFAULT ('[]'), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "lastAccessedAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP));
CREATE TABLE "session" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "roomId" varchar NOT NULL, "socketId" varchar NOT NULL, "role" varchar NOT NULL, "userId" INTEGER, "startedAt" datetime NOT NULL DEFAULT (datetime('now')), "endedAt" datetime, "guestId" varchar);
CREATE TABLE "movie" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "roomId" varchar NOT NULL);
CREATE TABLE "comment" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "roomId" varchar NOT NULL);
CREATE TABLE "playback_states" ("roomId" varchar PRIMARY KEY NOT NULL, "sourceUrl" TEXT);
CREATE TABLE "music_playback_states" ("roomId" varchar PRIMARY KEY NOT NULL, "trackKey" TEXT);
CREATE TABLE "music_queue_item" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "roomId" varchar NOT NULL);
CREATE TABLE "danmaku_track" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "roomId" varchar NOT NULL);
CREATE TABLE "room_danmaku_meta" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "roomId" varchar NOT NULL);
`

func newAdminTestDB(t *testing.T) *sql.DB {
	t.Helper()
	conn, err := sql.Open("sqlite", "file::memory:?_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatalf("打开内存库失败: %v", err)
	}
	t.Cleanup(func() { conn.Close() })
	conn.SetMaxOpenConns(1)
	for _, stmt := range strings.Split(adminTestDDL, ";") {
		stmt = strings.TrimSpace(stmt)
		if stmt == "" {
			continue
		}
		if _, err := conn.Exec(stmt); err != nil {
			t.Fatalf("建表失败: %v（语句: %s）", err, stmt)
		}
	}
	return conn
}

// ---------------------------------------------------------------------------
// 系统设置
// ---------------------------------------------------------------------------

func TestSettingsDefaultsAndRoundTrip(t *testing.T) {
	ctx := context.Background()
	repo := NewSettings(newAdminTestDB(t))

	// 表为空时 Get 返回内置默认值，且**不落库**（否则任意读接口都会写一行）。
	cfg, err := repo.Get(ctx)
	if err != nil {
		t.Fatalf("读取默认设置失败: %v", err)
	}
	if cfg.ID != 0 {
		t.Fatalf("空表时不应返回主键，得到 %d", cfg.ID)
	}
	if cfg.AutoDeleteAfterHours != 24 || cfg.RoomDefaultMusicVolume != 50 ||
		cfg.RegistrationMode != "approval" || cfg.RoomCreationMode != "admin-only" {
		t.Fatalf("默认值与 Node 不一致: %+v", cfg)
	}
	if cfg.CdnProxyURL != "https://gh-proxy.com" || !cfg.PlaysvideoEnabled || !cfg.AnnounceAutoPopupOnUpdate {
		t.Fatalf("新补的列默认值不对: %+v", cfg)
	}

	// GetOrCreate 才会真正写一行。
	created, err := repo.GetOrCreate(ctx)
	if err != nil {
		t.Fatalf("GetOrCreate 失败: %v", err)
	}
	if created.ID <= 0 {
		t.Fatalf("GetOrCreate 应回填主键，得到 %d", created.ID)
	}

	// 全字段改一遍再存，重点验证 json 列与布尔列能原样读回。
	created.RoomDefaultMusicVolume = 80
	created.CdnAccelerate = true
	created.CdnProxyURL = "https://gh-proxy.example.com"
	created.LivekitExternalURL = "wss://livekit.example.com"
	created.RoomMultiInstanceLogin = true
	created.DataSourceConfig = json.RawMessage(`{"anime":true}`)
	created.RoomPermissionMatrix = json.RawMessage(`{"kickViewer":{"user":false}}`)
	if err := repo.Save(ctx, created); err != nil {
		t.Fatalf("保存失败: %v", err)
	}

	got, err := repo.Get(ctx)
	if err != nil {
		t.Fatalf("重新读取失败: %v", err)
	}
	if got.ID != created.ID || got.RoomDefaultMusicVolume != 80 || !got.CdnAccelerate {
		t.Fatalf("保存后读回不一致: %+v", got)
	}
	if got.CdnProxyURL != "https://gh-proxy.example.com" || got.LivekitExternalURL != "wss://livekit.example.com" {
		t.Fatalf("字符串列读回不一致: %+v", got)
	}
	if string(got.DataSourceConfig) != `{"anime":true}` {
		t.Fatalf("dataSourceConfig 读回不一致: %s", got.DataSourceConfig)
	}
	if string(got.RoomPermissionMatrix) != `{"kickViewer":{"user":false}}` {
		t.Fatalf("roomPermissionMatrix 读回不一致: %s", got.RoomPermissionMatrix)
	}

	// 整行覆盖：把 json 列清成 nil 后必须写成 NULL，而不是空串。
	got.DataSourceConfig = nil
	got.RoomPermissionMatrix = nil
	if err := repo.Save(ctx, got); err != nil {
		t.Fatalf("保存失败: %v", err)
	}
	again, err := repo.Get(ctx)
	if err != nil {
		t.Fatalf("重新读取失败: %v", err)
	}
	if len(again.DataSourceConfig) != 0 || len(again.RoomPermissionMatrix) != 0 {
		t.Fatalf("清空 json 列后应为 nil，得到 %q / %q", again.DataSourceConfig, again.RoomPermissionMatrix)
	}

	// 只应存在一行：再 GetOrCreate 不该插第二条。
	if _, err := repo.GetOrCreate(ctx); err != nil {
		t.Fatalf("GetOrCreate 失败: %v", err)
	}
	var n int
	if err := repo.conn.QueryRow(`SELECT COUNT(*) FROM "system_settings"`).Scan(&n); err != nil {
		t.Fatalf("统计失败: %v", err)
	}
	if n != 1 {
		t.Fatalf("system_settings 应只有 1 行，得到 %d", n)
	}
}

// ---------------------------------------------------------------------------
// 用户管理
// ---------------------------------------------------------------------------

func TestUsersAdminOperations(t *testing.T) {
	ctx := context.Background()
	repo := NewUsers(newAdminTestDB(t))

	root, err := repo.Create(ctx, "root", "hash", "root", "active")
	if err != nil {
		t.Fatalf("创建 root 失败: %v", err)
	}
	guest, err := repo.Create(ctx, "visitor", "hash", "guest", "pending")
	if err != nil {
		t.Fatalf("创建 guest 失败: %v", err)
	}
	// 把 root 的创建时间提前：同一秒创建的两个用户 createdAt 相同，
	// 并列行的顺序由 SQLite 决定（Node 也是同一句 SQL、同一份数据，所以行为一致）。
	// 要断言顺序就必须让时间真正有先后。
	if _, err := repo.conn.Exec(
		`UPDATE "user" SET "createdAt" = '2020-01-01 00:00:00' WHERE "id" = ?`, root.ID); err != nil {
		t.Fatalf("调整创建时间失败: %v", err)
	}

	list, err := repo.ListAll(ctx)
	if err != nil {
		t.Fatalf("列表失败: %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("应有两个用户，得到 %d", len(list))
	}
	if list[0].ID != guest.ID {
		t.Fatalf("列表应按创建时间倒序，得到首位 id=%d（期望 %d）", list[0].ID, guest.ID)
	}

	// 审核通过：status→active，guest→user。
	if err := repo.Approve(ctx, guest.ID); err != nil {
		t.Fatalf("审核失败: %v", err)
	}
	approved, err := repo.FindByID(ctx, guest.ID)
	if err != nil {
		t.Fatalf("读取失败: %v", err)
	}
	if approved.Status != "active" || approved.Role != "user" {
		t.Fatalf("审核后应为 active/user，得到 %s/%s", approved.Status, approved.Role)
	}

	// 再审核一次不该把 user 改回别的角色（CASE 只对 guest 生效）。
	if err := repo.Approve(ctx, guest.ID); err != nil {
		t.Fatalf("重复审核失败: %v", err)
	}
	again, _ := repo.FindByID(ctx, guest.ID)
	if again.Role != "user" {
		t.Fatalf("重复审核不应改角色，得到 %s", again.Role)
	}

	// 改角色。
	if err := repo.UpdateRole(ctx, guest.ID, "admin"); err != nil {
		t.Fatalf("改角色失败: %v", err)
	}
	promoted, _ := repo.FindByID(ctx, guest.ID)
	if promoted.Role != "admin" {
		t.Fatalf("改角色未生效: %s", promoted.Role)
	}

	// 删除。
	if err := repo.Delete(ctx, guest.ID); err != nil {
		t.Fatalf("删除失败: %v", err)
	}
	if _, err := repo.FindByID(ctx, guest.ID); !errors.Is(err, ErrUserNotFound) {
		t.Fatalf("删除后仍能读到: %v", err)
	}
	if err := repo.Delete(ctx, guest.ID); !errors.Is(err, ErrUserNotFound) {
		t.Fatalf("重复删除应返回 ErrUserNotFound，得到 %v", err)
	}

	// 改不存在的用户 → ErrUserNotFound（API 层据此翻 404）。
	if err := repo.UpdateRole(ctx, 9999, "user"); !errors.Is(err, ErrUserNotFound) {
		t.Fatalf("改不存在用户应返回 ErrUserNotFound，得到 %v", err)
	}
	if root.Role != "root" {
		t.Fatal("root 不应被影响")
	}
}

// ---------------------------------------------------------------------------
// 房间级联删除
// ---------------------------------------------------------------------------

func TestRoomsDeleteCascade(t *testing.T) {
	ctx := context.Background()
	conn := newAdminTestDB(t)
	repo := NewRooms(conn)

	room := &Room{RoomID: "12345678", Status: "active", Mode: "screen-share", MaxViewers: 10}
	if err := repo.Create(ctx, room); err != nil {
		t.Fatalf("创建房间失败: %v", err)
	}

	// 造齐所有关联数据，其中一个 session 已结束（不该再被改 endedAt）。
	mustExec := func(query string, args ...any) {
		t.Helper()
		if _, err := conn.Exec(query, args...); err != nil {
			t.Fatalf("造数据失败: %v（%s）", err, query)
		}
	}
	mustExec(`INSERT INTO "session" ("roomId","socketId","role","userId") VALUES (?,?,?,?)`, room.RoomID, "s1", "viewer", 7)
	mustExec(`INSERT INTO "session" ("roomId","socketId","role","userId","endedAt") VALUES (?,?,?,?,?)`,
		room.RoomID, "s2", "sharer", 9, FormatSQLiteTime(time.Now()))
	for _, table := range []string{"movie", "comment", "music_queue_item", "danmaku_track", "room_danmaku_meta"} {
		mustExec(`INSERT INTO "`+table+`" ("roomId") VALUES (?)`, room.RoomID)
	}
	mustExec(`INSERT INTO "playback_states" ("roomId") VALUES (?)`, room.RoomID)
	mustExec(`INSERT INTO "music_playback_states" ("roomId") VALUES (?)`, room.RoomID)

	// 另一个房间的数据不能受牵连。
	other := &Room{RoomID: "87654321", Status: "active", Mode: "screen-share", MaxViewers: 10}
	if err := repo.Create(ctx, other); err != nil {
		t.Fatalf("创建对照房间失败: %v", err)
	}
	mustExec(`INSERT INTO "movie" ("roomId") VALUES (?)`, other.RoomID)

	if err := repo.DeleteCascade(ctx, room.RoomID); err != nil {
		t.Fatalf("级联删除失败: %v", err)
	}

	if _, err := repo.FindByRoomID(ctx, room.RoomID); !errors.Is(err, ErrRoomNotFound) {
		t.Fatalf("房间应已删除: %v", err)
	}
	for _, table := range []string{
		"movie", "comment", "playback_states", "music_playback_states",
		"music_queue_item", "danmaku_track", "room_danmaku_meta",
	} {
		var n int
		if err := conn.QueryRow(
			`SELECT COUNT(*) FROM "`+table+`" WHERE "roomId" = ?`, room.RoomID).Scan(&n); err != nil {
			t.Fatalf("统计 %s 失败: %v", table, err)
		}
		if n != 0 {
			t.Fatalf("%s 仍残留 %d 行", table, n)
		}
	}

	// 未结束的会话要被补上 endedAt；已结束的保持原值。
	var open int
	if err := conn.QueryRow(
		`SELECT COUNT(*) FROM "session" WHERE "roomId" = ? AND "endedAt" IS NULL`, room.RoomID).Scan(&open); err != nil {
		t.Fatalf("统计会话失败: %v", err)
	}
	if open != 0 {
		t.Fatalf("仍有 %d 条未结束会话", open)
	}

	// 对照房间的数据必须完好。
	if _, err := repo.FindByRoomID(ctx, other.RoomID); err != nil {
		t.Fatalf("对照房间被误删: %v", err)
	}
	var keep int
	if err := conn.QueryRow(`SELECT COUNT(*) FROM "movie" WHERE "roomId" = ?`, other.RoomID).Scan(&keep); err != nil {
		t.Fatalf("统计对照影片失败: %v", err)
	}
	if keep != 1 {
		t.Fatalf("对照房间影片被误删，剩 %d", keep)
	}
}

// TestRoomsListAllIncludesClosed 确认管理端能看到已关闭房间（否则无法重开）。
func TestRoomsListAllIncludesClosed(t *testing.T) {
	ctx := context.Background()
	repo := NewRooms(newAdminTestDB(t))

	active := &Room{RoomID: "11111111", Status: "active", Mode: "screen-share", MaxViewers: 10}
	closed := &Room{RoomID: "22222222", Status: "closed", Mode: "screen-share", MaxViewers: 10}
	if err := repo.Create(ctx, active); err != nil {
		t.Fatalf("创建失败: %v", err)
	}
	if err := repo.Create(ctx, closed); err != nil {
		t.Fatalf("创建失败: %v", err)
	}

	onlyActive, err := repo.ListActive(ctx)
	if err != nil {
		t.Fatalf("ListActive 失败: %v", err)
	}
	if len(onlyActive) != 1 {
		t.Fatalf("ListActive 应只含 active，得到 %d", len(onlyActive))
	}

	all, err := repo.ListAll(ctx)
	if err != nil {
		t.Fatalf("ListAll 失败: %v", err)
	}
	if len(all) != 2 {
		t.Fatalf("ListAll 应含 closed，得到 %d", len(all))
	}
}
