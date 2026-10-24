package store

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// ErrTrackNotFound 表示弹幕轨道不存在。
var ErrTrackNotFound = errors.New("弹幕轨道不存在")

// DanmakuTrack 对应 "danmaku_track" 表。
//
// Source 是 JSON 序列化后的字符串（前端传什么存什么），Items 是弹幕数组的
// JSON 文本。两者都按原样透传，Go 侧不解析——否则前端加一个字段就要改后端。
type DanmakuTrack struct {
	ID        int64
	TrackID   string
	RoomID    string
	Label     string
	Source    string
	Items     string
	Offset    float64
	Hidden    bool
	CreatedAt time.Time
	UpdatedAt time.Time
}

// Tracks 提供弹幕轨道表读写。
type Tracks struct {
	conn *sql.DB
}

// NewTracks 构造弹幕轨道仓库。
func NewTracks(conn *sql.DB) *Tracks { return &Tracks{conn: conn} }

const trackColumns = `"id", "trackId", "roomId", "label", "source", "items",
	"offset", "hidden", "createdAt", "updatedAt"`

// ListByRoom 按插入顺序返回房间内所有弹幕轨道。
//
// rooms.ts 的 find({ where: { roomId } }) 没有 order，sqlite 会按 rowid 输出；
// 显式写 ORDER BY id 让两端顺序一致（前端靠这个顺序决定轨道初始排列）。
func (t *Tracks) ListByRoom(ctx context.Context, roomID string) ([]*DanmakuTrack, error) {
	rows, err := t.conn.QueryContext(ctx,
		`SELECT `+trackColumns+` FROM "danmaku_track" WHERE "roomId" = ? ORDER BY "id" ASC`,
		roomID)
	if err != nil {
		return nil, fmt.Errorf("查询弹幕轨道失败: %w", err)
	}
	defer rows.Close()

	var list []*DanmakuTrack
	for rows.Next() {
		track, err := scanTrack(rows)
		if err != nil {
			return nil, fmt.Errorf("读取弹幕轨道失败: %w", err)
		}
		list = append(list, track)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("遍历弹幕轨道失败: %w", err)
	}
	return list, nil
}

// Find 按 (roomId, trackId) 查找单条轨道。
func (t *Tracks) Find(ctx context.Context, roomID, trackID string) (*DanmakuTrack, error) {
	row := t.conn.QueryRowContext(ctx,
		`SELECT `+trackColumns+` FROM "danmaku_track"
		 WHERE "roomId" = ? AND "trackId" = ? ORDER BY "id" ASC LIMIT 1`,
		roomID, trackID)
	track, err := scanTrack(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrTrackNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("读取弹幕轨道失败: %w", err)
	}
	return track, nil
}

// TrackUpsert 是「按 (roomId, trackId) 覆盖」的入参。
type TrackUpsert struct {
	TrackID string
	RoomID  string
	Label   string
	Source  string
	Items   string
	Offset  float64
	Hidden  bool
}

