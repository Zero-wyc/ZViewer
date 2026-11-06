package signal

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/rtcerr"
	"zviewer/backend/internal/diagnostics"
	"zviewer/backend/internal/piik/media/forwarding"
	"zviewer/backend/internal/piik/server/protocol"
	"zviewer/backend/internal/piik/server/route"
	"zviewer/backend/internal/piik/server/sfu"
)

func (r *router) sfuSignalAuthorized(participant authenticatedRouteParticipant, message protocol.SfuSignalMessage) (sfu.SubscriptionFence, bool) {
	fence := sfu.SubscriptionFence{ResourceFence: sfu.ResourceFence{
		RoomID: participant.roomID, ShareGeneration: r.hooks.shareGeneration(participant.roomID),
		PublicationGeneration: message.PublicationGeneration,
	}, ConnectionID: message.ConnectionID}
	rm, _ := r.rooms.Get(participant.roomID)
	peer, connected := r.connectedPeer(participant.roomID, participant.peerID)
	if r.closing || r.sfu == nil || rm == nil || rm.controller == nil || !connected || peer.SessionID != participant.sessionID {
		return fence, false
	}
	snapshot := rm.controller.Snapshot()
	if rm.roomMedia {
		if snapshot.VideoGeneration == "" {
			return fence, false
		}
		fence.ShareGeneration = rm.mediaGeneration
		// Opting into voice during an existing share preserves its admitted
		// resource fence, even though subsequent publications are room-scoped.
		if publication := snapshot.HostPublication; publication != nil &&
			publication.Generation == message.PublicationGeneration && publication.Resource != nil {
			fence.ResourceFence = resourceFence(publication.Resource)
		}
	}
	latestRevision := snapshot.Revision
	if snapshot.Operation != nil && snapshot.Operation.Current != nil {
		latestRevision = max(latestRevision, snapshot.Operation.Current.Revision)
	}
	if int64(message.Revision) > latestRevision {
		return fence, false
	}
	if r.sfuVideoRetiring(fence.ResourceFence) {
		return fence, false
	}
	if participant.role == protocol.RoleHost {
		publication := snapshot.HostPublication
		if publication != nil && publication.PhysicalActive && publication.Generation == message.PublicationGeneration &&
			publication.ConnectionID == message.ConnectionID && publication.HostSessionID == participant.sessionID {
			return fence, r.sfu.admission.HasPublication(fence.ResourceFence)
		}
		operation := snapshot.Operation
		return fence, participant.peerID == rm.hostPeerID && operation != nil && operation.Current != nil &&
			operation.Current.Tuple.Kind == route.UpstreamSfu && operation.Current.Tuple.Publication != route.PublicationReuse &&
			operation.Current.Revision == int64(message.Revision) && message.ConnectionID == message.PublicationGeneration &&
			r.sfu.admission.HasPublication(fence.ResourceFence)
	}
	fence.ViewerPeerID = participant.peerID
	if rm.roomMedia {
		operation := snapshot.Operation
		edge, hasEdge := snapshot.UpstreamByViewer.Get(participant.peerID)
		if hasEdge && edge.Kind == route.UpstreamSfu && edge.PhysicalActive &&
			edge.ChildSessionID == participant.sessionID && edge.PublicationGeneration == message.PublicationGeneration {
			active := edge.VideoReady && edge.VideoConnectionID == message.ConnectionID
			attaching := operation != nil && operation.Current != nil &&
				operation.Reason == route.DemandPublicationAttach &&
				operation.Current.Tuple.Kind == route.UpstreamSfu &&
				operation.ChildPeerID == participant.peerID && operation.ChildSessionID == participant.sessionID &&
				operation.AttachConnectionID == edge.ConnectionID &&
				operation.Current.Revision == int64(message.Revision) &&
				operation.Current.ConnectionID == message.ConnectionID
			if active || attaching {
				if edge.Resource == nil {
					return fence, false
				}
				fence = subscriptionFence(edge.Resource)
				return fence, r.sfu.admission.HasSubscription(fence)
			}
		}
	}
	if !r.sfu.admission.HasSubscription(fence) {
		return fence, false
	}
	if edge, ok := snapshot.UpstreamByViewer.Get(participant.peerID); !rm.roomMedia && ok && edge.PhysicalActive && edge.Kind == route.UpstreamSfu &&
		edge.PublicationGeneration == message.PublicationGeneration && edge.ConnectionID == message.ConnectionID && edge.ChildSessionID == participant.sessionID {
		return fence, true
	}
	operation := snapshot.Operation
	return fence, operation != nil && operation.Current != nil && operation.ChildPeerID == participant.peerID &&
		operation.ChildSessionID == participant.sessionID && operation.Current.Tuple.Kind == route.UpstreamSfu &&
		operation.Current.Revision == int64(message.Revision) && operation.Current.ConnectionID == message.ConnectionID
}

