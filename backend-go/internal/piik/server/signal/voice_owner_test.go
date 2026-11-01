package signal

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"zviewer/backend/internal/piik/server/protocol"
	"zviewer/backend/internal/piik/server/sfu"
	"zviewer/backend/internal/piik/server/sfu/sfutest"
)

func TestVoiceFailureReplacesOnlyCompanionOfHealthyPicture(t *testing.T) {
	h, host, viewer, _, viewerID := joinedVoiceOwnerRoom(t)
	host.sendJSON(map[string]any{"type": "start-sharing", "shareGeneration": "voice_picture_123456",
		"qualitySettings": protocol.DefaultQualitySettings, "routePolicy": protocol.DefaultRoutePolicy, "sharingPaused": false})
	host.next("sharing-started")
	prepare := nextPreparedRoute(t, viewer)
	viewer.sendJSON(map[string]any{"type": "route-ready", "phase": "prepare", "revision": prepare.Revision})
	nextActiveRouteRevision(t, viewer, prepare.Revision)
	before := nextVoiceState(t, viewer, func(state protocol.RoomVoiceStateMessage) bool {
		return len(state.Connections) == 1 && !state.Connections[0].Pending
	})
	oldID := before.Connections[0].ConnectionID
	viewer.sendJSON(map[string]any{"type": "room-voice-transport", "connectionId": oldID, "state": "failed"})
	after := nextVoiceState(t, viewer, func(state protocol.RoomVoiceStateMessage) bool {
		return len(state.Connections) == 1 && state.Connections[0].ConnectionID != oldID
	})
	if after.Connections[0].Pending {
		t.Fatal("voice repair started another route operation")
	}
	h.locked(func() {
		rm, _ := h.server.router.rooms.Get(h.room.RoomID)
		snapshot := rm.controller.Snapshot()
		edge, ok := snapshot.UpstreamByViewer.Get(viewerID.PeerID)
		if !ok || !edge.Usable || !edge.VideoReady || snapshot.Operation != nil || snapshot.Revision != int64(prepare.Revision) {
			t.Fatal("voice failure invalidated the current picture route")
		}
	})
	for _, client := range []*testClient{host, viewer} {
		client.sendJSON(map[string]any{"type": "room-voice-transport", "connectionId": after.Connections[0].ConnectionID, "state": "connected"})
	}
	nextVoiceState(t, viewer, func(state protocol.RoomVoiceStateMessage) bool {
		for _, member := range state.Members {
			if member.PeerID == viewerID.PeerID {
				return member.Upstream.Kind == "peer"
			}
		}
		return false
	})
}

