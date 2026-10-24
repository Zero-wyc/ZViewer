package room

import (
	"context"
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
