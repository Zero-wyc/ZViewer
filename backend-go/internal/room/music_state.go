package room

import (
	"context"
	"database/sql"
	"encoding/json"
	"log"
	"strconv"
	"strings"
	"sync"

	"zviewer/backend/internal/store"
)

// 一起听的播放基线（服务器权威），架构对齐一起看的 PlaybackMemory。
//
// 三步：
//  1. 写侧传输延迟补偿：房主上行（sync-state / host-heartbeat）带 clientTs，
//     服务器按 clamp((now-clientTs)/1000, 0, 1.5) × 1 补进 positionSec
//     （音乐恒 1x，仅播放中补偿），基线锚定服务器时间轴。
//  2. 服务器心跳：MusicBroadcaster 每 2s 取外推值广播 music:sync-heartbeat
//     (source='server')——观众进度唯一权威来源。
//  3. 观众自检：music:check-status 用 NeedsProgressSync（±10s）判定并下发纠偏。
//
// 与一起看的差异：
//   - 音乐心跳携带**完整** MusicSyncState，所以没有缓存时也能自建条目
//     （一起看的部分心跳建不出完整状态，只能丢弃）；
//   - 音乐没有倍速、没有 duration 字段——当前曲目时长按 trackKey 从
//     music_queue_item.durationMs 解析，外推到时长即凝固。

// MusicPlayMode 取值（与前端 music/types.ts 的 PlayMode 对齐）。
//
// order = 按顺序播完即停（B站 推荐连播仅此模式启用）。
const (
	MusicPlaySequence  = "sequence"
	MusicPlayOrder     = "order"
	MusicPlayRepeatOne = "repeat-one"
	MusicPlayShuffle   = "shuffle"
)

// MusicSyncState 是房间音乐同步状态快照。
//
// 字段与前端 MusicSyncState 逐字对齐，**不加 omitempty**：
// trackSongId / trackKey 为 null 时下发的是 `null`（键存在），
// 去掉键会让前端走另一条兼容分支。
type MusicSyncState struct {
	// TrackSongID 是网易云歌曲 ID（B站 曲目恒为 null，兼容旧客户端）。
	TrackSongID *int64 `json:"trackSongId"`
	// TrackKey 是当前曲目完整 key：`ncm:<songId>` / `bili:<bvid>:<cid>`。
	TrackKey *string `json:"trackKey"`
	// IsPlaying 是否正在播放。
	IsPlaying bool `json:"isPlaying"`
	// PositionSec 播放进度（秒）。
	PositionSec float64 `json:"positionSec"`
	// PlayMode 播放模式。
	PlayMode string `json:"playMode"`
	// UpdatedAt 是状态生成时刻（Unix 毫秒）。**服务端一律以服务器时钟物化**，
	// 不采信房主上报值（否则客户端时钟偏差直接变成观众的进度偏差）。
	UpdatedAt int64 `json:"updatedAt"`
}

// musicDBWriteThrottleMS 与 musicHeartbeatPersistThrottleMS 是两个落盘节流窗口。
//
// 房主操作是离散事件、心跳是 2s 一次，都不该次次写库（迁移期还与 Node
// 共用同一个 SQLite，写放大直接变成两边抢锁）。内存永远最新，DB 只负责
// 重启恢复，所以窗口按「多久之后基线算陈旧」定。
const (
	musicDBWriteThrottleMS        = 2000
	musicHeartbeatPersistThrottle = 10000
	// musicCacheStaleThresholdMS 是「房主离线且无人」后内存缓存的保留时长。
	// DB 里的基线不删——后端重启后 get-state 还能恢复续播。
	musicCacheStaleThresholdMS = 10 * 60 * 1000
)

// cachedMusic 是内存缓存条目。
type cachedMusic struct {
	state    MusicSyncState
	revision uint64
	// durationSec 是当前曲目时长（秒）；nil = 未知/不在队列，外推不截断。
	durationSec *float64
	// durationKey 是上面那个时长对应的 trackKey（避免同曲反复查队列表）。
	durationKey string
	// hostSocketID 是房主连接 ID（状态本体不含，单独存元数据）。
	hostSocketID  *string
	lastDBWriteAt int64
	dirty         bool
}

