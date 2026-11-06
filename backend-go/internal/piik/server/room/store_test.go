package room

import (
	"bytes"
	"errors"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"zviewer/backend/internal/piik/server/protocol"
)

// The scenarios below are ported from tests/room-store.test.ts.

func newStore(t *testing.T, options Options) *Store {
	t.Helper()
	if options.MaxRooms == 0 {
		options.MaxRooms = 2
	}
	if options.MaxViewersPerRoom == 0 {
		options.MaxViewersPerRoom = 2
	}
	store, err := New(options)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if err := store.Initialize(); err != nil {
		t.Fatalf("Initialize: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store
}

func constantRandom(value func(size int) byte) func(size int) []byte {
	return func(size int) []byte { return bytes.Repeat([]byte{value(size)}, size) }
}

// tryCreateRoom runs the locked/unlocked/locked createRoom sequence the package
// comment documents.
func tryCreateRoom(
	store *Store, policy protocol.CodeEntryPolicy, password, preferredRoomID string,
) (CreatedRoom, error) {
	if err := store.BeginCreateRoom(); err != nil {
		return CreatedRoom{}, err
	}
	var material []byte
	var derived error
	if password != "" {
		material, derived = store.DeriveViewerPasswordMaterial(password, nil)
	}
	return store.CreateRoom(policy, material, derived, preferredRoomID)
}

func createRoom(
	t *testing.T, store *Store, policy protocol.CodeEntryPolicy, password, preferredRoomID string,
) CreatedRoom {
	t.Helper()
	created, err := tryCreateRoom(store, policy, password, preferredRoomID)
	if err != nil {
		t.Fatalf("CreateRoom: %v", err)
	}
	return created
}

func tryReplaceRoom(
	store *Store, roomID, hostToken string, policy protocol.CodeEntryPolicy, password string,
) (ReplacedRoom, error) {
	current, err := store.HostManagedRoom(roomID, hostToken)
	if err != nil {
		return ReplacedRoom{}, err
	}
	var material []byte
	var derived error
	if password != "" {
		material, derived = store.DeriveViewerPasswordMaterial(password, func() bool {
			return store.HostStillOwnsRoom(roomID, hostToken, current)
		})
	}
	return store.ReplaceRoom(roomID, hostToken, policy, material, derived, current)
}

func trySetViewerPassword(store *Store, roomID, password, hostToken string) (bool, error) {
	current, err := store.HostManagedRoom(roomID, hostToken)
	if err != nil {
		return false, err
	}
	var material []byte
	var derived error
	if password != "" {
		material, derived = store.DeriveViewerPasswordMaterial(password, func() bool {
			return store.HostStillOwnsRoom(roomID, hostToken, current)
		})
	}
	return store.SetViewerPassword(roomID, hostToken, material, derived, current)
}

func tryConnectViewerWithPassword(
	store *Store, input ConnectViewerWithPasswordInput, mayConnect func() bool,
) (ConnectedParticipant, error) {
	if mayConnect == nil {
		mayConnect = func() bool { return true }
	}
	salt, expectedMaterial, room, err := store.ViewerPasswordChallenge(input.RoomID)
	if err != nil {
		return ConnectedParticipant{}, err
	}
	derived, err := store.DeriveViewerPassword(input.Password, salt, mayConnect)
	if err != nil {
		return ConnectedParticipant{}, err
	}
	return store.ConnectViewerWithPassword(input, derived, expectedMaterial, room, mayConnect)
}

func hostInput(roomID, hostToken string, sessionID ...string) ConnectParticipantInput {
	session := "host-session"
	if len(sessionID) > 0 {
		session = sessionID[0]
	}
	return ConnectParticipantInput{
		RoomID:    roomID,
		Role:      protocol.RoleHost,
		Token:     hostToken,
		ClientID:  "host-client",
		SessionID: session,
	}
}

func viewerInput(roomID, sessionID, viewerGrant string) ConnectParticipantInput {
	return ConnectParticipantInput{
		RoomID:      roomID,
		Role:        protocol.RoleViewer,
		ViewerGrant: viewerGrant,
		ClientID:    "viewer-" + sessionID,
		SessionID:   sessionID,
	}
}

func expectCode(t *testing.T, err error, code ErrorCode) {
	t.Helper()
	if !hasCode(err, code) {
		t.Fatalf("expected %s, got %v", code, err)
	}
}

func mustConnect(t *testing.T, store *Store, input ConnectParticipantInput) ConnectedParticipant {
	t.Helper()
	connected, err := store.ConnectParticipant(input)
	if err != nil {
		t.Fatalf("ConnectParticipant: %v", err)
	}
	return connected
}

var roomCodePattern = regexp.MustCompile(`^[1-9][0-9]{3}$`)
var viewerGrantPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{21}[AQgw]$`)

func TestAllocatesEveryFreeRoomCodeAndRecyclesReleases(t *testing.T) {
	store := newStore(t, Options{
		MaxRooms: Capacity,
		Random:   constantRandom(func(int) byte { return 0 }),
	})

	rooms := make([]CreatedRoom, 0, Capacity)
	seen := make(map[string]struct{}, Capacity)
	for index := 0; index < Capacity; index++ {
		created := createRoom(t, store, protocol.CodeEntryOpen, "", "")
		if !roomCodePattern.MatchString(created.RoomID) {
			t.Fatalf("room code %q is not four digits", created.RoomID)
		}
		seen[created.RoomID] = struct{}{}
		rooms = append(rooms, created)
	}
	if len(seen) != Capacity {
		t.Fatalf("allocated %d distinct codes, want %d", len(seen), Capacity)
	}
	if _, err := tryCreateRoom(store, protocol.CodeEntryOpen, "", ""); !hasCode(err, CodeRoomLimit) {
		t.Fatalf("expected ROOM_LIMIT, got %v", err)
	}

	released := rooms[4_321].RoomID
	closed, err := store.AbandonRoom(released)
	if err != nil || closed == nil || closed.RoomID != released {
		t.Fatalf("AbandonRoom(%s) = %v, %v", released, closed, err)
	}
	if created := createRoom(t, store, protocol.CodeEntryOpen, "", ""); created.RoomID != released {
		t.Fatalf("recycled code = %q, want %q", created.RoomID, released)
	}
}

func TestUsesAFreePreferredCodeAndFallsBack(t *testing.T) {
	store := newStore(t, Options{MaxRooms: 3})

	preferred := createRoom(t, store, protocol.CodeEntryOpen, "", "4321")
	fallback := createRoom(t, store, protocol.CodeEntryOpen, "", "4321")

	if preferred.RoomID != "4321" {
		t.Fatalf("preferred code = %q", preferred.RoomID)
	}
	if fallback.RoomID == "4321" {
		t.Fatal("fallback reused the occupied preferred code")
	}
	if closed, err := store.AbandonRoom("4321"); err != nil || closed.RoomID != "4321" {
		t.Fatalf("AbandonRoom = %v, %v", closed, err)
	}
	if again := createRoom(t, store, protocol.CodeEntryOpen, "", "4321"); again.RoomID != "4321" {
		t.Fatalf("released preferred code = %q", again.RoomID)
	}
}

func TestAbandonsEveryCurrentRoomAsOneShutdown(t *testing.T) {
	store := newStore(t, Options{MaxRooms: 3})
	first := createRoom(t, store, protocol.CodeEntryOpen, "", "")
	second := createRoom(t, store, protocol.CodeEntryOpen, "", "")
	mustConnect(t, store, hostInput(first.RoomID, first.HostToken))

	closed, err := store.AbandonAllRooms()
	if err != nil {
		t.Fatalf("AbandonAllRooms: %v", err)
	}
	if len(closed) != 2 {
		t.Fatalf("closed %d rooms, want 2", len(closed))
	}
	// Room insertion order is contract: the JS Map iterated in creation order.
	if closed[0].RoomID != first.RoomID || closed[1].RoomID != second.RoomID {
		t.Fatalf("closed order = %q, %q", closed[0].RoomID, closed[1].RoomID)
	}
	if len(closed[0].SessionIDs) != 1 || closed[0].SessionIDs[0] != "host-session" {
		t.Fatalf("closed sessions = %v", closed[0].SessionIDs)
	}
	if len(closed[1].SessionIDs) != 0 {
		t.Fatalf("second room sessions = %v", closed[1].SessionIDs)
	}
	if store.Size() != 0 {
		t.Fatalf("size = %d, want 0", store.Size())
	}
}

func TestAtomicallyReplacesARoomWithDifferentAuthority(t *testing.T) {
	store := newStore(t, Options{})
	original := createRoom(t, store, protocol.CodeEntryPrivate, "old-password", "4321")
	host := mustConnect(t, store, hostInput(original.RoomID, original.HostToken))
	mustConnect(t, store, viewerInput(original.RoomID, "viewer-session", original.ViewerGrant))

	_, err := tryReplaceRoom(
		store, original.RoomID, original.HostToken, protocol.CodeEntryPrivate, "bad password")
	expectCode(t, err, CodeInvalidToken)
	if connected, ok := store.GetConnectedHost(original.RoomID); !ok || connected.PeerID != host.PeerID {
		t.Fatalf("host lost after a rejected replacement: %v %v", connected, ok)
	}

	replacement, err := tryReplaceRoom(
		store, original.RoomID, original.HostToken, protocol.CodeEntryPrivate, "new-password")
	if err != nil {
		t.Fatalf("ReplaceRoom: %v", err)
	}
	if replacement.Created.RoomID == original.RoomID {
		t.Fatal("replacement reused the room code")
	}
	if replacement.Closed.RoomID != original.RoomID ||
		len(replacement.Closed.SessionIDs) != 2 ||
		replacement.Closed.SessionIDs[0] != "host-session" ||
		replacement.Closed.SessionIDs[1] != "viewer-session" {
		t.Fatalf("closed = %+v", replacement.Closed)
	}
	_, err = store.ConnectParticipant(hostInput(original.RoomID, original.HostToken))
	expectCode(t, err, CodeInvalidToken)
	connected := mustConnect(t, store, viewerInput(
		replacement.Created.RoomID, "new-viewer-session", replacement.Created.ViewerGrant))
	if connected.RoomID != replacement.Created.RoomID {
		t.Fatalf("viewer joined %q", connected.RoomID)
	}
	withPassword, err := tryConnectViewerWithPassword(store, ConnectViewerWithPasswordInput{
		RoomID:    replacement.Created.RoomID,
		Password:  "new-password",
		ClientID:  "password-viewer",
		SessionID: "password-session",
	}, nil)
	if err != nil || withPassword.RoomID != replacement.Created.RoomID {
		t.Fatalf("password login after replacement: %+v %v", withPassword, err)
	}
}

func TestRejectsRoomLimitsBeyondTheCodeSpace(t *testing.T) {
	_, err := New(Options{MaxRooms: Capacity + 1, MaxViewersPerRoom: 2})
	if err == nil || err.Error() != "Room limit must be an integer between 1 and 9000" {
		t.Fatalf("New: %v", err)
	}
}

func TestResumesDisconnectedRoomOnlyWithTheExactHostToken(t *testing.T) {
	store := newStore(t, Options{})
	room := createRoom(t, store, protocol.CodeEntryOpen, "", "")
	host := mustConnect(t, store, hostInput(room.RoomID, room.HostToken))

	if _, err := store.DisconnectParticipant(room.RoomID, host.PeerID, "host-session"); err != nil {
		t.Fatalf("DisconnectParticipant: %v", err)
	}
	_, err := store.ConnectParticipant(hostInput(room.RoomID, "wrong-token"))
	expectCode(t, err, CodeInvalidToken)
	resumed := mustConnect(t, store, hostInput(room.RoomID, room.HostToken, "host-session-2"))

	if _, err := store.DisconnectParticipant(
		room.RoomID, resumed.PeerID, "host-session-2"); err != nil {
		t.Fatalf("DisconnectParticipant: %v", err)
	}
	mustConnect(t, store, viewerInput(room.RoomID, "viewer-session", room.ViewerGrant))
	mustConnect(t, store, hostInput(room.RoomID, room.HostToken, "late-host"))
}

func TestManagesDormantAccessWithTheExactHostToken(t *testing.T) {
	store := newStore(t, Options{})
	room := createRoom(t, store, protocol.CodeEntryOpen, "", "")
	otherRoom := createRoom(t, store, protocol.CodeEntryOpen, "", "")

	_, err := trySetViewerPassword(store, room.RoomID, "room-password", "wrong-token")
	expectCode(t, err, CodeInvalidToken)
	_, err = store.SetCodeEntryPolicy(room.RoomID, protocol.CodeEntryPrivate, otherRoom.HostToken)
	expectCode(t, err, CodeInvalidToken)

	update, err := store.SetCodeEntryPolicy(
		room.RoomID, protocol.CodeEntryPrivate, room.HostToken)
	if err != nil || update.CodeEntryPolicy != protocol.CodeEntryPrivate ||
		update.ViewerPasswordEnabled {
		t.Fatalf("SetCodeEntryPolicy = %+v, %v", update, err)
	}
	if enabled, err := trySetViewerPassword(
		store, room.RoomID, "room-password", room.HostToken); err != nil || !enabled {
		t.Fatalf("SetViewerPassword = %v, %v", enabled, err)
	}
	if enabled, err := trySetViewerPassword(
		store, room.RoomID, "", room.HostToken); err != nil || enabled {
		t.Fatalf("cleared SetViewerPassword = %v, %v", enabled, err)
	}
	grant, err := store.SetViewerGrant(room.RoomID, "rotate", room.HostToken)
	if err != nil || !viewerGrantPattern.MatchString(grant.ViewerGrant) {
		t.Fatalf("SetViewerGrant = %+v, %v", grant, err)
	}
	if _, ok := store.GetConnectedHost(room.RoomID); ok {
		t.Fatal("a dormant room reported a connected host")
	}
}

func TestKeepsViewerGrantsIndependentFromCodeEntryPolicy(t *testing.T) {
	store := newStore(t, Options{MaxRooms: 3})
	room := createRoom(t, store, protocol.CodeEntryPrivate, "", "")

	_, err := store.ConnectParticipant(viewerInput(room.RoomID, "code-only", ""))
	expectCode(t, err, CodeInvalidToken)
	_, err = tryConnectViewerWithPassword(store, ConnectViewerWithPasswordInput{
		RoomID:    room.RoomID,
		Password:  "any-password",
		ClientID:  "private-code-viewer",
		SessionID: "private-code-session",
	}, nil)
	expectCode(t, err, CodeInvalidToken)
	granted := mustConnect(t, store, viewerInput(room.RoomID, "granted", room.ViewerGrant))
	if granted.Role != protocol.RoleViewer {
		t.Fatalf("role = %q", granted.Role)
	}
}

func TestKeepsTheExactViewerGrantValidForTheRoomIncarnation(t *testing.T) {
	store := newStore(t, Options{})
	room := createRoom(t, store, protocol.CodeEntryOpen, "", "")
	mustConnect(t, store, hostInput(room.RoomID, room.HostToken))

	if !viewerGrantPattern.MatchString(room.ViewerGrant) {
		t.Fatalf("viewer grant = %q", room.ViewerGrant)
	}
	connected := mustConnect(t, store, viewerInput(room.RoomID, "room-lived-grant", room.ViewerGrant))
	if connected.Role != protocol.RoleViewer {
		t.Fatalf("role = %q", connected.Role)
	}
}

func TestSupportsOpenAndPasswordEnabledPrivateCodeEntry(t *testing.T) {
	store := newStore(t, Options{MaxRooms: 3})
	open := createRoom(t, store, protocol.CodeEntryOpen, "", "")
	if connected := mustConnect(t, store, viewerInput(open.RoomID, "open", "")); connected.Role !=
		protocol.RoleViewer {
		t.Fatalf("role = %q", connected.Role)
	}

	password := createRoom(t, store, protocol.CodeEntryPrivate, "room-password", "")
	_, err := store.ConnectParticipant(viewerInput(password.RoomID, "wrong", ""))
	expectCode(t, err, CodeInvalidToken)
	connected, err := tryConnectViewerWithPassword(store, ConnectViewerWithPasswordInput{
		RoomID:    password.RoomID,
		Password:  "room-password",
		ClientID:  "password-viewer",
		SessionID: "password-session",
	}, nil)
	if err != nil || connected.Role != protocol.RoleViewer {
		t.Fatalf("password login = %+v, %v", connected, err)
	}
}

// gateState reads the KDF gate counters the way only a same-package test can.
func gateState(store *Store) (active, pending int) {
	store.gate.mu.Lock()
	defer store.gate.mu.Unlock()
	return store.gate.active, len(store.gate.waiters)
}

// withSaturatedGate holds the KDF gate at 2 running and 16 queued derivations
// for the duration of operation, which is what the vitest helper did by
// starting 18 password logins whose mayStart never returned.
func withSaturatedGate(t *testing.T, store *Store, operation func()) {
	t.Helper()
	release := make(chan struct{})
	var group sync.WaitGroup
	for index := 0; index < 18; index++ {
		group.Add(1)
		go func() {
			defer group.Done()
			_, _ = store.DeriveViewerPassword(
				"gate-password", make([]byte, viewerPasswordSaltBytes), func() bool {
					<-release
					return false
				})
		}()
	}
	defer func() {
		close(release)
		group.Wait()
	}()
	waitForSaturatedGate(t, store)
	operation()
}

func waitForSaturatedGate(t *testing.T, store *Store) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for {
		active, pending := gateState(store)
		if active == 2 && pending == 16 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("gate did not saturate: active=%d pending=%d", active, pending)
		}
		time.Sleep(time.Millisecond)
	}
}

func TestDoesNotCreateAPasswordlessRoomWhenTheGateIsBusy(t *testing.T) {
	store := newStore(t, Options{MaxRooms: 1})

	withSaturatedGate(t, store, func() {
		_, err := tryCreateRoom(store, protocol.CodeEntryPrivate, "room-password", "4321")
		expectCode(t, err, CodeRoomBusy)
	})
	if store.Size() != 0 {
		t.Fatalf("size = %d, want 0", store.Size())
	}
	if created := createRoom(t, store, protocol.CodeEntryPrivate, "", "4321"); created.RoomID != "4321" {
		t.Fatalf("room = %q, want 4321", created.RoomID)
	}
}

func TestKeepsGateSaturationDistinctFromInvalidCredentials(t *testing.T) {
	store := newStore(t, Options{})
	room := createRoom(t, store, protocol.CodeEntryPrivate, "room-password", "")

	withSaturatedGate(t, store, func() {
		_, err := tryConnectViewerWithPassword(store, ConnectViewerWithPasswordInput{
			RoomID:    room.RoomID,
			Password:  "room-password",
			ClientID:  "busy-password-client",
			SessionID: "busy-password-session",
		}, nil)
		expectCode(t, err, CodeRoomBusy)
	})
}

func TestKeepsRoomReplacementAndPasswordUpdatesUnchangedWhenBusy(t *testing.T) {
	store := newStore(t, Options{MaxRooms: 3})
	room := createRoom(t, store, protocol.CodeEntryPrivate, "old-password", "4321")

	withSaturatedGate(t, store, func() {
		_, err := tryReplaceRoom(
			store, room.RoomID, room.HostToken, protocol.CodeEntryPrivate, "replacement-password")
		expectCode(t, err, CodeRoomBusy)
	})
	if store.Size() != 1 {
		t.Fatalf("size = %d, want 1", store.Size())
	}
	if _, err := tryConnectViewerWithPassword(store, ConnectViewerWithPasswordInput{
		RoomID:    room.RoomID,
		Password:  "old-password",
		ClientID:  "after-replacement-client",
		SessionID: "after-replacement-session",
	}, nil); err != nil {
		t.Fatalf("password login after a busy replacement: %v", err)
	}

	withSaturatedGate(t, store, func() {
		_, err := trySetViewerPassword(store, room.RoomID, "updated-password", room.HostToken)
		expectCode(t, err, CodeRoomBusy)
	})
	if _, err := tryConnectViewerWithPassword(store, ConnectViewerWithPasswordInput{
		RoomID:    room.RoomID,
		Password:  "old-password",
		ClientID:  "after-update-client",
		SessionID: "after-update-session",
	}, nil); err != nil {
		t.Fatalf("password login after a busy update: %v", err)
	}
}

func TestBoundsPasswordDerivationsAndUsesTheSamePathForUnknownRooms(t *testing.T) {
	store := newStore(t, Options{})

	var mayStartCalls atomic.Int64
	release := make(chan struct{})
	results := make(chan error, 40)
	var group sync.WaitGroup
	for index := 0; index < 40; index++ {
		group.Add(1)
		go func(index int) {
			defer group.Done()
			_, err := tryConnectViewerWithPassword(store, ConnectViewerWithPasswordInput{
				RoomID:    "9999",
				Password:  "bounded-password",
				ClientID:  "bounded-client-" + strconv.Itoa(index),
				SessionID: "bounded-session-" + strconv.Itoa(index),
			}, func() bool {
				// The first two admitted hold their slot until every attempt
				// has been accepted or rejected, which the single-threaded
				// TypeScript got for free.
				if mayStartCalls.Add(1) <= 2 {
					<-release
					return true
				}
				return false
			})
			results <- err
		}(index)
	}
	waitForSaturatedGate(t, store)
	close(release)
	group.Wait()
	close(results)

	counts := map[ErrorCode]int{}
	for err := range results {
		var roomError *Error
		if !errors.As(err, &roomError) {
			t.Fatalf("unexpected error %v", err)
		}
		counts[roomError.Code]++
	}
	if calls := mayStartCalls.Load(); calls != 18 {
		t.Fatalf("mayStart calls = %d, want 18", calls)
	}
	if counts[CodeRoomNotFound] != 2 || counts[CodeInvalidToken] != 16 ||
		counts[CodeRoomBusy] != 22 {
		t.Fatalf("outcomes = %v", counts)
	}
}

func TestRotatesAndRevokesViewerGrantsWithoutChangingCodeEntry(t *testing.T) {
	store := newStore(t, Options{})
	room := createRoom(t, store, protocol.CodeEntryOpen, "", "")
	mustConnect(t, store, hostInput(room.RoomID, room.HostToken))

	rotated, err := store.SetViewerGrant(room.RoomID, "rotate", room.HostToken)
	if err != nil {
		t.Fatalf("rotate: %v", err)
	}
	_, err = store.ConnectParticipant(viewerInput(room.RoomID, "old-grant", room.ViewerGrant))
	expectCode(t, err, CodeInvalidToken)
	grantedViewer := mustConnect(t, store, viewerInput(room.RoomID, "new-grant", rotated.ViewerGrant))
	codeViewer := mustConnect(t, store, viewerInput(room.RoomID, "still-open", ""))

	revoked, err := store.SetViewerGrant(room.RoomID, "revoke", room.HostToken)
	if err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if revoked.ViewerGrant != "" {
		t.Fatalf("revoked grant = %q, want empty", revoked.ViewerGrant)
	}
	if len(revoked.RevokedViewers) != 1 || revoked.RevokedViewers[0].PeerID != grantedViewer.PeerID {
		t.Fatalf("revoked viewers = %+v", revoked.RevokedViewers)
	}
	if connected, ok := store.GetConnectedViewer(
		room.RoomID, codeViewer.PeerID); !ok || connected.SessionID != "still-open" {
		t.Fatalf("code viewer = %+v %v", connected, ok)
	}
	_, err = store.ConnectParticipant(viewerInput(room.RoomID, "revoked", rotated.ViewerGrant))
	expectCode(t, err, CodeInvalidToken)
}

func TestKeepsTheOldGrantWhenRotationCannotCreateAGeneration(t *testing.T) {
	failedRandomCall := 0
	randomCalls := 0
	randomValue := byte(0)
	store := newStore(t, Options{
		Random: func(size int) []byte {
			randomCalls++
			randomValue++
			if randomCalls == failedRandomCall {
				size--
			}
			return bytes.Repeat([]byte{randomValue}, size)
		},
	})
	room := createRoom(t, store, protocol.CodeEntryOpen, "", "")
	mustConnect(t, store, hostInput(room.RoomID, room.HostToken))
	viewer := mustConnect(t, store, viewerInput(room.RoomID, "existing", room.ViewerGrant))

	failedRandomCall = randomCalls + 2
	_, err := store.SetViewerGrant(room.RoomID, "rotate", room.HostToken)
	if err == nil ||
		err.Error() != "Authorization generation random source must return 16 bytes" {
		t.Fatalf("rotate: %v", err)
	}
	failedRandomCall = 0

	if connected, ok := store.GetConnectedViewer(
		room.RoomID, viewer.PeerID); !ok || connected.SessionID != "existing" {
		t.Fatalf("viewer = %+v %v", connected, ok)
	}
	connected := mustConnect(t, store, viewerInput(
		room.RoomID, "old-grant-still-valid", room.ViewerGrant))
	if connected.Role != protocol.RoleViewer {
		t.Fatalf("role = %q", connected.Role)
	}
}

func TestClearsEveryCredentialOnProcessRestart(t *testing.T) {
	firstStore := newStore(t, Options{})
	room := createRoom(t, firstStore, protocol.CodeEntryPrivate, "room-password", "")
	secondStore := newStore(t, Options{})

	replacement := createRoom(t, secondStore, protocol.CodeEntryOpen, "", "")
	if !roomCodePattern.MatchString(replacement.RoomID) {
		t.Fatalf("room code = %q", replacement.RoomID)
	}
	_, err := secondStore.ConnectParticipant(hostInput(room.RoomID, room.HostToken))
	expectCode(t, err, CodeInvalidToken)
	_, err = secondStore.ConnectParticipant(viewerInput(room.RoomID, "old-grant", room.ViewerGrant))
	expectCode(t, err, CodeInvalidToken)
	_, err = tryConnectViewerWithPassword(secondStore, ConnectViewerWithPasswordInput{
		RoomID:    room.RoomID,
		Password:  "room-password",
		ClientID:  "viewer",
		SessionID: "session",
	}, nil)
	expectCode(t, err, CodeRoomNotFound)
}

func TestRejectsAnOldGrantWhenANewRoomReusesTheSameCode(t *testing.T) {
	firstStore := newStore(t, Options{
		Random: constantRandom(func(size int) byte {
			if size == 8 {
				return 0
			}
			return 1
		}),
	})
	firstRoom := createRoom(t, firstStore, protocol.CodeEntryOpen, "", "")
	if _, err := firstStore.AbandonRoom(firstRoom.RoomID); err != nil {
		t.Fatalf("AbandonRoom: %v", err)
	}

	secondStore := newStore(t, Options{
		Random: constantRandom(func(size int) byte {
			if size == 8 {
				return 0
			}
			return 2
		}),
	})
	secondRoom := createRoom(t, secondStore, protocol.CodeEntryOpen, "", "")

	if secondRoom.RoomID != firstRoom.RoomID {
		t.Fatalf("codes differ: %q %q", secondRoom.RoomID, firstRoom.RoomID)
	}
	if secondRoom.ViewerGrant == firstRoom.ViewerGrant {
		t.Fatal("the new incarnation reused the old grant")
	}
	_, err := secondStore.ConnectParticipant(
		viewerInput(secondRoom.RoomID, "old-incarnation", firstRoom.ViewerGrant))
	expectCode(t, err, CodeInvalidToken)
}

func TestParticipantReplacementRules(t *testing.T) {
	store := newStore(t, Options{})
	room := createRoom(t, store, protocol.CodeEntryOpen, "", "")
	host := mustConnect(t, store, hostInput(room.RoomID, room.HostToken))

	resumed := mustConnect(t, store, hostInput(room.RoomID, room.HostToken, "host-session-2"))
	if resumed.PeerID != host.PeerID || resumed.ReplacedSessionID != "host-session" {
		t.Fatalf("resumed host = %+v", resumed)
	}
	_, err := store.ConnectParticipant(ConnectParticipantInput{
		RoomID:    room.RoomID,
		Role:      protocol.RoleHost,
		Token:     room.HostToken,
		ClientID:  "second-host-client",
		SessionID: "second-host-session",
	})
	expectCode(t, err, CodeHostAlreadyConnected)

	first := mustConnect(t, store, viewerInput(room.RoomID, "first", room.ViewerGrant))
	second := mustConnect(t, store, viewerInput(room.RoomID, "second", room.ViewerGrant))
	_, err = store.ConnectParticipant(viewerInput(room.RoomID, "third", room.ViewerGrant))
	expectCode(t, err, CodeRoomFull)
	if peerIDs := store.GetViewerPeerIDs(room.RoomID); len(peerIDs) != 2 ||
		peerIDs[0] != first.PeerID || peerIDs[1] != second.PeerID {
		t.Fatalf("viewer order = %v", peerIDs)
	}

	// A viewer returning under the same client ID keeps its peer ID and its
	// place in the insertion order, which viewer presence is ordered by.
	returning := mustConnect(t, store, ConnectParticipantInput{
		RoomID:      room.RoomID,
		Role:        protocol.RoleViewer,
		ViewerGrant: room.ViewerGrant,
		ClientID:    "viewer-first",
		SessionID:   "first-again",
	})
	if returning.PeerID != first.PeerID || returning.ReplacedSessionID != "first" {
		t.Fatalf("returning viewer = %+v", returning)
	}
	if peerIDs := store.GetViewerPeerIDs(room.RoomID); len(peerIDs) != 2 ||
		peerIDs[0] != first.PeerID || peerIDs[1] != second.PeerID {
		t.Fatalf("viewer order after the return = %v", peerIDs)
	}

	if _, err := store.DisconnectParticipant(room.RoomID, second.PeerID, "second"); err != nil {
		t.Fatalf("DisconnectParticipant: %v", err)
	}
	connected := store.GetConnectedViewers(room.RoomID)
	if len(connected) != 1 || connected[0].PeerID != first.PeerID ||
		connected[0].SessionID != "first-again" {
		t.Fatalf("connected viewers = %+v", connected)
	}
	if store.RemoveDisconnectedViewer(room.RoomID, first.PeerID) {
		t.Fatal("removed a connected viewer")
	}
	if !store.RemoveDisconnectedViewer(room.RoomID, second.PeerID) {
		t.Fatal("did not remove the disconnected viewer")
	}
	if peerIDs := store.GetViewerPeerIDs(room.RoomID); len(peerIDs) != 1 ||
		peerIDs[0] != first.PeerID {
		t.Fatalf("viewer order after the removal = %v", peerIDs)
	}

	for _, testCase := range []struct {
		roomID, grant string
		want          bool
	}{
		{room.RoomID, room.ViewerGrant, true},
		{room.RoomID, "", false},
		{room.RoomID, "AAAAAAAAAAAAAAAAAAAAAA", false},
		{"9999", room.ViewerGrant, false},
	} {
		mayEnter, err := store.ViewerGrantMayEnter(testCase.roomID, testCase.grant)
		if err != nil || mayEnter != testCase.want {
			t.Fatalf("ViewerGrantMayEnter(%q, %q) = %v, %v",
				testCase.roomID, testCase.grant, mayEnter, err)
		}
	}
}

// TestHostChangeChecksIdentityAfterTheDerivation pins the order of the checks
// the TypeScript ran after its KDF await: the second getHostManagedRoom first,
// then the room identity together with a cancelled derivation, then busy.
func TestHostChangeChecksIdentityAfterTheDerivation(t *testing.T) {
	// A constant random source gives a recreated room the same Host token, so
	// the identity comparison is reachable instead of being shadowed by the
	// token check.
	store := newStore(t, Options{
		MaxRooms: 3,
		Random:   constantRandom(func(int) byte { return 7 }),
	})
	room := createRoom(t, store, protocol.CodeEntryOpen, "", "4321")
	current, err := store.HostManagedRoom(room.RoomID, room.HostToken)
	if err != nil {
		t.Fatalf("HostManagedRoom: %v", err)
	}
	if !store.HostStillOwnsRoom(room.RoomID, room.HostToken, current) {
		t.Fatal("HostStillOwnsRoom rejected the unchanged room")
	}

	if _, err := store.AbandonRoom(room.RoomID); err != nil {
		t.Fatalf("AbandonRoom: %v", err)
	}
	if store.HostStillOwnsRoom(room.RoomID, room.HostToken, current) {
		t.Fatal("HostStillOwnsRoom accepted an abandoned room")
	}
	_, err = store.SetViewerPassword(room.RoomID, room.HostToken, nil, nil, current)
	expectCode(t, err, CodeInvalidToken)

	again := createRoom(t, store, protocol.CodeEntryOpen, "", "4321")
	if again.HostToken != room.HostToken {
		t.Fatal("the constant random source did not repeat the Host token")
	}
	_, err = store.SetViewerPassword(again.RoomID, again.HostToken, nil, nil, current)
	expectCode(t, err, CodeRoomAccessDenied)

	incarnation, err := store.HostManagedRoom(again.RoomID, again.HostToken)
	if err != nil {
		t.Fatalf("HostManagedRoom: %v", err)
	}
	_, err = store.SetViewerPassword(
		again.RoomID, again.HostToken, nil, errDerivationCancelled, incarnation)
	expectCode(t, err, CodeRoomAccessDenied)
	_, err = store.SetViewerPassword(
		again.RoomID, again.HostToken, nil, codeError(CodeRoomBusy), incarnation)
	expectCode(t, err, CodeRoomBusy)
	_, err = store.ReplaceRoom(again.RoomID, again.HostToken, protocol.CodeEntryOpen,
		nil, errDerivationCancelled, incarnation)
	expectCode(t, err, CodeRoomAccessDenied)
}

// TestPasswordLoginRechecksTheRoomAfterTheDerivation covers the guard chain the
// TypeScript ran after its scrypt await: a vanished room answers ROOM_NOT_FOUND,
// a replaced room and a refusing mayConnect answer INVALID_TOKEN, and so does a
// full room, whose ROOM_FULL must not leak to the client.
func TestPasswordLoginRechecksTheRoomAfterTheDerivation(t *testing.T) {
	// A constant random source repeats the salt, so a recreated room holds the
	// same material and only the room identity separates the two incarnations.
	store := newStore(t, Options{
		MaxRooms: 3,
		Random:   constantRandom(func(int) byte { return 7 }),
	})
	room := createRoom(t, store, protocol.CodeEntryPrivate, "room-password", "4321")
	input := ConnectViewerWithPasswordInput{
		RoomID:    room.RoomID,
		Password:  "room-password",
		ClientID:  "password-viewer",
		SessionID: "password-session",
	}
	alwaysConnect := func() bool { return true }

	salt, expectedMaterial, reference, err := store.ViewerPasswordChallenge(input.RoomID)
	if err != nil {
		t.Fatalf("ViewerPasswordChallenge: %v", err)
	}
	derived, err := store.DeriveViewerPassword(input.Password, salt, nil)
	if err != nil {
		t.Fatalf("DeriveViewerPassword: %v", err)
	}
	if _, err := store.AbandonRoom(room.RoomID); err != nil {
		t.Fatalf("AbandonRoom: %v", err)
	}
	_, err = store.ConnectViewerWithPassword(
		input, derived, expectedMaterial, reference, alwaysConnect)
	expectCode(t, err, CodeRoomNotFound)

	createRoom(t, store, protocol.CodeEntryPrivate, "room-password", "4321")
	_, err = store.ConnectViewerWithPassword(
		input, derived, expectedMaterial, reference, alwaysConnect)
	expectCode(t, err, CodeInvalidToken)

	salt, expectedMaterial, reference, err = store.ViewerPasswordChallenge(input.RoomID)
	if err != nil {
		t.Fatalf("ViewerPasswordChallenge: %v", err)
	}
	derived, err = store.DeriveViewerPassword(input.Password, salt, nil)
	if err != nil {
		t.Fatalf("DeriveViewerPassword: %v", err)
	}
	_, err = store.ConnectViewerWithPassword(
		input, derived, expectedMaterial, reference, func() bool { return false })
	expectCode(t, err, CodeInvalidToken)
}

// TestPasswordLoginRequiresAnInitializedStore pins the first check of
// connectViewerWithPassword: `ensureInitialized()` ran before the password was
// validated and before any derivation, so an uninitialized store answers the
// initialization error at the challenge, not INVALID_TOKEN after a KDF.
func TestPasswordLoginRequiresAnInitializedStore(t *testing.T) {
	database, err := NewDatabase(databasePath(t))
	if err != nil {
		t.Fatalf("NewDatabase: %v", err)
	}
	store, err := New(Options{MaxRooms: 2, MaxViewersPerRoom: 2, Database: database})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	_, _, _, err = store.ViewerPasswordChallenge("1234")
	if err == nil || err.Error() != "RoomStore stable authority is not initialized" {
		t.Fatalf("ViewerPasswordChallenge before Initialize = %v", err)
	}
}

// TestPasswordLoginHidesAFullRoom keeps ROOM_FULL from leaking to a Viewer that
// authenticated with the room password.
func TestPasswordLoginHidesAFullRoom(t *testing.T) {
	store := newStore(t, Options{MaxViewersPerRoom: 2})
	room := createRoom(t, store, protocol.CodeEntryPrivate, "room-password", "")
	mustConnect(t, store, viewerInput(room.RoomID, "first", room.ViewerGrant))
	mustConnect(t, store, viewerInput(room.RoomID, "second", room.ViewerGrant))

	_, err := tryConnectViewerWithPassword(store, ConnectViewerWithPasswordInput{
		RoomID:    room.RoomID,
		Password:  "room-password",
		ClientID:  "password-viewer",
		SessionID: "password-session",
	}, nil)
	expectCode(t, err, CodeInvalidToken)
}

func TestCreateRoomReportsACancelledDerivation(t *testing.T) {
	store := newStore(t, Options{})
	if err := store.BeginCreateRoom(); err != nil {
		t.Fatalf("BeginCreateRoom: %v", err)
	}
	material, derived := store.DeriveViewerPasswordMaterial(
		"room-password", func() bool { return false })
	if material != nil || !errors.Is(derived, errDerivationCancelled) {
		t.Fatalf("derive = %v, %v", material, derived)
	}
	_, err := store.CreateRoom(protocol.CodeEntryPrivate, material, derived, "")
	if err == nil || err.Error() != "Room creation password derivation was cancelled" {
		t.Fatalf("CreateRoom = %v", err)
	}
	if store.Size() != 0 {
		t.Fatalf("size = %d, want 0", store.Size())
	}
}

func TestRejectsAMalformedViewerPassword(t *testing.T) {
	store := newStore(t, Options{})
	for _, password := range []string{"", "with space", strings.Repeat("a", 65)} {
		material, derived := store.DeriveViewerPasswordMaterial(password, nil)
		if material != nil || !hasCode(derived, CodeInvalidToken) {
			t.Fatalf("derive(%q) = %v, %v", password, material, derived)
		}
		if _, err := store.DeriveViewerPassword(
			password, make([]byte, viewerPasswordSaltBytes), nil); !hasCode(err, CodeInvalidToken) {
			t.Fatalf("login derive(%q) = %v", password, err)
		}
	}
}

// TestUniformIndexRejectionLimit covers the D11 formula: (MaxUint64%n + 1) % n
// must not wrap where 2^64 % n is 0, which is every power-of-two free count.
func TestUniformIndexRejectionLimit(t *testing.T) {
	allOnes := bytes.Repeat([]byte{0xff}, 8)
	zeros := make([]byte, 8)
	for _, testCase := range []struct {
		name      string
		count     int
		wantIndex int
		wantDraws int
	}{
		{"power of two accepts the top value", 8_192, 8_191, 1},
		{"one free code accepts the top value", 1, 0, 1},
		{"three free codes reject the top value", 3, 0, 2},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			draws := 0
			random := func(size int) []byte {
				draws++
				if draws == 1 {
					return allOnes
				}
				return zeros
			}
			index, err := uniformIndex(testCase.count, random)
			if err != nil {
				t.Fatalf("uniformIndex: %v", err)
			}
			if index != testCase.wantIndex {
				t.Fatalf("index = %d, want %d", index, testCase.wantIndex)
			}
			if draws != testCase.wantDraws {
				t.Fatalf("draws = %d, want %d", draws, testCase.wantDraws)
			}
		})
	}
}

func TestUniformIndexRejectsAShortRandomSource(t *testing.T) {
	_, err := uniformIndex(9_000, func(int) []byte { return make([]byte, 7) })
	if err == nil || !strings.Contains(err.Error(), "must return 8 bytes") {
		t.Fatalf("uniformIndex: %v", err)
	}
}
