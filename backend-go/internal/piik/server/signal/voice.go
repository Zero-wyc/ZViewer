package signal

import (
	"zviewer/backend/internal/piik/server/protocol"
	"zviewer/backend/internal/piik/server/room"
	"zviewer/backend/internal/piik/server/sfu"
)

type voiceMember struct {
	sessionID     string
	joined        bool
	publicationID string
	deafened      *bool
}

// Room authority owns voice activation and publication identity. Connections below
// are physical facets of router.controller's graph, never another topology.
type roomVoice struct {
	hostPeerID  string
	bitrate     protocol.Int
	revision    int64
	members     map[string]*voiceMember
	connections map[string]*voiceEdge
}

func (v *roomVoice) enabled() bool {
	host := v.members[v.hostPeerID]
	return host != nil && host.joined
}

func (v *roomVoice) leaveAll() {
	for _, member := range v.members {
		member.joined, member.publicationID = false, ""
	}
}

type voiceEdge struct {
	id, logicalID, parent, child, transport string
	parentSession, childSession             string
	pending                                 bool
	revision                                int64
	send                                    map[string][]string
	connected                               map[string]bool
	sfuPlan                                 *sfu.VoiceConnectionPlan
	sfuWork                                 *voiceNegotiation
}

type voiceNegotiation struct {
	run  func() error
	done chan struct{}
}

func (s *Server) voiceRoom(roomID string) *roomVoice {
	if s.voices == nil {
		s.voices = make(map[string]*roomVoice)
	}
	v := s.voices[roomID]
	if v == nil {
		v = &roomVoice{bitrate: 64_000, members: make(map[string]*voiceMember), connections: make(map[string]*voiceEdge)}
		s.voices[roomID] = v
	}
	if host, ok := s.store.GetConnectedHost(roomID); ok {
		if v.hostPeerID != "" && v.hostPeerID != host.PeerID {
			v.leaveAll()
			delete(v.members, v.hostPeerID)
		}
		v.hostPeerID = host.PeerID
	}
	return v
}

func (s *Server) subscribeRoomVoice(sess *session, auth *authenticatedSession, deafened *bool) {
	sess.roomVoice = true
	v := s.voiceRoom(auth.roomID)
	m := v.members[auth.peerID]
	if m == nil {
		m = &voiceMember{}
		v.members[auth.peerID] = m
	}
	if m.sessionID != sess.sessionID {
		m.sessionID = sess.sessionID
		m.publicationID = ""
	}
	m.deafened = deafened
	sess.roomVoiceListeningPresence = deafened != nil
	s.syncVoiceDemand(auth.roomID)
	s.syncRoomVoice(auth.roomID)
}

func (s *Server) voiceSession(roomID, peerID string) (*session, *voiceMember) {
	v := s.voices[roomID]
	if v == nil {
		return nil, nil
	}
	m := v.members[peerID]
	if m == nil {
		return nil, nil
	}
	sess := s.sessionsByID[m.sessionID]
	if sess == nil || !sess.roomVoice || !s.isCurrentSession(sess) || sess.authenticated == nil ||
		sess.authenticated.roomID != roomID || sess.authenticated.peerID != peerID {
		return nil, m
	}
	return sess, m
}

func (s *Server) voiceAllowed(roomID, peerID string) bool {
	sess, m := s.voiceSession(roomID, peerID)
	return sess != nil && s.voices[roomID].enabled() && m.joined
}

func (s *Server) handleRoomVoiceCommand(sess *session, auth *authenticatedSession, command protocol.RoomVoiceCommand) {
	if !sess.roomVoice {
		s.voiceError(sess, "not-allowed")
		return
	}
	v := s.voiceRoom(auth.roomID)
	m := v.members[auth.peerID]
	if m == nil || m.sessionID != sess.sessionID {
		return
	}
	switch command.Action {
	case "bitrate":
		if auth.role != protocol.RoleHost || !sess.roomVoiceBitrate {
			s.voiceError(sess, "not-allowed")
			return
		}
		v.bitrate = command.Bitrate
		s.syncRoomVoice(auth.roomID)
		return
	case "deafen":
		if !sess.roomVoiceListeningPresence || command.Deafened == nil {
			s.voiceError(sess, "not-allowed")
			return
		}
		m.deafened = command.Deafened
		s.syncRoomVoice(auth.roomID)
		return
	case "join":
		if auth.role != protocol.RoleHost && !v.enabled() {
			s.voiceError(sess, "not-enabled")
			return
		}
		m.joined = true
	case "leave":
		if auth.role == protocol.RoleHost {
			v.leaveAll()
		} else {
			m.joined, m.publicationID = false, ""
		}
	case "publish":
		if !v.enabled() || !m.joined {
			s.voiceError(sess, "not-allowed")
			return
		}
		if m.publicationID == "" {
			m.publicationID = opaqueID()
		}
	case "unpublish":
		if command.PublicationID == m.publicationID {
			m.publicationID = ""
		}
	}
	s.syncVoiceDemand(auth.roomID)
	s.syncRoomVoice(auth.roomID)
}

