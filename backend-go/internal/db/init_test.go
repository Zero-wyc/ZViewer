package db

import (
	"context"
	"database/sql"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/crypto/bcrypt"
)

// openTemp 打开一个空的临时库（不校验 schema）。
func openTemp(t *testing.T) (*sql.DB, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "init.sqlite")
	conn, err := OpenForInit(path, false)
	if err != nil {
		t.Fatalf("OpenForInit: %v", err)
	}
	t.Cleanup(func() { conn.Close() })
	return conn, path
}

func TestInitSchemaCreatesAllTables(t *testing.T) {
	conn, _ := openTemp(t)
	ctx := context.Background()

	if err := InitSchema(ctx, conn); err != nil {
		t.Fatalf("InitSchema: %v", err)
	}
	// 建完必须能过 VerifySchema——这条断言把 schema.sql 与校验口径钉在一起。
	if err := VerifySchema(conn); err != nil {
		t.Fatalf("建表后 VerifySchema 仍未通过: %v", err)
	}

	var n int
	if err := conn.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
	).Scan(&n); err != nil {
		t.Fatalf("统计表数失败: %v", err)
	}
	if n != len(RequiredTables) {
		t.Fatalf("表数不符：期望 %d，实际 %d", len(RequiredTables), n)
	}
}

func TestInitSchemaRefusesNonEmptyDB(t *testing.T) {
	conn, _ := openTemp(t)
	ctx := context.Background()
	if err := InitSchema(ctx, conn); err != nil {
		t.Fatalf("首次 InitSchema: %v", err)
	}
	// 第二次必须拒绝，而不是把结构重盖一遍。
	if err := InitSchema(ctx, conn); err == nil {
		t.Fatal("非空库上 InitSchema 应报错")
	}
}

func TestSeedAdminOnlyCreatesOnce(t *testing.T) {
	conn, _ := openTemp(t)
	ctx := context.Background()
	if err := InitSchema(ctx, conn); err != nil {
		t.Fatalf("InitSchema: %v", err)
	}

	password, created, err := SeedAdmin(ctx, conn, "")
	if err != nil {
		t.Fatalf("SeedAdmin: %v", err)
	}
	if !created || password != "root" {
		t.Fatalf("应创建初始密码为 root 的管理员，实际 created=%v", created)
	}

	var role, status, passwordHash string
	if err := conn.QueryRowContext(ctx,
		`SELECT "role", "status", "passwordHash" FROM "user" WHERE "username" = 'root'`,
	).Scan(&role, &status, &passwordHash); err != nil {
		t.Fatalf("读取管理员失败: %v", err)
	}
	if role != "root" || status != "active" {
		t.Fatalf("管理员角色/状态不对: role=%s status=%s", role, status)
	}
	if passwordHash == "root" || bcrypt.CompareHashAndPassword([]byte(passwordHash), []byte("root")) != nil {
		t.Fatal("初始密码必须以可验证的 bcrypt 哈希保存")
	}
	changedHash, err := bcrypt.GenerateFromPassword([]byte("changed-test-password"), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := conn.ExecContext(ctx, `UPDATE "user" SET "passwordHash" = ? WHERE "username" = 'root'`, string(changedHash)); err != nil {
		t.Fatal(err)
	}

	// 已有用户时不能再建，否则每次 --init-db 都会多出一个 root。
	if password, created, err := SeedAdmin(ctx, conn, ""); err != nil || created || password != "" {
		t.Fatalf("第二次 SeedAdmin 不应创建: created=%v err=%v", created, err)
	}
	if err := conn.QueryRowContext(ctx, `SELECT "passwordHash" FROM "user" WHERE "username" = 'root'`).Scan(&passwordHash); err != nil {
		t.Fatal(err)
	}
	if passwordHash != string(changedHash) {
		t.Fatal("已有管理员修改过的密码被重置")
	}
}

func TestInitSchemaAddsIndexes(t *testing.T) {
	conn, _ := openTemp(t)
	ctx := context.Background()
	if err := InitSchema(ctx, conn); err != nil {
		t.Fatalf("InitSchema: %v", err)
	}
	if err := EnsureIndexes(ctx, conn); err != nil {
		t.Fatalf("EnsureIndexes: %v", err)
	}
	for _, spec := range RequiredIndexes {
		var name string
		if err := conn.QueryRowContext(ctx,
			`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`, spec.Name).Scan(&name); err != nil {
			t.Fatalf("索引 %s 缺失: %v", spec.Name, err)
		}
	}
}

// splitStatements 必须只吐出真正的 DDL，不能把注释块当语句执行。
func TestSplitStatements(t *testing.T) {
	script := `-- 头部注释
CREATE TABLE a (id integer);

-- 中间的注释
CREATE TABLE b (id integer);
`
	got := splitStatements(script)
	if len(got) != 2 {
		t.Fatalf("期望 2 条语句，实际 %d: %#v", len(got), got)
	}
	for _, s := range got {
		if strings.HasPrefix(strings.TrimSpace(s), "--") {
			t.Fatalf("语句里残留注释: %q", s)
		}
	}
}
