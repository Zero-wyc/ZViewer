package route

import (
	"encoding/json"
	"os"
	"testing"

	"zviewer/backend/internal/piik/server/protocol"
)

func TestDiagnosticReadersAcceptCurrentRoomProducer(t *testing.T) {
	routes := newController(1, Options{})
	addViewer(routes, A, 20, nil)
	routes.SetRelayVolunteer(A, sessionOf(A), true, nil)
	routes.hydrateEdge(A, peerEdge(HOST, "host_a"))
	for _, peer := range []string{B, C, D, E} {
		addViewer(routes, peer, 0, nil)
		routes.hydrateEdge(peer, peerEdge(A, peer+"_edge"))
	}
	routes.SetVideoPublication("new_video", false, 1)
	// Replacement preserves the room edges and prepares one video attachment.
	routes.SetVideoPublication("replacement_video", false, 2)
	routes.Reconcile(3)
	encoded, err := protocol.EncodeServerMessage(protocol.RouteDiagnosticSnapshotMessage{
		Type: "route-diagnostic-snapshot", Snapshot: routes.RouteDiagnosticSnapshot(3),
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := protocol.DecodeServerMessage(encoded); err != nil {
		t.Fatalf("current producer rejected: %v", err)
	}
	for _, field := range []string{"effectiveCapacity", "childCount"} {
		var invalid map[string]any
		if err := json.Unmarshal(encoded, &invalid); err != nil {
			t.Fatal(err)
		}
		child := invalid["snapshot"].(map[string]any)["children"].([]any)[0].(map[string]any)
		child[field] = protocol.MaxViewersPerRoomLimit + 1
		raw, err := json.Marshal(invalid)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := protocol.DecodeServerMessage(raw); err == nil {
			t.Fatalf("diagnostic %s exceeded the room resource bound", field)
		}
	}
	// The same production output is replayed by the TypeScript wire fixture.
	raw, err := os.ReadFile("../../../../tests/fixtures/wire-samples.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		ServerMessages []struct{ Name, JSON string }
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	for _, sample := range fixture.ServerMessages {
		if sample.Name == "room-relay-video-attachment-diagnostic" {
			if sample.JSON != string(encoded) {
				t.Fatal("cross-language fixture drifted from the actual room producer")
			}
			return
		}
	}
	t.Fatal("current room diagnostic is missing from the cross-language fixture")
}

func TestControllerDebugRequiresInjectedSinkAndRoom(t *testing.T) {
	var kinds, events []string
	sink := func(kind string, args ...any) {
		kinds = append(kinds, kind)
		if len(args) >= 2 {
			if event, ok := args[1].(string); ok {
				events = append(events, event)
			}
		}
	}
	c := &Controller{debugRoomID: "1234", debugLog: sink}
	c.debug("operation-started", "child", "viewer-1")
	if len(kinds) != 1 || kinds[0] != "piik-route" ||
		len(events) != 1 || events[0] != "operation-started" {
		t.Fatalf("injected sink received kinds=%v events=%v", kinds, events)
	}
	(&Controller{debugRoomID: "1234"}).debug("no-sink")
	(&Controller{debugLog: sink}).debug("no-room")
	if len(kinds) != 1 {
		t.Fatalf("disabled controller emitted %v", kinds)
	}
}
