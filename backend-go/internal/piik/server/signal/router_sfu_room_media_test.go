package signal

import (
	"context"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
	"zviewer/backend/internal/piik/media/forwarding"
	"zviewer/backend/internal/piik/server/protocol"
	"zviewer/backend/internal/piik/server/route"
	"zviewer/backend/internal/piik/server/sfu"
)

func TestRoomSfuVideoFailureRetainsRoomAdmissionDuringReplacement(t *testing.T) {
	h := newRouterHarness(t, routerHarnessOptions{capacity: 1, withSfu: true})
	created := h.createRoom()
	host, first, _ := h.establishSfuRoom(created)
	h.settle()
	h.locked(func() {
		rm, _ := h.router.rooms.Get(created.RoomID)
		rm.roomMedia = true
		rm.controller.SetVideoPublication(testShareGeneration, false, h.router.now())
		publication := rm.controller.Publication()
		edge, _ := rm.controller.Snapshot().UpstreamByViewer.Get(first.peerID)
		fence := resourceFence(publication.Resource)
		h.router.handleRouteFailed(host, routeFailedMessage(rm.controller.Revision(), "active", publication.ConnectionID))
		current := rm.controller.Publication()
		if current == nil || current.Generation != publication.Generation || !current.PhysicalActive {
			t.Fatal("video failure retired the room publication before replacement")
		}
		if !h.admission.HasPublication(fence) || !h.admission.HasSubscription(subscriptionFence(edge.Resource)) {
			t.Fatal("video failure released room admission used by healthy voice")
		}
	})
}

