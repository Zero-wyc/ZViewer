package signal

import (
	"sync/atomic"
	"testing"
	"time"

	"zviewer/backend/internal/piik/server/protocol"
)

func subscribeInteractions(t *testing.T, client *testClient) {
	t.Helper()
	client.sendJSON(map[string]any{"type": "subscribe-room-interactions"})
	ready := client.next("room-interactions-ready")
	if _, err := protocol.DecodeServerMessage(ready.raw); err != nil {
		t.Fatal(err)
	}
}

func TestRoomInteractionsStayInsideAuthorizedOptedInMembership(t *testing.T) {
	var now atomic.Int64
	now.Store(100_000)
	h := startHarness(t, harnessOptions{maxViewersPerRoom: 4, now: now.Load})
	host, viewer, old := openClient(t, h), openClient(t, h), openClient(t, h)
	authenticate(t, host, h.room, protocol.RoleHost, "host_interaction", -1, "", presenceOptions{displayName: "房主", viewerPresence: true})
	actor := authenticate(t, viewer, h.room, protocol.RoleViewer, "viewer_interaction", -1, "", presenceOptions{displayName: "小明", viewerPresence: true})
	authenticate(t, old, h.room, protocol.RoleViewer, "old_page_interaction", -1, "", presenceOptions{})
	otherRoom, err := h.server.CreateRoom(protocol.CodeEntryOpen, nil, "")
	if err != nil {
		t.Fatal(err)
	}
	outsider := openClient(t, h)
	other := authenticate(t, outsider, otherRoom, protocol.RoleViewer, "outsider_interaction", -1, "", presenceOptions{displayName: "Elsewhere", viewerPresence: true})
	for _, client := range []*testClient{host, viewer, outsider} {
		subscribeInteractions(t, client)
	}
	viewer.sendJSON(map[string]any{"type": "send-room-interaction", "requestId": "request_message_1", "payload": map[string]any{"kind": "chat", "text": "<b>你好 👋</b>"}})
	hostEvent := host.next("room-interaction")
	viewerEvent := viewer.next("room-interaction")
	if string(hostEvent.raw) != string(viewerEvent.raw) {
		t.Fatal("recipients received different events")
	}
	decoded, err := protocol.DecodeServerMessage(hostEvent.raw)
	if err != nil {
		t.Fatal(err)
	}
	event := decoded.(protocol.RoomInteractionMessage)
	if event.OccurredAt != protocol.Int(now.Load()) {
		t.Fatal("event time was not stamped at server acceptance")
	}
	if event.Sender.PeerID != actor.PeerID || event.Sender.DisplayName != "小明" {
		t.Fatal("sender identity was not derived from authentication")
	}
	for _, client := range []*testClient{old, outsider} {
		if _, ok := client.tryNext("room-interaction", 30*time.Millisecond); ok {
			t.Fatal("interaction escaped its negotiated room boundary")
		}
	}
	viewer.sendJSON(map[string]any{"type": "send-room-interaction", "requestId": "request_message_2", "payload": map[string]any{"kind": "reaction", "reaction": "wave"}})
	expectMatch(t, viewer.next("room-interaction-rejected").raw, `{"reason":"rate-limited"}`)
	now.Add(protocol.InteractionIntervalMs)
	viewer.sendJSON(map[string]any{"type": "send-room-interaction", "requestId": "request_message_3", "payload": map[string]any{"kind": "reaction", "reaction": "tomato", "targetPeerId": other.PeerID}})
	expectMatch(t, viewer.next("room-interaction-rejected").raw, `{"reason":"target-unavailable"}`)
	// Room data and its rejections never terminate signaling or require media.
	viewer.sendJSON(map[string]any{"type": "signaling-challenge", "sequence": 123})
	viewer.next("signaling-challenge-response")
}

func TestRoomInteractionRequiresAuthenticationAndSubscription(t *testing.T) {
	h := startHarness(t, harnessOptions{})
	guest := openClient(t, h)
	guest.sendJSON(map[string]any{"type": "subscribe-room-interactions"})
	expectMatch(t, guest.next("error").raw, `{"code":"AUTH_REQUIRED"}`)
	viewer := openClient(t, h)
	authenticate(t, viewer, h.room, protocol.RoleViewer, "unsubscribed_viewer", -1, "", presenceOptions{displayName: "Friend", viewerPresence: true})
	viewer.sendJSON(map[string]any{"type": "send-room-interaction", "requestId": "request_message_1", "payload": map[string]any{"kind": "chat", "text": "hello"}})
	expectMatch(t, viewer.next("room-interaction-rejected").raw, `{"reason":"not-subscribed"}`)
}