// Upsert 按 (roomId, trackId) 覆盖写入，返回落库后的轨道。
//
// 前端 setDefaultTrack 之类的场景会重复调用同一 trackId，若做成纯插入
// 会让同一轨道累积多条记录（历史版本已经踩过），所以这里必须覆盖。
func (t *Tracks) Upsert(ctx context.Context, in TrackUpsert) (*DanmakuTrack, error) {
	existing, err := t.Find(ctx, in.RoomID, in.TrackID)
	switch {
	case err == nil:
		_, err = t.conn.ExecContext(ctx, `
			UPDATE "danmaku_track"
			SET "label" = ?, "source" = ?, "items" = ?, "offset" = ?, "hidden" = ?,
			    "updatedAt" = datetime('now')
			WHERE "id" = ?
		`, in.Label, in.Source, in.Items, in.Offset, in.Hidden, existing.ID)
		if err != nil {
			return nil, fmt.Errorf("更新弹幕轨道失败: %w", err)
		}
		existing.Label = in.Label
		existing.Source = in.Source
		existing.Items = in.Items
		existing.Offset = in.Offset
		existing.Hidden = in.Hidden
		return existing, nil
	case errors.Is(err, ErrTrackNotFound):
		res, err := t.conn.ExecContext(ctx, `
			INSERT INTO "danmaku_track"
				("trackId", "roomId", "label", "source", "items", "offset", "hidden")
			VALUES (?, ?, ?, ?, ?, ?, ?)
		`, in.TrackID, in.RoomID, in.Label, in.Source, in.Items, in.Offset, in.Hidden)
		if err != nil {
			return nil, fmt.Errorf("新增弹幕轨道失败: %w", err)
		}
		id, _ := res.LastInsertId()
		return &DanmakuTrack{
			ID:      id,
			TrackID: in.TrackID,
			RoomID:  in.RoomID,
			Label:   in.Label,
			Source:  in.Source,
			Items:   in.Items,
			Offset:  in.Offset,
			Hidden:  in.Hidden,
		}, nil
	default:
		return nil, err
	}
}

// UpdateTrack 局部更新偏移与隐藏状态（nil 表示该字段不动）。
func (t *Tracks) UpdateTrack(ctx context.Context, roomID, trackID string, offset *float64, hidden *bool) (*DanmakuTrack, error) {
	track, err := t.Find(ctx, roomID, trackID)
	if err != nil {
		return nil, err
	}
	if offset != nil {
		track.Offset = *offset
	}
	if hidden != nil {
		track.Hidden = *hidden
	}
	_, err = t.conn.ExecContext(ctx, `
		UPDATE "danmaku_track"
		SET "offset" = ?, "hidden" = ?, "updatedAt" = datetime('now')
		WHERE "id" = ?
	`, track.Offset, track.Hidden, track.ID)
	if err != nil {
		return nil, fmt.Errorf("更新弹幕轨道失败: %w", err)
	}
	return track, nil
}

// Delete 删除单个轨道。
//
// Node 侧用 delete({ roomId, trackId })，会一次清掉所有同 trackId 的历史重复行；
// 这里照抄（WHERE 不带 id），否则历史脏数据会残留。
func (t *Tracks) Delete(ctx context.Context, roomID, trackID string) error {
	_, err := t.conn.ExecContext(ctx,
		`DELETE FROM "danmaku_track" WHERE "roomId" = ? AND "trackId" = ?`,
		roomID, trackID)
	if err != nil {
		return fmt.Errorf("删除弹幕轨道失败: %w", err)
	}
	return nil
}

