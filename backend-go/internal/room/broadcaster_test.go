package room

import (
	"context"
	"database/sql"
	"testing"
	"time"
)

// seedPlayback 直接往播放记忆里塞一条状态（绕过 socket 事件）。
func seedPlayback(t *testing.T, env *testEnv, roomID string, hostSocketID string, updatedAt int64) {
	t.Helper()
	pm := env.svc.Playback
	pm.mu.Lock()
	state := &Playback{
		SourceURL:    "https://example.com/a.m3u8",
		SourceType:   "url",
		IsPlaying:    true,
		CurrentTime:  10,
		PlaybackRate: 1,
		Duration:     3600,
		UpdatedAt:    updatedAt,
	}
	if hostSocketID != "" {
		sid := hostSocketID
		state.HostSocketID = &sid
	}
	pm.cache[roomID] = &cachedPlayback{state: state, lastDBWriteAt: 0, dirty: true}
	pm.mu.Unlock()
}

func playbackRowExists(t *testing.T, db *sql.DB, roomID string) bool {
	t.Helper()
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM "playback_states" WHERE "roomId" = ?`, roomID).Scan(&n); err != nil {
		t.Fatalf("查询播放状态失败: %v", err)
	}
	return n > 0
}

func TestIsHostOnlineUsesCachedSocketID(t *testing.T) {
	env := newTestEnv(t)
	ctx := context.Background()
	owner := int64(1)
	env.insertRoom(t, "ROOMB001", &owner, 10, false)
	seedPlayback(t, env, "ROOMB001", "sock-host", time.Now().UnixMilli())

	connected := func(id string) bool { return id == "sock-host" }
	if !env.svc.Playback.IsHostOnline("ROOMB001", connected) {
		t.Error("hostSocketId 在线时应判定为在线")
	}
	if env.svc.Playback.IsHostOnline("ROOMB001", func(string) bool { return false }) {
		t.Error("连接已断开时应判定为离线")
	}
	// 没有连接信息时按「有人」处理：宁可不清缓存，也不要误删
	if !env.svc.Playback.IsHostOnline("ROOMB001", nil) {
		t.Error("connected 为 nil 时应按在线处理")
	}
	// 没有 hostSocketId（房主从没广播过）一律离线
	seedPlayback(t, env, "ROOMB001", "", time.Now().UnixMilli())
	if env.svc.Playback.IsHostOnline("ROOMB001", connected) {
		t.Error("没有 hostSocketId 时应判定为离线")
	}
	_ = ctx
}

func TestCleanupStaleCacheKeepsFreshAndFlushesDirty(t *testing.T) {
	env := newTestEnv(t)
	ctx := context.Background()
	owner := int64(1)
	// 三个房间：新鲜的、陈旧的、房主在线的陈旧房间
	env.insertRoom(t, "ROOMC001", &owner, 10, false)
	env.insertRoom(t, "ROOMC002", &owner, 10, false)
	env.insertRoom(t, "ROOMC003", &owner, 10, false)

	now := time.Now().UnixMilli()
	seedPlayback(t, env, "ROOMC001", "sock-1", now)                                      // 新鲜
	seedPlayback(t, env, "ROOMC002", "sock-2", now-cacheStaleThreshold.Milliseconds()-1) // 陈旧且房主离线
	seedPlayback(t, env, "ROOMC003", "sock-3", now-cacheStaleThreshold.Milliseconds()-1) // 陈旧但房主在线

	env.svc.Playback.CleanupStaleCache(ctx, func(roomID string) bool {
		return roomID == "ROOMC003"
	})

	if !env.svc.Playback.HasCache("ROOMC001") {
		t.Error("新鲜缓存不应被清理")
	}
	if env.svc.Playback.HasCache("ROOMC002") {
		t.Error("陈旧且房主离线的缓存应被清理")
	}
	if !env.svc.Playback.HasCache("ROOMC003") {
		t.Error("房主仍在线的缓存不应被清理")
	}
	// 清理是「缓存 + DB 记录」一起删（与 Node 一致）：陈旧的播放状态
	// 既不该占内存，也不该留在库里等下次重启又被读出来。
	if playbackRowExists(t, env.db, "ROOMC002") {
		t.Error("陈旧缓存的 DB 记录也应被清除")
	}
}

func TestFlushAllDirtyWritesToDB(t *testing.T) {
	env := newTestEnv(t)
	ctx := context.Background()
	owner := int64(1)
	env.insertRoom(t, "ROOMH001", &owner, 10, false)
	seedPlayback(t, env, "ROOMH001", "sock-1", time.Now().UnixMilli())

	if playbackRowExists(t, env.db, "ROOMH001") {
		t.Fatal("前置条件：落盘前不应有 DB 记录")
	}
	env.svc.Playback.FlushAllDirty(ctx)
	if !playbackRowExists(t, env.db, "ROOMH001") {
		t.Error("退出前应把所有脏数据落盘，否则最多丢 2s 进度")
	}
}

func TestCleanupStaleStatesDropsOrphanState(t *testing.T) {
	env := newTestEnv(t)
	owner := int64(1)
	env.insertRoom(t, "ROOMD001", &owner, 10, false)
	env.insertRoom(t, "ROOMD002", &owner, 10, false)
	env.insertRoom(t, "ROOMD003", &owner, 10, false)

	env.svc.SetMovies("ROOMD001", []any{map[string]any{"id": 1}}, []int64{1})
	env.svc.SetMovies("ROOMD002", []any{map[string]any{"id": 2}}, []int64{2})
	env.svc.SetMovies("ROOMD003", []any{map[string]any{"id": 3}}, []int64{3})
	// ROOMD002 有播放记忆 → 就算房主不在也不能删（观众可能还在同步）
	seedPlayback(t, env, "ROOMD002", "sock-gone", time.Now().UnixMilli())

	env.svc.CleanupStaleStates(func(roomID string) bool { return roomID == "ROOMD003" })

	if env.svc.HasState("ROOMD001") {
		t.Error("无主且无播放记忆的运行时状态应被清理")
	}
	if !env.svc.HasState("ROOMD002") {
		t.Error("仍有播放记忆时不应清理运行时状态")
	}
	if !env.svc.HasState("ROOMD003") {
		t.Error("房主在线时不应清理运行时状态")
	}
}

func TestBroadcastAllSkipsEmptyRooms(t *testing.T) {
	env := newTestEnv(t)
	owner := int64(1)
	env.insertRoom(t, "ROOME001", &owner, 10, false)
	env.insertRoom(t, "ROOME002", &owner, 10, false)
	seedPlayback(t, env, "ROOME001", "sock-1", time.Now().UnixMilli())
	seedPlayback(t, env, "ROOME002", "sock-2", time.Now().UnixMilli())

	// 只有 ROOME001 里有连接
	env.hub.members["ROOME001"] = []string{"sock-1"}

	b := NewBroadcaster(env.svc, nil)
	b.broadcastAll()

	if !env.hub.hasRoomEvent("ROOME001", "server-heartbeat") {
		t.Error("有成员的房间应收到 server-heartbeat")
	}
	if !env.hub.hasRoomEvent("ROOME001", "sync-heartbeat") {
		t.Error("有成员的房间应收到 sync-heartbeat")
	}
	if env.hub.hasRoomEvent("ROOME002", "server-heartbeat") {
		t.Error("无成员的房间不应广播心跳")
	}

	// 两条心跳都发：房主端与观众端各认一条，缺哪条都有前端分支收不到
	count := 0
	for _, e := range env.hub.rooms {
		if e == "ROOME001|server-heartbeat" || e == "ROOME001|sync-heartbeat" {
			count++
		}
	}
	if count != 2 {
		t.Errorf("每轮应发 2 条心跳，实际 %d", count)
	}
}

func TestBroadcastSkipsRoomWithoutPlayback(t *testing.T) {
	env := newTestEnv(t)
	owner := int64(1)
	env.insertRoom(t, "ROOMF001", &owner, 10, false)
	env.hub.members["ROOMF001"] = []string{"sock-1"}
	// 只有运行时状态，没有播放记忆
	env.svc.SetMovies("ROOMF001", []any{}, []int64{})

	b := NewBroadcaster(env.svc, nil)
	b.broadcastAll()

	if env.hub.hasRoomEvent("ROOMF001", "server-heartbeat") {
		t.Error("没有播放记忆的房间不应广播心跳")
	}
}

func TestHostOnlineCacheTTL(t *testing.T) {
	env := newTestEnv(t)
	owner := int64(1)
	env.insertRoom(t, "ROOMG001", &owner, 10, false)
	// 没有活跃房主会话 → 离线
	b := NewBroadcaster(env.svc, nil)
	if b.isHostOnlineCached("ROOMG001") {
		t.Error("没有房主会话时应判定离线")
	}

	// 手动塞一条「在线」缓存，TTL 内不再查库
	b.hosts["ROOMG001"] = hostOnlineEntry{online: true, at: time.Now()}
	if !b.isHostOnlineCached("ROOMG001") {
		t.Error("TTL 内应直接返回缓存值")
	}
	// 过期后回到实际查询结果
	b.hosts["ROOMG001"] = hostOnlineEntry{online: true, at: time.Now().Add(-2 * hostOnlineCacheTTL)}
	if b.isHostOnlineCached("ROOMG001") {
		t.Error("缓存过期后应重新查询（此时没有房主会话，应为离线）")
	}
}
