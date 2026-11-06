package signal

import (
	"bytes"
	"reflect"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
	"zviewer/backend/internal/piik/server/protocol"
	"zviewer/backend/internal/piik/server/sfu"
	"zviewer/backend/internal/piik/server/sfu/sfutest"
)

func TestVoiceListeningPresenceIsOptedInAndDoesNotChangeMedia(t *testing.T) {
	h, host, viewer, hostID, viewerID := joinedVoiceOwnerRoom(t)
	host.sendJSON(map[string]any{"type": "subscribe-room-voice", "deafened": false})
	nextVoiceState(t, host, func(state protocol.RoomVoiceStateMessage) bool {
		for _, member := range state.Members {
			if member.PeerID == hostID.PeerID {
				return member.Deafened != nil && !*member.Deafened
			}
		}
		return false
	})
	voiceCommand(host, map[string]any{"action": "publish"})
	before := nextVoiceState(t, host, func(state protocol.RoomVoiceStateMessage) bool { return len(state.Publications) == 1 })
	voiceCommand(host, map[string]any{"action": "deafen", "deafened": true})
	after := nextVoiceState(t, host, func(state protocol.RoomVoiceStateMessage) bool {
		for _, member := range state.Members {
			if member.PeerID == hostID.PeerID {
				return member.Deafened != nil && *member.Deafened
			}
		}
		return false
	})
	if !reflect.DeepEqual(before.Publications, after.Publications) || !reflect.DeepEqual(before.Connections, after.Connections) {
		t.Fatal("deafen changed media publication or connections")
	}
	for _, member := range after.Members {
		if member.PeerID == viewerID.PeerID && member.Deafened != nil {
			t.Fatal("inferred listening state from legacy reporter")
		}
	}
	// Drain earlier states too: every message to the baseline subscriber must
	// retain the old strict member shape, even when another peer reports deafen.
	for {
		message := viewer.next("room-voice-state")
		if bytes.Contains(message.raw, []byte(`"deafened"`)) {
			t.Fatal("new member field reached a legacy reader")
		}
		decoded, err := protocol.DecodeServerMessage(message.raw)
		if err != nil {
			t.Fatal(err)
		}
		if decoded.(protocol.RoomVoiceStateMessage).Revision >= after.Revision {
			break
		}
	}
	voiceCommand(viewer, map[string]any{"action": "deafen", "deafened": true})
	viewer.next("room-voice-error")
	h.locked(func() {
		if h.server.voices[h.room.RoomID].members[viewerID.PeerID].deafened != nil {
			t.Fatal("unnegotiated command changed presence")
		}
	})
	h.closeClient(host)
	host = openClient(t, h)
	authenticate(t, host, h.room, protocol.RoleHost, "owner_host_123456", -1, "", presenceOptions{roomSession: true, roomOnly: true})
	host.sendJSON(map[string]any{"type": "subscribe-room-voice", "deafened": false})
	nextVoiceState(t, host, func(state protocol.RoomVoiceStateMessage) bool {
		for _, member := range state.Members {
			if member.PeerID == hostID.PeerID {
				return member.Deafened != nil && !*member.Deafened && member.PublicationID == ""
			}
		}
		return false
	})
}

func nextVoiceState(t *testing.T, client *testClient, matches func(protocol.RoomVoiceStateMessage) bool) protocol.RoomVoiceStateMessage {
	t.Helper()
	for {
		message, err := protocol.DecodeServerMessage(client.next("room-voice-state").raw)
		if err != nil {
			t.Fatal(err)
		}
		state := message.(protocol.RoomVoiceStateMessage)
		if matches == nil || matches(state) {
			return state
		}
	}
}

