package db

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// legacyDatabase 造一个 4.7 时代的库：表齐、但有四张表缺列，
// 并且 music_playback_states 整张表不存在（对应 4.5.5 之前的形态）。
//
// 里面的数据是刻意留的：升级必须只加结构，不能动行。
func legacyDatabase(t *testing.T) (*sql.DB, string) {
	t.Helper()
	conn, path := openTemp(t)
	ctx := context.Background()
	if err := InitSchema(ctx, conn); err != nil {
		t.Fatalf("InitSchema: %v", err)
	}

	stmts := []string{
		`INSERT INTO "room" ("roomId", "name") VALUES ('r1', '老房间')`,
		`INSERT INTO "session" ("roomId", "socketId", "role", "guestId") VALUES ('r1', 's1', 'viewer', 'g1')`,
		`INSERT INTO "movie" ("roomId", "url", "title") VALUES ('r1', 'https://example.com/a.m3u8', '老影片')`,
		`INSERT INTO "system_settings" ("id") VALUES (1)`,
		`ALTER TABLE "session" DROP COLUMN "guestId"`,
		`ALTER TABLE "playback_states" DROP COLUMN "noProxyFallback"`,
		`ALTER TABLE "movie" DROP COLUMN "serverProxy"`,
		`ALTER TABLE "system_settings" DROP COLUMN "roomDefaultMusicVolume"`,
		`DROP TABLE "music_playback_states"`,
	}
	for _, stmt := range stmts {
		if _, err := conn.ExecContext(ctx, stmt); err != nil {
			t.Fatalf("%s: %v", stmt, err)
		}
	}
	return conn, path
}

func TestPlanUpgradeOnCurrentSchemaIsEmpty(t *testing.T) {
	conn, _ := openTemp(t)
	if err := InitSchema(context.Background(), conn); err != nil {
		t.Fatalf("InitSchema: %v", err)
	}
	plan, err := PlanUpgrade(conn)
	if err != nil {
		t.Fatalf("PlanUpgrade: %v", err)
	}
	if !plan.Empty() {
		t.Fatalf("刚建好的库不应有待升级项: %v / %v", plan.MissingTables, plan.MissingColumns)
	}
}

func TestPlanUpgradeDetectsLegacyGaps(t *testing.T) {
	conn, _ := legacyDatabase(t)
	plan, err := PlanUpgrade(conn)
	if err != nil {
		t.Fatalf("PlanUpgrade: %v", err)
	}
	if len(plan.MissingTables) != 1 || plan.MissingTables[0] != "music_playback_states" {
		t.Fatalf("缺表识别错误: %v", plan.MissingTables)
	}
	want := map[string]string{
		"session":         "guestId",
		"playback_states": "noProxyFallback",
		"movie":           "serverProxy",
		"system_settings": "roomDefaultMusicVolume",
	}
	if plan.ColumnCount() != len(want) {
		t.Fatalf("缺列数量不符：期望 %d，实际 %d（%v）", len(want), plan.ColumnCount(), plan.MissingColumns)
	}
	for table, column := range want {
		if strings.Join(plan.MissingColumns[table], ",") != column {
			t.Fatalf("%s 缺列识别错误: %v", table, plan.MissingColumns[table])
		}
	}
}

