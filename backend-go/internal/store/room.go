package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

// ErrRoomNotFound 表示房间不存在。
var ErrRoomNotFound = errors.New("房间不存在")

// Room 对应 "room" 表（仅迁移期需要的列）。
type Room struct {
	RoomID      string
	Name        *string
	Status      string
	OwnerUserID *int64
}

// Rooms 提供房间表读取。
type Rooms struct {
	conn *sql.DB
}

// NewRooms 构造房间仓库。
func NewRooms(conn *sql.DB) *Rooms { return &Rooms{conn: conn} }

// FindByRoomID 读取房间。
func (r *Rooms) FindByRoomID(ctx context.Context, roomID string) (*Room, error) {
	var (
		room   Room
		name   sql.NullString
		owner  sql.NullInt64
		status sql.NullString
	)
	err := r.conn.QueryRowContext(ctx,
		`SELECT "roomId", "name", "status", "ownerUserId" FROM "room" WHERE "roomId" = ? LIMIT 1`,
		roomID).Scan(&room.RoomID, &name, &status, &owner)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrRoomNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("读取房间失败: %w", err)
	}
	room.Name = nullString(name)
	room.Status = status.String
	if owner.Valid {
		v := owner.Int64
		room.OwnerUserID = &v
	}
	return &room, nil
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
