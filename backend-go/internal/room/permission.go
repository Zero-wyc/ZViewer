package room

import (
	"context"
	"encoding/json"
	"errors"

	"zviewer/backend/internal/store"
)

// 用户角色取值（与 Node 的 UserRole 一致）。
const (
	RoleGuest = "guest"
	RoleUser  = "user"
	RoleAdmin = "admin"
	RoleRoot  = "root"
)

// CanCreateRoom 判断角色能否创建房间。
//
// 规则由系统设置 roomCreationMode 决定，**不要**在 handler 里硬编码：
// - guest 永远禁止
// - root / admin 永远允许
// - user 仅在 all-users 模式允许
func CanCreateRoom(role string, settings *store.SystemSettings) bool {
	if role == RoleGuest {
		return false
	}
	if role == RoleRoot || role == RoleAdmin {
		return true
	}
	if settings == nil {
		// 读不到设置时按默认模式（admin-only）处理：宁可少放人进来。
		return false
	}
	return settings.RoomCreationMode == "all-users"
}

// IsRoomHost 判断 socket 是否为该房间的活跃房主（带 5s 缓存）。
func (s *Service) IsRoomHost(ctx context.Context, socketID, roomID string) (bool, error) {
	key := permKey(socketID, roomID, "isRoomHost")
	if v, ok := s.perm.get(key); ok {
		return v, nil
	}
	sess, err := s.Sessions.FindActiveByRoomSocket(ctx, roomID, socketID)
	if err != nil {
		return false, err
	}
	result := sess != nil && sess.Role == store.SessionRoleSharer
	s.perm.set(key, result)
	return result, nil
}

// IsInRoom 判断 socket 是否在该房间内（任意角色，带 5s 缓存）。
func (s *Service) IsInRoom(ctx context.Context, socketID, roomID string) (bool, error) {
	key := permKey(socketID, roomID, "isInRoom")
	if v, ok := s.perm.get(key); ok {
		return v, nil
	}
	sess, err := s.Sessions.FindActiveByRoomSocket(ctx, roomID, socketID)
	if err != nil {
		return false, err
	}
	result := sess != nil
	s.perm.set(key, result)
	return result, nil
}

// IsRoomModerator 判断 socket 是否为该房间房管（带 5s 缓存）。
//
// 房管由房主任命（room.moderators，userId JSON 数组），房主**不在**这个名单里
// ——房主身份只看 sharer session，混进名单会让前端给房主多显示一个「房管」徽标。
func (s *Service) IsRoomModerator(ctx context.Context, socketID, roomID string) (bool, error) {
	key := permKey(socketID, roomID, "isRoomModerator")
	if v, ok := s.perm.get(key); ok {
		return v, nil
	}
	uid := s.socketUserID(socketID)
	if uid == nil || *uid <= 0 {
		s.perm.set(key, false)
		return false, nil
	}
	mods := s.Moderators(ctx, roomID)
	result := false
	for _, id := range mods {
		if id == *uid {
			result = true
			break
		}
	}
	s.perm.set(key, result)
	return result, nil
}

// CanViewerPerform 判定「房内某动作」是否允许（管理员设置页的权限矩阵）。
//
// 短路顺序与 Node 一致，不要重排：
//  1. 房主：一律允许（房主是房间里唯一的内容源，不受矩阵约束）
//  2. root：一律允许
//  3. 房管 / admin / user：查 roomPermissionMatrix 里该动作对应的开关，
//     矩阵未覆盖时按兼容默认（房管 ✓ / admin ✓ / user ✗）
//  4. guest：拒绝
func (s *Service) CanViewerPerform(ctx context.Context, socketID, role, roomID, action string) (bool, error) {
	if host, err := s.IsRoomHost(ctx, socketID, roomID); err == nil && host {
		return true, nil
	} else if err != nil {
		return false, err
	}
	if role == RoleRoot {
		return true, nil
	}
	// Settings 可能为 nil（单测与最小装配）：退化为「矩阵未覆盖」的默认值，
	// 否则整个判定会在这里空指针崩掉，而不是给出一个可解释的结果。
	var settings *store.SystemSettings
	if s.Settings != nil {
		if row, err := s.Settings.Get(ctx); err == nil {
			settings = row
		}
	}
	isMod, err := s.IsRoomModerator(ctx, socketID, roomID)
	if err != nil {
		return false, err
	}
	if isMod {
		return matrixAllow(settings, action, "moderator"), nil
	}
	switch role {
	case RoleAdmin:
		return matrixAllow(settings, action, "admin"), nil
	case RoleUser:
		return matrixAllow(settings, action, "user"), nil
	}
	return false, nil
}

// matrixAllow 读矩阵开关，缺省值与 Node 兼容默认一致。
func matrixAllow(settings *store.SystemSettings, action, field string) bool {
	if settings == nil || len(settings.RoomPermissionMatrix) == 0 {
		// 矩阵整列为空：房管/admin 允许、user 拒绝。
		return field != "user"
	}
	var matrix map[string]map[string]bool
	if err := json.Unmarshal(settings.RoomPermissionMatrix, &matrix); err != nil {
		return field != "user"
	}
	entry, ok := matrix[action]
	if !ok {
		return field != "user"
	}
	allowed, ok := entry[field]
	if !ok {
		return field != "user"
	}
	// user 缺省拒绝（必须显式为 true），房管/admin 缺省允许（只有 false 才拒）。
	if field == "user" {
		return allowed
	}
	return allowed
}