// 升级要同时满足四件事：补上结构、通过自检、旧数据一行不少、升级前留下备份。
func TestUpgradeRestoresSchemaAndKeepsData(t *testing.T) {
	conn, path := legacyDatabase(t)
	ctx := context.Background()
	backup := filepath.Join(filepath.Dir(path), "upgrade-backup.sqlite")

	plan, err := UpgradeSchema(ctx, conn, backup)
	if err != nil {
		t.Fatalf("UpgradeSchema: %v", err)
	}
	if len(plan.MissingTables) != 1 || plan.ColumnCount() != 4 {
		t.Fatalf("升级返回值不对: %+v", plan)
	}
	if err := VerifySchema(conn); err != nil {
		t.Fatalf("升级后仍不通过校验: %v", err)
	}

	// 数据还在，且新列取到了 DDL 里的默认值（SQLite 补 NOT NULL DEFAULT 列
	// 会把已有行填成默认值，不是 NULL）。
	var guestID sql.NullString
	var serverProxy, musicVolume int
	if err := conn.QueryRowContext(ctx,
		`SELECT "guestId" FROM "session" WHERE "socketId" = 's1'`).Scan(&guestID); err != nil {
		t.Fatalf("会话行丢失: %v", err)
	}
	if guestID.Valid {
		t.Fatalf("旧行的新列应为 NULL，实际 %q", guestID.String)
	}
	if err := conn.QueryRowContext(ctx,
		`SELECT "serverProxy" FROM "movie" WHERE "roomId" = 'r1'`).Scan(&serverProxy); err != nil {
		t.Fatalf("影片行丢失: %v", err)
	}
	if serverProxy != 0 {
		t.Fatalf("movie.serverProxy 的默认值应为 0，实际 %d", serverProxy)
	}
	if err := conn.QueryRowContext(ctx,
		`SELECT "roomDefaultMusicVolume" FROM "system_settings" WHERE "id" = 1`).Scan(&musicVolume); err != nil {
		t.Fatalf("设置行丢失: %v", err)
	}
	if musicVolume != 50 {
		t.Fatalf("system_settings.roomDefaultMusicVolume 的默认值应为 50，实际 %d", musicVolume)
	}
	var rooms int
	if err := conn.QueryRowContext(ctx, `SELECT COUNT(*) FROM "room"`).Scan(&rooms); err != nil || rooms != 1 {
		t.Fatalf("房间行丢失: count=%d err=%v", rooms, err)
	}

	// 备份必须是升级**之前**的快照：旧数据在，缺列还在。
	info, err := os.Stat(backup)
	if err != nil || info.Size() == 0 {
		t.Fatalf("没有生成备份文件: %v", err)
	}
	old, err := OpenForInit(backup, false)
	if err != nil {
		t.Fatalf("打不开备份: %v", err)
	}
	defer old.Close()
	var sessions int
	if err := old.QueryRow(`SELECT COUNT(*) FROM "session"`).Scan(&sessions); err != nil || sessions != 1 {
		t.Fatalf("备份里数据不对: count=%d err=%v", sessions, err)
	}
	oldCols, err := Columns(old, "session")
	if err != nil {
		t.Fatal(err)
	}
	if oldCols["guestId"] {
		t.Fatal("备份是升级之后的快照，起不到回滚作用")
	}
}

// 重复执行必须是无操作：既不再改库，也不再生成新备份。
func TestUpgradeIsIdempotent(t *testing.T) {
	conn, path := legacyDatabase(t)
	ctx := context.Background()
	if _, err := UpgradeSchema(ctx, conn, filepath.Join(filepath.Dir(path), "first.sqlite")); err != nil {
		t.Fatalf("首次升级: %v", err)
	}

	second := filepath.Join(filepath.Dir(path), "second.sqlite")
	plan, err := UpgradeSchema(ctx, conn, second)
	if err != nil {
		t.Fatalf("二次升级: %v", err)
	}
	if !plan.Empty() {
		t.Fatalf("已是当前结构，不该再有升级项: %+v", plan)
	}
	if _, err := os.Stat(second); !os.IsNotExist(err) {
		t.Fatal("无需升级时不应生成备份")
	}
}

// 补不了的列（NOT NULL 且无常量默认值）必须整体拒绝，而不是只改一半。
func TestUpgradeRefusesPartialAndDoesNotTouchDatabase(t *testing.T) {
	conn, path := legacyDatabase(t)
	ctx := context.Background()
	// songId 是 NOT NULL 且没有默认值，ADD COLUMN 补不了；
	// 同时保留一个能补的 guestId，用来证明失败时整批没有落库。
	if _, err := conn.ExecContext(ctx, `ALTER TABLE "music_queue_item" DROP COLUMN "songId"`); err != nil {
		t.Fatalf("DROP COLUMN: %v", err)
	}

	backup := filepath.Join(filepath.Dir(path), "refused.sqlite")
	if _, err := UpgradeSchema(ctx, conn, backup); err == nil {
		t.Fatal("含不可补列时应报错")
	} else if !strings.Contains(err.Error(), "music_queue_item.songId") {
		t.Fatalf("报错没有指出具体的列: %v", err)
	}

	cols, err := Columns(conn, "session")
	if err != nil {
		t.Fatal(err)
	}
	if cols["guestId"] {
		t.Fatal("被拒绝的升级不该动库")
	}
	if _, err := os.Stat(backup); !os.IsNotExist(err) {
		t.Fatal("拒绝发生在备份之前，不应留下备份文件")
	}
}

// 老库的缺列在启动路径上必须被拦下，并指向 --upgrade-db。
func TestOpenRejectsLegacyDatabaseWithActionableError(t *testing.T) {
	conn, path := legacyDatabase(t)
	conn.Close()

	reopened, err := Open(path, false)
	if reopened != nil {
		reopened.Close()
		t.Fatal("缺列的库不该被打开")
	}
	if err == nil {
		t.Fatal("缺列的库必须拒绝启动")
	}
	if !strings.Contains(err.Error(), "guestId") || !strings.Contains(err.Error(), "--upgrade-db") {
		t.Fatalf("报错需要指出缺列并给出下一步: %v", err)
	}
}
