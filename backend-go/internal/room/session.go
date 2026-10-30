package room

import (
	"context"
	"errors"
	"time"

	"zviewer/backend/internal/store"
)

// 会话相关的业务错误。文案与 Node 抛出的 Error.message 一致——
// 这些文案会经 ack 的 message 字段原样透给用户。
var (
	ErrRoomClosed   = errors.New("房间已关闭")
	ErrViewerGone   = errors.New("观看者已断开连接")
	ErrRoomFull     = errors.New("房间观看人数已达上限")
	ErrNoPermission = errors.New("无权限")
)

// HostResult 是房主注册（首次或重连）后回给前端的信息。
type HostResult struct {
	Mode            string
	ShareMethod     string
	Name            *string
	StreamKey       *string
	RequireApproval bool
	// Playback 为 nil 时 ack 里整个 playback 键消失（复刻 undefined）。
	Playback *Playback
}

// RegisterHost 注册房主（首次创建或断线重连）。
//
// 房间不存在 / 非 active / 归属不匹配时返回 (nil, nil)：调用方按
// 「房间不存在或无权限」统一回绝，不区分具体原因（与 Node 一致，
// 避免把「房间存在但不是你的」暴露给探测者）。
func (s *Service) RegisterHost(ctx context.Context, socketID, roomID string, userID int64) (*HostResult, error) {
	room, err := s.Rooms.FindByRoomID(ctx, roomID)
	if err != nil {
		if errors.Is(err, store.ErrRoomNotFound) {
			return nil, nil
		}
		return nil, err
	}
	if room.Status != "active" {
		return nil, nil
	}
	// ownerUserId 为 null 的房间（游客创建后升级登录、或历史数据）允许
	// 任何非游客用户接管：把当前用户写成 owner。
	if room.OwnerUserID != nil && *room.OwnerUserID != userID {
		return nil, nil
	}
	if room.OwnerUserID == nil {
		uid := userID
		if err := s.Rooms.SetOwner(ctx, roomID, &uid); err != nil {
			return nil, err
		}
	}

	s.CancelReconnectTimer(roomID)
	s.clearStreamOffline(roomID)

	// 复用已有 sharer 会话（重连场景），否则新建。
	existing, err := s.Sessions.FindActiveByRoomRole(ctx, roomID, store.SessionRoleSharer)
	if err != nil {
		return nil, err
	}
	if existing != nil {
		if err := s.Sessions.UpdateReuse(ctx, existing.ID, userID, socketID); err != nil {
			return nil, err
		}
	} else {
		if err := s.Sessions.Create(ctx, &store.Session{
			RoomID:   roomID,
			SocketID: socketID,
			Role:     store.SessionRoleSharer,
			UserID:   &userID,
		}); err != nil {
			return nil, err
		}
	}
	// session 变了，权限缓存必须立刻失效（否则重连后仍按旧会话判定）。
	s.perm.invalidate(socketID, roomID)

	if err := s.Rooms.TouchLastAccess(ctx, roomID); err != nil {
		return nil, err
	}
	if err := s.Playback.UpdateHostSocket(ctx, roomID, &socketID); err != nil {
		// 没有播放状态时这里只是「没更新到」，不影响房主上线。
		s.Logger.Printf("[room] 更新房主 socket 失败 %s: %v", roomID, err)
	}

	// 优先用推算后的状态（房主刷新期间视频仍在「播放」），没有则退回内存缓存。
	playback, err := s.Playback.Advanced(ctx, roomID)
	if err != nil {
		playback = s.GetPlayback(roomID)
	}

	return &HostResult{
		Mode:            room.Mode,
		ShareMethod:     room.ShareMethod,
		Name:            room.Name,
		StreamKey:       room.StreamKey,
		RequireApproval: room.RequireApproval,
		Playback:        playback,
	}, nil
}

