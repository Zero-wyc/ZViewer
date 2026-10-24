// Package db 打开既有 SQLite 数据库并提供连接池。
//
// 关键约束（与整体迁移策略一致）：**不换数据库**。
// Go 版直接读写 Node 版 sql.js 产出的同一个 .sqlite 文件，
// 表结构、列名、时间格式全部沿用 TypeORM 生成物；
// 本包不做任何建表或迁移——结构不符时立刻报错退出，
// 避免两套代码各自"顺手补一下 schema"导致结构漂移。
package db

import (
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	_ "modernc.org/sqlite" // 纯 Go 驱动，无 CGO，交叉编译友好
)

// Open 打开数据库并校验 schema。
func Open(path string, wal bool) (*sql.DB, error) {
	if _, err := os.Stat(path); err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("数据库不存在: %s（请先用 Node 版完成初始化，或确认 CONFIG_DIR / DATABASE_URL）", path)
		}
		return nil, fmt.Errorf("数据库不可访问: %s: %w", path, err)
	}

	conn, err := sql.Open("sqlite", buildDSN(path, wal))
	if err != nil {
		return nil, fmt.Errorf("打开数据库失败: %w", err)
	}

	// modernc 驱动是纯 Go 实现，连接开销小，但并发写仍需串行化。
	// 单进程 + 短事务，2 条连接足够：一条查询、一条写入，避免自锁。
	conn.SetMaxOpenConns(2)
	conn.SetMaxIdleConns(2)

	if err := conn.Ping(); err != nil {
		conn.Close()
		return nil, fmt.Errorf("数据库连通性检查失败: %w", err)
	}
	if err := VerifySchema(conn); err != nil {
		conn.Close()
		return nil, err
	}
	return conn, nil
}

func buildDSN(path string, wal bool) string {
	// busy_timeout 必须设：迁移期可能还有别的进程短暂持有写锁，
	// 否则接口会随机拿到 SQLITE_BUSY 变成 500。
	pragmas := []string{
		"_pragma=busy_timeout(5000)",
		"_pragma=foreign_keys(ON)",
		"_pragma=synchronous(NORMAL)",
	}
	if wal {
		// WAL 会改写库文件头的 journal 模式并生成 -wal/-shm 旁文件，
		// 属于持久化变更，因此只允许显式开启（SQLITE_WAL=1）。
		pragmas = append(pragmas, "_pragma=journal_mode(WAL)")
	}
	return "file:" + url.PathEscape(absoluteSlashPath(path)) + "?" + strings.Join(pragmas, "&")
}

// absoluteSlashPath 统一为绝对路径 + 正斜杠，
// 避免 Windows 反斜杠在 DSN 中被当作转义字符。
func absoluteSlashPath(path string) string {
	abs, err := filepath.Abs(path)
	if err != nil {
		abs = path
	}
	return filepath.ToSlash(abs)
}
