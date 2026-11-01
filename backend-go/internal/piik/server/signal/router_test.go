package signal

// Ported from tests/hybrid-media-router.test.ts (baseline b20fd88). The
// harness mirrors harness(...) there: a memory room.Store, a real
// sfu.Admission, sfutest.FakeMedia behind a thin spy (the vi.spyOn
// cases), a fake token issuer returning "token-<peerId>", recorded hooks and
// the shared mutex every router call and every assertion takes.
//
// Timing model. Node ran each TS test segment between two awaits as one
// synchronous tick with the router's continuations (the pump, token issues,
// drains) suspended; they ran at the next microtask checkpoint. Here every
// such segment is one h.locked block, so the router's goroutines (which take
// the same mutex) cannot interleave with it, and the TS await points map to
// waitFor/advance, which let those goroutines settle (router.inflight == 0).
// The seven fake-timer cases reproduce vitest 4.1 exactly: vi.waitFor ticks
// the clock 50 ms before every check and gives up after 20 checks,
// advanceTimersByTimeAsync fires due timers in order at their due time and
// flushes between them, and setSystemTime jumps the clock while shifting
// every pending timer by the same amount.

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"reflect"
	"runtime"
	"slices"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"zviewer/backend/internal/piik/server/ordered"
	"zviewer/backend/internal/piik/server/protocol"
	"zviewer/backend/internal/piik/server/room"
	"zviewer/backend/internal/piik/server/route"
	"zviewer/backend/internal/piik/server/sfu"
	"zviewer/backend/internal/piik/server/sfu/sfutest"
)

const testShareGeneration = "share_generation_12345678"

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

type routerHarnessOptions struct {
	capacity           int
	withSfu            bool
	prepareTimeoutMs   int64
	sfuIngressCapacity int
	fakeTimers         bool
}

type routerHarness struct {
	t             *testing.T
	mu            sync.Mutex
	store         *room.Store
	router        *router
	admission     *sfu.Admission
	media         *spyMedia
	clock         *manualClock
	sent          map[string][]protocol.ServerMessage
	routesChanged []string
}

func newRouterHarness(t *testing.T, options routerHarnessOptions) *routerHarness {
	t.Helper()
	h := &routerHarness{t: t, sent: map[string][]protocol.ServerMessage{}}
	storeOptions := room.Options{MaxRooms: 4, MaxViewersPerRoom: 20}
	var now func() int64
	var afterFunc func(time.Duration, func()) func() bool
	if options.fakeTimers {
		h.clock = &manualClock{settle: h.settle}
		now = h.clock.now
		afterFunc = h.clock.afterFunc
	}
	store, err := room.New(storeOptions)
	if err != nil {
		t.Fatalf("room.New: %v", err)
	}
	h.store = store
	var fallback *sfuFallback
	if options.withSfu {
		ingress := options.sfuIngressCapacity
		if ingress == 0 {
			ingress = 2
		}
		h.admission = sfu.NewAdmission(sfu.AdmissionOptions{IngressCapacity: ingress, EgressCapacity: 20})
		h.media = &spyMedia{FakeMedia: sfutest.New()}
		fallback = &sfuFallback{
			admission:        h.admission,
			media:            h.media,
			prepareTimeoutMs: options.prepareTimeoutMs,
		}
	}
	h.router = newRouter(routerOptions{
		mu:                        &h.mu,
		store:                     store,
		endpointMediaCopyCapacity: options.capacity,
		sfu:                       fallback,
		hooks: routerHooks{
			sendToSession: func(sessionID string, message protocol.ServerMessage) {
				h.sent[sessionID] = append(h.sent[sessionID], message)
			},
			shareGeneration: func(string) string { return testShareGeneration },
			routesChanged:   func(roomID string) { h.routesChanged = append(h.routesChanged, roomID) },
		},
		now:       now,
		afterFunc: afterFunc,
	})
	t.Cleanup(func() { _ = h.close() })
	return h
}

// locked runs fn as one synchronous TS segment.
func (h *routerHarness) locked(fn func()) {
	h.mu.Lock()
	defer h.mu.Unlock()
	fn()
}

// settle waits for the router's pending continuations (the TS microtask
// backlog) to finish.
func (h *routerHarness) settle() {
	h.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		var idle bool
		h.locked(func() { idle = h.router.inflight == 0 })
		if idle {
			return
		}
		if time.Now().After(deadline) {
			h.t.Fatal("timed out waiting for the router to settle")
		}
		time.Sleep(time.Millisecond)
	}
}

// close is the signaling server's `await this.hybridMediaRouter.close()`:
// entered with mu held, released only around the drain waits.
func (h *routerHarness) close() error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var err error
	h.locked(func() { err = h.router.close(ctx) })
	return err
}

func (h *routerHarness) createRoom() room.CreatedRoom {
	h.t.Helper()
	var created room.CreatedRoom
	var err error
	h.locked(func() {
		err = h.store.BeginCreateRoom()
		if err == nil {
			created, err = h.store.CreateRoom(protocol.CodeEntryOpen, nil, nil, "")
		}
	})
	if err != nil {
		h.t.Fatalf("createRoom: %v", err)
	}
	return created
}

// connectHost ports connectHost: the store side only, like the TS helper.
func (h *routerHarness) connectHost(created room.CreatedRoom, policy *protocol.RoutePolicy, clientID, sessionID string) authenticatedRouteParticipant {
	h.t.Helper()
	if clientID == "" {
		clientID = "host_client_12345678"
	}
	if sessionID == "" {
		sessionID = "host_session_12345678"
	}
	var connected room.ConnectedParticipant
	var err error
	h.locked(func() {
		connected, err = h.store.ConnectParticipant(room.ConnectParticipantInput{
			RoomID:    created.RoomID,
			Role:      protocol.RoleHost,
			Token:     created.HostToken,
			ClientID:  clientID,
			SessionID: sessionID,
		})
	})
	if err != nil {
		h.t.Fatalf("connect host: %v", err)
	}
	return authenticatedRouteParticipant{
		roomID:      created.RoomID,
		role:        protocol.RoleHost,
		peerID:      connected.PeerID,
		sessionID:   sessionID,
		routePolicy: policy,
	}
}

// connectViewer ports connectViewer: the store side only.
func (h *routerHarness) connectViewer(created room.CreatedRoom, suffix string) authenticatedRouteParticipant {
	h.t.Helper()
	sessionID := "viewer_session_" + suffix + "_12345678"
	var connected room.ConnectedParticipant
	var err error
	h.locked(func() {
		connected, err = h.store.ConnectParticipant(room.ConnectParticipantInput{
			RoomID:      created.RoomID,
			Role:        protocol.RoleViewer,
			ViewerGrant: created.ViewerGrant,
			ClientID:    "viewer_client_" + suffix + "_12345678",
			SessionID:   sessionID,
		})
	})
	if err != nil {
		h.t.Fatalf("connect viewer %s: %v", suffix, err)
	}
	return authenticatedRouteParticipant{
		roomID:    created.RoomID,
		role:      protocol.RoleViewer,
		peerID:    connected.PeerID,
		sessionID: sessionID,
	}
}

// The do* helpers are the TS router calls; they expect the harness lock to be
// held by an enclosing locked block. The lock-taking wrappers below serve the
// single-call segments.

func (h *routerHarness) doComplete(participant authenticatedRouteParticipant) hybridAuthenticationState {
	state := h.router.connectParticipant(participant)
	h.router.completeAuthentication(participant, state)
	return state
}

func readyMessage(revision int64) protocol.RouteReadyMessage {
	return protocol.RouteReadyMessage{Type: "route-ready", Revision: protocol.Int(revision), Phase: "prepare"}
}

func (h *routerHarness) doReady(participant authenticatedRouteParticipant, revision int64) {
	h.router.handleRouteReady(participant, readyMessage(revision))
}

func (h *routerHarness) doReadyApproved(participant authenticatedRouteParticipant, revision int64) {
	message := readyMessage(revision)
	message.QualityApproved = true
	h.router.handleRouteReady(participant, message)
}

func routeFailedMessage(revision int64, phase, connectionID string) protocol.RouteFailedMessage {
	message := protocol.RouteFailedMessage{Type: "route-failed", Revision: protocol.Int(revision), Phase: phase}
	if connectionID != "" {
		message.ConnectionID = &connectionID
	}
	return message
}

func (h *routerHarness) doFailed(participant authenticatedRouteParticipant, message protocol.RouteFailedMessage) {
	h.router.handleRouteFailed(participant, message)
}

func (h *routerHarness) doRelay(participant authenticatedRouteParticipant, downstreamEdges int) {
	h.router.setViewerRelayCapacity(participant, downstreamEdges)
}

// doDisconnect is the store.disconnectParticipant + router.disconnectParticipant pair.
func (h *routerHarness) doDisconnect(participant authenticatedRouteParticipant) {
	h.t.Helper()
	if _, err := h.store.DisconnectParticipant(participant.roomID, participant.peerID, participant.sessionID); err != nil {
		h.t.Fatalf("DisconnectParticipant: %v", err)
	}
	h.router.disconnectParticipant(participant.roomID, participant.peerID, participant.sessionID)
}

func (h *routerHarness) doEdge(roomID, peerID string) (activeViewerMediaEdge, bool) {
	return h.router.resolveActiveViewerMediaEdge(roomID, peerID)
}

func (h *routerHarness) doMustEdge(roomID, peerID string) activeViewerMediaEdge {
	h.t.Helper()
	edge, ok := h.doEdge(roomID, peerID)
	if !ok {
		h.t.Fatal("expected an active viewer media edge")
	}
	return edge
}

func (h *routerHarness) complete(participant authenticatedRouteParticipant) hybridAuthenticationState {
	var state hybridAuthenticationState
	h.locked(func() { state = h.doComplete(participant) })
	return state
}

func (h *routerHarness) routeReady(participant authenticatedRouteParticipant, revision int64) {
	h.locked(func() { h.doReady(participant, revision) })
}

func (h *routerHarness) routeFailed(participant authenticatedRouteParticipant, message protocol.RouteFailedMessage) {
	h.locked(func() { h.doFailed(participant, message) })
}

func (h *routerHarness) disconnect(participant authenticatedRouteParticipant) {
	h.t.Helper()
	h.locked(func() { h.doDisconnect(participant) })
}

func (h *routerHarness) activeEdge(roomID, peerID string) (activeViewerMediaEdge, bool) {
	var edge activeViewerMediaEdge
	var ok bool
	h.locked(func() { edge, ok = h.doEdge(roomID, peerID) })
	return edge, ok
}

func (h *routerHarness) mustActiveEdge(roomID, peerID string) activeViewerMediaEdge {
	h.t.Helper()
	edge, ok := h.activeEdge(roomID, peerID)
	if !ok {
		h.t.Fatal("expected an active viewer media edge")
	}
	return edge
}

func (h *routerHarness) messages(sessionID string) []protocol.ServerMessage {
	var copied []protocol.ServerMessage
	h.locked(func() { copied = slices.Clone(h.sent[sessionID]) })
	return copied
}

func (h *routerHarness) allMessages() []protocol.ServerMessage {
	var all []protocol.ServerMessage
	h.locked(func() {
		for _, messages := range h.sent {
			all = append(all, messages...)
		}
	})
	return all
}

// preparedFor ports preparedFor: the last phase "prepare" route-update.
func (h *routerHarness) preparedFor(sessionID string) (protocol.RouteUpdatePrepareMessage, bool) {
	return lastPrepare(h.messages(sessionID), "")
}

// ownPrepare is the test-local ownPrepare: the last prepare whose candidate
// child is the participant.
func (h *routerHarness) ownPrepare(participant authenticatedRouteParticipant) (protocol.RouteUpdatePrepareMessage, bool) {
	return lastPrepare(h.messages(participant.sessionID), participant.peerID)
}

func lastPrepare(messages []protocol.ServerMessage, childPeerID string) (protocol.RouteUpdatePrepareMessage, bool) {
	for index := len(messages) - 1; index >= 0; index-- {
		if prepared, ok := messages[index].(protocol.RouteUpdatePrepareMessage); ok &&
			(childPeerID == "" || prepared.Candidate.ChildPeerID == childPeerID) {
			return prepared, true
		}
	}
	return protocol.RouteUpdatePrepareMessage{}, false
}

