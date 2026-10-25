// Package db 打开既有 SQLite 数据库并提供连接池。
//
// 关键约束：**换库不在计划内**，结构以 TypeORM 生成物为准。
// 表结构与列名全部沿用 TypeORM 生成物，唯一事实源是 `schema.sql`。
//
// 启动路径（Open）只做三件事：连通性检查、VerifySchema、由调用方补索引；
// **绝不建表、绝不加列**——结构不符时立刻报错退出，避免两套代码各自
// "顺手补一下 schema" 导致结构漂移。
//
// 唯一的建表入口是显式的 `--init-db`（InitSchema），只用于空库。
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
			return nil, fmt.Errorf("数据库不存在: %s\n"+
				"新机器请先执行一次 `zviewer-server --init-db`（会建表并打印初始管理员密码）；\n"+
				"已有数据请确认 CONFIG_DIR / DATABASE_URL 指向了正确的库", path)
		}
		return nil, fmt.Errorf("数据库不可访问: %s: %w", path, err)
	}

	conn, err := sql.Open("sqlite", buildDSN(path, wal))
	if err != nil {
		return nil, fmt.Errorf("打开数据库失败: %w", err)
	}
	applyPool(conn)

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

// OpenForInit 打开（不存在则创建）库文件，但**不校验 schema**。
//
// 只给 `--init-db` 用：那时库里还没有表，走不通 Open 的强校验。
// 其它任何路径都必须用 Open，别为了"少几行"绕开结构校验。
func OpenForInit(path string, wal bool) (*sql.DB, error) {
	conn, err := sql.Open("sqlite", buildDSN(path, wal))
	if err != nil {
		return nil, fmt.Errorf("打开数据库失败: %w", err)
	}
	applyPool(conn)
	if err := conn.Ping(); err != nil {
		conn.Close()
		return nil, fmt.Errorf("数据库连通性检查失败: %w", err)
	}
	return conn, nil
}

// applyPool 统一连接池参数。
func applyPool(conn *sql.DB) {
	// modernc 驱动是纯 Go 实现，连接开销小，但并发写仍需串行化。
	// 单进程 + 短事务，2 条连接足够：一条查询、一条写入，避免自锁。
	conn.SetMaxOpenConns(2)
	conn.SetMaxIdleConns(2)
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
