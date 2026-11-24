package route

import (
	"encoding/json"
	"os"
	"strings"
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

func TestControllerDebugTracksActualCandidateRetirement(t *testing.T) {
	for _, test := range []struct {
		name, event string
		at          int64
		reason      RejectionBucket
		retire      func(*Controller, int64)
	}{
		{"deadline-via-reconcile", "operation-deadline", 1010, RejectionNone,
			func(c *Controller, at int64) { c.Reconcile(at) }},
		{"parent-capacity", "candidate-retired", 31, RejectionStale,
			func(c *Controller, at int64) {
				c.SetEffectiveCapacity(HOST, "host_session", 0, &at)
				c.Reconcile(at)
			}},
		{"pause", "operation-aborted", 31, RejectionAborted,
			func(c *Controller, at int64) { c.SetPaused(true, &at) }},
	} {
		t.Run(test.name, func(t *testing.T) {
			var events []map[string]any
			sink := func(_ string, args ...any) {
				fields := make(map[string]any)
				for i := 0; i < len(args); i += 2 {
					key := args[i].(string)
					if _, exists := fields[key]; exists {
						t.Fatalf("duplicate diagnostic key %q", key)
					}
					fields[key] = args[i+1]
				}
				events = append(events, fields)
			}
			c := newController(1, Options{OperationTimeoutMs: 1000, DebugRoomID: "test-room", DebugLog: sink})
			addViewer(c, A, 0, nil)
			c.Reconcile(10)
			baseRevision := c.Snapshot().Revision
			operation := beginOperation(t, c, BeginInput{NowMs: 20, ConnectionID: "private-connection", Reservation: direct()})
			started := events[len(events)-1]
			eq(t, started["event"], "candidate-started")
			eq[any](t, started["revision"], baseRevision)
			eq[any](t, started["candidateRevision"], operation.Current.Revision)
			before := len(events)
			eq(t, c.OperationExpired(30).Accepted, false)
			eq(t, len(events), before)
			test.retire(c, test.at)
			var terminal []map[string]any
			invalidReason := ""
			for _, event := range events {
				if event["event"] == test.event {
					terminal = append(terminal, event)
				}
				if event["event"] == "candidate-invalid" {
					invalidReason = event["reason"].(string)
				}
			}
			eq(t, len(terminal), 1)
			entry := terminal[0]
			eq[any](t, entry["child"], c.DiagnosticParticipantLabel(A))
			eq(t, entry["candidate"], "p2p:host")
			eq[any](t, entry["candidateRevision"], operation.Current.Revision)
			eq[any](t, entry["elapsedMs"], test.at-20)
			eq[any](t, entry["remainingMs"], int64(1010)-test.at)
			if test.reason != RejectionNone {
				eq[any](t, entry["reason"], test.reason)
			}
			if test.name == "parent-capacity" {
				eq(t, invalidReason, "parent-capacity")
			}
			raw, err := json.Marshal(events)
			if err != nil {
				t.Fatal(err)
			}
			for _, private := range []string{HOST, A, "host_session", sessionOf(A), "private-connection"} {
				if strings.Contains(string(raw), private) {
					t.Fatal("route diagnostics exposed a private endpoint identity")
				}
			}
		})
	}
}
