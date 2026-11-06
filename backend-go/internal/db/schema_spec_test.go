package db

import (
	"context"
	"sort"
	"strings"
	"testing"
)

// RequiredTables 是手写清单，schema.sql 是事实源，两者必须一致：
// 往 schema.sql 加表却忘了改清单，会让新表在启动校验里彻底不被检查。
func TestRequiredTablesMatchSchemaSQL(t *testing.T) {
	spec, err := Schema()
	if err != nil {
		t.Fatalf("解析 schema.sql: %v", err)
	}
	var fromSQL []string
	for _, table := range spec {
		fromSQL = append(fromSQL, table.Name)
	}
	sort.Strings(fromSQL)

	want := append([]string(nil), RequiredTables...)
	sort.Strings(want)

	if strings.Join(fromSQL, ",") != strings.Join(want, ",") {
		t.Fatalf("RequiredTables 与 schema.sql 不一致\n  schema.sql: %v\n  RequiredTables: %v", fromSQL, want)
	}
}

// 解析结果必须和「真正建出来的表」逐列一致。
//
// 这条断言是解析器的保险：正则/切行一旦漏掉某类列（例如带 CHECK 的、
// 带 varchar(50) 的），这里立刻会暴露，而不是等到线上放行了缺列的库。
func TestParsedColumnsMatchCreatedSchema(t *testing.T) {
	conn, _ := openTemp(t)
	ctx := context.Background()
	if err := InitSchema(ctx, conn); err != nil {
		t.Fatalf("InitSchema: %v", err)
	}

	spec, err := Schema()
	if err != nil {
		t.Fatalf("解析 schema.sql: %v", err)
	}
	for _, table := range spec {
		actual, err := Columns(conn, table.Name)
		if err != nil {
			t.Fatalf("%s: %v", table.Name, err)
		}
		if len(actual) != len(table.Columns) {
			t.Fatalf("%s 列数不符：解析 %d，实际 %d", table.Name, len(table.Columns), len(actual))
		}
		for _, col := range table.Columns {
			if !actual[col.Name] {
				t.Fatalf("%s 解析出的列 %q 在真实表里不存在", table.Name, col.Name)
			}
			if col.Type == "" || strings.ContainsAny(col.Type, `" `) {
				t.Fatalf("%s.%s 类型解析异常: %q", table.Name, col.Name, col.Type)
			}
		}
	}
}

// 可空列、带常量默认值的 NOT NULL 列都能用 ADD COLUMN 补；
// 主键列和 `DEFAULT (datetime('now'))` 这类不能——SQLite 明确禁止。
func TestColumnAddabilityFollowsSQLiteRules(t *testing.T) {
	spec, err := Schema()
	if err != nil {
		t.Fatalf("解析 schema.sql: %v", err)
	}
	find := func(table, column string) ColumnSpec {
		t.Helper()
		for _, s := range spec {
			if s.Name != table {
				continue
			}
			if col, ok := s.Column(column); ok {
				return col
			}
		}
		t.Fatalf("schema.sql 里找不到 %s.%s", table, column)
		return ColumnSpec{}
	}

	cases := []struct {
		table, column string
		addable       bool
		wantDDL       string
	}{
		{"session", "guestId", true, `ALTER TABLE "session" ADD COLUMN "guestId" varchar`},
		{"playback_states", "noProxyFallback", true, `ALTER TABLE "playback_states" ADD COLUMN "noProxyFallback" boolean`},
		{"movie", "serverProxy", true, `ALTER TABLE "movie" ADD COLUMN "serverProxy" boolean NOT NULL DEFAULT 0`},
		{"system_settings", "roomDefaultMusicVolume", true, `ALTER TABLE "system_settings" ADD COLUMN "roomDefaultMusicVolume" integer NOT NULL DEFAULT 50`},
		{"system_settings", "livekitExternalUrl", true, `ALTER TABLE "system_settings" ADD COLUMN "livekitExternalUrl" text NOT NULL DEFAULT ''`},
		// 主键列不能补
		{"playback_states", "roomId", false, ""},
		// NOT NULL 且默认值是 datetime('now')，SQLite 不允许 ADD COLUMN 带这种默认值
		{"playback_states", "createdAt", false, ""},
		// NOT NULL 且完全没有默认值
		{"playback_states", "sourceUrl", false, ""},
	}
	for _, c := range cases {
		col := find(c.table, c.column)
		ddl, ok := col.AlterDDL(c.table)
		if ok != c.addable {
			t.Fatalf("%s.%s 可补性判断错误：期望 %v，实际 %v（%s）", c.table, c.column, c.addable, ok, ddl)
		}
		if ok && ddl != c.wantDDL {
			t.Fatalf("%s.%s 生成的 DDL 不符\n  期望: %s\n  实际: %s", c.table, c.column, c.wantDDL, ddl)
		}
	}
}

