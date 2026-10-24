// Package room 实现房间的实时业务：生命周期、房主/观众会话、运行时状态与播放记忆。
//
// 这一层是 Node 版 `modules/room` + `modules/playback-memory` 的对应实现。
// 与 REST 层一样，判断「谁在这个房间里」**只认 session 表的 endedAt IS NULL**，
// 不额外维护内存在场表——两套事实源一旦分叉，表现就是「房间在但进不去」。
package room

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"
)

// Playback 是持久化的播放状态，字段与 Node 的 PlaybackStateDto 逐字对齐。
//
// 可选字段一律用指针 + omitempty：Node 侧 undefined 在 JSON.stringify 里
// **整键消失**，下发 null 会让前端 `x ?? 默认值` 兜底失效。
type Playback struct {
	SourceURL       string          `json:"sourceUrl"`
	SourceType      string          `json:"sourceType"`
	AudioURL        *string         `json:"audioUrl,omitempty"`
	Format          *string         `json:"format,omitempty"`
	VideoCodec      *string         `json:"videoCodec,omitempty"`
	AudioCodec      *string         `json:"audioCodec,omitempty"`
	Cid             *int64          `json:"cid,omitempty"`
	IsPlaying       bool            `json:"isPlaying"`
	CurrentTime     float64         `json:"currentTime"`
	PlaybackRate    float64         `json:"playbackRate"`
	Duration        float64         `json:"duration"`
	CurrentQn       *int64          `json:"currentQn,omitempty"`
	AcceptQuality   json.RawMessage `json:"acceptQuality,omitempty"`
	Headers         json.RawMessage `json:"headers,omitempty"`
	NoProxyFallback *bool           `json:"noProxyFallback,omitempty"`
	// IsPreview 用 omitempty：Node 的播放记忆在内存里是「客户端上报的 state
	// 原样 + 几个补丁字段」，前端没传 isPreview 时对象里就没这个键；
	// 恒输出 false 会让 request-state 的 ack 多出一个 Node 没有的字段。
	IsPreview      bool    `json:"isPreview,omitempty"`
	PreviewTitle   *string `json:"previewTitle,omitempty"`
	BufferMode     *bool   `json:"bufferMode,omitempty"`
	CurrentMovieID *int64  `json:"currentMovieId,omitempty"`
	// UpdatedAt 是 Unix 毫秒时间戳（对应 DB 的 lastUpdatedAt），
	// 服务器据此推算当前实际进度。
	UpdatedAt int64 `json:"updatedAt"`
	// HostSocketID 在 DTO 里恒存在（可能为 null），因此不加 omitempty。
	HostSocketID *string `json:"hostSocketId"`
}

// clone 返回深拷贝，避免调用方改动「已推算」的副本时污染缓存基线。
func (p *Playback) clone() *Playback {
	cp := *p
	return &cp
}

// cachedPlayback 是内存缓存条目。
//
// 单独记 lastDBWriteAt / dirty 是为了节流落盘：房主每 500ms 推一次状态、
// 每 2s 发一次心跳，每次都写 DB 会把 SQLite 写成瓶颈（且迁移期与 Node
// 共用同一个库，写放大直接变成两边互相抢锁）。内存永远是最新的，
// DB 只用于持久化与重启恢复。
type cachedPlayback struct {
	state *Playback
	// lastDBWriteAt 是最近一次落盘的时刻（Unix 毫秒），0 表示从未写过。
	lastDBWriteAt int64
	// dirty 表示内存已变更但还没落盘。
	dirty bool
}

// PlaybackMemory 管理播放状态的「内存缓存 + DB 持久化」。
//
// 与 Node 版一致：读优先内存，写同步更新内存、按节流窗口异步落盘。
type PlaybackMemory struct {
	conn *sql.DB

	mu    sync.Mutex
	cache map[string]*cachedPlayback
}

// NewPlaybackMemory 构造播放记忆服务。
func NewPlaybackMemory(conn *sql.DB) *PlaybackMemory {
	return &PlaybackMemory{conn: conn, cache: make(map[string]*cachedPlayback)}
}

// ErrNoPlayback 表示房间没有任何播放状态。
var ErrNoPlayback = errors.New("房间无播放状态")

const playbackColumns = `"roomId", "sourceUrl", "sourceType", "audioUrl", "format",
	"videoCodec", "audioCodec", "cid", "isPlaying", "currentTime", "playbackRate",
	"duration", "currentQn", "acceptQuality", "headers", "noProxyFallback",
	"isPreview", "previewTitle", "bufferMode", "currentMovieId",
	"lastUpdatedAt", "hostSocketId"`