func (r *router) handleSfuSignal(participant authenticatedRouteParticipant, message protocol.SfuSignalMessage) {
	fence, allowed := r.sfuSignalAuthorized(participant, message)
	if !allowed {
		return
	}
	media := r.sfu.media
	// Each session's input loop serializes SDP/ICE. SDP negotiation is bounded
	// by the route operation and runs outside the authority mutex.
	var description webrtc.SessionDescription
	var err error
	newPublication := false
	// Register the physical owner before releasing authority. Retirement must
	// see this handle even when the SDP effect has not started yet.
	if message.Kind == "description" && participant.role == protocol.RoleHost &&
		message.Description.Type == "offer" && !media.HasPublication(fence.ResourceFence, message.ConnectionID) {
		if message.Media == nil {
			return
		}
		err = media.PreparePublication(fence.ResourceFence, message.ConnectionID, sfuPublicationMedia(message.Media))
		newPublication = err == nil
	}
	r.io(func() {
		if err != nil {
			return
		}
		switch message.Kind {
		case "media":
			if participant.role == protocol.RoleHost {
				err = media.UpdatePublication(fence.ResourceFence, message.ConnectionID, sfuPublicationMedia(message.Media))
			}
		case "description":
			incoming := webrtc.SessionDescription{Type: webrtc.NewSDPType(message.Description.Type), SDP: message.Description.SDP}
			if participant.role == protocol.RoleHost {
				if incoming.Type != webrtc.SDPTypeOffer {
					return
				}
				description, err = media.AcceptPublisherOffer(fence.ResourceFence, message.ConnectionID, incoming)
			} else if incoming.Type == webrtc.SDPTypeAnswer {
				err = media.ApplySubscriberAnswer(fence, message.ConnectionID, incoming)
			}
		case "candidate":
			var candidate webrtc.ICECandidateInit
			if message.Candidate != nil {
				encoded, _ := json.Marshal(message.Candidate)
				_ = json.Unmarshal(encoded, &candidate)
			}
			if participant.role == protocol.RoleHost {
				err = media.AddPublisherICE(fence.ResourceFence, message.ConnectionID, candidate)
			} else {
				err = media.AddSubscriberICE(fence, message.ConnectionID, candidate)
			}
		case "subscribe":
			if participant.role == protocol.RoleViewer {
				description, err = media.RestartSubscriber(fence, message.ConnectionID)
			}
		}
	})
	if _, allowed := r.sfuSignalAuthorized(participant, message); !allowed {
		if newPublication {
			r.retireSfuVideoPublication(fence.ResourceFence, message.ConnectionID)
		}
		return
	}
	if err != nil {
		r.debug(participant.roomID, "sfu-signal-failed",
			"participant", r.debugPeer(participant.roomID, participant.peerID),
			"role", participant.role, "kind", message.Kind, diagnostics.Error(err))
		var candidateError *rtcerr.OperationError
		if message.Kind == "candidate" && errors.As(err, &candidateError) {
			return
		}
		r.failSfuConnection(participant, message)
		return
	}
	if description.SDP != "" {
		r.sendSfuDescription(participant.sessionID, message, description)
	}
	if newPublication {
		rm, _ := r.rooms.Get(participant.roomID)
		operation := rm.controller.Operation()
		if operation != nil && operation.Current != nil && operation.Current.Tuple.Kind == route.UpstreamSfu {
			r.prepareSfuSubscriber(participant.roomID, operation, message.PublicationGeneration)
		}
	}
}

