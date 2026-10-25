package store

import (
	"context"
	"database/sql"
	"path/filepath"
	"sync"
	"testing"

	_ "modernc.org/sqlite"
)

// 并发首读同一个房间的弹幕辅助数据。
//
// 真实触发路径：4 个客户端同时打开一个刚创建的房间，REST 各自 GET
// /api/rooms/:id/danmaku-meta。大家同时 SELECT 不到行，就一起 INSERT，
// 而 "roomId" 上有 UNIQUE 索引 —— 后到的那个必然撞约束。
//
// 修之前这里会拿到 `constraint failed: UNIQUE constraint failed`（线上表现为
// 首次打开房间偶发 500）。Node 版抓不到：sql.js 单线程，await 之间不会被同类
// 写入插队；只有并发压测（scripts/soak.sh）才会暴露。
//
// 注意用**文件库**而不是 `file::memory:`：内存库每个连接一个独立实例，
// 多连接下根本不会互相撞约束，测试会假通过。
func TestMetasGetOrCreateConcurrent(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "meta.sqlite")
	conn, err := sql.Open("sqlite", "file:"+dbPath+"?_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatalf("打开库失败: %v", err)
	}
	t.Cleanup(func() { conn.Close() })
	conn.SetMaxOpenConns(8)

	ddl := `CREATE TABLE "room_danmaku_meta" (
		"id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
		"roomId" varchar NOT NULL,
		"blockKeywords" text NOT NULL DEFAULT ('[]'),
		"deletedLog" text NOT NULL DEFAULT ('[]'),
		"realtimeLog" text NOT NULL DEFAULT ('[]'),
		"createdAt" datetime NOT NULL DEFAULT (datetime('now')),
		"updatedAt" datetime NOT NULL DEFAULT (datetime('now')));
		CREATE UNIQUE INDEX "IDX_meta_room" ON "room_danmaku_meta" ("roomId");`
	if _, err := conn.Exec(ddl); err != nil {
		t.Fatalf("建表失败: %v", err)
	}

	metas := NewMetas(conn)
	const workers = 16
	start := make(chan struct{})
	errs := make([]error, workers)
	ids := make([]int64, workers)

	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			<-start
			meta, err := metas.GetOrCreate(context.Background(), "CONCURRENT1")
			if err != nil {
				errs[idx] = err
				return
			}
			ids[idx] = meta.ID
		}(i)
	}
	close(start)
	wg.Wait()

	for i, err := range errs {
		if err != nil {
			t.Fatalf("第 %d 个并发请求失败: %v", i, err)
		}
	}
	for i, id := range ids {
		if id != ids[0] {
			t.Fatalf("并发创建出了不同的行: 第 0 个 id=%d，第 %d 个 id=%d", ids[0], i, id)
		}
	}

	var count int
	if err := conn.QueryRow(`SELECT COUNT(*) FROM "room_danmaku_meta" WHERE "roomId" = 'CONCURRENT1'`).Scan(&count); err != nil {
		t.Fatalf("统计行数失败: %v", err)
	}
	if count != 1 {
		t.Fatalf("应只有 1 行，实际 %d 行", count)
	}
}

// 已有行时 GetOrCreate 不应重复插入（幂等）。
func TestMetasGetOrCreateIdempotent(t *testing.T) {
	conn := newTestCommentDB(t) // 复用 comment_test 的 DDL（含 room_danmaku_meta）
	metas := NewMetas(conn)

	first, err := metas.GetOrCreate(context.Background(), "R-IDEM")
	if err != nil {
		t.Fatalf("首次读取失败: %v", err)
	}
	second, err := metas.GetOrCreate(context.Background(), "R-IDEM")
	if err != nil {
		t.Fatalf("二次读取失败: %v", err)
	}
	if first.ID != second.ID {
		t.Fatalf("两次返回不同行: %d vs %d", first.ID, second.ID)
	}
}
