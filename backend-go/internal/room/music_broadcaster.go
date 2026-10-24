package room

import (
	"context"
	"log"
	"sync"
	"time"

	"zviewer/backend/internal/store"
)

// 一起听的服务器心跳广播器。
//
// 服务器每 2s 恒定广播 music:sync-heartbeat(source='server')，房主在线与否
// 走同一条进度路径——观众进度统一以服务器推算值（基线已做写侧补偿）为权威，
// 房主的 music:sync-state / host-heartbeat 降级为「基线更新通道」
// （旧转发保留：旧前端兼容 + 新前端在 7s 无服务器心跳时 fallback）。
//
// 与一起看广播器的两条差异：
//   - 事件名是 music:sync-heartbeat，载荷里带 roomId（一起看那条是统一协议，
//     刻意不带 roomId 以免两条协议分叉；音乐这条前端按 roomId 过滤残留事件）。
//   - hostOnline 随每次心跳下发：覆盖「观众在房主离线后才加入 / socket 重连
//     错过 host-disconnected」的场景——get-state 只在加入时查一次。

const (
	// musicHeartbeatInterval 是服务器推算状态的广播间隔。
	musicHeartbeatInterval = 2 * time.Second
	// musicCleanupInterval 是陈旧内存缓存的清理间隔。
	musicCleanupInterval = 30 * time.Second
	// musicHostOnlineCacheTTL 是房主在线判定的缓存时间（避免每 2s × 每房间打库）。
	musicHostOnlineCacheTTL = 5 * time.Second
)

// musicSyncHeartbeatPayload 是 music:sync-heartbeat 的载荷。
type musicSyncHeartbeatPayload struct {
	RoomID     string          `json:"roomId"`
	Source     string          `json:"source"`
	State      *MusicSyncState `json:"state"`
	HostOnline bool            `json:"hostOnline"`
}

type musicHostOnlineEntry struct {
	online bool
	at     time.Time
}

// MusicBroadcaster 是音乐服务器心跳与缓存清理的定时器。
type MusicBroadcaster struct {
	svc    *Service
	logger *log.Logger

	stopOnce sync.Once
	stopCh   chan struct{}
	wg       sync.WaitGroup

	mu    sync.Mutex
	hosts map[string]musicHostOnlineEntry
}

// NewMusicBroadcaster 构造广播器。需显式 Start 才开始计时。
func NewMusicBroadcaster(svc *Service, logger *log.Logger) *MusicBroadcaster {
	if logger == nil {
		logger = log.Default()
	}
	return &MusicBroadcaster{
		svc:    svc,
		logger: logger,
		stopCh: make(chan struct{}),
		hosts:  make(map[string]musicHostOnlineEntry),
	}
}

// Start 启动两个定时器（心跳 2s / 清理 30s）。重复调用无副作用。
func (b *MusicBroadcaster) Start() {
	if b == nil || b.svc == nil || b.svc.Music == nil {
		return
	}
	b.wg.Add(2)
	go b.loop(musicHeartbeatInterval, b.broadcastAll)
	go b.loop(musicCleanupInterval, b.cleanupOnce)
}

// Stop 停止定时器并等待在途的一轮结束。
func (b *MusicBroadcaster) Stop() {
	if b == nil {
		return
	}
	b.stopOnce.Do(func() { close(b.stopCh) })
	b.wg.Wait()
}

func (b *MusicBroadcaster) loop(interval time.Duration, fn func()) {
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

// broadcastAll 遍历所有有基线的房间，下发推算后的状态。
func (b *MusicBroadcaster) broadcastAll() {
	hub := b.svc.Hub
	if hub == nil || b.svc.Music == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	for _, roomID := range b.svc.Music.ActiveRoomIDs() {
		// 房间没人时跳过：不对着空房间每 2s 序列化一次。
		// 注意**不按房主在线跳过**——服务器心跳是观众进度的唯一权威来源，
		// 房主在线时同样要发（前端两边都收，按 source 区分）。
		if hub.MemberCount(roomID) == 0 {
			continue
		}
		state, err := b.svc.Music.GetAdvancedState(ctx, roomID)
		if err != nil {
			b.logger.Printf("[music-heartbeat] 读取基线失败 room=%s: %v", roomID, err)
			continue
		}
		if state == nil {
			continue
		}
		hub.EmitRoom(roomID, "music:sync-heartbeat", musicSyncHeartbeatPayload{
			RoomID:     roomID,
			Source:     "server",
			State:      state,
			HostOnline: b.isHostOnlineCached(ctx, roomID),
		})
	}
}

// cleanupOnce 清理陈旧的内存缓存（房主长期离线的房间）。
func (b *MusicBroadcaster) cleanupOnce() {
	if b.svc.Music == nil {
		return
	}
	b.svc.Music.CleanupStaleCache()

	// 顺手让房主在线缓存过期，避免清理后仍拿着 5s 前的判定。
	b.mu.Lock()
	for roomID, entry := range b.hosts {
		if time.Since(entry.at) > musicHostOnlineCacheTTL {
			delete(b.hosts, roomID)
		}
	}
	b.mu.Unlock()
}

// isHostOnlineCached 查询房间房主在线状态（5s TTL）。
//
// 查询失败按离线处理：观众端进入自主控制模式，比误判「房主还在」安全——
// 后者会让观众的控制申请发出去却永远没人应答。
func (b *MusicBroadcaster) isHostOnlineCached(ctx context.Context, roomID string) bool {
	b.mu.Lock()
	if entry, ok := b.hosts[roomID]; ok && time.Since(entry.at) < musicHostOnlineCacheTTL {
		online := entry.online
		b.mu.Unlock()
		return online
	}
	b.mu.Unlock()

	online := false
	if b.svc.Sessions != nil {
		sharer, err := b.svc.Sessions.FindActiveByRoomRole(ctx, roomID, store.SessionRoleSharer)
		if err != nil {
			b.logger.Printf("[music-heartbeat] 查询房主失败 room=%s: %v", roomID, err)
		} else {
			online = sharer != nil
		}
	}

	b.mu.Lock()
	b.hosts[roomID] = musicHostOnlineEntry{online: online, at: time.Now()}
	b.mu.Unlock()
	return online
}