// activeAfter ports activeAfter.
func (h *routerHarness) activeAfter(sessionID string, revision int64) (protocol.RouteUpdateActiveMessage, bool) {
	messages := h.messages(sessionID)
	for index := len(messages) - 1; index >= 0; index-- {
		if active, ok := messages[index].(protocol.RouteUpdateActiveMessage); ok && int64(active.Revision) > revision {
			return active, true
		}
	}
	return protocol.RouteUpdateActiveMessage{}, false
}

func (h *routerHarness) lastRouteStatus(sessionID string) (protocol.RouteStatusMessage, bool) {
	messages := h.messages(sessionID)
	for index := len(messages) - 1; index >= 0; index-- {
		if status, ok := messages[index].(protocol.RouteStatusMessage); ok {
			return status, true
		}
	}
	return protocol.RouteStatusMessage{}, false
}

func (h *routerHarness) hasRouteStatus(sessionID, state string) bool {
	return h.countRouteStatus(sessionID, state) > 0
}

func (h *routerHarness) countRouteStatus(sessionID, state string) int {
	count := 0
	for _, message := range h.messages(sessionID) {
		if status, ok := message.(protocol.RouteStatusMessage); ok && status.State == state {
			count++
		}
	}
	return count
}

func sfuConfigCount(messages []protocol.ServerMessage) int {
	count := 0
	for _, message := range messages {
		if _, ok := message.(protocol.SfuConfigMessage); ok {
			count++
		}
	}
	return count
}

// waitFor ports vi.waitFor. With fake timers every check first ticks the
// clock by the 50 ms poll interval and the 1 s timeout allows 20 checks, as
// vitest 4.1 does; with real timers it polls.
func (h *routerHarness) waitFor(description string, condition func() bool) {
	h.t.Helper()
	if h.clock != nil {
		for check := 0; check < 20; check++ {
			h.clock.advance(50)
			if condition() {
				return
			}
		}
		h.t.Fatalf("timed out waiting for %s", description)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		if condition() {
			return
		}
		if time.Now().After(deadline) {
			h.t.Fatalf("timed out waiting for %s", description)
		}
		time.Sleep(time.Millisecond)
	}
}

func (h *routerHarness) waitPrepared(sessionID string) protocol.RouteUpdatePrepareMessage {
	h.t.Helper()
	return h.waitPreparedMatching(sessionID, "a prepare", func(protocol.RouteUpdatePrepareMessage) bool { return true })
}

func (h *routerHarness) waitPreparedTransport(sessionID, transport string) protocol.RouteUpdatePrepareMessage {
	h.t.Helper()
	return h.waitPreparedMatching(sessionID, transport+" prepare", func(prepared protocol.RouteUpdatePrepareMessage) bool {
		return prepared.Candidate.Transport == transport
	})
}

func (h *routerHarness) waitPreparedUpstream(sessionID string, upstream protocol.MediaRouteUpstream) protocol.RouteUpdatePrepareMessage {
	h.t.Helper()
	return h.waitPreparedMatching(sessionID, "a prepare with upstream "+upstream.Kind, func(prepared protocol.RouteUpdatePrepareMessage) bool {
		return prepared.Assignment.Upstream == upstream
	})
}

func (h *routerHarness) waitPreparedAbove(sessionID string, revision int64) protocol.RouteUpdatePrepareMessage {
	h.t.Helper()
	return h.waitPreparedMatching(sessionID, "a newer prepare", func(prepared protocol.RouteUpdatePrepareMessage) bool {
		return int64(prepared.Revision) > revision
	})
}

func (h *routerHarness) waitPreparedMatching(sessionID, description string, matches func(protocol.RouteUpdatePrepareMessage) bool) protocol.RouteUpdatePrepareMessage {
	h.t.Helper()
	var prepared protocol.RouteUpdatePrepareMessage
	h.waitFor(description+" for "+sessionID, func() bool {
		candidate, ok := h.preparedFor(sessionID)
		if ok && matches(candidate) {
			prepared = candidate
			return true
		}
		return false
	})
	return prepared
}

func (h *routerHarness) waitFailed(sessionID string) {
	h.t.Helper()
	h.waitFor("route-exhausted for "+sessionID, func() bool {
		status, ok := h.lastRouteStatus(sessionID)
		return ok && status.State == "failed" && status.Reason == "route-exhausted"
	})
}

func (h *routerHarness) waitUsage(want sfu.Usage) {
	h.t.Helper()
	h.waitFor("SFU usage to reach the expected value", func() bool { return h.usage() == want })
}

func (h *routerHarness) diagnostic(roomID string) protocol.RouteDiagnosticSnapshot {
	var snapshot protocol.RouteDiagnosticSnapshot
	h.locked(func() { snapshot = h.router.routeDiagnosticSnapshot(roomID) })
	return snapshot
}

func (h *routerHarness) usage() sfu.Usage {
	var usage sfu.Usage
	h.locked(func() { usage = h.admission.Usage() })
	return usage
}

// establishSfuRoom ports establishSfuRoom: a Host, a first Viewer moved to
// the SFU and a second Viewer joining it.
func (h *routerHarness) establishSfuRoom(created room.CreatedRoom) (host, first, second authenticatedRouteParticipant) {
	h.t.Helper()
	host = h.connectHost(created, nil, "", "")
	first = h.connectViewer(created, "sfu-root-"+created.RoomID)
	h.locked(func() {
		h.doComplete(host)
		h.doComplete(first)
	})
	firstDirect := h.waitPrepared(first.sessionID)
	second = h.connectViewer(created, "sfu-leaf-"+created.RoomID)
	h.locked(func() {
		h.doReady(first, int64(firstDirect.Revision))
		h.doComplete(second)
	})
	firstSfu := h.waitPreparedTransport(first.sessionID, "sfu")
	h.routeReady(first, int64(firstSfu.Revision))
	secondSfu := h.waitPreparedTransport(second.sessionID, "sfu")
	h.routeReady(second, int64(secondSfu.Revision))
	return host, first, second
}

// senderDiagnostics ports senderDiagnostics(state).
func senderDiagnostics(state string) protocol.SenderQualityDiagnostics {
	var reason *string
	switch state {
	case "healthy":
		value := "none"
		reason = &value
	case "degraded":
		value := "bandwidth"
		reason = &value
	}
	return protocol.SenderQualityDiagnostics{NatTraversalPath: "unknown", Reason: reason}
}

func senderEvidenceMessage(childPeerID, connectionID, rtpStatsID, trackIdentifier string, sampleTimestampMs float64, routeRevision int64, state string) protocol.SenderQualityEvidenceMessage {
	timestamp := protocol.Num(sampleTimestampMs)
	return protocol.SenderQualityEvidenceMessage{
		Type:              "sender-quality-evidence",
		ChildPeerID:       childPeerID,
		ConnectionID:      connectionID,
		RtpStatsID:        &rtpStatsID,
		TrackIdentifier:   &trackIdentifier,
		SampleTimestampMs: &timestamp,
		RouteRevision:     protocol.Int(routeRevision),
		State:             state,
		Diagnostics:       senderDiagnostics(state),
	}
}

type spyMedia struct {
	*sfutest.FakeMedia
	mu               sync.Mutex
	deleteCalls      int
	closePublication func(sfu.ResourceFence) error
}

func (media *spyMedia) ClosePublication(fence sfu.ResourceFence) error {
	media.mu.Lock()
	media.deleteCalls++
	override := media.closePublication
	media.mu.Unlock()
	if override != nil {
		return override(fence)
	}
	return media.FakeMedia.ClosePublication(fence)
}
func (media *spyMedia) counts() (int, int, int) {
	media.mu.Lock()
	defer media.mu.Unlock()
	return media.deleteCalls, 0, len(media.SubscriptionDrainAttempts())
}
func (media *spyMedia) setClosePublication(closePublication func(sfu.ResourceFence) error) {
	media.mu.Lock()
	defer media.mu.Unlock()
	media.closePublication = closePublication
}

func hasViewer(fences []sfu.SubscriptionFence, viewerPeerID string) bool {
	for _, fence := range fences {
		if fence.ViewerPeerID == viewerPeerID {
			return true
		}
	}
	return false
}

// manualClock is vi.useFakeTimers + vi.setSystemTime over sinon fake-timers:
// advance fires due timers in due order at their due time and lets the
// router settle after each (tickAsync); set jumps the clock and shifts every
// pending timer by the jump so none fires early (setSystemTime).
type manualClock struct {
	mu     sync.Mutex
	nowMs  int64
	seq    uint64
	timers []*manualTimer
	settle func()
}

type manualTimer struct {
	dueMs   int64
	seq     uint64
	fn      func()
	settled bool
}

func (c *manualClock) now() int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.nowMs
}

func (c *manualClock) set(ms int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	difference := ms - c.nowMs
	c.nowMs = ms
	for _, timer := range c.timers {
		timer.dueMs += difference
	}
}

func (c *manualClock) afterFunc(d time.Duration, fn func()) func() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	timer := &manualTimer{dueMs: c.nowMs + d.Milliseconds(), seq: c.seq, fn: fn}
	c.seq++
	c.timers = append(c.timers, timer)
	return func() bool {
		c.mu.Lock()
		defer c.mu.Unlock()
		if timer.settled {
			return false
		}
		timer.settled = true
		c.timers = slices.DeleteFunc(c.timers, func(candidate *manualTimer) bool { return candidate == timer })
		return true
	}
}

func (c *manualClock) advance(ms int64) {
	c.settle()
	c.mu.Lock()
	target := c.nowMs + ms
	c.mu.Unlock()
	for {
		c.mu.Lock()
		var next *manualTimer
		for _, timer := range c.timers {
			if timer.dueMs <= target && (next == nil || timer.dueMs < next.dueMs ||
				(timer.dueMs == next.dueMs && timer.seq < next.seq)) {
				next = timer
			}
		}
		if next == nil {
			c.nowMs = target
			c.mu.Unlock()
			c.settle()
			return
		}
		next.settled = true
		c.timers = slices.DeleteFunc(c.timers, func(candidate *manualTimer) bool { return candidate == next })
		c.nowMs = max(c.nowMs, next.dueMs)
		c.mu.Unlock()
		next.fn()
		c.settle()
	}
}

// debugRecorder is vi.spyOn(router, "debug"): a slog handler that records
// the sanitised route events while the debug flag is forced on.
type debugRecord struct {
	roomID  string
	event   string
	details map[string]any
}

type debugRecorder struct {
	mu      sync.Mutex
	records []debugRecord
}

func captureRouteDebug(t *testing.T) *debugRecorder {
	t.Helper()
	recorder := &debugRecorder{}
	previousLogger := slog.Default()
	t.Setenv("PIIK_DEBUG", "route")
	slog.SetDefault(slog.New(recorder))
	t.Cleanup(func() {
		slog.SetDefault(previousLogger)
	})
	return recorder
}

func (d *debugRecorder) Enabled(context.Context, slog.Level) bool { return true }

func (d *debugRecorder) Handle(_ context.Context, record slog.Record) error {
	if record.Message != "piik-route" {
		return nil
	}
	details := map[string]any{}
	record.Attrs(func(attr slog.Attr) bool {
		details[attr.Key] = normaliseAttr(attr.Value)
		return true
	})
	roomID, _ := details["roomId"].(string)
	event, _ := details["event"].(string)
	d.mu.Lock()
	defer d.mu.Unlock()
	d.records = append(d.records, debugRecord{roomID: roomID, event: event, details: details})
	return nil
}

func (d *debugRecorder) WithAttrs([]slog.Attr) slog.Handler { return d }
func (d *debugRecorder) WithGroup(string) slog.Handler      { return d }

// calledWith is expect(debug).toHaveBeenCalledWith(roomId, event,
// expect.objectContaining(expected)).
func (d *debugRecorder) calledWith(roomID, event string, expected map[string]any) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	for _, record := range d.records {
		if record.roomID != roomID || record.event != event {
			continue
		}
		matches := true
		for key, want := range expected {
			if got, ok := record.details[key]; !ok || !reflect.DeepEqual(got, want) {
				matches = false
				break
			}
		}
		if matches {
			return true
		}
	}
	return false
}

