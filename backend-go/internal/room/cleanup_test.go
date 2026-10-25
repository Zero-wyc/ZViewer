package room

import (
	"context"
	"fmt"
	"testing"
	"time"

	"zviewer/backend/internal/store"
)

// 房间清理定时任务的行为：开关门控 + 阈值判定 + 物理删除。

// cleanupSettingsDDL 只建清理用得到的列（其余走默认值）。
const cleanupSettingsDDL = `CREATE TABLE "system_settings" (
	"id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	"autoDeleteInactiveRooms" boolean NOT NULL DEFAULT (1),
	"autoDeleteAfterHours" INTEGER NOT NULL DEFAULT (24),
	"roomDefaultMusicVolume" INTEGER NOT NULL DEFAULT (50),
	"dataSourceConfig" json,
	"registrationMode" TEXT NOT NULL DEFAULT ('approval'),
	"roomCreationMode" TEXT NOT NULL DEFAULT ('admin-only'),
	"roomPermissionMatrix" json,
	"roomMultiInstanceLogin" boolean NOT NULL DEFAULT (0),
	"betaFeaturesEnabled" boolean NOT NULL DEFAULT (0),
	"dashDisabled" boolean NOT NULL DEFAULT (0),
	"bilibiliDefaultParseMode" TEXT NOT NULL DEFAULT ('mp4'),
	"bilibiliPgcDefaultMode" TEXT NOT NULL DEFAULT ('mp4'),
	"cdnAccelerate" boolean NOT NULL DEFAULT (0),
	"playsvideoEnabled" boolean NOT NULL DEFAULT (1),
	"cdnProxyUrl" TEXT NOT NULL DEFAULT ('https://gh-proxy.com'),
	"livekitExternalUrl" TEXT NOT NULL DEFAULT (''),
	"announceAutoPopupOnUpdate" boolean NOT NULL DEFAULT (1),
	"createdAt" datetime NOT NULL DEFAULT (datetime('now')),
	"updatedAt" datetime NOT NULL DEFAULT (datetime('now'))
)`

// withCleanupSettings 给测试环境挂上可改的设置表。
func withCleanupSettings(t *testing.T, env *testEnv, autoDelete bool, hours int) {
	t.Helper()
	if _, err := env.db.Exec(cleanupSettingsDDL); err != nil {
		t.Fatalf("建设置表失败: %v", err)
	}
	if _, err := env.db.Exec(
		`INSERT INTO "system_settings" ("autoDeleteInactiveRooms","autoDeleteAfterHours") VALUES (?,?)`,
		autoDelete, hours,
	); err != nil {
		t.Fatalf("写入设置失败: %v", err)
	}
	env.svc.Settings = store.NewSettings(env.db)
}

// setLastAccessed 改房间的最后访问时间（负数的 hours 表示「多久以前」）。
func setLastAccessed(t *testing.T, env *testEnv, roomID string, offsetHours int) {
	t.Helper()
	if _, err := env.db.Exec(
		`UPDATE "room" SET "lastAccessedAt" = datetime('now', ?) WHERE "roomId" = ?`,
		fmt.Sprintf("%+d hours", offsetHours), roomID,
	); err != nil {
		t.Fatalf("更新 lastAccessedAt 失败: %v", err)
	}
}

func TestCleanupInactiveRooms(t *testing.T) {
	env := newTestEnv(t)
	ctx := context.Background()
	withCleanupSettings(t, env, true, 24)

	env.insertRoom(t, "ROOMSTALE", nil, 10, false)
	env.insertRoom(t, "ROOMFRESH", nil, 10, false)
	setLastAccessed(t, env, "ROOMSTALE", -48)
	setLastAccessed(t, env, "ROOMFRESH", -1)

	// 已关闭的房间不在清理范围（只删 active）。
	env.insertRoom(t, "ROOMCLOSED", nil, 10, false)
	setLastAccessed(t, env, "ROOMCLOSED", -48)
	if _, err := env.db.Exec(`UPDATE "room" SET "status" = 'closed' WHERE "roomId" = 'ROOMCLOSED'`); err != nil {
		t.Fatalf("改状态失败: %v", err)
	}

	if removed := env.svc.CleanupInactiveRooms(ctx); removed != 1 {
		t.Fatalf("清理数量 = %d，期望 1", removed)
	}

	if ok, _ := env.svc.Rooms.Exists(ctx, "ROOMSTALE"); ok {
		t.Error("超期房间应被删除")
	}
	if ok, _ := env.svc.Rooms.Exists(ctx, "ROOMFRESH"); !ok {
		t.Error("未超期房间不该被删")
	}
	if ok, _ := env.svc.Rooms.Exists(ctx, "ROOMCLOSED"); !ok {
		t.Error("已关闭房间不该被这轮清理动到")
	}
}

func TestCleanupRespectsToggle(t *testing.T) {
	env := newTestEnv(t)
	ctx := context.Background()
	withCleanupSettings(t, env, false, 24)

	env.insertRoom(t, "ROOMSTALE", nil, 10, false)
	setLastAccessed(t, env, "ROOMSTALE", -48)

	if removed := env.svc.CleanupInactiveRooms(ctx); removed != 0 {
		t.Fatalf("开关关闭时清理数量 = %d，期望 0", removed)
	}
	if ok, _ := env.svc.Rooms.Exists(ctx, "ROOMSTALE"); !ok {
		t.Error("开关关闭时不该删房间")
	}
}

func TestCleanupWithoutSettings(t *testing.T) {
	// 没注入 Settings（比如只跑房间单测）时不能崩，也不能删东西。
	env := newTestEnv(t)
	env.insertRoom(t, "ROOMSTALE", nil, 10, false)
	if removed := env.svc.CleanupInactiveRooms(context.Background()); removed != 0 {
		t.Fatalf("无设置时清理数量 = %d，期望 0", removed)
	}
}

func TestCleanupSchedulerStops(t *testing.T) {
	env := newTestEnv(t)
	withCleanupSettings(t, env, true, 24)

	ctx, cancel := context.WithCancel(context.Background())
	stop := env.svc.StartCleanupScheduler(ctx)
	cancel()
	// 停机不能卡住（重启流程里会串行调用）。
	done := make(chan struct{})
	go func() {
		stop()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("stop 未返回")
	}
}