// load 读缓存，未命中回落 DB 并回填缓存。
func (m *PlaybackMemory) load(ctx context.Context, roomID string) (*Playback, error) {
	m.mu.Lock()
	if c, ok := m.cache[roomID]; ok && c.state != nil {
		cp := c.state.clone()
		m.mu.Unlock()
		return cp, nil
	}
	m.mu.Unlock()

	row := m.conn.QueryRowContext(ctx,
		`SELECT `+playbackColumns+` FROM "playback_states" WHERE "roomId" = ? LIMIT 1`, roomID)
	p, err := scanPlayback(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNoPlayback
	}
	if err != nil {
		return nil, fmt.Errorf("读取播放状态失败: %w", err)
	}

	m.mu.Lock()
	// 并发读同一房间时可能已被别的协程填入，保留先到的那份（内容相同）。
	if existing, ok := m.cache[roomID]; ok && existing.state != nil {
		p = existing.state
	} else {
		m.cache[roomID] = &cachedPlayback{state: p, lastDBWriteAt: time.Now().UnixMilli()}
	}
	cp := p.clone()
	m.mu.Unlock()
	return cp, nil
}

// Advanced 返回按时间推算后的播放状态（房主重连、观众请求状态时用）。
//
// 推算公式与 Node 版一致：
//
//	elapsed = (now - lastUpdatedAt) / 1000
//	current = currentTime + elapsed * playbackRate * (isPlaying ? 1 : 0)
//
// 超过总时长即视为播完（currentTime 钉在 duration、isPlaying=false），
// 否则房主离线久了会把进度推到两倍时长。
func (m *PlaybackMemory) Advanced(ctx context.Context, roomID string) (*Playback, error) {
	p, err := m.load(ctx, roomID)
	if err != nil {
		return nil, err
	}
	if !p.IsPlaying {
		return p, nil
	}
	now := time.Now().UnixMilli()
	elapsed := float64(now-p.UpdatedAt) / 1000
	advanced := p.CurrentTime + elapsed*p.PlaybackRate
	if p.Duration > 0 && advanced >= p.Duration {
		p.CurrentTime = p.Duration
		p.IsPlaying = false
		return p, nil
	}
	p.CurrentTime = advanced
	return p, nil
}

// UpdateHostSocket 更新房主 socket ID（房主重连 / 断开时调用）。
//
// 断开时传 nil：状态保留，服务器继续推算进度给观众。
// 房间没有播放状态时**不做任何事**——Node 侧同样只 update 不 insert，
// 这里凭空插一条会让观众加入时看到「有播放状态但 sourceUrl 为空」。
func (m *PlaybackMemory) UpdateHostSocket(ctx context.Context, roomID string, hostSocketID *string) error {
	m.mu.Lock()
	if c, ok := m.cache[roomID]; ok && c.state != nil {
		c.state.HostSocketID = hostSocketID
	}
	m.mu.Unlock()

	if _, err := m.conn.ExecContext(ctx,
		`UPDATE "playback_states" SET "hostSocketId" = ? WHERE "roomId" = ?`,
		nullableStr(hostSocketID), roomID); err != nil {
		return fmt.Errorf("更新房主 socket 失败: %w", err)
	}
	return nil
}

// HostSocketID 返回缓存里的房主 socket ID（无缓存或未设置返回空串）。
func (m *PlaybackMemory) HostSocketID(roomID string) string {
	m.mu.Lock()
	defer m.mu.Unlock()
	if c, ok := m.cache[roomID]; ok && c.state != nil && c.state.HostSocketID != nil {
		return *c.state.HostSocketID
	}
	return ""
}

// HasCache 判断房间是否有内存缓存条目。
//
// 与「读 DB」不同：这里只问「这个房间当前是否有人在同步播放」。
// host-heartbeat 的落盘节流依赖它——没有缓存说明房主还没广播过完整状态，
// 单凭心跳的 currentTime 拼不出完整播放状态（缺 sourceUrl 等），不能建。
func (m *PlaybackMemory) HasCache(roomID string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	_, ok := m.cache[roomID]
	return ok
}

// ActiveRoomIDs 返回所有有播放状态的房间（供定时广播/清理遍历）。
func (m *PlaybackMemory) ActiveRoomIDs() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]string, 0, len(m.cache))
	for roomID := range m.cache {
		out = append(out, roomID)
	}
	return out
}

// IsHostOnline 判断「缓存的 hostSocketId 那条连接是否还在线」。
//
// 注意与 Service.IsSharerOnline 的区别：那个查的是 session 表（谁是房主），
// 这个查的是连接存活（那条 socket 还在不在）。清理逻辑必须用后者——
// 后端重启后从 DB 恢复出来的 hostSocketId 早已失效，只按 session 判断
// 会把陈旧缓存一直留着。
//
// connected 为 nil 时按「有人」处理，与 Node 侧 `this.io` 未注入时的
// `return true` 一致（宁可不清，也不要在没有连接信息时误删播放状态）。
func (m *PlaybackMemory) IsHostOnline(roomID string, connected func(socketID string) bool) bool {
	socketID := m.HostSocketID(roomID)
	if socketID == "" {
		return false
	}
	if connected == nil {
		return true
	}
	return connected(socketID)
}

// cacheStaleThreshold 是「多久没更新就算陈旧」的阈值（对应 Node 的
// CACHE_STALE_THRESHOLD_MS）。房主离线超过这个时长的播放状态不再值得保留。
const cacheStaleThreshold = 10 * time.Minute

