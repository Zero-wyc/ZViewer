package signal

// Ported from tests/server-signal.test.ts (baseline b20fd88): the 43 cases
// of describe("WebSocket signaling"). The harness mirrors startHarness: a
// memory room.Store, short timer options (authentication 500 ms, viewer
// grace 50 ms, heartbeat disabled at 60 s), an httptest.Server whose every
// request reaches Server.ServeHTTP, real coder/websocket clients and a
// MessageInbox port. Room access updates call the server directly where the
// TS went through HTTP; the site-access cookie is a stub predicate.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"reflect"
	"runtime"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"zviewer/backend/internal/piik/server/config"
	"zviewer/backend/internal/piik/server/protocol"
	"zviewer/backend/internal/piik/server/room"
	"zviewer/backend/internal/piik/server/sfu"
	"zviewer/backend/internal/piik/server/sfu/sfutest"
)

const (
	allowedOrigin    = "http://allowed.test"
	siteAccessCookie = "piik-site-access=granted"
	defaultWait      = 2 * time.Second
)

func TestSenderQualityBudgetAdmitsRoomProducerCadence(t *testing.T) {
	s := &Server{endpointMediaCopyCapacity: 2, senderQualityRateBySession: map[string]*senderQualityRateWindow{}}
	// Browser and Native producers report each physical sender every two
	// seconds. A room may retain all Viewer senders plus one serial preparation.
	const senders = protocol.MaxViewersPerRoomLimit + 1
	for window := range 4 {
		now := int64(window * protocol.ViewerQualityEvidenceIntervalMs)
		for range senders {
			if !s.consumeSenderQualityBudget("producer-session", now) {
				t.Fatal("legal per-connection producer burst was rate limited")
			}
		}
		// Keep the existing double allowance for boundary timing, then reject
		// further traffic until the next observation window.
		for range senders {
			if !s.consumeSenderQualityBudget("producer-session", now) {
				t.Fatal("producer boundary allowance was lost")
			}
		}
		if s.consumeSenderQualityBudget("producer-session", now) {
			t.Fatal("sender evidence above the room budget was accepted")
		}
	}
}

func TestCreateRoomReleasesLockWhenDerivationOrCommitPanics(t *testing.T) {
	for _, password := range []string{"", "room-password"} {
		t.Run(password, func(t *testing.T) {
			store, err := room.New(room.Options{
				MaxRooms: 1, MaxViewersPerRoom: 1,
				Random: func(int) []byte { panic("test random source") },
			})
			if err != nil {
				t.Fatal(err)
			}
			server := &Server{store: store}
			func() {
				defer func() {
					if value := recover(); value != "test random source" {
						t.Errorf("panic = %v, want original random-source panic", value)
					}
				}()
				_, _ = server.CreateRoom(protocol.CodeEntryOpen, &password, "")
			}()
			if !server.mu.TryLock() {
				t.Fatal("CreateRoom left the server locked after a recovered panic")
			}
			server.mu.Unlock()
		})
	}
}

func TestPasswordPreparationDoesNotBlockAnotherRoom(t *testing.T) {
	for _, update := range []bool{false, true} {
		t.Run(fmt.Sprintf("update=%v", update), func(t *testing.T) {
			started, release := make(chan struct{}), make(chan struct{})
			var hold atomic.Bool
			var releaseOnce sync.Once
			unblock := func() { releaseOnce.Do(func() { close(release) }) }
			t.Cleanup(unblock)
			store, err := room.New(room.Options{
				MaxRooms: 3, MaxViewersPerRoom: 1,
				Random: func(size int) []byte {
					// Hold the existing salt source in the unlocked password phase.
					if hold.CompareAndSwap(true, false) {
						close(started)
						<-release
					}
					return bytes.Repeat([]byte{byte(size)}, size)
				},
			})
			if err != nil {
				t.Fatal(err)
			}
			server := &Server{store: store}
			original, err := server.CreateRoom(protocol.CodeEntryOpen, nil, "1234")
			if err != nil {
				t.Fatal(err)
			}
			hold.Store(true)
			done := make(chan error, 1)
			go func() {
				password := "room-password"
				var err error
				if update {
					_, err = server.UpdateRoomAccess(original.RoomID, original.HostToken,
						protocol.SetViewerPasswordRequest{Password: &password})
				} else {
					_, err = server.CreateRoom(protocol.CodeEntryPrivate, &password, "2345")
				}
				done <- err
			}()
			select {
			case <-started:
			case <-time.After(defaultWait):
				t.Fatal("password preparation did not start")
			}
			if !server.mu.TryLock() {
				t.Fatal("password work blocks signaling for other rooms")
			}
			server.mu.Unlock()
			if _, err := server.CreateRoom(protocol.CodeEntryOpen, nil, "3456"); err != nil {
				t.Fatalf("independent room creation: %v", err)
			}
			unblock()
			select {
			case err := <-done:
				if err != nil {
					t.Fatalf("password operation: %v", err)
				}
			case <-time.After(defaultWait):
				t.Fatal("password operation did not finish")
			}
		})
	}
}