func TestVoiceOnlySfuPreparesWithoutVideoPublication(t *testing.T) {
	h := startHarness(t, harnessOptions{sfuOnly: true, endpointMediaCopyCapacity: 1,
		sfu: &SfuFallback{Media: sfutest.New(), Admission: sfu.NewAdmission(sfu.AdmissionOptions{IngressCapacity: 1, EgressCapacity: 2})}})
	host, viewer := openClient(t, h), openClient(t, h)
	authenticate(t, host, h.room, protocol.RoleHost, "voice_sfu_host_123", -1, "", presenceOptions{roomSession: true, roomOnly: true})
	authenticate(t, viewer, h.room, protocol.RoleViewer, "voice_sfu_viewer_123", 1, "", presenceOptions{})
	for _, client := range []*testClient{host, viewer} {
		client.sendJSON(map[string]any{"type": "subscribe-room-voice"})
		nextVoiceState(t, client, nil)
	}
	voiceCommand(host, map[string]any{"action": "join"})
	nextVoiceState(t, host, func(state protocol.RoomVoiceStateMessage) bool { return state.Enabled })
	voiceCommand(viewer, map[string]any{"action": "join"})
	state := nextVoiceState(t, viewer, func(state protocol.RoomVoiceStateMessage) bool { return len(state.Connections) > 0 })
	if len(state.Connections) != 1 || state.Connections[0].Transport != "sfu" || !state.Connections[0].Pending {
		t.Fatalf("invalid SFU preparation: %+v", state.Connections)
	}
	for _, client := range []*testClient{host, viewer} {
		own := nextVoiceState(t, client, func(state protocol.RoomVoiceStateMessage) bool { return len(state.Connections) > 0 })
		client.sendJSON(map[string]any{"type": "room-voice-transport", "connectionId": own.Connections[0].ConnectionID, "state": "connected"})
	}
	var events []sfu.VoiceMediaEvent
	if !waitFor(t, defaultWait, func() bool {
		ready := true
		h.locked(func() {
			events = nil
			for _, edge := range h.server.voices[h.room.RoomID].connections {
				ready = ready && edge.connected[edge.child]
				events = append(events, sfu.VoiceMediaEvent{RoomID: h.room.RoomID, PeerID: edge.child,
					SessionID: edge.childSession, ConnectionID: edge.id, State: webrtc.PeerConnectionStateConnected})
			}
		})
		return ready && len(events) == 2
	}) {
		t.Fatal("clients did not report both voice transports")
	}
	// The transport may leave Connected while its callback waits for Server.mu.
	// One stale facet must not combine with the other facet to commit the route.
	events[0].IsCurrentState = func() bool { return false }
	h.server.onVoiceMediaEvent(events[0])
	events[1].IsCurrentState = func() bool { return true }
	h.server.onVoiceMediaEvent(events[1])
	h.locked(func() {
		rm, _ := h.server.router.rooms.Get(h.room.RoomID)
		if rm.controller.Operation() == nil {
			t.Fatal("stale Connected callback committed a voice route")
		}
	})
	events[0].IsCurrentState = func() bool { return true }
	h.server.onVoiceMediaEvent(events[0])
	h.locked(func() {
		rm, _ := h.server.router.rooms.Get(h.room.RoomID)
		if rm.controller.Operation() != nil {
			t.Fatal("current Connected callback did not commit voice route")
		}
	})
}

func voiceCommand(client *testClient, command map[string]any) {
	client.sendJSON(map[string]any{"type": "room-voice-command", "command": command})
}

