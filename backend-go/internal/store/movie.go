package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

// Movies 提供影片表的最小读取能力（仅解析链需要的部分）。
type Movies struct {
	conn *sql.DB
}

// NewMovies 构造影片仓库。
func NewMovies(conn *sql.DB) *Movies { return &Movies{conn: conn} }

// ErrMovieNotFound 表示影片不存在。
var ErrMovieNotFound = errors.New("影片不存在")

// RoomOwnerUserID 返回影片所属房间的房主用户 ID。
//
// 用途：观众端解析时用「房主」的 B站 Cookie 而非观众自己的。
// 房主是大会员时，会员专享集拿到的是完整内容；用观众身份只会拿到 3 分钟试看。
func (m *Movies) RoomOwnerUserID(ctx context.Context, movieID int64) (int64, error) {
	var ownerID sql.NullInt64
	err := m.conn.QueryRowContext(ctx, `
		SELECT r."ownerUserId"
		FROM "movie" mv
		JOIN "room" r ON r."roomId" = mv."roomId"
		WHERE mv."id" = ?
		LIMIT 1
	`, movieID).Scan(&ownerID)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, ErrMovieNotFound
	}
	if err != nil {
		return 0, fmt.Errorf("查询影片房主失败: %w", err)
	}
	if !ownerID.Valid {
		return 0, ErrMovieNotFound
	}
	return ownerID.Int64, nil
}