// normaliseAttr flattens slog values to string/int64/float64/bool/nil so the
// expectations can use plain literals.
func normaliseAttr(value slog.Value) any {
	switch value.Kind() {
	case slog.KindString:
		return value.String()
	case slog.KindInt64:
		return value.Int64()
	case slog.KindUint64:
		return int64(value.Uint64())
	case slog.KindFloat64:
		return value.Float64()
	case slog.KindBool:
		return value.Bool()
	case slog.KindAny:
		raw := value.Any()
		if raw == nil {
			return nil
		}
		reflected := reflect.ValueOf(raw)
		switch reflected.Kind() {
		case reflect.String:
			return reflected.String()
		case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
			return reflected.Int()
		case reflect.Float32, reflect.Float64:
			return reflected.Float()
		case reflect.Bool:
			return reflected.Bool()
		}
		return raw
	}
	return value.Any()
}

var qualityPolicy = &protocol.RoutePolicy{PeerOnly: false, TopologyOptimization: true, NatPrediction: false}

// prepareQualityConvergence ports the shared prefix of "commits P2P quality
// convergence after client relative approval": two Viewers on the Host, the
// second advertising relay capacity, and enough sender evidence for the
// controller to prepare a quality-convergence candidate for the first.
func prepareQualityConvergence(h *routerHarness, debug *debugRecorder) (created room.CreatedRoom, host, first, second authenticatedRouteParticipant, firstEdge activeViewerMediaEdge, qualityPrepare protocol.RouteUpdatePrepareMessage) {
	t := h.t
	t.Helper()
	created = h.createRoom()
	host = h.connectHost(created, qualityPolicy, "", "")
	first = h.connectViewer(created, "quality-first")
	h.locked(func() {
		h.doComplete(host)
		h.doComplete(first)
	})
	firstPrepare := h.waitPrepared(first.sessionID)
	if firstPrepare.Candidate.QualityProbe {
		t.Fatal("the join candidate must not be a quality probe")
	}
	second = h.connectViewer(created, "quality-second")
	h.locked(func() {
		h.doReady(first, int64(firstPrepare.Revision))
		h.doComplete(second)
	})
	secondPrepare := h.waitPrepared(second.sessionID)
	h.locked(func() {
		h.doReady(second, int64(secondPrepare.Revision))
		h.doRelay(second, 3)
		firstEdge = h.doMustEdge(created.RoomID, first.peerID)
		secondEdge := h.doMustEdge(created.RoomID, second.peerID)
		if firstEdge.upstream != protocol.PeerUpstream(host.peerID) || secondEdge.upstream != protocol.PeerUpstream(host.peerID) {
			t.Fatalf("both viewers must start on the host: %v %v", firstEdge.upstream, secondEdge.upstream)
		}
		if !h.router.observeSenderQualityEvidence(host, senderEvidenceMessage(second.peerID, secondEdge.connectionID, "second-rtp", "track", 100, secondEdge.revision, "healthy")) {
			t.Fatal("healthy evidence for the second viewer must be accepted")
		}
		if debug != nil && !debug.calledWith(created.RoomID, "sender-quality-evidence", map[string]any{
			"routeRevision": secondEdge.revision, "committedCopies": int64(2), "candidateReservedCopies": int64(0),
			"possibleCopies": int64(2), "endpointCapacity": int64(2), "operationReason": nil,
			"candidateTransition": nil, "sampleRole": "active",
		}) {
			t.Fatalf("active sender evidence debug context missing: %+v", debug.records)
		}
		if !h.router.observeSenderQualityEvidence(host, senderEvidenceMessage(first.peerID, firstEdge.connectionID, "first-rtp", "track", 100, firstEdge.revision, "healthy")) {
			t.Fatal("healthy evidence for the first viewer must be accepted")
		}
		for window := 0; window < 3; window++ {
			if !h.router.observeSenderQualityEvidence(host, senderEvidenceMessage(first.peerID, firstEdge.connectionID, "first-rtp", "track", float64(101+window), firstEdge.revision, "degraded")) {
				t.Fatal("degraded evidence must be accepted")
			}
		}
	})
	qualityPrepare = h.waitPreparedAbove(first.sessionID, firstEdge.revision)
	if !qualityPrepare.Candidate.QualityProbe {
		t.Fatal("the convergence candidate must be a quality probe")
	}
	h.locked(func() {
		if !h.router.observeSenderQualityEvidence(second, senderEvidenceMessage(first.peerID, qualityPrepare.Candidate.ConnectionID, "candidate-rtp", "track", 200, int64(qualityPrepare.Revision), "healthy")) {
			t.Fatal("candidate evidence must be accepted")
		}
		if debug != nil && !debug.calledWith(created.RoomID, "sender-quality-evidence", map[string]any{
			"routeRevision": int64(qualityPrepare.Revision), "committedCopies": int64(0), "candidateReservedCopies": int64(1),
			"possibleCopies": int64(1), "endpointCapacity": int64(2), "operationReason": "quality-convergence",
			"candidateTransition": "none", "sampleRole": "candidate",
		}) {
			t.Fatalf("candidate sender evidence debug context missing: %+v", debug.records)
		}
	})
	return created, host, first, second, firstEdge, qualityPrepare
}

// ---------------------------------------------------------------------------
// tests, in tests/hybrid-media-router.test.ts order
// ---------------------------------------------------------------------------

// TS: it.each([undefined, false, true]) with candidateReady mocked. Go cannot
// monkeypatch the controller and SettleResult.Committed collapses undefined
// and false, so the two representable outcomes come from a real
// quality-convergence candidate: ready without relative approval settles
// accepted-but-uncommitted, ready with approval commits.
func TestRouterPublishesConnectionIdentityOnlyForExplicitCommit(t *testing.T) {
	for _, committed := range []bool{false, true} {
		t.Run(map[bool]string{false: "uncommitted", true: "committed"}[committed], func(t *testing.T) {
			h := newRouterHarness(t, routerHarnessOptions{capacity: 2})
			created, _, first, _, firstEdge, qualityPrepare := prepareQualityConvergence(h, nil)
			var got string
			h.locked(func() {
				if committed {
					h.doReadyApproved(first, int64(qualityPrepare.Revision))
				} else {
					h.doReady(first, int64(qualityPrepare.Revision))
				}
				edge, _ := h.doEdge(created.RoomID, first.peerID)
				got = edge.connectionID
			})
			want := firstEdge.connectionID
			if committed {
				want = qualityPrepare.Candidate.ConnectionID
			}
			if got != want {
				t.Fatalf("connection identity = %q, want %q", got, want)
			}
		})
	}
}

func TestRouterLogsOnlyAggregateCandidateOriginForRouteSignals(t *testing.T) {
	debug := captureRouteDebug(t)
	h := newRouterHarness(t, routerHarnessOptions{capacity: 2})
	h.locked(func() {
		h.router.debugPeerSignal(peerSignalDebugInput{
			roomID:          "1234",
			sourcePeerID:    "source_12345678",
			targetPeerID:    "target_12345678",
			signalKind:      "candidate",
			candidateOrigin: protocol.CandidateOriginPredicted,
			authorization:   signalAuthorizationProbe,
		})
	})
	if !debug.calledWith("1234", "peer-signal", map[string]any{
		"candidateOrigin": "predicted", "signalKind": "candidate", "authorization": "probe",
	}) {
		t.Fatalf("peer-signal debug event missing: %+v", debug.records)
	}
	for _, record := range debug.records {
		for _, value := range record.details {
			if text, ok := value.(string); ok && (strings.Contains(text, "source_12345678") || strings.Contains(text, "target_12345678")) {
				t.Fatalf("raw peer id leaked into debug output: %+v", record.details)
			}
		}
	}
}

func TestRouterProjectsExactEndpointCopyContextFromCurrentSnapshot(t *testing.T) {
	h := newRouterHarness(t, routerHarnessOptions{capacity: 2})
	edge := func(parentPeerID, connectionID string) route.CommittedEdge {
		return route.CommittedEdge{
			Kind: route.UpstreamPeer, ChildSessionID: "child-session", ParentPeerID: parentPeerID,
			ParentSessionID: "parent-session", Transport: route.TransportDirect, ConnectionID: connectionID,
			Usable: true, PhysicalActive: true,
		}
	}
	edges := func(entries ...[3]string) *ordered.Map[string, route.CommittedEdge] {
		upstream := &ordered.Map[string, route.CommittedEdge]{}
		for _, entry := range entries {
			upstream.Set(entry[0], edge(entry[1], entry[2]))
		}
		return upstream
	}
	operation := func(tuple route.CandidateTuple, transition route.EndpointTransition) *route.OperationSnapshot {
		return &route.OperationSnapshot{
			ChildPeerID: "candidate", ChildSessionID: "candidate-session", DemandPeerID: "candidate",
			Reason: route.DemandQualityConvergence, BaseRevision: 7, FactVersion: 1,
			Candidates: []route.CandidatePlan{{Tuple: tuple, EndpointTransition: transition}},
			Cursor:     0, DeadlineAtMs: 20_000, WakeAtMs: 20_000,
			Current: &route.CurrentAttempt{Tuple: tuple, Revision: 8, ConnectionID: "candidate-connection"},
		}
	}
	snapshot := func(upstream *ordered.Map[string, route.CommittedEdge], op *route.OperationSnapshot, publication *route.HostPublication) route.RouteSnapshot {
		return route.RouteSnapshot{Revision: 7, FactVersion: 1, UpstreamByViewer: upstream, HostPublication: publication, Operation: op}
	}
	project := func(state route.RouteSnapshot, observedPeerID string, endpointCapacity int, sample qualitySample) qualityCopyContext {
		var context qualityCopyContext
		h.locked(func() { context = h.router.qualityCopyContext(state, "host", observedPeerID, endpointCapacity, sample) })
		return context
	}
	hostProducer := "host"
	overlap := route.EndpointTransition{Kind: route.TransitionOverlap, ProducerPeerID: &hostProducer}
	none := route.EndpointTransition{Kind: route.TransitionNone}
	hostEdges := edges([3]string{"a", "host", "a-connection"}, [3]string{"b", "host", "b-connection"})
	peerCandidate := route.CandidateTuple{Kind: route.UpstreamPeer, ParentPeerID: "host", Transport: route.TransportDirect}
	sfuSample := qualitySample{kind: route.UpstreamSfu, routeRevision: 8, publicationGeneration: "publication", hostSessionID: "host-session"}
	publication := &route.HostPublication{
		Generation: "publication", HostSessionID: "host-session", ConnectionID: "publication-connection",
		Usable: true, PhysicalActive: true, Resource: &route.Resource{},
	}

	got := project(snapshot(hostEdges, operation(peerCandidate, overlap), nil), "host", 2,
		qualitySample{kind: route.UpstreamPeer, childPeerID: "candidate", routeRevision: 8, connectionID: "candidate-connection"})
	want := qualityCopyContext{
		committedCopies: 2, candidateReservedCopies: 1, possibleCopies: 3, endpointCapacity: 2,
		operationReason: route.DemandQualityConvergence, candidateTransition: route.TransitionOverlap, sampleRole: "candidate",
	}
	if got != want {
		t.Fatalf("peer candidate context = %+v, want %+v", got, want)
	}

	oneHostEdge := edges([3]string{"a", "host", "a-connection"})
	sfuCases := []struct {
		state    route.RouteSnapshot
		expected qualityCopyContext
	}{
		{
			state: snapshot(hostEdges, operation(route.CandidateTuple{Kind: route.UpstreamSfu, Publication: route.PublicationCreate}, overlap), nil),
			expected: qualityCopyContext{committedCopies: 2, candidateReservedCopies: 1, possibleCopies: 3,
				candidateTransition: route.TransitionOverlap},
		},
		{
			state: snapshot(oneHostEdge, operation(route.CandidateTuple{Kind: route.UpstreamSfu, Publication: route.PublicationReuse}, none), publication),
			expected: qualityCopyContext{committedCopies: 2, candidateReservedCopies: 0, possibleCopies: 2,
				candidateTransition: route.TransitionNone},
		},
	}
	for index, testCase := range sfuCases {
		got := project(testCase.state, "host", 2, sfuSample)
		if got.committedCopies != testCase.expected.committedCopies ||
			got.candidateReservedCopies != testCase.expected.candidateReservedCopies ||
			got.possibleCopies != testCase.expected.possibleCopies ||
			got.candidateTransition != testCase.expected.candidateTransition ||
			got.sampleRole != "candidate" {
			t.Fatalf("sfu case %d = %+v, want %+v (candidate)", index, got, testCase.expected)
		}
	}

	relayEdges := edges([3]string{"a", "relay", "relay-a"}, [3]string{"b", "relay", "relay-b"})
	relaySample := qualitySample{kind: route.UpstreamPeer, childPeerID: "a", routeRevision: 7, connectionID: "relay-a"}
	got = project(snapshot(relayEdges, nil, nil), "relay", 3, relaySample)
	if got.committedCopies != 2 || got.candidateReservedCopies != 0 || got.possibleCopies != 2 ||
		got.endpointCapacity != 3 || got.sampleRole != "active" {
		t.Fatalf("relay context = %+v", got)
	}
	stale := relaySample
	stale.routeRevision = 6
	if got := project(snapshot(relayEdges, nil, nil), "relay", 3, stale); got.sampleRole != "unknown" {
		t.Fatalf("stale relay sample role = %q, want unknown", got.sampleRole)
	}
}

