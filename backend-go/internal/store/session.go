package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// Session 角色取值（对应 Node 的 `SessionRole`）。
const (
	SessionRoleSharer = "sharer"
	SessionRoleViewer = "viewer"
)

// Session 对应 "session" 表：一条 socket 在某个房间里的在场记录。
//
// 这张表是「房间准入」的唯一事实源：REST、媒体请求、socket 权限判定全都
// 通过 `endedAt IS NULL` 判断是否在场。**不要**把在场状态另存一份内存表，
// 否则重启后房主/观众会被当成不在场，表现为「房间在但谁都进不去」。
type Session struct {
	ID        int64
	RoomID    string
	SocketID  string
	Role      string
	UserID    *int64
	GuestID   *string
	StartedAt time.Time
	EndedAt   *time.Time
}

// Sessions 提供 session 表读写。
type Sessions struct {
	conn *sql.DB
}

// NewSessions 构造 session 仓库。
func NewSessions(conn *sql.DB) *Sessions { return &Sessions{conn: conn} }

const sessionColumns = `"id", "roomId", "socketId", "role", "userId", "guestId", "startedAt", "endedAt"`

// Create 插入一条在场记录并回填 ID 与 StartedAt。
//
// startedAt 显式写入（而不是交给表默认值）：TypeORM 的 @CreateDateColumn
// 写的是带毫秒的 UTC 串，而 DEFAULT datetime('now') 只到秒。两者都能读，
// 但 `getRecentSharer` 依赖 startedAt 排序，秒级精度会让同秒创建的两条记录
// 顺序不稳定。
func (s *Sessions) Create(ctx context.Context, sess *Session) error {
	now := time.Now()
	if sess.StartedAt.IsZero() {
		sess.StartedAt = now
	}
	res, err := s.conn.ExecContext(ctx, `
		INSERT INTO "session" ("roomId", "socketId", "role", "userId", "guestId", "startedAt", "endedAt")
		VALUES (?, ?, ?, ?, ?, ?, NULL)
	`, sess.RoomID, sess.SocketID, sess.Role, nullableInt64(sess.UserID), nullableStringPtr(sess.GuestID),
		FormatSQLiteTime(sess.StartedAt))
	if err != nil {
		return fmt.Errorf("创建会话失败: %w", err)
	}
	id, err := res.LastInsertId()
	if err == nil {
		sess.ID = id
	}
	return nil
}

// FindActiveBySocket 查该 socket 当前的活跃会话（跨房间，最多一条）。
func (s *Sessions) FindActiveBySocket(ctx context.Context, socketID string) (*Session, error) {
	return s.queryOne(ctx, `
		SELECT `+sessionColumns+` FROM "session"
		WHERE "socketId" = ? AND "endedAt" IS NULL
		LIMIT 1
	`, socketID)
}

// FindActiveByRoomRole 查房间内某角色的活跃会话（sharer 至多一条）。
func (s *Sessions) FindActiveByRoomRole(ctx context.Context, roomID, role string) (*Session, error) {
	return s.queryOne(ctx, `
		SELECT `+sessionColumns+` FROM "session"
		WHERE "roomId" = ? AND "role" = ? AND "endedAt" IS NULL
		LIMIT 1
	`, roomID, role)
}

// FindActiveByRoomSocket 查该房间内该 socket 的活跃会话。
func (s *Sessions) FindActiveByRoomSocket(ctx context.Context, roomID, socketID string) (*Session, error) {
	return s.queryOne(ctx, `
		SELECT `+sessionColumns+` FROM "session"
		WHERE "roomId" = ? AND "socketId" = ? AND "endedAt" IS NULL
		LIMIT 1
	`, roomID, socketID)
}

// FindActiveByRoomUser 查同一用户在同一房间的活跃会话。
//
// 游客（userID<=0）直接返回 nil：所有游客共享 userId=0，按它查会让不同
// 游客互相顶替，而游客本来就允许多端进入。
func (s *Sessions) FindActiveByRoomUser(ctx context.Context, roomID string, userID int64) (*Session, error) {
	if userID <= 0 {
		return nil, nil
	}
	return s.queryOne(ctx, `
		SELECT `+sessionColumns+` FROM "session"
		WHERE "roomId" = ? AND "userId" = ? AND "endedAt" IS NULL
		LIMIT 1
	`, roomID, userID)
}

// ListActiveByRoomRole 列出房间内某角色的全部活跃会话。
func (s *Sessions) ListActiveByRoomRole(ctx context.Context, roomID, role string) ([]*Session, error) {
	rows, err := s.conn.QueryContext(ctx, `
		SELECT `+sessionColumns+` FROM "session"
		WHERE "roomId" = ? AND "role" = ? AND "endedAt" IS NULL
	`, roomID, role)
	if err != nil {
		return nil, fmt.Errorf("查询会话列表失败: %w", err)
	}
	defer rows.Close()

	var list []*Session
	for rows.Next() {
		sess, err := scanSession(rows)
		if err != nil {
			return nil, fmt.Errorf("读取会话行失败: %w", err)
		}
		list = append(list, sess)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("遍历会话列表失败: %w", err)
	}
	return list, nil
}