func TestVoiceOwnerMustOpenBeforeViewersCanJoin(t *testing.T) {
	h := startHarness(t, harnessOptions{})
	host, viewer := openClient(t, h), openClient(t, h)
	authenticate(t, host, h.room, protocol.RoleHost, "voice_closed_host_123456", -1, "",
		presenceOptions{roomSession: true, roomOnly: true})
	authenticate(t, viewer, h.room, protocol.RoleViewer, "voice_closed_viewer_123456", 0, "", presenceOptions{})
	for _, client := range []*testClient{host, viewer} {
		client.sendJSON(map[string]any{"type": "subscribe-room-voice"})
		nextVoiceState(t, client, nil)
	}
	voiceCommand(viewer, map[string]any{"action": "join"})
	message, err := protocol.DecodeServerMessage(viewer.next("room-voice-error").raw)
	if err != nil || message.(protocol.RoomVoiceErrorMessage).Code != "not-enabled" {
		t.Fatal("viewer could open voice without the Host")
	}
	voiceCommand(host, map[string]any{"action": "join"})
	state := nextVoiceState(t, viewer, func(state protocol.RoomVoiceStateMessage) bool { return state.Enabled })
	if len(state.Publications) != 0 || len(state.Connections) != 0 {
		t.Fatal("opening room voice started a microphone or joined a Viewer")
	}
	voiceCommand(viewer, map[string]any{"action": "join"})
	pending := nextVoiceState(t, viewer, func(state protocol.RoomVoiceStateMessage) bool {
		return len(state.Connections) == 1 && state.Connections[0].Pending
	})
	for _, client := range []*testClient{host, viewer} {
		client.sendJSON(map[string]any{"type": "room-voice-transport", "connectionId": pending.Connections[0].ConnectionID, "state": "connected"})
	}
	nextVoiceState(t, viewer, func(state protocol.RoomVoiceStateMessage) bool {
		return len(state.Connections) == 1 && !state.Connections[0].Pending
	})
	voiceCommand(viewer, map[string]any{"action": "publish"})
	nextVoiceState(t, host, func(state protocol.RoomVoiceStateMessage) bool { return len(state.Publications) == 1 })
	voiceCommand(host, map[string]any{"action": "leave"})
	state = nextVoiceState(t, viewer, func(state protocol.RoomVoiceStateMessage) bool { return !state.Enabled })
	if len(state.Publications) != 0 || len(state.Connections) != 0 {
		t.Fatal("closing room voice retained media")
	}
	for _, member := range state.Members {
		if member.Joined || member.PublicationID != "" {
			t.Fatal("closing room voice retained a joined participant")
		}
	}
	voiceCommand(host, map[string]any{"action": "join"})
	state = nextVoiceState(t, viewer, func(state protocol.RoomVoiceStateMessage) bool { return state.Enabled })
	if len(state.Publications) != 0 || len(state.Connections) != 0 {
		t.Fatal("reopening room voice restored former media")
	}
}

func joinedVoiceOwnerRoom(t *testing.T) (*harness, *testClient, *testClient, authenticatedMessage, authenticatedMessage) {
	t.Helper()
	h := startHarness(t, harnessOptions{viewerDisconnectGraceMs: 30_000})
	host, viewer := openClient(t, h), openClient(t, h)
	hostID := authenticate(t, host, h.room, protocol.RoleHost, "owner_host_123456", -1, "", presenceOptions{roomSession: true, roomOnly: true})
	viewerID := authenticate(t, viewer, h.room, protocol.RoleViewer, "owner_viewer_123456", 1, "", presenceOptions{})
	for _, client := range []*testClient{host, viewer} {
		client.sendJSON(map[string]any{"type": "subscribe-room-voice"})
		nextVoiceState(t, client, nil)
	}
	voiceCommand(host, map[string]any{"action": "join"})
	nextVoiceState(t, host, func(state protocol.RoomVoiceStateMessage) bool { return state.Enabled })
	voiceCommand(viewer, map[string]any{"action": "join"})
	pending := nextVoiceState(t, viewer, func(state protocol.RoomVoiceStateMessage) bool {
		return len(state.Connections) == 1 && state.Connections[0].Pending
	})
	for _, client := range []*testClient{host, viewer} {
		client.sendJSON(map[string]any{"type": "room-voice-transport", "connectionId": pending.Connections[0].ConnectionID, "state": "connected"})
	}
	nextVoiceState(t, viewer, func(state protocol.RoomVoiceStateMessage) bool {
		return len(state.Connections) == 1 && !state.Connections[0].Pending
	})
	return h, host, viewer, hostID, viewerID
}

