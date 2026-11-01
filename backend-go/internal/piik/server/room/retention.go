package room

// ExpireEmptyRooms commits storage retirement before returning effect cleanup.
func (s *Store) ExpireEmptyRooms(beforeMs int64) ([]ClosedRoom, error) {
	return s.abandonRooms(s.EmptyRoomIDs(beforeMs))
}

// EmptyRoomIDs returns empty rooms in creation order, including never-joined
// rooms. A connected Host or Viewer protects an idle chat room just like a share.
// Callers retire candidates synchronously under the same signaling lock.
func (s *Store) EmptyRoomIDs(beforeMs int64) []string {
	var ids []string
	for id, room := range s.rooms.All() {
		if room.emptySinceMs <= beforeMs && !roomOccupied(room) {
			ids = append(ids, id)
		}
	}
	return ids
}

func roomOccupied(room *Room) bool {
	if room.host != nil && room.host.sessionID != "" {
		return true
	}
	for _, viewer := range room.viewers.All() {
		if viewer.sessionID != "" {
			return true
		}
	}
	return false
}
