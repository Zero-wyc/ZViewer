package room

import (
	"time"

	"zviewer/backend/internal/store"
)

type streamStatusPayload struct {
	RoomID string `json:"roomId"`
	Status string `json:"status"`
}

func (s *Service) noteStreamOffline(roomID string) time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	if at, ok := s.streamOfflineAt[roomID]; ok {
		return at
	}
	at := time.Now()
	s.streamOfflineAt[roomID] = at
	return at
}

func (s *Service) clearStreamOffline(roomID string) {
	s.mu.Lock()
	delete(s.streamOfflineAt, roomID)
	s.mu.Unlock()
}

func (s *Service) tracksStreamPresence(room *store.Room) bool {
	return room != nil && room.Status == "active" && room.Mode == "screen-share" &&
		room.ShareMethod == "stream-push" && room.StreamKey != nil &&
		s.NMS != nil && s.NMS.TracksPublishing()
}

func (s *Service) streamStatus(room *store.Room) streamStatusPayload {
	status := "offline"
	if s.IsStreamPublishing(room) {
		status = "live"
	}
	return streamStatusPayload{RoomID: room.RoomID, Status: status}
}

func (s *Service) sendStreamStatus(socketID string, room *store.Room) {
	if s.Hub != nil && s.tracksStreamPresence(room) {
		s.Hub.EmitTo(socketID, "stream-status", s.streamStatus(room))
	}
}

// Use the existing two-second heartbeat so an OBS viewer does not need a
// browser host, playback memory, or a page refresh to learn media state.
func (b *Broadcaster) broadcastStreamPresence() {
	s := b.svc
	if s.Hub == nil || s.NMS == nil || !s.NMS.TracksPublishing() {
		clear(b.streams)
		return
	}
	ctx, cancel := handlerCtx()
	defer cancel()
	rooms, err := s.Rooms.ListActiveStreamPush(ctx)
	if err != nil {
		b.logger.Printf("[room] query OBS presence: %v", err)
		return
	}
	ids := make([]string, 0, len(rooms))
	for _, room := range rooms {
		ids = append(ids, room.RoomID)
	}
	counts, err := s.Rooms.ActiveSessionCounts(ctx, ids)
	if err != nil {
		b.logger.Printf("[room] query OBS host sessions: %v", err)
		return
	}
	current := make(map[string]bool, len(rooms))
	for _, room := range rooms {
		payload := s.streamStatus(room)
		live := payload.Status == "live"
		current[room.RoomID] = live
		_, hostConnected := counts.Sharers[room.RoomID]
		if live || hostConnected {
			s.clearStreamOffline(room.RoomID)
		}
		if live && !hostConnected && !s.HasReconnectTimer(room.RoomID) {
			s.startHostReconnectTimer(room.RoomID, "")
		}
		wasLive, seen := b.streams[room.RoomID]
		if !live && !hostConnected && (!seen || wasLive) {
			s.noteStreamOffline(room.RoomID)
			if wasLive {
				s.Hub.EmitRoom(room.RoomID, "host-disconnected", map[string]any{"roomId": room.RoomID})
			}
			s.startHostReconnectTimer(room.RoomID, "")
		}
		if s.Hub.MemberCount(room.RoomID) > 0 {
			s.Hub.EmitRoom(room.RoomID, "stream-status", payload)
		}
	}
	b.streams = current
}