// MusicMemory 管理音乐播放基线的「内存缓存 + DB 节流落盘」。
type MusicMemory struct {
	conn   *sql.DB
	queue  *store.MusicQueue
	states *store.MusicStates
	hub    Hub
	logger *log.Logger

	mu        sync.Mutex
	cache     map[string]*cachedMusic
	persistMu sync.Mutex
}

// NewMusicMemory 构造音乐播放基线服务。
func NewMusicMemory(conn *sql.DB) *MusicMemory {
	return &MusicMemory{
		conn:   conn,
		queue:  store.NewMusicQueue(conn),
		states: store.NewMusicStates(conn),
		logger: log.Default(),
		cache:  make(map[string]*cachedMusic),
	}
}

// SetLogger 替换日志器（测试与装配用）。
func (m *MusicMemory) SetLogger(l *log.Logger) {
	if l != nil {
		m.logger = l
	}
}

// SetHub 注入实时层能力。
//
// 只在 isHostOnline 里用到：hostSocketId 非空仅代表「曾经注册过」，
// 后端重启后从 DB 恢复的是失效旧值，必须核对连接是否实际还在。
func (m *MusicMemory) SetHub(hub Hub) { m.hub = hub }

// IsHostOnline 判断房间基线记录的房主连接是否仍在线。
func (m *MusicMemory) IsHostOnline(roomID string) bool {
	m.mu.Lock()
	c := m.cache[roomID]
	var sid string
	if c != nil && c.hostSocketID != nil {
		sid = *c.hostSocketID
	}
	m.mu.Unlock()
	if sid == "" {
		return false
	}
	if m.hub == nil {
		// 没有实时层（单测/最小装配）时退化为「有记录即在线」，
		// 与 Node 未注入 io 时的行为一致。
		return true
	}
	return m.hub.Connected(sid)
}

// SetPlayback 写入房主的完整播放状态（music:sync-state 离散事件）。
//
// clientTs 是客户端发出时刻（Unix 毫秒）；0 表示没传（旧前端），不补偿。
func (m *MusicMemory) SetPlayback(ctx context.Context, roomID string, state MusicSyncState, hostSocketID string, clientTs int64) error {
	now := nowMillis()
	state.PositionSec = CompensateTransportDelay(TransportDelayParams{
		CurrentTime:  state.PositionSec,
		ClientTs:     clientTs,
		PlaybackRate: 1,
		IsPlaying:    state.IsPlaying,
		Now:          now,
	})
	state.UpdatedAt = now

	m.mu.Lock()
	c := m.cache[roomID]
	if c == nil {
		c = &cachedMusic{durationKey: ""}
		m.cache[roomID] = c
	}
	m.applyStateLocked(c, state, hostSocketID)
	lastWrite := c.lastDBWriteAt
	m.mu.Unlock()

	m.refreshDuration(ctx, roomID)
	if now-lastWrite > musicDBWriteThrottleMS {
		return m.FlushToDB(ctx, roomID)
	}
	return nil
}

// ApplyHostHeartbeat 把房主心跳合并进基线（每 2s，携带完整状态）。
//
// 与一起看不同的关键点：这里**没有缓存也自建**。音乐心跳是完整状态，
// 而观众完全依赖服务器心跳推进进度，基线缺失会让广播彻底停摆。
func (m *MusicMemory) ApplyHostHeartbeat(ctx context.Context, roomID string, state MusicSyncState, hostSocketID string, clientTs int64) error {
	now := nowMillis()
	state.PositionSec = CompensateTransportDelay(TransportDelayParams{
		CurrentTime:  state.PositionSec,
		ClientTs:     clientTs,
		PlaybackRate: 1,
		IsPlaying:    state.IsPlaying,
		Now:          now,
	})
	state.UpdatedAt = now

	m.mu.Lock()
	c := m.cache[roomID]
	if c == nil {
		c = &cachedMusic{durationKey: ""}
		m.cache[roomID] = c
	}
	m.applyStateLocked(c, state, hostSocketID)
	shouldFlush := now-c.lastDBWriteAt > musicHeartbeatPersistThrottle
	if shouldFlush {
		c.dirty = true
	}
	m.mu.Unlock()

	m.refreshDuration(ctx, roomID)
	if shouldFlush {
		return m.FlushToDB(ctx, roomID)
	}
	return nil
}

