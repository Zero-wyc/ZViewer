package signal

import (
	"encoding/json"
	"slices"

	"github.com/pion/webrtc/v4"
	"zviewer/backend/internal/piik/server/protocol"
	"zviewer/backend/internal/piik/server/route"
	"zviewer/backend/internal/piik/server/sfu"
)

func (s *Server) voiceRouteFailed(roomID, peerID string) {
	if sess, _ := s.voiceSession(roomID, peerID); sess != nil {
		s.voiceError(sess, "connection-unavailable")
	}
}

func (s *Server) voiceConnection(roomID, peerID, sessionID, id string) *voiceEdge {
	v := s.voices[roomID]
	if v == nil {
		return nil
	}
	for _, edge := range v.connections {
		if edge.id == id && (edge.parent == peerID && edge.parentSession == sessionID ||
			edge.child == peerID && edge.childSession == sessionID) {
			return edge
		}
	}
	return nil
}

func (s *Server) handleRoomVoiceSignal(sess *session, auth *authenticatedSession, message protocol.RoomVoiceSignalMessage) {
	if !sess.roomVoice {
		return
	}
	edge := s.voiceConnection(auth.roomID, auth.peerID, sess.sessionID, message.ConnectionID)
	if edge == nil || !s.voiceAllowed(auth.roomID, auth.peerID) {
		return
	}
	if edge.transport == "sfu" {
		runtime := s.voiceRuntime()
		if runtime == nil {
			return
		}
		var incoming sfu.VoiceSignal
		encoded, err := json.Marshal(message)
		if err == nil {
			err = json.Unmarshal(encoded, &incoming)
		}
		plan := edge.sfuPlan
		if err == nil {
			s.router.io(func() { err = runtime.SignalVoice(auth.roomID, auth.peerID, sess.sessionID, edge.id, incoming) })
		}
		if err != nil && s.voiceConnection(auth.roomID, auth.peerID, sess.sessionID, edge.id) == edge && edge.sfuPlan == plan {
			s.voiceError(sess, "connection-unavailable")
		}
		return
	}
	other := edge.parent
	if auth.peerID == edge.parent {
		other = edge.child
	}
	target, _ := s.voiceSession(auth.roomID, other)
	if target == nil {
		return
	}
	if description := message.Description; description != nil {
		if (description.SDP.Type == "offer") != (auth.peerID == edge.parent) {
			return
		}
		seen := make(map[string]bool)
		tracks := make([]protocol.VoiceTrack, 0, len(description.Tracks))
		for _, track := range description.Tracks {
			if seen[track.MID] || seen[track.PublicationID] {
				s.voiceError(sess, "not-allowed")
				return
			}
			seen[track.MID], seen[track.PublicationID] = true, true
			if slices.Contains(edge.send[auth.peerID], track.PublicationID) {
				tracks = append(tracks, track)
			}
		}
		// Leaving voice can overtake an offer already in flight. Finish
		// its SDP transaction without reviving a retired publication binding.
		pruned := *description
		pruned.Tracks = tracks
		message.Description = &pruned
	}
	if message.Renegotiate && auth.peerID != edge.child {
		return
	}
	s.send(target, message)
}

func (s *Server) onVoiceMediaEvent(event sfu.VoiceMediaEvent) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closing {
		return
	}
	edge := s.voiceConnection(event.RoomID, event.PeerID, event.SessionID, event.ConnectionID)
	if edge == nil || edge.transport != "sfu" {
		return
	}
	sess, _ := s.voiceSession(event.RoomID, event.PeerID)
	if sess == nil {
		return
	}
	if event.Description != nil || event.Candidate != nil {
		message := protocol.RoomVoiceSignalMessage{Type: "room-voice-signal", ConnectionID: edge.id}
		encoded, err := json.Marshal(sfu.VoiceSignal{Description: event.Description, Candidate: event.Candidate})
		if err == nil {
			err = json.Unmarshal(encoded, &message)
		}
		if err == nil {
			s.send(sess, message)
		}
	}
	if event.State == webrtc.PeerConnectionStateConnected {
		if event.IsCurrentState != nil && !event.IsCurrentState() {
			return
		}
		edge.connected[""] = true
		s.commitVoiceCandidate(event.RoomID)
		s.syncRoomVoice(event.RoomID)
	}
	if event.State == webrtc.PeerConnectionStateFailed {
		s.failVoiceConnection(event.RoomID, edge)
	}
}

func (s *Server) handleRoomVoiceTransport(sess *session, auth *authenticatedSession, message protocol.RoomVoiceTransportMessage) {
	if !sess.roomVoice {
		return
	}
	edge := s.voiceConnection(auth.roomID, auth.peerID, sess.sessionID, message.ConnectionID)
	if edge == nil {
		return
	}
	if message.State == "failed" {
		s.failVoiceConnection(auth.roomID, edge)
		return
	}
	edge.connected[auth.peerID] = true
	s.commitVoiceCandidate(auth.roomID)
	s.syncRoomVoice(auth.roomID)
}