func (s *Server) voiceError(sess *session, code string) {
	s.send(sess, protocol.RoomVoiceErrorMessage{Type: "room-voice-error", Code: code})
}

func (s *Server) roomVoiceParticipants(roomID string) []room.ConnectedPeer {
	result := []room.ConnectedPeer{}
	if host, ok := s.store.GetConnectedHost(roomID); ok {
		result = append(result, host)
	}
	return append(result, s.store.GetConnectedViewers(roomID)...)
}

func (s *Server) syncVoiceDemand(roomID string) {
	v := s.voices[roomID]
	if v == nil {
		return
	}
	listeners := make([]string, 0, len(v.members))
	for peerID := range v.members {
		if s.voiceAllowed(roomID, peerID) {
			listeners = append(listeners, peerID)
		}
	}
	if len(listeners) == 0 {
		if rm, _ := s.router.rooms.Get(roomID); rm != nil && rm.roomMedia && rm.controller != nil {
			rm.controller.SetVoiceListeners(nil, s.now())
			if s.activeHostShareGeneration(roomID) == "" {
				s.router.clearDeadline(rm)
				s.router.releaseResources(rm.controller.Dispose())
				rm.controller = nil
			} else {
				s.router.requestPump(roomID)
			}
		}
		return
	}
	host, ok := s.store.GetConnectedHost(roomID)
	if !ok {
		return
	}
	rm := s.router.room(roomID)
	if !rm.roomMedia {
		rm.roomMedia = true
		rm.mediaGeneration = opaqueID()
		if rm.controller != nil {
			if publication := rm.controller.Snapshot().HostPublication; publication != nil && publication.Resource != nil {
				rm.mediaGeneration = publication.Resource.ShareGeneration
			}
			generation := s.activeHostShareGeneration(roomID)
			paused := generation != "" && s.shares[roomID].pausedGeneration == generation
			s.router.releaseResources(rm.controller.SetVideoPublication(generation, paused, s.now()))
		}
	}
	hostSession := s.sessionsByID[host.SessionID]
	if hostSession == nil || hostSession.authenticated == nil {
		return
	}
	participant := routeParticipant(hostSession, hostSession.authenticated)
	policy := s.routePolicyOf(roomID)
	participant.routePolicy = &policy
	s.router.connectParticipant(participant)
	generation := s.activeHostShareGeneration(roomID)
	paused := generation != "" && s.shares[roomID].pausedGeneration == generation
	s.router.releaseResources(rm.controller.SetVideoPublication(generation, paused, s.now()))
	for _, peer := range s.store.GetConnectedViewers(roomID) {
		if generation == "" && !s.voiceAllowed(roomID, peer.PeerID) {
			if rm.controller != nil {
				rm.controller.ConfirmDeparture(peer.PeerID, s.router.nowPtr())
			}
			continue
		}
		if current := s.sessionsByID[peer.SessionID]; current != nil && current.authenticated != nil {
			s.router.connectParticipant(routeParticipant(current, current.authenticated))
		}
	}
	rm.controller.SetVoiceListeners(listeners, s.now())
	s.router.requestPump(roomID)
}

func (s *Server) disconnectRoomVoice(roomID, peerID, sessionID string) {
	v := s.voices[roomID]
	if v == nil {
		return
	}
	if m := v.members[peerID]; m != nil && m.sessionID == sessionID {
		m.publicationID = ""
	}
	s.syncVoiceDemand(roomID)
	s.syncRoomVoice(roomID)
}

func (s *Server) closeRoomVoice(roomID string) {
	if v := s.voices[roomID]; v != nil {
		for _, edge := range v.connections {
			s.closeVoiceEdge(roomID, edge)
		}
		delete(s.voices, roomID)
	}
}
