package room

// 游客房管：游客没有 userId（恒为 0），而 room.moderators 只存 userId，
// 所以游客的房管身份只能按连接身份（socketId）记在内存里：
//   - 游客离开房间 / 断线即失效，不跨连接（游客重进房间是新的 session）；
//   - 不落库，进程重启后游客房管清空（登录用户的房管名单仍在 room.moderators）。
//
// 新增/撤销都要立刻失效该房间的权限缓存，否则房管点不动按钮或撤了还能用。

// guestModerators 返回房间当前的游客房管 socketId 快照（可直接下发前端）。
func (s *Service) guestModerators(roomID string) []string {
	s.guestModsMu.RLock()
	defer s.guestModsMu.RUnlock()
	set := s.guestMods[roomID]
	if len(set) == 0 {
		return []string{}
	}
	out := make([]string, 0, len(set))
	for socketID := range set {
		out = append(out, socketID)
	}
	return out
}

// isGuestModerator 判断某个连接是否该房间的游客房管。
func (s *Service) isGuestModerator(roomID, socketID string) bool {
	if roomID == "" || socketID == "" {
		return false
	}
	s.guestModsMu.RLock()
	defer s.guestModsMu.RUnlock()
	_, ok := s.guestMods[roomID][socketID]
	return ok
}

// addGuestModerator 记录游客房管并返回最新快照。
func (s *Service) addGuestModerator(roomID, socketID string) []string {
	s.guestModsMu.Lock()
	if s.guestMods == nil {
		s.guestMods = make(map[string]map[string]struct{})
	}
	if s.guestMods[roomID] == nil {
		s.guestMods[roomID] = make(map[string]struct{})
	}
	s.guestMods[roomID][socketID] = struct{}{}
	s.guestModsMu.Unlock()
	s.perm.invalidate("", roomID)
	return s.guestModerators(roomID)
}

// removeGuestModerator 撤销游客房管并返回最新快照。
func (s *Service) removeGuestModerator(roomID, socketID string) []string {
	s.guestModsMu.Lock()
	if set := s.guestMods[roomID]; set != nil {
		delete(set, socketID)
		if len(set) == 0 {
			delete(s.guestMods, roomID)
		}
	}
	s.guestModsMu.Unlock()
	s.perm.invalidate("", roomID)
	return s.guestModerators(roomID)
}

// clearGuestModerator 在连接离开房间 / 断线时清掉它在所有房间的游客房管身份。
func (s *Service) clearGuestModerator(socketID string) {
	if socketID == "" {
		return
	}
	s.guestModsMu.Lock()
	affected := []string{}
	for roomID, set := range s.guestMods {
		if _, ok := set[socketID]; ok {
			delete(set, socketID)
			affected = append(affected, roomID)
			if len(set) == 0 {
				delete(s.guestMods, roomID)
			}
		}
	}
	s.guestModsMu.Unlock()
	for _, roomID := range affected {
		s.perm.invalidate("", roomID)
	}
}

// moderatorEvent 组装 moderators-changed 载荷：登录用户按 userId 下发，
// 游客房管额外用 guestModerators(socketId) 下发，前端两种都要合并判定。
func (s *Service) moderatorEvent(roomID string, moderators []int64) map[string]any {
	if moderators == nil {
		moderators = []int64{}
	}
	return map[string]any{
		"roomId":          roomID,
		"moderators":      moderators,
		"guestModerators": s.guestModerators(roomID),
	}
}