// CleanupStaleCache 清理陈旧缓存：房主连接已断开且状态超过 10 分钟没更新。
//
// 脏数据先落盘再清——直接删缓存会丢掉最后 2s 的进度（房主可能只是掉线，
// 重连后要接着播）。
func (m *PlaybackMemory) CleanupStaleCache(ctx context.Context, isHostOnline func(roomID string) bool) {
	if isHostOnline == nil {
		isHostOnline = func(string) bool { return false }
	}
	now := time.Now().UnixMilli()

	type stale struct {
		roomID string
		dirty  bool
	}
	var targets []stale

	m.mu.Lock()
	for roomID, c := range m.cache {
		if isHostOnline(roomID) {
			continue
		}
		if c.state == nil || now-c.state.UpdatedAt <= cacheStaleThreshold.Milliseconds() {
			continue
		}
		targets = append(targets, stale{roomID: roomID, dirty: c.dirty})
	}
	m.mu.Unlock()

	for _, t := range targets {
		if t.dirty {
			if err := m.flushToDB(ctx, t.roomID); err != nil {
				// 落盘失败就本轮不删：留着下个周期再试，比丢掉进度好。
				continue
			}
		}
		if err := m.Clear(ctx, t.roomID); err != nil {
			continue
		}
	}
}

// FlushAllDirty 把全部脏数据落盘（进程退出前调用，最多丢 2s 进度）。
func (m *PlaybackMemory) FlushAllDirty(ctx context.Context) {
	for _, roomID := range m.ActiveRoomIDs() {
		if err := m.flushToDB(ctx, roomID); err != nil {
			// 退出路径上不中断其余房间的落盘。
			continue
		}
	}
}

// Clear 清除房间的播放记忆（内存 + DB）。关闭房间时调用。
func (m *PlaybackMemory) Clear(ctx context.Context, roomID string) error {
	m.mu.Lock()
	delete(m.cache, roomID)
	m.mu.Unlock()

	if _, err := m.conn.ExecContext(ctx,
		`DELETE FROM "playback_states" WHERE "roomId" = ?`, roomID); err != nil {
		return fmt.Errorf("清理播放状态失败: %w", err)
	}
	return nil
}

func scanPlayback(row rowScanner) (*Playback, error) {
	var (
		p            Playback
		audioURL     sql.NullString
		format       sql.NullString
		videoCodec   sql.NullString
		audioCodec   sql.NullString
		cid          sql.NullInt64
		currentQn    sql.NullInt64
		acceptQ      sql.NullString
		headers      sql.NullString
		noProxy      sql.NullInt64
		isPreview    sql.NullInt64
		previewTitle sql.NullString
		bufferMode   sql.NullInt64
		currentMovie sql.NullInt64
		lastUpdated  sql.NullInt64
		hostSocket   sql.NullString
		roomID       string
	)
	err := row.Scan(&roomID, &p.SourceURL, &p.SourceType, &audioURL, &format,
		&videoCodec, &audioCodec, &cid, &p.IsPlaying, &p.CurrentTime, &p.PlaybackRate,
		&p.Duration, &currentQn, &acceptQ, &headers, &noProxy,
		&isPreview, &previewTitle, &bufferMode, &currentMovie,
		&lastUpdated, &hostSocket)
	if err != nil {
		return nil, err
	}
	p.AudioURL = nullStr(audioURL)
	p.Format = nullStr(format)
	p.VideoCodec = nullStr(videoCodec)
	p.AudioCodec = nullStr(audioCodec)
	p.Cid = nullInt(cid)
	p.CurrentQn = nullInt(currentQn)
	p.AcceptQuality = rawJSONOrNil(acceptQ)
	p.Headers = rawJSONOrNil(headers)
	p.NoProxyFallback = nullBool(noProxy)
	p.IsPreview = isPreview.Int64 != 0
	p.PreviewTitle = nullStr(previewTitle)
	p.BufferMode = nullBool(bufferMode)
	p.CurrentMovieID = nullInt(currentMovie)
	p.UpdatedAt = lastUpdated.Int64
	p.HostSocketID = nullStr(hostSocket)
	return &p, nil
}

// rowScanner 是 *sql.Row / *sql.Rows 的公共子集。
type rowScanner interface {
	Scan(dest ...any) error
}

func nullStr(v sql.NullString) *string {
	if !v.Valid {
		return nil
	}
	s := v.String
	return &s
}

func nullInt(v sql.NullInt64) *int64 {
	if !v.Valid {
		return nil
	}
	n := v.Int64
	return &n
}

func nullBool(v sql.NullInt64) *bool {
	if !v.Valid {
		return nil
	}
	b := v.Int64 != 0
	return &b
}

func nullableStr(v *string) any {
	if v == nil {
		return nil
	}
	return *v
}

// rawJSONOrNil 只在值确实是合法 JSON 时透传。TypeORM 那侧是 JSON.parse +
// 失败忽略，这里等价于「解析失败就当没有」。
func rawJSONOrNil(v sql.NullString) json.RawMessage {
	if !v.Valid || v.String == "" {
		return nil
	}
	if !json.Valid([]byte(v.String)) {
		return nil
	}
	return json.RawMessage(v.String)
}