// CountActiveByRoomRole 统计房间内某角色的活跃会话数。
func (s *Sessions) CountActiveByRoomRole(ctx context.Context, roomID, role string) (int64, error) {
	var n int64
	err := s.conn.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM "session"
		WHERE "roomId" = ? AND "role" = ? AND "endedAt" IS NULL
	`, roomID, role).Scan(&n)
	if err != nil {
		return 0, fmt.Errorf("统计会话数失败: %w", err)
	}
	return n, nil
}

// EndBySocket 结束该 socket 的所有活跃会话，返回受影响行数。
//
// Node 侧是 `update({socketId, endedAt: IsNull()}, {endedAt: new Date()})`，
// 一次可能命中多条（同一 socket 理论上只在一个房间，但历史脏数据里有
// 多条的），所以这里不带 roomId 条件。
func (s *Sessions) EndBySocket(ctx context.Context, socketID string) (int64, error) {
	res, err := s.conn.ExecContext(ctx, `
		UPDATE "session" SET "endedAt" = ?
		WHERE "socketId" = ? AND "endedAt" IS NULL
	`, FormatSQLiteTime(time.Now()), socketID)
	if err != nil {
		return 0, fmt.Errorf("结束会话失败: %w", err)
	}
	n, _ := res.RowsAffected()
	return n, nil
}

// EndByID 结束指定会话（房主新建房间时收尾旧房间的 sharer 会话）。
func (s *Sessions) EndByID(ctx context.Context, id int64) error {
	_, err := s.conn.ExecContext(ctx,
		`UPDATE "session" SET "endedAt" = ? WHERE "id" = ? AND "endedAt" IS NULL`,
		FormatSQLiteTime(time.Now()), id)
	if err != nil {
		return fmt.Errorf("结束会话失败: %w", err)
	}
	return nil
}

// EndByRoom 结束房间内所有活跃会话（关闭房间时用）。
func (s *Sessions) EndByRoom(ctx context.Context, roomID string) (int64, error) {
	res, err := s.conn.ExecContext(ctx, `
		UPDATE "session" SET "endedAt" = ?
		WHERE "roomId" = ? AND "endedAt" IS NULL
	`, FormatSQLiteTime(time.Now()), roomID)
	if err != nil {
		return 0, fmt.Errorf("结束房间会话失败: %w", err)
	}
	n, _ := res.RowsAffected()
	return n, nil
}

// UpdateReuse 复用一条已有会话：改 socketId / userId，并清空 endedAt。
//
// 房主重连时走这条路径（而不是新建），否则一个房间会攒下一串已结束的
// sharer 记录，`getRecentSharer` 的「最近一条」语义也随之漂移。
func (s *Sessions) UpdateReuse(ctx context.Context, id, userID int64, socketID string) error {
	_, err := s.conn.ExecContext(ctx, `
		UPDATE "session" SET "socketId" = ?, "userId" = ?, "endedAt" = NULL
		WHERE "id" = ?
	`, socketID, userID, id)
	if err != nil {
		return fmt.Errorf("复用会话失败: %w", err)
	}
	return nil
}

// FindLatestByRoomRole 查房间内该角色最近创建的一条会话（含已结束的）。
func (s *Sessions) FindLatestByRoomRole(ctx context.Context, roomID, role string) (*Session, error) {
	return s.queryOne(ctx, `
		SELECT `+sessionColumns+` FROM "session"
		WHERE "roomId" = ? AND "role" = ?
		ORDER BY "startedAt" DESC, "id" DESC
		LIMIT 1
	`, roomID, role)
}

// SetRole 修改会话角色（转交房主用）。
func (s *Sessions) SetRole(ctx context.Context, socketID, role string) (int64, error) {
	// 转交房主时前端不传房间：同一 socket 只会在一个房间里，按 socketId 定位即可。
	res, err := s.conn.ExecContext(ctx, `
		UPDATE "session" SET "role" = ? WHERE "socketId" = ?
	`, role, socketID)
	if err != nil {
		return 0, fmt.Errorf("修改会话角色失败: %w", err)
	}
	n, _ := res.RowsAffected()
	return n, nil
}

func (s *Sessions) queryOne(ctx context.Context, query string, args ...any) (*Session, error) {
	row := s.conn.QueryRowContext(ctx, query, args...)
	sess, err := scanSession(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("读取会话失败: %w", err)
	}
	return sess, nil
}

func scanSession(row rowScanner) (*Session, error) {
	var (
		sess    Session
		userID  sql.NullInt64
		guestID sql.NullString
		started sql.NullString
		ended   sql.NullString
	)
	if err := row.Scan(&sess.ID, &sess.RoomID, &sess.SocketID, &sess.Role,
		&userID, &guestID, &started, &ended); err != nil {
		return nil, err
	}
	if userID.Valid {
		v := userID.Int64
		sess.UserID = &v
	}
	sess.GuestID = nullString(guestID)
	sess.StartedAt = parseTimeOrZero(started)
	if ended.Valid && ended.String != "" {
		t := parseTimeOrZero(ended)
		sess.EndedAt = &t
	}
	return &sess, nil
}
