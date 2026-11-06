package db

import (
	"database/sql"
	"errors"
	"fmt"
	"sort"
	"strings"
)

// RequiredTables 是 Go 侧要求必须存在的 16 张表。
//
// 它与 schema.sql 是**互相校验**的关系（见 TestRequiredTablesMatchSchemaSQL）：
// 往 schema.sql 加表必须同步改这里，否则测试会失败。两份清单里任意一份被
// 误删时，另一份还能兜住——缺表、缺列在启动时都是硬错误。
var RequiredTables = []string{
	"audit_logs",
	"bilibili_credential",
	"comment",
	"danmaku_track",
	"movie",
	"music_playback_states",
	"music_queue_item",
	"ncm_credential",
	"playback_states",
	"room",
	"room_danmaku_meta",
	"server_folder",
	"session",
	"system_settings",
	"user",
	"user_mount",
}

// ExistingTables 返回库里现有的表名集合（不含 sqlite_ 内部表）。
//
// 结构校验只保留 VerifySchema 一个入口，不要拆出「只查表」的变体：
// 那会让缺表的老库先报一条不完整的信息，用户跑完升级才发现还有缺列。
func ExistingTables(conn *sql.DB) (map[string]struct{}, error) {
	rows, err := conn.Query(
		`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
	)
	if err != nil {
		return nil, fmt.Errorf("读取表清单失败: %w", err)
	}
	defer rows.Close()

	actual := make(map[string]struct{}, len(RequiredTables))
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, fmt.Errorf("读取表清单失败: %w", err)
		}
		actual[name] = struct{}{}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("读取表清单失败: %w", err)
	}
	return actual, nil
}

// VerifySchema 按 schema.sql 逐表逐列校验结构。
//
// 为什么必须查到列：4.x 的 TypeORM 是 `synchronize: true`，每次启动自动补表补列；
// 5.x 明确「绝不自动改表」。所以「表齐但缺列」的老库（4.6/4.7）在只查表名的
// 旧校验下会被判为健康——而 SQLite 对**双引号包裹但不存在的列名会退化成字符串
// 字面量**，读出来是 "noProxyFallback" 这样的垃圾值，或者写入时直接报
// table session has no column named guestId。这种坏法必须挡在启动前。
//
// 缺表和缺列一次性报全：用户只跑一条命令，没必要让他来回两趟。
func VerifySchema(conn *sql.DB) error {
	spec, err := Schema()
	if err != nil {
		return fmt.Errorf("解析 schema.sql 失败: %w", err)
	}
	existing, err := ExistingTables(conn)
	if err != nil {
		return err
	}

	var (
		missingTables []string
		columnLines   []string
		missingCols   int
	)
	// 缺表按手写契约报（schema.sql 与它的差异由测试兜），缺列按 schema.sql 报。
	for _, name := range RequiredTables {
		if _, ok := existing[name]; !ok {
			missingTables = append(missingTables, name)
		}
	}
	for _, table := range spec {
		if _, ok := existing[table.Name]; !ok {
			continue // 表都没有，列无从谈起，已在上面的缺表清单里
		}
		actual, err := Columns(conn, table.Name)
		if err != nil {
			return err
		}
		var missing []string
		for _, col := range table.Columns {
			if !actual[col.Name] {
				missing = append(missing, col.Name)
			}
		}
		if len(missing) == 0 {
			continue
		}
		missingCols += len(missing)
		columnLines = append(columnLines, fmt.Sprintf("  %s: %s", table.Name, strings.Join(missing, ", ")))
	}
	if len(missingTables) == 0 && missingCols == 0 {
		return nil
	}
	sort.Strings(missingTables)

	var b strings.Builder
	switch {
	case len(missingTables) > 0 && missingCols > 0:
		fmt.Fprintf(&b, "数据库结构不完整：缺少 %d 张表、%d 个列", len(missingTables), missingCols)
	case len(missingTables) > 0:
		fmt.Fprintf(&b, "数据库结构不完整：缺少 %d 张表", len(missingTables))
	default:
		fmt.Fprintf(&b, "数据库结构不完整：%d 张表共缺少 %d 个列", len(columnLines), missingCols)
	}
	b.WriteString("\n")
	if len(missingTables) > 0 {
		fmt.Fprintf(&b, "  缺表: %s\n", strings.Join(missingTables, ", "))
	}
	for _, line := range columnLines {
		b.WriteString(line)
		b.WriteString("\n")
	}
	if missingCols > 0 {
		b.WriteString("这通常是从 4.x 直接升到 5.x 造成的：4.x 每次启动自动改表，5.x 不会。\n")
	}
	b.WriteString("空库请执行一次 `zviewer-server --init-db`；\n" +
		"已有数据的库请执行 `zviewer-server --upgrade-db`：先做一致性备份，再补上缺失的表和列")
	return errors.New(b.String())
}

// Columns 返回指定表的列名集合（键为列名，值为 true）。
func Columns(conn *sql.DB, table string) (map[string]bool, error) {
	// 表名来自代码内常量，不接受外部输入，不存在注入面
	rows, err := conn.Query(`SELECT name FROM pragma_table_info(?)`, table)
	if err != nil {
		return nil, fmt.Errorf("读取 %s 表结构失败: %w", table, err)
	}
	defer rows.Close()

	result := make(map[string]bool)
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, fmt.Errorf("读取 %s 表结构失败: %w", table, err)
		}
		result[name] = true
	}
	return result, rows.Err()
}