func TestRouterKeepsControllerDiagnosticLabelUntilDepartedRelayIsPruned(t *testing.T) {
	h := newRouterHarness(t, routerHarnessOptions{capacity: 2})
	created := h.createRoom()
	host := h.connectHost(created, nil, "", "")
	parent := h.connectViewer(created, "diagnostic-label-parent")
	h.locked(func() {
		h.doComplete(host)
		h.doComplete(parent)
	})
	parentPrepare := h.waitPrepared(parent.sessionID)
	temporaryRoot := h.connectViewer(created, "diagnostic-label-temporary-root")
	h.locked(func() {
		h.doReady(parent, int64(parentPrepare.Revision))
		h.doRelay(parent, 1)
		h.doComplete(temporaryRoot)
	})
	temporaryPrepare := h.waitPreparedUpstream(temporaryRoot.sessionID, protocol.PeerUpstream(host.peerID))
	child := h.connectViewer(created, "diagnostic-label-child")
	h.locked(func() {
		h.doReady(temporaryRoot, int64(temporaryPrepare.Revision))
		h.doComplete(child)
	})
	childPrepare := h.waitPreparedUpstream(child.sessionID, protocol.PeerUpstream(parent.peerID))
	h.locked(func() {
		h.doReady(child, int64(childPrepare.Revision))
		h.doDisconnect(temporaryRoot)
		h.router.removeViewer(created.RoomID, temporaryRoot.peerID)
	})
	h.waitFor("the temporary root to lose its edge", func() bool {
		_, ok := h.activeEdge(created.RoomID, temporaryRoot.peerID)
		return !ok
	})

	debugPeer := func(peerID string) string {
		var label string
		h.locked(func() { label = h.router.debugPeer(created.RoomID, peerID) })
		return label
	}
	h.locked(func() {
		label := h.router.debugPeer(created.RoomID, parent.peerID)
		h.doDisconnect(parent)
		h.router.removeViewer(created.RoomID, parent.peerID)
		if got := h.router.debugPeer(created.RoomID, parent.peerID); got != label {
			t.Fatalf("label after departure = %q, want %q", got, label)
		}
	})

	recovery := h.waitPreparedMatching(child.sessionID, "a recovery onto the host", func(prepared protocol.RouteUpdatePrepareMessage) bool {
		return int64(prepared.Revision) > int64(childPrepare.Revision) &&
			prepared.Assignment.Upstream == protocol.PeerUpstream(host.peerID)
	})
	h.routeReady(child, int64(recovery.Revision))
	h.waitFor("the departed relay to be pruned", func() bool { return debugPeer(parent.peerID) == "viewer-unknown" })
}

func TestRouterMapsExactHostActiveFailureToCommittedDirectEdge(t *testing.T) {
	h := newRouterHarness(t, routerHarnessOptions{capacity: 2})
	created := h.createRoom()
	host := h.connectHost(created, nil, "", "")
	viewer := h.connectViewer(created, "host-edge-failure")
	h.locked(func() {
		h.doComplete(host)
		h.doComplete(viewer)
	})
	prepared := h.waitPrepared(viewer.sessionID)
	h.locked(func() {
		h.doReady(viewer, int64(prepared.Revision))
		active := h.doMustEdge(created.RoomID, viewer.peerID)
		h.doFailed(host, routeFailedMessage(active.revision, "active", active.connectionID))
	})
	h.waitFailed(viewer.sessionID)
}

func TestRouterRebindsReplacementHostAndClearsOfflineViewerMediaOwnership(t *testing.T) {
	h := newRouterHarness(t, routerHarnessOptions{capacity: 2})
	created := h.createRoom()
	previousHost := h.connectHost(created, nil, "", "")
	viewer := h.connectViewer(created, "host-rebind-offline-viewer")
	h.locked(func() {
		h.doComplete(previousHost)
		h.doComplete(viewer)
	})
	prepared := h.waitPrepared(viewer.sessionID)
	h.locked(func() {
		h.doReady(viewer, int64(prepared.Revision))
		h.doRelay(viewer, 1)
	})
	h.waitFor("the viewer connection identity", func() bool {
		_, ok := h.activeEdge(created.RoomID, viewer.peerID)
		return ok
	})

	h.locked(func() {
		h.doDisconnect(viewer)
		h.doDisconnect(previousHost)
	})
	resumedHost := h.connectHost(created, nil, "replacement-host-client", "replacement-host-session")
	if resumedHost.peerID == previousHost.peerID {
		t.Fatal("a replacement client must receive a new host peer id")
	}
	h.locked(func() {
		h.doComplete(resumedHost)
		if _, ok := h.doEdge(created.RoomID, viewer.peerID); ok {
			t.Fatal("the offline viewer must lose its media ownership")
		}
	})
	reconnectedViewer := h.connectViewer(created, "host-rebind-offline-viewer")
	if reconnectedViewer.peerID != viewer.peerID {
		t.Fatal("the same client must keep its viewer peer id")
	}
	h.locked(func() {
		h.router.connectParticipant(reconnectedViewer)
		found := false
		for _, child := range h.router.routeDiagnosticSnapshot(created.RoomID).Children {
			if child.EffectiveCapacity == 1 {
				found = true
			}
		}
		if !found {
			t.Fatal("the reconnected viewer must keep its advertised capacity")
		}
	})
}

func TestRouterAcceptsActiveFailureForDirectConnectionAdoptedDuringRebuild(t *testing.T) {
	h := newRouterHarness(t, routerHarnessOptions{capacity: 2})
	created := h.createRoom()
	host := h.connectHost(created, nil, "", "")
	viewer := h.connectViewer(created, "rebuilt-edge-failure")
	h.locked(func() {
		h.doComplete(host)
		h.doComplete(viewer)
	})
	prepared := h.waitPrepared(viewer.sessionID)
	h.locked(func() {
		h.doReady(viewer, int64(prepared.Revision))
		active := h.doMustEdge(created.RoomID, viewer.peerID)
		rebuiltConnectionID := "rebuilt_connection_12345678"
		authorization := h.router.peerSignalAuthorization(peerSignalInput{
			roomID: created.RoomID, sourcePeerID: host.peerID, sourceSessionID: host.sessionID,
			targetPeerID: viewer.peerID, targetSessionID: viewer.sessionID, connectionID: rebuiltConnectionID,
			signalKind: "description", descriptionType: "offer",
		})
		if authorization != signalAuthorizationAllowed {
			t.Fatalf("adoption authorization = %v, want allowed", authorization)
		}
		adopted := h.doMustEdge(created.RoomID, viewer.peerID)
		if adopted.revision != active.revision || adopted.connectionID != rebuiltConnectionID {
			t.Fatalf("adopted edge = %+v", adopted)
		}
		h.doFailed(viewer, routeFailedMessage(active.revision, "active", active.connectionID))
		rm, _ := h.router.rooms.Get(created.RoomID)
		edge, ok := rm.controller.Snapshot().UpstreamByViewer.Get(viewer.peerID)
		if !ok || !edge.Usable || edge.ConnectionID != rebuiltConnectionID {
			t.Fatal("retired-connection failure affected its replacement")
		}
		h.doFailed(viewer, routeFailedMessage(active.revision, "active", rebuiltConnectionID))
	})
	h.waitFailed(viewer.sessionID)
}

func TestRouterKeepsCommittedEdgeSignalingAuthorizedDuringAnotherPeerCandidate(t *testing.T) {
	h := newRouterHarness(t, routerHarnessOptions{capacity: 2})
	created := h.createRoom()
	host := h.connectHost(created, nil, "", "")
	h.complete(host)

	roots := []authenticatedRouteParticipant{
		h.connectViewer(created, "stable-root-a"),
		h.connectViewer(created, "stable-root-b"),
	}
	// TS: for each root, complete then await; the ready + capacity of one
	// root share the tick with the next root's complete.
	var pending func()
	for _, root := range roots {
		h.locked(func() {
			if pending != nil {
				pending()
			}
			h.doComplete(root)
		})
		prepared := h.waitPrepared(root.sessionID)
		pending = func() {
			h.doReady(root, int64(prepared.Revision))
			h.doRelay(root, 1)
		}
	}

	candidateChild := h.connectViewer(created, "candidate-child")
	h.locked(func() {
		pending()
		h.doComplete(candidateChild)
	})
	prepared := h.waitPreparedMatching(candidateChild.sessionID, "a peer candidate", func(prepared protocol.RouteUpdatePrepareMessage) bool {
		return prepared.Assignment.Upstream.Kind == "peer"
	})
	var candidateParent, unrelatedRoot authenticatedRouteParticipant
	for _, root := range roots {
		if root.peerID == prepared.Assignment.Upstream.PeerID {
			candidateParent = root
		} else {
			unrelatedRoot = root
		}
	}

	h.locked(func() {
		activeParentEdge := h.doMustEdge(created.RoomID, candidateParent.peerID)
		authorize := func(input peerSignalInput) signalAuthorization {
			input.roomID = created.RoomID
			input.signalKind = "description"
			input.descriptionType = "offer"
			return h.router.peerSignalAuthorization(input)
		}
		if got := authorize(peerSignalInput{
			sourcePeerID: host.peerID, sourceSessionID: host.sessionID,
			targetPeerID: candidateParent.peerID, targetSessionID: candidateParent.sessionID,
			connectionID: activeParentEdge.connectionID,
		}); got != signalAuthorizationAllowed {
			t.Fatalf("committed edge authorization = %v, want allowed", got)
		}
		if got := authorize(peerSignalInput{
			sourcePeerID: candidateParent.peerID, sourceSessionID: candidateParent.sessionID,
			targetPeerID: candidateChild.peerID, targetSessionID: candidateChild.sessionID,
			connectionID: prepared.Candidate.ConnectionID,
		}); got != signalAuthorizationProbe {
			t.Fatalf("candidate authorization = %v, want probe", got)
		}
		if got := authorize(peerSignalInput{
			sourcePeerID: unrelatedRoot.peerID, sourceSessionID: unrelatedRoot.sessionID,
			targetPeerID: candidateChild.peerID, targetSessionID: candidateChild.sessionID,
			connectionID: prepared.Candidate.ConnectionID,
		}); got != signalAuthorizationUnassigned {
			t.Fatalf("unrelated authorization = %v, want unassigned", got)
		}
	})
}