func TestRoomVoiceBitrateIsHostOwnedAndOptedIn(t *testing.T) {
	h := startHarness(t, harnessOptions{})
	host, viewer, old := openClient(t, h), openClient(t, h), openClient(t, h)
	authenticate(t, host, h.room, protocol.RoleHost, "bitrate_host_123456", -1, "", presenceOptions{roomSession: true, roomOnly: true})
	authenticate(t, viewer, h.room, protocol.RoleViewer, "bitrate_viewer_123456", 1, "", presenceOptions{})
	authenticate(t, old, h.room, protocol.RoleViewer, "bitrate_older_123456", 1, "", presenceOptions{})
	for _, client := range []*testClient{host, viewer} {
		client.sendJSON(map[string]any{"type": "subscribe-room-voice", "bitrate": true, "deafened": false})
		nextVoiceState(t, client, func(state protocol.RoomVoiceStateMessage) bool { return state.Bitrate == 64_000 })
	}
	old.sendJSON(map[string]any{"type": "subscribe-room-voice"})
	if initial := nextVoiceState(t, old, nil); initial.Bitrate != 0 {
		t.Fatal("new field sent to an older subscription")
	}
	voiceCommand(host, map[string]any{"action": "bitrate", "bitrate": 96_000})
	state := nextVoiceState(t, viewer, func(state protocol.RoomVoiceStateMessage) bool { return state.Bitrate == 96_000 })
	if state.Enabled || len(state.Publications) != 0 || len(state.Connections) != 0 {
		t.Fatal("quality setting activated voice")
	}
	if next := nextVoiceState(t, old, func(next protocol.RoomVoiceStateMessage) bool { return next.Revision >= state.Revision }); next.Bitrate != 0 {
		t.Fatal("new field sent to an older subscription")
	}
	voiceCommand(viewer, map[string]any{"action": "bitrate", "bitrate": 64_000})
	viewer.next("room-voice-error")
	h.locked(func() {
		if h.server.voices[h.room.RoomID].bitrate != 96_000 {
			t.Fatal("Viewer changed room bitrate")
		}
	})
}

func TestVoiceOnlyRouteFailureDoesNotChangeVideoStatus(t *testing.T) {
	h, _, viewer, _, viewerID := joinedVoiceOwnerRoom(t)
	h.locked(func() {
		for _, state := range []string{"waiting", "failed"} {
			h.server.router.sendViewerRouteStatus(h.room.RoomID, viewerID.PeerID,
				protocol.RouteStatusMessage{Type: "route-status", Revision: 1, State: state, Reason: "route-exhausted"})
		}
	})
	viewer.next("room-voice-error")
	if _, ok := viewer.tryNext("route-status", 30*time.Millisecond); ok {
		t.Fatal("voice-only routing changed video status")
	}
}

func TestRoomCandidateWaitsForBothPictureAndVoice(t *testing.T) {
	for _, pictureFirst := range []bool{true, false} {
		name := "voice-first"
		if pictureFirst {
			name = "picture-first"
		}
		t.Run(name, func(t *testing.T) {
			h := startHarness(t, harnessOptions{})
			host, viewer := openClient(t, h), openClient(t, h)
			authenticate(t, host, h.room, protocol.RoleHost, "composite_host_123456", -1, "", presenceOptions{roomSession: true, roomOnly: true})
			host.sendJSON(map[string]any{"type": "subscribe-room-voice"})
			nextVoiceState(t, host, nil)
			voiceCommand(host, map[string]any{"action": "join"})
			host.sendJSON(map[string]any{"type": "start-sharing", "shareGeneration": "composite_video_123456",
				"qualitySettings": protocol.DefaultQualitySettings, "routePolicy": protocol.DefaultRoutePolicy, "sharingPaused": false})
			host.next("sharing-started")
			authenticate(t, viewer, h.room, protocol.RoleViewer, "composite_viewer_123456", 1, "", presenceOptions{})
			viewer.sendJSON(map[string]any{"type": "subscribe-room-voice"})
			voiceCommand(viewer, map[string]any{"action": "join"})
			pending := nextVoiceState(t, viewer, func(state protocol.RoomVoiceStateMessage) bool {
				return len(state.Connections) == 1 && state.Connections[0].Pending
			})
			voice := pending.Connections[0]
			for prepared := nextPreparedRoute(t, viewer); prepared.Revision != int64(voice.Revision); prepared = nextPreparedRoute(t, viewer) {
			}
			picture := func() {
				viewer.sendJSON(map[string]any{"type": "route-ready", "phase": "prepare", "revision": voice.Revision})
			}
			audio := func() {
				for _, client := range []*testClient{host, viewer} {
					client.sendJSON(map[string]any{"type": "room-voice-transport", "connectionId": voice.ConnectionID, "state": "connected"})
				}
			}
			barriers := []*testClient{viewer}
			if pictureFirst {
				picture()
			} else {
				audio()
				barriers = append(barriers, host)
			}
			for _, client := range barriers {
				client.sendJSON(map[string]any{"type": "signaling-challenge", "sequence": 1})
				client.next("signaling-challenge-response")
			}
			h.locked(func() {
				rm, _ := h.server.router.rooms.Get(h.room.RoomID)
				if op := rm.controller.Operation(); op == nil || op.Current == nil || protocol.Int(op.Current.Revision) != voice.Revision {
					t.Fatal("only one media facet committed the room route")
				}
			})
			if pictureFirst {
				audio()
			} else {
				picture()
			}
			nextActiveRouteRevision(t, viewer, int64(voice.Revision))
			nextVoiceState(t, viewer, func(state protocol.RoomVoiceStateMessage) bool {
				return len(state.Connections) == 1 && !state.Connections[0].Pending
			})
		})
	}
}

