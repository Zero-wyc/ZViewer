package db

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// newTestDB 建一个只含被测两张表的最小库。
//
// 刻意不走 Open()：Open 会跑 VerifySchema 要求 16 张表齐全，而这里只想验证
// 索引与备份，用不上完整 schema。
func newTestDB(t *testing.T) *sql.DB {
	t.Helper()
	path := filepath.Join(t.TempDir(), "t.sqlite")
	conn, err := sql.Open("sqlite", "file:"+filepath.ToSlash(path))
	if err != nil {
		t.Fatalf("打开临时库失败: %v", err)
	}
	t.Cleanup(func() { conn.Close() })

	if _, err := conn.Exec(`
		CREATE TABLE IF NOT EXISTS "danmaku_track" (
			id INTEGER PRIMARY KEY AUTOINCREMENT, "roomId" TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS "session" (
			id INTEGER PRIMARY KEY AUTOINCREMENT, "roomId" TEXT NOT NULL,
			"socketId" TEXT NOT NULL, "role" TEXT, "endedAt" datetime
		);
	`); err != nil {
		t.Fatalf("建表失败: %v", err)
	}
	return conn
}

func TestEnsureIndexesIsIdempotent(t *testing.T) {
	conn := newTestDB(t)
	ctx := context.Background()

	// 连跑三次：第二次起必须完全是空操作（IF NOT EXISTS），不能报错。
	for i := 0; i < 3; i++ {
		if err := EnsureIndexes(ctx, conn); err != nil {
			t.Fatalf("第 %d 次 EnsureIndexes 失败: %v", i+1, err)
		}
	}

	for _, spec := range RequiredIndexes {
		var name string
		err := conn.QueryRowContext(ctx,
			`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`, spec.Name).Scan(&name)
		if err != nil {
			t.Fatalf("索引 %s 未创建: %v", spec.Name, err)
		}
	}
}

// 部分索引必须真的被查询计划用上，否则建了等于没建。
func TestSessionPartialIndexIsUsed(t *testing.T) {
	conn := newTestDB(t)
	ctx := context.Background()
	if err := EnsureIndexes(ctx, conn); err != nil {
		t.Fatalf("EnsureIndexes: %v", err)
	}

	rows, err := conn.QueryContext(ctx,
		`EXPLAIN QUERY PLAN SELECT * FROM "session" WHERE "roomId" = ? AND "role" = ? AND "endedAt" IS NULL LIMIT 1`,
		"r1", "host")
	if err != nil {
		t.Fatalf("EXPLAIN 失败: %v", err)
	}
	defer rows.Close()

	var plan strings.Builder
	for rows.Next() {
		var id, parent, notused int
		var detail string
		if err := rows.Scan(&id, &parent, &notused, &detail); err != nil {
			t.Fatalf("读取查询计划失败: %v", err)
		}
		plan.WriteString(detail)
		plan.WriteString("\n")
	}
	if !strings.Contains(plan.String(), "idx_session_active_room") {
		t.Fatalf("查询计划没有用上部分索引，实际计划:\n%s", plan.String())
	}
}

func TestBackupProducesReadableSnapshot(t *testing.T) {
	conn := newTestDB(t)
	ctx := context.Background()
	if _, err := conn.ExecContext(ctx, `INSERT INTO "danmaku_track" ("roomId") VALUES ('r1'), ('r2')`); err != nil {
		t.Fatalf("写测试数据失败: %v", err)
	}

	dest := filepath.Join(t.TempDir(), "backup.sqlite")
	if err := Backup(ctx, conn, dest); err != nil {
		t.Fatalf("Backup: %v", err)
	}
	if info, err := os.Stat(dest); err != nil || info.Size() == 0 {
		t.Fatalf("备份文件异常: %v", err)
	}

	snap, err := sql.Open("sqlite", "file:"+filepath.ToSlash(dest))
	if err != nil {
		t.Fatalf("打开备份失败: %v", err)
	}
	defer snap.Close()
	var n int
	if err := snap.QueryRow(`SELECT COUNT(*) FROM "danmaku_track"`).Scan(&n); err != nil {
		t.Fatalf("读备份失败: %v", err)
	}
	if n != 2 {
		t.Fatalf("备份内容不一致，期望 2 行，实际 %d", n)
	}

	// 已存在的目标必须拒绝，避免静默覆盖上一份备份。
	if err := Backup(ctx, conn, dest); err == nil {
		t.Fatal("目标已存在时 Backup 应报错")
	}
}