// CanModeratorActOn 做房管防篡权校验：房管能否对该目标执行管理动作。
//
// 返回空串表示允许；否则是拒绝原因（直接作为 ack 的 message 下发，文案与
// Node 逐字一致）。房主本人不走这里——房主可以操作任何人。
//
// 游客（userID<=0）一律放行：游客之间没有身份可篡。
func (s *Service) CanModeratorActOn(ctx context.Context, roomID string, targetUserID *int64, targetRole string) (string, error) {
	if targetRole == RoleRoot {
		return "不能对管理员操作", nil
	}
	if targetUserID == nil || *targetUserID <= 0 {
		return "", nil
	}
	room, roomErr := s.Rooms.FindByRoomID(ctx, roomID)
	if roomErr != nil && !errors.Is(roomErr, store.ErrRoomNotFound) {
		return "", roomErr
	}
	if room != nil && room.OwnerUserID != nil && *room.OwnerUserID == *targetUserID {
		return "不能对房主操作", nil
	}
	mods := s.Moderators(ctx, roomID)
	for _, id := range mods {
		if id == *targetUserID {
			return "不能对房管操作", nil
		}
	}
	return "", nil
}

// SetModerators 写房管名单并立刻失效该房间的权限缓存。
//
// 必须同步失效：任命/撤销房管后如果还留着 5s 旧结果，新晋房管点不动管理按钮，
// 被撤的人反而还能继续操作。
func (s *Service) SetModerators(ctx context.Context, roomID string, ids []int64) error {
	if err := s.Rooms.SetModerators(ctx, roomID, ids); err != nil {
		return err
	}
	s.perm.invalidate("", roomID)
	return nil
}

// IsMuted 判断用户是否在房间禁言名单里。
func (s *Service) IsMuted(ctx context.Context, roomID string, userID int64) (bool, error) {
	room, err := s.Rooms.FindByRoomID(ctx, roomID)
	if errors.Is(err, store.ErrRoomNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return idListContains(room.MutedViewers, userID), nil
}

// GetOrReactivateSharer 取当前 socket 的 sharer 会话，带 socket 重连自愈。
//
// register-host 之后 sharer 会话的 socketId 一般已经更新，但存在竞态：
// 重连后先到的 update-room-mode 仍带着旧 socketId，按 socketId 查不到人。
// 此时如果调用者确实是房间 owner（或 root），就把最新一条 sharer 会话
// 改挂到当前 socket 上——否则重连后第一次切模式必然报「无权限」。
func (s *Service) GetOrReactivateSharer(ctx context.Context, socketID, roomID string, userID int64, role string) (*store.Session, error) {
	sess, err := s.Sessions.FindActiveByRoomSocket(ctx, roomID, socketID)
	if err != nil {
		return nil, err
	}
	if sess != nil && sess.Role == store.SessionRoleSharer {
		return sess, nil
	}

	room, err := s.Rooms.FindByRoomID(ctx, roomID)
	if errors.Is(err, store.ErrRoomNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if room.Status != "active" {
		return nil, nil
	}
	isOwner := role == RoleRoot || room.OwnerUserID == nil || *room.OwnerUserID == userID
	if !isOwner {
		return nil, nil
	}
	latest, err := s.Sessions.FindLatestByRoomRole(ctx, roomID, store.SessionRoleSharer)
	if err != nil || latest == nil {
		return nil, err
	}
	if err := s.Sessions.UpdateReuse(ctx, latest.ID, userID, socketID); err != nil {
		return nil, err
	}
	latest.SocketID = socketID
	latest.UserID = &userID
	latest.EndedAt = nil
	s.perm.invalidate(socketID, roomID)
	return latest, nil
}

// idListContains 判断 JSON 数组列里是否含该 ID（解析失败按「不含」）。
func idListContains(raw string, userID int64) bool {
	if raw == "" {
		return false
	}
	var ids []int64
	if err := json.Unmarshal([]byte(raw), &ids); err != nil {
		return false
	}
	for _, id := range ids {
		if id == userID {
			return true
		}
	}
	return false
}

// socketUserID 读取连接上的 userId（缺失视为游客）。
func (s *Service) socketUserID(socketID string) *int64 {
	if s.Hub == nil {
		return nil
	}
	return userIDFromData(s.Hub.SocketData(socketID))
}

// ErrNotHost 表示当前 socket 不是该房间房主。
var ErrNotHost = errors.New("无权限：仅房主可执行此操作")

// RequireHost 是 IsRoomHost 的便捷包装：不是房主时返回 ErrNotHost。
func (s *Service) RequireHost(ctx context.Context, socketID, roomID string) error {
	ok, err := s.IsRoomHost(ctx, socketID, roomID)
	if err != nil {
		return err
	}
	if !ok {
		return ErrNotHost
	}
	return nil
}
