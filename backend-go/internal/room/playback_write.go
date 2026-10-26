package room

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"zviewer/backend/internal/store"
)

// 落盘节流的两个窗口。
//
// state 事件是房主侧 500ms 级别的高频推送，心跳是 2s 一次；两者都不该
// 每次都写库。内存永远是最新的，DB 只负责持久化与重启恢复，所以节流
// 窗口按「多久之后基线算陈旧」来定：
const (
	// dbWriteThrottleMS 是 state 写入的落盘间隔（对应 Node 的 DB_WRITE_THROTTLE_MS）。
	dbWriteThrottleMS = 2000
	// heartbeatPersistThrottleMS 是心跳落盘间隔（对应 HEARTBEAT_PERSIST_THROTTLE_MS）。
	// 心跳每 2s 一次，10s 节流保证外推基线足够新鲜。
	heartbeatPersistThrottleMS = 10000
)

// SetPlayback 写入房主的完整播放状态（内存 + 按节流落盘）。
//
// currentMovieID 由调用方从运行时状态取（播放记忆层不关心影片列表从哪来）。
// clientTs 为客户端发出时刻（毫秒），提供时补偿传输延迟；调用侧已做过
// 显式补偿（watch-together-control）时不要再传，否则会二次补偿。
func (m *PlaybackMemory) SetPlayback(
	ctx context.Context,
	roomID string,
	state Playback,
	hostSocketID string,
	clientTs int64,
	currentMovieID *int64,
) error {
	now := nowMillis()

	next := state
	next.CurrentTime = CompensateTransportDelay(TransportDelayParams{
		CurrentTime:  state.CurrentTime,
		ClientTs:     clientTs,
		PlaybackRate: state.PlaybackRate,
		IsPlaying:    state.IsPlaying,
		Now:          now,
	})
	next.CurrentMovieID = currentMovieID
	next.UpdatedAt = now
	if hostSocketID != "" {
		sid := hostSocketID
		next.HostSocketID = &sid
	}

	m.mu.Lock()
	c := m.cache[roomID]
	if c == nil {
		c = &cachedPlayback{}
		m.cache[roomID] = c
	}
	// 保留 hostSocketId：整体覆盖 state 会丢掉 updateHostSocket 写入的值，
	// 后果是 isHostOnline 在房主明明在线时返回 false，服务器心跳便与房主的
	// state 广播同时往外发，观众端进度来回跳。
	if next.HostSocketID == nil && c.state != nil {
		next.HostSocketID = c.state.HostSocketID
	}
	c.state = &next
	c.revision++
	c.dirty = true
	lastWrite := c.lastDBWriteAt
	m.mu.Unlock()

	if now-lastWrite > dbWriteThrottleMS {
		return m.flushToDB(ctx, roomID)
	}
	return nil
}

// HostHeartbeat 是房主心跳携带的轻量进度。
type HostHeartbeat struct {
	CurrentTime  float64
	IsPlaying    bool
	PlaybackRate float64
}

// ApplyHostHeartbeat 把心跳合并进播放记忆（只改进度字段，不覆盖源信息）。
//
// 房主在线期间除了离散的 state/control 事件之外没有持久化更新，外推基线
// 会逐渐偏离真实进度；心跳携带真实 currentTime，按 10s 节流合并后基线
// 保持新鲜，房主断线时的服务器外推不会超前太多。
//
// **没有缓存时直接返回，不创建**：心跳缺 sourceUrl / sourceType 等字段，
// 单独一条心跳拼不出完整播放状态，凭空建一条会让观众加入时拿到
// 「有状态但源为空」的记录。
func (m *PlaybackMemory) ApplyHostHeartbeat(
	ctx context.Context,
	roomID string,
	hb HostHeartbeat,
	clientTs int64,
) error {
	now := nowMillis()

	m.mu.Lock()
	c := m.cache[roomID]
	if c == nil || c.state == nil {
		m.mu.Unlock()
		return nil
	}
	c.state.CurrentTime = CompensateTransportDelay(TransportDelayParams{
		CurrentTime:  hb.CurrentTime,
		ClientTs:     clientTs,
		PlaybackRate: hb.PlaybackRate,
		IsPlaying:    hb.IsPlaying,
		Now:          now,
	})
	c.state.IsPlaying = hb.IsPlaying
	if hb.PlaybackRate > 0 {
		c.state.PlaybackRate = hb.PlaybackRate
	}
	c.state.UpdatedAt = now
	c.revision++
	shouldFlush := now-c.lastDBWriteAt > heartbeatPersistThrottleMS
	if shouldFlush {
		c.dirty = true
	}
	m.mu.Unlock()

	if shouldFlush {
		return m.flushToDB(ctx, roomID)
	}
	return nil
}

// Raw 返回未推算的原始状态（房主重连恢复 "最后已知进度" 时用）。
func (m *PlaybackMemory) Raw(ctx context.Context, roomID string) (*Playback, error) {
	return m.load(ctx, roomID)
}

