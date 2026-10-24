package room

import (
	"context"
	"log"
	"sync"
	"time"
)

// 服务器心跳的两个周期。
const (
	// serverHeartbeatInterval 是 sync-heartbeat / server-heartbeat 的广播间隔。
	//
	// 房主侧心跳也是 2s，两路同时发不是冗余：房主那条是「我这边现在到哪了」，
	// 服务器这条是**推算值**，房主掉线后观众只能靠它继续播。
	serverHeartbeatInterval = 2 * time.Second
	// cleanupInterval 是陈旧缓存清理的周期。
	cleanupInterval = 30 * time.Second
	// hostOnlineCacheTTL 是房主在线判定的缓存时间。
	//
	// 每 2s × 每房间都打一次 session 表太贵；5s 的滞后对前端「房主离线 →
	// 观众自主控制」的切换完全可以接受。
	hostOnlineCacheTTL = 5 * time.Second
)

// serverHeartbeatPayload 是 server-heartbeat 的载荷（字段顺序即下发顺序）。
//
// RoomID 只在 server-heartbeat 里有：sync-heartbeat 是统一协议（音乐侧共用
// 同一个事件名），带 roomId 会让两条协议分叉。
type serverHeartbeatPayload struct {
	RoomID     string    `json:"roomId"`
	State      *Playback `json:"state"`
	HostOnline bool      `json:"hostOnline"`
}

// syncHeartbeatPayload 是 sync-heartbeat 的载荷。
//
// Source 恒为 "server"：客户端据此区分「房主心跳」与「服务器心跳」，
// 前者可以携带房主端的本地播放器状态，后者只有推算值。
type syncHeartbeatPayload struct {
	Source     string    `json:"source"`
	State      *Playback `json:"state"`
	HostOnline bool      `json:"hostOnline"`
}

type hostOnlineEntry struct {
	online bool
	at     time.Time
}

// Broadcaster 是服务器周期心跳与缓存清理的定时器。
//
// 为什么需要它：房主断开后，观众端的进度只能由服务器推算并持续下发。
// 没有这条通道时观众会在房主心跳超时（6s）后暂停，即使影片还在播。
type Broadcaster struct {
	svc    *Service
	logger *log.Logger

	stopOnce sync.Once
	stopCh   chan struct{}
	wg       sync.WaitGroup

	hostMu sync.Mutex
	hosts  map[string]hostOnlineEntry
}

// NewBroadcaster 构造广播器。需显式 Start 才会开始计时。
func NewBroadcaster(svc *Service, logger *log.Logger) *Broadcaster {
	if logger == nil {
		logger = log.Default()
	}
	return &Broadcaster{
		svc:    svc,
		logger: logger,
		stopCh: make(chan struct{}),
		hosts:  make(map[string]hostOnlineEntry),
	}
}

// Start 启动两个定时器（心跳 2s / 清理 30s）。重复调用无副作用。
func (b *Broadcaster) Start() {
	if b == nil || b.svc == nil {
		return
	}
	b.wg.Add(2)
	go b.loop(serverHeartbeatInterval, b.broadcastAll)
	go b.loop(cleanupInterval, b.cleanupOnce)
}

// Stop 停止定时器并等待在途的一轮结束。
func (b *Broadcaster) Stop() {
	if b == nil {
		return
	}
	b.stopOnce.Do(func() { close(b.stopCh) })
	b.wg.Wait()
}

// loop 按固定间隔调用 fn，直到 Stop。
//
// 用 ticker 而不是 time.AfterFunc 递归：后者每次都要重新分配定时器，
// 且 Stop 与回调之间有竞态（停完之后还可能再排一个）。
func (b *Broadcaster) loop(interval time.Duration, fn func()) {
	defer b.wg.Done()
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-b.stopCh:
			return
		case <-ticker.C:
			fn()
		}
	}
}

