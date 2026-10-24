package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// ErrRoomNotFound 表示房间不存在。
var ErrRoomNotFound = errors.New("房间不存在")

// Room 对应 "room" 表。
//
// 迁移期只映射 REST 层用得到的列：房间创建/准入/在线统计走 socket.io，
// 那部分尚未迁移，所以密文列（password 只有「有没有」的语义）、
// streamKey、成员名单（mutedViewers 等）都不落结构体。
type Room struct {
	ID              int64
	RoomID          string
	Name            *string
	Status          string
	Mode            string
	MaxViewers      int64
	RequireApproval bool
	// HasPassword 对应 Node 的 `hasPassword: !!room.password`：
	// 空串也算没有密码（`!!''` 为 false）。
	HasPassword    bool
	OwnerUserID    *int64
	LastAccessedAt time.Time
	CreatedAt      time.Time
	UpdatedAt      time.Time
}

// Rooms 提供房间表读写。
type Rooms struct {
	conn *sql.DB
}

// NewRooms 构造房间仓库。
func NewRooms(conn *sql.DB) *Rooms { return &Rooms{conn: conn} }

const roomColumns = `"id", "roomId", "name", "status", "mode", "maxViewers",
	"requireApproval", "password", "ownerUserId",
	"lastAccessedAt", "createdAt", "updatedAt"`

// FindByRoomID 读取房间。
func (r *Rooms) FindByRoomID(ctx context.Context, roomID string) (*Room, error) {
	row := r.conn.QueryRowContext(ctx,
		`SELECT `+roomColumns+` FROM "room" WHERE "roomId" = ? LIMIT 1`, roomID)
	room, err := scanRoom(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrRoomNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("读取房间失败: %w", err)
	}
	return room, nil
}

// ListActive 返回所有状态为 active 的房间，按最后访问时间倒序
// （对应 rooms.ts 的 `where: { status: 'active' }, order: { lastAccessedAt: 'DESC' }`）。
func (r *Rooms) ListActive(ctx context.Context) ([]*Room, error) {
	rows, err := r.conn.QueryContext(ctx, `
		SELECT `+roomColumns+` FROM "room"
		WHERE "status" = 'active'
		ORDER BY "lastAccessedAt" DESC
	`)
	if err != nil {
		return nil, fmt.Errorf("查询房间列表失败: %w", err)
	}
	defer rows.Close()

	var list []*Room
	for rows.Next() {
		room, err := scanRoom(rows)
		if err != nil {
			return nil, fmt.Errorf("读取房间行失败: %w", err)
		}
		list = append(list, room)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("遍历房间列表失败: %w", err)
	}
	return list, nil
}

// SessionCounts 是房间在线统计：观众数与 sharer（投屏端）是否存在。
type SessionCounts struct {
	Viewers map[string]int64
	Sharers map[string]struct{}
}

// ActiveSessionCounts 一次性统计一批房间的在线观众与 sharer。
//
// 刻意只查一回（rooms.ts 用 In(roomIds) 批量查询消 N+1）：房间列表页
// 可能一次几十个房间，逐个查会把首屏拖成几十次往返。
func (r *Rooms) ActiveSessionCounts(ctx context.Context, roomIDs []string) (*SessionCounts, error) {
	counts := &SessionCounts{
		Viewers: make(map[string]int64, len(roomIDs)),
		Sharers: make(map[string]struct{}, len(roomIDs)),
	}
	if len(roomIDs) == 0 {
		return counts, nil
	}

	// 参数占位符按房间数动态生成，避免 SQL 注入也避免固定上限。
	placeholders := make([]byte, 0, len(roomIDs)*2)
	args := make([]any, 0, len(roomIDs))
	for i, id := range roomIDs {
		if i > 0 {
			placeholders = append(placeholders, ',')
		}
		placeholders = append(placeholders, '?')
		args = append(args, id)
	}

	rows, err := r.conn.QueryContext(ctx, `
		SELECT "roomId", "role", COUNT(*) FROM "session"
		WHERE "roomId" IN (`+string(placeholders)+`) AND "endedAt" IS NULL
		GROUP BY "roomId", "role"
	`, args...)
	if err != nil {
		return nil, fmt.Errorf("统计房间在线人数失败: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var (
			id    string
			role  string
			total int64
		)
		if err := rows.Scan(&id, &role, &total); err != nil {
			return nil, fmt.Errorf("读取在线统计失败: %w", err)
		}
		switch role {
		case "viewer":
			counts.Viewers[id] = total
		case "sharer":
			counts.Sharers[id] = struct{}{}
		}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("遍历在线统计失败: %w", err)
	}
	return counts, nil
}

