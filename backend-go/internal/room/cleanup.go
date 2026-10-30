package room

import (
	"context"
	"sync"
	"time"
)

// 房间清理定时任务，对应 modules/room/room-cleanup.service.ts。
//
// 每小时扫一遍「状态 active 但长期没人访问」的房间并物理删除。
// 与「房主掉线宽限期到点关闭」（CloseAfterHostGrace）是两件事：
//   - 宽限期只把 status 置成 closed，房间行还在；
//   - 这里按 lastAccessedAt 兜底清库，把 closed 之外的漏网房间也收掉。

// CleanupInterval 是清理周期（1 小时）。
const CleanupInterval = time.Hour

// CleanupInactiveRooms 删除超过阈值未访问的活跃房间，返回删除数量。
//
// 失败只记日志、不打断调用方（定时任务里抛错等于把这一轮静默丢掉）。
func (s *Service) CleanupInactiveRooms(ctx context.Context) int {
	if s.Settings == nil || s.Rooms == nil {
		return 0
	}
	settings, err := s.Settings.Get(ctx)
	if err != nil {
		s.logf("读取系统设置失败，跳过本轮房间清理: %v", err)
		return 0
	}
	if !settings.AutoDeleteInactiveRooms {
		s.logf("自动删除无人房间已关闭，跳过清理")
		return 0
	}

	hours := settings.AutoDeleteAfterHours
	if hours < 0 {
		hours = 0
	}
	threshold := time.Now().Add(-time.Duration(hours) * time.Hour)

	roomIDs, err := s.Rooms.ListStaleActive(ctx, threshold)
	if err != nil {
		s.logf("查询待清理房间失败: %v", err)
		return 0
	}

	removed := 0
	for _, roomID := range roomIDs {
		room, err := s.Rooms.FindByRoomID(ctx, roomID)
		if err != nil {
			s.logf("读取待清理房间 %s 失败: %v", roomID, err)
			continue
		}
		if s.IsStreamPublishing(room) {
			continue
		}
		if err := s.DeleteRoomAndRelations(ctx, roomID); err != nil {
			s.logf("清理房间 %s 失败: %v", roomID, err)
			continue
		}
		removed++
	}
	s.logf("已清理 %d 个长期无人访问的房间（阈值 %d 小时）", removed, hours)
	return removed
}

// StartCleanupScheduler 启动周期性清理：**启动即跑一轮**，之后每小时一轮。
//
// 返回的 stop 用于优雅退出（关掉定时器并等当前这一轮结束）。
// 启动即跑一轮不能省：进程重启前挂着「早该清掉」的房间，等一小时才清
// 会让首屏列表里一直躺着僵尸房间。
func (s *Service) StartCleanupScheduler(ctx context.Context) (stop func()) {
	ctx, cancel := context.WithCancel(ctx)
	ticker := time.NewTicker(CleanupInterval)
	done := make(chan struct{})

	go func() {
		defer close(done)
		defer cancel()
		s.CleanupInactiveRooms(ctx)
		for {
			select {
			case <-ticker.C:
				s.CleanupInactiveRooms(ctx)
			case <-ctx.Done():
				return
			}
		}
	}()

	var stopOnce sync.Once
	return func() {
		stopOnce.Do(func() {
			cancel()
			ticker.Stop()
		})
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			// 单轮清理卡住（比如 DB 被锁）时不要拖着整个进程退出。
		}
	}
}

// logf 是带空判断的日志（测试里 Logger 可能是 nil）。
func (s *Service) logf(format string, args ...any) {
	if s.Logger != nil {
		s.Logger.Printf(format, args...)
	}
}
