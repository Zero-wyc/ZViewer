package signal

import "zviewer/backend/internal/piik/server/protocol"

func (s *Server) subscribeRemoteInput(sess *session, actor *authenticatedSession, message protocol.SubscribeRemoteInputMessage) {
	if sess.remoteInput {
		return
	}
	if actor.role == protocol.RoleViewer {
		if !protocol.ValidInputKey(message.EndpointID, message.Secret) {
			return
		}
		// One endpoint belongs to one authenticated Viewer, never an identity
		// supplied by a relay. Keep the binding only for this room session.
		for _, viewer := range s.store.GetConnectedViewers(actor.roomID) {
			other := s.sessionsByID[viewer.SessionID]
			if other != nil && other != sess && other.inputEndpoint == message.EndpointID {
				return
			}
		}
		sess.inputEndpoint, sess.inputSecret = message.EndpointID, message.Secret
	} else if message.EndpointID != "" || message.Secret != "" {
		return
	}
	sess.remoteInput = true
	s.refreshRemoteInputMembers(actor.roomID)
}

func (s *Server) refreshRemoteInputMembers(roomID string) {
	s.pruneCoPlayPresence(roomID)
	s.sendRemoteInputPeers(roomID)
	s.broadcastCoPlayPresence(roomID)
}

// Caller holds Server.mu. Only an opted-in Host receives the keys; observers,
// relays and older pages cannot acquire them through this subscription.
func (s *Server) sendRemoteInputPeers(roomID string) {
	host, ok := s.store.GetConnectedHost(roomID)
	if !ok {
		return
	}
	target := s.sessionsByID[host.SessionID]
	if target == nil || !target.remoteInput || !target.open() || target.revoked {
		return
	}
	peers := []protocol.RemoteInputPeer{}
	for _, viewer := range s.store.GetConnectedViewers(roomID) {
		current := s.sessionsByID[viewer.SessionID]
		if current != nil && current.remoteInput && current.open() && !current.revoked && current.inputEndpoint != "" {
			peers = append(peers, protocol.RemoteInputPeer{PeerID: viewer.PeerID, EndpointID: current.inputEndpoint, Secret: current.inputSecret})
		}
	}
	s.send(target, protocol.RemoteInputPeersMessage{Type: "remote-input-peers", Peers: peers})
}