func TestRoomSfuVideoAttachmentUsesExistingAdmissionAndExactPhysicalIdentity(t *testing.T) {
	h := newRouterHarness(t, routerHarnessOptions{capacity: 1, withSfu: true})
	created := h.createRoom()
	host, first, second := h.establishSfuRoom(created)
	h.settle()
	h.locked(func() {
		rm, _ := h.router.rooms.Get(created.RoomID)
		rm.roomMedia, rm.mediaGeneration = true, "room_media_12345678"
		rm.controller.SetVideoPublication(testShareGeneration, false, h.router.now())
		publication := rm.controller.Publication()
		originalHostID := publication.ConnectionID
		rm.controller.SetVideoPublication("", false, h.router.now())
		rm.controller.SetVideoPublication("video_next_12345678", false, h.router.now())
		rm.controller.SetHostVideoConnectionID("publisher_next_12345678")
		op := rm.controller.Reconcile(h.router.now()).Operation
		if op == nil || op.Reason != route.DemandPublicationAttach {
			t.Fatal("expected publication attachment")
		}
		child, other := first, second
		if op.ChildPeerID == second.peerID {
			child, other = second, first
		}
		edge, _ := rm.controller.Snapshot().UpstreamByViewer.Get(child.peerID)
		begun := rm.controller.BeginCurrentCandidate(route.BeginInput{
			Guard: cursorGuard(op, op.Candidates[op.Cursor]), NowMs: h.router.now(),
			ConnectionID: "subscriber_next_12345678",
		})
		if !begun.Accepted {
			t.Fatal("attachment did not begin")
		}
		op = begun.Operation
		message := protocol.SfuSignalMessage{Type: "sfu-signal", Kind: "candidate",
			Revision: protocol.Int(op.Current.Revision), PublicationGeneration: publication.Generation,
			ConnectionID: op.Current.ConnectionID}
		fence, allowed := h.router.sfuSignalAuthorized(child, message)
		if !allowed || fence.ConnectionID != edge.ConnectionID || fence.ResourceFence != resourceFence(publication.Resource) {
			t.Fatal("physical video attachment did not retain the exact logical reservation")
		}
		if _, allowed := h.router.sfuSignalAuthorized(other, message); allowed {
			t.Fatal("another viewer could use the admitted video facet")
		}
		stale := child
		stale.sessionID = "replaced_session_12345678"
		if _, allowed := h.router.sfuSignalAuthorized(stale, message); allowed {
			t.Fatal("stale session could signal an attachment")
		}
		voiceOnly := message
		voiceOnly.ConnectionID = edge.ConnectionID
		if _, allowed := h.router.sfuSignalAuthorized(child, voiceOnly); allowed {
			t.Fatal("room connection identity was accepted as the replacement video identity")
		}
		hostMessage := message
		hostMessage.ConnectionID = "publisher_next_12345678"
		if _, allowed := h.router.sfuSignalAuthorized(host, hostMessage); !allowed {
			t.Fatal("replacement publisher was rejected")
		}
		phase, revision := sfuConnectionPhase(rm.controller.Snapshot(), host.role, host.peerID,
			publication.Generation, hostMessage.ConnectionID)
		if phase != "prepare" || revision != op.Current.Revision {
			t.Fatal("publisher attachment lost its current operation phase")
		}
		h.router.prepareSfuVideoAttachment(created.RoomID, op)
		h.router.sendFreshSfuConfig(child)
		config, ok := h.sent[child.sessionID][len(h.sent[child.sessionID])-1].(protocol.SfuConfigMessage)
		if !ok || config.ConnectionID != message.ConnectionID || config.Revision != message.Revision {
			t.Fatal("reauthentication did not describe the pending physical attachment")
		}
		guard := route.CandidateGuard{ChildPeerID: child.peerID, ChildSessionID: child.sessionID,
			Revision: op.Current.Revision, ConnectionID: op.Current.ConnectionID}
		if !rm.controller.CandidateReady(guard, h.router.now(), nil,
			route.CandidateProof{VideoGeneration: "video_next_12345678"}).Committed {
			t.Fatal("video proof did not commit")
		}
		message.Revision = protocol.Int(rm.controller.Revision())
		if _, allowed := h.router.sfuSignalAuthorized(child, message); !allowed {
			t.Fatal("committed video facet was rejected")
		}
		h.router.handleSfuMediaEvent(sfu.MediaEvent{Fence: resourceFence(publication.Resource),
			ConnectionID: originalHostID, State: webrtc.PeerConnectionStateFailed})
		if current := rm.controller.Publication(); !current.Usable || current.ConnectionID != hostMessage.ConnectionID {
			t.Fatal("retired publisher callback invalidated its replacement")
		}
		rm.controller.SetVideoPublication("", false, h.router.now())
		if _, allowed := h.router.sfuSignalAuthorized(child, message); allowed {
			t.Fatal("stopped video retained signaling authority")
		}
		if !h.admission.HasSubscription(fence) || !h.admission.HasPublication(fence.ResourceFence) {
			t.Fatal("video stop released room admission")
		}
	})
}

func TestRoomSfuVideoRetirementDetachesBeforeCloseAndKeepsAdmission(t *testing.T) {
	h := newRouterHarness(t, routerHarnessOptions{capacity: 1, withSfu: true})
	created := h.createRoom()
	h.establishSfuRoom(created)
	h.settle()
	media := sfu.NewMedia(sfu.MediaOptions{})
	defer media.Close()
	h.locked(func() {
		rm, _ := h.router.rooms.Get(created.RoomID)
		rm.roomMedia, rm.mediaGeneration = true, "room_media_12345678"
		rm.controller.SetVideoPublication(testShareGeneration, false, h.router.now())
		publication := rm.controller.Publication()
		fence := resourceFence(publication.Resource)
		metadata := sfu.PublicationMedia{Codec: "vp8", RIDs: []string{""},
			Formats: []forwarding.LayerFormat{{Width: 640, Height: 360, Bitrate: 500_000}}}
		if err := media.PreparePublication(fence, publication.ConnectionID, metadata); err != nil {
			t.Fatal(err)
		}
		h.router.sfu.media = media
		h.router.retireRoomVideo(created.RoomID, rm)
		if media.HasPublication(fence, publication.ConnectionID) {
			t.Fatal("retired video remained visible while physical close was pending")
		}
		if !h.admission.HasPublication(fence) {
			t.Fatal("video retirement released room ingress")
		}
		if err := media.PreparePublication(fence, "replacement_publisher_12345678", metadata); err != nil {
			t.Fatal(err)
		}
		if retired := media.RetirePublication(fence, publication.ConnectionID); retired != nil {
			t.Fatal("old identity detached the replacement")
		}
	})
	h.settle()
	h.locked(func() {
		rm, _ := h.router.rooms.Get(created.RoomID)
		fence := resourceFence(rm.controller.Publication().Resource)
		if !media.HasPublication(fence, "replacement_publisher_12345678") {
			t.Fatal("old physical close removed the replacement")
		}
		if h.router.sfuDrainTasks.Len() != 0 {
			t.Fatal("retired physical close did not settle")
		}
	})
}

