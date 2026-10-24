package store

import (
	"context"
	"database/sql"
	"fmt"
	"time"
)

// AuditEntry 对应 "audit_logs" 表。
//
// 只保留 Go 侧当前会写的字段；其余列（target 等）留空由后续模块补齐。
type AuditEntry struct {
	ActorUserID   *int64
	ActorUsername string
	ActorRole     string
	Action        string
	IP            string
	Success       bool
	Detail        string
}

// Audit 提供审计日志写入。
type Audit struct {
	conn *sql.DB
}

// NewAudit 构造审计仓库。
func NewAudit(conn *sql.DB) *Audit { return &Audit{conn: conn} }

// Write 写一条审计记录。
//
// 审计失败不允许影响主流程——登录成功但审计写不进去时，
// 用户仍然应该登录成功，因此只返回错误供调用方记日志。
func (a *Audit) Write(ctx context.Context, entry AuditEntry) error {
	role := entry.ActorRole
	if role == "" {
		role = "system"
	}
	_, err := a.conn.ExecContext(ctx, `
		INSERT INTO "audit_logs"
			("actorUserId", "actorUsername", "actorRole", "action", "ip", "success", "detail", "createdAt")
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`,
		nullableInt64(entry.ActorUserID),
		nullableString(entry.ActorUsername),
		role,
		entry.Action,
		nullableString(entry.IP),
		entry.Success,
		nullableString(entry.Detail),
		FormatSQLiteTime(time.Now()),
	)
	if err != nil {
		return fmt.Errorf("写入审计日志失败: %w", err)
	}
	return nil
}

func nullableString(v string) any {
	if v == "" {
		return nil
	}
	return v
}

func nullableInt64(v *int64) any {
	if v == nil {
		return nil
	}
	return *v
}
