package signal

import "zviewer/backend/internal/piik/server/protocol"

func (s *Server) setRelayVolunteer(sess *session, auth *authenticatedSession, message protocol.SetRelayVolunteerMessage) {
	if auth.role != protocol.RoleViewer {
		s.sendError(sess, "FORBIDDEN", "Only viewers may volunteer relay capacity")
		return
	}
	rm := s.router.room(auth.roomID)
	settings, _ := rm.viewerSettings.Get(auth.peerID)
	settings.capacity, settings.volunteer, settings.sessionID = int(message.Capacity), message.Enabled, sess.sessionID
	rm.viewerSettings.Set(auth.peerID, settings)
	capacity := min(settings.capacity, s.endpointMediaCopyCapacity)
	if settings.volunteer {
		capacity = settings.capacity
	}
	if rm.controller != nil {
		rm.controller.SetRelayVolunteer(auth.peerID, sess.sessionID, settings.volunteer, s.router.nowPtr())
		rm.controller.SetEffectiveCapacity(auth.peerID, sess.sessionID, settings.capacity, s.router.nowPtr())
		s.router.requestPump(auth.roomID)
	}
	s.send(sess, protocol.RelayVolunteerMessage{Type: "relay-volunteer", Enabled: settings.volunteer, Capacity: protocol.Int(capacity)})
}
