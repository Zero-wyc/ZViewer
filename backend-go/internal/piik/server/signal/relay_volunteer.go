package signal

import "zviewer/backend/internal/piik/server/protocol"

func (s *Server) setRelayVolunteer(sess *session, auth *authenticatedSession, message protocol.SetRelayVolunteerMessage) {
	if auth.role == protocol.RoleHost && !message.Settings {
		s.sendError(sess, "FORBIDDEN", "Host capacity settings require room capacity support")
		return
	}
	rm := s.router.room(auth.roomID)
	settings, _ := rm.endpointSettings.Get(auth.peerID)
	settings.capacity, settings.volunteer, settings.sessionID = int(message.Capacity), message.Enabled, sess.sessionID
	if message.Settings {
		if message.PhysicalCapacity == nil || (auth.role == protocol.RoleHost && (message.Enabled && message.Capacity < 1)) {
			s.sendError(sess, "INVALID_CAPACITY", "Room capacity must be at least one")
			return
		}
		settings.settings, settings.physicalCapacity = true, int(*message.PhysicalCapacity)
		if auth.role == protocol.RoleHost {
			settings.volunteer = false
			if message.Enabled {
				rm.roomCapacity = int(message.Capacity)
			}
		}
	}
	rm.endpointSettings.Set(auth.peerID, settings)
	if rm.controller != nil {
		rm.controller.SetDefaultCapacity(rm.roomCapacity, s.router.nowPtr())
		rm.controller.SetRelayVolunteer(auth.peerID, sess.sessionID, settings.capacityOverride(), s.router.nowPtr())
		rm.controller.SetEffectiveCapacity(auth.peerID, sess.sessionID, settings.reportedCapacity(s.endpointMediaCopyCapacity), s.router.nowPtr())
		s.router.requestPump(auth.roomID)
	}
	s.send(sess, s.relayCapacityAck(rm, settings, auth.role == protocol.RoleHost))
	if auth.role == protocol.RoleHost && message.Enabled {
		for peerID, other := range rm.endpointSettings.All() {
			if peerID != auth.peerID && other.settings && other.sessionID != "" {
				s.router.hooks.sendToSession(other.sessionID, s.relayCapacityAck(rm, other, false))
			}
		}
	}
}

func (s *Server) relayCapacityAck(rm *roomRuntime, settings endpointRouteSettings, host bool) protocol.RelayVolunteerMessage {
	ack := protocol.RelayVolunteerMessage{Type: "relay-volunteer", Enabled: settings.volunteer,
		Capacity: protocol.Int(settings.effectiveCapacity(rm.roomCapacity, s.endpointMediaCopyCapacity))}
	if settings.settings {
		roomCapacity := protocol.Int(rm.roomCapacity)
		ack.RoomCapacity = &roomCapacity
		if host {
			ack.Enabled = rm.roomCapacity != s.endpointMediaCopyCapacity
		}
	}
	return ack
}