// broadcastAll 遍历所有有播放状态的房间，下发推算后的进度。
func (b *Broadcaster) broadcastAll() {
	hub := b.svc.Hub
	if hub == nil {
		return
	}
	for _, roomID := range b.svc.Playback.ActiveRoomIDs() {
		// 房间里没人就不用序列化：没人收，纯浪费。注意这里**不按房主在线
		// 跳过**——服务器心跳是观众进度的唯一权威来源，房主在线时也要发，
		// 否则房主端与服务器端会有两条不同的进度在观众那里打架。
		if hub.MemberCount(roomID) == 0 {
			continue
		}

		ctx, cancel := handlerCtx()
		state, err := b.svc.Playback.Advanced(ctx, roomID)
		cancel()
		if err != nil || state == nil {
			continue
		}

		hostOnline := b.isHostOnlineCached(roomID)

		hub.EmitRoom(roomID, "server-heartbeat", serverHeartbeatPayload{
			RoomID:     roomID,
			State:      state,
			HostOnline: hostOnline,
		})
		hub.EmitRoom(roomID, "sync-heartbeat", syncHeartbeatPayload{
			Source:     "server",
			State:      state,
			HostOnline: hostOnline,
		})
	}
}

// isHostOnlineCached 查询房主是否在线（5s 缓存）。
//
// 查询失败按「离线」处理：观众端进入自主控制模式，比误判在线却收不到
// 进度要好。
func (b *Broadcaster) isHostOnlineCached(roomID string) bool {
	now := time.Now()

	b.hostMu.Lock()
	if e, ok := b.hosts[roomID]; ok && now.Sub(e.at) < hostOnlineCacheTTL {
		b.hostMu.Unlock()
		return e.online
	}
	b.hostMu.Unlock()

	ctx, cancel := handlerCtx()
	defer cancel()
	online, err := b.svc.IsSharerOnline(ctx, roomID)
	if err != nil {
		online = false
	}

	b.hostMu.Lock()
	b.hosts[roomID] = hostOnlineEntry{online: online, at: now}
	b.hostMu.Unlock()
	return online
}

// cleanupOnce 清理陈旧缓存：播放记忆与房间运行时状态。
//
// 顺序不能反：播放记忆先清，房间状态才能据「还有没有播放记忆」判断
// 自己该不该留。反过来的话房间状态永远清不掉（它自己就是判断依据的一部分）。
func (b *Broadcaster) cleanupOnce() {
	ctx, cancel := context.WithTimeout(context.Background(), cleanupInterval)
	defer cancel()

	b.svc.Playback.CleanupStaleCache(ctx, b.hostSocketOnline)
	b.svc.CleanupStaleStates(b.hostSocketOnline)
}

// hostSocketOnline 判断「缓存里的 hostSocketId 那条连接是否还在线」。
//
// 与 isHostOnlineCached 不是一回事：那个查 session 表（谁是房主），
// 这个查连接存活（那条 socket 还在吗）。清理只能用后者——后端重启后
// 从 DB 恢复的 hostSocketId 早已失效。
func (b *Broadcaster) hostSocketOnline(roomID string) bool {
	if b.svc.Hub == nil {
		return false
	}
	return b.svc.Playback.IsHostOnline(roomID, b.svc.Hub.Connected)
}

// CleanupStaleStates 清理不再有主人的房间运行时状态。
//
// 判据是「房主连接不在 + 没有播放记忆」：两者都成立说明这个房间既没人在播、
// 也没人可能在播，运行时状态（影片列表、字幕、当前影片）留着只是泄漏。
func (s *Service) CleanupStaleStates(isHostOnline func(roomID string) bool) {
	if isHostOnline == nil {
		isHostOnline = func(string) bool { return false }
	}

	// 先在锁外判定，再回锁删除：isHostOnline 会去读播放记忆（另一把锁）
	// 与连接表，持锁调用等于把两把锁串起来，容易和广播路径形成环。
	s.mu.Lock()
	ids := make([]string, 0, len(s.states))
	for roomID := range s.states {
		ids = append(ids, roomID)
	}
	s.mu.Unlock()

	for _, roomID := range ids {
		if isHostOnline(roomID) || s.Playback.HasCache(roomID) {
			continue
		}
		s.Delete(roomID)
		s.CancelReconnectTimer(roomID)
	}
}
