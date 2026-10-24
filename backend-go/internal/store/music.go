package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

// 一起听（listen-together）的两张表。
//
// 与 Node 版共用同一份库，所以这里**只写 SQL、不建表**：表结构由 TypeORM
// 的 synchronize 定义（`music_queue_item` / `music_playback_states`），
// Go 侧只负责读写。表缺失时启动阶段的 VerifySchema 会直接拦下。

// ErrMusicStateNotFound 表示房间没有音乐播放基线。
var ErrMusicStateNotFound = errors.New("房间无音乐播放状态")

// MusicQueueItem 对应 "music_queue_item" 表：房间播放队列的一行。
//
// source / sourceId 是历史字段：塞壬支持已移除后 source 恒为 'ncm'，
// 唯一例外是 B站 本地插播条目（source='bili'，sourceId='<bvid>:<cid>'）。
// 保留这两列是为了兼容存量数据，别按「已废弃」把它们删掉——
// B站 条目的重解析与 afterCurrent 定位都靠 sourceId 匹配。
type MusicQueueItem struct {
	ID       int64
	RoomID   string
	Source   string
	SongID   int64
	SourceID *string
	Name     string
	Artist   string
	Album    string
	Cover    *string
	// DurationMs 是歌曲时长（毫秒）；<=0 表示未知（外推时不做截断）。
	DurationMs int64
	VIP        bool
	// Order 是队列内序号（小在前）。删除/重排后由业务层压实为 1..n 连续；
	// SQLite 里 order 是关键字，所有语句都必须写成 "order"。
	Order int64
	// AddedBy 是添加者用户 ID（游客为 0）。广播时解析成用户名。
	AddedBy int64
	// Recommended 表示 B站 相关推荐自动加入的条目（前端显示「推荐」tag）。
	Recommended bool
}

// MusicQueue 提供 music_queue_item 表读写。
type MusicQueue struct {
	conn *sql.DB
}

// NewMusicQueue 构造队列仓库。
func NewMusicQueue(conn *sql.DB) *MusicQueue { return &MusicQueue{conn: conn} }

const musicQueueColumns = `"id", "roomId", "source", "songId", "sourceId",
	"name", "artist", "album", "cover", "durationMs", "vip",
	"order", "addedBy", "recommended"`

// ListByRoom 读取房间队列（按 order 升序）。
//
// 排序不是非空 order 的兜底：连续插入时若出现 order 平局，SQLite 的返回
// 顺序退化成 rowid 随机序，表现为「点下一首跳到任意一首」。业务层已经
// 保证不产生平局，这里只做单纯的 ORDER BY。
func (q *MusicQueue) ListByRoom(ctx context.Context, roomID string) ([]*MusicQueueItem, error) {
	rows, err := q.conn.QueryContext(ctx, `
		SELECT `+musicQueueColumns+` FROM "music_queue_item"
		WHERE "roomId" = ?
		ORDER BY "order" ASC`, roomID)
	if err != nil {
		return nil, fmt.Errorf("读取播放队列失败: %w", err)
	}
	defer rows.Close()

	out := make([]*MusicQueueItem, 0, 16)
	for rows.Next() {
		item, err := scanMusicQueueItem(rows)
		if err != nil {
			return nil, fmt.Errorf("读取播放队列失败: %w", err)
		}
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("读取播放队列失败: %w", err)
	}
	return out, nil
}

// DeleteStale 删除已失去音源的历史条目（songId<=0 且非 B站）。
//
// 对应 Node 的 loadQueue：每次读队列顺手清一次。这个「读时清理」不是懒：
// 塞壬下线后这些行永远播不了，留着只会让前端列表出现点不动的条目。
func (q *MusicQueue) DeleteStale(ctx context.Context, ids []int64) error {
	if len(ids) == 0 {
		return nil
	}
	placeholders := make([]string, len(ids))
	args := make([]any, len(ids))
	for i, id := range ids {
		placeholders[i] = "?"
		args[i] = id
	}
	_, err := q.conn.ExecContext(ctx,
		`DELETE FROM "music_queue_item" WHERE "id" IN (`+strings.Join(placeholders, ",")+`)`, args...)
	if err != nil {
		return fmt.Errorf("清理失效队列条目失败: %w", err)
	}
	return nil
}