func TestSfuLogicalSubscriptionDrainClosesPendingPhysicalVideo(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	demand := make(chan struct{}, 1)
	media := sfu.NewMedia(sfu.MediaOptions{Events: func(event sfu.MediaEvent) {
		if event.ActiveCount != nil {
			select {
			case demand <- struct{}{}:
			default:
			}
		}
	}})
	defer media.Close()
	fence := sfu.SubscriptionFence{ResourceFence: sfu.ResourceFence{RoomID: "1234",
		ShareGeneration: "room_media_12345678", PublicationGeneration: "publication_12345678"},
		ViewerPeerID: "viewer_12345678", ConnectionID: "logical_edge_12345678"}
	if err := media.PreparePublication(fence.ResourceFence, "publisher_12345678", sfu.PublicationMedia{
		Codec: "vp8", RIDs: []string{""}, Formats: []forwarding.LayerFormat{{Width: 640, Height: 360, Bitrate: 500_000}},
	}); err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() {
		_, err := media.PrepareSubscriber(ctx, fence, "physical_video_12345678")
		result <- err
	}()
	select {
	case <-demand:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if err := media.CloseSubscription(fence, fence.ConnectionID); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-result:
		if err == nil {
			t.Fatal("retired waiting subscriber was prepared")
		}
	case <-ctx.Done():
		t.Fatal("logical drain did not cancel physical video preparation")
	}
}

type heldVideoRetirement struct {
	*sfu.Media
	started  chan struct{}
	release  chan struct{}
	oldClose func() error
}

type heldPublicationCreation struct {
	*sfu.Media
	oldConnection                       string
	entered, release, accepting, finish chan struct{}
}

func (m *heldPublicationCreation) PreparePublication(fence sfu.ResourceFence, connection string, metadata sfu.PublicationMedia) error {
	if connection == m.oldConnection {
		close(m.entered)
		<-m.release
	}
	return m.Media.PreparePublication(fence, connection, metadata)
}

func (m *heldPublicationCreation) AcceptPublisherOffer(_ sfu.ResourceFence, connection string, _ webrtc.SessionDescription) (webrtc.SessionDescription, error) {
	if connection == m.oldConnection {
		close(m.accepting)
		<-m.finish
	}
	return webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: "answer"}, nil
}

func (*heldPublicationCreation) PrepareSubscriber(context.Context, sfu.SubscriptionFence, string) (webrtc.SessionDescription, error) {
	return webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: "offer"}, nil
}