func TestRouterCommitsP2PQualityConvergenceAfterClientRelativeApproval(t *testing.T) {
	debug := captureRouteDebug(t)
	h := newRouterHarness(t, routerHarnessOptions{capacity: 2})
	created, host, first, second, _, qualityPrepare := prepareQualityConvergence(h, debug)
	h.locked(func() {
		h.doReady(first, int64(qualityPrepare.Revision))
		if edge := h.doMustEdge(created.RoomID, first.peerID); edge.upstream != protocol.PeerUpstream(host.peerID) {
			t.Fatalf("upstream before approval = %v, want the host", edge.upstream)
		}
		h.doReadyApproved(first, int64(qualityPrepare.Revision))
		if edge := h.doMustEdge(created.RoomID, first.peerID); edge.upstream != protocol.PeerUpstream(second.peerID) {
			t.Fatalf("upstream after approval = %v, want the second viewer", edge.upstream)
		}
	})
}

func TestRouterPreparesSameParentConnectionRegenerationAfterPersistentDegradation(t *testing.T) {
	h := newRouterHarness(t, routerHarnessOptions{capacity: 2})
	created := h.createRoom()
	host := h.connectHost(created, qualityPolicy, "", "")
	viewer := h.connectViewer(created, "quality-regeneration")
	h.locked(func() {
		h.doComplete(host)
		h.doComplete(viewer)
	})
	initial := h.waitPrepared(viewer.sessionID)
	if initial.Assignment.Upstream != protocol.PeerUpstream(host.peerID) {
		t.Fatalf("initial upstream = %v", initial.Assignment.Upstream)
	}
	var edge activeViewerMediaEdge
	h.locked(func() {
		h.doReady(viewer, int64(initial.Revision))
		edge = h.doMustEdge(created.RoomID, viewer.peerID)
		h.router.observeSenderQualityEvidence(host, senderEvidenceMessage(viewer.peerID, edge.connectionID, "old-sender-rtp", "old-track", 100, edge.revision, "healthy"))
		for _, sampleTimestampMs := range []float64{101, 102, 103} {
			h.router.observeSenderQualityEvidence(host, senderEvidenceMessage(viewer.peerID, edge.connectionID, "old-sender-rtp", "old-track", sampleTimestampMs, edge.revision, "degraded"))
		}
	})

	regeneration := h.waitPreparedAbove(viewer.sessionID, edge.revision)
	if regeneration.Candidate.Transport != "direct" || !regeneration.Candidate.QualityProbe {
		t.Fatalf("regeneration candidate = %+v", regeneration.Candidate)
	}
	if regeneration.Assignment.Upstream != protocol.PeerUpstream(host.peerID) {
		t.Fatalf("regeneration upstream = %v", regeneration.Assignment.Upstream)
	}
	if hostPrepare, ok := h.preparedFor(host.sessionID); !ok || hostPrepare.Candidate.ConnectionID != regeneration.Candidate.ConnectionID {
		t.Fatal("the host must receive the same regeneration candidate")
	}
	if active := h.mustActiveEdge(created.RoomID, viewer.peerID); active.connectionID != edge.connectionID ||
		active.upstream != protocol.PeerUpstream(host.peerID) {
		t.Fatalf("active edge during regeneration = %+v", active)
	}
}

func TestRouterCreatesNatRetriesThroughRealPrepareMessages(t *testing.T) {
	for _, withSfu := range []bool{false, true} {
		t.Run(map[bool]string{false: "sfu=false", true: "sfu=true"}[withSfu], func(t *testing.T) {
			h := newRouterHarness(t, routerHarnessOptions{capacity: 2, withSfu: withSfu})
			created := h.createRoom()
			host := h.connectHost(created, &protocol.RoutePolicy{PeerOnly: true, TopologyOptimization: false, NatPrediction: true}, "", "")
			viewer := h.connectViewer(created, "nat-retry")
			h.locked(func() {
				h.doComplete(host)
				h.doComplete(viewer)
			})
			connectionIDs := map[string]struct{}{}
			var staleFailure *protocol.RouteFailedMessage
			for current := 1; current <= 4; current++ {
				prepared := h.waitPreparedMatching(viewer.sessionID, "connection attempt", func(prepared protocol.RouteUpdatePrepareMessage) bool {
					return prepared.Candidate.ConnectionAttempt != nil &&
						*prepared.Candidate.ConnectionAttempt == protocol.ConnectionAttempt{Current: protocol.Int(current), Total: 4}
				})
				connectionIDs[prepared.Candidate.ConnectionID] = struct{}{}
				h.locked(func() {
					if hostPrepare, ok := lastPrepare(h.sent[host.sessionID], ""); !ok || !reflect.DeepEqual(hostPrepare.Candidate, prepared.Candidate) {
						t.Fatal("the host must see the same candidate")
					}
					if staleFailure != nil {
						h.doFailed(viewer, *staleFailure)
					}
					if again, _ := lastPrepare(h.sent[viewer.sessionID], ""); again.Candidate.ConnectionID != prepared.Candidate.ConnectionID {
						t.Fatal("a stale failure must not disturb the current candidate")
					}
					if current == 4 {
						h.doReady(viewer, int64(prepared.Revision))
						if active := h.doMustEdge(created.RoomID, viewer.peerID); active.connectionID != prepared.Candidate.ConnectionID {
							t.Fatalf("active edge = %+v", active)
						}
					} else {
						failure := routeFailedMessage(int64(prepared.Revision), "prepare", prepared.Candidate.ConnectionID)
						staleFailure = &failure
						h.doFailed(viewer, failure)
						h.doFailed(host, failure)
					}
				})
			}
			if len(connectionIDs) != 4 {
				t.Fatalf("distinct connection ids = %d, want 4", len(connectionIDs))
			}
			for _, message := range h.allMessages() {
				switch typed := message.(type) {
				case protocol.SfuConfigMessage:
					t.Fatal("peer-only media must not receive an sfu-config")
				case protocol.RouteStatusMessage:
					if typed.State == "failed" {
						t.Fatal("NAT retries must not report failure")
					}
				}
			}
		})
	}
}

func TestRouterKeepsPeerOnlySharesOutOfConfiguredSfuFallback(t *testing.T) {
	h := newRouterHarness(t, routerHarnessOptions{capacity: 1, withSfu: true})
	created := h.createRoom()
	host := h.connectHost(created, &protocol.RoutePolicy{PeerOnly: true}, "", "")
	first := h.connectViewer(created, "peer-only-first")
	h.locked(func() {
		h.doComplete(host)
		h.doComplete(first)
	})
	direct := h.waitPreparedTransport(first.sessionID, "direct")
	blocked := h.connectViewer(created, "peer-only-blocked")
	h.locked(func() {
		h.doReady(first, int64(direct.Revision))
		h.doComplete(blocked)
	})
	h.waitFailed(blocked.sessionID)
	if sfuConfigCount(h.allMessages()) != 0 {
		t.Fatal("peer-only shares must never receive an sfu-config")
	}
}

func TestRouterSilentlyKeepsWorkingMediaWhenQualityOnlySfuAdmissionIsDenied(t *testing.T) {
	debug := captureRouteDebug(t)
	h := newRouterHarness(t, routerHarnessOptions{capacity: 2, withSfu: true, sfuIngressCapacity: 1})
	occupied := sfu.ResourceFence{RoomID: "9001", ShareGeneration: "occupied_share_12345678", PublicationGeneration: "occupied_publication_12345678"}
	created := h.createRoom()
	host := h.connectHost(created, qualityPolicy, "", "")
	h.locked(func() {
		if !h.admission.ReservePublication(occupied) {
			t.Fatal("the occupying publication must be reserved")
		}
		h.doComplete(host)
	})
	viewers := []authenticatedRouteParticipant{
		h.connectViewer(created, "quality-sfu-denied-first"),
		h.connectViewer(created, "quality-sfu-denied-second"),
	}
	active := make([]activeViewerMediaEdge, len(viewers))
	for index, viewer := range viewers {
		h.complete(viewer)
		prepared := h.waitPrepared(viewer.sessionID)
		h.routeReady(viewer, int64(prepared.Revision))
		active[index] = h.mustActiveEdge(created.RoomID, viewer.peerID)
	}
	degrade := func(viewer authenticatedRouteParticipant) {
		h.locked(func() {
			edge := h.doMustEdge(created.RoomID, viewer.peerID)
			for index, state := range []string{"healthy", "degraded", "degraded", "degraded"} {
				if !h.router.observeSenderQualityEvidence(host, senderEvidenceMessage(viewer.peerID, edge.connectionID, "viewer-rtp", "track", float64(100+index), edge.revision, state)) {
					t.Fatalf("%s evidence must be accepted", state)
				}
			}
		})
	}
	// SFU relief requires every Host root to be persistently degraded. Exhaust
	// the second root's regeneration before the first makes SFU eligible.
	degrade(viewers[1])
	regeneration := h.waitPreparedAbove(viewers[1].sessionID, active[1].revision)
	h.routeFailed(viewers[1], routeFailedMessage(int64(regeneration.Revision), "prepare", regeneration.Candidate.ConnectionID))
	h.settle()
	degrade(viewers[0])
	h.waitFor("the quality-only SFU admission rejection", func() bool {
		return debug.calledWith(created.RoomID, "candidate-preparation-denied", map[string]any{"rejectionBucket": "sfu-admission"})
	})
	h.settle()
	for index, viewer := range viewers {
		for _, message := range h.messages(viewer.sessionID) {
			if _, ok := message.(protocol.RouteStatusMessage); ok {
				t.Fatal("a denied quality-only candidate must stay silent")
			}
		}
		if edge := h.mustActiveEdge(created.RoomID, viewer.peerID); edge.connectionID != active[index].connectionID ||
			edge.upstream != protocol.PeerUpstream(host.peerID) {
			t.Fatalf("working media changed: %+v", edge)
		}
	}
	h.locked(func() {
		h.admission.BeginDrain(occupied)
		h.admission.CompleteDrain(occupied)
	})
}

func TestRouterNotifiesPresenceOwnerAfterCommittedGraphChanges(t *testing.T) {
	h := newRouterHarness(t, routerHarnessOptions{capacity: 1, withSfu: true})
	created := h.createRoom()
	h.establishSfuRoom(created)
	h.waitFor("the last routesChanged call", func() bool {
		var last string
		h.locked(func() {
			if len(h.routesChanged) > 0 {
				last = h.routesChanged[len(h.routesChanged)-1]
			}
		})
		return last == created.RoomID
	})
}

func TestRouterWakesAtDerivedDirectBoundaryAndPreparesSfuAutomatically(t *testing.T) {
	h := newRouterHarness(t, routerHarnessOptions{capacity: 2, withSfu: true, prepareTimeoutMs: 300, fakeTimers: true})
	created := h.createRoom()
	host := h.connectHost(created, nil, "", "")
	viewer := h.connectViewer(created, "staged-deadline")
	h.locked(func() {
		h.doComplete(host)
		h.doComplete(viewer)
	})

	h.waitPreparedTransport(viewer.sessionID, "direct")
	h.clock.advance(150)
	h.waitPreparedTransport(viewer.sessionID, "sfu")
	if h.hasRouteStatus(viewer.sessionID, "failed") {
		t.Fatal("the direct boundary must not report failure")
	}
}