func TestStopSharingDoesNotWriteRoomAuthority(t *testing.T) {
	database, err := room.NewDatabase(filepath.Join(t.TempDir(), "rooms.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	store := newStore(t, 1, database)
	h := startHarness(t, harnessOptions{store: store})
	host := openClient(t, h)
	authenticated := authenticate(t, host, h.room, protocol.RoleHost, "storage-free-host", 1, "", presenceOptions{})
	host.ignore("route-update")
	h.locked(func() {
		if err := database.Close(); err != nil {
			t.Fatal(err)
		}
	})
	host.sendJSON(map[string]any{"type": "stop-sharing", "shareGeneration": authenticated.ShareGeneration})
	expectClose(t, host, 1000, "Sharing stopped")
	if h.storeSize() != 1 {
		t.Fatal("stopping sharing removed room authority")
	}
	resumed := openClient(t, h)
	authenticate(t, resumed, h.room, protocol.RoleHost, "storage-free-host", 1, "", presenceOptions{})
}

func TestHostKeepsRoomSessionAndInteractionsAfterSharingStops(t *testing.T) {
	h := startHarness(t, harnessOptions{maxViewersPerRoom: 2})
	host := openClient(t, h)
	hostAuth := authenticate(t, host, h.room, protocol.RoleHost, "persistent-host", 1,
		"first_share_generation_12345678", presenceOptions{displayName: "Host", viewerPresence: true, roomSession: true})
	viewer := openClient(t, h)
	authenticate(t, viewer, h.room, protocol.RoleViewer, "persistent-viewer", 1, "",
		presenceOptions{displayName: "Viewer", viewerPresence: true})
	host.ignore("route-update")
	host.ignore("viewer-presence")
	subscribeInteractions(t, host)
	subscribeInteractions(t, viewer)

	host.sendJSON(map[string]any{"type": "stop-sharing", "shareGeneration": hostAuth.ShareGeneration})
	viewer.next("sharing-stopped")
	viewer.next("host-status")
	host.expectNone(80 * time.Millisecond)
	h.locked(func() {
		connected, ok := h.server.store.GetConnectedHost(h.room.RoomID)
		if !ok || connected.SessionID == "" {
			t.Fatal("stopping media must retain the Host room session")
		}
	})

	host.sendJSON(map[string]any{
		"type":      "send-room-interaction",
		"requestId": "persistent_chat_request",
		"payload":   map[string]any{"kind": "chat", "text": "still here"},
	})
	host.next("room-interaction")
	viewer.next("room-interaction")

	host.sendJSON(map[string]any{
		"type":            "start-sharing",
		"shareGeneration": "second_share_generation_12345678",
		"routePolicy":     map[string]any{"peerOnly": true, "topologyOptimization": true, "natPrediction": false},
	})
	started := host.next("sharing-started")
	if !bytes.Contains(started.raw, []byte(`"shareGeneration":"second_share_generation_12345678"`)) {
		t.Fatalf("unexpected sharing-started: %s", started.raw)
	}
	viewer.next("host-status")
	h.closeClient(viewer)
	h.closeClient(host)
}

func TestIdleHostChatAndPublicationAcknowledgmentOrder(t *testing.T) {
	h := startHarness(t, harnessOptions{})
	host := openClient(t, h)
	authenticate(t, host, h.room, protocol.RoleHost, "room-only-host", 1, "", presenceOptions{roomSession: true, roomOnly: true, viewerPresence: true})
	host.ignore("viewer-presence")
	viewer := openClient(t, h)
	authenticate(t, viewer, h.room, protocol.RoleViewer, "room-only-viewer", 1, "", presenceOptions{})
	subscribeInteractions(t, host)
	subscribeInteractions(t, viewer)
	host.sendJSON(map[string]any{"type": "send-room-interaction", "requestId": "chat_before_capture",
		"payload": map[string]any{"kind": "chat", "text": "before capture"}})
	host.next("room-interaction")
	viewer.next("room-interaction")
	host.sendJSON(map[string]any{"type": "start-sharing", "shareGeneration": "new_publication_generation",
		"routePolicy": protocol.DefaultRoutePolicy})
	// No ignored route messages: acknowledgment must precede media effects.
	host.sendJSON(map[string]any{"type": "signaling-challenge", "sequence": 1})
	host.next("signaling-challenge-response")
	host.mu.Lock()
	first := host.messages[0].typ
	host.mu.Unlock()
	if first != "sharing-started" {
		t.Fatalf("first publication message = %s", first)
	}
	host.next("sharing-started")
	host.next("route-update")
}

func TestRejectedPublicationRetainsHostRoomSession(t *testing.T) {
	h := startHarness(t, harnessOptions{})
	host := openClient(t, h)
	authenticate(t, host, h.room, protocol.RoleHost, "rejected-start-host", 1, "", presenceOptions{roomSession: true, roomOnly: true, viewerPresence: true})
	host.ignore("viewer-presence")
	subscribeInteractions(t, host)
	// Inject the existing route-construction failure, after room admission.
	h.locked(func() { h.server.router.capacity = 0 })
	host.sendJSON(map[string]any{"type": "start-sharing", "shareGeneration": "rejected_publication_generation",
		"routePolicy": protocol.DefaultRoutePolicy})
	expectMatch(t, host.next("sharing-start-failed").raw,
		`{"shareGeneration":"rejected_publication_generation","code":"SERVER_ERROR"}`)
	h.locked(func() {
		h.server.router.capacity = 2
		if h.server.activeHostShareGeneration(h.room.RoomID) != "" {
			t.Fatal("failed publication remained active")
		}
	})
	host.sendJSON(map[string]any{"type": "send-room-interaction", "requestId": "chat_after_rejected_start",
		"payload": map[string]any{"kind": "chat", "text": "still in room"}})
	host.next("room-interaction")
	host.sendJSON(map[string]any{"type": "start-sharing", "shareGeneration": "next_publication_generation",
		"routePolicy": protocol.DefaultRoutePolicy})
	host.next("sharing-started")
	host.next("route-update")
	host.ignore("route-update")
	host.sendJSON(map[string]any{"type": "stop-sharing", "shareGeneration": "next_publication_generation"})
	host.sendJSON(map[string]any{"type": "start-sharing", "shareGeneration": "next_publication_generation",
		"routePolicy": protocol.DefaultRoutePolicy})
	expectMatch(t, host.next("sharing-start-failed").raw,
		`{"shareGeneration":"next_publication_generation","code":"FORBIDDEN"}`)
}

func TestPersistentRoomSessionReconnectStaysMediaIdle(t *testing.T) {
	h := startHarness(t, harnessOptions{maxViewersPerRoom: 2})
	host := openClient(t, h)
	hostAuth := authenticate(t, host, h.room, protocol.RoleHost, "idle-reconnect-host", 1,
		"idle_reconnect_generation_12345678", presenceOptions{roomSession: true})
	viewer := openClient(t, h)
	authenticate(t, viewer, h.room, protocol.RoleViewer, "idle-reconnect-viewer", 1, "", presenceOptions{})
	host.ignore("route-update")
	viewer.ignore("route-update")
	host.sendJSON(map[string]any{"type": "stop-sharing", "shareGeneration": hostAuth.ShareGeneration})
	viewer.next("sharing-stopped")
	viewer.next("host-status")
	h.closeClient(viewer)
	h.closeClient(host)

	resumed := openClient(t, h)
	resumedAuth := authenticate(t, resumed, h.room, protocol.RoleHost, "idle-reconnect-host", 1, "",
		presenceOptions{roomSession: true, roomOnly: true})
	if resumedAuth.ShareGeneration != nil {
		t.Fatalf("room-only Host must not receive a media generation: %v", *resumedAuth.ShareGeneration)
	}
	h.locked(func() {
		if runtime, ok := h.server.router.rooms.Get(h.room.RoomID); ok && runtime.controller != nil {
			t.Fatal("room-only Host reconnect created a media controller")
		}
	})
	lateViewer := openClient(t, h)
	lateAuth := authenticate(t, lateViewer, h.room, protocol.RoleViewer, "idle-reconnect-late-viewer", 1, "", presenceOptions{})
	if lateAuth.HostOnline || lateAuth.HostPaused == nil || *lateAuth.HostPaused {
		t.Fatalf("idle room advertised active Host media: online=%v paused=%v", lateAuth.HostOnline, lateAuth.HostPaused)
	}
	if lateAuth.ShareGeneration != nil || lateAuth.RouteAssignment.Upstream.Kind != "none" {
		t.Fatalf("idle room advertised a media route: generation=%v assignment=%+v", lateAuth.ShareGeneration, lateAuth.RouteAssignment)
	}
	h.closeClient(lateViewer)
	h.closeClient(resumed)
}

func TestStoppedPublicationReauthenticationPreservesRoomSessionFence(t *testing.T) {
	for _, persistent := range []bool{true, false} {
		t.Run(map[bool]string{true: "room-session", false: "legacy"}[persistent], func(t *testing.T) {
			h := startHarness(t, harnessOptions{})
			host := openClient(t, h)
			const clientID, stoppedGeneration = "stopped-reconnect-host", "stopped_reconnect_generation"
			authenticate(t, host, h.room, protocol.RoleHost, clientID, 1, stoppedGeneration,
				presenceOptions{roomSession: persistent})
			viewer := openClient(t, h)
			authenticate(t, viewer, h.room, protocol.RoleViewer, "stopped-reconnect-viewer", 1, "", presenceOptions{})
			host.ignore("route-update")
			viewer.ignore("route-update")
			host.sendJSON(map[string]any{"type": "stop-sharing", "shareGeneration": stoppedGeneration})
			viewer.next("sharing-stopped")
			viewer.next("host-status")
			h.locked(func() {
				if h.server.activeHostShareGeneration(h.room.RoomID) != "" {
					t.Fatal("stopped publication remained active")
				}
			})
			// A delayed authenticate still carries the generation that was valid
			// when sent. It must not need a compensating client stop to stay idle.
			resumed := openClient(t, h)
			auth := authenticate(t, resumed, h.room, protocol.RoleHost, clientID, 1, stoppedGeneration,
				presenceOptions{roomSession: persistent})
			if !persistent {
				if auth.ShareGeneration == nil || *auth.ShareGeneration != stoppedGeneration {
					t.Fatal("legacy authenticate-to-publish behavior changed")
				}
				return
			}
			if auth.ShareGeneration != nil || auth.RouteAssignment.Upstream.Kind != "none" {
				t.Fatal("delayed authentication restored a stopped publication")
			}
			h.locked(func() {
				if h.server.activeHostShareGeneration(h.room.RoomID) != "" {
					t.Fatal("delayed authentication reacquired media authority")
				}
				if rm, _ := h.server.router.rooms.Get(h.room.RoomID); rm != nil && rm.controller != nil {
					t.Fatal("delayed authentication rebuilt source-less routes")
				}
			})
			const freshGeneration = "fresh_reconnect_generation"
			resumed.sendJSON(map[string]any{"type": "start-sharing", "shareGeneration": freshGeneration,
				"routePolicy": protocol.DefaultRoutePolicy})
			resumed.next("sharing-started")
			h.locked(func() {
				if h.server.activeHostShareGeneration(h.room.RoomID) != freshGeneration {
					t.Fatal("fresh publication could not start after idle reauthentication")
				}
			})
			active := openClient(t, h)
			activeAuth := authenticate(t, active, h.room, protocol.RoleHost, clientID, 1, freshGeneration,
				presenceOptions{roomSession: true})
			if activeAuth.ShareGeneration == nil || *activeAuth.ShareGeneration != freshGeneration {
				t.Fatal("active publication did not survive reauthentication")
			}
		})
	}
}

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

type harnessOptions struct {
	authenticationTimeoutMs             int
	viewerDisconnectGraceMs             int
	roomEmptyTimeoutMs                  int64
	maxViewersPerRoom                   int
	maxSignalConnections                int
	maxUnauthenticatedSignalConnections int
	siteAccessPassword                  string
	endpointMediaCopyCapacity           int
	stunURLs                            []string
	natPredictionEnabled                bool
	now                                 func() int64
	store                               *room.Store
	room                                *room.CreatedRoom
	afterFunc                           func(time.Duration, func()) func() bool
	sfu                                 *SfuFallback
	sfuOnly                             bool
}

type harness struct {
	t      *testing.T
	server *Server
	http   *httptest.Server
	store  *room.Store
	room   room.CreatedRoom
	wsURL  string
	closed bool
}

func orValue(value, fallback int) int {
	if value == 0 {
		return fallback
	}
	return value
}

func newStore(t *testing.T, maxViewersPerRoom int, database *room.Database) *room.Store {
	t.Helper()
	store, err := room.New(room.Options{
		MaxRooms:          room.Capacity,
		MaxViewersPerRoom: maxViewersPerRoom,
		Database:          database,
	})
	if err != nil {
		t.Fatalf("room.New: %v", err)
	}
	if database != nil {
		if err := store.Initialize(); err != nil {
			t.Fatalf("store.Initialize: %v", err)
		}
	}
	return store
}

// createStoreRoom is roomStore.createRoom() on a store no server guards yet.
func createStoreRoom(t *testing.T, store *room.Store, policy protocol.CodeEntryPolicy, password string) room.CreatedRoom {
	t.Helper()
	if err := store.BeginCreateRoom(); err != nil {
		t.Fatalf("BeginCreateRoom: %v", err)
	}
	var material []byte
	var derived error
	if password != "" {
		material, derived = store.DeriveViewerPasswordMaterial(password, nil)
	}
	created, err := store.CreateRoom(policy, material, derived, "")
	if err != nil {
		t.Fatalf("CreateRoom: %v", err)
	}
	return created
}

func startHarness(t *testing.T, options harnessOptions) *harness {
	t.Helper()
	maxViewersPerRoom := orValue(options.maxViewersPerRoom, 8)
	store := options.store
	if store == nil {
		store = newStore(t, maxViewersPerRoom, nil)
	}
	var created room.CreatedRoom
	if options.room != nil {
		created = *options.room
	} else {
		created = createStoreRoom(t, store, protocol.CodeEntryOpen, "")
	}
	publicBaseURL, err := url.Parse("https://share.example.test")
	if err != nil {
		t.Fatal(err)
	}
	server, err := New(Options{
		Store:                     store,
		EndpointMediaCopyCapacity: orValue(options.endpointMediaCopyCapacity, 2),
		SfuFallback:               options.sfu,
		SfuOnly:                   options.sfuOnly,
		Ice: config.IceConfig(config.Config{
			STUNURLs:             options.stunURLs,
			NATPredictionEnabled: options.natPredictionEnabled,
		}),
		NATPredictionEnabled: options.natPredictionEnabled,
		AllowedOrigins:       map[string]struct{}{allowedOrigin: {}},
		SiteAccessAtUpgrade: func(request *http.Request) bool {
			return options.siteAccessPassword == "" ||
				strings.Contains(request.Header.Get("Cookie"), siteAccessCookie)
		},
		PublicBaseURL:                 publicBaseURL,
		Now:                           options.now,
		AuthenticationTimeoutMs:       orValue(options.authenticationTimeoutMs, 500),
		ViewerDisconnectGraceMs:       orValue(options.viewerDisconnectGraceMs, 50),
		HeartbeatIntervalMs:           60_000,
		RoomEmptyTimeoutMs:            options.roomEmptyTimeoutMs,
		MaxConnections:                options.maxSignalConnections,
		MaxUnauthenticatedConnections: options.maxUnauthenticatedSignalConnections,
		AfterFunc:                     options.afterFunc,
		Logger:                        slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		t.Fatalf("signal.New: %v", err)
	}
	httpServer := httptest.NewServer(server)
	h := &harness{
		t:      t,
		server: server,
		http:   httpServer,
		store:  store,
		room:   created,
		wsURL:  "ws" + strings.TrimPrefix(httpServer.URL, "http") + "/signal",
	}
	t.Cleanup(h.close)
	return h
}

// close is runningServer.close(): the signaling server first, then the
// listener and the store. It is idempotent so tests may close early.
func (h *harness) close() {
	if h.closed {
		return
	}
	h.closed = true
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := h.server.Close(ctx); err != nil {
		h.t.Errorf("server.Close: %v", err)
	}
	h.http.Close()
	if err := h.store.Close(); err != nil {
		h.t.Errorf("store.Close: %v", err)
	}
}

// locked runs fn under the server's mutex, which is how a test may touch the
// store while the server runs (the TS store was shared on one thread).
func (h *harness) locked(fn func()) {
	h.server.mu.Lock()
	defer h.server.mu.Unlock()
	fn()
}

func (h *harness) sessionCount() int {
	var count int
	h.locked(func() { count = h.server.sessions.Len() })
	return count
}

func (h *harness) storeSize() int {
	var size int
	h.locked(func() { size = h.store.Size() })
	return size
}

func (h *harness) updateRoomAccess(request protocol.RoomAccessUpdateRequest) protocol.RoomAccessUpdateResponse {
	h.t.Helper()
	response, err := h.server.UpdateRoomAccess(h.room.RoomID, h.room.HostToken, request)
	if err != nil {
		h.t.Fatalf("UpdateRoomAccess: %v", err)
	}
	return response
}

func (h *harness) createRoom(policy protocol.CodeEntryPolicy, password string) room.CreatedRoom {
	h.t.Helper()
	var roomPassword *string
	if password != "" {
		roomPassword = &password
	}
	created, err := h.server.CreateRoom(policy, roomPassword, "")
	if err != nil {
		h.t.Fatalf("CreateRoom: %v", err)
	}
	return created
}

func waitFor(t *testing.T, timeout time.Duration, condition func() bool) bool {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if condition() {
			return true
		}
		time.Sleep(5 * time.Millisecond)
	}
	return condition()
}

// expectGoroutinesSettled is the close tests' stand-in for the race detector
// (unavailable without cgo): every goroutine the server started (readers,
// writers, pings, pump drivers, drains, timer callbacks) must have exited,
// so the count returns to what it was before the harness started.
func expectGoroutinesSettled(t *testing.T, before int) {
	t.Helper()
	if waitFor(t, defaultWait, func() bool { return runtime.NumGoroutine() <= before }) {
		return
	}
	stacks := make([]byte, 1<<20)
	t.Fatalf("goroutines: %d before, %d after close\n%s",
		before, runtime.NumGoroutine(), stacks[:runtime.Stack(stacks, true)])
}

// ---------------------------------------------------------------------------
// client
// ---------------------------------------------------------------------------

type inbound struct {
	typ string
	raw []byte
}

type closeEvent struct {
	code   int
	reason string
}

// testClient is MessageInbox plus the socket.
type testClient struct {
	t    *testing.T
	conn *websocket.Conn

	mu           sync.Mutex
	messages     []inbound
	ignored      map[string]bool
	decodeErrors []string
	notify       chan struct{}
	closed       chan closeEvent
}

func dialClient(t *testing.T, wsURL, origin, cookie string) (*websocket.Conn, *http.Response, error) {
	t.Helper()
	header := http.Header{}
	header.Set("Origin", origin)
	if cookie != "" {
		header.Set("Cookie", cookie)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return websocket.Dial(ctx, wsURL, &websocket.DialOptions{HTTPHeader: header})
}

func openClient(t *testing.T, h *harness) *testClient {
	t.Helper()
	return openClientWithCookie(t, h, "")
}

func openClientWithCookie(t *testing.T, h *harness, cookie string) *testClient {
	t.Helper()
	conn, _, err := dialClient(t, h.wsURL, allowedOrigin, cookie)
	if err != nil {
		t.Fatalf("websocket.Dial: %v", err)
	}
	return newTestClient(t, conn)
}

func newTestClient(t *testing.T, conn *websocket.Conn) *testClient {
	t.Helper()
	conn.SetReadLimit(1 << 20)
	client := &testClient{
		t:       t,
		conn:    conn,
		ignored: map[string]bool{},
		notify:  make(chan struct{}, 1),
		closed:  make(chan closeEvent, 1),
	}
	go client.readLoop()
	t.Cleanup(func() {
		client.mu.Lock()
		defer client.mu.Unlock()
		for _, failure := range client.decodeErrors {
			t.Error(failure)
		}
	})
	return client
}

func (c *testClient) readLoop() {
	for {
		_, data, err := c.conn.Read(context.Background())
		if err != nil {
			event := closeEvent{code: -1, reason: err.Error()}
			var closeError websocket.CloseError
			if errors.As(err, &closeError) {
				event = closeEvent{code: int(closeError.Code), reason: closeError.Reason}
			}
			c.closed <- event
			return
		}
		var probe struct {
			Type string `json:"type"`
		}
		_ = json.Unmarshal(data, &probe)
		c.mu.Lock()
		// TS: decodeServerMessage(data) validates every server message.
		if _, err := protocol.DecodeServerMessage(data); err != nil {
			c.decodeErrors = append(c.decodeErrors,
				fmt.Sprintf("server message %q failed the wire schema: %v", probe.Type, err))
		}
		if !c.ignored[probe.Type] {
			c.messages = append(c.messages, inbound{typ: probe.Type, raw: data})
		}
		c.mu.Unlock()
		select {
		case c.notify <- struct{}{}:
		default:
		}
	}
}

func (c *testClient) sendText(text string) {
	c.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := c.conn.Write(ctx, websocket.MessageText, []byte(text)); err != nil {
		c.t.Fatalf("write: %v", err)
	}
}

func (c *testClient) sendJSON(message map[string]any) {
	c.t.Helper()
	encoded, err := json.Marshal(message)
	if err != nil {
		c.t.Fatal(err)
	}
	c.sendText(string(encoded))
}

func (c *testClient) tryNext(typ string, timeout time.Duration) (inbound, bool) {
	deadline := time.Now().Add(timeout)
	for {
		c.mu.Lock()
		for index, message := range c.messages {
			if message.typ == typ {
				c.messages = slices.Delete(c.messages, index, index+1)
				c.mu.Unlock()
				return message, true
			}
		}
		c.mu.Unlock()
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return inbound{}, false
		}
		select {
		case <-c.notify:
		case <-time.After(remaining):
		}
	}
}

// next is inbox.next(type): the first buffered message of that type, or the
// next one to arrive.
func (c *testClient) next(typ string) inbound {
	c.t.Helper()
	return c.nextWithin(typ, defaultWait)
}

func (c *testClient) nextWithin(typ string, timeout time.Duration) inbound {
	c.t.Helper()
	message, ok := c.tryNext(typ, timeout)
	if !ok {
		c.t.Fatalf("Timed out waiting for %s", typ)
	}
	return message
}

// expectNone is inbox.expectNone(timeoutMs).
func (c *testClient) expectNone(timeout time.Duration) {
	c.t.Helper()
	check := func() {
		c.mu.Lock()
		defer c.mu.Unlock()
		if len(c.messages) > 0 {
			c.t.Fatalf("Unexpected message: %s", c.messages[0].typ)
		}
	}
	check()
	time.Sleep(timeout)
	check()
}

// ignore is inbox.ignore(type).
func (c *testClient) ignore(typ string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.ignored[typ] = true
	c.messages = slices.DeleteFunc(c.messages, func(message inbound) bool { return message.typ == typ })
}

// closeCode waits for the socket's close event.
func (c *testClient) closeCode() closeEvent {
	c.t.Helper()
	select {
	case event := <-c.closed:
		c.closed <- event
		return event
	case <-time.After(defaultWait):
		c.t.Fatalf("Timed out waiting for the socket to close")
		return closeEvent{}
	}
}

func (c *testClient) isClosed() bool {
	select {
	case event := <-c.closed:
		c.closed <- event
		return true
	default:
		return false
	}
}

// closeClient is closeClient(): a client-initiated close that also waits
// for the server to have run handleDisconnect, which the single-threaded TS
// tests sequenced through later messages.
func (h *harness) closeClient(c *testClient) {
	h.t.Helper()
	if c.isClosed() {
		return
	}
	before := h.sessionCount()
	_ = c.conn.Close(websocket.StatusNormalClosure, "")
	c.closeCode()
	if !waitFor(h.t, defaultWait, func() bool { return h.sessionCount() < before }) {
		h.t.Fatalf("server did not release the closed session")
	}
}

func rejectedUpgradeStatus(t *testing.T, h *harness, origin string) int {
	t.Helper()
	conn, response, err := dialClient(t, h.wsURL, origin, "")
	if err == nil {
		_ = conn.CloseNow()
		t.Fatalf("WebSocket upgrade unexpectedly succeeded")
	}
	if response == nil {
		t.Fatalf("upgrade failed without an HTTP response: %v", err)
	}
	return response.StatusCode
}

func rawUpgradeResponse(t *testing.T, h *harness, requestTarget string) string {
	t.Helper()
	parsed, err := url.Parse(h.wsURL)
	if err != nil {
		t.Fatal(err)
	}
	conn, err := net.DialTimeout("tcp", parsed.Host, 2*time.Second)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(2 * time.Second))
	request := strings.Join([]string{
		"GET " + requestTarget + " HTTP/1.1",
		"Host: " + parsed.Host,
		"Upgrade: websocket",
		"Connection: Upgrade",
		"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
		"Sec-WebSocket-Version: 13",
		"Origin: " + allowedOrigin,
		"",
		"",
	}, "\r\n")
	if _, err := conn.Write([]byte(request)); err != nil {
		t.Fatalf("write: %v", err)
	}
	response, _ := io.ReadAll(conn)
	return string(response)
}

// ---------------------------------------------------------------------------
// JSON assertions (expect(...).toEqual / toMatchObject on decoded JSON)
// ---------------------------------------------------------------------------

func jsonValue(t *testing.T, raw []byte) any {
	t.Helper()
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		t.Fatalf("invalid JSON %s: %v", raw, err)
	}
	return value
}

func jsonObject(t *testing.T, raw []byte) map[string]any {
	t.Helper()
	object, ok := jsonValue(t, raw).(map[string]any)
	if !ok {
		t.Fatalf("expected a JSON object, got %s", raw)
	}
	return object
}

// matches is toMatchObject: objects are subset-matched recursively, arrays
// must have equal length with matching elements, scalars must be equal.
func matches(actual, expected any) bool {
	switch expected := expected.(type) {
	case map[string]any:
		actualObject, ok := actual.(map[string]any)
		if !ok {
			return false
		}
		for key, value := range expected {
			actualValue, present := actualObject[key]
			if !present || !matches(actualValue, value) {
				return false
			}
		}
		return true
	case []any:
		actualList, ok := actual.([]any)
		if !ok || len(actualList) != len(expected) {
			return false
		}
		for index := range expected {
			if !matches(actualList[index], expected[index]) {
				return false
			}
		}
		return true
	}
	return reflect.DeepEqual(actual, expected)
}

func expectEqual(t *testing.T, raw []byte, expected string) {
	t.Helper()
	if !reflect.DeepEqual(jsonValue(t, raw), jsonValue(t, []byte(expected))) {
		t.Fatalf("expected exactly %s\ngot %s", expected, raw)
	}
}

func expectMatch(t *testing.T, raw []byte, expected string) {
	t.Helper()
	if !matches(jsonValue(t, raw), jsonValue(t, []byte(expected))) {
		t.Fatalf("expected a match of %s\ngot %s", expected, raw)
	}
}

func hasKey(t *testing.T, raw []byte, key string) bool {
	t.Helper()
	_, present := jsonObject(t, raw)[key]
	return present
}

// ---------------------------------------------------------------------------
// typed views of the messages the tests inspect
// ---------------------------------------------------------------------------

type authenticatedMessage struct {
	PeerID          string               `json:"peerId"`
	HostOnline      bool                 `json:"hostOnline"`
	HostPaused      *bool                `json:"hostPaused"`
	ConnectionID    *string              `json:"connectionId"`
	RoutePolicy     protocol.RoutePolicy `json:"routePolicy"`
	RouteRevision   int64                `json:"routeRevision"`
	RouteAssignment struct {
		Upstream protocol.MediaRouteUpstream `json:"upstream"`
	} `json:"routeAssignment"`
	QualitySettings               json.RawMessage `json:"qualitySettings"`
	ViewerAuthorizationGeneration string          `json:"viewerAuthorizationGeneration"`
	MaxViewers                    int             `json:"maxViewers"`
	ShareGeneration               *string         `json:"shareGeneration"`
	Role                          string          `json:"role"`
	CodeEntryPolicy               string          `json:"codeEntryPolicy"`
	IceConfig                     json.RawMessage `json:"iceConfig"`
	raw                           []byte
}

func parseAuthenticated(t *testing.T, raw []byte) authenticatedMessage {
	t.Helper()
	var message authenticatedMessage
	if err := json.Unmarshal(raw, &message); err != nil {
		t.Fatalf("authenticated: %v (%s)", err, raw)
	}
	message.raw = raw
	return message
}

type routeUpdate struct {
	Revision   int64  `json:"revision"`
	Phase      string `json:"phase"`
	Assignment struct {
		Upstream     protocol.MediaRouteUpstream `json:"upstream"`
		ChildPeerIDs []string                    `json:"childPeerIds"`
	} `json:"assignment"`
	Candidate struct {
		ChildPeerID  string `json:"childPeerId"`
		ConnectionID string `json:"connectionId"`
		Transport    string `json:"transport"`
		QualityProbe bool   `json:"qualityProbe"`
	} `json:"candidate"`
	raw []byte
}

func parseRouteUpdate(t *testing.T, raw []byte) routeUpdate {
	t.Helper()
	var message routeUpdate
	if err := json.Unmarshal(raw, &message); err != nil {
		t.Fatalf("route-update: %v (%s)", err, raw)
	}
	message.raw = raw
	return message
}

type presenceEntry struct {
	Role        string                      `json:"role"`
	PeerID      string                      `json:"peerId"`
	DisplayName string                      `json:"displayName"`
	Upstream    protocol.MediaRouteUpstream `json:"upstream"`
	MediaReady  *bool                       `json:"mediaReady,omitempty"`
}

