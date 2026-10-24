package room

import (
	"context"
	"database/sql"
	"errors"
	"log"
	"sync"
	"time"

	"zviewer/backend/internal/store"
)

// HostReconnectGrace 是房主断线后的重连宽限期。
//
// 10 分钟内房主回来（register-host）即恢复；超时后按「自动删除无人房间」
// 开关决定是否关闭。这个值直接决定观众能在「无房主」状态下停留多久，
// 与前端文案一致，改动要同步改提示语。
const HostReconnectGrace = 10 * time.Minute

// Hub 是实时层（socket.io）暴露给房间业务的能力子集。
//
// 用接口而不是直接依赖 `*sio.Server`，一是让房间逻辑能用假 Hub 单测，
// 二是把「业务只管发什么事件」与「事件怎么编码上线路」分开——
// 后者已经由 internal/sio 的协议层保证。
type Hub interface {
	// EmitRoom 向房间内所有连接广播。
	EmitRoom(roomID, event string, payload any)
	// EmitRoomExcept 向房间内除指定连接外的所有连接广播
	// （对应 Node 的 `socket.to(roomId).emit()`，发送者自己收不到）。
	EmitRoomExcept(roomID, exceptSocketID, event string, payload any)
	// EmitTo 只推给指定连接（对应 `io.to(socket.id).emit()`）。
	EmitTo(socketID, event string, payload any)
	// SocketIDs 返回房间内所有在线连接 ID。
	SocketIDs(roomID string) []string
	// Connected 判断连接是否仍在线。
	Connected(socketID string) bool
	// Leave 让连接退出房间（保持连接本身不断开）。
	Leave(socketID, roomID string)
	// Join 让**另一条**连接加入房间（审批通过时房主替观众加）。
	Join(socketID, roomID string)
	// Disconnect 断开连接（对应 `socket.disconnect(true)`）。
	Disconnect(socketID string)
	// SocketData 读取连接上的身份数据（userId / username / role）。
	// 连接已断开时返回 nil。
	SocketData(socketID string) map[string]any
	// DeleteSocketData 清除连接上的某个 data 键（拒绝审批时清 pendingRoomId）。
	DeleteSocketData(socketID, key string)
}

// RuntimeState 是房间的运行时状态（重启即丢失，DB 才是事实源）。
type RuntimeState struct {
	// Movies 是当前影片列表。用 any 承载：DTO 的字段由 api 层定义，
	// 房间层只负责「存着并按原样广播」，多一层转换就多一处漂移机会。
	Movies []any
	// CurrentMovieID 当前播放的影片 ID（int64 或 nil）。
	CurrentMovieID any
	// Playback 是房主最近一次广播的播放状态。
	Playback *Playback
	// Subtitle 是房主最近一次广播的字幕状态（原样缓存，观众中途加入时补发）。
	Subtitle any
}

// Service 是房间业务的中枢：运行时状态、重连定时器、会话与权限。
//
// 单例，所有 handler 与 REST 共用同一份内存状态。
type Service struct {
	DB       *sql.DB
	Rooms    *store.Rooms
	Sessions *store.Sessions
	Settings *store.Settings
	Playback *PlaybackMemory
	Hub      Hub
	Logger   *log.Logger

	// movieLister 由 api 层注入（DTO 定义在那边）。
	movieLister MovieLister

	mu     sync.Mutex
	states map[string]*RuntimeState
	timers map[string]*time.Timer

	// admitMu 串行化「人数校验 + 插入会话」，避免并发进房时超员。
	admitMu sync.Mutex
	perm    *permCache
}

// NewService 构造房间服务。
func NewService(db *sql.DB, rooms *store.Rooms, sessions *store.Sessions, settings *store.Settings, playback *PlaybackMemory, hub Hub, logger *log.Logger) *Service {
	if logger == nil {
		logger = log.Default()
	}
	return &Service{
		DB:       db,
		Rooms:    rooms,
		Sessions: sessions,
		Settings: settings,
		Playback: playback,
		Hub:      hub,
		Logger:   logger,
		states:   make(map[string]*RuntimeState),
		timers:   make(map[string]*time.Timer),
		perm:     newPermCache(),
	}
}

// ---------------------------------------------------------------------------
// 运行时状态
// ---------------------------------------------------------------------------

// State 返回房间运行时状态，不存在时创建空状态。
func (s *Service) State(roomID string) *RuntimeState {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := s.states[roomID]
	if st == nil {
		// movies 必须初始化成空切片而不是 nil：下发给前端的 `{movies}` 里
		// nil 会序列化成 `null`，而前端按数组处理（.map / .length），
		// 一个 null 就白屏。Node 侧 roomState 初始化同样给的是 []。
		st = &RuntimeState{Movies: []any{}}
		s.states[roomID] = st
	}
	return st
}

