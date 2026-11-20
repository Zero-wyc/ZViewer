package room

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"zviewer/backend/internal/sio"
	"zviewer/backend/internal/store"
)

// MusicPermission 是房间级「点歌权限」配置，对应 room.MusicPermission 列。
//
// 语义（与前端契约一致）：
//   - allowMembers：成员（非房主/房管/矩阵放行者）默认可否点歌；
//   - allowedUserIds：逐用户白名单，命中即允许（优先于 allowMembers）；
//   - deniedUserIds：逐用户黑名单，命中即拒绝（优先于白名单）；
//   - 游客没有 userId，只受 allowMembers 控制。
type MusicPermission struct {
	AllowMembers   bool    `json:"allowMembers"`
	AllowedUserIDs []int64 `json:"allowedUserIds"`
	DeniedUserIDs  []int64 `json:"deniedUserIds"`
}

// ParseMusicPermission 解析房间列里的原始 JSON。
//
// 空串 / "{}" / null / 非法 JSON 一律退化为「成员可点歌、两份名单为空」：
// 旧库新增列默认就是 '{}'，不能让一次解析失败把全房点歌关掉。
// 缺省 allowMembers 也按 true 处理（只配名单没配开关的历史数据）。
func ParseMusicPermission(raw string) MusicPermission {
	perm := MusicPermission{AllowMembers: true}
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" || trimmed == "null" {
		return perm.Normalized()
	}
	var decoded struct {
		AllowMembers   *bool   `json:"allowMembers"`
		AllowedUserIDs []int64 `json:"allowedUserIds"`
		DeniedUserIDs  []int64 `json:"deniedUserIds"`
	}
	if err := json.Unmarshal([]byte(trimmed), &decoded); err != nil {
		return perm.Normalized()
	}
	if decoded.AllowMembers != nil {
		perm.AllowMembers = *decoded.AllowMembers
	}
	perm.AllowedUserIDs = decoded.AllowedUserIDs
	perm.DeniedUserIDs = decoded.DeniedUserIDs
	return perm.Normalized()
}

// Normalized 归一化：去掉非法 ID（<=0）、去重、保证切片非 nil，
// 并让黑名单优先——同一个 ID 同时出现在两份名单时只保留在 denied 里。
func (p MusicPermission) Normalized() MusicPermission {
	out := MusicPermission{
		AllowMembers:   p.AllowMembers,
		AllowedUserIDs: normalizeIDList(p.AllowedUserIDs),
		DeniedUserIDs:  normalizeIDList(p.DeniedUserIDs),
	}
	denied := make(map[int64]struct{}, len(out.DeniedUserIDs))
	for _, id := range out.DeniedUserIDs {
		denied[id] = struct{}{}
	}
	allowed := make([]int64, 0, len(out.AllowedUserIDs))
	for _, id := range out.AllowedUserIDs {
		if _, conflict := denied[id]; conflict {
			continue
		}
		allowed = append(allowed, id)
	}
	out.AllowedUserIDs = allowed
	return out
}

// SetUser 把某个用户写入白名单或黑名单，并从另一份名单移除（互斥）。
func (p *MusicPermission) SetUser(userID int64, allowed bool) {
	p.AllowedUserIDs = removeID(p.AllowedUserIDs, userID)
	p.DeniedUserIDs = removeID(p.DeniedUserIDs, userID)
	if allowed {
		p.AllowedUserIDs = append(p.AllowedUserIDs, userID)
		return
	}
	p.DeniedUserIDs = append(p.DeniedUserIDs, userID)
}

// AllowsUser 按房间配置判定某个连接能否点歌（不含权限矩阵基础权限）。
//
// 判定顺序：黑名单 → 白名单 → allowMembers。游客（uid 为 nil/<=0）跳过名单，
// 只看 allowMembers，绝不能因为「白名单为空」反推出游客可点。
func (p MusicPermission) AllowsUser(uid *int64) bool {
	if uid != nil && *uid > 0 {
		if idInList(p.DeniedUserIDs, *uid) {
			return false
		}
		if idInList(p.AllowedUserIDs, *uid) {
			return true
		}
	}
	return p.AllowMembers
}