// AdmitViewer 让观众进入房间（创建 viewer 会话）。
//
// 同房间的准入是**串行**的：人数上限校验与插入之间若有并发，
// 两个请求会同时读到 n-1 然后双双通过，房间就超员了。Node 侧用
// Promise 链做同一件事，这里换成互斥锁。
func (s *Service) AdmitViewer(ctx context.Context, socketID, roomID string, userID *int64, guestID *string) (*store.Session, error) {
	s.admitMu.Lock()
	defer s.admitMu.Unlock()

	existing, err := s.Sessions.FindActiveByRoomSocket(ctx, roomID, socketID)
	if err != nil {
		return nil, err
	}
	if existing != nil {
		return existing, nil
	}

	room, err := s.Rooms.FindByRoomID(ctx, roomID)
	if err != nil {
		if errors.Is(err, store.ErrRoomNotFound) {
			return nil, ErrRoomClosed
		}
		return nil, err
	}
	if room.Status != "active" {
		return nil, ErrRoomClosed
	}
	if s.Hub != nil && !s.Hub.Connected(socketID) {
		return nil, ErrViewerGone
	}
	count, err := s.Sessions.CountActiveByRoomRole(ctx, roomID, store.SessionRoleViewer)
	if err != nil {
		return nil, err
	}
	// 注意 `>=`：maxViewers=1 时第一个人进来前 count=0，允许；第二个人时
	// count=1 就已经满了。
	if count >= room.MaxViewers {
		return nil, ErrRoomFull
	}

	if err := s.Rooms.TouchLastAccess(ctx, roomID); err != nil {
		return nil, err
	}

	sess := &store.Session{
		RoomID:   roomID,
		SocketID: socketID,
		Role:     store.SessionRoleViewer,
		UserID:   userID,
	}
	// 只有游客（userId=0）才记 guestId；登录用户记了也没用，
	// 反而会让「同账号多端」判定按 guestId 走。
	if userID != nil && *userID == 0 {
		sess.GuestID = guestID
	}
	if err := s.Sessions.Create(ctx, sess); err != nil {
		return nil, err
	}
	// 清掉待审批标记。Node 侧 admitViewer 里也是**只在新建成会话时**清
	// （上面的「已在房间」早退路径不清）。不清的话房主批准之后再点「拒绝」
	// 仍然会成功——reject-join 就是靠这个标记判断有没有待审批申请。
	if s.Hub != nil {
		s.Hub.DeleteSocketData(socketID, pendingRoomIDKey)
	}
	s.perm.invalidate(socketID, roomID)
	return sess, nil
}

// EndSession 结束某 socket 的活跃会话。
//
// 返回 nil 表示该 socket 本来就不在任何房间里（重复断线回调、未进房就断开）。
func (s *Service) EndSession(ctx context.Context, socketID string) (*store.Session, error) {
	sess, err := s.Sessions.FindActiveBySocket(ctx, socketID)
	if err != nil || sess == nil {
		return nil, err
	}
	if _, err := s.Sessions.EndBySocket(ctx, socketID); err != nil {
		return nil, err
	}
	s.perm.invalidate(socketID, "")
	return sess, nil
}

// Viewers 返回房间内所有活跃观众会话。
func (s *Service) Viewers(ctx context.Context, roomID string) ([]*store.Session, error) {
	return s.Sessions.ListActiveByRoomRole(ctx, roomID, store.SessionRoleViewer)
}

// Sharer 返回房间内活跃房主会话（无则 nil）。
func (s *Service) Sharer(ctx context.Context, roomID string) (*store.Session, error) {
	return s.Sessions.FindActiveByRoomRole(ctx, roomID, store.SessionRoleSharer)
}

// ViewerCount 返回房间内活跃观众数（不含房主）。
func (s *Service) ViewerCount(ctx context.Context, roomID string) (int64, error) {
	return s.Sessions.CountActiveByRoomRole(ctx, roomID, store.SessionRoleViewer)
}

// IsSharerOnline 判断房主是否在线。
func (s *Service) IsSharerOnline(ctx context.Context, roomID string) (bool, error) {
	sharer, err := s.Sharer(ctx, roomID)
	return sharer != nil, err
}

// RecentSharer 返回「视为在场」的房主会话。
//
// 房主已断开但结束时间在 maxAge 内时仍算在场：观众在房主短暂掉线时
// 应该还能进房间看到内容，而不是被一句「分享端不在线」挡在门外。
func (s *Service) RecentSharer(ctx context.Context, roomID string, maxAge time.Duration) (*store.Session, error) {
	sess, err := s.Sessions.FindLatestByRoomRole(ctx, roomID, store.SessionRoleSharer)
	if err != nil || sess == nil {
		return nil, err
	}
	if sess.EndedAt == nil {
		return sess, nil
	}
	if time.Since(*sess.EndedAt) <= maxAge {
		return sess, nil
	}
	return nil, nil
}

// ActiveSessionByUser 查同一用户在同一房间的活跃会话（游客返回 nil）。
func (s *Service) ActiveSessionByUser(ctx context.Context, roomID string, userID *int64) (*store.Session, error) {
	if userID == nil {
		return nil, nil
	}
	return s.Sessions.FindActiveByRoomUser(ctx, roomID, *userID)
}

// ActiveSession 查某 socket 当前的活跃会话（跨房间）。
func (s *Service) ActiveSession(ctx context.Context, socketID string) (*store.Session, error) {
	return s.Sessions.FindActiveBySocket(ctx, socketID)
}

// SharerBySocketID 按 socket 查它作为房主的活跃会话（跨房间）。
func (s *Service) SharerBySocketID(ctx context.Context, socketID string) (*store.Session, error) {
	sess, err := s.Sessions.FindActiveBySocket(ctx, socketID)
	if err != nil || sess == nil {
		return nil, err
	}
	if sess.Role != store.SessionRoleSharer {
		return nil, nil
	}
	return sess, nil
}
