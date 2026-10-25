package db

import (
	"context"
	"crypto/rand"
	"database/sql"
	_ "embed"
	"errors"
	"fmt"
	"math/big"
	"strings"

	"golang.org/x/crypto/bcrypt"
)

// schemaSQL 是 TypeORM 生成物的逐字快照，只在 `--init-db` 里执行。
//
//go:embed schema.sql
var schemaSQL string

// InitResult 描述一次初始化实际做了什么。
type InitResult struct {
	TablesCreated int
	AdminUsername string
	AdminPassword string // 仅在本次新建了管理员时非空
}

// InitSchema 在**空库**上建表并补索引。
//
// 与启动路径的区别要说清楚：正常启动永远不会调用它（`VerifySchema` 缺表就退出）。
// 这里是显式的 `--init-db`，只服务于「新机器 / 新克隆仓库，config/ 里什么都还没有」
// 这一种情况。库里有任何一张表时直接拒绝，避免在半初始化的库上盖结构。
func InitSchema(ctx context.Context, conn *sql.DB) error {
	var existing int
	if err := conn.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
	).Scan(&existing); err != nil {
		return fmt.Errorf("读取现有表失败: %w", err)
	}
	if existing > 0 {
		return fmt.Errorf("数据库里已有 %d 张表，--init-db 只用于空库；"+
			"若确认要重建，请先备份（--backup-db）再自行删除文件", existing)
	}

	for _, stmt := range splitStatements(schemaSQL) {
		if _, err := conn.ExecContext(ctx, stmt); err != nil {
			return fmt.Errorf("建表失败: %w\n语句: %s", err, firstLine(stmt))
		}
	}
	return nil
}

// SeedAdmin 在 user 表为空时创建一个可登录的 root 账号。
//
// 为什么必须由代码建：注册接口永远只创建 role=user、status=pending 的账号
// （审批模式默认开启），新库没有任何人能审批——自举路径只能是这里。
// 密码随机生成并返回给调用方打印一次，不落盘、不写日志。
func SeedAdmin(ctx context.Context, conn *sql.DB, username string) (string, bool, error) {
	if username == "" {
		username = "root"
	}

	var count int
	if err := conn.QueryRowContext(ctx, `SELECT COUNT(*) FROM "user"`).Scan(&count); err != nil {
		return "", false, fmt.Errorf("读取用户数失败: %w", err)
	}
	if count > 0 {
		return "", false, nil
	}

	password, err := randomPassword(12)
	if err != nil {
		return "", false, err
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return "", false, fmt.Errorf("生成口令哈希失败: %w", err)
	}

	_, err = conn.ExecContext(ctx,
		`INSERT INTO "user" ("username", "passwordHash", "role", "status") VALUES (?, ?, 'root', 'active')`,
		username, string(hash),
	)
	if err != nil {
		return "", false, fmt.Errorf("创建初始管理员失败: %w", err)
	}
	return password, true, nil
}

// splitStatements 把 schema.sql 拆成单条语句，并丢掉整行注释。
//
// DDL 里没有含分号的字符串字面量（默认值都是 `('...')`），所以按分号切分是安全的。
// 去掉注释是为了让报错里的 firstLine 直接是可读的 DDL，而不是注释行。
func splitStatements(script string) []string {
	parts := strings.Split(script, ";")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if stmt := stripLineComments(p); stmt != "" {
			out = append(out, stmt)
		}
	}
	return out
}

// stripLineComments 去掉 `--` 开头的整行注释，用来判断这条语句是否只剩注释。
func stripLineComments(s string) string {
	var b strings.Builder
	for _, line := range strings.Split(s, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "--") {
			continue
		}
		b.WriteString(line)
		b.WriteString("\n")
	}
	return strings.TrimSpace(b.String())
}

func firstLine(s string) string {
	for _, line := range strings.Split(s, "\n") {
		if t := strings.TrimSpace(line); t != "" {
			return t
		}
	}
	return ""
}

func randomPassword(n int) (string, error) {
	const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	max := big.NewInt(int64(len(alphabet)))
	var b strings.Builder
	for i := 0; i < n; i++ {
		idx, err := rand.Int(rand.Reader, max)
		if err != nil {
			return "", errors.New("生成随机密码失败: " + err.Error())
		}
		b.WriteByte(alphabet[idx.Int64()])
	}
	return b.String(), nil
}
