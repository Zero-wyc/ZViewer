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

// 所有写入都显式更新 "updatedAt"。
//
// 表上只有 DEFAULT datetime('now')，没有 ON UPDATE 触发器；
// TypeORM 的 @UpdateDateColumn 是在应用层写的。Go 侧不补这一句，
// 改过的行 updatedAt 会永远停在创建时间——管理端按 updatedAt 排序/判断会错。
const touchUpdatedAt = `"updatedAt" = ?`

// UpdatePassword 更新密码哈希。
func (u *Users) UpdatePassword(ctx context.Context, id int64, hash string) error {
	res, err := u.conn.ExecContext(ctx,
		`UPDATE "user" SET "passwordHash" = ?, `+touchUpdatedAt+` WHERE "id" = ?`,
		hash, FormatSQLiteTime(time.Now()), id,
	)
	return ensureAffected(res, err, "修改密码失败")
}

// UpdateUsername 更新用户名，返回落库后的完整记录。
//
// 唯一约束由数据库兜底：调用方应先查重，但并发下仍可能撞车，
// 这里把约束冲突原样上抛，由 API 层翻译成 409。
func (u *Users) UpdateUsername(ctx context.Context, id int64, username string) (*User, error) {
	res, err := u.conn.ExecContext(ctx,
		`UPDATE "user" SET "username" = ?, `+touchUpdatedAt+` WHERE "id" = ?`,
		username, FormatSQLiteTime(time.Now()), id,
	)
	if err := ensureAffected(res, err, "修改用户名失败"); err != nil {
		return nil, err
	}
	return u.FindByID(ctx, id)
}

// UpdateAvatar 更新头像 URL；avatar 传 nil 表示恢复默认头像。
func (u *Users) UpdateAvatar(ctx context.Context, id int64, avatar *string) (*User, error) {
	res, err := u.conn.ExecContext(ctx,
		`UPDATE "user" SET "avatar" = ?, `+touchUpdatedAt+` WHERE "id" = ?`,
		nullableStringPtr(avatar), FormatSQLiteTime(time.Now()), id,
	)
	if err := ensureAffected(res, err, "更新头像失败"); err != nil {
		return nil, err
	}
	return u.FindByID(ctx, id)
}

// InvalidateTokens 使该用户此刻之前签发的所有令牌失效（含 refresh）。
//
// 必须在密码修改落库之后调用：先吊销再写密码，中间那段时间新密码
// 已可用而旧 token 仍然有效，等于窗口期白送。
func (u *Users) InvalidateTokens(ctx context.Context, id int64) error {
	now := FormatRevocationTime(time.Now())
	res, err := u.conn.ExecContext(ctx,
		`UPDATE "user" SET "tokenInvalidBefore" = ?, `+touchUpdatedAt+` WHERE "id" = ?`,
		now, FormatSQLiteTime(time.Now()), id,
	)
	return ensureAffected(res, err, "吊销用户令牌失败")
}

// FormatRevocationTime 序列化 tokenInvalidBefore，**带显式时区（Z）**。
//
// 这一列是唯一必须带时区的一列，原因是两端读它的方式不同：
//   - TypeORM 水合 datetime 列时走 new Date(str)，对 "YYYY-MM-DD HH:mm:ss"
//     这种无时区字符串按**服务器本地时区**解释（V8 的非 ISO 分支）；
//   - 但 DateUtils 写入时用的是 UTC 分解。
//
// 于是 Node 自己写、自己读就已经差一个时区偏移（UTC+8 下会多吊销 8 小时）。
// 如果 Go 也写无时区字符串，两个读法就会分叉成"Go 能拒、Node 不能拒"。
// 写成带 Z 的 ISO 串后，new Date() 与 Go 的 RFC3339 解析都得到同一个时刻，
// 迁回 Node 也不会放过改密前签发的旧令牌。
func FormatRevocationTime(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z07:00")
}

// ensureAffected 统一处理"没更新到任何行"的情况。
func ensureAffected(res sql.Result, err error, action string) error {
	if err != nil {
		return fmt.Errorf("%s: %w", action, err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return nil // 驱动不支持时不必失败
	}
	if n == 0 {
		return ErrUserNotFound
	}
	return nil
}

func nullableStringPtr(v *string) any {
	if v == nil {
		return nil
	}
	return *v
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

// FormatSQLiteTime 按 TypeORM 的写入格式序列化时间（UTC、毫秒精度）。
//
// **必须带毫秒**。TypeORM 的 DateUtils.mixedDateToUtcDatetimeString 生成的是
// 'YYYY-MM-DD HH:mm:ss.SSS'，而 DEFAULT datetime('now') 生成的只到秒——
// 两者都能被 SQLite 读，差异只体现在精度上。
//
// 这里的精度不是洁癖：tokenInvalidBefore 与 JWT 的 issuedAtMs 做"签发时间 <= 吊销时间"
// 比较。截到秒会让同一秒内签发的令牌在改密后依旧有效——而"改密后旧令牌立刻失效"
// 正是这个字段存在的唯一理由。
func FormatSQLiteTime(t time.Time) string {
	return t.UTC().Format("2006-01-02 15:04:05.000")
}
