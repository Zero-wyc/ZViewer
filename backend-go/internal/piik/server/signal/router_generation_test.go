package signal

import (
	"sync/atomic"
	"testing"
	"time"

	"zviewer/backend/internal/piik/server/protocol"
)

func TestDisconnectedParentCannotTrapRoomCreationInPublicationPump(t *testing.T) {
	h := newRouterHarness(t, routerHarnessOptions{capacity: 1, fakeTimers: true})
	created := h.createRoom()
	host := h.connectHost(created, nil, "", "")
	viewer := h.connectViewer(created, "waiting-picture")
	h.complete(host)
	h.complete(viewer)
	prepared := h.waitPrepared(viewer.sessionID)
	h.routeReady(viewer, int64(prepared.Revision))
	h.settle()
	before := h.mustActiveEdge(created.RoomID, viewer.peerID)
	h.locked(func() {
		rm, _ := h.router.rooms.Get(created.RoomID)
		rm.roomMedia, rm.mediaGeneration = true, "room_media_12345678"
		rm.controller.SetVideoPublication("", false, h.router.now())
		rm.controller.SetVideoPublication(testShareGeneration, false, h.router.now())
		_, _ = h.store.DisconnectParticipant(created.RoomID, host.peerID, host.sessionID)
		rm.controller.DisconnectSession(host.peerID, host.sessionID)
	})
	// Use the production HTTP mutation's mutex, shared with this same router.
	server := &Server{store: h.store}
	h.router.mu = &server.mu
	now := h.router.now
	var stop atomic.Bool
	h.router.now = func() int64 {
		if stop.Load() {
			// Only the failing control uses this escape, so the old infinite pump
			// can release its test-owned goroutine and mutex before cleanup.
			panic("test cancels non-progressing pump")
		}
		return now()
	}
	pumping, pumped := make(chan struct{}), make(chan struct{})
	go func() {
		server.mu.Lock()
		defer server.mu.Unlock()
		defer close(pumped)
		close(pumping)
		rm, _ := h.router.rooms.Get(created.RoomID)
		revision := rm.controller.Revision()
		h.router.recoverPump(func() {
			h.router.pumpRoom(created.RoomID, rm, rm.controller, &revision, nil, false)
		})
	}()
	<-pumping
	roomCreated := make(chan error, 1)
	go func() {
		_, err := server.CreateRoom(protocol.CodeEntryOpen, nil, "")
		roomCreated <- err
	}()
	blocked := false
	select {
	case err := <-roomCreated:
		if err != nil {
			t.Error(err)
		}
	case <-time.After(time.Second):
		blocked = true
		stop.Store(true)
		select {
		case <-roomCreated:
		case <-time.After(time.Second):
			t.Fatal("test pump did not retire after cancellation")
		}
	}
	<-pumped
	server.mu.Lock()
	h.router.mu, h.router.now = &h.mu, now
	server.mu.Unlock()
	if blocked {
		t.Fatal("publication attachment to an offline parent held the room-creation mutex")
	}
	rm, _ := h.router.rooms.Get(created.RoomID)
	after, ok := rm.controller.Snapshot().UpstreamByViewer.Get(viewer.peerID)
	if !ok || after.ConnectionID != before.connectionID || !after.Usable || !after.PhysicalActive {
		t.Fatal("waiting for its parent replaced the healthy room connection")
	}
}

func TestStoppedShareReadyCannotCommitReplacementShare(t *testing.T) {
	h := newRouterHarness(t, routerHarnessOptions{capacity: 2, fakeTimers: true})
	created := h.createRoom()
	host := h.connectHost(created, nil, "", "")
	viewer := h.connectViewer(created, "share-ready")
	h.locked(func() {
		h.doComplete(host)
		h.doComplete(viewer)
	})
	old := h.waitPrepared(viewer.sessionID)
	h.settle()
	h.locked(func() {
		h.router.stopRoom(created.RoomID)
		h.sent[viewer.sessionID] = nil
		h.router.hooks.shareGeneration = func(string) string { return "replacement_generation_12345678" }
		h.doComplete(host)
	})
	current := h.waitPrepared(viewer.sessionID)
	if current.Candidate.ConnectionID == old.Candidate.ConnectionID {
		t.Fatal("replacement reused the physical connection")
	}
	h.routeReady(viewer, int64(old.Revision))
	if _, committed := h.activeEdge(created.RoomID, viewer.peerID); committed {
		t.Fatalf("stopped share ready at revision %d committed replacement revision %d", old.Revision, current.Revision)
	}
	h.routeReady(viewer, int64(current.Revision))
	if _, committed := h.activeEdge(created.RoomID, viewer.peerID); !committed {
		t.Fatal("replacement's own first-frame proof did not commit")
	}
}
