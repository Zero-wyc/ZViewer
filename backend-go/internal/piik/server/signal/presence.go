package signal

// Viewer presence, Host status, disconnect handling and room termination run
// with Server.mu held, so each effect observes the current room membership.

import (
	"fmt"
	"strings"
	"time"

	"github.com/coder/websocket"

	"zviewer/backend/internal/piik/server/protocol"
	"zviewer/backend/internal/piik/server/room"
)

// viewerKey scopes grace timers and quality evidence to one room participant.
func viewerKey(roomID, peerID string) string { return roomID + ":" + peerID }

// sendViewerPresence lists the host entry first
// when it has a display name, then viewers in store order; recipients are
// the opted-in host first, then opted-in viewers in store order, deduped by
// connection.
func (s *Server) sendViewerPresence(roomID string) {
	if _, deferred := s.deferredViewerPresenceRooms[roomID]; deferred {
		return
	}

	connectedViewers := s.store.GetConnectedViewers(roomID)
	viewers := []protocol.ParticipantPresenceEntry{}
	host, hasHost := s.store.GetConnectedHost(roomID)
	var hostSession *session
	var hostState *authenticatedSession
	if hasHost {
		hostSession = s.sessionsByID[host.SessionID]
		if hostSession != nil {
			hostState = hostSession.authenticated
		}
	}
	if hasHost && hostSession != nil && hostState != nil &&
		hostState.role == protocol.RoleHost &&
		hostState.roomID == roomID &&
		hostState.peerID == host.PeerID &&
		hostState.displayName != nil {
		viewers = append(viewers, protocol.HostPresenceEntry(host.PeerID, protocol.DisplayName(*hostState.displayName)))
	}

	for _, viewer := range connectedViewers {
		viewerState := s.authenticatedOf(viewer.SessionID)
		if viewerState == nil ||
			viewerState.role != protocol.RoleViewer ||
			viewerState.roomID != roomID ||
			viewerState.peerID != viewer.PeerID ||
			viewerState.displayName == nil {
			continue
		}
		upstream := s.router.getViewerRouteUpstream(roomID, viewer.PeerID)
		activeEdge, hasActiveEdge := s.router.resolveActiveViewerMediaEdge(roomID, viewer.PeerID)
		mediaReady := hasActiveEdge && upstream.Kind != "none"
		if mediaReady {
			if activeEdge.upstream.Kind == "sfu" {
				mediaReady = upstream.Kind == "sfu"
			} else {
				mediaReady = upstream.Kind == "peer" && activeEdge.upstream.PeerID == upstream.PeerID
			}
		}
		viewers = append(viewers, protocol.NewViewerPresenceEntry(
			viewer.PeerID, protocol.DisplayName(*viewerState.displayName), upstream, mediaReady))
	}
	encoded, err := protocol.EncodeServerMessage(protocol.ViewerPresenceMessage{
		Type:    "viewer-presence",
		Viewers: viewers,
	})
	if err != nil {
		panic(err)
	}

	var recipients []*session
	seen := map[*session]struct{}{}
	add := func(sess *session) {
		if _, duplicate := seen[sess]; duplicate {
			return
		}
		seen[sess] = struct{}{}
		recipients = append(recipients, sess)
	}
	if hostSession != nil && hostState != nil && hostState.viewerPresence {
		add(hostSession)
	}
	for _, viewer := range connectedViewers {
		viewerSession := s.sessionsByID[viewer.SessionID]
		if viewerSession == nil {
			continue
		}
		viewerState := viewerSession.authenticated
		if viewerState != nil &&
			viewerState.role == protocol.RoleViewer &&
			viewerState.roomID == roomID &&
			viewerState.peerID == viewer.PeerID &&
			viewerState.viewerPresence {
			add(viewerSession)
		}
	}
	for _, sess := range recipients {
		s.sendEncoded(sess, encoded)
	}
}

func (s *Server) broadcastHostStatus(roomID string, online, paused bool) {
	for _, viewer := range s.store.GetConnectedViewers(roomID) {
		s.sendToSession(viewer.SessionID, protocol.HostStatusMessage{
			Type:   "host-status",
			Online: online,
			Paused: paused,
		})
	}
}

