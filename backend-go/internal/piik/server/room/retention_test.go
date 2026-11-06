package room

import (
	"reflect"
	"testing"

	"zviewer/backend/internal/piik/server/protocol"
)

func TestEmptyRoomRetentionUsesAuthenticatedPresence(t *testing.T) {
	var now int64
	store := newStore(t, Options{Now: func() int64 { return now }})
	created := createRoom(t, store, protocol.CodeEntryOpen, "", "4321")
	if ids := store.EmptyRoomIDs(0); !reflect.DeepEqual(ids, []string{created.RoomID}) {
		t.Fatalf("never-joined room = %v", ids)
	}
	host := mustConnect(t, store, hostInput(created.RoomID, created.HostToken))
	viewer := mustConnect(t, store, viewerInput(created.RoomID, "viewer-session", created.ViewerGrant))
	now = 3_600_000
	if closed, err := store.ExpireEmptyRooms(now); err != nil || len(closed) != 0 {
		t.Fatalf("occupied room retired: %v %v", closed, err)
	}
	_, _ = store.DisconnectParticipant(created.RoomID, host.PeerID, "host-session")
	if len(store.EmptyRoomIDs(now)) != 0 {
		t.Fatal("a Viewer without a Host must protect the room")
	}
	_, _ = store.DisconnectParticipant(created.RoomID, viewer.PeerID, "viewer-session")
	if len(store.EmptyRoomIDs(now-1)) != 0 {
		t.Fatal("empty interval began before the last departure")
	}

	// Reconnect/replacement and a late old-session close must not retire the
	// current participant, or let failed admission renew an empty room.
	now += 10
	mustConnect(t, store, hostInput(created.RoomID, created.HostToken, "new-session"))
	_, _ = store.DisconnectParticipant(created.RoomID, host.PeerID, "host-session")
	if len(store.EmptyRoomIDs(now)) != 0 {
		t.Fatal("stale disconnect made the new session empty")
	}
	_, _ = store.DisconnectParticipant(created.RoomID, host.PeerID, "new-session")
	lastDeparture := now
	now += 100
	_, err := store.ConnectParticipant(hostInput(created.RoomID, "wrong-token"))
	expectCode(t, err, CodeInvalidToken)
	store.RemoveDisconnectedViewer(created.RoomID, viewer.PeerID)
	closed, err := store.ExpireEmptyRooms(lastDeparture)
	if err != nil || len(closed) != 1 || len(closed[0].SessionIDs) != 0 || store.Size() != 0 {
		t.Fatalf("empty retirement = %v %v, size=%d", closed, err, store.Size())
	}
	reused := createRoom(t, store, protocol.CodeEntryOpen, "", created.RoomID)
	_, err = store.ConnectParticipant(viewerInput(reused.RoomID, "old-invite", created.ViewerGrant))
	expectCode(t, err, CodeInvalidToken)
}

func TestRevokingLastConnectedViewerStartsEmptyInterval(t *testing.T) {
	var now int64
	store := newStore(t, Options{Now: func() int64 { return now }})
	created := createRoom(t, store, protocol.CodeEntryOpen, "", "4321")
	mustConnect(t, store, viewerInput(created.RoomID, "viewer-session", created.ViewerGrant))
	now = 100
	if _, err := store.SetViewerGrant(created.RoomID, "revoke", created.HostToken); err != nil {
		t.Fatal(err)
	}
	if len(store.EmptyRoomIDs(99)) != 0 || len(store.EmptyRoomIDs(100)) != 1 {
		t.Fatal("revocation did not start the empty interval")
	}
	now = 200
	if _, err := store.SetViewerGrant(created.RoomID, "rotate", created.HostToken); err != nil {
		t.Fatal(err)
	}
	if len(store.EmptyRoomIDs(100)) != 1 {
		t.Fatal("changing credentials on an already empty room renewed it")
	}
}

func TestRestorePreservesCreationOrderAndRestartsEmptyInterval(t *testing.T) {
	path := databasePath(t)
	var now int64
	options := Options{Now: func() int64 { return now }}
	first := stableStore(t, path, options)
	older := createRoom(t, first, protocol.CodeEntryOpen, "", "9000")
	now++
	createRoom(t, first, protocol.CodeEntryOpen, "", "1000")
	_, err := first.SetCodeEntryPolicy(older.RoomID, protocol.CodeEntryPrivate, older.HostToken)
	if err != nil {
		t.Fatal(err)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	now = 7_200_000
	restored := stableStore(t, path, options)
	if len(restored.EmptyRoomIDs(now-1)) != 0 {
		t.Fatal("restart must allow participants to reconnect")
	}
	if ids := restored.EmptyRoomIDs(now); !reflect.DeepEqual(ids, []string{"9000", "1000"}) {
		t.Fatalf("restored creation order = %v", ids)
	}
	closed, err := restored.ExpireEmptyRooms(now)
	if err != nil || len(closed) != 2 {
		t.Fatalf("expire = %v %v", closed, err)
	}
	if err := restored.Close(); err != nil {
		t.Fatal(err)
	}
	if next := stableStore(t, path, options); next.Size() != 0 {
		t.Fatal("expired authority survived restart")
	}
}

func TestExpiryStorageFailureDoesNotPartiallyRetireRooms(t *testing.T) {
	store := stableStore(t, databasePath(t), Options{Now: func() int64 { return 0 }})
	createRoom(t, store, protocol.CodeEntryOpen, "", "9000")
	createRoom(t, store, protocol.CodeEntryOpen, "", "1000")
	// Fail the second deletion, after the first executed inside the transaction.
	_, err := store.database.exec(`CREATE TEMP TRIGGER fail_retirement BEFORE DELETE ON rooms
		WHEN OLD.room_id = '1000' BEGIN SELECT RAISE(ABORT, 'injected write failure'); END`)
	if err != nil {
		t.Fatal(err)
	}
	free := len(store.freeRoomCodes)
	if closed, err := store.ExpireEmptyRooms(0); err == nil || len(closed) != 0 {
		t.Fatalf("expiry unexpectedly succeeded: %v %v", closed, err)
	}
	rows, err := store.database.readStoredRooms()
	if err != nil || len(rows) != 2 || store.Size() != 2 || len(store.freeRoomCodes) != free {
		t.Fatalf("failed batch changed authority: rows=%d, rooms=%d, free=%d, error=%v", len(rows), store.Size(), len(store.freeRoomCodes), err)
	}
}
