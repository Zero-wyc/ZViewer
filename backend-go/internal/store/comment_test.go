package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	_ "modernc.org/sqlite"
)

const testCommentDDL = `
CREATE TABLE "comment" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "roomId" varchar NOT NULL, "username" varchar NOT NULL, "content" varchar NOT NULL, "isDanmaku" boolean NOT NULL DEFAULT (0), "createdAt" datetime NOT NULL DEFAULT (datetime('now')));
CREATE TABLE "room_danmaku_meta" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "roomId" varchar NOT NULL, "blockKeywords" text NOT NULL DEFAULT ('[]'), "deletedLog" text NOT NULL DEFAULT ('[]'), "realtimeLog" text NOT NULL DEFAULT ('[]'), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')));
`

func newTestCommentDB(t *testing.T) *sql.DB {
	t.Helper()
	conn, err := sql.Open("sqlite", "file::memory:?_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatalf("打开内存库失败: %v", err)
	}
	t.Cleanup(func() { conn.Close() })
	conn.SetMaxOpenConns(1)
	for _, stmt := range strings.Split(testCommentDDL, ";") {
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

func TestCommentsCreateAndList(t *testing.T) {
	conn := newTestCommentDB(t)
	repo := NewComments(conn)
	ctx := context.Background()

	first, err := repo.Create(ctx, "ROOMC", "alice", "第一条", false)
	if err != nil {
		t.Fatalf("写入失败: %v", err)
	}
	if first.ID <= 0 {
		t.Fatalf("应回读自增 id，实际 %d", first.ID)
	}
	if _, err := repo.Create(ctx, "ROOMC", "bob", "弹幕形状", true); err != nil {
		t.Fatalf("写入失败: %v", err)
	}
	// 别的房间的评论不能混进来
	if _, err := repo.Create(ctx, "ROOMX", "carol", "别处", false); err != nil {
		t.Fatalf("写入失败: %v", err)
	}

	list, err := repo.ListByRoom(ctx, "ROOMC")
	if err != nil {
		t.Fatalf("读取失败: %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("应返回 2 条，实际 %d", len(list))
	}
	if list[0].Username != "alice" || list[1].Username != "bob" {
		t.Fatalf("应按 createdAt 升序返回，实际 %s,%s", list[0].Username, list[1].Username)
	}
	if !list[1].IsDanmaku {
		t.Error("isDanmaku 应透传 true")
	}
	if list[0].CreatedAt.IsZero() {
		t.Error("createdAt 应能解析出时间")
	}
}

func TestCommentsCreateKeepsMillisecondPrecision(t *testing.T) {
	conn := newTestCommentDB(t)
	repo := NewComments(conn)

	comment, err := repo.Create(context.Background(), "ROOMC", "alice", "x", false)
	if err != nil {
		t.Fatalf("写入失败: %v", err)
	}
	// 列默认值是秒级 datetime('now')；不显式写毫秒，同秒内多条评论会撞时间
	var raw string
	if err := conn.QueryRow(`SELECT "createdAt" FROM "comment" WHERE "id" = ?`, comment.ID).Scan(&raw); err != nil {
		t.Fatalf("读回失败: %v", err)
	}
	if !strings.Contains(raw, ".") {
		t.Fatalf("createdAt 应带毫秒，实际 %q", raw)
	}
}

func TestAppendRealtimeTrimsToLimit(t *testing.T) {
	conn := newTestCommentDB(t)
	metas := NewMetas(conn)
	ctx := context.Background()

	for i := 0; i < RealtimeLogLimit+5; i++ {
		entry, _ := json.Marshal(map[string]any{"id": fmt.Sprintf("d%d", i), "content": "x"})
		if _, err := metas.AppendRealtime(ctx, "ROOMC", entry); err != nil {
			t.Fatalf("追加失败: %v", err)
		}
	}

	meta, err := metas.GetOrCreate(ctx, "ROOMC")
	if err != nil {
		t.Fatalf("读取失败: %v", err)
	}
	var list []map[string]any
	if err := json.Unmarshal([]byte(meta.RealtimeLog), &list); err != nil {
		t.Fatalf("realtimeLog 不是合法数组: %v", err)
	}
	if len(list) != RealtimeLogLimit {
		t.Fatalf("应截断到 %d 条，实际 %d", RealtimeLogLimit, len(list))
	}
	if list[0]["id"] != "d5" {
		t.Fatalf("应丢弃最旧的 5 条，首条实际 %v", list[0]["id"])
	}
}

func TestAppendRealtimeRecoversFromBrokenJSON(t *testing.T) {
	conn := newTestCommentDB(t)
	metas := NewMetas(conn)
	ctx := context.Background()

	meta, err := metas.GetOrCreate(ctx, "ROOMB")
	if err != nil {
		t.Fatalf("建记录失败: %v", err)
	}
	if _, err := conn.Exec(`UPDATE "room_danmaku_meta" SET "realtimeLog" = 'not-json' WHERE "id" = ?`, meta.ID); err != nil {
		t.Fatalf("写坏数据失败: %v", err)
	}

	next, err := metas.AppendRealtime(ctx, "ROOMB", json.RawMessage(`{"id":"d1"}`))
	if err != nil {
		t.Fatalf("坏数据不应让追加失败: %v", err)
	}
	if next.RealtimeLog != `[{"id":"d1"}]` {
		t.Fatalf("应从空数组重建，实际 %q", next.RealtimeLog)
	}
}

func TestAppendRealtimeKeepsEntryShape(t *testing.T) {
	conn := newTestCommentDB(t)
	metas := NewMetas(conn)
	ctx := context.Background()

	// time 缺失时整个键不该出现：写成 0 会把弹幕钉在第 0 秒
	if _, err := metas.AppendRealtime(ctx, "ROOMC", json.RawMessage(`{"id":"a","content":"x","sender":"u"}`)); err != nil {
		t.Fatalf("追加失败: %v", err)
	}
	meta, _ := metas.GetOrCreate(ctx, "ROOMC")
	want := `[{"id":"a","content":"x","sender":"u"}]`
	if meta.RealtimeLog != want {
		t.Fatalf("realtimeLog = %q, want %q", meta.RealtimeLog, want)
	}
}