// applyStateLocked 覆盖状态与房主连接（调用方已持锁）。
//
// 房主连接为空时保留旧值：心跳与离散状态都不带 socketId，一律覆盖会把
// 「房主在线」误判成离线，服务器心跳随即与房主广播重复下发。
func (m *MusicMemory) applyStateLocked(c *cachedMusic, state MusicSyncState, hostSocketID string) {
	if hostSocketID != "" {
		sid := hostSocketID
		c.hostSocketID = &sid
	}
	c.state = state
	c.revision++
	c.dirty = true
}

// GetAdvancedState 取外推后的当前状态（服务器心跳 / get-state / check-status 用）。
//
// 外推：暂停原样返回；播放中 positionSec + (now-updatedAt)/1000（恒 1x），
// 到达歌曲时长即凝固（isPlaying=false, positionSec=duration）。
func (m *MusicMemory) GetAdvancedState(ctx context.Context, roomID string) (*MusicSyncState, error) {
	m.mu.Lock()
	c := m.cache[roomID]
	_, hadCache := m.cache[roomID]
	cached := c
	m.mu.Unlock()

	if !hadCache || cached == nil {
		st, err := m.loadFromDB(ctx, roomID)
		if err != nil {
			return nil, err
		}
		if st == nil {
			return nil, nil
		}
		cached = &cachedMusic{state: *st, lastDBWriteAt: nowMillis()}
		m.mu.Lock()
		// 并发读同一房间时保留先到的那份（内容相同）。
		if existing, ok := m.cache[roomID]; ok && existing != nil {
			cached = existing
		} else {
			m.cache[roomID] = cached
		}
		m.mu.Unlock()
	}

	return m.advanceState(ctx, roomID, cached), nil
}

// GetRawState 取未推算的原始基线（queue-upsert afterCurrent 定位用）。
func (m *MusicMemory) GetRawState(ctx context.Context, roomID string) (*MusicSyncState, error) {
	m.mu.Lock()
	if c := m.cache[roomID]; c != nil {
		st := c.state
		m.mu.Unlock()
		return &st, nil
	}
	m.mu.Unlock()

	st, err := m.loadFromDB(ctx, roomID)
	if err != nil {
		return nil, err
	}
	if st == nil {
		return nil, nil
	}
	m.mu.Lock()
	if existing, ok := m.cache[roomID]; ok && existing != nil {
		cp := existing.state
		m.mu.Unlock()
		return &cp, nil
	}
	m.cache[roomID] = &cachedMusic{state: *st, lastDBWriteAt: nowMillis()}
	m.mu.Unlock()
	return st, nil
}

// UpdateHostSocket 更新房主连接（房主重连/断开；nil = 断开）。
func (m *MusicMemory) UpdateHostSocket(ctx context.Context, roomID string, hostSocketID *string) {
	m.persistMu.Lock()
	defer m.persistMu.Unlock()
	m.mu.Lock()
	if c := m.cache[roomID]; c != nil {
		if hostSocketID == nil {
			c.hostSocketID = nil
		} else {
			sid := *hostSocketID
			c.hostSocketID = &sid
		}
		c.revision++
	}
	m.mu.Unlock()
	if err := m.states.SetHostSocket(ctx, roomID, hostSocketID); err != nil {
		m.logger.Printf("[music] 更新房主连接失败 room=%s: %v", roomID, err)
	}
}

// ActiveRoomIDs 返回所有有基线的房间（定时广播遍历用）。
func (m *MusicMemory) ActiveRoomIDs() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]string, 0, len(m.cache))
	for id := range m.cache {
		out = append(out, id)
	}
	return out
}