type presenceMessage struct {
	Viewers []presenceEntry `json:"viewers"`
	raw     []byte
}

func parsePresence(t *testing.T, raw []byte) presenceMessage {
	t.Helper()
	var message presenceMessage
	if err := json.Unmarshal(raw, &message); err != nil {
		t.Fatalf("viewer-presence: %v (%s)", err, raw)
	}
	message.raw = raw
	return message
}

func viewerPresenceEntries(message presenceMessage) []presenceEntry {
	var viewers []presenceEntry
	for _, entry := range message.Viewers {
		if entry.Role == protocol.RoleViewer {
			viewers = append(viewers, entry)
		}
	}
	return viewers
}

// viewerEntriesJSON re-encodes viewerPresenceEntries(message) so the TS
// assertions on that filtered list can use the JSON matchers.
func viewerEntriesJSON(t *testing.T, message presenceMessage) []byte {
	t.Helper()
	entries := viewerPresenceEntries(message)
	if entries == nil {
		entries = []presenceEntry{}
	}
	encoded, err := json.Marshal(entries)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func hostPresenceEntry(message presenceMessage) *presenceEntry {
	for _, entry := range message.Viewers {
		if entry.Role == protocol.RoleHost {
			return &entry
		}
	}
	return nil
}

func displayNames(entries []presenceEntry) []string {
	names := []string{}
	for _, entry := range entries {
		names = append(names, entry.DisplayName)
	}
	return names
}

func peerIDs(entries []presenceEntry) []string {
	ids := []string{}
	for _, entry := range entries {
		ids = append(ids, entry.PeerID)
	}
	return ids
}

func isMediaReady(entry presenceEntry) bool {
	return entry.MediaReady != nil && *entry.MediaReady
}

// ---------------------------------------------------------------------------
// protocol helpers (authenticate, routes, presence, evidence)
// ---------------------------------------------------------------------------

type presenceOptions struct {
	routePreference *protocol.ViewerRoutePreference
	displayName     string
	viewerPresence  bool
	viewerPassword  string
	codeOnly        bool
	sharingPaused   *bool
	qualitySettings map[string]any
	routePolicy     *protocol.RoutePolicy
	roomSession     bool
	roomOnly        bool
}

// authenticate ports the authenticate() helper. relayCapacity -1 is the TS
// null (no relay-capacity message after the authenticated reply).
func authenticate(
	t *testing.T,
	client *testClient,
	rm room.CreatedRoom,
	role protocol.Role,
	clientID string,
	relayCapacity int,
	shareGeneration string,
	presence presenceOptions,
) authenticatedMessage {
	t.Helper()
	message := map[string]any{
		"type":     "authenticate",
		"protocol": protocol.SignalingProtocol,
		"roomId":   rm.RoomID,
		"role":     role,
		"clientId": clientID,
	}
	if role == protocol.RoleHost {
		message["token"] = rm.HostToken
		if shareGeneration != "" {
			message["shareGeneration"] = shareGeneration
		}
		if presence.roomSession {
			message["roomSession"] = true
		}
		if presence.roomOnly {
			message["roomOnly"] = true
		}
		if presence.sharingPaused != nil {
			message["sharingPaused"] = *presence.sharingPaused
		}
		if presence.qualitySettings != nil {
			message["qualitySettings"] = presence.qualitySettings
		}
		if presence.routePolicy != nil {
			message["routePolicy"] = *presence.routePolicy
		}
		if presence.viewerPresence {
			message["viewerPresence"] = true
		}
		if presence.displayName != "" {
			message["displayName"] = presence.displayName
		}
	} else {
		if presence.viewerPassword != "" {
			message["viewerPassword"] = presence.viewerPassword
		} else if !presence.codeOnly && rm.ViewerGrant != "" {
			message["viewerGrant"] = rm.ViewerGrant
		}
		if presence.displayName != "" {
			message["displayName"] = presence.displayName
		}
		if presence.viewerPresence {
			message["viewerPresence"] = true
		}
		if presence.routePreference != nil {
			message["routePreference"] = *presence.routePreference
		}
	}
	client.sendJSON(message)
	authenticated := parseAuthenticated(t, client.next("authenticated").raw)
	if role == protocol.RoleViewer && relayCapacity >= 0 {
		client.sendJSON(map[string]any{"type": "relay-capacity", "downstreamEdges": relayCapacity})
	}
	return authenticated
}

func boolPointer(value bool) *bool { return &value }

func nextPreparedRoute(t *testing.T, client *testClient) routeUpdate {
	t.Helper()
	for {
		message := parseRouteUpdate(t, client.next("route-update").raw)
		if message.Phase == "prepare" {
			return message
		}
	}
}

func nextActiveRouteRevision(t *testing.T, client *testClient, revision int64) routeUpdate {
	t.Helper()
	for {
		message := parseRouteUpdate(t, client.next("route-update").raw)
		if message.Phase == "active" && message.Revision == revision {
			return message
		}
	}
}

func nextActiveRouteAfter(t *testing.T, client *testClient, revision int64) routeUpdate {
	t.Helper()
	for {
		message := parseRouteUpdate(t, client.next("route-update").raw)
		if message.Phase == "active" && message.Revision > revision {
			return message
		}
	}
}

func commitPreparedRoute(t *testing.T, client *testClient) routeUpdate {
	t.Helper()
	prepared := nextPreparedRoute(t, client)
	client.sendJSON(map[string]any{
		"type":         "route-transport-connected",
		"revision":     prepared.Revision,
		"connectionId": prepared.Candidate.ConnectionID,
	})
	client.sendJSON(map[string]any{
		"type":     "route-ready",
		"revision": prepared.Revision,
		"phase":    "prepare",
	})
	return nextActiveRouteRevision(t, client, prepared.Revision)
}

func nextViewerPresenceMatching(t *testing.T, client *testClient, predicate func(presenceMessage) bool) presenceMessage {
	t.Helper()
	for attempt := 0; attempt < 20; attempt++ {
		message := parsePresence(t, client.next("viewer-presence").raw)
		if predicate(message) {
			return message
		}
	}
	t.Fatalf("Viewer presence did not reach the expected state")
	return presenceMessage{}
}

func expectNoViewerPresenceMatching(t *testing.T, client *testClient, predicate func(presenceMessage) bool, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		message, ok := client.tryNext("viewer-presence", time.Until(deadline))
		if !ok {
			return
		}
		if predicate(parsePresence(t, message.raw)) {
			t.Fatalf("Viewer presence reached a forbidden state: %s", message.raw)
		}
	}
}

func viewerQualityEvidenceMessage(connectionID string, routeRevision, sequence, presentationEpoch int64) map[string]any {
	return map[string]any{
		"type": "viewer-quality-evidence",
		"guard": map[string]any{
			"connectionId":      connectionID,
			"routeRevision":     routeRevision,
			"presentationEpoch": presentationEpoch,
		},
		"sequence": sequence,
		"windowMs": 2_000,
		"metrics": map[string]any{
			"natTraversalPath":             "ordinary",
			"width":                        1_920,
			"height":                       1_080,
			"framesPerSecond":              60,
			"bitrateKbps":                  7_500,
			"packetsReceivedDelta":         1_500,
			"packetsLostDelta":             2,
			"rttMs":                        18,
			"jitterMs":                     3.5,
			"framesDecodedDelta":           120,
			"framesDroppedDelta":           1,
			"decodeMsPerFrame":             2.4,
			"freezeCountDelta":             0,
			"freezeDurationMsDelta":        0,
			"pauseCountDelta":              0,
			"pauseDurationMsDelta":         0,
			"codec":                        "video/VP8",
			"codecProfile":                 nil,
			"codecParameters":              nil,
			"audioBitrateKbps":             192,
			"audioPacketLossPercent":       0.2,
			"audioJitterMs":                2.5,
			"audioVideoPlayoutDeltaMs":     -12.5,
			"videoJitterBufferDelayMs":     24,
			"audioJitterBufferDelayMs":     18,
			"audioConcealedSamplesPercent": 1,
			"audioConcealmentEventsDelta":  3,
			"audioCodec":                   "audio/opus",
		},
	}
}

func signalDescription(targetPeerID, connectionID, descriptionType string) map[string]any {
	return map[string]any{
		"type":         "signal",
		"targetPeerId": targetPeerID,
		"payload": map[string]any{
			"kind":         "description",
			"connectionId": connectionID,
			"description":  map[string]any{"type": descriptionType, "sdp": "v=0\r\n"},
		},
	}
}

func signalCandidate(targetPeerID, connectionID string) map[string]any {
	return map[string]any{
		"type":         "signal",
		"targetPeerId": targetPeerID,
		"payload": map[string]any{
			"kind":         "candidate",
			"connectionId": connectionID,
			"candidate":    nil,
		},
	}
}

func utcMillis(year int, month time.Month, day, hour int) int64 {
	return time.Date(year, month, day, hour, 0, 0, 0, time.UTC).UnixMilli()
}

type clock struct{ ms atomic.Int64 }

func newClock(start int64) *clock {
	c := &clock{}
	c.ms.Store(start)
	return c
}

func (c *clock) now() int64            { return c.ms.Load() }
func (c *clock) advance(deltaMs int64) { c.ms.Add(deltaMs) }

func expectClose(t *testing.T, client *testClient, code int, reason string) {
	t.Helper()
	event := client.closeCode()
	if event.code != code || event.reason != reason {
		t.Fatalf("expected close {%d %q}, got {%d %q}", code, reason, event.code, event.reason)
	}
}

func expectCloseCode(t *testing.T, client *testClient, code int) {
	t.Helper()
	if event := client.closeCode(); event.code != code {
		t.Fatalf("expected close code %d, got {%d %q}", code, event.code, event.reason)
	}
}

func expectString(t *testing.T, name, actual, expected string) {
	t.Helper()
	if actual != expected {
		t.Fatalf("%s: expected %q, got %q", name, expected, actual)
	}
}

func expectStrings(t *testing.T, name string, actual, expected []string) {
	t.Helper()
	if !slices.Equal(actual, expected) {
		t.Fatalf("%s: expected %q, got %q", name, expected, actual)
	}
}

func expectTrue(t *testing.T, name string, condition bool) {
	t.Helper()
	if !condition {
		t.Fatalf("%s", name)
	}
}

// ---------------------------------------------------------------------------
// route policy and ICE
// ---------------------------------------------------------------------------

func TestSignalEchoesExactPerShareRoutePolicyAuthority(t *testing.T) {
	for _, sfuEnabled := range []bool{false, true} {
		for _, peerOnly := range []bool{false, true} {
			t.Run(fmt.Sprintf("sfu=%t/peerOnly=%t", sfuEnabled, peerOnly), func(t *testing.T) {
				options := harnessOptions{natPredictionEnabled: true}
				if sfuEnabled {
					options.sfu = &SfuFallback{
						Media:     sfutest.New(),
						Admission: sfu.NewAdmission(sfu.AdmissionOptions{IngressCapacity: 2, EgressCapacity: 20}),
					}
				}
				h := startHarness(t, options)
				viewer := openClient(t, h)
				waiting := authenticate(t, viewer, h.room, protocol.RoleViewer, "route-policy-viewer", 1, "", presenceOptions{})
				if waiting.ShareGeneration != nil || waiting.RoutePolicy.PeerOnly != !sfuEnabled {
					t.Fatalf("waiting policy: %+v", waiting.RoutePolicy)
				}
				host := openClient(t, h)
				requested := protocol.RoutePolicy{PeerOnly: peerOnly, TopologyOptimization: true, NatPrediction: true}
				expected := requested
				expected.PeerOnly = !sfuEnabled || peerOnly
				authenticated := authenticate(t, host, h.room, protocol.RoleHost, "route-policy-host", 1,
					"route_policy_share_generation_12345678", presenceOptions{routePolicy: &requested})
				if authenticated.RoutePolicy != expected {
					t.Fatalf("routePolicy: %+v; want %+v", authenticated.RoutePolicy, expected)
				}
				expectTrue(t, "sfuStandbyUrl must be absent", !hasKey(t, authenticated.raw, "sfuStandbyUrl"))
				expectEqual(t, viewer.next("route-policy").raw, fmt.Sprintf(
					`{"type":"route-policy","shareGeneration":"route_policy_share_generation_12345678","routePolicy":{"peerOnly":%t,"topologyOptimization":true,"natPrediction":true}}`, expected.PeerOnly))
			})
		}
	}
}

func TestSignalBroadcastsConfiguredNatPredictionInLightweightRooms(t *testing.T) {
	h := startHarness(t, harnessOptions{
		stunURLs:             []string{"stun:share.example.test:3478"},
		natPredictionEnabled: true,
	})
	waitingViewer := openClient(t, h)
	waiting := authenticate(t, waitingViewer, h.room, protocol.RoleViewer, "ordinary-nat-waiting-viewer", -1, "", presenceOptions{})
	expectTrue(t, "waiting natPrediction must be false", !waiting.RoutePolicy.NatPrediction)

	host := openClient(t, h)
	routePolicy := protocol.DefaultRoutePolicy
	routePolicy.NatPrediction = true
	hostAuth := authenticate(t, host, h.room, protocol.RoleHost, "ordinary-nat-host", -1,
		"ordinary_nat_share_generation_12345678", presenceOptions{routePolicy: &routePolicy})
	routePolicy.PeerOnly = true
	if hostAuth.RoutePolicy != routePolicy {
		t.Fatalf("routePolicy: %+v", hostAuth.RoutePolicy)
	}
	expectMatch(t, waitingViewer.next("route-policy").raw,
		`{"routePolicy":{"peerOnly":true,"topologyOptimization":true,"natPrediction":true}}`)

	joiningViewer := openClient(t, h)
	joined := authenticate(t, joiningViewer, h.room, protocol.RoleViewer, "ordinary-nat-joining-viewer", -1, "", presenceOptions{})
	if joined.RoutePolicy != routePolicy {
		t.Fatalf("joined routePolicy: %+v", joined.RoutePolicy)
	}
}

func TestSignalClampsNatPredictionOffWhenServerCapabilityIsDisabled(t *testing.T) {
	h := startHarness(t, harnessOptions{})
	host := openClient(t, h)
	routePolicy := protocol.DefaultRoutePolicy
	routePolicy.NatPrediction = true
	authenticated := authenticate(t, host, h.room, protocol.RoleHost, "disabled-nat-host", -1,
		"disabled_nat_share_generation_12345678", presenceOptions{routePolicy: &routePolicy})
	expectTrue(t, "natPrediction must be clamped off", !authenticated.RoutePolicy.NatPrediction)
}

func TestSignalDeliversOnlySelfHostedAuxiliaryNatStunEndpoints(t *testing.T) {
	h := startHarness(t, harnessOptions{
		stunURLs:             []string{"stun:ordinary.example.test:3478"},
		natPredictionEnabled: true,
	})
	viewer := openClient(t, h)
	authenticated := authenticate(t, viewer, h.room, protocol.RoleViewer, "nat-auxiliary-viewer", -1, "", presenceOptions{})
	expectEqual(t, authenticated.IceConfig,
		`{"iceServers":[{"urls":["stun:ordinary.example.test:3478"]}],"natPredictionStunUrls":["stun:ordinary.example.test:3479","stun:ordinary.example.test:3480"]}`)
}

// ---------------------------------------------------------------------------
// lifecycle and restart
// ---------------------------------------------------------------------------

func TestConnectionAttemptProgressMatchesBothRecipients(t *testing.T) {
	h := startHarness(t, harnessOptions{natPredictionEnabled: true,
		stunURLs: []string{"stun:share.example.test:3478"}})
	host, viewer := openClient(t, h), openClient(t, h)
	policy := protocol.RoutePolicy{PeerOnly: true, NatPrediction: true}
	authenticate(t, host, h.room, protocol.RoleHost, "progress-host", 1, "progress_share_generation_12345678",
		presenceOptions{routePolicy: &policy})
	authenticate(t, viewer, h.room, protocol.RoleViewer, "progress-viewer", 0, "", presenceOptions{})
	for current := 1; current <= 4; current++ {
		hostPrepare, viewerPrepare := nextPreparedRoute(t, host), nextPreparedRoute(t, viewer)
		for _, update := range []routeUpdate{hostPrepare, viewerPrepare} {
			decoded, err := protocol.DecodeServerMessage(update.raw)
			if err != nil {
				t.Fatal(err)
			}
			progress := decoded.(protocol.RouteUpdatePrepareMessage).Candidate.ConnectionAttempt
			if progress == nil || *progress != (protocol.ConnectionAttempt{Current: protocol.Int(current), Total: 4}) {
				t.Fatalf("progress = %+v", progress)
			}
		}
		if hostPrepare.Candidate.ConnectionID != viewerPrepare.Candidate.ConnectionID {
			t.Fatal("recipients disagree on the candidate")
		}
		viewer.sendJSON(map[string]any{"type": "route-failed", "phase": "prepare",
			"revision": viewerPrepare.Revision, "connectionId": viewerPrepare.Candidate.ConnectionID})
	}
}

