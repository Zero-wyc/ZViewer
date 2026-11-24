package signal

import (
	"testing"
	"zviewer/backend/internal/piik/server/protocol"
)

func (h *routerHarness) doRelaySettings(p authenticatedRouteParticipant, enabled bool, capacity, physical int) protocol.RelayVolunteerMessage {
	h.t.Helper()
	value := protocol.Int(physical)
	return h.doRelayCommand(p, protocol.SetRelayVolunteerMessage{Type: "set-relay-volunteer", Settings: true, Enabled: enabled, Capacity: protocol.Int(capacity), PhysicalCapacity: &value})
}
func (h *routerHarness) doRelayCommand(p authenticatedRouteParticipant, message protocol.SetRelayVolunteerMessage) protocol.RelayVolunteerMessage {
	h.t.Helper()
	sess := &session{sessionID: p.sessionID}
	server := &Server{router: h.router, endpointMediaCopyCapacity: h.router.capacity}
	server.setRelayVolunteer(sess, &authenticatedSession{roomID: p.roomID, peerID: p.peerID, role: p.role}, message)
	if len(sess.queue) != 1 {
		h.t.Fatalf("ack count=%d", len(sess.queue))
	}
	decoded, err := protocol.DecodeServerMessage(sess.queue[0].data)
	ack, ok := decoded.(protocol.RelayVolunteerMessage)
	if err != nil || !ok {
		h.t.Fatalf("ack=%#v, %v", decoded, err)
	}
	return ack
}
func TestRoomRelayCapacitySurvivesReconnectAndControllerReplacement(t *testing.T) {
	h := newRouterHarness(t, routerHarnessOptions{capacity: 2})
	created := h.createRoom()
	host := h.connectHost(created, nil, "", "")
	h.locked(func() {
		h.doComplete(host)
		ack := h.doRelaySettings(host, true, 4, 20)
		if ack.RoomCapacity == nil || *ack.RoomCapacity != 4 || ack.Capacity != 4 {
			t.Fatalf("host ack=%+v", ack)
		}
		h.router.connectParticipant(host)
		h.router.stopRoom(created.RoomID)
		h.router.connectParticipant(host)
	})
	for _, suffix := range []string{"one", "two", "three", "four"} {
		viewer := h.connectViewer(created, "room-limit-"+suffix)
		h.locked(func() { h.doComplete(viewer); h.doRelaySettings(viewer, false, 0, 20) })
		prepared := h.waitPreparedUpstream(viewer.sessionID, protocol.PeerUpstream(host.peerID))
		h.routeReady(viewer, int64(prepared.Revision))
	}
	h.locked(func() { h.doDisconnect(host) })
	reconnected := h.connectHost(created, nil, "", "new_host_session_12345678")
	h.locked(func() {
		h.router.connectParticipant(reconnected)
		settings, _ := h.router.room(created.RoomID).endpointSettings.Get(host.peerID)
		if settings.settings {
			t.Fatal("new WebSocket inherited settings opt-in")
		}
		ack := h.doRelaySettings(reconnected, false, 0, 20)
		if *ack.RoomCapacity != 4 || ack.Capacity != 4 {
			t.Fatalf("Host discovery reset room: %+v", ack)
		}
		h.doDisconnect(reconnected)
	})
	replacement := h.connectHost(created, nil, "other_host_client_12345678", "other_host_session_12345678")
	h.locked(func() {
		h.router.connectParticipant(replacement)
		if h.router.room(created.RoomID).endpointSettings.Has(host.peerID) {
			t.Fatal("old Host settings retained")
		}
		ack := h.doRelaySettings(replacement, false, 0, 3)
		if *ack.RoomCapacity != 4 || ack.Capacity != 3 {
			t.Fatalf("room or hardware ceiling lost: %+v", ack)
		}
	})
}
func TestViewerRelayOverrideAndLegacyCompatibility(t *testing.T) {
	h := newRouterHarness(t, routerHarnessOptions{capacity: 2})
	created := h.createRoom()
	host := h.connectHost(created, nil, "", "")
	viewer := h.connectViewer(created, "personal-limit")
	legacy := h.connectViewer(created, "legacy-limit")
	h.locked(func() {
		h.router.connectParticipant(host)
		h.router.connectParticipant(viewer)
		h.router.connectParticipant(legacy)
		h.doRelay(legacy, 3)
		h.doRelaySettings(host, true, 8, 20)
		settings, _ := h.router.room(created.RoomID).endpointSettings.Get(legacy.peerID)
		if settings.reportedCapacity(2) != 2 {
			t.Fatal("room policy expanded old page budget")
		}
		ack := h.doRelaySettings(viewer, false, 0, 3)
		if ack.Capacity != 3 || *ack.RoomCapacity != 8 {
			t.Fatalf("default clamp=%+v", ack)
		}
		ack = h.doRelaySettings(viewer, true, 0, 20)
		if !ack.Enabled || ack.Capacity != 0 {
			t.Fatalf("receive only=%+v", ack)
		}
		ack = h.doRelaySettings(viewer, true, 12, 3)
		if ack.Capacity != 3 {
			t.Fatalf("override exceeded hardware: %+v", ack)
		}
		ack = h.doRelaySettings(viewer, true, 12, 20)
		if ack.Capacity != 12 {
			t.Fatalf("rediscovery lost intent: %+v", ack)
		}
		ack = h.doRelaySettings(viewer, false, 12, 20)
		if ack.Enabled || ack.Capacity != 8 {
			t.Fatalf("follow room=%+v", ack)
		}
		h.doRelaySettings(host, true, 4, 20)
		broadcast, ok := h.sent[viewer.sessionID][len(h.sent[viewer.sessionID])-1].(protocol.RelayVolunteerMessage)
		if !ok || *broadcast.RoomCapacity != 4 || broadcast.Capacity != 4 {
			t.Fatalf("broadcast=%+v", broadcast)
		}
		if len(h.sent[legacy.sessionID]) != 0 {
			t.Fatal("old page received new broadcast")
		}
		ack = h.doRelayCommand(legacy, protocol.SetRelayVolunteerMessage{Type: "set-relay-volunteer", Enabled: true, Capacity: 20})
		if ack.RoomCapacity != nil || ack.Capacity != 20 {
			t.Fatalf("old volunteer changed: %+v", ack)
		}
		ack = h.doRelayCommand(legacy, protocol.SetRelayVolunteerMessage{Type: "set-relay-volunteer", Enabled: false, Capacity: 20})
		if ack.RoomCapacity != nil || ack.Capacity != 2 {
			t.Fatalf("old withdrawal changed: %+v", ack)
		}
	})
}
func TestRoomCapacityReductionPreservesMediaAndSubtreeUntilSerialCommit(t *testing.T) {
	h := newRouterHarness(t, routerHarnessOptions{capacity: 2})
	created := h.createRoom()
	host := h.connectHost(created, nil, "", "")
	h.locked(func() { h.doComplete(host); h.doRelaySettings(host, true, 3, 20) })
	viewers := make([]authenticatedRouteParticipant, 0, 3)
	for _, suffix := range []string{"one", "two", "three"} {
		viewer := h.connectViewer(created, "reduction-"+suffix)
		viewers = append(viewers, viewer)
		h.locked(func() { h.doComplete(viewer); h.doRelaySettings(viewer, true, 0, 20) })
		prepared := h.waitPreparedUpstream(viewer.sessionID, protocol.PeerUpstream(host.peerID))
		h.routeReady(viewer, int64(prepared.Revision))
	}
	h.locked(func() { h.doRelaySettings(viewers[2], true, 1, 20) })
	descendant := h.connectViewer(created, "retained-subtree")
	h.complete(descendant)
	subtreePrepare := h.waitPreparedUpstream(descendant.sessionID, protocol.PeerUpstream(viewers[2].peerID))
	h.routeReady(descendant, int64(subtreePrepare.Revision))
	subtree := h.mustActiveEdge(created.RoomID, descendant.peerID)
	old := h.mustActiveEdge(created.RoomID, viewers[2].peerID)
	h.locked(func() { h.doRelaySettings(viewers[0], true, 2, 20); h.doRelaySettings(host, true, 2, 20) })
	prepared := h.waitPreparedAbove(viewers[2].sessionID, old.revision)
	if prepared.Assignment.Upstream != protocol.PeerUpstream(viewers[0].peerID) {
		t.Fatalf("candidate=%+v", prepared.Assignment)
	}
	if current := h.mustActiveEdge(created.RoomID, viewers[2].peerID); current.connectionID != old.connectionID {
		t.Fatal("old media closed before proof")
	}
	if current := h.mustActiveEdge(created.RoomID, descendant.peerID); current.connectionID != subtree.connectionID {
		t.Fatal("subtree closed before proof")
	}
	h.routeReady(viewers[2], int64(prepared.Revision))
	h.waitFor("serial handoff commit", func() bool {
		return h.mustActiveEdge(created.RoomID, viewers[2].peerID).connectionID == prepared.Candidate.ConnectionID
	})
	if current := h.mustActiveEdge(created.RoomID, descendant.peerID); current.connectionID != subtree.connectionID {
		t.Fatal("subtree closed at commit")
	}
}