func TestRouterRelayPreparationFailureAdvancesWithoutWaitingForDeadline(t *testing.T) {
	h := newRouterHarness(t, routerHarnessOptions{capacity: 2, withSfu: true, fakeTimers: true})
	created := h.createRoom()
	host := h.connectHost(created, nil, "", "")
	relay := h.connectViewer(created, "relay")
	h.locked(func() {
		h.doComplete(host)
		h.doComplete(relay)
	})
	h.settle()
	root, ok := h.preparedFor(relay.sessionID)
	if !ok {
		t.Fatal("relay must prepare its Host upstream")
	}
	h.locked(func() {
		h.doReady(relay, int64(root.Revision))
		h.doRelay(relay, 2)
	})
	child := h.connectViewer(created, "child")
	h.complete(child)
	h.settle()
	direct, ok := h.preparedFor(child.sessionID)
	if !ok || direct.Assignment.Upstream != protocol.PeerUpstream(host.peerID) {
		t.Fatal("child must try the Host first")
	}
	h.routeFailed(host, routeFailedMessage(int64(direct.Revision), "prepare", direct.Candidate.ConnectionID))
	h.settle()
	prepared, ok := h.preparedFor(child.sessionID)
	if !ok || prepared.Assignment.Upstream != protocol.PeerUpstream(relay.peerID) {
		t.Fatal("child must next try the relay")
	}
	failure := routeFailedMessage(int64(prepared.Revision), "prepare", prepared.Candidate.ConnectionID)
	h.routeFailed(relay, failure)
	h.settle()
	fallback, ok := h.preparedFor(child.sessionID)
	if !ok || fallback.Candidate.Transport != "sfu" || fallback.Revision <= prepared.Revision {
		t.Fatalf("relay rejection must prepare SFU immediately: %+v", fallback)
	}
	h.routeFailed(relay, failure)
	h.settle()
	current, _ := h.preparedFor(child.sessionID)
	if current.Candidate.ConnectionID != fallback.Candidate.ConnectionID {
		t.Fatal("duplicate relay failure disturbed the next candidate")
	}
	if h.clock.now() != 0 {
		t.Fatal("preparation failure must advance without a timer wake")
	}
	if retained := h.mustActiveEdge(created.RoomID, relay.peerID); retained.connectionID != root.Candidate.ConnectionID {
		t.Fatal("relay preparation failure disturbed its active upstream")
	}
}

func TestRouterKeepsExactTransportConnectedDirectCandidatePastBoundary(t *testing.T) {
	h := newRouterHarness(t, routerHarnessOptions{capacity: 2, withSfu: true, prepareTimeoutMs: 300, fakeTimers: true})
	created := h.createRoom()
	host := h.connectHost(created, nil, "", "")
	viewer := h.connectViewer(created, "transport-connected")
	h.locked(func() {
		h.doComplete(host)
		h.doComplete(viewer)
	})
	direct := h.waitPreparedTransport(viewer.sessionID, "direct")
	h.locked(func() {
		h.router.handleRouteTransportConnected(viewer, protocol.RouteTransportConnectedMessage{
			Type: "route-transport-connected", Revision: direct.Revision, ConnectionID: direct.Candidate.ConnectionID})
	})
	h.clock.advance(150)
	if prepared, _ := h.preparedFor(viewer.sessionID); !reflect.DeepEqual(prepared, direct) {
		t.Fatalf("prepare after the boundary = %+v, want the direct candidate", prepared)
	}
	h.routeReady(viewer, int64(direct.Revision))
	h.waitFor("the active direct edge", func() bool {
		active, ok := h.activeAfter(viewer.sessionID, int64(direct.Revision)-1)
		return ok && active.Assignment.Upstream.Kind == "peer"
	})
}

func TestRouterAcceptsExactParentProgressWithoutGrantingReadiness(t *testing.T) {
	for _, relayParent := range []bool{false, true} {
		t.Run(fmt.Sprintf("relay=%v", relayParent), func(t *testing.T) {
			h := newRouterHarness(t, routerHarnessOptions{capacity: 2, withSfu: true, prepareTimeoutMs: 300, fakeTimers: true})
			created := h.createRoom()
			host := h.connectHost(created, nil, "", "")
			h.locked(func() { h.doComplete(host) })
			parents := map[string]authenticatedRouteParticipant{host.peerID: host}
			if relayParent {
				for _, name := range []string{"root-a", "root-b"} {
					root := h.connectViewer(created, name)
					h.locked(func() { h.doComplete(root) })
					prepared := h.waitPreparedTransport(root.sessionID, "direct")
					h.routeReady(root, int64(prepared.Revision))
					h.locked(func() { h.doRelay(root, 2) })
					parents[root.peerID] = root
				}
			}
			viewer := h.connectViewer(created, "delayed-feedback")
			h.locked(func() { h.doComplete(viewer) })
			direct := h.waitPreparedTransport(viewer.sessionID, "direct")
			h.locked(func() {
				rm, _ := h.router.rooms.Get(created.RoomID)
				before := rm.controller.Operation()
				parent := parents[before.Current.Tuple.ParentPeerID]
				if (parent.role == protocol.RoleViewer) != relayParent {
					t.Fatal("unexpected preparing parent")
				}
				message := protocol.RouteTransportConnectedMessage{Type: "route-transport-connected", Revision: direct.Revision, ConnectionID: direct.Candidate.ConnectionID}
				stale := parent
				stale.sessionID = "retired-session"
				h.router.handleRouteTransportConnected(stale, message)
				foreign := parent
				foreign.peerID = "unrelated-peer"
				h.router.handleRouteTransportConnected(foreign, message)
				wrong := message
				wrong.ConnectionID = "retired-connection"
				h.router.handleRouteTransportConnected(parent, wrong)
				wrong = message
				wrong.Revision++
				h.router.handleRouteTransportConnected(parent, wrong)
				if rm.controller.Operation().WakeAtMs != before.WakeAtMs {
					t.Fatal("unrelated progress changed candidate timing")
				}
				h.router.handleRouteTransportConnected(parent, message)
				after := rm.controller.Operation()
				if after == nil || after.DeadlineAtMs != before.DeadlineAtMs || after.WakeAtMs != before.DeadlineAtMs {
					t.Fatal("parent progress did not retain the original total deadline")
				}
				h.doReady(parent, int64(direct.Revision))
				if rm.controller.Operation() == nil {
					t.Fatal("parent committed a route without Viewer readiness")
				}
			})
			h.clock.advance(150)
			if prepared, _ := h.preparedFor(viewer.sessionID); !reflect.DeepEqual(prepared, direct) {
				t.Fatal("connected candidate was replaced before delayed Viewer readiness")
			}
			h.routeReady(viewer, int64(direct.Revision))
			h.waitFor("the active peer edge", func() bool {
				active, ok := h.activeAfter(viewer.sessionID, int64(direct.Revision)-1)
				return ok && active.Assignment.Upstream.Kind == "peer"
			})
		})
	}
}

func TestRouterUsesDirectBoundaryToBootstrapSfuWhenEveryHostSlotIsFull(t *testing.T) {
	h := newRouterHarness(t, routerHarnessOptions{capacity: 2, withSfu: true, prepareTimeoutMs: 300, fakeTimers: true})
	created := h.createRoom()
	host := h.connectHost(created, nil, "", "")
	firstRoot := h.connectViewer(created, "first-root")
	h.locked(func() {
		h.doComplete(host)
		h.doComplete(firstRoot)
	})
	firstPrepare := h.waitPreparedTransport(firstRoot.sessionID, "direct")
	secondRoot := h.connectViewer(created, "second-root")
	h.locked(func() {
		h.doReady(firstRoot, int64(firstPrepare.Revision))
		h.doRelay(firstRoot, 2)
		h.doComplete(secondRoot)
	})
	secondPrepare := h.waitPreparedTransport(secondRoot.sessionID, "direct")
	waiting := h.connectViewer(created, "waiting")
	h.locked(func() {
		h.doReady(secondRoot, int64(secondPrepare.Revision))
		h.doComplete(waiting)
	})
	h.waitPreparedTransport(waiting.sessionID, "direct")

	h.clock.advance(150)
	secondBootstrap := h.waitPreparedTransport(secondRoot.sessionID, "sfu")
	h.routeFailed(secondRoot, routeFailedMessage(int64(secondBootstrap.Revision), "prepare", secondBootstrap.Candidate.ConnectionID))
	firstBootstrap := h.waitPreparedTransport(firstRoot.sessionID, "sfu")
	if h.hasRouteStatus(secondRoot.sessionID, "failed") {
		t.Fatal("a failed carrier bootstrap must not fail the carrier")
	}
	h.routeFailed(firstRoot, routeFailedMessage(int64(firstBootstrap.Revision), "prepare", firstBootstrap.Candidate.ConnectionID))
	h.waitFailed(waiting.sessionID)
	for _, root := range []authenticatedRouteParticipant{firstRoot, secondRoot} {
		if h.hasRouteStatus(root.sessionID, "failed") {
			t.Fatal("roots must not be told about the waiting viewer's exhaustion")
		}
	}
	if !h.hasRouteStatus(waiting.sessionID, "failed") {
		t.Fatal("the waiting viewer must be told")
	}
}

func TestRouterDoesNotRecreateSfuAfterExhaustedReuseAndCarrierTeardown(t *testing.T) {
	h := newRouterHarness(t, routerHarnessOptions{capacity: 2, withSfu: true, prepareTimeoutMs: 300, fakeTimers: true})
	created := h.createRoom()
	host := h.connectHost(created, nil, "", "")
	firstRoot := h.connectViewer(created, "reuse-loop-first-root")
	h.locked(func() {
		h.doComplete(host)
		h.doComplete(firstRoot)
	})
	firstDirect := h.waitPreparedTransport(firstRoot.sessionID, "direct")
	secondRoot := h.connectViewer(created, "reuse-loop-second-root")
	h.locked(func() {
		h.doReady(firstRoot, int64(firstDirect.Revision))
		h.doRelay(firstRoot, 1)
		h.doComplete(secondRoot)
	})
	secondDirect := h.waitPreparedTransport(secondRoot.sessionID, "direct")
	departedParent := h.connectViewer(created, "reuse-loop-departed-parent")
	h.locked(func() {
		h.doReady(secondRoot, int64(secondDirect.Revision))
		h.doComplete(departedParent)
	})
	parentDirect := h.waitPreparedUpstream(departedParent.sessionID, protocol.PeerUpstream(firstRoot.peerID))
	demand := h.connectViewer(created, "reuse-loop-demand")
	h.locked(func() {
		h.doReady(departedParent, int64(parentDirect.Revision))
		h.doRelay(departedParent, 1)
		h.doComplete(demand)
	})
	demandDirect := h.waitPreparedUpstream(demand.sessionID, protocol.PeerUpstream(departedParent.peerID))
	var departureAt int64
	h.locked(func() {
		h.doReady(demand, int64(demandDirect.Revision))
		departureAt = h.clock.now()
		h.doDisconnect(departedParent)
		h.router.removeViewer(created.RoomID, departedParent.peerID)
		h.doRelay(secondRoot, 1)
	})

	h.waitFor("a direct recovery for the demand", func() bool {
		recovery, ok := h.ownPrepare(demand)
		return ok && int64(recovery.Revision) > int64(demandDirect.Revision) &&
			recovery.Candidate.ChildPeerID == demand.peerID && recovery.Candidate.Transport == "direct"
	})
	h.clock.advance(max(int64(0), departureAt+150-h.clock.now()))

	var carrier authenticatedRouteParticipant
	h.waitFor("a carrier bootstrap", func() bool {
		for _, viewer := range []authenticatedRouteParticipant{firstRoot, secondRoot} {
			if prepared, ok := h.ownPrepare(viewer); ok && prepared.Candidate.Transport == "sfu" {
				carrier = viewer
				return true
			}
		}
		return false
	})
	bootstrap, _ := h.ownPrepare(carrier)
	h.routeReady(carrier, int64(bootstrap.Revision))

	h.waitPreparedTransport(demand.sessionID, "sfu")
	if h.usage().Ingress != 1 {
		t.Fatal("expected one admitted publication")
	}
	configCountAfterBootstrap := sfuConfigCount(h.allMessages())
	if configCountAfterBootstrap < 3 {
		t.Fatalf("sfu-config count after bootstrap = %d, want >= 3", configCountAfterBootstrap)
	}

	h.clock.advance(max(int64(0), departureAt+300-h.clock.now()))
	h.waitFor("the carrier direct convergence", func() bool {
		prepared, ok := h.ownPrepare(carrier)
		return ok && prepared.Candidate.Transport == "direct"
	})
	if operation := h.diagnostic(created.RoomID).Operation; operation == nil || operation.Reason != "direct-convergence" {
		t.Fatalf("operation = %+v, want direct-convergence", operation)
	}
	carrierDirect, _ := h.ownPrepare(carrier)
	h.routeReady(carrier, int64(carrierDirect.Revision))

	h.waitFor("the carrier back on the host", func() bool {
		edge, ok := h.activeEdge(created.RoomID, carrier.peerID)
		return ok && edge.upstream == protocol.PeerUpstream(host.peerID)
	})
	h.waitFor("the publication drain", func() bool { return len(h.media.Deleted()) == 1 })
	h.clock.advance(300)

	if h.usage().Ingress != 0 {
		t.Fatal("retired publication remained admitted")
	}
	if count := sfuConfigCount(h.allMessages()); count != configCountAfterBootstrap {
		t.Fatalf("sfu-config count = %d, want %d", count, configCountAfterBootstrap)
	}
	if usage := h.usage(); usage != (sfu.Usage{}) {
		t.Fatalf("usage = %+v, want empty", usage)
	}
}