// SetMovies 覆盖影片列表。传 nil 时按空列表处理，避免广播出 `movies: null`。
func (s *Service) SetMovies(roomID string, movies []any) {
	if movies == nil {
		movies = []any{}
	}
	s.State(roomID).Movies = movies
}

// Movies 返回当前影片列表（永不为 nil）。
func (s *Service) Movies(roomID string) []any {
	s.mu.Lock()
	defer s.mu.Unlock()
	if st := s.states[roomID]; st != nil && st.Movies != nil {
		return st.Movies
	}
	return []any{}
}

// SetCurrentMovie 设置当前播放影片。
func (s *Service) SetCurrentMovie(roomID string, movieID any) {
	s.State(roomID).CurrentMovieID = movieID
}

// CurrentMovieID 返回当前播放影片 ID（无则为 nil）。
func (s *Service) CurrentMovieID(roomID string) any {
	s.mu.Lock()
	defer s.mu.Unlock()
	if st := s.states[roomID]; st != nil {
		return st.CurrentMovieID
	}
	return nil
}

// SetPlayback 缓存房主广播的播放状态。
func (s *Service) SetPlayback(roomID string, p *Playback) {
	s.State(roomID).Playback = p
}

// GetPlayback 返回缓存的播放状态（未推算）。
func (s *Service) GetPlayback(roomID string) *Playback {
	s.mu.Lock()
	defer s.mu.Unlock()
	if st := s.states[roomID]; st != nil {
		return st.Playback
	}
	return nil
}

// SetSubtitle 缓存房主最近一次广播的字幕状态。
func (s *Service) SetSubtitle(roomID string, subtitle any) {
	s.State(roomID).Subtitle = subtitle
}

// Subtitle 返回缓存的字幕状态。
func (s *Service) Subtitle(roomID string) any {
	s.mu.Lock()
	defer s.mu.Unlock()
	if st := s.states[roomID]; st != nil {
		return st.Subtitle
	}
	return nil
}

// Delete 清除房间运行时状态。
func (s *Service) Delete(roomID string) {
	s.mu.Lock()
	delete(s.states, roomID)
	s.mu.Unlock()
}

// ---------------------------------------------------------------------------
// 房主重连定时器
// ---------------------------------------------------------------------------

// StartReconnectTimer 启动房主重连定时器（会先取消已有的，避免重复关闭）。
func (s *Service) StartReconnectTimer(roomID string, fn func()) {
	s.CancelReconnectTimer(roomID)
	timer := time.AfterFunc(HostReconnectGrace, fn)
	s.mu.Lock()
	s.timers[roomID] = timer
	s.mu.Unlock()
}

// CancelReconnectTimer 取消房主重连定时器。
func (s *Service) CancelReconnectTimer(roomID string) {
	s.mu.Lock()
	timer := s.timers[roomID]
	delete(s.timers, roomID)
	s.mu.Unlock()
	if timer != nil {
		timer.Stop()
	}
}

// HasReconnectTimer 判断是否有待触发的重连定时器。
func (s *Service) HasReconnectTimer(roomID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.timers[roomID]
	return ok
}

// ---------------------------------------------------------------------------
// 关闭房间
// ---------------------------------------------------------------------------

// CloseAfterHostGrace 是重连定时器的回调：按「自动删除无人房间」开关决定是否关闭。
//
// 开关关闭时房间保留——观众可继续停留，房主可随时回来；关闭只能由
// close-room / admin-close-room 显式触发。
// 读设置失败时按原行为关闭：异常态下让房间泄漏比误关更难收拾。
func (s *Service) CloseAfterHostGrace(ctx context.Context, settings *store.Settings, roomID, sharerSocketID string) {
	if settings != nil {
		cfg, err := settings.Get(ctx)
		if err != nil {
			s.Logger.Printf("[room] 读取设置失败，按默认关闭房间 %s: %v", roomID, err)
		} else if !cfg.AutoDeleteInactiveRooms {
			s.Logger.Printf("[room] 自动删除无人房间已关闭，保留房间 %s", roomID)
			return
		}
	}
	if err := s.CloseAndNotify(ctx, roomID, sharerSocketID); err != nil {
		s.Logger.Printf("[room] 关闭房间 %s 失败: %v", roomID, err)
	}
}