func TestSignalRebuildsRouteWhenViewerReconnectsBeforeHostAfterRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rooms.sqlite")
	firstDatabase, err := room.NewDatabase(path)
	if err != nil {
		t.Fatal(err)
	}
	firstStore := newStore(t, 8, firstDatabase)
	rm := createStoreRoom(t, firstStore, protocol.CodeEntryOpen, "")
	first := startHarness(t, harnessOptions{store: firstStore, room: &rm})
	firstHost := openClient(t, first)
	authenticate(t, firstHost, rm, protocol.RoleHost, "restart-route-host", 1, "restart_share_generation_12345678", presenceOptions{})
	firstViewer := openClient(t, first)
	authenticate(t, firstViewer, rm, protocol.RoleViewer, "restart-route-viewer", 1, "", presenceOptions{})
	nextPreparedRoute(t, firstViewer)

	first.close()

	secondDatabase, err := room.NewDatabase(path)
	if err != nil {
		t.Fatal(err)
	}
	secondStore := newStore(t, 8, secondDatabase)
	second := startHarness(t, harnessOptions{store: secondStore, room: &rm})
	secondViewer := openClient(t, second)
	viewerAuth := authenticate(t, secondViewer, rm, protocol.RoleViewer, "restart-route-viewer", 1, "", presenceOptions{})
	expectString(t, "viewer upstream", viewerAuth.RouteAssignment.Upstream.Kind, "none")

	secondHost := openClient(t, second)
	authenticate(t, secondHost, rm, protocol.RoleHost, "restart-route-host", 1, "restart_share_generation_12345678", presenceOptions{})
	viewerPrepare := nextPreparedRoute(t, secondViewer)
	hostPrepare := nextPreparedRoute(t, secondHost)
	if viewerPrepare.Revision != hostPrepare.Revision || viewerPrepare.Candidate != hostPrepare.Candidate {
		t.Fatalf("viewer prepare %s\nhost prepare %s", viewerPrepare.raw, hostPrepare.raw)
	}
}

func TestSignalIdentifiesGracefulServiceRestartToConnectedClients(t *testing.T) {
	before := runtime.NumGoroutine()
	h := startHarness(t, harnessOptions{})
	host := openClient(t, h)
	authenticate(t, host, h.room, protocol.RoleHost, "restart-host", 1, "", presenceOptions{})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	shutdown := make(chan error, 1)
	go func() { shutdown <- h.server.Close(ctx) }()

	expectClose(t, host, 1012, "Service restart")
	if err := <-shutdown; err != nil {
		t.Fatalf("Close: %v", err)
	}
	h.close()
	expectGoroutinesSettled(t, before)
}

// TS signaling.ts:251-256: forceCloseTimer terminates every client that has
// not finished the close handshake one second after close() began, however
// many there are; the library's own handshake timeout (5 s) never decides.
func TestSignalCloseTerminatesUnresponsiveClientsAfterOneSecondGrace(t *testing.T) {
	before := runtime.NumGoroutine()
	h := startHarness(t, harnessOptions{authenticationTimeoutMs: 60_000})
	var conns []*websocket.Conn
	for range 2 {
		// Never read: the close frame is never answered.
		conn, _, err := dialClient(t, h.wsURL, allowedOrigin, "")
		if err != nil {
			t.Fatalf("websocket.Dial: %v", err)
		}
		conns = append(conns, conn)
	}
	if !waitFor(t, defaultWait, func() bool { return h.sessionCount() == 2 }) {
		t.Fatalf("sessions = %d, want 2", h.sessionCount())
	}

	started := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := h.server.Close(ctx); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if elapsed := time.Since(started); elapsed < serviceRestartCloseGrace || elapsed > 3*time.Second {
		t.Fatalf("Close took %v, want the one-second grace", elapsed)
	}
	for _, conn := range conns {
		_ = conn.CloseNow()
	}
	h.close()
	expectGoroutinesSettled(t, before)
}