// FlushToDB 把指定房间的脏数据写入 DB。
func (m *PlaybackMemory) FlushToDB(ctx context.Context, roomID string) error {
	return m.flushToDB(ctx, roomID)
}

// flushToDB 把内存状态整行 upsert 到 playback_states。
//
// 整行覆盖是有意的（与 Node 的 `repo.upsert(entity, ['roomId'])` 一致）：
// 这里写的一定是完整快照，按列合并反而可能留下上一部影片的残留字段
// （比如换了影片但 audioUrl 没清）。
func (m *PlaybackMemory) flushToDB(ctx context.Context, roomID string) error {
	m.persistMu.Lock()
	defer m.persistMu.Unlock()
	m.mu.Lock()
	c := m.cache[roomID]
	if c == nil || c.state == nil || !c.dirty {
		m.mu.Unlock()
		return nil
	}
	state := c.state.clone()
	revision := c.revision
	m.mu.Unlock()

	metadata, err := json.Marshal(state.PlaybackMetadata)
	if err != nil {
		return fmt.Errorf("编码播放元数据失败: %w", err)
	}
	now := store.FormatSQLiteTime(time.Now())
	_, err = m.conn.ExecContext(ctx, `
		INSERT INTO "playback_states" (
			"roomId", "sourceUrl", "sourceType", "audioUrl", "format",
			"videoCodec", "audioCodec", "cid", "isPlaying", "currentTime",
			"playbackRate", "duration", "currentQn", "acceptQuality", "headers",
			"noProxyFallback", "isPreview", "previewTitle", "bufferMode",
			"currentMovieId", "lastUpdatedAt", "hostSocketId", "updatedAt", "metadata"
		) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
		ON CONFLICT("roomId") DO UPDATE SET
			"sourceUrl" = excluded."sourceUrl",
			"sourceType" = excluded."sourceType",
			"audioUrl" = excluded."audioUrl",
			"format" = excluded."format",
			"videoCodec" = excluded."videoCodec",
			"audioCodec" = excluded."audioCodec",
			"cid" = excluded."cid",
			"isPlaying" = excluded."isPlaying",
			"currentTime" = excluded."currentTime",
			"playbackRate" = excluded."playbackRate",
			"duration" = excluded."duration",
			"currentQn" = excluded."currentQn",
			"acceptQuality" = excluded."acceptQuality",
			"headers" = excluded."headers",
			"noProxyFallback" = excluded."noProxyFallback",
			"isPreview" = excluded."isPreview",
			"previewTitle" = excluded."previewTitle",
			"bufferMode" = excluded."bufferMode",
			"currentMovieId" = excluded."currentMovieId",
			"lastUpdatedAt" = excluded."lastUpdatedAt",
			"hostSocketId" = excluded."hostSocketId",
			"updatedAt" = excluded."updatedAt",
 "metadata" = excluded."metadata"
	`,
		roomID, state.SourceURL, state.SourceType, nullableStr(state.AudioURL),
		nullableStr(state.Format), nullableStr(state.VideoCodec), nullableStr(state.AudioCodec),
		nullIntVal(state.Cid), boolToInt(state.IsPlaying), state.CurrentTime,
		state.PlaybackRate, state.Duration, nullIntVal(state.CurrentQn),
		nullRawJSON(state.AcceptQuality), nullRawJSON(state.Headers),
		nullBoolVal(state.NoProxyFallback), boolToInt(state.IsPreview),
		nullableStr(state.PreviewTitle),
		// bufferMode 是 NOT NULL 列（noProxyFallback 可空），缺失要落 0 而不是 NULL。
		boolToInt(derefBool(state.BufferMode)),
		nullIntVal(state.CurrentMovieID), state.UpdatedAt,
		nullableStr(state.HostSocketID), now, string(metadata),
	)
	if err != nil {
		return fmt.Errorf("写入播放状态失败: %w", err)
	}

	m.mu.Lock()
	// 落盘期间可能又有新写入，只在「仍是我们刚写的那份」时清脏标记。
	if cur := m.cache[roomID]; cur == c && cur.revision == revision {
		cur.dirty = false
		cur.lastDBWriteAt = nowMillis()
	}
	m.mu.Unlock()
	return nil
}

func boolToInt(v bool) int {
	if v {
		return 1
	}
	return 0
}

func nullIntVal(v *int64) any {
	if v == nil {
		return nil
	}
	return *v
}

func nullBoolVal(v *bool) any {
	if v == nil {
		return nil
	}
	return boolToInt(*v)
}

// derefBool 把可选布尔取成值（缺失按 false），用于 NOT NULL 列。
func derefBool(v *bool) bool {
	return v != nil && *v
}

func nullRawJSON(v []byte) any {
	if len(v) == 0 {
		return nil
	}
	return string(v)
}