func TestRouterReportsLateFinalSfuBootstrapReadyOnlyToWaitingDemand(t *testing.T) {
	h := newRouterHarness(t, routerHarnessOptions{capacity: 2, withSfu: true, prepareTimeoutMs: 300, fakeTimers: true})
	created := h.createRoom()
	host := h.connectHost(created, nil, "", "")
	firstRoot := h.connectViewer(created, "late-ready-first-root")
	h.locked(func() {
		h.doComplete(host)
		h.doComplete(firstRoot)
	})
	firstPrepare := h.waitPreparedTransport(firstRoot.sessionID, "direct")
	secondRoot := h.connectViewer(created, "late-ready-second-root")
	h.locked(func() {
		h.doReady(firstRoot, int64(firstPrepare.Revision))
		h.doRelay(firstRoot, 2)
		h.doComplete(secondRoot)
	})
	secondPrepare := h.waitPreparedTransport(secondRoot.sessionID, "direct")
	waiting := h.connectViewer(created, "late-ready-waiting")
	h.locked(func() {
		h.doReady(secondRoot, int64(secondPrepare.Revision))
		h.doComplete(waiting)
	})
	h.waitPreparedTransport(waiting.sessionID, "direct")

	h.clock.advance(150)
	firstCarrier := h.waitPreparedTransport(secondRoot.sessionID, "sfu")
	h.routeFailed(secondRoot, routeFailedMessage(int64(firstCarrier.Revision), "prepare", firstCarrier.Candidate.ConnectionID))

	finalCarrier := h.waitPreparedTransport(firstRoot.sessionID, "sfu")
	h.clock.set(451)
	h.routeReady(firstRoot, int64(finalCarrier.Revision))

	h.waitFor("exactly one exhaustion for the waiting viewer", func() bool {
		count := 0
		for _, message := range h.messages(waiting.sessionID) {
			if status, ok := message.(protocol.RouteStatusMessage); ok && status.State == "failed" && status.Reason == "route-exhausted" {
				count++
			}
		}
		return count == 1
	})
	for _, carrier := range []authenticatedRouteParticipant{firstRoot, secondRoot} {
		if h.hasRouteStatus(carrier.sessionID, "failed") {
			t.Fatal("carriers must not be told about the waiting viewer's exhaustion")
		}
	}
}

func TestRouterReportsBoundedRouteExhaustionWithoutRawErrorText(t *testing.T) {
	h := newRouterHarness(t, routerHarnessOptions{capacity: 2, withSfu: true, prepareTimeoutMs: 300, fakeTimers: true})
	created := h.createRoom()
	host := h.connectHost(created, nil, "", "")
	viewer := h.connectViewer(created, "route-exhausted")
	h.locked(func() {
		h.doComplete(host)
		h.doComplete(viewer)
	})

	h.waitPreparedTransport(viewer.sessionID, "direct")
	h.clock.advance(150)
	h.waitPreparedTransport(viewer.sessionID, "sfu")
	h.clock.advance(150)
	h.waitFailed(viewer.sessionID)
	for _, message := range h.messages(viewer.sessionID) {
		if failure, ok := message.(protocol.ErrorMessage); ok && strings.Contains(failure.Message, "media route") {
			t.Fatal("raw error text must not reach the viewer")
		}
	}
}

func TestRouterReportsTypedExhaustionWhenExactCandidateFails(t *testing.T) {
	h := newRouterHarness(t, routerHarnessOptions{capacity: 1})
	created := h.createRoom()
	host := h.connectHost(created, nil, "", "")
	viewer := h.connectViewer(created, "candidate-failed")
	h.locked(func() {
		h.doComplete(host)
		h.doComplete(viewer)
	})
	prepared := h.waitPrepared(viewer.sessionID)
	h.routeFailed(viewer, routeFailedMessage(int64(prepared.Revision), "prepare", prepared.Candidate.ConnectionID))
	h.waitFailed(viewer.sessionID)
}

func noCandidateExhaustion(t *testing.T) {
	t.Helper()
	h := newRouterHarness(t, routerHarnessOptions{capacity: 1})
	created := h.createRoom()
	host := h.connectHost(created, nil, "", "")
	first := h.connectViewer(created, "only-slot")
	h.locked(func() {
		h.doComplete(host)
		h.doComplete(first)
	})
	firstPrepare := h.waitPrepared(first.sessionID)
	blocked := h.connectViewer(created, "no-candidate")
	h.locked(func() {
		h.doReady(first, int64(firstPrepare.Revision))
		h.doComplete(blocked)
	})
	h.waitFailed(blocked.sessionID)
}

func TestRouterReportsTypedExhaustionWhenReconciliationHasNoCandidate(t *testing.T) {
	noCandidateExhaustion(t)
}

func TestRouterReportsOnlySfuAdmissionWaitingWhileBoundedCapacityIsUnavailable(t *testing.T) {
	h := newRouterHarness(t, routerHarnessOptions{capacity: 2, withSfu: true, prepareTimeoutMs: 300, fakeTimers: true})
	capacityFences := []sfu.ResourceFence{
		{RoomID: "9001", ShareGeneration: "capacity_share_a", PublicationGeneration: "capacity_publication_a"},
		{RoomID: "9002", ShareGeneration: "capacity_share_b", PublicationGeneration: "capacity_publication_b"},
	}
	created := h.createRoom()
	host := h.connectHost(created, nil, "", "")
	viewer := h.connectViewer(created, "sfu-admission-wait")
	h.locked(func() {
		for _, fence := range capacityFences {
			if !h.admission.ReservePublication(fence) {
				t.Fatal("the capacity fence must be reserved")
			}
		}
		h.doComplete(host)
		h.doComplete(viewer)
	})

	h.waitPreparedTransport(viewer.sessionID, "direct")
	h.clock.advance(150)
	h.waitFor("the sfu-admission waiting status", func() bool {
		status, ok := h.lastRouteStatus(viewer.sessionID)
		return ok && status.State == "waiting" && status.Reason == "sfu-admission"
	})
	h.locked(func() {
		for _, fence := range capacityFences {
			h.admission.BeginDrain(fence)
			h.admission.CompleteDrain(fence)
		}
	})
}

// TS asserted admission.reservePublication was not called again through a
// spy; here the observable is the waiting status count, which a woken
// waiter would re-send (map 7.2 step 9c), plus the unchanged usage.
func TestRouterReleasesExactSubscriptionChargeAfterPhysicalClose(t *testing.T) {
	h := newRouterHarness(t, routerHarnessOptions{capacity: 1, withSfu: true, sfuIngressCapacity: 2})
	activeRoom := h.createRoom()
	_, first, _ := h.establishSfuRoom(activeRoom)
	h.waitUsage(sfu.Usage{Ingress: 1, Egress: 2})
	waitingRoom := h.createRoom()
	waitingHost := h.connectHost(waitingRoom, nil, "", "")
	waitingViewer := h.connectViewer(waitingRoom, "waiter")
	h.locked(func() {
		if !h.admission.ReservePublication(sfu.ResourceFence{RoomID: "9001", ShareGeneration: "waiter_share_12345678", PublicationGeneration: "waiter_publication_12345678"}) {
			t.Fatal("the occupying publication must be reserved")
		}
		h.doComplete(waitingHost)
		h.doComplete(waitingViewer)
	})
	direct := h.waitPrepared(waitingViewer.sessionID)
	h.routeFailed(waitingViewer, routeFailedMessage(int64(direct.Revision), "prepare", direct.Candidate.ConnectionID))
	h.waitFor("the waiting status", func() bool {
		status, ok := h.lastRouteStatus(waitingViewer.sessionID)
		return ok && status.State == "waiting" && status.Reason == "sfu-admission"
	})
	drainGate := make(chan struct{})
	h.media.SetSubscriptionDrainBarrier(drainGate)

	h.locked(func() {
		h.doDisconnect(first)
		h.router.removeViewer(activeRoom.RoomID, first.peerID)
	})
	h.waitFor("one diagnostic child", func() bool { return len(h.diagnostic(activeRoom.RoomID).Children) == 1 })
	h.waitFor("the subscription drain attempt", func() bool {
		return hasViewer(h.media.SubscriptionDrainAttempts(), first.peerID)
	})
	if usage := h.usage(); usage != (sfu.Usage{Ingress: 2, Egress: 2}) {
		t.Fatalf("usage during drain = %+v", usage)
	}
	close(drainGate)
	h.waitFor("the drained subscription", func() bool {
		return hasViewer(h.media.DrainedSubscriptions(), first.peerID)
	})

	h.waitUsage(sfu.Usage{Ingress: 2, Egress: 1})

	if err := h.close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	if usage := h.usage(); usage != (sfu.Usage{}) {
		t.Fatalf("usage after close = %+v", usage)
	}
}

func TestRouterOrdersExactPrepareCommitsOnlyChildProofAndRollsBackAboveP(t *testing.T) {
	h := newRouterHarness(t, routerHarnessOptions{capacity: 2})
	created := h.createRoom()
	host := h.connectHost(created, nil, "", "")
	first := h.connectViewer(created, "first")
	h.locked(func() {
		h.doComplete(host)
		h.doComplete(first)
	})

	firstPrepare := h.waitPrepared(first.sessionID)
	if firstPrepare.Candidate.ChildPeerID != first.peerID || firstPrepare.Candidate.Transport != "direct" {
		t.Fatalf("first candidate = %+v", firstPrepare.Candidate)
	}
	h.locked(func() {
		if hostPrepare, ok := lastPrepare(h.sent[host.sessionID], ""); !ok || !reflect.DeepEqual(hostPrepare.Candidate, firstPrepare.Candidate) {
			t.Fatal("the host must receive the same candidate")
		}
		h.doReady(host, int64(firstPrepare.Revision))
		for _, message := range h.sent[first.sessionID] {
			if active, ok := message.(protocol.RouteUpdateActiveMessage); ok && int64(active.Revision) > int64(firstPrepare.Revision) {
				t.Fatal("host proof must not commit the candidate")
			}
		}
		h.doReady(first, int64(firstPrepare.Revision))
	})
	h.waitFor("the active route at the prepare revision", func() bool {
		for _, message := range h.messages(first.sessionID) {
			if active, ok := message.(protocol.RouteUpdateActiveMessage); ok && active.Revision == firstPrepare.Revision {
				return true
			}
		}
		return false
	})

	second := h.connectViewer(created, "second")
	h.complete(second)
	secondPrepare := h.waitPrepared(second.sessionID)
	h.routeFailed(second, routeFailedMessage(int64(secondPrepare.Revision), "prepare", secondPrepare.Candidate.ConnectionID))
	h.waitFor("the rollback broadcast", func() bool {
		_, ok := h.activeAfter(second.sessionID, int64(secondPrepare.Revision))
		return ok
	})
	if active, _ := h.activeAfter(second.sessionID, int64(secondPrepare.Revision)); int64(active.Revision) <= int64(secondPrepare.Revision) {
		t.Fatalf("rollback revision = %d", active.Revision)
	}
}