func TestSignalEndsEveryRoomBeforeLocalAuthorityStops(t *testing.T) {
	before := runtime.NumGoroutine()
	h := startHarness(t, harnessOptions{})
	host := openClient(t, h)
	authenticate(t, host, h.room, protocol.RoleHost, "ending-host", 1, "", presenceOptions{})
	viewer := openClient(t, h)
	authenticate(t, viewer, h.room, protocol.RoleViewer, "ending-viewer", 1, "", presenceOptions{})

	// TS: server.end() = endAllRooms() then close().
	if err := h.server.EndAllRooms(); err != nil {
		t.Fatalf("EndAllRooms: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	shutdown := make(chan error, 1)
	go func() { shutdown <- h.server.Close(ctx) }()

	expectEqual(t, host.next("room-closed").raw, `{"type":"room-closed","reason":"host-ended"}`)
	expectEqual(t, viewer.next("room-closed").raw, `{"type":"room-closed","reason":"host-ended"}`)
	expectClose(t, host, 1000, "Room abandoned")
	expectClose(t, viewer, 1000, "Room abandoned")
	if err := <-shutdown; err != nil {
		t.Fatalf("Close: %v", err)
	}
	if size := h.storeSize(); size != 0 {
		t.Fatalf("store size %d", size)
	}
	h.close()
	expectGoroutinesSettled(t, before)
}

// ---------------------------------------------------------------------------
// challenge and diagnostics
// ---------------------------------------------------------------------------

func TestSignalAnswersOnlyOptedInCurrentSocketsAndRateLimitsEachSocket(t *testing.T) {
	now := newClock(time.Now().UnixMilli())
	h := startHarness(t, harnessOptions{now: now.now})
	host := openClient(t, h)
	hostAuth := authenticate(t, host, h.room, protocol.RoleHost, "challenge-host", 1, "", presenceOptions{})
	nextActiveRouteRevision(t, host, hostAuth.RouteRevision)

	host.sendJSON(map[string]any{"type": "signaling-challenge", "sequence": 7})
	expectEqual(t, host.next("signaling-challenge-response").raw,
		`{"type":"signaling-challenge-response","sequence":7}`)

	host.sendJSON(map[string]any{"type": "signaling-challenge", "sequence": 8})
	host.expectNone(40 * time.Millisecond)

	now.advance(1_000)
	host.sendJSON(map[string]any{"type": "signaling-challenge", "sequence": 9})
	expectEqual(t, host.next("signaling-challenge-response").raw,
		`{"type":"signaling-challenge-response","sequence":9}`)
}

func TestSignalServesOneCurrentRouteSnapshotOnlyToAuthenticatedHost(t *testing.T) {
	h := startHarness(t, harnessOptions{})
	host := openClient(t, h)
	authenticate(t, host, h.room, protocol.RoleHost, "route-diagnostic-host", 1, "", presenceOptions{})
	viewer := openClient(t, h)
	authenticate(t, viewer, h.room, protocol.RoleViewer, "route-diagnostic-viewer", 1, "", presenceOptions{})

	host.sendJSON(map[string]any{"type": "request-route-diagnostic"})
	expectMatch(t, host.next("route-diagnostic-snapshot").raw,
		`{"snapshot":{"children":[{"ordinal":1,"finalRoute":"waiting"}]}}`)

	viewer.sendJSON(map[string]any{"type": "request-route-diagnostic"})
	expectMatch(t, viewer.next("error").raw, `{"code":"FORBIDDEN"}`)
}

// ---------------------------------------------------------------------------
// native wire compatibility
// ---------------------------------------------------------------------------

func TestSignalKeepsExactNativeHostWireUnchangedWithoutPresenceOptIn(t *testing.T) {
	h := startHarness(t, harnessOptions{})
	host := openClient(t, h)
	authenticate(t, host, h.room, protocol.RoleHost, "native-compatible-host", 1, "", presenceOptions{})
	viewer := openClient(t, h)
	authenticate(t, viewer, h.room, protocol.RoleViewer, "native-compatible-viewer", 1, "",
		presenceOptions{displayName: "移动观众"})
	hostPrepared := nextPreparedRoute(t, host)
	viewerActive := commitPreparedRoute(t, viewer)
	if hostPrepared.Revision != viewerActive.Revision {
		t.Fatalf("host prepare revision %d, viewer active revision %d", hostPrepared.Revision, viewerActive.Revision)
	}
	nextActiveRouteRevision(t, host, viewerActive.Revision)
	host.expectNone(40 * time.Millisecond)

	host.sendJSON(map[string]any{"type": "set-display-name", "displayName": "Native 不应改名"})
	expectMatch(t, host.next("error").raw, `{"code":"FORBIDDEN"}`)
	host.expectNone(40 * time.Millisecond)
}

// ---------------------------------------------------------------------------
// password and code entry
// ---------------------------------------------------------------------------

func sendPasswordAuthenticate(client *testClient, rm room.CreatedRoom, clientID, password string) {
	client.sendJSON(map[string]any{
		"type":           "authenticate",
		"protocol":       protocol.SignalingProtocol,
		"roomId":         rm.RoomID,
		"role":           protocol.RoleViewer,
		"clientId":       clientID,
		"viewerPassword": password,
	})
}

func TestSignalKeepsPasswordOptionalForPrivateRoomEntry(t *testing.T) {
	h := startHarness(t, harnessOptions{})
	host := openClient(t, h)
	authenticate(t, host, h.room, protocol.RoleHost, "password-settings-host", 1, "", presenceOptions{})

	updated := h.updateRoomAccess(protocol.SetCodeEntryPolicyRequest{Action: "set-code-entry-policy", Policy: protocol.CodeEntryPrivate})
	if !reflect.DeepEqual(updated, protocol.CodeEntryPolicyUpdatedResponse{
		Type: "code-entry-policy-updated", CodeEntryPolicy: protocol.CodeEntryPrivate, ViewerPasswordEnabled: false,
	}) {
		t.Fatalf("code entry update: %+v", updated)
	}

	wrongViewer := openClient(t, h)
	sendPasswordAuthenticate(wrongViewer, h.room, "wrong-password-viewer", "wrong-password")
	expectMatch(t, wrongViewer.next("error").raw, `{"code":"ROOM_ACCESS_DENIED"}`)

	password := "easy-password"
	enabled := h.updateRoomAccess(protocol.SetViewerPasswordRequest{Action: "set-viewer-password", Password: &password})
	if !reflect.DeepEqual(enabled, protocol.ViewerPasswordUpdatedResponse{Type: "viewer-password-updated", Enabled: true}) {
		t.Fatalf("password update: %+v", enabled)
	}

	passwordViewer := openClient(t, h)
	admitted := authenticate(t, passwordViewer, h.room, protocol.RoleViewer, "password-viewer", 1, "",
		presenceOptions{viewerPassword: "easy-password"})
	expectString(t, "role", admitted.Role, protocol.RoleViewer)
	commitPreparedRoute(t, passwordViewer)

	disabled := h.updateRoomAccess(protocol.SetViewerPasswordRequest{Action: "set-viewer-password", Password: nil})
	if !reflect.DeepEqual(disabled, protocol.ViewerPasswordUpdatedResponse{Type: "viewer-password-updated", Enabled: false}) {
		t.Fatalf("password removal: %+v", disabled)
	}

	grantViewer := openClient(t, h)
	granted := authenticate(t, grantViewer, h.room, protocol.RoleViewer, "grant-after-password-removal", 1, "", presenceOptions{})
	expectString(t, "role", granted.Role, protocol.RoleViewer)
	removedPasswordViewer := openClient(t, h)
	sendPasswordAuthenticate(removedPasswordViewer, h.room, "removed-password-viewer", "easy-password")
	expectMatch(t, removedPasswordViewer.next("error").raw, `{"code":"ROOM_ACCESS_DENIED"}`)
}

func TestSignalReportsPasswordConfigurationOnlyToAuthenticatedHost(t *testing.T) {
	h := startHarness(t, harnessOptions{})
	h.updateRoomAccess(protocol.SetCodeEntryPolicyRequest{Action: "set-code-entry-policy", Policy: protocol.CodeEntryPrivate})

	host := openClient(t, h)
	withoutPassword := authenticate(t, host, h.room, protocol.RoleHost, "password-state-host", 1, "", presenceOptions{})
	expectMatch(t, withoutPassword.raw, `{"role":"host","codeEntryPolicy":"private","viewerPasswordEnabled":false}`)

	viewer := openClient(t, h)
	viewerAuthenticated := authenticate(t, viewer, h.room, protocol.RoleViewer, "password-state-viewer", 1, "", presenceOptions{})
	expectTrue(t, "viewerPasswordEnabled must be absent for viewers", !hasKey(t, viewerAuthenticated.raw, "viewerPasswordEnabled"))

	password := "room-password"
	h.updateRoomAccess(protocol.SetViewerPasswordRequest{Action: "set-viewer-password", Password: &password})
	replacementHost := openClient(t, h)
	withPassword := authenticate(t, replacementHost, h.room, protocol.RoleHost, "password-state-host", 1, "", presenceOptions{})
	expectMatch(t, withPassword.raw, `{"role":"host","codeEntryPolicy":"private","viewerPasswordEnabled":true}`)
}

// ---------------------------------------------------------------------------
// presence roster
// ---------------------------------------------------------------------------

func TestSignalReportsEveryOnlineViewerWithoutExpandingHostMediaFanout(t *testing.T) {
	h := startHarness(t, harnessOptions{})
	host := openClient(t, h)
	hostAuth := authenticate(t, host, h.room, protocol.RoleHost, "presence-host", 1, "", presenceOptions{viewerPresence: true})
	nextViewerPresenceMatching(t, host, func(message presenceMessage) bool {
		return len(viewerPresenceEntries(message)) == 0
	})

	viewerNames := []string{"阿明", "阿青", ""}
	var viewers []*testClient
	for index, displayName := range viewerNames {
		viewer := openClient(t, h)
		viewers = append(viewers, viewer)
		authenticated := authenticate(t, viewer, h.room, protocol.RoleViewer,
			fmt.Sprintf("presence-viewer-%d", index), 1, "", presenceOptions{displayName: displayName})
		prepared := nextPreparedRoute(t, viewer)
		viewer.sendJSON(map[string]any{
			"type":         "route-transport-connected",
			"revision":     prepared.Revision,
			"connectionId": prepared.Candidate.ConnectionID,
		})
		viewer.sendJSON(map[string]any{"type": "route-ready", "revision": prepared.Revision, "phase": "prepare"})
		expectTrue(t, "prepare revision must exceed the authenticated revision", prepared.Revision > authenticated.RouteRevision)
		nextActiveRouteRevision(t, viewer, prepared.Revision)
	}

	isRelay := func(viewer presenceEntry) bool {
		return viewer.Upstream.Kind == "peer" && viewer.Upstream.PeerID != hostAuth.PeerID
	}
	full := nextViewerPresenceMatching(t, host, func(message presenceMessage) bool {
		entries := viewerPresenceEntries(message)
		return len(entries) == 3 && slices.ContainsFunc(entries, isRelay)
	})
	fullEntries := viewerPresenceEntries(full)
	expectStrings(t, "display names", displayNames(fullEntries), []string{"阿明", "阿青", "观众"})
	directChildren := 0
	for _, viewer := range fullEntries {
		if viewer.Upstream.Kind == "peer" && viewer.Upstream.PeerID == hostAuth.PeerID {
			directChildren++
		}
	}
	if directChildren != 2 {
		t.Fatalf("expected 2 direct children of the host, got %d", directChildren)
	}
	for _, viewer := range fullEntries {
		expectTrue(t, "every viewer must be mediaReady", isMediaReady(viewer))
	}
	relayIndex := slices.IndexFunc(fullEntries, isRelay)
	relay := fullEntries[relayIndex]
	expectTrue(t, "relay parent must be in the roster", slices.ContainsFunc(fullEntries, func(viewer presenceEntry) bool {
		return viewer.PeerID == relay.Upstream.PeerID
	}))
	host.ignore("route-update")
	host.sendJSON(signalCandidate(relay.PeerID, "stale_connection_12345678"))
	host.expectNone(40 * time.Millisecond)

	viewers[2].sendJSON(map[string]any{"type": "set-display-name", "displayName": "后来改名"})
	renamed := nextViewerPresenceMatching(t, host, func(message presenceMessage) bool {
		return slices.ContainsFunc(viewerPresenceEntries(message), func(viewer presenceEntry) bool {
			return viewer.DisplayName == "后来改名"
		})
	})
	if len(viewerPresenceEntries(renamed)) != 3 {
		t.Fatalf("renamed roster: %s", renamed.raw)
	}

	h.closeClient(viewers[2])
	afterDisconnect := nextViewerPresenceMatching(t, host, func(message presenceMessage) bool {
		return len(viewerPresenceEntries(message)) == 2
	})
	expectStrings(t, "display names after disconnect", displayNames(viewerPresenceEntries(afterDisconnect)), []string{"阿明", "阿青"})
}

// ---------------------------------------------------------------------------
// quality evidence forwarding
// ---------------------------------------------------------------------------

func TestSignalForwardsExactDirectViewerReceiveEvidenceToHost(t *testing.T) {
	now := newClock(10_000)
	h := startHarness(t, harnessOptions{now: now.now})
	host := openClient(t, h)
	hostAuth := authenticate(t, host, h.room, protocol.RoleHost, "evidence-direct-host", 1, "", presenceOptions{viewerPresence: true})
	viewer := openClient(t, h)
	viewerAuth := authenticate(t, viewer, h.room, protocol.RoleViewer, "evidence-direct-viewer", 1, "", presenceOptions{})
	host.ignore("viewer-presence")
	prepared := nextPreparedRoute(t, viewer)
	connectionID := prepared.Candidate.ConnectionID
	routeRevision := prepared.Revision
	viewer.sendJSON(map[string]any{"type": "route-transport-connected", "revision": routeRevision, "connectionId": connectionID})
	viewer.sendJSON(map[string]any{"type": "route-ready", "revision": routeRevision, "phase": "prepare"})
	nextActiveRouteRevision(t, viewer, routeRevision)
	nextActiveRouteRevision(t, host, routeRevision)
	host.sendJSON(signalDescription(viewerAuth.PeerID, connectionID, "offer"))
	viewer.next("signal")

	viewer.sendJSON(viewerQualityEvidenceMessage(connectionID, routeRevision, 0, 0))
	expectMatch(t, host.next("viewer-quality-evidence").raw, fmt.Sprintf(
		`{"viewerPeerId":%q,"upstream":{"kind":"peer","peerId":%q},"guard":{"connectionId":%q,"routeRevision":%d}}`,
		viewerAuth.PeerID, hostAuth.PeerID, connectionID, routeRevision))

	viewer.sendJSON(viewerQualityEvidenceMessage(connectionID, routeRevision, 0, 1))
	host.expectNone(40 * time.Millisecond)
	now.advance(2_000)
	viewer.sendJSON(viewerQualityEvidenceMessage(connectionID, routeRevision, 7, 1))
	expectMatch(t, host.next("viewer-quality-evidence").raw, fmt.Sprintf(
		`{"guard":{"connectionId":%q,"routeRevision":%d,"presentationEpoch":1},"sequence":7}`, connectionID, routeRevision))
	now.advance(2_000)
	viewer.sendJSON(viewerQualityEvidenceMessage(connectionID, routeRevision, 1, 0))
	host.expectNone(40 * time.Millisecond)
	viewer.sendJSON(viewerQualityEvidenceMessage(connectionID, routeRevision, 0, 2))
	host.expectNone(40 * time.Millisecond)
	now.advance(2_000)
	viewer.sendJSON(viewerQualityEvidenceMessage(connectionID, routeRevision, 9, 2))
	expectMatch(t, host.next("viewer-quality-evidence").raw, fmt.Sprintf(
		`{"guard":{"connectionId":%q,"routeRevision":%d,"presentationEpoch":2},"sequence":9}`, connectionID, routeRevision))
}

func diagnosticQuality(t *testing.T, raw []byte) map[string]any {
	t.Helper()
	snapshot, _ := jsonObject(t, raw)["snapshot"].(map[string]any)
	children, _ := snapshot["children"].([]any)
	for _, child := range children {
		entry, _ := child.(map[string]any)
		if quality, ok := entry["quality"].(map[string]any); ok {
			return quality
		}
	}
	return nil
}

func TestSignalForwardsRelayedChildReceiveReportToExactParentAndHost(t *testing.T) {
	now := newClock(10_000)
	h := startHarness(t, harnessOptions{endpointMediaCopyCapacity: 1, now: now.now})
	host := openClient(t, h)
	authenticate(t, host, h.room, protocol.RoleHost, "evidence-relay-host", 1, "", presenceOptions{viewerPresence: true})
	parent := openClient(t, h)
	parentAuth := authenticate(t, parent, h.room, protocol.RoleViewer, "evidence-relay-parent", 1, "", presenceOptions{})
	parentPrepare := nextPreparedRoute(t, parent)
	parent.sendJSON(map[string]any{"type": "route-ready", "revision": parentPrepare.Revision, "phase": "prepare"})
	nextActiveRouteRevision(t, parent, parentPrepare.Revision)

	child := openClient(t, h)
	childAuth := authenticate(t, child, h.room, protocol.RoleViewer, "evidence-relay-child", 1, "", presenceOptions{})
	childPrepare := nextPreparedRoute(t, child)
	if childPrepare.Assignment.Upstream != protocol.PeerUpstream(parentAuth.PeerID) {
		t.Fatalf("child upstream: %+v", childPrepare.Assignment.Upstream)
	}
	child.sendJSON(map[string]any{"type": "route-ready", "revision": childPrepare.Revision, "phase": "prepare"})
	nextActiveRouteRevision(t, child, childPrepare.Revision)

	child.sendJSON(viewerQualityEvidenceMessage(childPrepare.Candidate.ConnectionID, childPrepare.Revision, 0, 0))
	expected := fmt.Sprintf(
		`{"viewerPeerId":%q,"upstream":{"kind":"peer","peerId":%q},"guard":{"connectionId":%q,"routeRevision":%d}}`,
		childAuth.PeerID, parentAuth.PeerID, childPrepare.Candidate.ConnectionID, childPrepare.Revision)
	expectMatch(t, parent.next("viewer-quality-evidence").raw, expected)
	expectMatch(t, host.next("viewer-quality-evidence").raw, expected)
	host.sendJSON(map[string]any{"type": "request-route-diagnostic"})
	quality := diagnosticQuality(t, host.next("route-diagnostic-snapshot").raw)
	if !reflect.DeepEqual(quality, jsonValue(t, []byte(
		`{"eligibleWindows":1,"eligibleDurationMs":2000,"freezeWindows":0,"freezeCount":0,"freezeDurationMs":0,"pauseCount":0,"pauseDurationMs":0}`))) {
		t.Fatalf("diagnostic quality: %v", quality)
	}

	now.advance(2_000)
	incomplete := viewerQualityEvidenceMessage(childPrepare.Candidate.ConnectionID, childPrepare.Revision, 1, 0)
	incomplete["metrics"].(map[string]any)["pauseCountDelta"] = nil
	child.sendJSON(incomplete)
	expectMatch(t, parent.next("viewer-quality-evidence").raw, `{"metrics":{"pauseCountDelta":null}}`)
	expectMatch(t, host.next("viewer-quality-evidence").raw, `{"metrics":{"pauseCountDelta":null}}`)
	host.sendJSON(map[string]any{"type": "request-route-diagnostic"})
	unchanged := diagnosticQuality(t, host.next("route-diagnostic-snapshot").raw)
	if unchanged["eligibleWindows"] != float64(1) {
		t.Fatalf("eligibleWindows: %v", unchanged["eligibleWindows"])
	}
}

// ---------------------------------------------------------------------------
// presence roster (continued)
// ---------------------------------------------------------------------------

func TestSignalSharesOptedInHostNameWithHostAndViewerRosterSubscribers(t *testing.T) {
	h := startHarness(t, harnessOptions{})
	host := openClient(t, h)
	hostAuth := authenticate(t, host, h.room, protocol.RoleHost, "named-host-client", 1, "",
		presenceOptions{viewerPresence: true, displayName: "原始分享者"})
	initial := parsePresence(t, host.next("viewer-presence").raw)
	entry := hostPresenceEntry(initial)
	if entry == nil || entry.PeerID != hostAuth.PeerID || entry.DisplayName != "原始分享者" || entry.Upstream.Kind != "none" {
		t.Fatalf("initial host presence: %s", initial.raw)
	}

	viewer := openClient(t, h)
	viewerAuth := authenticate(t, viewer, h.room, protocol.RoleViewer, "named-viewer-client", 1, "",
		presenceOptions{viewerPresence: true, displayName: "观看者"})
	hostNamed := func(name string) func(presenceMessage) bool {
		return func(message presenceMessage) bool {
			entry := hostPresenceEntry(message)
			return entry != nil && entry.DisplayName == name
		}
	}
	viewerSnapshot := nextViewerPresenceMatching(t, viewer, hostNamed("原始分享者"))
	expectString(t, "host peer", hostPresenceEntry(viewerSnapshot).PeerID, hostAuth.PeerID)
	expectTrue(t, "viewer must see itself", slices.ContainsFunc(viewerPresenceEntries(viewerSnapshot), func(entry presenceEntry) bool {
		return entry.PeerID == viewerAuth.PeerID
	}))

	hostSnapshot := nextViewerPresenceMatching(t, host, func(message presenceMessage) bool {
		return hostNamed("原始分享者")(message) && len(viewerPresenceEntries(message)) == 1
	})
	expectString(t, "host peer", hostPresenceEntry(hostSnapshot).PeerID, hostAuth.PeerID)

	host.sendJSON(map[string]any{"type": "set-display-name", "displayName": "改名后的分享者"})
	renamedViewer := nextViewerPresenceMatching(t, viewer, hostNamed("改名后的分享者"))
	expectString(t, "host peer", hostPresenceEntry(renamedViewer).PeerID, hostAuth.PeerID)
	renamedHost := nextViewerPresenceMatching(t, host, hostNamed("改名后的分享者"))
	expectString(t, "host peer", hostPresenceEntry(renamedHost).PeerID, hostAuth.PeerID)
}

func TestSignalReplacesOptedInViewerRosterAfterAnotherViewerLeaves(t *testing.T) {
	h := startHarness(t, harnessOptions{})
	host := openClient(t, h)
	authenticate(t, host, h.room, protocol.RoleHost, "viewer-roster-host", 1, "", presenceOptions{})

	subscriber := openClient(t, h)
	subscriberAuth := authenticate(t, subscriber, h.room, protocol.RoleViewer, "viewer-roster-subscriber", 1, "",
		presenceOptions{viewerPresence: true, displayName: "订阅者"})
	nextViewerPresenceMatching(t, subscriber, func(message presenceMessage) bool {
		return len(viewerPresenceEntries(message)) == 1
	})

	other := openClient(t, h)
	otherAuth := authenticate(t, other, h.room, protocol.RoleViewer, "viewer-roster-other", 1, "",
		presenceOptions{displayName: "另一位"})
	joined := nextViewerPresenceMatching(t, subscriber, func(message presenceMessage) bool {
		return len(viewerPresenceEntries(message)) == 2
	})
	expectStrings(t, "joined roster", peerIDs(viewerPresenceEntries(joined)), []string{subscriberAuth.PeerID, otherAuth.PeerID})

	h.closeClient(other)
	left := nextViewerPresenceMatching(t, subscriber, func(message presenceMessage) bool {
		return len(viewerPresenceEntries(message)) == 1
	})
	expectStrings(t, "roster after leave", peerIDs(viewerPresenceEntries(left)), []string{subscriberAuth.PeerID})
}

func TestSignalClearsDisconnectedHostNameAndPublishesReplacementName(t *testing.T) {
	h := startHarness(t, harnessOptions{viewerDisconnectGraceMs: 40})
	firstHost := openClient(t, h)
	firstAuth := authenticate(t, firstHost, h.room, protocol.RoleHost, "replaceable-host-client", 1, "",
		presenceOptions{viewerPresence: true, displayName: "旧分享者"})
	firstHost.next("viewer-presence")

	viewer := openClient(t, h)
	viewerAuth := authenticate(t, viewer, h.room, protocol.RoleViewer, "replacement-roster-viewer", 1, "",
		presenceOptions{viewerPresence: true})
	nextViewerPresenceMatching(t, viewer, func(message presenceMessage) bool {
		entry := hostPresenceEntry(message)
		return entry != nil && entry.DisplayName == "旧分享者"
	})

	h.closeClient(firstHost)
	viewer.next("host-status")
	offline := nextViewerPresenceMatching(t, viewer, func(message presenceMessage) bool {
		return hostPresenceEntry(message) == nil
	})
	expectMatch(t, viewerEntriesJSON(t, offline), fmt.Sprintf(`[{"peerId":%q,"upstream":{"kind":"none"}}]`, viewerAuth.PeerID))

	replacement := openClient(t, h)
	replacementAuth := authenticate(t, replacement, h.room, protocol.RoleHost, "replaceable-host-client", 1, "",
		presenceOptions{viewerPresence: true, displayName: "新分享者"})
	expectString(t, "replacement peer", replacementAuth.PeerID, firstAuth.PeerID)
	online := nextViewerPresenceMatching(t, viewer, func(message presenceMessage) bool {
		entry := hostPresenceEntry(message)
		return entry != nil && entry.DisplayName == "新分享者"
	})
	expectString(t, "online host peer", hostPresenceEntry(online).PeerID, firstAuth.PeerID)
	h.closeClient(replacement)
	h.closeClient(viewer)
}

// ---------------------------------------------------------------------------
// grant rotation and revocation
// ---------------------------------------------------------------------------

func viewerGrantOf(t *testing.T, inviteURL string) string {
	t.Helper()
	parsed, err := url.Parse(inviteURL)
	if err != nil {
		t.Fatal(err)
	}
	values, err := url.ParseQuery(parsed.Fragment)
	if err != nil {
		t.Fatal(err)
	}
	return values.Get("v")
}

func TestSignalStronglyRotatesAndRevokesEveryViewerGenerationAndMediaEdge(t *testing.T) {
	h := startHarness(t, harnessOptions{})
	host := openClient(t, h)
	hostAuth := authenticate(t, host, h.room, protocol.RoleHost, "ordinary-access-presence-host", 1, "",
		presenceOptions{viewerPresence: true})
	if entries := viewerPresenceEntries(parsePresence(t, host.next("viewer-presence").raw)); len(entries) != 0 {
		t.Fatalf("initial roster: %v", entries)
	}

	firstViewer := openClient(t, h)
	firstViewerAuth := authenticate(t, firstViewer, h.room, protocol.RoleViewer, "ordinary-access-presence-viewer-1", 1, "",
		presenceOptions{displayName: "第一位"})
	commitPreparedRoute(t, firstViewer)
	hasPeerEdge := func(message presenceMessage) bool {
		return slices.ContainsFunc(viewerPresenceEntries(message), func(entry presenceEntry) bool {
			return entry.Upstream.Kind == "peer"
		})
	}
	expectMatch(t, viewerEntriesJSON(t, nextViewerPresenceMatching(t, host, hasPeerEdge)), fmt.Sprintf(
		`[{"role":"viewer","peerId":%q,"displayName":"第一位","upstream":{"kind":"peer","peerId":%q}}]`,
		firstViewerAuth.PeerID, hostAuth.PeerID))

	rotated := h.updateRoomAccess(protocol.RotateViewerGrantRequest{Action: "rotate-viewer-grant"})
	expectMatch(t, firstViewer.next("viewer-grant-revoked").raw,
		fmt.Sprintf(`{"viewerAuthorizationGeneration":%q}`, firstViewerAuth.ViewerAuthorizationGeneration))
	expectCloseCode(t, firstViewer, 4004)
	nextViewerPresenceMatching(t, host, func(message presenceMessage) bool {
		return len(viewerPresenceEntries(message)) == 0
	})

	rotatedGrant, ok := rotated.(protocol.ViewerGrantUpdatedResponse)
	if !ok || rotatedGrant.InviteURL == nil {
		t.Fatalf("expected a rotated Viewer grant, got %+v", rotated)
	}
	grant := viewerGrantOf(t, *rotatedGrant.InviteURL)
	expectTrue(t, "rotated grant must be present", grant != "")
	rotatedRoom := h.room
	rotatedRoom.ViewerGrant = grant
	secondViewer := openClient(t, h)
	secondViewerAuth := authenticate(t, secondViewer, rotatedRoom, protocol.RoleViewer, "ordinary-access-presence-viewer-2", 1, "",
		presenceOptions{displayName: "第二位"})
	commitPreparedRoute(t, secondViewer)
	seen := nextViewerPresenceMatching(t, host, func(message presenceMessage) bool {
		return slices.ContainsFunc(viewerPresenceEntries(message), func(entry presenceEntry) bool {
			return entry.PeerID == secondViewerAuth.PeerID
		})
	})
	if len(viewerPresenceEntries(seen)) != 1 {
		t.Fatalf("second roster: %s", seen.raw)
	}

	revoked := h.updateRoomAccess(protocol.RevokeViewerGrantRequest{Action: "revoke-viewer-grant"})
	secondViewer.next("viewer-grant-revoked")
	expectCloseCode(t, secondViewer, 4004)
	nextViewerPresenceMatching(t, host, func(message presenceMessage) bool {
		return len(viewerPresenceEntries(message)) == 0
	})
	revokedGrant, ok := revoked.(protocol.ViewerGrantUpdatedResponse)
	if !ok || revokedGrant.InviteURL != nil {
		t.Fatalf("revoke response: %+v", revoked)
	}
	expectNoViewerPresenceMatching(t, host, func(message presenceMessage) bool {
		return len(viewerPresenceEntries(message)) > 0
	}, 30*time.Millisecond)
}

func TestSignalRotatesGrantAndPromotesWaitingCodeAdmittedViewer(t *testing.T) {
	h := startHarness(t, harnessOptions{endpointMediaCopyCapacity: 1, maxViewersPerRoom: 2})
	host := openClient(t, h)
	hostAuth := authenticate(t, host, h.room, protocol.RoleHost, "mixed-access-host", 2, "", presenceOptions{viewerPresence: true})
	if entries := viewerPresenceEntries(parsePresence(t, host.next("viewer-presence").raw)); len(entries) != 0 {
		t.Fatalf("initial roster: %v", entries)
	}

	grantViewer := openClient(t, h)
	grantAuth := authenticate(t, grantViewer, h.room, protocol.RoleViewer, "mixed-grant-viewer", 0, "",
		presenceOptions{displayName: "邀请观众"})
	commitPreparedRoute(t, grantViewer)
	nextViewerPresenceMatching(t, host, func(message presenceMessage) bool {
		return slices.ContainsFunc(viewerPresenceEntries(message), func(entry presenceEntry) bool {
			return entry.PeerID == grantAuth.PeerID && entry.Upstream.Kind == "peer" && isMediaReady(entry)
		})
	})

	codeViewer := openClient(t, h)
	codeAuth := authenticate(t, codeViewer, h.room, protocol.RoleViewer, "mixed-code-viewer", 1, "",
		presenceOptions{codeOnly: true, displayName: "房间号观众"})
	nextViewerPresenceMatching(t, host, func(message presenceMessage) bool {
		return len(viewerPresenceEntries(message)) == 2
	})
	h.updateRoomAccess(protocol.RotateViewerGrantRequest{Action: "rotate-viewer-grant"})
	grantViewer.next("viewer-grant-revoked")
	expectCloseCode(t, grantViewer, 4004)
	commitPreparedRoute(t, codeViewer)
	remaining := nextViewerPresenceMatching(t, host, func(message presenceMessage) bool {
		entries := viewerPresenceEntries(message)
		return len(entries) == 1 && entries[0].PeerID == codeAuth.PeerID && entries[0].Upstream.Kind == "peer"
	})
	expectEqual(t, viewerEntriesJSON(t, remaining), fmt.Sprintf(
		`[{"role":"viewer","peerId":%q,"displayName":"房间号观众","upstream":{"kind":"peer","peerId":%q},"mediaReady":true}]`,
		codeAuth.PeerID, hostAuth.PeerID))
	expectTrue(t, "code viewer must stay open", !codeViewer.isClosed())
	var connected bool
	h.locked(func() { _, connected = h.store.GetConnectedViewer(h.room.RoomID, codeAuth.PeerID) })
	expectTrue(t, "code viewer must stay connected", connected)

	h.closeClient(codeViewer)
	h.closeClient(host)
}

// ---------------------------------------------------------------------------
// site access at upgrade
// ---------------------------------------------------------------------------

func sendCodeOnlyAuthenticate(client *testClient, roomID, clientID string, extra map[string]any) {
	message := map[string]any{
		"type":     "authenticate",
		"protocol": protocol.SignalingProtocol,
		"roomId":   roomID,
		"role":     protocol.RoleViewer,
		"clientId": clientID,
	}
	for key, value := range extra {
		message[key] = value
	}
	client.sendJSON(message)
}

func TestSignalRequiresSiteAccessForCodeOnlyViewersWhileAcceptingRoomGrants(t *testing.T) {
	h := startHarness(t, harnessOptions{siteAccessPassword: "protected-instance-password"})

	viewer := openClient(t, h)
	sendCodeOnlyAuthenticate(viewer, h.room.RoomID, "code-only-viewer-without-site-access", nil)
	expectMatch(t, viewer.next("error").raw, `{"code":"INVALID_TOKEN"}`)

	grantedViewer := openClient(t, h)
	granted := authenticate(t, grantedViewer, h.room, protocol.RoleViewer, "grant-viewer-without-site-access", 1, "", presenceOptions{})
	expectString(t, "role", granted.Role, protocol.RoleViewer)

	unauthorizedHost := openClient(t, h)
	unauthorizedHost.sendJSON(map[string]any{
		"type":     "authenticate",
		"protocol": protocol.SignalingProtocol,
		"roomId":   h.room.RoomID,
		"role":     protocol.RoleHost,
		"token":    h.room.HostToken,
		"clientId": "host-client-without-admission",
	})
	expectMatch(t, unauthorizedHost.next("error").raw, `{"code":"AUTH_REQUIRED"}`)

	viewerWithHostCookie := openClientWithCookie(t, h, siteAccessCookie)
	admitted := authenticate(t, viewerWithHostCookie, h.room, protocol.RoleViewer, "viewer-with-host-cookie", 1, "",
		presenceOptions{codeOnly: true})
	expectString(t, "role", admitted.Role, protocol.RoleViewer)

	publicRoom := h.createRoom(protocol.CodeEntryOpen, "")
	publicWithoutSiteAccess := openClient(t, h)
	sendCodeOnlyAuthenticate(publicWithoutSiteAccess, publicRoom.RoomID, "public-viewer-without-site-access", nil)
	expectMatch(t, publicWithoutSiteAccess.next("error").raw, `{"code":"INVALID_TOKEN"}`)

	publicWithForgedGrant := openClient(t, h)
	sendCodeOnlyAuthenticate(publicWithForgedGrant, publicRoom.RoomID, "public-viewer-with-forged-grant",
		map[string]any{"viewerGrant": strings.Repeat("x", 21) + "g"})
	expectMatch(t, publicWithForgedGrant.next("error").raw, `{"code":"INVALID_TOKEN"}`)

	publicWithSiteAccess := openClientWithCookie(t, h, siteAccessCookie)
	publicAdmitted := authenticate(t, publicWithSiteAccess, publicRoom, protocol.RoleViewer, "public-viewer-with-site-access", 1, "",
		presenceOptions{codeOnly: true})
	expectString(t, "role", publicAdmitted.Role, protocol.RoleViewer)

	passwordRoom := h.createRoom(protocol.CodeEntryPrivate, "room-password")

	passwordWithoutSiteAccess := openClient(t, h)
	sendCodeOnlyAuthenticate(passwordWithoutSiteAccess, passwordRoom.RoomID, "password-viewer-without-site-access",
		map[string]any{"viewerPassword": "room-password"})
	expectMatch(t, passwordWithoutSiteAccess.next("error").raw, `{"code":"INVALID_TOKEN"}`)

	passwordWithSiteAccess := openClientWithCookie(t, h, siteAccessCookie)
	passwordAdmitted := authenticate(t, passwordWithSiteAccess, passwordRoom, protocol.RoleViewer, "password-viewer-with-site-access", 1, "",
		presenceOptions{viewerPassword: "room-password"})
	expectString(t, "role", passwordAdmitted.Role, protocol.RoleViewer)

	host := openClientWithCookie(t, h, siteAccessCookie)
	hostAuth := authenticate(t, host, h.room, protocol.RoleHost, "host-client-protected", 1, "", presenceOptions{})
	expectString(t, "role", hostAuth.Role, protocol.RoleHost)
}

func TestSignalDistinguishesMissingRoomsFromExistingRoomCodeOnlyDenials(t *testing.T) {
	now := newClock(utcMillis(2026, time.August, 24, 12))
	h := startHarness(t, harnessOptions{
		siteAccessPassword: "protected-instance-password",
		maxViewersPerRoom:  1,
		now:                now.now,
	})

	protectedRoom := h.createRoom(protocol.CodeEntryPrivate, "correct-password")
	abandoned := h.createRoom(protocol.CodeEntryOpen, "")
	unusedRoomID := ""
	for code := 1_000; code < 10_000; code++ {
		candidate := fmt.Sprint(code)
		if candidate != h.room.RoomID && candidate != protectedRoom.RoomID && candidate != abandoned.RoomID {
			unusedRoomID = candidate
			break
		}
	}

	admitted := openClientWithCookie(t, h, siteAccessCookie)
	authenticate(t, admitted, h.room, protocol.RoleViewer, "admitted-viewer", 1, "", presenceOptions{codeOnly: true})

	expectDenial := func(roomID, clientID, code, viewerPassword string) {
		t.Helper()
		client := openClientWithCookie(t, h, siteAccessCookie)
		extra := map[string]any{}
		if viewerPassword != "" {
			extra["viewerPassword"] = viewerPassword
		}
		sendCodeOnlyAuthenticate(client, roomID, clientID, extra)
		message := "Room access denied"
		if code == "ROOM_NOT_FOUND" {
			message = "Room not found"
		}
		expectEqual(t, client.next("error").raw, fmt.Sprintf(`{"type":"error","code":%q,"message":%q}`, code, message))
		expectClose(t, client, 4003, "Authentication failed")
	}

	expectDenial(unusedRoomID, "unknown-room-viewer", "ROOM_NOT_FOUND", "")
	expectDenial(protectedRoom.RoomID, "missing-password-viewer", "ROOM_ACCESS_DENIED", "")
	expectDenial(protectedRoom.RoomID, "wrong-password-viewer", "ROOM_ACCESS_DENIED", "wrong-password")
	expectDenial(h.room.RoomID, "full-room-viewer", "ROOM_ACCESS_DENIED", "")

	h.locked(func() {
		if _, err := h.store.AbandonRoom(abandoned.RoomID); err != nil {
			t.Fatal(err)
		}
	})
	expectDenial(abandoned.RoomID, "abandoned-room-viewer", "ROOM_NOT_FOUND", "")

	abandonedGrant := openClientWithCookie(t, h, siteAccessCookie)
	sendCodeOnlyAuthenticate(abandonedGrant, abandoned.RoomID, "abandoned-grant-viewer",
		map[string]any{"viewerGrant": abandoned.ViewerGrant})
	expectMatch(t, abandonedGrant.next("error").raw, `{"code":"INVALID_TOKEN"}`)
}

// ---------------------------------------------------------------------------
// room lifetime
// ---------------------------------------------------------------------------

func TestSignalRetainsDormantAuthorityAcrossLongHostAbsence(t *testing.T) {
	now := newClock(utcMillis(2026, time.August, 20, 12))
	h := startHarness(t, harnessOptions{now: now.now})
	now.advance(30 * 24 * 60 * 60 * 1_000)
	host := openClient(t, h)
	authenticate(t, host, h.room, protocol.RoleHost, "returning-host", 1, "", presenceOptions{})
	viewer := openClient(t, h)
	authenticate(t, viewer, h.room, protocol.RoleViewer, "waiting-viewer", 1, "", presenceOptions{})
	h.closeClient(host)
	viewer.next("host-status")
	now.advance(30 * 24 * 60 * 60 * 1_000)
	resumed := openClient(t, h)
	authenticate(t, resumed, h.room, protocol.RoleHost, "returning-host", 1, "", presenceOptions{})
	lateViewer := openClient(t, h)
	authenticate(t, lateViewer, h.room, protocol.RoleViewer, "late-viewer", 1, "", presenceOptions{})
	if h.storeSize() != 1 || viewer.isClosed() {
		t.Fatal("host absence retired the room or its Viewer")
	}
}

func TestSignalKeepsPreHostViewerSessionCurrentAfterHostConnects(t *testing.T) {
	now := newClock(utcMillis(2026, time.August, 20, 12))
	h := startHarness(t, harnessOptions{now: now.now})
	viewer := openClient(t, h)
	authenticate(t, viewer, h.room, protocol.RoleViewer, "pre-host-viewer", 1, "", presenceOptions{displayName: "Before"})
	host := openClient(t, h)
	authenticate(t, host, h.room, protocol.RoleHost, "pre-host-host", 1, "", presenceOptions{viewerPresence: true})
	named := func(name string) func(presenceMessage) bool {
		return func(message presenceMessage) bool {
			return slices.ContainsFunc(viewerPresenceEntries(message), func(entry presenceEntry) bool {
				return entry.DisplayName == name
			})
		}
	}
	nextViewerPresenceMatching(t, host, named("Before"))

	now.advance(86_400_001)
	viewer.sendJSON(map[string]any{"type": "set-display-name", "displayName": "After"})
	updated := nextViewerPresenceMatching(t, host, named("After"))
	if len(viewerPresenceEntries(updated)) != 1 {
		t.Fatalf("updated roster: %s", updated.raw)
	}
}

// ---------------------------------------------------------------------------
// grant update failure
// ---------------------------------------------------------------------------

func TestSignalLeavesEstablishedAuthorizationAndMediaUntouchedWhenGrantUpdateFails(t *testing.T) {
	// The TS mocked setViewerGrant to throw; here the stable-authority
	// database is closed underneath the store, so the write fails before
	// memory changes, which is the same failure point.
	database, err := room.NewDatabase(filepath.Join(t.TempDir(), "rooms.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	store := newStore(t, 8, database)
	h := startHarness(t, harnessOptions{store: store})
	host := openClient(t, h)
	hostAuth := authenticate(t, host, h.room, protocol.RoleHost, "persistence-failure-host", 1, "", presenceOptions{})
	viewer := openClient(t, h)
	viewerAuth := authenticate(t, viewer, h.room, protocol.RoleViewer, "persistence-failure-viewer", 1, "", presenceOptions{})
	commitPreparedRoute(t, viewer)
	host.sendJSON(signalDescription(viewerAuth.PeerID, "persistence-failure-edge", "offer"))
	viewer.next("signal")

	h.locked(func() {
		if err := database.Close(); err != nil {
			t.Fatalf("database.Close: %v", err)
		}
	})
	_, err = h.server.UpdateRoomAccess(h.room.RoomID, h.room.HostToken,
		protocol.RotateViewerGrantRequest{Action: "rotate-viewer-grant"})
	var roomError *room.Error
	if err == nil || errors.As(err, &roomError) {
		t.Fatalf("expected the rotation to fail with a non-room error, got %v", err)
	}
	if message, ok := viewer.tryNext("viewer-grant-revoked", 30*time.Millisecond); ok {
		t.Fatalf("viewer was revoked: %s", message.raw)
	}

	host.sendJSON(signalCandidate(viewerAuth.PeerID, "persistence-failure-edge"))
	expectMatch(t, viewer.next("signal").raw, fmt.Sprintf(
		`{"fromPeerId":%q,"payload":{"connectionId":"persistence-failure-edge"}}`, hostAuth.PeerID))

	secondViewer := openClient(t, h)
	secondAuth := authenticate(t, secondViewer, h.room, protocol.RoleViewer, "persistence-failure-new-viewer", 1, "", presenceOptions{})
	expectString(t, "viewerAuthorizationGeneration", secondAuth.ViewerAuthorizationGeneration, viewerAuth.ViewerAuthorizationGeneration)
}

// ---------------------------------------------------------------------------
// host arrival, pause and quality
// ---------------------------------------------------------------------------

func TestSignalLetsViewersArriveFirstAndReplaysTheirSnapshotWhenHostJoins(t *testing.T) {
	h := startHarness(t, harnessOptions{})
	viewer := openClient(t, h)
	viewerAuth := authenticate(t, viewer, h.room, protocol.RoleViewer, "viewer-client-early", 1, "", presenceOptions{})
	expectTrue(t, "host must be offline", !viewerAuth.HostOnline)
	expectTrue(t, "mediaMode must be present", hasKey(t, viewerAuth.raw, "mediaMode"))
	expectTrue(t, "routeRevision must be present", hasKey(t, viewerAuth.raw, "routeRevision"))

	host := openClient(t, h)
	authenticate(t, host, h.room, protocol.RoleHost, "host-client-stable", 1, "", presenceOptions{})
	host.ignore("route-update")
	expectEqual(t, viewer.next("host-status").raw, `{"type":"host-status","online":true,"paused":false}`)
}

func setSharingPaused(client *testClient, shareGeneration string, paused bool) {
	client.sendJSON(map[string]any{"type": "set-sharing-paused", "shareGeneration": shareGeneration, "paused": paused})
}

func TestSignalSnapshotsIntentionalPauseAcrossViewerReplacementAndClearsItOnResumeAndStop(t *testing.T) {
	h := startHarness(t, harnessOptions{})
	shareGeneration := "pause_share_generation_12345678"
	host := openClient(t, h)
	hostAuth := authenticate(t, host, h.room, protocol.RoleHost, "pause-host-client", 1, shareGeneration, presenceOptions{})
	expectTrue(t, "hostPaused must be absent for the host", !hasKey(t, hostAuth.raw, "hostPaused"))
	viewer := openClient(t, h)
	viewerAuth := authenticate(t, viewer, h.room, protocol.RoleViewer, "pause-viewer-client", 1, "", presenceOptions{})
	expectTrue(t, "hostPaused must be false", viewerAuth.HostPaused != nil && !*viewerAuth.HostPaused)
	commitPreparedRoute(t, viewer)

	setSharingPaused(host, shareGeneration, true)
	expectEqual(t, viewer.next("host-status").raw, `{"type":"host-status","online":true,"paused":true}`)

	h.closeClient(host)
	expectMatch(t, viewer.next("host-status").raw, `{"online":false,"paused":false}`)
	activeHost := openClient(t, h)
	authenticate(t, activeHost, h.room, protocol.RoleHost, "pause-host-client", 1, shareGeneration,
		presenceOptions{sharingPaused: boolPointer(true)})
	expectMatch(t, viewer.next("host-status").raw, `{"online":true,"paused":true}`)

	replacement := openClient(t, h)
	replacementAuth := authenticate(t, replacement, h.room, protocol.RoleViewer, "pause-viewer-client", 1, "", presenceOptions{})
	expectTrue(t, "hostPaused must be true", replacementAuth.HostPaused != nil && *replacementAuth.HostPaused)

	setSharingPaused(activeHost, shareGeneration, false)
	expectMatch(t, replacement.next("host-status").raw, `{"online":true,"paused":false}`)

	setSharingPaused(activeHost, shareGeneration, true)
	expectMatch(t, replacement.next("host-status").raw, `{"paused":true}`)
	activeHost.sendJSON(map[string]any{"type": "stop-sharing", "shareGeneration": shareGeneration})
	replacement.next("sharing-stopped")
	expectMatch(t, replacement.next("host-status").raw, `{"online":false,"paused":false}`)

	nextHost := openClient(t, h)
	authenticate(t, nextHost, h.room, protocol.RoleHost, "pause-host-client", 1, "next_pause_share_generation_12345678", presenceOptions{})
	replacement.next("sharing-stopped")
	expectMatch(t, replacement.next("host-status").raw, `{"online":false,"paused":false}`)
	expectMatch(t, replacement.next("host-status").raw, `{"online":true,"paused":false}`)
}

func TestSignalAppliesSymmetricPauseUpdatesOnlyToExactCurrentHostShare(t *testing.T) {
	h := startHarness(t, harnessOptions{})
	shareGeneration := "hybrid_pause_share_generation_12345678"
	host := openClient(t, h)
	authenticate(t, host, h.room, protocol.RoleHost, "hybrid-pause-host-client", 1, shareGeneration, presenceOptions{})
	viewer := openClient(t, h)
	authenticate(t, viewer, h.room, protocol.RoleViewer, "hybrid-pause-viewer-client", 1, "", presenceOptions{})

	setSharingPaused(host, shareGeneration, true)
	expectMatch(t, viewer.next("host-status").raw, `{"online":true,"paused":true}`)
	setSharingPaused(host, shareGeneration, false)
	expectMatch(t, viewer.next("host-status").raw, `{"online":true,"paused":false}`)

	setSharingPaused(host, "stale_pause_share_generation_12345678", true)
	expectCloseCode(t, host, 4001)
}

func TestSignalRetainsAuthoritativePauseWhenReconnectingHostAdvertisesUnpaused(t *testing.T) {
	h := startHarness(t, harnessOptions{})
	shareGeneration := "reconnect_resume_share_generation_12345678"
	hostClientID := "reconnect-resume-host-client"
	host := openClient(t, h)
	authenticate(t, host, h.room, protocol.RoleHost, hostClientID, 1, shareGeneration, presenceOptions{})
	viewer := openClient(t, h)
	authenticate(t, viewer, h.room, protocol.RoleViewer, "reconnect-resume-viewer-client", 1, "", presenceOptions{})
	commitPreparedRoute(t, viewer)

	setSharingPaused(host, shareGeneration, true)
	expectMatch(t, viewer.next("host-status").raw, `{"online":true,"paused":true}`)
	h.closeClient(host)
	expectMatch(t, viewer.next("host-status").raw, `{"online":false,"paused":false}`)

	reconnectedHost := openClient(t, h)
	authenticate(t, reconnectedHost, h.room, protocol.RoleHost, hostClientID, 1, shareGeneration,
		presenceOptions{sharingPaused: boolPointer(false)})
	expectEqual(t, reconnectedHost.next("pause-sharing-source").raw,
		fmt.Sprintf(`{"type":"pause-sharing-source","shareGeneration":%q}`, shareGeneration))
	expectMatch(t, viewer.next("host-status").raw, `{"online":true,"paused":true}`)

	setSharingPaused(reconnectedHost, shareGeneration, false)
	expectMatch(t, viewer.next("host-status").raw, `{"online":true,"paused":false}`)
}

func TestSignalBindsNewShareQualityAndPreservesActiveShareQualityAcrossReconnect(t *testing.T) {
	h := startHarness(t, harnessOptions{})
	initialSettings := map[string]any{
		"resolution":            protocol.QualityResolution{Width: 2560, Height: 1440},
		"maxFramerate":          60,
		"maxBitrate":            8_000_000,
		"degradationPreference": "maintain-resolution",
		"maxAudioBitrate":       192000,
	}
	initialJSON := `{"resolution":{"width":2560,"height":1440},"maxFramerate":60,"maxBitrate":8000000,"degradationPreference":"maintain-resolution","maxAudioBitrate":192000}`
	firstGeneration := "first_share_generation_12345678"
	viewer := openClient(t, h)
	authenticate(t, viewer, h.room, protocol.RoleViewer, "quality-viewer-client", 1, "", presenceOptions{})

	host := openClient(t, h)
	hostAuth := authenticate(t, host, h.room, protocol.RoleHost, "quality-host-client", 1, firstGeneration,
		presenceOptions{qualitySettings: initialSettings})
	expectEqual(t, hostAuth.QualitySettings, initialJSON)
	expectEqual(t, viewer.next("quality-settings").raw, `{"type":"quality-settings","qualitySettings":`+initialJSON+`}`)

	reconnectSettings := map[string]any{
		"resolution":            protocol.QualityResolution{Width: 854, Height: 480},
		"maxFramerate":          15,
		"maxBitrate":            2_000_000,
		"degradationPreference": "maintain-framerate",
		"maxAudioBitrate":       64000,
	}
	reconnectJSON := `{"resolution":{"width":854,"height":480},"maxFramerate":15,"maxBitrate":2000000,"degradationPreference":"maintain-framerate","maxAudioBitrate":64000}`
	reconnectedHost := openClient(t, h)
	reconnectedAuth := authenticate(t, reconnectedHost, h.room, protocol.RoleHost, "quality-host-client", 1, firstGeneration,
		presenceOptions{qualitySettings: reconnectSettings})
	expectCloseCode(t, host, 4001)
	expectEqual(t, reconnectedAuth.QualitySettings, initialJSON)
	if message, ok := viewer.tryNext("quality-settings", 30*time.Millisecond); ok {
		t.Fatalf("unexpected quality-settings: %s", message.raw)
	}

	updatedSettings := map[string]any{
		"resolution":            protocol.QualityResolution{Width: 1280, Height: 720},
		"maxFramerate":          30,
		"maxBitrate":            3_000_000,
		"degradationPreference": "balanced",
		"maxAudioBitrate":       128000,
	}
	updatedJSON := `{"resolution":{"width":1280,"height":720},"maxFramerate":30,"maxBitrate":3000000,"degradationPreference":"balanced","maxAudioBitrate":128000}`
	reconnectedHost.sendJSON(map[string]any{"type": "set-quality-settings", "qualitySettings": updatedSettings})
	expectEqual(t, viewer.next("quality-settings").raw, `{"type":"quality-settings","qualitySettings":`+updatedJSON+`}`)

	reconnectedHost.sendJSON(map[string]any{"type": "stop-sharing", "shareGeneration": firstGeneration})
	expectCloseCode(t, reconnectedHost, 1000)
	viewer.next("sharing-stopped")

	nextHost := openClient(t, h)
	nextAuth := authenticate(t, nextHost, h.room, protocol.RoleHost, "quality-host-client", 1, "next_share_generation_12345678",
		presenceOptions{qualitySettings: reconnectSettings})
	expectEqual(t, nextAuth.QualitySettings, reconnectJSON)
	expectEqual(t, viewer.next("quality-settings").raw, `{"type":"quality-settings","qualitySettings":`+reconnectJSON+`}`)
}

// ---------------------------------------------------------------------------
// grace, reconnect and media identity
// ---------------------------------------------------------------------------

func TestSignalKeepsViewerPeerStableWhenItReconnectsInsideGracePeriod(t *testing.T) {
	h := startHarness(t, harnessOptions{viewerDisconnectGraceMs: 80})
	host := openClient(t, h)
	authenticate(t, host, h.room, protocol.RoleHost, "host-client-stable", 1, "", presenceOptions{})
	firstViewer := openClient(t, h)
	firstAuth := authenticate(t, firstViewer, h.room, protocol.RoleViewer, "viewer-client-stable", 1, "", presenceOptions{})
	activeRoute := commitPreparedRoute(t, firstViewer)
	nextActiveRouteRevision(t, host, activeRoute.Revision)
	host.sendJSON(signalDescription(firstAuth.PeerID, "stable-connection", "offer"))
	firstViewer.next("signal")

	h.closeClient(firstViewer)
	reconnectedViewer := openClient(t, h)
	reconnectedAuth := authenticate(t, reconnectedViewer, h.room, protocol.RoleViewer, "viewer-client-stable", 1, "", presenceOptions{})
	expectString(t, "peer", reconnectedAuth.PeerID, firstAuth.PeerID)
	if reconnectedAuth.ConnectionID == nil || *reconnectedAuth.ConnectionID != "stable-connection" {
		t.Fatalf("connectionId: %v", reconnectedAuth.ConnectionID)
	}
	nextActiveRouteRevision(t, host, reconnectedAuth.RouteRevision)
	host.expectNone(110 * time.Millisecond)

	h.closeClient(reconnectedViewer)
	nextActiveRouteAfter(t, host, activeRoute.Revision)
	host.sendJSON(map[string]any{"type": "request-route-diagnostic"})
	expectMatch(t, host.next("route-diagnostic-snapshot").raw, `{"snapshot":{"children":[]}}`)
}

func TestSignalClearsPreviousMediaGenerationWhenSharingStops(t *testing.T) {
	h := startHarness(t, harnessOptions{viewerDisconnectGraceMs: 300})
	host := openClient(t, h)
	authenticate(t, host, h.room, protocol.RoleHost, "host-client-stop", 1, "", presenceOptions{})
	viewer := openClient(t, h)
	viewerAuth := authenticate(t, viewer, h.room, protocol.RoleViewer, "viewer-client-stop", 1, "", presenceOptions{})
	commitPreparedRoute(t, viewer)
	host.sendJSON(signalDescription(viewerAuth.PeerID, "connection-before-stop", "offer"))
	viewer.next("signal")

	host.sendJSON(map[string]any{"type": "stop-sharing"})
	viewer.next("sharing-stopped")
	expectMatch(t, viewer.next("host-status").raw, `{"online":false}`)
	expectCloseCode(t, host, 1000)
	h.closeClient(viewer)

	reconnected := openClient(t, h)
	reconnectedAuth := authenticate(t, reconnected, h.room, protocol.RoleViewer, "viewer-client-stop", 1, "", presenceOptions{})
	expectTrue(t, "connectionId must be null", reconnectedAuth.ConnectionID == nil)
	expectString(t, "peer", reconnectedAuth.PeerID, viewerAuth.PeerID)
	expectTrue(t, "host must be offline", !reconnectedAuth.HostOnline)
}

func TestSignalReplacesSameClientPresenceWithoutTransientLeaveChurn(t *testing.T) {
	h := startHarness(t, harnessOptions{viewerDisconnectGraceMs: 40})
	host := openClient(t, h)
	hostAuth := authenticate(t, host, h.room, protocol.RoleHost, "host-client-stable", 1, "", presenceOptions{viewerPresence: true})
	if entries := viewerPresenceEntries(parsePresence(t, host.next("viewer-presence").raw)); len(entries) != 0 {
		t.Fatalf("initial roster: %v", entries)
	}
	original := openClient(t, h)
	originalAuth := authenticate(t, original, h.room, protocol.RoleViewer, "viewer-client-stable", 1, "",
		presenceOptions{displayName: "旧会话"})
	commitPreparedRoute(t, original)
	expectMatch(t, viewerEntriesJSON(t, nextViewerPresenceMatching(t, host, func(message presenceMessage) bool {
		return slices.ContainsFunc(viewerPresenceEntries(message), func(entry presenceEntry) bool {
			return entry.Upstream.Kind == "peer"
		})
	})), fmt.Sprintf(
		`[{"role":"viewer","peerId":%q,"displayName":"旧会话","upstream":{"kind":"peer","peerId":%q}}]`,
		originalAuth.PeerID, hostAuth.PeerID))

	replacement := openClient(t, h)
	replacementAuth := authenticate(t, replacement, h.room, protocol.RoleViewer, "viewer-client-stable", 1, "",
		presenceOptions{displayName: "新会话"})

	expectString(t, "peer", replacementAuth.PeerID, originalAuth.PeerID)
	expectCloseCode(t, original, 4001)
	expectMatch(t, viewerEntriesJSON(t, parsePresence(t, host.next("viewer-presence").raw)), fmt.Sprintf(
		`[{"role":"viewer","peerId":%q,"displayName":"新会话","upstream":{"kind":"peer","peerId":%q}}]`,
		originalAuth.PeerID, hostAuth.PeerID))
	expectNoViewerPresenceMatching(t, host, func(message presenceMessage) bool {
		return !slices.ContainsFunc(viewerPresenceEntries(message), func(entry presenceEntry) bool {
			return entry.PeerID == originalAuth.PeerID
		})
	}, 70*time.Millisecond)
}

func TestSignalNotifiesHostWhenPreOfferViewerReconnectsInsideGrace(t *testing.T) {
	h := startHarness(t, harnessOptions{viewerDisconnectGraceMs: 300})
	originalViewer := openClient(t, h)
	originalAuth := authenticate(t, originalViewer, h.room, protocol.RoleViewer, "viewer-client-before-offer", 1, "", presenceOptions{})
	h.closeClient(originalViewer)

	host := openClient(t, h)
	hostAuth := authenticate(t, host, h.room, protocol.RoleHost, "host-client-stable", 1, "", presenceOptions{})
	nextActiveRouteRevision(t, host, hostAuth.RouteRevision)

	reconnectedViewer := openClient(t, h)
	reconnectedAuth := authenticate(t, reconnectedViewer, h.room, protocol.RoleViewer, "viewer-client-before-offer", 1, "", presenceOptions{})
	expectString(t, "peer", reconnectedAuth.PeerID, originalAuth.PeerID)
	prepared := nextPreparedRoute(t, host)
	expectMatch(t, prepared.raw, fmt.Sprintf(
		`{"candidate":{"childPeerId":%q,"transport":"direct","qualityProbe":false}}`, originalAuth.PeerID))
}

func TestSignalReplaysViewersWhenHostReconnects(t *testing.T) {
	h := startHarness(t, harnessOptions{viewerDisconnectGraceMs: 500})
	viewer := openClient(t, h)
	viewerAuth := authenticate(t, viewer, h.room, protocol.RoleViewer, "viewer-client-stable", 1, "", presenceOptions{})
	firstHost := openClient(t, h)
	firstHostAuth := authenticate(t, firstHost, h.room, protocol.RoleHost, "host-client-stable", 1, "", presenceOptions{})
	commitPreparedRoute(t, viewer)
	viewer.next("host-status")
	firstHost.sendJSON(signalDescription(viewerAuth.PeerID, "connection-before-control-outage", "offer"))
	viewer.next("signal")

	h.closeClient(firstHost)
	expectMatch(t, viewer.next("host-status").raw, `{"online":false}`)
	h.closeClient(viewer)
	refreshedViewer := openClient(t, h)
	refreshedViewerAuth := authenticate(t, refreshedViewer, h.room, protocol.RoleViewer, "viewer-client-stable", 1, "", presenceOptions{})
	expectString(t, "peer", refreshedViewerAuth.PeerID, viewerAuth.PeerID)
	expectTrue(t, "host must be offline", !refreshedViewerAuth.HostOnline)

	secondHost := openClient(t, h)
	secondHostAuth := authenticate(t, secondHost, h.room, protocol.RoleHost, "host-client-stable", 1, "", presenceOptions{})
	expectString(t, "host peer", secondHostAuth.PeerID, firstHostAuth.PeerID)
	var viewerPeerIDs []string
	h.locked(func() { viewerPeerIDs = h.store.GetViewerPeerIDs(h.room.RoomID) })
	expectStrings(t, "viewer peers", viewerPeerIDs, []string{viewerAuth.PeerID})
	nextActiveRouteRevision(t, secondHost, secondHostAuth.RouteRevision)
	expectMatch(t, refreshedViewer.next("host-status").raw, `{"online":true}`)
}

func TestSignalReconcilesEmptyRosterAfterViewerGracePeriodEndsOffline(t *testing.T) {
	h := startHarness(t, harnessOptions{viewerDisconnectGraceMs: 30})
	firstHost := openClient(t, h)
	firstHostAuth := authenticate(t, firstHost, h.room, protocol.RoleHost, "host-client-roster", 1, "", presenceOptions{})
	viewer := openClient(t, h)
	authenticate(t, viewer, h.room, protocol.RoleViewer, "viewer-client-roster", 1, "", presenceOptions{})
	commitPreparedRoute(t, viewer)

	h.closeClient(firstHost)
	h.closeClient(viewer)
	time.Sleep(70 * time.Millisecond)

	secondHost := openClient(t, h)
	secondHostAuth := authenticate(t, secondHost, h.room, protocol.RoleHost, "host-client-roster", 1, "", presenceOptions{})
	expectString(t, "host peer", secondHostAuth.PeerID, firstHostAuth.PeerID)
	var viewerPeerIDs []string
	h.locked(func() { viewerPeerIDs = h.store.GetViewerPeerIDs(h.room.RoomID) })
	if len(viewerPeerIDs) != 0 {
		t.Fatalf("viewer peers: %v", viewerPeerIDs)
	}
	nextActiveRouteRevision(t, secondHost, secondHostAuth.RouteRevision)
	secondHost.expectNone(30 * time.Millisecond)
}

func TestSignalKeepsMediaIdentityThroughGraceWhilePresenceReturnsOnce(t *testing.T) {
	h := startHarness(t, harnessOptions{viewerDisconnectGraceMs: 500})
	firstHost := openClient(t, h)
	firstHostAuth := authenticate(t, firstHost, h.room, protocol.RoleHost, "host-client-grace-roster", 1, "",
		presenceOptions{viewerPresence: true})
	if entries := viewerPresenceEntries(parsePresence(t, firstHost.next("viewer-presence").raw)); len(entries) != 0 {
		t.Fatalf("initial roster: %v", entries)
	}
	firstViewer := openClient(t, h)
	firstViewerAuth := authenticate(t, firstViewer, h.room, protocol.RoleViewer, "viewer-client-grace-roster", 1, "",
		presenceOptions{displayName: "短线重连"})
	commitPreparedRoute(t, firstViewer)
	expectMatch(t, viewerEntriesJSON(t, nextViewerPresenceMatching(t, firstHost, func(message presenceMessage) bool {
		return slices.ContainsFunc(viewerPresenceEntries(message), func(entry presenceEntry) bool {
			return entry.Upstream.Kind == "peer"
		})
	})), fmt.Sprintf(
		`[{"role":"viewer","peerId":%q,"displayName":"短线重连","upstream":{"kind":"peer","peerId":%q}}]`,
		firstViewerAuth.PeerID, firstHostAuth.PeerID))
	firstHost.sendJSON(signalDescription(firstViewerAuth.PeerID, "connection-during-grace", "offer"))
	firstViewer.next("signal")

	h.closeClient(firstViewer)
	if entries := viewerPresenceEntries(parsePresence(t, firstHost.next("viewer-presence").raw)); len(entries) != 0 {
		t.Fatalf("roster after viewer left: %v", entries)
	}
	h.closeClient(firstHost)

	secondHost := openClient(t, h)
	secondHostAuth := authenticate(t, secondHost, h.room, protocol.RoleHost, "host-client-grace-roster", 1, "",
		presenceOptions{viewerPresence: true})
	var viewerPeerIDs []string
	h.locked(func() { viewerPeerIDs = h.store.GetViewerPeerIDs(h.room.RoomID) })
	expectStrings(t, "viewer peers", viewerPeerIDs, []string{firstViewerAuth.PeerID})
	if entries := viewerPresenceEntries(parsePresence(t, secondHost.next("viewer-presence").raw)); len(entries) != 0 {
		t.Fatalf("second host roster: %v", entries)
	}

	secondViewer := openClient(t, h)
	secondViewerAuth := authenticate(t, secondViewer, h.room, protocol.RoleViewer, "viewer-client-grace-roster", 1, "",
		presenceOptions{displayName: "短线重连"})
	expectString(t, "peer", secondViewerAuth.PeerID, firstViewerAuth.PeerID)
	if secondViewerAuth.ConnectionID == nil || *secondViewerAuth.ConnectionID != "connection-during-grace" {
		t.Fatalf("connectionId: %v", secondViewerAuth.ConnectionID)
	}
	expectEqual(t, viewerEntriesJSON(t, nextViewerPresenceMatching(t, secondHost, func(message presenceMessage) bool {
		return slices.ContainsFunc(viewerPresenceEntries(message), func(entry presenceEntry) bool {
			return entry.PeerID == firstViewerAuth.PeerID
		})
	})), fmt.Sprintf(
		`[{"role":"viewer","peerId":%q,"displayName":"短线重连","upstream":{"kind":"peer","peerId":%q},"mediaReady":true}]`,
		firstViewerAuth.PeerID, secondHostAuth.PeerID))
	expectNoViewerPresenceMatching(t, secondHost, func(message presenceMessage) bool {
		return !slices.ContainsFunc(viewerPresenceEntries(message), func(entry presenceEntry) bool {
			return entry.PeerID == firstViewerAuth.PeerID
		})
	}, 30*time.Millisecond)

	secondViewer.sendJSON(map[string]any{
		"type":         "restart-request",
		"targetPeerId": secondHostAuth.PeerID,
		"connectionId": *secondViewerAuth.ConnectionID,
		"rebuild":      false,
	})
	expectMatch(t, secondHost.next("restart-request").raw, fmt.Sprintf(
		`{"fromPeerId":%q,"connectionId":"connection-during-grace","rebuild":false}`, firstViewerAuth.PeerID))
}

// ---------------------------------------------------------------------------
// capacity and abandonment
// ---------------------------------------------------------------------------

func TestSignalStopsSharingWithoutDeletingRoomAndRestrictsRoomAbandonment(t *testing.T) {
	maxViewersPerRoom := 5
	h := startHarness(t, harnessOptions{maxViewersPerRoom: maxViewersPerRoom})
	host := openClient(t, h)
	hostAuth := authenticate(t, host, h.room, protocol.RoleHost, "host-client-stable", 1, "", presenceOptions{})
	if hostAuth.MaxViewers != maxViewersPerRoom {
		t.Fatalf("maxViewers %d", hostAuth.MaxViewers)
	}
	var viewers []*testClient
	for index := 1; index <= maxViewersPerRoom; index++ {
		viewer := openClient(t, h)
		viewerAuth := authenticate(t, viewer, h.room, protocol.RoleViewer, fmt.Sprintf("viewer-client-%d", index), 1, "", presenceOptions{})
		if viewerAuth.MaxViewers != maxViewersPerRoom {
			t.Fatalf("viewer maxViewers %d", viewerAuth.MaxViewers)
		}
		commitPreparedRoute(t, viewer)
		viewers = append(viewers, viewer)
	}

	overflow := openClient(t, h)
	overflow.sendJSON(map[string]any{
		"type":        "authenticate",
		"protocol":    protocol.SignalingProtocol,
		"roomId":      h.room.RoomID,
		"role":        protocol.RoleViewer,
		"viewerGrant": h.room.ViewerGrant,
		"clientId":    fmt.Sprintf("viewer-client-%d", maxViewersPerRoom+1),
	})
	expectMatch(t, overflow.next("error").raw, `{"code":"ROOM_FULL"}`)

	host.sendJSON(map[string]any{"type": "stop-sharing"})
	for _, viewer := range viewers {
		expectEqual(t, viewer.next("sharing-stopped").raw, `{"type":"sharing-stopped"}`)
		expectMatch(t, viewer.next("host-status").raw, `{"online":false}`)
	}
	expectCloseCode(t, host, 1000)
	if size := h.storeSize(); size != 1 {
		t.Fatalf("store size %d", size)
	}

	viewers[0].sendJSON(map[string]any{"type": "abandon-room"})
	expectMatch(t, viewers[0].next("error").raw, `{"code":"FORBIDDEN"}`)
	if size := h.storeSize(); size != 1 {
		t.Fatalf("store size %d", size)
	}

	abandonHost := openClient(t, h)
	authenticate(t, abandonHost, h.room, protocol.RoleHost, "host-client-stable", 1, "", presenceOptions{})
	abandonHost.sendJSON(map[string]any{"type": "abandon-room"})
	expectMatch(t, abandonHost.next("room-closed").raw, `{"reason":"host-ended"}`)
	for _, viewer := range viewers {
		expectMatch(t, viewer.next("room-closed").raw, `{"reason":"host-ended"}`)
	}
	if size := h.storeSize(); size != 0 {
		t.Fatalf("store size %d", size)
	}
}

// ---------------------------------------------------------------------------
// transport hardening
// ---------------------------------------------------------------------------

func TestSignalRequiresAllowedOriginTimelyAuthenticationAndBoundedPayloads(t *testing.T) {
	h := startHarness(t, harnessOptions{authenticationTimeoutMs: 30})
	if status := rejectedUpgradeStatus(t, h, allowedOrigin+"/path"); status != 403 {
		t.Fatalf("origin with path: %d", status)
	}
	if status := rejectedUpgradeStatus(t, h, "https://foreign.example.test"); status != 403 {
		t.Fatalf("foreign origin: %d", status)
	}

	unauthenticated := openClient(t, h)
	expectMatch(t, unauthenticated.nextWithin("error", 300*time.Millisecond).raw, `{"code":"AUTH_REQUIRED"}`)
	expectCloseCode(t, unauthenticated, 4003)

	oversized := openClient(t, h)
	oversized.sendText(strings.Repeat("x", protocol.MaxSignalBytes+1))
	expectCloseCode(t, oversized, 1009)
}

func TestClosingSignalSessionDoesNotReserveLateViewerAdmission(t *testing.T) {
	h := startHarness(t, harnessOptions{})
	client := openClient(t, h)
	if !waitFor(t, defaultWait, func() bool { return h.sessionCount() == 1 }) {
		t.Fatal("signaling session was not registered")
	}
	message, err := json.Marshal(map[string]any{
		"type": "authenticate", "protocol": protocol.SignalingProtocol,
		"roomId": h.room.RoomID, "role": protocol.RoleViewer, "clientId": "late-viewer",
	})
	if err != nil {
		t.Fatal(err)
	}
	h.locked(func() {
		sess := h.server.sessions.Keys()[0]
		// An authentication deadline can queue close before a frame already
		// read from the socket acquires the signaling lock.
		sess.close(websocket.StatusCode(protocol.SignalCloseAuthenticationFailed), "Authentication required")
		h.server.handleMessage(sess, message)
		if peers := h.store.GetViewerPeerIDs(h.room.RoomID); len(peers) != 0 {
			t.Fatalf("closing session left room capacity reserved: %v", peers)
		}
	})
	expectCloseCode(t, client, int(protocol.SignalCloseAuthenticationFailed))
}

func TestSignalTerminatesStaleV12BeforeAuthentication(t *testing.T) {
	h := startHarness(t, harnessOptions{})
	invalidClient := openClient(t, h)
	invalidClient.sendJSON(map[string]any{
		"type":     "authenticate",
		"protocol": "piik-v12",
		"roomId":   h.room.RoomID,
		"role":     protocol.RoleViewer,
		"clientId": "invalid-client",
	})
	expectMatch(t, invalidClient.next("error").raw, `{"code":"INVALID_MESSAGE"}`)
	expectClose(t, invalidClient, 1008, "Invalid message")
}

func TestSignalRejectsInvalidUpgradeRequestTargetWithoutStoppingServer(t *testing.T) {
	h := startHarness(t, harnessOptions{})
	for _, testCase := range []struct{ target, status string }{
		// new URL("//[", "http://localhost") throws (signaling.ts:186-190).
		{"//[", "HTTP/1.1 400 Bad Request"},
		// WHATWG pathname is not percent-decoded, so this is not "/signal".
		{"/%73ignal", "HTTP/1.1 404 Not Found"},
	} {
		response := rawUpgradeResponse(t, h, testCase.target)
		if !strings.HasPrefix(response, testCase.status) {
			t.Fatalf("target %q: raw response %q, want %s", testCase.target, response, testCase.status)
		}
	}

	host := openClient(t, h)
	hostAuth := authenticate(t, host, h.room, protocol.RoleHost, "host-after-invalid-url", 1, "", presenceOptions{})
	expectString(t, "role", hostAuth.Role, protocol.RoleHost)
}

func TestSignalRejectsUnauthenticatedAndTotalConnectionOverflowBeforeUpgrade(t *testing.T) {
	h := startHarness(t, harnessOptions{maxSignalConnections: 2, maxUnauthenticatedSignalConnections: 1})
	host := openClient(t, h)
	if status := rejectedUpgradeStatus(t, h, allowedOrigin); status != 503 {
		t.Fatalf("unauthenticated overflow: %d", status)
	}

	authenticate(t, host, h.room, protocol.RoleHost, "capacity-host", 1, "", presenceOptions{})
	viewer := openClient(t, h)
	authenticate(t, viewer, h.room, protocol.RoleViewer, "capacity-viewer", 1, "", presenceOptions{})
	if status := rejectedUpgradeStatus(t, h, allowedOrigin); status != 503 {
		t.Fatalf("total overflow: %d", status)
	}
}

// ---------------------------------------------------------------------------
// Go-only coverage: the TS suite never exercised the heartbeat (it ran at
// 60 s) or the outbound buffer bound; both are new concurrency code here.
// ---------------------------------------------------------------------------

// timerQueue is an AfterFunc whose callbacks fire only on demand.
type timerQueue struct {
	mu      sync.Mutex
	entries []*queuedTimer
}

type queuedTimer struct {
	duration time.Duration
	fn       func()
	stopped  bool
}

func (m *timerQueue) afterFunc(duration time.Duration, fn func()) func() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	entry := &queuedTimer{duration: duration, fn: fn}
	m.entries = append(m.entries, entry)
	return func() bool {
		m.mu.Lock()
		defer m.mu.Unlock()
		stopped := !entry.stopped
		entry.stopped = true
		return stopped
	}
}

// fire runs every pending callback armed with exactly duration.
func (m *timerQueue) fire(duration time.Duration) {
	m.fireWhere(func(armed time.Duration) bool { return armed == duration })
}

// fireDue runs every pending callback armed with less than limit.
func (m *timerQueue) fireDue(limit time.Duration) {
	m.fireWhere(func(armed time.Duration) bool { return armed < limit })
}

func (m *timerQueue) fireWhere(due func(time.Duration) bool) {
	m.mu.Lock()
	var fired []*queuedTimer
	m.entries = slices.DeleteFunc(m.entries, func(entry *queuedTimer) bool {
		if entry.stopped {
			return true
		}
		if due(entry.duration) {
			fired = append(fired, entry)
			return true
		}
		return false
	})
	m.mu.Unlock()
	for _, entry := range fired {
		entry.fn()
	}
}

func TestSignalHeartbeatTerminatesSilentConnectionAfterMissedPong(t *testing.T) {
	timers := &timerQueue{}
	h := startHarness(t, harnessOptions{afterFunc: timers.afterFunc})
	heartbeat := 60_000 * time.Millisecond
	responsive := openClient(t, h)
	header := http.Header{}
	header.Set("Origin", allowedOrigin)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	silentConn, _, err := websocket.Dial(ctx, h.wsURL, &websocket.DialOptions{
		HTTPHeader: header,
		// A false return suppresses the pong.
		OnPingReceived: func(context.Context, []byte) bool { return false },
	})
	if err != nil {
		t.Fatalf("websocket.Dial: %v", err)
	}
	silent := newTestClient(t, silentConn)
	// The client sees the 101 before the server goroutine registers the
	// session under mu (the slot itself is already reserved), so wait.
	if !waitFor(t, defaultWait, func() bool { return h.sessionCount() == 2 }) {
		t.Fatalf("sessions: %d", h.sessionCount())
	}

	aliveSessions := func() int {
		alive := 0
		h.locked(func() {
			for sess := range h.server.sessions.All() {
				if sess.alive {
					alive++
				}
			}
		})
		return alive
	}
	timers.fire(heartbeat)
	if !waitFor(t, defaultWait, func() bool { return aliveSessions() == 1 }) {
		t.Fatalf("expected exactly the responsive session to answer the ping, alive=%d", aliveSessions())
	}
	timers.fire(heartbeat)
	silent.closeCode()
	if !waitFor(t, defaultWait, func() bool { return h.sessionCount() == 1 }) {
		t.Fatalf("silent session was not terminated")
	}
	expectTrue(t, "responsive client must stay open", !responsive.isClosed())
	hostAuth := authenticate(t, responsive, h.room, protocol.RoleHost, "heartbeat-host", 1, "", presenceOptions{})
	expectString(t, "role", hostAuth.Role, protocol.RoleHost)
}

func TestSignalTerminatesConnectionAboveOutboundBufferBound(t *testing.T) {
	h := startHarness(t, harnessOptions{})
	over := newSession(nil, true)
	closed := newSession(nil, true)
	h.locked(func() {
		over.queuedBytes = maxBufferedSignalBytes + 1
		h.server.sendEncoded(over, []byte("{}"))
		closed.close(websocket.StatusNormalClosure, "bye")
		h.server.sendEncoded(closed, []byte("{}"))
	})
	expectTrue(t, "a session above the bound is terminated, not queued", over.terminated && len(over.queue) == 0)
	expectTrue(t, "a closing session drops sends without terminating", !closed.terminated && len(closed.queue) == 1)
}

// TS signaling.ts:233-259: close() set `closing` and ran the router's close()
// up to its first await in the same tick, so no router timer could act in
// between. In Go a deadline callback parked on mu while Close runs must find
// the router already closing; otherwise it advances the operation and starts
// a pump that creates a LiveKit room during shutdown. The interleaving is
// forced through sync.Mutex starvation mode: a waiter that has waited over
// 1 ms and wakes to a locked mutex switches it to starvation mode, after
// which Unlock hands the lock to the front waiter in FIFO order, so Close
// (queued first) runs its locked prefix and its Unlock hands the lock
// straight to the callback (queued second) with no chance to re-acquire.
func TestSignalCloseMarksRouterClosingBeforeReleasingTheLock(t *testing.T) {
	timers := &timerQueue{}
	now := newClock(utcMillis(2026, time.August, 24, 12))
	control := sfutest.New()
	h := startHarness(t, harnessOptions{
		afterFunc: timers.afterFunc,
		now:       now.now,
		sfu: &SfuFallback{
			Admission:        sfu.NewAdmission(sfu.AdmissionOptions{IngressCapacity: 2, EgressCapacity: 20}),
			Media:            control,
			PrepareTimeoutMs: 300,
		},
	})
	host := openClient(t, h)
	authenticate(t, host, h.room, protocol.RoleHost, "close-window-host", 1, "", presenceOptions{})
	viewer := openClient(t, h)
	authenticate(t, viewer, h.room, protocol.RoleViewer, "close-window-viewer", 1, "", presenceOptions{})
	// The direct candidate is prepared; once the pump driver settles its
	// boundary deadline (150 ms) is the only short timer armed.
	nextPreparedRoute(t, viewer)
	routerIdle := func() bool {
		idle := false
		h.locked(func() { idle = h.server.router.inflight == 0 })
		return idle
	}
	if !waitFor(t, defaultWait, routerIdle) {
		t.Fatal("pump driver did not settle")
	}
	now.advance(150)

	h.server.mu.Lock()
	closed := make(chan error, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		closed <- h.server.Close(ctx)
	}()
	time.Sleep(50 * time.Millisecond) // Close is queued on mu first...
	fired := make(chan struct{})
	go func() {
		timers.fireDue(time.Minute) // ...the deadline callback second.
		close(fired)
	}()
	time.Sleep(50 * time.Millisecond)
	// Wake Close and take the lock back before it runs: it finds the mutex
	// locked after a long wait, flips starvation mode and requeues at the
	// front. From here every Unlock is a FIFO handoff.
	h.server.mu.Unlock()
	h.server.mu.Lock()
	time.Sleep(50 * time.Millisecond)
	h.server.mu.Unlock()

	if err := <-closed; err != nil {
		t.Fatalf("Close: %v", err)
	}
	<-fired
	if !waitFor(t, defaultWait, routerIdle) {
		t.Fatal("router goroutines did not settle after Close")
	}
	if created := control.Created(); len(created) != 0 {
		t.Fatalf("a deadline firing during Close created %d LiveKit room(s)", len(created))
	}
	h.close()
}
