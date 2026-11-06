package signal

import "zviewer/backend/internal/piik/server/protocol"

func (s *Server) setAudioPresence(sess *session, actor *authenticatedSession, message protocol.SetAudioPresenceMessage) {
	host, ok := s.store.GetConnectedHost(actor.roomID)
	if actor.role != protocol.RoleHost || !ok || host.SessionID != sess.sessionID ||
		actor.shareGeneration == "" || actor.shareGeneration != message.ShareGeneration ||
		s.shares[actor.roomID].generation != message.ShareGeneration {
		return
	}
	share := s.shares[actor.roomID]
	share.audioAvailable = &message.Available
	s.shares[actor.roomID] = share
	s.broadcastAudioPresence(actor.roomID)
}

func (s *Server) sendAudioPresence(sess *session, roomID string) {
	if sess == nil || !sess.audioPresence {
		return
	}
	s.send(sess, protocol.AudioPresenceMessage{Type: "audio-presence", Available: s.shares[roomID].audioAvailable})
}

func (s *Server) broadcastAudioPresence(roomID string) {
	for _, viewer := range s.store.GetConnectedViewers(roomID) {
		s.sendAudioPresence(s.sessionsByID[viewer.SessionID], roomID)
	}
}