// handleDisconnect runs once, from the reader
// goroutine's exit.
func (s *Server) handleDisconnect(sess *session) {
	if !s.sessions.Has(sess) {
		return
	}
	sess.clearAuthenticationTimer()
	delete(s.senderQualityRateBySession, sess.sessionID)
	s.sessions.Delete(sess)
	if s.sessionsByID[sess.sessionID] == sess {
		delete(s.sessionsByID, sess.sessionID)
	}
	if sess.revoked {
		return
	}
	if sess.authenticated == nil {
		s.unauthenticatedConnections--
		return
	}
	if s.closing {
		return
	}

	disconnected, err := s.store.DisconnectParticipant(
		sess.authenticated.roomID, sess.authenticated.peerID, sess.sessionID)
	if err != nil {
		panic(fmt.Errorf("room store failed during disconnect: %w", err))
	}
	if disconnected == nil {
		return
	}
	s.router.disconnectParticipant(disconnected.RoomID, disconnected.PeerID, sess.sessionID)
	s.disconnectRoomVoice(disconnected.RoomID, disconnected.PeerID, sess.sessionID)
	s.refreshRemoteInputMembers(disconnected.RoomID)
	if disconnected.Role == protocol.RoleHost {
		s.broadcastHostStatus(disconnected.RoomID, false, false)
		s.sendViewerPresence(disconnected.RoomID)
		return
	}

	s.sendViewerPresence(disconnected.RoomID)

	// The registered pointer rejects stale grace callbacks; the store then
	// guards against removing a Viewer that has already reconnected.
	roomID, peerID := disconnected.RoomID, disconnected.PeerID
	key := viewerKey(roomID, peerID)
	timer := &graceTimer{}
	timer.stop = s.afterFunc(time.Duration(s.viewerDisconnectGraceMs)*time.Millisecond, func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.viewerGraceTimers[key] != timer {
			return
		}
		delete(s.viewerGraceTimers, key)
		if s.store.RemoveDisconnectedViewer(roomID, peerID) {
			if voice := s.voices[roomID]; voice != nil {
				delete(voice.members, peerID)
				s.syncRoomVoice(roomID)
			}
			s.clearViewerEvidence(roomID, peerID)
			s.router.removeViewer(roomID, peerID)
		}
	})
	s.viewerGraceTimers[key] = timer
}

// stopSharing sends sharing-stopped then host-status to each viewer.
// The share generation deliberately survives.
func (s *Server) stopSharing(roomID string) {
	if current, ok := s.shares[roomID]; ok {
		if host, connected := s.store.GetConnectedHost(roomID); connected {
			if sess := s.sessionsByID[host.SessionID]; sess != nil && sess.authenticated != nil &&
				sess.authenticated.shareGeneration == current.generation {
				sess.authenticated.shareGeneration = ""
			}
		}
		s.shares[roomID] = roomShare{generation: current.generation}
	}
	s.broadcastAudioPresence(roomID)
	s.broadcastCoPlayPresence(roomID)
	s.clearRoomViewerEvidence(roomID)
	s.router.stopRoom(roomID)
	for _, viewer := range s.store.GetConnectedViewers(roomID) {
		s.sendToSession(viewer.SessionID, protocol.SharingStoppedMessage{Type: "sharing-stopped"})
		s.sendToSession(viewer.SessionID, protocol.HostStatusMessage{
			Type:   "host-status",
			Online: false,
			Paused: false,
		})
	}
}

// abandonRoom leaves store-error mapping to its caller.
func (s *Server) abandonRoom(roomID string) error {
	abandoned, err := s.store.AbandonRoom(roomID)
	if err != nil {
		return err
	}
	if abandoned == nil {
		return nil
	}
	s.closeRoom(*abandoned)
	return nil
}

// closeRoom closes the host session first, then
// viewers in store order, each told room-closed then closed with 1000.
func (s *Server) closeRoom(closed room.ClosedRoom) {
	s.closeRoomVoice(closed.RoomID)
	s.clearRoomGraceTimers(closed.RoomID)
	s.clearRoomViewerEvidence(closed.RoomID)
	s.router.deleteRoom(closed.RoomID)
	delete(s.shares, closed.RoomID)
	for _, sessionID := range closed.SessionIDs {
		sess := s.sessionsByID[sessionID]
		if sess == nil {
			continue
		}
		s.send(sess, protocol.RoomClosedMessage{Type: "room-closed", Reason: "host-ended"})
		sess.close(websocket.StatusNormalClosure, "Room abandoned")
	}
}