func TestSfuPublicationCreationCannotOccupyReplacementRoomShare(t *testing.T) {
	h := newRouterHarness(t, routerHarnessOptions{capacity: 1, withSfu: true})
	created := h.createRoom()
	host, first, second := h.establishSfuRoom(created)
	h.settle()
	media := &heldPublicationCreation{Media: sfu.NewMedia(sfu.MediaOptions{}), entered: make(chan struct{}), release: make(chan struct{}), accepting: make(chan struct{}), finish: make(chan struct{})}
	defer media.Close()
	finished := false
	released := false
	defer func() {
		if !finished {
			close(media.finish)
		}
		if !released {
			close(media.release)
		}
	}()
	var message protocol.SfuSignalMessage
	var fence sfu.ResourceFence
	h.locked(func() {
		rm, _ := h.router.rooms.Get(created.RoomID)
		rm.roomMedia, rm.mediaGeneration = true, "room_media_12345678"
		rm.controller.SetVideoPublication(testShareGeneration, false, h.router.now())
		rm.controller.SetVoiceListeners([]string{host.peerID, first.peerID, second.peerID}, h.router.now())
		publication := rm.controller.Publication()
		fence = resourceFence(publication.Resource)
		media.oldConnection = publication.ConnectionID
		h.router.sfu.media = media
		h.sent = map[string][]protocol.ServerMessage{}
		message = protocol.SfuSignalMessage{Type: "sfu-signal", Kind: "description", Revision: protocol.Int(rm.controller.Revision()),
			PublicationGeneration: publication.Generation, ConnectionID: publication.ConnectionID,
			Description: &protocol.SessionDescription{Type: "offer", SDP: "offer"},
			Media:       &protocol.SfuMedia{Codec: "vp8", Layers: []protocol.SfuLayer{{Width: 640, Height: 360, Bitrate: 500_000}}}}
	})
	done := make(chan struct{})
	go func() { h.locked(func() { h.router.handleSfuSignal(host, message) }); close(done) }()
	select {
	case <-media.entered:
	case <-time.After(defaultWait):
		t.Fatal("old publication creation did not start")
	}
	stopping, stopped := make(chan struct{}), make(chan struct{})
	go func() {
		close(stopping)
		h.locked(func() {
			h.router.setVideoPublication(created.RoomID, "", false)
			h.router.setVideoPublication(created.RoomID, "video_latest_12345678", false)
		})
		close(stopped)
	}()
	<-stopping
	// Give the replacement the opportunity to overtake the held constructor.
	// Its observable result, rather than lock availability, is asserted below.
	select {
	case <-stopped:
	case <-time.After(50 * time.Millisecond):
	}
	close(media.release)
	released = true
	select {
	case <-media.accepting:
	case <-time.After(defaultWait):
		t.Fatal("old SDP did not start")
	}
	select {
	case <-stopped:
	case <-time.After(defaultWait):
		t.Fatal("room share did not replace")
	}
	h.settle()
	var latest protocol.SfuConfigMessage
	h.locked(func() {
		rm, _ := h.router.rooms.Get(created.RoomID)
		if resourceFence(rm.controller.Publication().Resource) != fence {
			t.Fatal("voice room reservation changed across picture replacement")
		}
		for _, sent := range h.sent[host.sessionID] {
			if config, ok := sent.(protocol.SfuConfigMessage); ok {
				latest = config
			}
		}
		if latest.ConnectionID == "" || latest.ConnectionID == message.ConnectionID {
			t.Fatal("latest share was not configured")
		}
		next := message
		next.ConnectionID, next.Revision = latest.ConnectionID, latest.Revision
		h.router.handleSfuSignal(host, next)
		if !media.HasPublication(fence, latest.ConnectionID) {
			t.Fatal("late old creation occupied the current share's room reservation")
		}
		answered := false
		for _, sent := range h.sent[host.sessionID] {
			if reply, ok := sent.(protocol.SfuSignalMessage); ok && reply.ConnectionID == latest.ConnectionID && reply.Description != nil {
				answered = true
			}
		}
		if !answered {
			t.Fatal("latest share offer failed behind the old occupant")
		}
	})
	// The old SDP completion must not retire the newly accepted physical owner.
	close(media.finish)
	finished = true
	select {
	case <-done:
	case <-time.After(defaultWait):
		t.Fatal("old SDP completion did not settle")
	}
	h.settle()
	if !media.HasPublication(fence, latest.ConnectionID) {
		t.Fatal("old completion retired the current share")
	}
}

func (m *heldVideoRetirement) RetirePublication(fence sfu.ResourceFence, connection string) func() error {
	work := m.Media.RetirePublication(fence, connection)
	if work == nil {
		return nil
	}
	m.oldClose = work
	return func() error {
		close(m.started)
		<-m.release
		return work()
	}
}