// CloseAndNotify 关闭房间并通知所有成员。
//
// 顺序不能改：先落库（status=closed）、再广播 room-closed、最后踢人。
// 反过来的话被踢的客户端收不到 room-closed，前端会停在播放页而不是
// 跳回房间列表。
func (s *Service) CloseAndNotify(ctx context.Context, roomID, sharerSocketID string) error {
	if err := s.Rooms.SetStatus(ctx, roomID, "closed"); err != nil {
		return err
	}
	if _, err := s.Sessions.EndByRoom(ctx, roomID); err != nil {
		return err
	}
	// 房间关闭后所有 sharer session 都已结束，缓存必须整体失效。
	s.perm.invalidate("", roomID)

	if s.Hub != nil {
		s.Hub.EmitRoom(roomID, "room-closed", map[string]any{"roomId": roomID})
	}

	s.Delete(roomID)
	s.CancelReconnectTimer(roomID)

	if err := s.Playback.Clear(ctx, roomID); err != nil {
		s.Logger.Printf("[room] 清理播放记忆失败 %s: %v", roomID, err)
	}
	// 一起听（music_playback_states）尚未迁移业务，但关闭房间必须一并清掉，
	// 否则下次同 ID 房间进来会接着放上一首。
	if _, err := s.DB.ExecContext(ctx,
		`DELETE FROM "music_playback_states" WHERE "roomId" = ?`, roomID); err != nil {
		s.Logger.Printf("[room] 清理音乐播放状态失败 %s: %v", roomID, err)
	}

	if s.Hub == nil {
		return nil
	}
	for _, id := range s.Hub.SocketIDs(roomID) {
		if id == sharerSocketID {
			continue
		}
		s.Hub.Leave(id, roomID)
		s.Hub.Disconnect(id)
	}
	return nil
}

// ---------------------------------------------------------------------------
// 权限缓存
// ---------------------------------------------------------------------------

// permCache 是 isRoomHost / isInRoom 的 5 秒结果缓存。
//
// 心跳每 2s 一次，每次都查 DB 会把单房间变成每秒数条查询；但缓存又必须
// 能在「踢出 / session 结束 / 房间关闭」时立刻失效，否则被踢的人还能在
// TTL 内继续广播，表现为「踢了没反应，几秒后才掉」。
type permCache struct {
	mu      sync.Mutex
	entries map[string]permEntry
}

type permEntry struct {
	ok      bool
	expires time.Time
}

const (
	permCacheTTL   = 5 * time.Second
	permCacheLimit = 1000
)

func newPermCache() *permCache {
	return &permCache{entries: make(map[string]permEntry)}
}

func permKey(socketID, roomID, method string) string {
	return socketID + ":" + roomID + ":" + method
}

func (c *permCache) get(key string) (bool, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[key]
	if !ok {
		return false, false
	}
	if time.Now().After(e.expires) {
		delete(c.entries, key)
		return false, false
	}
	return e.ok, true
}

func (c *permCache) set(key string, ok bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	// socketId 维度的旧条目断连后再也不会被读到，惰性过期清不掉它们，
	// 因此超限时先清过期、仍超限就整体清空（5s TTL 下重建成本可忽略）。
	if len(c.entries) >= permCacheLimit {
		now := time.Now()
		for k, v := range c.entries {
			if now.After(v.expires) {
				delete(c.entries, k)
			}
		}
		if len(c.entries) >= permCacheLimit {
			c.entries = make(map[string]permEntry)
		}
	}
	c.entries[key] = permEntry{ok: ok, expires: time.Now().Add(permCacheTTL)}
}

// invalidate 按 socketID / roomID 失效缓存（两者都为空时清空全部）。
func (c *permCache) invalidate(socketID, roomID string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if socketID != "" && roomID != "" {
		for _, m := range []string{"isRoomHost", "isInRoom", "isRoomModerator"} {
			delete(c.entries, permKey(socketID, roomID, m))
		}
		return
	}
	if socketID == "" && roomID == "" {
		c.entries = make(map[string]permEntry)
		return
	}
	for k := range c.entries {
		// key = socketId:roomId:method，两侧都不含冒号
		// （socket id 是 base64url，roomId 是 8 位字母数字）。
		parts := splitPermKey(k)
		if socketID != "" {
			if parts[0] == socketID {
				delete(c.entries, k)
			}
			continue
		}
		if parts[1] == roomID {
			delete(c.entries, k)
		}
	}
}

func splitPermKey(key string) [3]string {
	var out [3]string
	idx := 0
	start := 0
	for i := 0; i < len(key) && idx < 2; i++ {
		if key[i] == ':' {
			out[idx] = key[start:i]
			start = i + 1
			idx++
		}
	}
	out[idx] = key[start:]
	return out
}

// InvalidatePermission 供 handler 在 session 变化后主动失效缓存。
func (s *Service) InvalidatePermission(socketID, roomID string) {
	s.perm.invalidate(socketID, roomID)
}

// errRoomIDExhausted 表示连续 20 次生成的房间号都被占用。
//
// 8 位 62 进制空间约 2.2e14，连撞 20 次只可能是库被塞满了同前缀的
// 测试数据，直接报错比无限重试更容易发现问题。
var errRoomIDExhausted = errors.New("生成房间号失败：连续碰撞")