// Clear 清除房间基线（房间关闭/删除时调用，含 DB 行）。
func (m *MusicMemory) Clear(ctx context.Context, roomID string) {
	m.persistMu.Lock()
	defer m.persistMu.Unlock()
	m.mu.Lock()
	delete(m.cache, roomID)
	m.mu.Unlock()
	if err := m.states.Delete(ctx, roomID); err != nil {
		m.logger.Printf("[music] 清除基线失败 room=%s: %v", roomID, err)
	}
}

// FlushAllDirty 把所有脏数据落盘（优雅关闭时调用，最多丢 2s 脏数据）。
func (m *MusicMemory) FlushAllDirty(ctx context.Context) {
	m.mu.Lock()
	ids := make([]string, 0, len(m.cache))
	for id, c := range m.cache {
		if c.dirty {
			ids = append(ids, id)
		}
	}
	m.mu.Unlock()
	for _, id := range ids {
		if err := m.FlushToDB(ctx, id); err != nil {
			m.logger.Printf("[music] 落盘失败 room=%s: %v", id, err)
		}
	}
}

// CleanupStaleCache 清理「房主离线且 10 分钟没动过」的内存缓存。
//
// 只清内存，DB 保留：后端重启后 get-state 仍能恢复续播。
// 脏数据不清——还没落盘的基线丢了就是真丢了。
func (m *MusicMemory) CleanupStaleCache() {
	now := nowMillis()
	m.mu.Lock()
	defer m.mu.Unlock()
	for roomID, c := range m.cache {
		if c.dirty {
			continue
		}
		if m.isHostOnlineLocked(c) {
			continue
		}
		if now-c.state.UpdatedAt > musicCacheStaleThresholdMS {
			delete(m.cache, roomID)
		}
	}
}

// isHostOnlineLocked 是 IsHostOnline 的持锁版本（CleanupStaleCache 内部用）。
//
// 这里**不能**再调 IsHostOnline：它会取同一把 m.mu，Go 的 sync.Mutex
// 不可重入，直接死锁。
func (m *MusicMemory) isHostOnlineLocked(c *cachedMusic) bool {
	if c.hostSocketID == nil || *c.hostSocketID == "" {
		return false
	}
	if m.hub == nil {
		return true
	}
	return m.hub.Connected(*c.hostSocketID)
}

// advanceState 把状态外推到当前时刻。
func (m *MusicMemory) advanceState(ctx context.Context, roomID string, c *cachedMusic) *MusicSyncState {
	m.mu.Lock()
	state := c.state
	m.mu.Unlock()
	if !state.IsPlaying {
		return &state
	}
	now := nowMillis()
	advanced := state.PositionSec + float64(now-state.UpdatedAt)/1000

	dur := m.ensureDurationSec(ctx, roomID, c, derefString(state.TrackKey))
	if dur != nil && *dur > 0 && advanced >= *dur {
		state.PositionSec = *dur
		state.IsPlaying = false
		return &state
	}
	state.PositionSec = advanced
	return &state
}

// refreshDuration 在换曲时刷新时长缓存（同曲不重复查队列表）。
//
// 失败不截断：查不到时长就按「未知」处理，绝不因此中断播放推进。
func (m *MusicMemory) refreshDuration(ctx context.Context, roomID string) {
	m.mu.Lock()
	c := m.cache[roomID]
	if c == nil {
		m.mu.Unlock()
		return
	}
	key := derefString(c.state.TrackKey)
	m.mu.Unlock()

	m.resolveDuration(ctx, roomID, c, key)
}

// ensureDurationSec 确保 cached.durationSec 与当前 trackKey 匹配，返回时长（秒）。
func (m *MusicMemory) ensureDurationSec(ctx context.Context, roomID string, c *cachedMusic, key string) *float64 {
	m.mu.Lock()
	if c.durationKey == key {
		d := c.durationSec
		m.mu.Unlock()
		return d
	}
	m.mu.Unlock()
	return m.resolveDuration(ctx, roomID, c, key)
}