// Rename 修改房间名称。
func (r *Rooms) Rename(ctx context.Context, roomID, name string) error {
	res, err := r.conn.ExecContext(ctx,
		`UPDATE "room" SET "name" = ?, "updatedAt" = datetime('now') WHERE "roomId" = ?`,
		name, roomID)
	if err != nil {
		return fmt.Errorf("修改房间名称失败: %w", err)
	}
	if n, err := res.RowsAffected(); err == nil && n == 0 {
		return ErrRoomNotFound
	}
	return nil
}

func scanRoom(row rowScanner) (*Room, error) {
	var (
		room       Room
		name       sql.NullString
		status     sql.NullString
		mode       sql.NullString
		maxViewers sql.NullInt64
		approval   sql.NullInt64
		password   sql.NullString
		owner      sql.NullInt64
		lastAccess sql.NullString
		createdAt  sql.NullString
		updatedAt  sql.NullString
	)
	err := row.Scan(
		&room.ID, &room.RoomID, &name, &status, &mode, &maxViewers,
		&approval, &password, &owner,
		&lastAccess, &createdAt, &updatedAt,
	)
	if err != nil {
		return nil, err
	}
	room.Name = nullString(name)
	room.Status = status.String
	room.Mode = mode.String
	room.MaxViewers = maxViewers.Int64
	room.RequireApproval = approval.Int64 != 0
	room.HasPassword = password.Valid && password.String != ""
	if owner.Valid {
		v := owner.Int64
		room.OwnerUserID = &v
	}
	room.LastAccessedAt = parseTimeOrZero(lastAccess)
	room.CreatedAt = parseTimeOrZero(createdAt)
	room.UpdatedAt = parseTimeOrZero(updatedAt)
	return &room, nil
}

// parseTimeOrZero 复刻 TypeORM 的 datetime 水合：`new Date(str + 'Z')`。
//
// 解析失败返回零值而不是报错——时间列只影响展示，读不出来不该让
// 整个房间列表挂掉（TypeORM 那边会得到 Invalid Date，同样不致命）。
func parseTimeOrZero(v sql.NullString) time.Time {
	if !v.Valid {
		return time.Time{}
	}
	if t, ok := parseSQLiteTime(v.String); ok {
		return t
	}
	return time.Time{}
}

// Exists 判断房间是否存在。
func (r *Rooms) Exists(ctx context.Context, roomID string) (bool, error) {
	var one int
	err := r.conn.QueryRowContext(ctx,
		`SELECT 1 FROM "room" WHERE "roomId" = ? LIMIT 1`, roomID).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("查询房间失败: %w", err)
	}
	return true, nil
}

// HasActiveSession 判断某身份在该房间是否有未结束的会话。
//
// 这是「房间准入」的唯一依据：REST 与媒体请求都继承这个判定。
// 游客（userID=0）必须按 guestId 匹配——只看 userId 会让所有游客互相
// 冒用同一间房的准入。
func (r *Rooms) HasActiveSession(ctx context.Context, roomID string, userID int64, guestID string) (bool, error) {
	var one int
	var err error
	if userID > 0 {
		err = r.conn.QueryRowContext(ctx, `
			SELECT 1 FROM "session"
			WHERE "roomId" = ? AND "userId" = ? AND "endedAt" IS NULL
			LIMIT 1
		`, roomID, userID).Scan(&one)
	} else {
		err = r.conn.QueryRowContext(ctx, `
			SELECT 1 FROM "session"
			WHERE "roomId" = ? AND "userId" = 0 AND "guestId" = ? AND "endedAt" IS NULL
			LIMIT 1
		`, roomID, guestID).Scan(&one)
	}
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("查询房间会话失败: %w", err)
	}
	return true, nil
}
