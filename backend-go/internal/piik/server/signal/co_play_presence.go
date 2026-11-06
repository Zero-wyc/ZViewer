package signal

import "zviewer/backend/internal/piik/server/protocol"

// This is a share-scoped presentation projection. Only the Host App owns input
// grants; neither subscribing nor publishing this list can grant control.
func (s *Server) setCoPlayPresence(sess *session, actor *authenticatedSession, message protocol.SetCoPlayPresenceMessage) {
	host, ok := s.store.GetConnectedHost(actor.roomID)
	if actor.role != protocol.RoleHost || !ok || host.SessionID != sess.sessionID ||
		actor.shareGeneration == "" || actor.shareGeneration != message.ShareGeneration ||
		s.shares[actor.roomID].generation != message.ShareGeneration {
		return
	}
	endpoints := s.coPlayEndpoints(actor.roomID)
	share := s.shares[actor.roomID]
	share.coPlayGrants = nil
	for _, grant := range message.Grants {
		if _, exists := endpoints[grant.EndpointID]; exists {
			share.coPlayGrants = append(share.coPlayGrants, grant)
		}
	}
	s.shares[actor.roomID] = share
	s.broadcastCoPlayPresence(actor.roomID)
}

func (s *Server) coPlayEndpoints(roomID string) map[string]string {
	endpoints := make(map[string]string)
	for _, viewer := range s.store.GetConnectedViewers(roomID) {
		current := s.sessionsByID[viewer.SessionID]
		if current != nil && current.remoteInput && current.open() && !current.revoked && current.inputEndpoint != "" {
			endpoints[current.inputEndpoint] = viewer.PeerID
		}
	}
	return endpoints
}

func (s *Server) pruneCoPlayPresence(roomID string) {
	share, exists := s.shares[roomID]
	if !exists || len(share.coPlayGrants) == 0 {
		return
	}
	endpoints := s.coPlayEndpoints(roomID)
	retained := share.coPlayGrants[:0]
	for _, grant := range share.coPlayGrants {
		if _, exists := endpoints[grant.EndpointID]; exists {
			retained = append(retained, grant)
		}
	}
	share.coPlayGrants = retained
	s.shares[roomID] = share
}

func (s *Server) coPlayParticipants(roomID string) []protocol.CoPlayParticipant {
	participants := []protocol.CoPlayParticipant{}
	if _, ok := s.store.GetConnectedHost(roomID); !ok {
		return participants
	}
	endpoints := s.coPlayEndpoints(roomID)
	for _, grant := range s.shares[roomID].coPlayGrants {
		if peerID, exists := endpoints[grant.EndpointID]; exists {
			participants = append(participants, protocol.CoPlayParticipant{PeerID: peerID})
		}
	}
	return participants
}

func (s *Server) sendCoPlayPresence(sess *session, roomID string) {
	if sess != nil && sess.coPlayPresence {
		s.send(sess, protocol.CoPlayPresenceMessage{Type: "co-play-presence", Participants: s.coPlayParticipants(roomID)})
	}
}

func (s *Server) broadcastCoPlayPresence(roomID string) {
	participants := s.coPlayParticipants(roomID)
	for _, viewer := range s.store.GetConnectedViewers(roomID) {
		if target := s.sessionsByID[viewer.SessionID]; target != nil && target.coPlayPresence {
			s.send(target, protocol.CoPlayPresenceMessage{Type: "co-play-presence", Participants: participants})
		}
	}
}