func TestRetiredPumpPreservesReplacementShareResourceWaiter(t *testing.T) {
	h := newRouterHarness(t, routerHarnessOptions{capacity: 1, withSfu: true, sfuIngressCapacity: 1})
	created := h.createRoom()
	host := h.connectHost(created, nil, "", "")
	viewer := h.connectViewer(created, "replacement-waiter")
	occupied := sfu.ResourceFence{RoomID: "9001", ShareGeneration: "occupied-share", PublicationGeneration: "occupied-publication"}
	h.locked(func() {
		h.router.sfuOnly = true
		if !h.admission.ReservePublication(occupied) {
			t.Fatal("reserve occupied publication")
		}
		h.router.connectParticipant(host)
		h.router.connectParticipant(viewer)
		old, _ := h.router.rooms.Get(created.RoomID)
		old.pumping = true
		controller := old.controller
		revision := controller.Revision()
		// Suspend the same queued remainder as requestPump, allowing the new
		// share to acquire the authority mutex before the old driver resumes.
		pending := h.router.pumpRoom(created.RoomID, old, controller, &revision, nil, true)
		if pending == nil || !pending.result.denied {
			t.Fatal("expected queued denied candidate")
		}
		h.router.stopRoom(created.RoomID)
		h.router.connectParticipant(host)
		replacement, _ := h.router.rooms.Get(created.RoomID)
		replacementRevision := replacement.controller.Revision()
		h.router.pumpRoom(created.RoomID, replacement, replacement.controller, &replacementRevision, nil, false)
		if !h.router.resourceWaiters.Has(created.RoomID) {
			t.Fatal("replacement did not wait")
		}
		h.router.inflight++
		go h.router.drivePump(created.RoomID, old, controller, revision, pending, false)
	})
	h.settle()
	h.locked(func() {
		if !h.router.resourceWaiters.Has(created.RoomID) {
			t.Fatal("retired pump erased the replacement share's SFU waiter")
		}
		h.admission.BeginDrain(occupied)
		h.admission.CompleteDrain(occupied)
		h.router.wakeResourceWaiters()
	})
	h.waitPreparedTransport(viewer.sessionID, "sfu")
}

func TestRouterCreatesOneHostPublicationAndReusesExactViewerSubscriptions(t *testing.T) {
	h := newRouterHarness(t, routerHarnessOptions{capacity: 1, withSfu: true})
	created := h.createRoom()
	host := h.connectHost(created, nil, "", "")
	first := h.connectViewer(created, "sfu_first")
	h.locked(func() {
		h.doComplete(host)
		h.doComplete(first)
	})
	firstDirect := h.waitPrepared(first.sessionID)
	second := h.connectViewer(created, "sfu_second")
	h.locked(func() {
		h.doReady(first, int64(firstDirect.Revision))
		h.doComplete(second)
	})
	firstSfu := h.waitPreparedTransport(first.sessionID, "sfu")
	h.routeReady(first, int64(firstSfu.Revision))

	secondSfu := h.waitPreparedTransport(second.sessionID, "sfu")
	h.routeReady(second, int64(secondSfu.Revision))
	h.waitUsage(sfu.Usage{Ingress: 1, Egress: 2})
	if count := sfuConfigCount(h.messages(host.sessionID)); count != 1 {
		t.Fatalf("host sfu-config count = %d, want 1", count)
	}
}

func TestRouterResolvesExactDirectAndPeerRelayedViewerEvidenceSources(t *testing.T) {
	h := newRouterHarness(t, routerHarnessOptions{capacity: 1})
	created := h.createRoom()
	host := h.connectHost(created, nil, "", "")
	root := h.connectViewer(created, "evidence-root")
	h.locked(func() {
		h.doComplete(host)
		h.doComplete(root)
	})
	rootPrepare := h.waitPrepared(root.sessionID)
	h.locked(func() {
		if _, ok := h.doEdge(created.RoomID, root.peerID); ok {
			t.Fatal("a prepared candidate is not an active edge")
		}
		h.doReady(root, int64(rootPrepare.Revision))
	})
	h.waitFor("the root active edge", func() bool {
		edge, ok := h.activeEdge(created.RoomID, root.peerID)
		return ok && edge == activeViewerMediaEdge{
			revision: int64(rootPrepare.Revision), connectionID: rootPrepare.Candidate.ConnectionID,
			upstream: protocol.PeerUpstream(host.peerID),
		}
	})

	child := h.connectViewer(created, "evidence-child")
	h.locked(func() {
		h.doRelay(root, 1)
		h.doComplete(child)
	})
	childPrepare := h.waitPrepared(child.sessionID)
	if childPrepare.Candidate.Transport != "direct" {
		t.Fatalf("child transport = %q", childPrepare.Candidate.Transport)
	}
	h.routeReady(child, int64(childPrepare.Revision))
	h.waitFor("the child active edge", func() bool {
		edge, ok := h.activeEdge(created.RoomID, child.peerID)
		return ok && edge == activeViewerMediaEdge{
			revision: int64(childPrepare.Revision), connectionID: childPrepare.Candidate.ConnectionID,
			upstream: protocol.PeerUpstream(root.peerID),
		}
	})
}

func TestRouterDrainsEveryPendingSfuPublicationDuringCloseEvenWhenOneDrainRejects(t *testing.T) {
	before := runtime.NumGoroutine()
	h := newRouterHarness(t, routerHarnessOptions{capacity: 1, withSfu: true, prepareTimeoutMs: 1_000, sfuIngressCapacity: 2_000})
	roomA := h.createRoom()
	h.establishSfuRoom(roomA)
	roomB := h.createRoom()
	h.establishSfuRoom(roomB)
	h.media.SetFailDelete(true)
	h.locked(func() {
		h.router.stopRoom(roomA.RoomID)
		h.router.stopRoom(roomB.RoomID)
	})
	h.waitFor("two delete attempts", func() bool {
		deletes, _, _ := h.media.counts()
		return deletes == 2
	})

	h.media.SetFailDelete(false)
	fake := h.media.FakeMedia
	h.media.setClosePublication(func(fence sfu.ResourceFence) error {
		if fence.RoomID == roomA.RoomID {
			return errors.New("room deletion failed")
		}
		return fake.ClosePublication(fence)
	})

	err := h.close()
	if err == nil || !strings.Contains(err.Error(), "SFU drain failed during shutdown") {
		t.Fatalf("close error = %v, want the shutdown drain failure", err)
	}
	var deleted []string
	for _, fence := range h.media.Deleted() {
		deleted = append(deleted, fence.RoomID)
	}
	if !slices.Equal(deleted, []string{roomB.RoomID}) {
		t.Fatalf("deleted rooms = %v, want [%s]", deleted, roomB.RoomID)
	}
	expectGoroutinesSettled(t, before)
}

func TestRouterSerializesFreshSfuConfigurationWithoutMakingRefreshOneShot(t *testing.T) {
	h := newRouterHarness(t, routerHarnessOptions{capacity: 1, withSfu: true})
	created := h.createRoom()
	_, first, _ := h.establishSfuRoom(created)
	configCount := func() int { return sfuConfigCount(h.messages(first.sessionID)) }
	var active activeViewerMediaEdge
	var initialCount int
	h.locked(func() {
		active = h.doMustEdge(created.RoomID, first.peerID)
		if active.upstream != protocol.SfuUpstream() {
			t.Fatalf("upstream = %v", active.upstream)
		}
		initialCount = sfuConfigCount(h.sent[first.sessionID])
		h.router.refreshSfu(first, 0)
	})
	h.waitFor("the first refresh", func() bool { return configCount() == initialCount+1 })
	h.locked(func() { h.router.refreshSfu(first, active.revision) })
	h.waitFor("the second refresh", func() bool { return configCount() == initialCount+2 })
}

// hybrid-media-router.ts:1129-1132: a throw from media or tokenIssuer
// rejected the pump promise and its .catch told the Host. In Go the throw is a
// panic raised while mu is released for the token issue, so the pump must come
// back holding mu; otherwise drivePump's deferred Unlock aborts the process.

func TestRouterEmitsTypedExhaustionAndClearsDiagnosticsOnDepartureAndRoomDeletion(t *testing.T) {
	h := newRouterHarness(t, routerHarnessOptions{capacity: 1})
	created := h.createRoom()
	host := h.connectHost(created, nil, "", "")
	viewer := h.connectViewer(created, "diagnostic")
	h.locked(func() {
		h.doComplete(host)
		h.doComplete(viewer)
	})
	prepared := h.waitPrepared(viewer.sessionID)
	h.locked(func() {
		if len(h.router.routeDiagnosticSnapshot(created.RoomID).Children) != 1 {
			t.Fatal("one diagnostic child expected")
		}
		h.doFailed(viewer, routeFailedMessage(int64(prepared.Revision), "prepare", prepared.Candidate.ConnectionID))
	})
	h.waitFailed(viewer.sessionID)

	replacement := h.connectViewer(created, "diagnostic-replacement")
	h.locked(func() {
		emptySnapshot := func() bool {
			snapshot := h.router.routeDiagnosticSnapshot(created.RoomID)
			return len(snapshot.Children) == 0 && snapshot.Operation == nil
		}
		h.router.removeViewer(created.RoomID, viewer.peerID)
		if !emptySnapshot() {
			t.Fatal("departure must clear the diagnostics")
		}
		h.doComplete(replacement)
		if len(h.router.routeDiagnosticSnapshot(created.RoomID).Children) != 1 {
			t.Fatal("the replacement must appear in the diagnostics")
		}
		h.router.stopRoom(created.RoomID)
		if !emptySnapshot() {
			t.Fatal("stopRoom must clear the diagnostics")
		}
		h.doComplete(host)
		if len(h.router.routeDiagnosticSnapshot(created.RoomID).Children) == 0 {
			t.Fatal("a restarted share must rebuild the diagnostics")
		}
		h.router.deleteRoom(created.RoomID)
		if !emptySnapshot() {
			t.Fatal("deleteRoom must clear the diagnostics")
		}
	})
}

func TestRouterPreservesConnectedViewerCapacityAcrossSharingGenerations(t *testing.T) {
	h := newRouterHarness(t, routerHarnessOptions{capacity: 1})
	created := h.createRoom()
	host := h.connectHost(created, nil, "", "")
	root := h.connectViewer(created, "retained-capacity-root")
	h.locked(func() {
		h.doComplete(host)
		h.doComplete(root)
	})
	initialRoot := h.waitPrepared(root.sessionID)
	h.locked(func() {
		h.doReady(root, int64(initialRoot.Revision))
		h.doRelay(root, 1)
		h.router.stopRoom(created.RoomID)
		h.sent[root.sessionID] = nil
		h.doComplete(host)
	})
	restartedRoot := h.waitPrepared(root.sessionID)
	child := h.connectViewer(created, "retained-capacity-child")
	h.locked(func() {
		h.doReady(root, int64(restartedRoot.Revision))
		h.doComplete(child)
	})
	childPrepare := h.waitPrepared(child.sessionID)
	if childPrepare.Assignment.Upstream != protocol.PeerUpstream(root.peerID) {
		t.Fatalf("child upstream = %v, want the retained root", childPrepare.Assignment.Upstream)
	}
}

// TS declared this scenario twice under two names; both are kept.
func TestRouterEmitsTypedExhaustionWhenReconciliationHasNoCandidate(t *testing.T) {
	noCandidateExhaustion(t)
}

// ---------------------------------------------------------------------------
// Go-only coverage of the concurrency seams the TS runtime did not have:
// the per-room-name FIFO keeps LiveKit calls in decision order.
// ---------------------------------------------------------------------------

func TestRouterDebugFlagParsesLikeNodeDebug(t *testing.T) {
	previous := slog.Default()
	t.Cleanup(func() { slog.SetDefault(previous) })
	slog.SetDefault(slog.New(slog.NewTextHandler(io.Discard, nil)))
	cases := map[string]bool{"": false, "route": true, "http,route": true, " route ": true, "router": false}
	keys := make([]string, 0, len(cases))
	for key := range cases {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		t.Setenv("PIIK_DEBUG", key)
		if got := routeDebugFlag(key); got != cases[key] {
			t.Fatalf("routeDebugFlag(%q) = %v, want %v", key, got, cases[key])
		}
		if got := routeDebugEnabled(); got != cases[key] {
			t.Fatalf("routeDebugEnabled with %q = %v, want %v", key, got, cases[key])
		}
	}
	t.Setenv("PIIK_DEBUG", "")
	slog.SetDefault(slog.New(slog.NewTextHandler(io.Discard, &slog.HandlerOptions{Level: slog.LevelDebug})))
	if !routeDebugEnabled() {
		t.Fatal("the active diagnostic logger did not enable route events")
	}
}
