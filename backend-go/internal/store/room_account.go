package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

// RoomAccount 是「房间共享账号」绑定：一间房在一个平台上只认一个账号。
type RoomAccount struct {
	Provider  string
	RoomID    string
	UserID    int64
	UpdatedAt string
}

// RoomAccounts 读写 "room_account" 表。
type RoomAccounts struct {
	conn *sql.DB
}

// NewRoomAccounts 构造房间共享账号仓库。
func NewRoomAccounts(conn *sql.DB) *RoomAccounts { return &RoomAccounts{conn: conn} }

// SetRoomAccount 写入/覆盖房间绑定（后登录者成为新的共享账号）。
func (r *RoomAccounts) SetRoomAccount(ctx context.Context, provider, roomID string, userID int64) error {
	_, err := r.conn.ExecContext(ctx, `
		INSERT INTO "room_account" ("provider", "roomId", "userId", "updatedAt")
		VALUES (?, ?, ?, datetime('now'))
		ON CONFLICT("provider", "roomId") DO UPDATE SET
			"userId" = excluded."userId",
			"updatedAt" = datetime('now')
	`, provider, roomID, userID)
	if err != nil {
		return fmt.Errorf("绑定房间共享账号失败: %w", err)
	}
	return nil
}

// GetRoomAccount 读取房间绑定；没有绑定时返回 (0, false, nil)。
func (r *RoomAccounts) GetRoomAccount(ctx context.Context, provider, roomID string) (int64, bool, error) {
	var userID int64
	err := r.conn.QueryRowContext(ctx, `
		SELECT "userId" FROM "room_account" WHERE "provider" = ? AND "roomId" = ? LIMIT 1
	`, provider, roomID).Scan(&userID)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, fmt.Errorf("读取房间共享账号失败: %w", err)
	}
	return userID, true, nil
}

// ClearRoomAccount 解除房间绑定（没有绑定也算成功）。
func (r *RoomAccounts) ClearRoomAccount(ctx context.Context, provider, roomID string) error {
	if _, err := r.conn.ExecContext(ctx, `
		DELETE FROM "room_account" WHERE "provider" = ? AND "roomId" = ?
	`, provider, roomID); err != nil {
		return fmt.Errorf("解除房间共享账号失败: %w", err)
	}
	return nil
}