func TestVoiceOwnersRebindRoomOnlySessionsAndReleaseLastDisconnect(t *testing.T) {
	h, host, viewer, hostID, viewerID := joinedVoiceOwnerRoom(t)
	h.closeClient(viewer)
	viewer = openClient(t, h)
	reboundViewer := authenticate(t, viewer, h.room, protocol.RoleViewer, "owner_viewer_123456", 1, "", presenceOptions{})
	if reboundViewer.PeerID != viewerID.PeerID {
		t.Fatal("viewer identity did not survive grace")
	}
	viewer.sendJSON(map[string]any{"type": "subscribe-room-voice"})
	nextVoiceState(t, viewer, func(state protocol.RoomVoiceStateMessage) bool { return len(state.Connections) == 1 })
	h.locked(func() {
		rm, _ := h.server.router.rooms.Get(h.room.RoomID)
		edge, ok := rm.controller.Snapshot().UpstreamByViewer.Get(viewerID.PeerID)
		peer, _ := h.store.GetConnectedViewer(h.room.RoomID, viewerID.PeerID)
		if !ok || edge.ChildSessionID != peer.SessionID || !h.server.voiceAllowed(h.room.RoomID, viewerID.PeerID) {
			t.Fatal("subscription did not rebind approved viewer route")
		}
	})
	h.closeClient(host)
	host = openClient(t, h)
	reboundHost := authenticate(t, host, h.room, protocol.RoleHost, "owner_host_123456", -1, "", presenceOptions{roomSession: true, roomOnly: true})
	if reboundHost.PeerID != hostID.PeerID {
		t.Fatal("host identity changed on room reconnect")
	}
	host.sendJSON(map[string]any{"type": "subscribe-room-voice"})
	nextVoiceState(t, host, func(state protocol.RoomVoiceStateMessage) bool { return len(state.Connections) == 1 })
	h.locked(func() {
		rm, _ := h.server.router.rooms.Get(h.room.RoomID)
		edge, ok := rm.controller.Snapshot().UpstreamByViewer.Get(viewerID.PeerID)
		peer, _ := h.store.GetConnectedHost(h.room.RoomID)
		if !ok || edge.ParentSessionID != peer.SessionID {
			t.Fatal("subscription did not rebind room-only host route")
		}
	})
	h.closeClient(viewer)
	h.closeClient(host)
	h.locked(func() {
		if rm, _ := h.server.router.rooms.Get(h.room.RoomID); rm != nil && rm.controller != nil {
			t.Fatal("last disconnected voice participant retained idle room resources")
		}
	})
}

func TestVoiceOwnerCanCloseWhileViewerIsDisconnected(t *testing.T) {
	h, host, viewer, _, viewerID := joinedVoiceOwnerRoom(t)
	h.closeClient(viewer)
	nextVoiceState(t, host, func(state protocol.RoomVoiceStateMessage) bool {
		for _, member := range state.Members {
			if member.PeerID == viewerID.PeerID {
				return !member.Connected
			}
		}
		return false
	})
	voiceCommand(host, map[string]any{"action": "leave"})
	nextVoiceState(t, host, func(state protocol.RoomVoiceStateMessage) bool {
		for _, member := range state.Members {
			if member.PeerID == viewerID.PeerID {
				return !state.Enabled && !member.Joined
			}
		}
		return false
	})
	viewer = openClient(t, h)
	authenticate(t, viewer, h.room, protocol.RoleViewer, "owner_viewer_123456", 1, "", presenceOptions{})
	viewer.sendJSON(map[string]any{"type": "subscribe-room-voice"})
	state := nextVoiceState(t, viewer, nil)
	for _, member := range state.Members {
		if member.PeerID == viewerID.PeerID && (state.Enabled || member.Joined || member.PublicationID != "") {
			t.Fatal("reconnection restored closed room voice")
		}
	}
}

func TestVoiceOwnersOptInPreservesPausedPublication(t *testing.T) {
	h := startHarness(t, harnessOptions{})
	host := openClient(t, h)
	authenticate(t, host, h.room, protocol.RoleHost, "owner_paused_host_123456", -1, "owner_paused_share_123456",
		presenceOptions{sharingPaused: boolPointer(true)})
	host.sendJSON(map[string]any{"type": "subscribe-room-voice"})
	nextVoiceState(t, host, nil)
	voiceCommand(host, map[string]any{"action": "join"})
	nextVoiceState(t, host, func(state protocol.RoomVoiceStateMessage) bool {
		return state.Enabled && len(state.Members) == 1 && state.Members[0].Joined
	})
	h.locked(func() {
		rm, _ := h.server.router.rooms.Get(h.room.RoomID)
		snapshot := rm.controller.Snapshot()
		if !snapshot.RoomMedia || !snapshot.VideoPaused || snapshot.VideoGeneration != "owner_paused_share_123456" {
			t.Fatal("voice opt-in resumed a paused screen publication")
		}
	})
}

