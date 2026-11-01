package signal

import (
	"strings"
	"testing"
	"time"

	"zviewer/backend/internal/piik/server/protocol"
)

func TestCoPlayPresenceUsesCurrentInputAuthority(t *testing.T) {
	h := startHarness(t, harnessOptions{})
	host := openClient(t, h)
	const generation = "coplay_share_generation_12345678"
	authenticate(t, host, h.room, protocol.RoleHost, "coplay_host_client", 1, generation, presenceOptions{roomSession: true})
	viewer, legacy := openClient(t, h), openClient(t, h)
	actor := authenticate(t, viewer, h.room, protocol.RoleViewer, "coplay_viewer_client", 1, "", presenceOptions{})
	authenticate(t, legacy, h.room, protocol.RoleViewer, "coplay_legacy_client", 1, "", presenceOptions{})
	endpoint := strings.Repeat("1", 32)
	viewer.sendJSON(map[string]any{"type": "subscribe-remote-input", "endpointId": endpoint, "secret": strings.Repeat("2", 64)})
	viewer.sendJSON(map[string]any{"type": "subscribe-co-play-presence"})
	expectMatch(t, viewer.next("co-play-presence").raw, `{"participants":[]}`)
	set := func(client *testClient, share, id string) {
		client.sendJSON(map[string]any{"type": "set-co-play-presence", "shareGeneration": share,
			"grants": []protocol.CoPlayGrant{{EndpointID: id}}})
	}
	set(host, generation, endpoint)
	event, err := protocol.DecodeServerMessage(viewer.next("co-play-presence").raw)
	if err != nil {
		t.Fatal(err)
	}
	participants := event.(protocol.CoPlayPresenceMessage).Participants
	if len(participants) != 1 || participants[0].PeerID != actor.PeerID {
		t.Fatal("presence did not resolve the authenticated endpoint's room identity")
	}
	if _, ok := legacy.tryNext("co-play-presence", 30*time.Millisecond); ok {
		t.Fatal("legacy Viewer received an unrequested event")
	}
	set(viewer, generation, endpoint)
	set(host, "stale_coplay_generation", endpoint)
	if _, ok := viewer.tryNext("co-play-presence", 30*time.Millisecond); ok {
		t.Fatal("non-Host or stale source changed collaboration")
	}
	legacy.sendJSON(map[string]any{"type": "subscribe-co-play-presence"})
	event, err = protocol.DecodeServerMessage(legacy.next("co-play-presence").raw)
	if err != nil || len(event.(protocol.CoPlayPresenceMessage).Participants) != 1 {
		t.Fatal("late subscriber missed the current participants")
	}
	h.closeClient(viewer)
	expectMatch(t, legacy.next("co-play-presence").raw, `{"participants":[]}`)
	viewer = openClient(t, h)
	authenticate(t, viewer, h.room, protocol.RoleViewer, "coplay_viewer_client", 1, "", presenceOptions{})
	viewer.sendJSON(map[string]any{"type": "subscribe-remote-input", "endpointId": endpoint, "secret": strings.Repeat("5", 64)})
	viewer.sendJSON(map[string]any{"type": "subscribe-co-play-presence"})
	expectMatch(t, viewer.next("co-play-presence").raw, `{"participants":[]}`)
	h.closeClient(viewer)
	viewer = openClient(t, h)
	authenticate(t, viewer, h.room, protocol.RoleViewer, "coplay_viewer_client", 1, "", presenceOptions{})
	viewer.sendJSON(map[string]any{"type": "subscribe-remote-input", "endpointId": strings.Repeat("3", 32), "secret": strings.Repeat("4", 64)})
	viewer.sendJSON(map[string]any{"type": "subscribe-co-play-presence"})
	expectMatch(t, viewer.next("co-play-presence").raw, `{"participants":[]}`)
	set(host, generation, endpoint)
	expectMatch(t, viewer.next("co-play-presence").raw, `{"participants":[]}`)
	set(host, generation, strings.Repeat("3", 32))
	event, err = protocol.DecodeServerMessage(viewer.next("co-play-presence").raw)
	if err != nil || len(event.(protocol.CoPlayPresenceMessage).Participants) != 1 {
		t.Fatal("new endpoint could not be presented")
	}
	host.sendJSON(map[string]any{"type": "stop-sharing", "shareGeneration": generation})
	expectMatch(t, viewer.next("co-play-presence").raw, `{"participants":[]}`)
	viewer.next("sharing-stopped")
	host.sendJSON(map[string]any{"type": "start-sharing", "shareGeneration": "next_coplay_generation", "routePolicy": protocol.DefaultRoutePolicy})
	host.next("sharing-started")
	expectMatch(t, viewer.next("co-play-presence").raw, `{"participants":[]}`)
}