// resolveDuration 按 trackKey 从队列解析时长并写回缓存。
//
//	ncm:key  → songId = Number(key[4:])
//	bili:key → source='bili' AND sourceId = key[5:]
//
// 条目不在队列（本地插播竞态）或 durationMs<=0 → nil（不截断）。
func (m *MusicMemory) resolveDuration(ctx context.Context, roomID string, c *cachedMusic, trackKey string) *float64 {
	var sec *float64
	if trackKey != "" {
		var item *store.MusicQueueItem
		var err error
		switch {
		case strings.HasPrefix(trackKey, "bili:"):
			item, err = m.queue.FindBySourceID(ctx, roomID, trackKey[5:])
		case strings.HasPrefix(trackKey, "ncm:"):
			songID, convErr := strconv.ParseInt(trackKey[4:], 10, 64)
			if convErr != nil {
				songID = -1
			}
			item, err = m.queue.FindBySongID(ctx, roomID, songID)
		default:
			item = nil
		}
		if err != nil {
			m.logger.Printf("[music] 解析歌曲时长失败 room=%s key=%s: %v", roomID, trackKey, err)
			item = nil
		}
		if item != nil && item.DurationMs > 0 {
			v := float64(item.DurationMs) / 1000
			sec = &v
		}
	}
	m.mu.Lock()
	// A slow lookup for the previous song must not replace the new song's
	// duration cache. Return its result only to the original playback snapshot.
	if derefString(c.state.TrackKey) == trackKey {
		c.durationSec = sec
		c.durationKey = trackKey
	}
	m.mu.Unlock()
	return sec
}

// FlushToDB 把指定房间的脏数据写入 DB。
func (m *MusicMemory) FlushToDB(ctx context.Context, roomID string) error {
	m.persistMu.Lock()
	defer m.persistMu.Unlock()
	m.mu.Lock()
	c := m.cache[roomID]
	if c == nil || !c.dirty {
		m.mu.Unlock()
		return nil
	}
	snapshot := c.state
	revision := c.revision
	hostID := c.hostSocketID
	m.mu.Unlock()

	var hostCopy *string
	if hostID != nil {
		v := *hostID
		hostCopy = &v
	}
	row := store.MusicPlaybackState{
		RoomID:        roomID,
		TrackSongID:   snapshot.TrackSongID,
		TrackKey:      snapshot.TrackKey,
		IsPlaying:     snapshot.IsPlaying,
		PositionSec:   snapshot.PositionSec,
		PlayMode:      snapshot.PlayMode,
		LastUpdatedAt: snapshot.UpdatedAt,
		HostSocketID:  hostCopy,
	}
	if err := m.states.Upsert(ctx, &row); err != nil {
		return err
	}

	m.mu.Lock()
	// 落盘期间可能又有新写入：只在「仍是刚写的那份」时清脏标记。
	if cur := m.cache[roomID]; cur == c && cur.revision == revision {
		cur.dirty = false
		cur.lastDBWriteAt = nowMillis()
	}
	m.mu.Unlock()
	return nil
}