func TestVoiceOwnersGrantRevocationRemovesPermanentMember(t *testing.T) {
	h, host, viewer, _, viewerID := joinedVoiceOwnerRoom(t)
	voiceCommand(viewer, map[string]any{"action": "publish"})
	nextVoiceState(t, host, func(state protocol.RoomVoiceStateMessage) bool { return len(state.Publications) == 1 })
	h.updateRoomAccess(protocol.RevokeViewerGrantRequest{Action: "revoke-viewer-grant"})
	viewer.next("viewer-grant-revoked")
	expectCloseCode(t, viewer, 4004)
	state := nextVoiceState(t, host, func(state protocol.RoomVoiceStateMessage) bool {
		return len(state.Members) == 1 && len(state.Publications) == 0
	})
	if len(state.Connections) != 0 {
		t.Fatal("revoked member retained a voice connection")
	}
	h.locked(func() {
		if _, exists := h.server.voices[h.room.RoomID].members[viewerID.PeerID]; exists {
			t.Fatal("permanently revoked identity retained voice permission")
		}
	})
}

func TestVoiceOwnersStopDropsVideoOnlyCandidateDemand(t *testing.T) {
	h, host, viewer, _, viewerID := joinedVoiceOwnerRoom(t)
	legacy := openClient(t, h)
	legacyID := authenticate(t, legacy, h.room, protocol.RoleViewer, "owner_legacy_123456", 0, "", presenceOptions{})
	host.sendJSON(map[string]any{"type": "start-sharing", "shareGeneration": "owner_share_123456",
		"qualitySettings": protocol.DefaultQualitySettings, "routePolicy": protocol.DefaultRoutePolicy, "sharingPaused": false})
	host.next("sharing-started")
	prepare := nextPreparedRoute(t, viewer)
	viewer.sendJSON(map[string]any{"type": "route-ready", "phase": "prepare", "revision": prepare.Revision})
	nextActiveRouteRevision(t, viewer, prepare.Revision)
	nextPreparedRoute(t, legacy)
	host.sendJSON(map[string]any{"type": "stop-sharing", "shareGeneration": "owner_share_123456"})
	viewer.next("sharing-stopped")
	if !waitFor(t, defaultWait, func() bool {
		settled := false
		h.locked(func() {
			rm, _ := h.server.router.rooms.Get(h.room.RoomID)
			snapshot := rm.controller.Snapshot()
			edge, ok := snapshot.UpstreamByViewer.Get(viewerID.PeerID)
			_, legacyEdge := snapshot.UpstreamByViewer.Get(legacyID.PeerID)
			settled = !rm.pumping && snapshot.Operation == nil && ok && edge.Usable && !edge.VideoReady && !legacyEdge
		})
		return settled
	}) {
		t.Fatal("video-only viewer retained voice candidate demand after share stop")
	}
}

type heldVoiceMedia struct {
	*sfutest.FakeMedia
	negotiations                    chan sfu.VoiceConnectionPlan
	negotiateRelease, latestRelease chan struct{}
	closeStarted, closeRelease      chan struct{}
	closeOnce                       sync.Once
}

