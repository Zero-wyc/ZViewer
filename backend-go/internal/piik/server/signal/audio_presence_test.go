package signal

import (
	"testing"
	"time"

	"zviewer/backend/internal/piik/server/protocol"
)

func TestAudioPresenceSubscriptionGenerationAndReconnect(t *testing.T) {
	h := startHarness(t, harnessOptions{})
	host := openClient(t, h)
	const generation = "audio_share_generation_12345678"
	authenticate(t, host, h.room, protocol.RoleHost, "audio_host_client", 1, generation, presenceOptions{roomSession: true})
	viewer := openClient(t, h)
	authenticate(t, viewer, h.room, protocol.RoleViewer, "audio_viewer_client", 1, "", presenceOptions{})
	legacy := openClient(t, h)
	authenticate(t, legacy, h.room, protocol.RoleViewer, "legacy_audio_client", 1, "", presenceOptions{})
	viewer.sendJSON(map[string]any{"type": "subscribe-audio-presence"})
	expectMatch(t, viewer.next("audio-presence").raw, `{"available":null}`)
	set := func(client *testClient, share string, available bool) {
		client.sendJSON(map[string]any{"type": "set-audio-presence", "shareGeneration": share, "available": available})
	}
	set(host, generation, false)
	expectMatch(t, viewer.next("audio-presence").raw, `{"available":false}`)
	set(host, generation, true)
	expectMatch(t, viewer.next("audio-presence").raw, `{"available":true}`)
	if _, ok := legacy.tryNext("audio-presence", 30*time.Millisecond); ok {
		t.Fatal("legacy Viewer received an unrequested event")
	}
	legacy.sendJSON(map[string]any{"type": "subscribe-audio-presence"})
	expectMatch(t, legacy.next("audio-presence").raw, `{"available":true}`)
	set(viewer, generation, false)
	set(host, "replaced_audio_generation", false)
	if _, ok := viewer.tryNext("audio-presence", 30*time.Millisecond); ok {
		t.Fatal("non-Host or stale generation changed availability")
	}
	h.closeClient(viewer)
	viewer = openClient(t, h)
	authenticate(t, viewer, h.room, protocol.RoleViewer, "audio_viewer_client", 1, "", presenceOptions{})
	viewer.sendJSON(map[string]any{"type": "subscribe-audio-presence"})
	expectMatch(t, viewer.next("audio-presence").raw, `{"available":true}`)
	h.closeClient(host)
	host = openClient(t, h)
	authenticate(t, host, h.room, protocol.RoleHost, "audio_host_client", 1, generation, presenceOptions{roomSession: true})
	h.locked(func() {
		available := h.server.shares[h.room.RoomID].audioAvailable
		if available == nil || !*available {
			t.Fatal("same-generation Host reconnect lost input availability")
		}
	})
	set(host, generation, false)
	expectMatch(t, viewer.next("audio-presence").raw, `{"available":false}`)
	host.sendJSON(map[string]any{"type": "stop-sharing", "shareGeneration": generation})
	// stopSharing clears the room fact before notifying publication retirement.
	expectMatch(t, viewer.next("audio-presence").raw, `{"available":null}`)
	viewer.next("sharing-stopped")
	host.sendJSON(map[string]any{"type": "start-sharing", "shareGeneration": "next_audio_generation", "routePolicy": protocol.DefaultRoutePolicy})
	host.next("sharing-started")
	expectMatch(t, viewer.next("audio-presence").raw, `{"available":null}`)
	set(host, "next_audio_generation", true)
	expectMatch(t, viewer.next("audio-presence").raw, `{"available":true}`)
}