// Insert 追加一条队列条目并回填 ID。
func (q *MusicQueue) Insert(ctx context.Context, item *MusicQueueItem) (int64, error) {
	res, err := q.conn.ExecContext(ctx, `
		INSERT INTO "music_queue_item" (
			"roomId", "source", "songId", "sourceId", "name", "artist", "album",
			"cover", "durationMs", "vip", "order", "addedBy", "recommended"
		) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		item.RoomID, item.Source, item.SongID, nullableStringPtr(item.SourceID),
		item.Name, item.Artist, item.Album, nullableStringPtr(item.Cover),
		item.DurationMs, boolInt(item.VIP), item.Order, item.AddedBy,
		boolInt(item.Recommended),
	)
	if err != nil {
		return 0, fmt.Errorf("添加队列条目失败: %w", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		return 0, nil
	}
	item.ID = id
	return id, nil
}

// Delete 删除房间里的一条队列条目（同时限定 roomId，防跨房间删除）。
//
// 返回受影响行数：0 表示条目不存在或属于别的房间，调用方据此回
// 「歌曲不在队列中」。Node 侧用的是 `repo.delete({id, roomId})`。
func (q *MusicQueue) Delete(ctx context.Context, roomID string, id int64) (int64, error) {
	res, err := q.conn.ExecContext(ctx,
		`DELETE FROM "music_queue_item" WHERE "id" = ? AND "roomId" = ?`, id, roomID)
	if err != nil {
		return 0, fmt.Errorf("删除队列条目失败: %w", err)
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return 0, nil
	}
	return affected, nil
}

// DeleteByRoom 清空房间队列。
func (q *MusicQueue) DeleteByRoom(ctx context.Context, roomID string) error {
	_, err := q.conn.ExecContext(ctx,
		`DELETE FROM "music_queue_item" WHERE "roomId" = ?`, roomID)
	if err != nil {
		return fmt.Errorf("清空播放队列失败: %w", err)
	}
	return nil
}

// SetOrders 批量重排 order。
//
// 逐行 UPDATE（而不是一条 CASE WHEN）：队列规模是十几条量级，逐行语句
// 更好读，出问题时也能从 SQL 直接看出「哪一条被写成了几号」。
func (q *MusicQueue) SetOrders(ctx context.Context, pairs []MusicOrderPair) error {
	if len(pairs) == 0 {
		return nil
	}
	for _, p := range pairs {
		if _, err := q.conn.ExecContext(ctx,
			`UPDATE "music_queue_item" SET "order" = ? WHERE "id" = ?`, p.Order, p.ID); err != nil {
			return fmt.Errorf("重排播放队列失败: %w", err)
		}
	}
	return nil
}

// MusicOrderPair 是「条目 ID → 新序号」。
type MusicOrderPair struct {
	ID    int64
	Order int64
}

// FindBySongID 按网易云 songId 找房间内条目（解析歌曲时长用）。
func (q *MusicQueue) FindBySongID(ctx context.Context, roomID string, songID int64) (*MusicQueueItem, error) {
	if songID <= 0 {
		return nil, nil
	}
	row := q.conn.QueryRowContext(ctx, `
		SELECT `+musicQueueColumns+` FROM "music_queue_item"
		WHERE "roomId" = ? AND "songId" = ? LIMIT 1`, roomID, songID)
	item, err := scanMusicQueueItem(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("读取队列条目失败: %w", err)
	}
	return item, nil
}

// FindBySourceID 按 B站 sourceId（"bvid:cid"）找房间内条目。
func (q *MusicQueue) FindBySourceID(ctx context.Context, roomID, sourceID string) (*MusicQueueItem, error) {
	row := q.conn.QueryRowContext(ctx, `
		SELECT `+musicQueueColumns+` FROM "music_queue_item"
		WHERE "roomId" = ? AND "source" = 'bili' AND "sourceId" = ? LIMIT 1`, roomID, sourceID)
	item, err := scanMusicQueueItem(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("读取队列条目失败: %w", err)
	}
	return item, nil
}

func scanMusicQueueItem(row rowScanner) (*MusicQueueItem, error) {
	var (
		item      MusicQueueItem
		sourceID  sql.NullString
		cover     sql.NullString
		vip       int64
		recommend int64
	)
	if err := row.Scan(
		&item.ID, &item.RoomID, &item.Source, &item.SongID, &sourceID,
		&item.Name, &item.Artist, &item.Album, &cover, &item.DurationMs,
		&vip, &item.Order, &item.AddedBy, &recommend,
	); err != nil {
		return nil, err
	}
	if sourceID.Valid {
		v := sourceID.String
		item.SourceID = &v
	}
	if cover.Valid {
		v := cover.String
		item.Cover = &v
	}
	item.VIP = vip != 0
	item.Recommended = recommend != 0
	return &item, nil
}

// ===========================================================================
// 音乐播放基线
// ===========================================================================

// MusicPlaybackState 对应 "music_playback_states" 表（roomId 为主键）。
//
// lastUpdatedAt 是**服务器物化**的时间戳（Unix 毫秒）：房主上报的 updatedAt
// 一律不采信，否则客户端时钟偏差会直接变成观众的进度偏差。
type MusicPlaybackState struct {
	RoomID      string
	TrackSongID *int64
	TrackKey    *string
	IsPlaying   bool
	PositionSec float64
	PlayMode    string
	// LastUpdatedAt 是最近一次写入时刻（Unix 毫秒）。
	LastUpdatedAt int64
	// HostSocketID 是房主连接 ID；房主断开后置空，但基线仍保留。
	HostSocketID *string
}

// MusicStates 提供 music_playback_states 表读写。
type MusicStates struct {
	conn *sql.DB
}

// NewMusicStates 构造音乐播放基线仓库。
func NewMusicStates(conn *sql.DB) *MusicStates { return &MusicStates{conn: conn} }

const musicStateColumns = `"roomId", "trackSongId", "trackKey", "isPlaying",
	"positionSec", "playMode", "lastUpdatedAt", "hostSocketId"`

// Find 读取房间基线。
func (s *MusicStates) Find(ctx context.Context, roomID string) (*MusicPlaybackState, error) {
	row := s.conn.QueryRowContext(ctx,
		`SELECT `+musicStateColumns+` FROM "music_playback_states" WHERE "roomId" = ? LIMIT 1`, roomID)
	var (
		st        MusicPlaybackState
		trackSong sql.NullInt64
		trackKey  sql.NullString
		hostID    sql.NullString
	)
	err := row.Scan(&st.RoomID, &trackSong, &trackKey, &st.IsPlaying,
		&st.PositionSec, &st.PlayMode, &st.LastUpdatedAt, &hostID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrMusicStateNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("读取音乐播放状态失败: %w", err)
	}
	if trackSong.Valid {
		v := trackSong.Int64
		st.TrackSongID = &v
	}
	if trackKey.Valid {
		v := trackKey.String
		st.TrackKey = &v
	}
	if hostID.Valid {
		v := hostID.String
		st.HostSocketID = &v
	}
	return &st, nil
}

// Upsert 整行写入基线（对应 TypeORM 的 `repo.upsert(entity, ['roomId'])`）。
//
// 整行覆盖是有意的：写的永远是完整快照，按列合并反而可能留下上一首曲目的
// 残留（换歌但 trackSongId 没清）。createdAt 交给表默认值。
func (s *MusicStates) Upsert(ctx context.Context, st *MusicPlaybackState) error {
	now := FormatSQLiteTime(time.Now())
	_, err := s.conn.ExecContext(ctx, `
		INSERT INTO "music_playback_states" (
			"roomId", "trackSongId", "trackKey", "isPlaying", "positionSec",
			"playMode", "lastUpdatedAt", "hostSocketId", "updatedAt"
		) VALUES (?,?,?,?,?,?,?,?,?)
		ON CONFLICT("roomId") DO UPDATE SET
			"trackSongId" = excluded."trackSongId",
			"trackKey" = excluded."trackKey",
			"isPlaying" = excluded."isPlaying",
			"positionSec" = excluded."positionSec",
			"playMode" = excluded."playMode",
			"lastUpdatedAt" = excluded."lastUpdatedAt",
			"hostSocketId" = excluded."hostSocketId",
			"updatedAt" = excluded."updatedAt"
	`,
		st.RoomID, nullableInt64(st.TrackSongID), nullableStringPtr(st.TrackKey),
		boolInt(st.IsPlaying), st.PositionSec, st.PlayMode,
		st.LastUpdatedAt, nullableStringPtr(st.HostSocketID), now,
	)
	if err != nil {
		return fmt.Errorf("写入音乐播放状态失败: %w", err)
	}
	return nil
}

// SetHostSocket 只改房主连接列（房主重连/断开时调用）。
//
// 单列更新而不是整行 upsert：这条路径上没有完整快照可写，
// 整行写会把刚被心跳改新的 positionSec 覆盖回旧值。
func (s *MusicStates) SetHostSocket(ctx context.Context, roomID string, hostSocketID *string) error {
	_, err := s.conn.ExecContext(ctx,
		`UPDATE "music_playback_states" SET "hostSocketId" = ? WHERE "roomId" = ?`,
		nullableStringPtr(hostSocketID), roomID)
	if err != nil {
		return fmt.Errorf("更新房主连接失败: %w", err)
	}
	return nil
}

// Delete 删除房间基线（房间关闭时调用）。
func (s *MusicStates) Delete(ctx context.Context, roomID string) error {
	_, err := s.conn.ExecContext(ctx,
		`DELETE FROM "music_playback_states" WHERE "roomId" = ?`, roomID)
	if err != nil {
		return fmt.Errorf("删除音乐播放状态失败: %w", err)
	}
	return nil
}
