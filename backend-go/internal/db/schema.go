package db

import (
	"database/sql"
	"fmt"
	"sort"
	"strings"
)

// RequiredTables 是 Node 版 TypeORM 生成的 16 张表。
//
// 这张清单是两侧共用数据库的"契约"：Go 版启动时逐项核对，
// 缺任何一张都直接拒绝启动，而不是自己补建——
// 补建出来的 DDL 只要和 TypeORM 有一处差异（CHECK、DEFAULT、COLLATE），
// 后续 Node 版 synchronize 就会静默重建表，造成数据丢失。
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

// VerifySchema 校验数据库结构是否符合预期。
func VerifySchema(conn *sql.DB) error {
	rows, err := conn.Query(
		`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
	)
	if err != nil {
		return fmt.Errorf("读取表清单失败: %w", err)
	}
	defer rows.Close()

	actual := make(map[string]struct{}, len(RequiredTables))
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return fmt.Errorf("读取表清单失败: %w", err)
		}
		actual[name] = struct{}{}
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("读取表清单失败: %w", err)
	}

	var missing []string
	for _, table := range RequiredTables {
		if _, ok := actual[table]; !ok {
			missing = append(missing, table)
		}
	}
	if len(missing) > 0 {
		sort.Strings(missing)
		return fmt.Errorf(
			"数据库结构与 Node 版不一致，缺少 %d 张表: %s\n"+
				"请先用 Node 版后端启动一次以完成建表，或检查 DATABASE_URL 是否指向了正确的库",
			len(missing), strings.Join(missing, ", "),
		)
	}

	// 抽查 user 表的关键列：鉴权、审计、房间权限都依赖它们，
	// 列名一旦不一致（例如 TypeORM 改了命名策略），宁可早失败。
	requiredUserColumns := []string{"id", "username", "passwordHash", "role", "status", "avatar", "tokenInvalidBefore"}
	columns, err := Columns(conn, "user")
	if err != nil {
		return err
	}
	var missingCols []string
	for _, col := range requiredUserColumns {
		if _, ok := columns[col]; !ok {
			missingCols = append(missingCols, col)
		}
	}
	if len(missingCols) > 0 {
		return fmt.Errorf("user 表缺少列: %s", strings.Join(missingCols, ", "))
	}
	return nil
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
