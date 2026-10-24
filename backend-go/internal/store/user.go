// Package store 是对既有 SQLite 表的读写层。
//
// 所有 SQL 都按 TypeORM 生成的列名（camelCase、需双引号包裹）书写，
// 时间列按 SQLite 的 'YYYY-MM-DD HH:MM:SS'（UTC）解析。
package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// ErrUserNotFound 表示用户不存在。
var ErrUserNotFound = errors.New("用户不存在")

// User 对应 "user" 表。
type User struct {
	ID                 int64
	Username           string
	PasswordHash       string
	Role               string
	Status             string
	Avatar             *string
	TokenInvalidBefore *time.Time
	CreatedAt          time.Time
	UpdatedAt          time.Time
}

// Users 提供用户表查询。
type Users struct {
	conn *sql.DB
}

// NewUsers 构造用户仓库。
func NewUsers(conn *sql.DB) *Users { return &Users{conn: conn} }

const userColumns = `"id", "username", "passwordHash", "role", "status", "avatar", "tokenInvalidBefore", "createdAt", "updatedAt"`

// FindByID 按主键查询用户。
func (u *Users) FindByID(ctx context.Context, id int64) (*User, error) {
	row := u.conn.QueryRowContext(ctx, `SELECT `+userColumns+` FROM "user" WHERE "id" = ? LIMIT 1`, id)
	return scanUser(row)
}

// FindByUsername 按用户名查询用户（用户名唯一）。
func (u *Users) FindByUsername(ctx context.Context, username string) (*User, error) {
	row := u.conn.QueryRowContext(ctx, `SELECT `+userColumns+` FROM "user" WHERE "username" = ? LIMIT 1`, username)
	return scanUser(row)
}

// Count 返回用户总数（用于判断是否需要初始化 root 账号）。
func (u *Users) Count(ctx context.Context) (int64, error) {
	var n int64
	err := u.conn.QueryRowContext(ctx, `SELECT COUNT(*) FROM "user"`).Scan(&n)
	return n, err
}

// Create 新增用户并返回落库后的完整记录。
//
// createdAt / updatedAt 交给表默认值（datetime('now')），
// 与 TypeORM 的 CreateDateColumn 行为一致，避免两侧时间格式分叉。
func (u *Users) Create(ctx context.Context, username, passwordHash, role, status string) (*User, error) {
	res, err := u.conn.ExecContext(ctx,
		`INSERT INTO "user" ("username", "passwordHash", "role", "status") VALUES (?, ?, ?, ?)`,
		username, passwordHash, role, status,
	)
	if err != nil {
		return nil, fmt.Errorf("创建用户失败: %w", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		return nil, fmt.Errorf("创建用户失败: %w", err)
	}
	return u.FindByID(ctx, id)
}

func scanUser(row *sql.Row) (*User, error) {
	var (
		user      User
		avatar    sql.NullString
		invalid   sql.NullString
		createdAt string
		updatedAt string
	)
	err := row.Scan(
		&user.ID, &user.Username, &user.PasswordHash, &user.Role, &user.Status,
		&avatar, &invalid, &createdAt, &updatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrUserNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("读取用户失败: %w", err)
	}
	if avatar.Valid {
		v := avatar.String
		user.Avatar = &v
	}
	if invalid.Valid && invalid.String != "" {
		if t, ok := parseSQLiteTime(invalid.String); ok {
			user.TokenInvalidBefore = &t
		}
	}
	user.CreatedAt, _ = parseSQLiteTime(createdAt)
	user.UpdatedAt, _ = parseSQLiteTime(updatedAt)
	return &user, nil
}

// sqliteTimeLayouts 覆盖两类写入来源：
// TypeORM/sql.js 的 datetime('now')（UTC、无时区标记）与 Go 侧可能写入的 RFC3339。
var sqliteTimeLayouts = []string{
	"2006-01-02 15:04:05",
	"2006-01-02 15:04:05.999999999",
	time.RFC3339Nano,
	"2006-01-02T15:04:05",
}

// parseSQLiteTime 解析 SQLite 时间字符串，统一按 UTC 理解。
func parseSQLiteTime(raw string) (time.Time, bool) {
	if raw == "" {
		return time.Time{}, false
	}
	for _, layout := range sqliteTimeLayouts {
		if t, err := time.ParseInLocation(layout, raw, time.UTC); err == nil {
			return t.UTC(), true
		}
		if t, err := time.Parse(layout, raw); err == nil {
			return t.UTC(), true
		}
	}
	return time.Time{}, false
}

// FormatSQLiteTime 按 TypeORM 的写入格式序列化时间（UTC、秒精度）。
func FormatSQLiteTime(t time.Time) string {
	return t.UTC().Format("2006-01-02 15:04:05")
}