func sfuPublicationMedia(value *protocol.SfuMedia) sfu.PublicationMedia {
	metadata := sfu.PublicationMedia{Codec: value.Codec, Audio: value.Audio, AudioBitrate: uint32(value.AudioBitrate)}
	for _, layer := range value.Layers {
		metadata.RIDs = append(metadata.RIDs, layer.RID)
		metadata.Formats = append(metadata.Formats, forwarding.LayerFormat{Width: uint32(layer.Width), Height: uint32(layer.Height), Bitrate: uint32(layer.Bitrate)})
	}
	return metadata
}

func (r *router) prepareSfuSubscriber(roomID string, operation *route.OperationSnapshot, generation string) {
	message := protocol.SfuSignalMessage{Type: "sfu-signal", Kind: "description", Revision: protocol.Int(operation.Current.Revision), PublicationGeneration: generation, ConnectionID: operation.Current.ConnectionID}
	participant := authenticatedRouteParticipant{roomID: roomID, role: protocol.RoleViewer, peerID: operation.ChildPeerID, sessionID: operation.ChildSessionID}
	fence, allowed := r.sfuSignalAuthorized(participant, message)
	if !allowed {
		return
	}
	media := r.sfu.media
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(max(int64(0), operation.DeadlineAtMs-r.now()))*time.Millisecond)
	r.inflight++
	go func() {
		defer cancel()
		description, err := media.PrepareSubscriber(ctx, fence, message.ConnectionID)
		r.mu.Lock()
		defer r.mu.Unlock()
		r.inflight--
		if _, allowed := r.sfuSignalAuthorized(participant, message); !allowed {
			go media.CloseSubscription(fence, message.ConnectionID)
			return
		}
		if err != nil {
			r.debug(roomID, "sfu-subscriber-prepare-failed",
				"participant", r.debugPeer(roomID, participant.peerID), diagnostics.Error(err))
			r.failSfuConnection(participant, message)
			return
		}
		r.sendSfuDescription(participant.sessionID, message, description)
	}()
}

func (r *router) sendSfuDescription(sessionID string, message protocol.SfuSignalMessage, description webrtc.SessionDescription) {
	message.Kind = "description"
	message.Description = &protocol.SessionDescription{Type: description.Type.String(), SDP: description.SDP}
	message.Media, message.Candidate = nil, nil
	r.hooks.sendToSession(sessionID, message)
}

func (r *router) failSfuConnection(participant authenticatedRouteParticipant, message protocol.SfuSignalMessage) {
	rm, _ := r.rooms.Get(participant.roomID)
	if rm == nil || rm.controller == nil {
		return
	}
	connectionID := message.ConnectionID
	snapshot := rm.controller.Snapshot()
	phase, revision := sfuConnectionPhase(snapshot, participant.role, participant.peerID, message.PublicationGeneration, connectionID)
	if phase == "prepare" {
		connectionID = snapshot.Operation.Current.ConnectionID
	}
	r.handleRouteFailed(participant, protocol.RouteFailedMessage{Type: "route-failed", Revision: protocol.Int(revision), Phase: phase, ConnectionID: &connectionID})
}