// CanRequestMusic 判定当前连接能否向房间点歌。
//
// 顺序：先看权限矩阵（房主/root/房管/被勾选的用户直接允许），
// 矩阵不放行时再看房间级配置（黑名单/白名单/allowMembers）。
func (s *Service) CanRequestMusic(ctx context.Context, sc *sio.Socket, roomID string) (bool, error) {
	room, err := s.Rooms.FindByRoomID(ctx, roomID)
	if errors.Is(err, store.ErrRoomNotFound) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("读取房间点歌权限失败: %w", err)
	}
	perm := ParseMusicPermission(room.MusicPermission)

	matrixAllowed, err := s.CanViewerPerform(ctx, sc.ID, socketRole(sc), roomID, "musicQueue")
	if err != nil {
		return false, err
	}
	if matrixAllowed {
		return true, nil
	}
	return perm.AllowsUser(socketUserID(sc)), nil
}

// handleMusicUpdatePermission 处理房主修改点歌权限（music:update-permission）。
func (s *Service) handleMusicUpdatePermission(sc *sio.Socket, args []json.RawMessage, ack func(...any)) {
	ctx, cancel := handlerCtx()
	defer cancel()

	raw := firstObject(args)
	roomID := s.musicRoomID(sc, raw, ack)
	if roomID == "" {
		return
	}
	host, err := s.IsRoomHost(ctx, sc.ID, roomID)
	if err != nil {
		s.Logger.Printf("[music:update-permission] 权限判定失败: %v", err)
		ackFail(ack, "修改点歌权限失败")
		return
	}
	if !host {
		ackFail(ack, "无权限：仅房主可修改点歌权限")
		return
	}

	room, err := s.Rooms.FindByRoomID(ctx, roomID)
	if err != nil {
		s.Logger.Printf("[music:update-permission] 读取房间失败: %v", err)
		ackFail(ack, "修改点歌权限失败")
		return
	}
	perm := ParseMusicPermission(room.MusicPermission)
	updated, ok := applyMusicPermissionUpdate(perm, raw)
	if !ok {
		ackFail(ack, "参数无效")
		return
	}
	perm = updated

	encoded, err := json.Marshal(perm)
	if err != nil {
		s.Logger.Printf("[music:update-permission] 编码失败: %v", err)
		ackFail(ack, "修改点歌权限失败")
		return
	}
	if err := s.Rooms.SetMusicPermission(ctx, roomID, string(encoded)); err != nil {
		s.Logger.Printf("[music:update-permission] 保存失败: %v", err)
		ackFail(ack, "修改点歌权限失败")
		return
	}

	s.Hub.EmitRoom(roomID, "music:permission-changed", map[string]any{
		"roomId":     roomID,
		"permission": perm,
	})
	ackOK(ack, map[string]any{"permission": perm})
}

// applyMusicPermissionUpdate 把一次 update-permission 的 payload 合并进现有配置。
//
// payload 语义：allowMembers 存在则改开关；userId+allowed 成对存在时维护名单
// （allowed=true 加白并移出黑，false 加黑并移出白）。返回 ok=false 表示参数无效。
func applyMusicPermissionUpdate(perm MusicPermission, raw map[string]json.RawMessage) (MusicPermission, bool) {
	allowMembers, hasAllowMembers := jsonBoolField(raw, "allowMembers")
	userID, hasUserID := jsonIntField(raw, "userId")
	allowed, hasAllowed := jsonBoolField(raw, "allowed")
	// userId 与 allowed 必须成对出现；只给一半无法表达「加白还是加黑」。
	if hasUserID != hasAllowed {
		return perm, false
	}
	if !hasAllowMembers && !hasUserID {
		return perm, false
	}
	// 游客没有 user id，名单操作只接受真实用户。
	if hasUserID && userID <= 0 {
		return perm, false
	}

	if hasAllowMembers {
		perm.AllowMembers = allowMembers
	}
	if hasUserID {
		perm.SetUser(userID, allowed)
	}
	return perm.Normalized(), true
}
