package signal

import "testing"

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
