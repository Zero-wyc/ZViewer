package store

import (
	"context"
	"database/sql"
	"fmt"
	"time"
)

// Comment 对应 "comment" 表。
//
// Node 侧实体没有 userId 列（commentService.createComment 收了 userId 但显式
// `void userId` 丢弃），用户名是冗余存的。别在这里加 userId：库结构由 Node
// 迁移创建，多一个列就是启动即失败。
type Comment struct {
	ID        int64
	RoomID    string
	Username  string
	Content   string
	IsDanmaku bool
	CreatedAt time.Time
}

// Comments 提供评论表读写。
type Comments struct {
	conn *sql.DB
}

// NewComments 构造评论仓库。
func NewComments(conn *sql.DB) *Comments { return &Comments{conn: conn} }

// Create 插入一条评论并回读 id。
//
// createdAt 显式写成毫秒精度：列默认值是 `datetime('now')`（秒级），
// 而 Node 的 CreateDateColumn 是按 JS Date 写入的毫秒值。不显式写会让
// 同一秒内的评论拿到相同时间，前端按时间排序时顺序随机。
func (c *Comments) Create(ctx context.Context, roomID, username, content string, isDanmaku bool) (*Comment, error) {
	now := time.Now()
	flag := 0
	if isDanmaku {
		flag = 1
	}
	res, err := c.conn.ExecContext(ctx, `
		INSERT INTO "comment" ("roomId", "username", "content", "isDanmaku", "createdAt")
		VALUES (?, ?, ?, ?, ?)
	`, roomID, username, content, flag, FormatSQLiteTime(now))
	if err != nil {
		return nil, fmt.Errorf("写入评论失败: %w", err)
	}
	id, _ := res.LastInsertId()
	return &Comment{
		ID:        id,
		RoomID:    roomID,
		Username:  username,
		Content:   content,
		IsDanmaku: isDanmaku,
		CreatedAt: now,
	}, nil
}

// ListByRoom 按创建时间升序读取房间的全部评论。
//
// Node 是 `find({ where: { roomId }, order: { createdAt: 'ASC' } })`，
// 同毫秒的多条按插入顺序（SQLite 扫描序）返回，所以这里补 "id" ASC 做兜底，
// 否则同样的数据两次查询可能给出不同顺序，前端历史列表会跳。
func (c *Comments) ListByRoom(ctx context.Context, roomID string) ([]*Comment, error) {
	rows, err := c.conn.QueryContext(ctx, `
		SELECT "id", "roomId", "username", "content", "isDanmaku", "createdAt"
		FROM "comment" WHERE "roomId" = ?
		ORDER BY "createdAt" ASC, "id" ASC
	`, roomID)
	if err != nil {
		return nil, fmt.Errorf("读取评论历史失败: %w", err)
	}
	defer rows.Close()

	out := make([]*Comment, 0, 16)
	for rows.Next() {
		var (
			item      Comment
			isDanmaku int64
			createdAt sql.NullString
		)
		if err := rows.Scan(&item.ID, &item.RoomID, &item.Username, &item.Content,
			&isDanmaku, &createdAt); err != nil {
			return nil, fmt.Errorf("解析评论行失败: %w", err)
		}
		item.IsDanmaku = isDanmaku != 0
		item.CreatedAt = parseTimeOrZero(createdAt)
		out = append(out, &item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("读取评论历史失败: %w", err)
	}
	return out, nil
}