// revokeGrantViewers makes three separate passes
// over the revoked viewers, with presence deferred until the end.
func (s *Server) revokeGrantViewers(roomID string, update room.ViewerGrantUpdate) {
	if len(update.RevokedViewers) == 0 {
		return
	}
	// The store has already removed their admission. Retire input identity as
	// well; a shared relay's media connection may survive this Viewer leaving.
	s.refreshRemoteInputMembers(roomID)
	s.deferredViewerPresenceRooms[roomID] = struct{}{}
	func() {
		defer delete(s.deferredViewerPresenceRooms, roomID)
		for _, viewer := range update.RevokedViewers {
			s.clearViewerState(roomID, viewer.PeerID)
			if viewer.SessionID == "" {
				continue
			}
			s.sendToSession(viewer.SessionID, protocol.ViewerGrantRevokedMessage{
				Type:                          "viewer-grant-revoked",
				ViewerAuthorizationGeneration: update.PreviousViewerAuthorizationGeneration,
			})
		}

		for _, viewer := range update.RevokedViewers {
			s.router.removeViewer(roomID, viewer.PeerID)
		}

		for _, viewer := range update.RevokedViewers {
			if viewer.SessionID != "" {
				s.closeRevokedViewerSession(viewer.SessionID)
			}
			if voice := s.voices[roomID]; voice != nil {
				delete(voice.members, viewer.PeerID)
			}
		}
		s.syncVoiceDemand(roomID)
		s.syncRoomVoice(roomID)
	}()
	s.sendViewerPresence(roomID)
}

// closeRevokedViewerSession deauthorizes
// before the close so queued callbacks of the old generation cannot route
// signaling after the persistent authorization commit.
func (s *Server) closeRevokedViewerSession(sessionID string) {
	sess := s.sessionsByID[sessionID]
	if sess == nil {
		return
	}
	if sess.sessionID == sessionID {
		sess.clearAuthenticationTimer()
		sess.revoked = true
	}
	if s.sessionsByID[sessionID] == sess {
		delete(s.sessionsByID, sessionID)
	}
	sess.close(websocket.StatusCode(protocol.SignalCloseViewerAccessRevoked), "Viewer access revoked")
}

func (s *Server) clearViewerGrace(roomID, peerID string) {
	key := viewerKey(roomID, peerID)
	if timer, ok := s.viewerGraceTimers[key]; ok {
		timer.stop()
		delete(s.viewerGraceTimers, key)
	}
}

func (s *Server) clearViewerState(roomID, peerID string) {
	s.clearViewerGrace(roomID, peerID)
	s.clearViewerEvidence(roomID, peerID)
}

// clearRoomGraceTimers scans by room prefix; Go maps allow deletion during range.
func (s *Server) clearRoomGraceTimers(roomID string) {
	prefix := roomID + ":"
	for key, timer := range s.viewerGraceTimers {
		if strings.HasPrefix(key, prefix) {
			timer.stop()
			delete(s.viewerGraceTimers, key)
		}
	}
}

func (s *Server) clearRoomViewerEvidence(roomID string) {
	prefix := roomID + ":"
	for key := range s.viewerQualityEvidenceGates {
		if strings.HasPrefix(key, prefix) {
			delete(s.viewerQualityEvidenceGates, key)
		}
	}
	for key := range s.viewerQualityEvidenceAttempts {
		if strings.HasPrefix(key, prefix) {
			delete(s.viewerQualityEvidenceAttempts, key)
		}
	}
}

// clearViewerEvidence drops one viewer's evidence gate and rate stamp.
func (s *Server) clearViewerEvidence(roomID, viewerPeerID string) {
	key := viewerKey(roomID, viewerPeerID)
	delete(s.viewerQualityEvidenceGates, key)
	delete(s.viewerQualityEvidenceAttempts, key)
}