func (m *heldVoiceMedia) ConfigureVoice(plan sfu.VoiceConnectionPlan, _ func(sfu.VoiceMediaEvent)) (func() error, error) {
	return func() error {
		m.negotiations <- plan
		if len(plan.Publish) == 0 {
			<-m.negotiateRelease
			return errors.New("held negotiation failed")
		}
		<-m.latestRelease
		return nil
	}, nil
}
func (*heldVoiceMedia) SignalVoice(string, string, string, string, sfu.VoiceSignal) error { return nil }
func (m *heldVoiceMedia) CloseVoice(string, string, string, string) func() error {
	return func() error { m.closeOnce.Do(func() { close(m.closeStarted) }); <-m.closeRelease; return nil }
}
func TestVoiceEffectsPreserveSynchronousAuthorityAndShutdownJoinsWork(t *testing.T) {
	media := &heldVoiceMedia{FakeMedia: sfutest.New(), negotiations: make(chan sfu.VoiceConnectionPlan, 8), negotiateRelease: make(chan struct{}), latestRelease: make(chan struct{}), closeStarted: make(chan struct{}), closeRelease: make(chan struct{})}
	var negotiateOnce, latestOnce, closeOnce sync.Once
	releaseNegotiation := func() { negotiateOnce.Do(func() { close(media.negotiateRelease) }) }
	releaseLatest := func() { latestOnce.Do(func() { close(media.latestRelease) }) }
	releaseClose := func() { closeOnce.Do(func() { close(media.closeRelease) }) }
	t.Cleanup(releaseNegotiation)
	t.Cleanup(releaseLatest)
	t.Cleanup(releaseClose)
	h := startHarness(t, harnessOptions{sfu: &SfuFallback{Media: media, Admission: sfu.NewAdmission(sfu.AdmissionOptions{IngressCapacity: 2, EgressCapacity: 20})}})
	edge := &voiceEdge{id: "physical", logicalID: "logical", child: "peer", childSession: "session", transport: "sfu", send: map[string][]string{}}
	var v *roomVoice
	h.locked(func() { v = h.server.voiceRoom(h.room.RoomID); v.connections[edge.logicalID] = edge })
	done := make(chan struct{})
	go func() {
		h.server.mu.Lock()
		defer h.server.mu.Unlock()
		h.server.configureVoiceJunction(h.room.RoomID, v, edge, nil)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(defaultWait):
		t.Fatal("synchronous voice projection waited for SDP work")
	}
	select {
	case <-media.negotiations:
	case <-time.After(defaultWait):
		t.Fatal("negotiation did not start")
	}
	created := make(chan error, 1)
	go func() { _, err := h.server.CreateRoom(protocol.CodeEntryOpen, nil, ""); created <- err }()
	select {
	case err := <-created:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(defaultWait):
		t.Fatal("voice negotiation blocked another room")
	}
	var replacementPlan *sfu.VoiceConnectionPlan
	h.locked(func() {
		operation := edge.sfuWork
		for _, id := range []string{"superseded", "latest"} {
			edge.send[edge.child] = []string{id}
			h.server.configureVoiceJunction(h.room.RoomID, v, edge, []protocol.VoicePublication{{ID: id, PeerID: edge.child}})
			if edge.sfuWork != operation {
				t.Error("plan update started an overlapping negotiation worker")
			}
		}
		replacementPlan = edge.sfuPlan
	})
	releaseNegotiation()
	select {
	case plan := <-media.negotiations:
		if len(plan.Publish) != 1 || plan.Publish[0].ID != "latest" {
			t.Fatalf("queued work replayed a superseded publication: %+v", plan.Publish)
		}
	case <-time.After(defaultWait):
		t.Fatal("latest negotiation did not start")
	}
	h.locked(func() {
		if edge.sfuPlan != replacementPlan {
			t.Error("stale negotiation failure overwrote replacement plan")
		}
	})
	h.locked(func() { h.server.closeRoomVoice(h.room.RoomID) })
	select {
	case <-media.closeStarted:
	case <-time.After(defaultWait):
		t.Fatal("physical retirement did not start")
	}
	go func() { _, err := h.server.CreateRoom(protocol.CodeEntryOpen, nil, ""); created <- err }()
	select {
	case err := <-created:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(defaultWait):
		t.Fatal("voice retirement blocked another room")
	}
	closed := make(chan error, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), defaultWait)
		defer cancel()
		closed <- h.server.Close(ctx)
	}()
	select {
	case err := <-closed:
		t.Fatalf("shutdown escaped held retirement: %v", err)
	case <-time.After(30 * time.Millisecond):
	}
	releaseClose()
	select {
	case err := <-closed:
		t.Fatalf("shutdown escaped in-flight negotiation: %v", err)
	case <-time.After(30 * time.Millisecond):
	}
	releaseLatest()
	select {
	case err := <-closed:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(defaultWait):
		t.Fatal("shutdown did not join retirement")
	}
}

