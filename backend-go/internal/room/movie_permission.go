package room

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"zviewer/backend/internal/store"
)

// MoviePermission 是房间级「点片权限」配置，对应 room.moviePermission 列。
//
// 语义与点歌权限（musicPermission）一致，但默认值相反：
//   - allowMembers：成员（非房主/房管/矩阵放行者）默认可否点片，默认 false；
//   - allowedUserIds：逐用户白名单，命中即允许（优先于 allowMembers）；
//   - deniedUserIds：逐用户黑名单，命中即拒绝（优先于白名单）；
//   - 游客没有 userId，只受 allowMembers 控制。
//
// 点片默认关闭：旧库补列时的默认值 '{}' 解析后 allowMembers=false，
// 与「成员默认可点歌」的 musicPermission 相反，别照抄那边的默认值。
type MoviePermission struct {
	AllowMembers   bool    `json:"allowMembers"`
	AllowedUserIDs []int64 `json:"allowedUserIds"`
	DeniedUserIDs  []int64 `json:"deniedUserIds"`
}

// ParseMoviePermission 解析房间列里的原始 JSON（api 层与房间层共用）。
//
// 空串 / "{}" / null / 非法 JSON 一律退化为「成员不可点片、两份名单为空」：
// 解析失败必须 fail-closed，不能把点片权限误开给全房。
func ParseMoviePermission(raw string) MoviePermission {
	perm := MoviePermission{AllowMembers: false}
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
func (p MoviePermission) Normalized() MoviePermission {
	out := MoviePermission{
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
func (p *MoviePermission) SetUser(userID int64, allowed bool) {
	p.AllowedUserIDs = removeID(p.AllowedUserIDs, userID)
	p.DeniedUserIDs = removeID(p.DeniedUserIDs, userID)
	if allowed {
		p.AllowedUserIDs = append(p.AllowedUserIDs, userID)
		return
	}
	p.DeniedUserIDs = append(p.DeniedUserIDs, userID)
}

// AllowsUser 按房间配置判定某个用户能否点片（不含权限矩阵基础权限）。
//
// 判定顺序：黑名单 → 白名单 → allowMembers。游客（uid 为 nil/<=0）跳过名单，
// 只看 allowMembers，绝不能因为「白名单为空」反推出游客可点。
func (p MoviePermission) AllowsUser(uid *int64) bool {
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

// MoviePermissionUpdate 是一次 PUT movie-permission 的更新意图。
//
// AllowMembers 为 nil 表示不改开关；UserID/Allowed 必须同为 nil 或同非 nil。
type MoviePermissionUpdate struct {
	AllowMembers *bool
	UserID       *int64
	Allowed      *bool
}

// ApplyMoviePermissionUpdate 把一次更新合并进现有配置。
//
// 返回 ok=false 表示参数无效（成对字段缺失、一项都没给、userId<=0）。
func ApplyMoviePermissionUpdate(perm MoviePermission, upd MoviePermissionUpdate) (MoviePermission, bool) {
	if (upd.UserID == nil) != (upd.Allowed == nil) {
		return perm, false
	}
	if upd.AllowMembers == nil && upd.UserID == nil {
		return perm, false
	}
	if upd.UserID != nil && *upd.UserID <= 0 {
		return perm, false
	}
	if upd.AllowMembers != nil {
		perm.AllowMembers = *upd.AllowMembers
	}
	if upd.UserID != nil {
		perm.SetUser(*upd.UserID, *upd.Allowed)
	}
	return perm.Normalized(), true
}

// CanRequestMovie 判定某个用户能否向房间点片（REST 新增影片用）。
//
// 顺序：房主/root/房管/矩阵放行 → 房间级配置（黑名单/白名单/allowMembers）。
// 房间不存在或读取失败一律拒绝（fail-closed）。
func (s *Service) CanRequestMovie(ctx context.Context, userID *int64, role, roomID string) bool {
	rm, err := s.Rooms.FindByRoomID(ctx, roomID)
	if errors.Is(err, store.ErrRoomNotFound) {
		return false
	}
	if err != nil {
		s.Logger.Printf("[movie] 读取房间点片权限失败 room=%s: %v", roomID, err)
		return false
	}
	if s.movieMatrixAllows(ctx, rm, userID, role) {
		return true
	}
	return ParseMoviePermission(rm.MoviePermission).AllowsUser(userID)
}

// movieMatrixAllows 判定权限矩阵是否直接放行点片（房主/root/房管/矩阵勾选）。
func (s *Service) movieMatrixAllows(ctx context.Context, rm *store.Room, userID *int64, role string) bool {
	if role == RoleRoot {
		return true
	}
	// 游客没有 userId，名单与矩阵都无从判定，只能落到 allowMembers。
	if userID == nil || *userID <= 0 {
		return false
	}
	if rm.OwnerUserID != nil && *rm.OwnerUserID == *userID {
		return true
	}
	var settings *store.SystemSettings
	if s.Settings != nil {
		if row, err := s.Settings.Get(ctx); err == nil {
			settings = row
		}
	}
	for _, id := range s.Moderators(ctx, rm.RoomID) {
		if id == *userID {
			return matrixAllow(settings, "addMovie", "moderator")
		}
	}
	switch role {
	case RoleAdmin:
		return matrixAllow(settings, "addMovie", "admin")
	case RoleUser:
		return matrixAllow(settings, "addMovie", "user")
	}
	return false
}