func (s *Server) commitVoiceCandidate(roomID string) {
	rm, _ := s.router.rooms.Get(roomID)
	if rm == nil || rm.controller == nil || !rm.roomMedia {
		return
	}
	op := rm.controller.Operation()
	if op == nil || op.Current == nil || op.AttachConnectionID != "" {
		return
	}
	v := s.voices[roomID]
	if v == nil {
		return
	}
	edge := v.connections[op.Current.ConnectionID]
	if edge == nil || !s.voiceCandidateReady(roomID, op.Current.ConnectionID) {
		return
	}
	if op.VideoGeneration != "" {
		if prepared := rm.pendingMedia; prepared != nil && prepared.connectionID == op.Current.ConnectionID && prepared.videoReady != nil {
			if child, ok := s.store.GetConnectedViewer(roomID, op.ChildPeerID); ok && child.SessionID == op.ChildSessionID {
				s.router.handleRouteReady(authenticatedRouteParticipant{roomID: roomID, role: protocol.RoleViewer, peerID: child.PeerID, sessionID: child.SessionID}, *prepared.videoReady)
			}
		}
		return
	}
	guard := route.CandidateGuard{ChildPeerID: op.ChildPeerID, ChildSessionID: op.ChildSessionID,
		Revision: op.Current.Revision, ConnectionID: op.Current.ConnectionID}
	progress := rm.controller.CandidateTransportConnected(guard, s.now())
	s.router.releaseResources(progress.Released)
	if !progress.Accepted {
		return
	}
	settled := rm.controller.CandidateReady(guard, s.now(), s.router.commitReservation, route.CandidateProof{})
	s.router.releaseResources(settled.Released)
	if settled.Accepted {
		s.router.broadcastActive(roomID, rm)
		s.router.requestPump(roomID)
	}
}

func (s *Server) voiceCandidateReady(roomID, connectionID string) bool {
	v := s.voices[roomID]
	if v == nil {
		return true
	}
	edge := v.connections[connectionID]
	if edge == nil {
		return true
	}
	if !edge.connected[edge.parent] || !edge.connected[edge.child] {
		return false
	}
	if edge.transport != "sfu" {
		return true
	}
	rm, _ := s.router.rooms.Get(roomID)
	if rm == nil || rm.controller == nil {
		return false
	}
	if op := rm.controller.Operation(); op != nil && op.Current != nil && op.Current.ConnectionID == connectionID && op.Current.Tuple.Publication != route.PublicationReuse {
		if prepared := rm.pendingMedia; prepared != nil && prepared.connectionID == connectionID {
			if root := v.connections[prepared.publicationGeneration]; root != nil {
				return root.connected[""] && root.connected[root.child]
			}
			return !s.voiceAllowed(roomID, rm.hostPeerID)
		}
		return false
	}
	return true
}

func (s *Server) failVoiceConnection(roomID string, edge *voiceEdge) {
	rm, _ := s.router.rooms.Get(roomID)
	if rm == nil || rm.controller == nil {
		return
	}
	op := rm.controller.Operation()
	if edge.pending && op != nil && op.Current != nil {
		guard := route.CandidateGuard{ChildPeerID: op.ChildPeerID, ChildSessionID: op.ChildSessionID,
			Revision: op.Current.Revision, ConnectionID: op.Current.ConnectionID}
		failed := rm.controller.CandidateFailed(guard, s.now())
		s.router.releaseResources(failed.Released)
		s.router.broadcastActive(roomID, rm)
		s.router.requestPump(roomID)
		return
	}
	edge.connected[edge.child], edge.connected[edge.parent] = false, false
	snapshot := rm.controller.Snapshot()
	// A companion audio connection is not evidence that the committed picture
	// path failed. Recreate that physical facet on the proven route; only the
	// route owner may replace neighbours or retire the picture connection.
	for child, current := range snapshot.UpstreamByViewer.All() {
		if !current.Usable || !current.PhysicalActive || !current.VideoReady ||
			snapshot.VideoGeneration == "" || current.VideoGeneration != snapshot.VideoGeneration {
			continue
		}
		childFacet := child == edge.child && current.ConnectionID == edge.logicalID
		rootFacet := edge.child == rm.hostPeerID && edge.transport == "sfu" &&
			current.Kind == route.UpstreamSfu && current.PublicationGeneration == edge.logicalID
		if childFacet || rootFacet {
			s.closeVoiceEdge(roomID, edge)
			delete(s.voices[roomID].connections, edge.logicalID)
			s.syncRoomVoice(roomID)
			return
		}
	}
	if current, ok := snapshot.UpstreamByViewer.Get(edge.child); ok && current.ConnectionID == edge.logicalID {
		rm.controller.InvalidateEdge(route.EdgeGuard{ChildPeerID: edge.child, ChildSessionID: current.ChildSessionID,
			ParentSessionID: current.ParentSessionID, RouteRevision: snapshot.Revision, ConnectionID: current.ConnectionID}, s.router.nowPtr())
		s.router.requestPump(roomID)
	} else if publication := snapshot.HostPublication; publication != nil && edge.transport == "sfu" && edge.child == rm.hostPeerID && edge.logicalID == publication.Generation {
		rm.controller.InvalidateHostPublication(route.PublicationGuard{HostSessionID: publication.HostSessionID, RouteRevision: snapshot.Revision,
			Generation: publication.Generation, ConnectionID: publication.ConnectionID}, s.router.nowPtr())
		s.router.requestPump(roomID)
	}
	for _, peerID := range []string{edge.parent, edge.child} {
		if sess, _ := s.voiceSession(roomID, peerID); sess != nil {
			s.voiceError(sess, "connection-unavailable")
		}
	}
}