type capacityHeldVoiceMedia struct {
	*sfutest.FakeMedia
	mu      sync.Mutex
	busy    bool
	plans   chan sfu.VoiceConnectionPlan
	release chan struct{}
}

func (m *capacityHeldVoiceMedia) ConfigureVoice(plan sfu.VoiceConnectionPlan, _ func(sfu.VoiceMediaEvent)) (func() error, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.busy {
		return nil, errors.New("voice connection capacity is exhausted")
	}
	m.plans <- plan
	return nil, nil
}
func (*capacityHeldVoiceMedia) SignalVoice(string, string, string, string, sfu.VoiceSignal) error {
	return nil
}
func (m *capacityHeldVoiceMedia) CloseVoice(string, string, string, string) func() error {
	return func() error { <-m.release; m.mu.Lock(); m.busy = false; m.mu.Unlock(); return nil }
}
func TestVoiceRetirementRefreshesCurrentPlanAfterCapacityRelease(t *testing.T) {
	media := &capacityHeldVoiceMedia{FakeMedia: sfutest.New(), busy: true, plans: make(chan sfu.VoiceConnectionPlan, 32), release: make(chan struct{})}
	var releaseOnce sync.Once
	unblock := func() { releaseOnce.Do(func() { close(media.release) }) }
	t.Cleanup(unblock)
	h := startHarness(t, harnessOptions{sfuOnly: true, sfu: &SfuFallback{Media: media, Admission: sfu.NewAdmission(sfu.AdmissionOptions{IngressCapacity: 2, EgressCapacity: 20})}})
	host, viewer := openClient(t, h), openClient(t, h)
	authenticate(t, host, h.room, protocol.RoleHost, "capacity-host", -1, "", presenceOptions{roomSession: true, roomOnly: true})
	viewerID := authenticate(t, viewer, h.room, protocol.RoleViewer, "capacity-viewer", 0, "", presenceOptions{})
	for _, client := range []*testClient{host, viewer} {
		client.sendJSON(map[string]any{"type": "subscribe-room-voice"})
		nextVoiceState(t, client, nil)
	}
	voiceCommand(host, map[string]any{"action": "join"})
	nextVoiceState(t, host, func(state protocol.RoomVoiceStateMessage) bool { return state.Enabled })
	voiceCommand(viewer, map[string]any{"action": "join"})
	nextVoiceState(t, viewer, func(state protocol.RoomVoiceStateMessage) bool { return len(state.Connections) > 0 })
	// Keep the actual controller's current facets. Capacity is held by an older
	// retiring facet, and publication intent changes before its close completes.
	h.locked(func() {
		v := h.server.voices[h.room.RoomID]
		for _, edge := range v.connections {
			edge.pending = false
			edge.connected[edge.parent] = true
			edge.connected[edge.child] = true
		}
		h.server.commitVoiceCandidate(h.room.RoomID)
		h.server.syncRoomVoice(h.room.RoomID)
		h.server.closeVoiceEdge(h.room.RoomID, &voiceEdge{id: "retiring-capacity", child: "old-peer", childSession: "old-session", transport: "sfu"})
	})
	voiceCommand(viewer, map[string]any{"action": "publish"})
	state := nextVoiceState(t, viewer, func(state protocol.RoomVoiceStateMessage) bool { return len(state.Publications) == 1 })
	expected := state.Publications[0].ID
	unblock()
	deadline := time.After(defaultWait)
	for {
		select {
		case plan := <-media.plans:
			if plan.PeerID == viewerID.PeerID {
				for _, pub := range plan.Publish {
					if pub.ID == expected {
						return
					}
				}
			}
		case <-deadline:
			t.Fatal("completed retirement did not resume current publication intent")
		}
	}
}