// ReplaceAll 在一个事务里清空房间轨道并写入新列表。
func (t *Tracks) ReplaceAll(ctx context.Context, roomID string, list []TrackUpsert) ([]*DanmakuTrack, error) {
	tx, err := t.conn.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("开启事务失败: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.ExecContext(ctx,
		`DELETE FROM "danmaku_track" WHERE "roomId" = ?`, roomID); err != nil {
		return nil, fmt.Errorf("清空弹幕轨道失败: %w", err)
	}
	for _, in := range list {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO "danmaku_track"
				("trackId", "roomId", "label", "source", "items", "offset", "hidden")
			VALUES (?, ?, ?, ?, ?, ?, ?)
		`, in.TrackID, roomID, in.Label, in.Source, in.Items, in.Offset, in.Hidden); err != nil {
			return nil, fmt.Errorf("写入弹幕轨道失败: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("提交弹幕轨道事务失败: %w", err)
	}
	return t.ListByRoom(ctx, roomID)
}

func scanTrack(row rowScanner) (*DanmakuTrack, error) {
	var (
		track     DanmakuTrack
		source    sql.NullString
		items     sql.NullString
		offset    sql.NullFloat64
		hidden    sql.NullInt64
		createdAt sql.NullString
		updatedAt sql.NullString
	)
	if err := row.Scan(
		&track.ID, &track.TrackID, &track.RoomID, &track.Label, &source, &items,
		&offset, &hidden, &createdAt, &updatedAt,
	); err != nil {
		return nil, err
	}
	track.Source = source.String
	track.Items = items.String
	track.Offset = offset.Float64
	track.Hidden = hidden.Int64 != 0
	track.CreatedAt = parseTimeOrZero(createdAt)
	track.UpdatedAt = parseTimeOrZero(updatedAt)
	return &track, nil
}

// ==================== 弹幕辅助数据 ====================

// DanmakuMeta 对应 "room_danmaku_meta" 表（每房间一条）。
type DanmakuMeta struct {
	ID            int64
	RoomID        string
	BlockKeywords string
	DeletedLog    string
	RealtimeLog   string
}

// Metas 提供房间弹幕辅助数据读写。
type Metas struct {
	conn *sql.DB
}

// NewMetas 构造弹幕辅助数据仓库。
func NewMetas(conn *sql.DB) *Metas { return &Metas{conn: conn} }

// GetOrCreate 读取房间弹幕辅助数据，不存在则建一条空记录。
//
// REST 的 GET 与 PUT 都会走到这里，如果不建记录，前端第一次打开房间
// 拿到的就是 404 语义，管理面板没法初始化。
func (m *Metas) GetOrCreate(ctx context.Context, roomID string) (*DanmakuMeta, error) {
	var meta DanmakuMeta
	err := m.conn.QueryRowContext(ctx, `
		SELECT "id", "roomId", "blockKeywords", "deletedLog", "realtimeLog"
		FROM "room_danmaku_meta" WHERE "roomId" = ? ORDER BY "id" ASC LIMIT 1
	`, roomID).Scan(&meta.ID, &meta.RoomID, &meta.BlockKeywords, &meta.DeletedLog, &meta.RealtimeLog)
	if err == nil {
		return &meta, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("读取弹幕辅助数据失败: %w", err)
	}

	res, err := m.conn.ExecContext(ctx, `
		INSERT INTO "room_danmaku_meta" ("roomId", "blockKeywords", "deletedLog", "realtimeLog")
		VALUES (?, '[]', '[]', '[]')
	`, roomID)
	if err != nil {
		return nil, fmt.Errorf("创建弹幕辅助数据失败: %w", err)
	}
	id, _ := res.LastInsertId()
	return &DanmakuMeta{
		ID:            id,
		RoomID:        roomID,
		BlockKeywords: "[]",
		DeletedLog:    "[]",
		RealtimeLog:   "[]",
	}, nil
}

// ReplaceBlockAndDeleted 整体替换屏蔽词与已删除记录。
// RealtimeLog 不动：它由 send-danmaku 事件单独维护。
func (m *Metas) ReplaceBlockAndDeleted(ctx context.Context, roomID, blockKeywords, deletedLog string) (*DanmakuMeta, error) {
	meta, err := m.GetOrCreate(ctx, roomID)
	if err != nil {
		return nil, err
	}
	_, err = m.conn.ExecContext(ctx, `
		UPDATE "room_danmaku_meta"
		SET "blockKeywords" = ?, "deletedLog" = ?, "updatedAt" = datetime('now')
		WHERE "id" = ?
	`, blockKeywords, deletedLog, meta.ID)
	if err != nil {
		return nil, fmt.Errorf("更新弹幕辅助数据失败: %w", err)
	}
	meta.BlockKeywords = blockKeywords
	meta.DeletedLog = deletedLog
	return meta, nil
}

// JSONArrayText 复刻 `JSON.stringify(arr)` 的最小形态。
//
// 只为写库时保持与 Node 一致的文本（紧凑、无空格）。传入内容必须已经是
// 合法 JSON，否则回落到 fallback，不在这里做「修复」。
func JSONArrayText(raw json.RawMessage, fallback string) string {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return fallback
	}
	var buf bytes.Buffer
	if err := json.Compact(&buf, []byte(trimmed)); err != nil {
		return fallback
	}
	return buf.String()
}