func sfuConnectionPhase(snapshot route.RouteSnapshot, role protocol.Role, peerID, generation, connectionID string) (string, int64) {
	operation := snapshot.Operation
	if operation != nil && operation.Current != nil && operation.Current.Tuple.Kind == route.UpstreamSfu &&
		(role == protocol.RoleViewer && operation.ChildPeerID == peerID && operation.Current.ConnectionID == connectionID ||
			role == protocol.RoleHost && (connectionID == generation && (snapshot.HostPublication == nil || snapshot.HostPublication.Generation != generation) ||
				snapshot.RoomMedia && operation.Reason == route.DemandPublicationAttach &&
					snapshot.HostPublication != nil && snapshot.HostPublication.Generation == generation &&
					snapshot.HostPublication.ConnectionID == connectionID)) {
		return "prepare", operation.Current.Revision
	}
	return "active", snapshot.Revision
}

// Media callbacks identify physical handles; signaling reconnect does not retire them.
func (s *Server) HandleSfuMediaEvent(event sfu.MediaEvent) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.router.handleSfuMediaEvent(event)
}

func (r *router) handleSfuMediaEvent(event sfu.MediaEvent) {
	rm, _ := r.rooms.Get(event.Fence.RoomID)
	if r.closing || rm == nil || rm.controller == nil ||
		(!rm.roomMedia && r.hooks.shareGeneration(event.Fence.RoomID) != event.Fence.ShareGeneration) {
		return
	}
	peerID, role := event.ViewerPeerID, protocol.RoleViewer
	if peerID == "" {
		peerID, role = rm.hostPeerID, protocol.RoleHost
	}
	peer, connected := r.connectedPeer(event.Fence.RoomID, peerID)
	snapshot := rm.controller.Snapshot()
	if rm.roomMedia {
		publication := snapshot.HostPublication
		expectedGeneration := rm.mediaGeneration
		if publication != nil && publication.Generation == event.Fence.PublicationGeneration && publication.Resource != nil {
			expectedGeneration = publication.Resource.ShareGeneration
		}
		if snapshot.VideoGeneration == "" || expectedGeneration != event.Fence.ShareGeneration {
			return
		}
	}
	participant := authenticatedRouteParticipant{roomID: event.Fence.RoomID, role: role, peerID: peerID, sessionID: peer.SessionID}
	phase, revision := sfuConnectionPhase(snapshot, role, peerID, event.Fence.PublicationGeneration, event.ConnectionID)
	message := protocol.SfuSignalMessage{Type: "sfu-signal", Kind: "candidate", Revision: protocol.Int(revision), PublicationGeneration: event.Fence.PublicationGeneration, ConnectionID: event.ConnectionID}
	if !connected && role == protocol.RoleHost && event.State == webrtc.PeerConnectionStateFailed {
		publication := snapshot.HostPublication
		if publication != nil && publication.Generation == event.Fence.PublicationGeneration && publication.ConnectionID == event.ConnectionID {
			participant.sessionID = publication.HostSessionID
			r.failSfuConnection(participant, message)
		}
		return
	}
	if _, allowed := r.sfuSignalAuthorized(participant, message); !allowed {
		return
	}
	if event.ActiveCount != nil {
		message.Kind = "layers"
		count := protocol.Int(*event.ActiveCount)
		message.ActiveCount = &count
		r.hooks.sendToSession(participant.sessionID, message)
		return
	}
	if event.State != webrtc.PeerConnectionStateUnknown {
		r.debug(participant.roomID, "sfu-transport-state",
			"participant", r.debugPeer(participant.roomID, participant.peerID),
			"connectionId", diagnostics.ID(event.ConnectionID),
			"publicationGeneration", diagnostics.ID(event.Fence.PublicationGeneration),
			"role", role, "phase", phase, "revision", revision, "state", event.State.String())
		if event.State == webrtc.PeerConnectionStateFailed {
			r.failSfuConnection(participant, message)
		}
		return
	}
	if event.Candidate != nil {
		encoded, _ := json.Marshal(event.Candidate)
		_ = json.Unmarshal(encoded, &message.Candidate)
	}
	r.hooks.sendToSession(participant.sessionID, message)
}