func TestRoomVoiceUsesNormalRoomAuthorityAndKeepsGraphAcrossVideo(t *testing.T) {
	h := startHarness(t, harnessOptions{})
	host, viewer, old := openClient(t, h), openClient(t, h), openClient(t, h)
	hostID := authenticate(t, host, h.room, protocol.RoleHost, "voice_host_123456", -1, "", presenceOptions{roomSession: true, roomOnly: true})
	viewerID := authenticate(t, viewer, h.room, protocol.RoleViewer, "voice_viewer_123456", 1, "", presenceOptions{})
	authenticate(t, old, h.room, protocol.RoleViewer, "voice_old_page_123456", 1, "", presenceOptions{})
	for _, client := range []*testClient{host, viewer} {
		client.sendJSON(map[string]any{"type": "subscribe-room-voice"})
		nextVoiceState(t, client, nil)
	}
	voiceCommand(viewer, map[string]any{"action": "join"})
	viewer.next("room-voice-error")
	voiceCommand(viewer, map[string]any{"action": "publish"})
	viewer.next("room-voice-error")
	voiceCommand(host, map[string]any{"action": "join"})
	nextVoiceState(t, host, func(state protocol.RoomVoiceStateMessage) bool { return state.Enabled })
	voiceCommand(viewer, map[string]any{"action": "join"})
	pending := nextVoiceState(t, viewer, func(s protocol.RoomVoiceStateMessage) bool {
		return len(s.Connections) == 1 && s.Connections[0].Pending
	})
	voiceID := pending.Connections[0].ConnectionID
	for _, client := range []*testClient{host, viewer} {
		client.sendJSON(map[string]any{"type": "room-voice-transport", "connectionId": voiceID, "state": "connected"})
	}
	active := nextVoiceState(t, viewer, func(s protocol.RoomVoiceStateMessage) bool {
		return len(s.Connections) == 1 && !s.Connections[0].Pending
	})
	if active.Connections[0].ConnectionID != voiceID {
		t.Fatal("voice commit replaced the physical transport")
	}
	voiceCommand(host, map[string]any{"action": "publish"})
	publication := nextVoiceState(t, viewer, func(s protocol.RoomVoiceStateMessage) bool {
		return len(s.Publications) == 1 && len(s.Connections[0].Receive) == 1
	})
	pubID := publication.Publications[0].ID
	if publication.Publications[0].PeerID != hostID.PeerID {
		t.Fatal("publication sender was not authenticated")
	}
	voiceCommand(viewer, map[string]any{"action": "publish"})
	nextVoiceState(t, host, func(s protocol.RoomVoiceStateMessage) bool {
		return len(s.Publications) == 2 && len(s.Connections[0].Receive) == 1
	})
	viewerPub := nextVoiceState(t, viewer, func(s protocol.RoomVoiceStateMessage) bool { return len(s.Publications) == 2 })
	for _, pub := range viewerPub.Publications {
		if pub.PeerID == viewerID.PeerID {
			voiceCommand(viewer, map[string]any{"action": "unpublish", "publicationId": pub.ID})
		}
	}
	nextVoiceState(t, viewer, func(s protocol.RoomVoiceStateMessage) bool {
		return len(s.Publications) == 1 && s.Publications[0].ID == pubID
	})
	if _, ok := old.tryNext("room-voice-state", 30*time.Millisecond); ok {
		t.Fatal("voice sent to a page without capability opt-in")
	}

	h.server.mu.Lock()
	runtime, _ := h.server.router.rooms.Get(h.room.RoomID)
	logical := runtime.controller.Snapshot().UpstreamByViewer.Values()[0].ConnectionID
	h.server.mu.Unlock()
	host.sendJSON(map[string]any{"type": "start-sharing", "shareGeneration": "voice_video_generation_1",
		"qualitySettings": protocol.DefaultQualitySettings, "routePolicy": protocol.DefaultRoutePolicy, "sharingPaused": false})
	host.next("sharing-started")
	prepare := nextPreparedRoute(t, viewer)
	if prepare.Candidate.ConnectionID == logical {
		t.Fatal("video attachment reused room transport identity")
	}
	viewer.sendJSON(map[string]any{"type": "route-ready", "phase": "prepare", "revision": prepare.Revision})
	nextActiveRouteRevision(t, viewer, prepare.Revision)
	h.server.mu.Lock()
	edge, _ := runtime.controller.Snapshot().UpstreamByViewer.Get(viewerID.PeerID)
	h.server.mu.Unlock()
	if !edge.VideoReady || edge.ConnectionID != logical || edge.VideoConnectionID != prepare.Candidate.ConnectionID {
		t.Fatal("video did not attach to retained room edge")
	}
	host.sendJSON(map[string]any{"type": "stop-sharing", "shareGeneration": "voice_video_generation_1"})
	viewer.next("sharing-stopped")
	state := nextVoiceState(t, viewer, func(s protocol.RoomVoiceStateMessage) bool {
		return len(s.Publications) == 1 && len(s.Connections) == 1 && !s.Connections[0].Pending
	})
	if state.Connections[0].ConnectionID != voiceID || state.Publications[0].ID != pubID {
		t.Fatal("video stop retired room voice")
	}
	h.server.mu.Lock()
	edge, _ = runtime.controller.Snapshot().UpstreamByViewer.Get(viewerID.PeerID)
	h.server.mu.Unlock()
	if edge.VideoReady || edge.ConnectionID != logical || !edge.Usable {
		t.Fatal("video stop corrupted room graph")
	}
	// A late stop for a former source cannot retire a replacement microphone.
	voiceCommand(host, map[string]any{"action": "unpublish", "publicationId": pubID})
	nextVoiceState(t, viewer, func(s protocol.RoomVoiceStateMessage) bool { return len(s.Publications) == 0 })
	voiceCommand(host, map[string]any{"action": "publish"})
	newState := nextVoiceState(t, viewer, func(s protocol.RoomVoiceStateMessage) bool { return len(s.Publications) == 1 })
	voiceCommand(host, map[string]any{"action": "unpublish", "publicationId": pubID})
	last := nextVoiceState(t, viewer, func(s protocol.RoomVoiceStateMessage) bool {
		return len(s.Publications) == 1 && s.Publications[0].ID == newState.Publications[0].ID
	})
	if last.Publications[0].ID == pubID {
		t.Fatal("publication identity was reused")
	}
	voiceCommand(viewer, map[string]any{"action": "leave"})
	nextVoiceState(t, viewer, func(state protocol.RoomVoiceStateMessage) bool {
		for _, member := range state.Members {
			if member.PeerID == viewerID.PeerID {
				return !member.Joined
			}
		}
		return false
	})

	viewer.sendJSON(map[string]any{"type": "signaling-challenge", "sequence": 42})
	viewer.next("signaling-challenge-response")
}