// 缺列必须被拦下：这正是 4.6/4.7 升 5.x 时「启动正常、运行时读出字符串垃圾值」的根因。
func TestVerifySchemaRejectsMissingColumn(t *testing.T) {
	conn, _ := openTemp(t)
	ctx := context.Background()
	if err := InitSchema(ctx, conn); err != nil {
		t.Fatalf("InitSchema: %v", err)
	}
	if err := VerifySchema(conn); err != nil {
		t.Fatalf("刚建好的库应通过校验: %v", err)
	}

	if _, err := conn.ExecContext(ctx, `ALTER TABLE "session" DROP COLUMN "guestId"`); err != nil {
		t.Fatalf("DROP COLUMN 不可用（SQLite 版本过低）: %v", err)
	}
	err := VerifySchema(conn)
	if err == nil {
		t.Fatal("缺列时 VerifySchema 必须报错")
	}
	msg := err.Error()
	if !strings.Contains(msg, "session") || !strings.Contains(msg, "guestId") {
		t.Fatalf("报错没有指出具体的表和列: %s", msg)
	}
	if !strings.Contains(msg, "--upgrade-db") {
		t.Fatalf("报错没有给出可执行的下一步: %s", msg)
	}
}

func TestVerifySchemaRejectsMissingTable(t *testing.T) {
	conn, _ := openTemp(t)
	ctx := context.Background()
	if err := InitSchema(ctx, conn); err != nil {
		t.Fatalf("InitSchema: %v", err)
	}
	if _, err := conn.ExecContext(ctx, `DROP TABLE "music_queue_item"`); err != nil {
		t.Fatalf("DROP TABLE: %v", err)
	}
	err := VerifySchema(conn)
	if err == nil {
		t.Fatal("缺表时 VerifySchema 必须报错")
	}
	if !strings.Contains(err.Error(), "music_queue_item") {
		t.Fatalf("报错没有指出缺失的表: %s", err)
	}
}

// EnsurePlaybackMetadata 必须仍然能把 4.8.0 的库补成可启动状态：
// 它是启动路径上唯一的自动列迁移，被严格列校验挡掉就等于断掉了那条升级路。
func TestOpenAcceptsLegacyPlaybackMetadata(t *testing.T) {
	conn, path := openTemp(t)
	ctx := context.Background()
	if err := InitSchema(ctx, conn); err != nil {
		t.Fatalf("InitSchema: %v", err)
	}
	if _, err := conn.ExecContext(ctx, `ALTER TABLE "playback_states" DROP COLUMN "metadata"`); err != nil {
		t.Fatalf("DROP COLUMN: %v", err)
	}
	conn.Close()

	reopened, err := Open(path, false)
	if err != nil {
		t.Fatalf("4.8.0 形态的库应能自动补齐 metadata 后启动: %v", err)
	}
	defer reopened.Close()

	cols, err := Columns(reopened, "playback_states")
	if err != nil {
		t.Fatal(err)
	}
	if !cols["metadata"] {
		t.Fatal("metadata 列没有被补上")
	}
}