func TestRoomSfuVideoReplacementWaitsForPhysicalRetirement(t *testing.T) {
	for _, intent := range []string{"newest-share", "stopped", "abandoned"} {
		t.Run(intent, func(t *testing.T) {
			stop := intent != "newest-share"
			h := newRouterHarness(t, routerHarnessOptions{capacity: 1, withSfu: true})
			created := h.createRoom()
			host, first, second := h.establishSfuRoom(created)
			h.settle()
			media := &heldVideoRetirement{Media: sfu.NewMedia(sfu.MediaOptions{}), started: make(chan struct{}), release: make(chan struct{})}
			defer media.Close()
			released := false
			defer func() {
				if !released {
					close(media.release)
				}
			}()
			metadata := sfu.PublicationMedia{Codec: "vp8", RIDs: []string{""}, Formats: []forwarding.LayerFormat{{Width: 640, Height: 360, Bitrate: 500_000}}}
			var fence sfu.ResourceFence
			var latestID string
			var fullDrain *drainOperation
			h.locked(func() {
				rm, _ := h.router.rooms.Get(created.RoomID)
				rm.roomMedia, rm.mediaGeneration = true, "room_media_12345678"
				rm.controller.SetVideoPublication(testShareGeneration, false, h.router.now())
				rm.controller.SetVoiceListeners([]string{host.peerID, first.peerID, second.peerID}, h.router.now())
				publication := rm.controller.Publication()
				fence = resourceFence(publication.Resource)
				if err := media.PreparePublication(fence, publication.ConnectionID, metadata); err != nil {
					t.Fatal(err)
				}
				h.router.sfu.media = media
				h.sent = map[string][]protocol.ServerMessage{}
				h.router.setVideoPublication(created.RoomID, "", false)
				h.router.setVideoPublication(created.RoomID, "video_first_12345678", false)
			})
			select {
			case <-media.started:
			case <-time.After(defaultWait):
				t.Fatal("physical retirement did not start")
			}
			h.locked(func() {
				rm, _ := h.router.rooms.Get(created.RoomID)
				if stop {
					h.router.setVideoPublication(created.RoomID, "", false)
				} else {
					h.router.setVideoPublication(created.RoomID, "video_latest_12345678", false)
					latestID = rm.controller.Publication().ConnectionID
					h.router.sendFreshSfuConfig(host)
				}
				for _, messages := range h.sent {
					for _, message := range messages {
						if _, ok := message.(protocol.SfuConfigMessage); ok {
							t.Fatal("new picture allocated before old physical join")
						}
					}
				}
				if !h.admission.HasPublication(fence) || rm.controller.Publication() == nil {
					t.Fatal("picture retirement discarded voice admission")
				}
				if intent == "abandoned" {
					h.router.deleteRoom(created.RoomID)
					task, _ := h.router.sfuDrainTasks.Get(sfu.SubscriptionFence{ResourceFence: fence})
					fullDrain = task.operation
				}
			})
			if fullDrain != nil {
				select {
				case <-fullDrain.done:
					t.Fatal("room drain released admission before retired picture joined")
				case <-time.After(50 * time.Millisecond):
				}
			}
			close(media.release)
			released = true
			h.settle()
			h.locked(func() {
				if intent == "abandoned" {
					if h.admission.Usage().Ingress != 0 || h.router.sfuDrainTasks.Len() != 0 {
						t.Fatal("room admission did not release after every physical join")
					}
					return
				}
				rm, _ := h.router.rooms.Get(created.RoomID)
				configs := 0
				for _, message := range h.sent[host.sessionID] {
					if config, ok := message.(protocol.SfuConfigMessage); ok {
						configs++
						if stop || config.ConnectionID != latestID {
							t.Fatal("retirement resumed superseded picture intent")
						}
					}
				}
				if !stop && configs == 0 {
					t.Fatal("latest picture did not resume after physical join")
				}
				if stop && configs != 0 {
					t.Fatal("retirement resurrected stopped picture")
				}
				if rm.controller.Publication() == nil || !h.admission.HasPublication(fence) {
					t.Fatal("voice admission did not survive picture handoff")
				}
				if !stop {
					if err := media.PreparePublication(fence, latestID, metadata); err != nil {
						t.Fatal(err)
					}
					if err := media.oldClose(); err != nil {
						t.Fatal(err)
					}
					if !media.HasPublication(fence, latestID) {
						t.Fatal("late old close removed current picture")
					}
				}
			})
		})
	}
}