// loadFromDB 从 DB 读基线（后端重启后首次访问）。
func (m *MusicMemory) loadFromDB(ctx context.Context, roomID string) (*MusicSyncState, error) {
	row, err := m.states.Find(ctx, roomID)
	if err == store.ErrMusicStateNotFound {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &MusicSyncState{
		TrackSongID: row.TrackSongID,
		TrackKey:    row.TrackKey,
		IsPlaying:   row.IsPlaying,
		PositionSec: row.PositionSec,
		PlayMode:    normalizePlayMode(row.PlayMode),
		UpdatedAt:   row.LastUpdatedAt,
	}, nil
}

// normalizePlayMode 把库里读出来的模式收敛到四个合法值。
//
// 表里是 varchar，历史数据可能写着别的（早期版本、手工改库）；
// 非法值一律按 sequence 处理——与 Node 的 loadFromDb 一致。
func normalizePlayMode(v string) string {
	switch v {
	case MusicPlaySequence, MusicPlayOrder, MusicPlayRepeatOne, MusicPlayShuffle:
		return v
	}
	return MusicPlaySequence
}

// isPlayMode 判断取值是否合法。
func isPlayMode(v string) bool {
	switch v {
	case MusicPlaySequence, MusicPlayOrder, MusicPlayRepeatOne, MusicPlayShuffle:
		return true
	}
	return false
}

// derefString 解引用可空字符串（nil → ""）。
func derefString(v *string) string {
	if v == nil {
		return ""
	}
	return *v
}

// musicStateFromPayload 校验并提取同步状态字段（异常 payload 返回 nil）。
//
// 校验规则与 Node 的 pickSyncState 逐条对齐，**不要放宽**：
//   - trackSongId：null 或正整数（B站 曲目恒 null）
//   - trackKey：null，或以 ncm: / bili: 开头（其它前缀按 null 处理，不报错）
//   - isPlaying：必须是布尔
//   - positionSec：非负有限数
//   - playMode：四个合法值之一
//   - updatedAt：有限数（服务端会重写，这里只是要求客户端带上）
//
// playMode / updatedAt 缺失时 Node 直接返回 null（整条心跳作废），
// 所以这里也必须严格——宽松处理会让半截状态污染基线。
func musicStateFromPayload(raw map[string]json.RawMessage) *MusicSyncState {
	if raw == nil {
		return nil
	}
	out := MusicSyncState{}

	// trackSongId
	if v, ok := raw["trackSongId"]; ok && !isJSONNull(v) {
		var n int64
		if err := json.Unmarshal(v, &n); err != nil {
			return nil
		}
		if n <= 0 {
			return nil
		}
		out.TrackSongID = &n
	}

	// trackKey：非法前缀回退 null（不整条拒绝）
	if v, ok := raw["trackKey"]; ok && !isJSONNull(v) {
		var s string
		if err := json.Unmarshal(v, &s); err != nil {
			return nil
		}
		if strings.HasPrefix(s, "ncm:") || strings.HasPrefix(s, "bili:") {
			out.TrackKey = &s
		}
	}

	// isPlaying
	v, ok := raw["isPlaying"]
	if !ok {
		return nil
	}
	var isPlaying bool
	if err := json.Unmarshal(v, &isPlaying); err != nil {
		return nil
	}
	out.IsPlaying = isPlaying

	// positionSec
	v, ok = raw["positionSec"]
	if !ok {
		return nil
	}
	var pos float64
	if err := json.Unmarshal(v, &pos); err != nil {
		return nil
	}
	if !isFiniteNumber(pos) || pos < 0 {
		return nil
	}
	out.PositionSec = pos

	// playMode
	v, ok = raw["playMode"]
	if !ok {
		return nil
	}
	var mode string
	if err := json.Unmarshal(v, &mode); err != nil {
		return nil
	}
	if !isPlayMode(mode) {
		return nil
	}
	out.PlayMode = mode

	// updatedAt
	v, ok = raw["updatedAt"]
	if !ok {
		return nil
	}
	var ts float64
	if err := json.Unmarshal(v, &ts); err != nil {
		return nil
	}
	if !isFiniteNumber(ts) {
		return nil
	}
	out.UpdatedAt = int64(ts)

	return &out
}

// isJSONNull 判断原始 JSON 是否为 null。
func isJSONNull(v json.RawMessage) bool {
	s := strings.TrimSpace(string(v))
	return s == "" || s == "null"
}

// isFiniteNumber 判断浮点值是否有限（NaN/±Inf）。
//
// JSON 本身不表达 NaN/Inf（unmarshal 会报错），但客户端可能发
// 1e999 这类超大指数——std 库直接拒绝，这里作为第二道闸门，
// 防止将来换成宽松解析时把 Inf 写进基线。
func isFiniteNumber(v float64) bool {
	return v == v && v <= 1.7976931348623157e308 && v >= -1.7976931348623157e308
}