func TestViewersCanInteractAfterHostDisconnects(t *testing.T) {
	var now atomic.Int64
	now.Store(100_000)
	h := startHarness(t, harnessOptions{now: now.Load})
	host, first, second := openClient(t, h), openClient(t, h), openClient(t, h)
	hostActor := authenticate(t, host, h.room, protocol.RoleHost, "leaving_host", -1, "",
		presenceOptions{displayName: "Host", roomSession: true})
	authenticate(t, first, h.room, protocol.RoleViewer, "remaining_first", -1, "", presenceOptions{displayName: "First"})
	secondActor := authenticate(t, second, h.room, protocol.RoleViewer, "remaining_second", -1, "", presenceOptions{displayName: "Second"})
	subscribeInteractions(t, first)
	subscribeInteractions(t, second)
	h.closeClient(host)
	for _, payload := range []map[string]any{
		{"kind": "chat", "text": "still here"},
		{"kind": "reaction", "reaction": "wave"},
		{"kind": "reaction", "reaction": "tomato", "targetPeerId": secondActor.PeerID},
	} {
		first.sendJSON(map[string]any{"type": "send-room-interaction", "requestId": "after_host_left", "payload": payload})
		if a, b := first.next("room-interaction"), second.next("room-interaction"); string(a.raw) != string(b.raw) {
			t.Fatal("remaining viewers did not receive the same interaction")
		}
		now.Add(protocol.InteractionIntervalMs)
	}
	first.sendJSON(map[string]any{"type": "send-room-interaction", "requestId": "departed_target",
		"payload": map[string]any{"kind": "reaction", "reaction": "tomato", "targetPeerId": hostActor.PeerID}})
	expectMatch(t, first.next("room-interaction-rejected").raw, `{"reason":"target-unavailable"}`)
}

func TestRoomInteractionBackpressureDoesNotRetireMediaSignaling(t *testing.T) {
	h := startHarness(t, harnessOptions{})
	host, viewer := openClient(t, h), openClient(t, h)
	authenticate(t, host, h.room, protocol.RoleHost, "data_host_1234", -1, "", presenceOptions{displayName: "Host", viewerPresence: true})
	actor := authenticate(t, viewer, h.room, protocol.RoleViewer, "slow_viewer_1234", -1, "", presenceOptions{displayName: "Viewer", viewerPresence: true})
	subscribeInteractions(t, host)
	subscribeInteractions(t, viewer)
	h.locked(func() {
		peer, ok := h.server.store.GetConnectedViewer(h.room.RoomID, actor.PeerID)
		if !ok {
			t.Fatal("missing viewer")
		}
		slow := h.server.sessionsByID[peer.SessionID]
		// Inject a stalled writer under the same lock as a real broadcast, so
		// the test does not depend on OS TCP buffer sizes or the reader's timing.
		previous := slow.queuedBytes
		slow.queuedBytes = 20 * 1024
		hostPeer, _ := h.server.store.GetConnectedHost(h.room.RoomID)
		hostSession := h.server.sessionsByID[hostPeer.SessionID]
		h.server.handleRoomInteraction(hostSession, hostSession.authenticated, protocol.SendRoomInteractionMessage{
			Type: "send-room-interaction", RequestID: "busy_request_1234", Payload: protocol.InteractionPayload{Kind: "chat", Text: "hello"},
		})
		if slow.terminated || slow.closeQueued {
			t.Error("room data closed the signaling session")
		}
		if slow.queuedBytes != 20*1024 {
			t.Error("room data entered a stalled signaling queue")
		}
		slow.queuedBytes = previous
	})
	host.next("room-interaction")
	if _, ok := viewer.tryNext("room-interaction", 30*time.Millisecond); ok {
		t.Fatal("stalled recipient got room data")
	}
	viewer.sendJSON(map[string]any{"type": "signaling-challenge", "sequence": 456})
	viewer.next("signaling-challenge-response")
}
