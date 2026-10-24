package store

import (
	"context"
	"database/sql"
	"strings"
	"testing"
	"time"

	_ "modernc.org/sqlite"
)

const testUserDDL = `CREATE TABLE "user" (
	"id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	"username" varchar NOT NULL,
	"passwordHash" varchar NOT NULL,
	"role" varchar NOT NULL DEFAULT ('guest'),
	"status" varchar NOT NULL DEFAULT ('pending'),
	"avatar" varchar,
	"tokenInvalidBefore" datetime,
	"createdAt" datetime NOT NULL DEFAULT (datetime('now')),
	"updatedAt" datetime NOT NULL DEFAULT (datetime('now')),
	CONSTRAINT "UQ_user_username" UNIQUE ("username")
)`

func newTestUsers(t *testing.T) (*Users, *sql.DB) {
	t.Helper()
	conn, err := sql.Open("sqlite", "file::memory:?_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatalf("打开内存库失败: %v", err)
	}
	t.Cleanup(func() { conn.Close() })

	// :memory: 是每连接独立的，必须锁到单连接上，否则下一个查询会看到空库
	conn.SetMaxOpenConns(1)

	if _, err := conn.Exec(testUserDDL); err != nil {
		t.Fatalf("建表失败: %v", err)
	}
	users := NewUsers(conn)
	if _, err := conn.Exec(
		`INSERT INTO "user" ("username","passwordHash","role","status") VALUES ('u','h','root','active')`,
	); err != nil {
		t.Fatalf("插入用户失败: %v", err)
	}
	return users, conn
}

func TestInvalidateTokensWritesExplicitUTC(t *testing.T) {
	users, conn := newTestUsers(t)
	ctx := context.Background()

	if err := users.InvalidateTokens(ctx, 1); err != nil {
		t.Fatalf("吊销失败: %v", err)
	}

	var raw string
	if err := conn.QueryRow(`SELECT "tokenInvalidBefore" FROM "user" WHERE "id" = 1`).Scan(&raw); err != nil {
		t.Fatalf("读取失败: %v", err)
	}

	// 必须带 Z：两端（Go 的 RFC3339、Node 的 new Date）对无时区串的解释不同，
	// 少了 Z 就会出现"Go 认为已吊销、Node 认为仍有效"。
	if !strings.HasSuffix(raw, "Z") {
		t.Fatalf("tokenInvalidBefore 必须带显式时区，实际 %q", raw)
	}
	parsed, err := time.Parse(time.RFC3339, raw)
	if err != nil {
		t.Fatalf("无法按 RFC3339 解析: %v", err)
	}
	if drift := time.Since(parsed); drift < 0 || drift > 5*time.Second {
		t.Fatalf("写入的时间偏离当前时刻过大: %v", drift)
	}
}

func TestFormatRevocationKeepsMilliseconds(t *testing.T) {
	// 截到秒会让"改密同一秒内签发的令牌"继续有效，这正是吊销要挡的场景
	ts := time.Date(2026, 10, 24, 11, 9, 51, 238_000_000, time.UTC)
	if got := FormatRevocationTime(ts); got != "2026-10-24T11:09:51.238Z" {
		t.Fatalf("格式不对: %q", got)
	}
}

func TestUpdateUsernameAndAvatar(t *testing.T) {
	users, conn := newTestUsers(t)
	ctx := context.Background()

	user, err := users.UpdateUsername(ctx, 1, "新名字")
	if err != nil {
		t.Fatalf("改名失败: %v", err)
	}
	if user.Username != "新名字" {
		t.Fatalf("改名未生效: %q", user.Username)
	}

	avatarURL := "/uploads/avatars/1-1.png"
	user, err = users.UpdateAvatar(ctx, 1, &avatarURL)
	if err != nil {
		t.Fatalf("设置头像失败: %v", err)
	}
	if user.Avatar == nil || *user.Avatar != avatarURL {
		t.Fatalf("头像未生效: %v", user.Avatar)
	}

	user, err = users.UpdateAvatar(ctx, 1, nil)
	if err != nil {
		t.Fatalf("清空头像失败: %v", err)
	}
	if user.Avatar != nil {
		t.Fatalf("头像应为 nil，实际 %v", *user.Avatar)
	}

	// updatedAt 必须被刷新：表上没有 ON UPDATE 触发器，全靠语句自己写
	var updatedAt string
	if err := conn.QueryRow(`SELECT "updatedAt" FROM "user" WHERE "id" = 1`).Scan(&updatedAt); err != nil {
		t.Fatalf("读取 updatedAt 失败: %v", err)
	}
	if !strings.Contains(updatedAt, ".") {
		t.Fatalf("updatedAt 应带毫秒（TypeORM 写入格式），实际 %q", updatedAt)
	}
}

func TestUpdateMissingUserReturnsNotFound(t *testing.T) {
	users, _ := newTestUsers(t)
	if _, err := users.UpdateUsername(context.Background(), 999, "x"); err != ErrUserNotFound {
		t.Fatalf("期望 ErrUserNotFound，实际 %v", err)
	}
}
