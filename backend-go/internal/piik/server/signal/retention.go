package signal

import (
	"errors"
	"fmt"

	"zviewer/backend/internal/piik/server/room"
)

// Capacity reclamation and scheduled expiry use the normal room retirement
// owner, so grace timers, route state and share generations cannot outlive a
// recycled code. All selection and retirement happen under Server.mu.
func (s *Server) roomCapacityCandidate(err error, exceptRoomID string) string {
	var roomError *room.Error
	if s.roomEmptyTimeoutMs <= 0 || !errors.As(err, &roomError) || roomError.Code != room.CodeRoomLimit {
		return ""
	}
	now := s.now()
	// A recently vacated old room should not be displaced while another empty
	// room has already expired but is waiting for the next heartbeat sweep.
	// Reuse the admission/reconnect window for early reclamation as well: a
	// new room's HTTP response must reach its Host before its code can be reused.
	for _, before := range []int64{now - s.roomEmptyTimeoutMs, now - int64(s.viewerDisconnectGraceMs)} {
		for _, id := range s.store.EmptyRoomIDs(before) {
			if id != exceptRoomID {
				return id
			}
		}
	}
	return ""
}

func (s *Server) expireEmptyRooms() {
	if s.roomEmptyTimeoutMs <= 0 {
		return
	}
	closed, err := s.store.ExpireEmptyRooms(s.now() - s.roomEmptyTimeoutMs)
	if err != nil {
		s.logger.Error("Could not expire empty rooms", "errorType", fmt.Sprintf("%T", err))
		return
	}
	for _, room := range closed {
		s.closeRoom(room)
	}
}
