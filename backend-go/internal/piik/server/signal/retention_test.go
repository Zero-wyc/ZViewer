package signal

import (
	"errors"
	"testing"

	"zviewer/backend/internal/piik/server/protocol"
	"zviewer/backend/internal/piik/server/room"
)

func TestRoomCapacityReclaimsOldestEmptyRoomOnlyWhenEnabled(t *testing.T) {
	for _, enabled := range []bool{false, true} {
		t.Run(map[bool]string{false: "default-retention", true: "empty-reclamation"}[enabled], func(t *testing.T) {
			store, err := room.New(room.Options{MaxRooms: 2, MaxViewersPerRoom: 2, Now: func() int64 { return 0 }})
			if err != nil {
				t.Fatal(err)
			}
			timeout := int64(0)
			if enabled {
				timeout = 3_600_000
			}
			h := startHarness(t, harnessOptions{store: store, now: func() int64 { return 51 }, roomEmptyTimeoutMs: timeout})
			second, err := h.server.CreateRoom(protocol.CodeEntryOpen, nil, "")
			if err != nil {
				t.Fatal(err)
			}
			created, err := h.server.CreateRoom(protocol.CodeEntryOpen, nil, h.room.RoomID)
			if !enabled {
				var limit *room.Error
				if !errors.As(err, &limit) || limit.Code != room.CodeRoomLimit {
					t.Fatalf("default capacity result = %v", err)
				}
				return
			}
			if err != nil || created.RoomID != h.room.RoomID || created.HostToken == h.room.HostToken {
				t.Fatalf("reclaim oldest empty = %v %v", created.RoomID, err)
			}
			h.locked(func() {
				if _, err := store.HostManagedRoom(second.RoomID, second.HostToken); err != nil {
					t.Fatal("newer empty room was retired")
				}
			})
			host := openClient(t, h)
			authenticate(t, host, created, protocol.RoleHost, "idle-host", 1, "", presenceOptions{roomSession: true, roomOnly: true})
			viewer := openClient(t, h)
			authenticate(t, viewer, second, protocol.RoleViewer, "waiting-viewer", 1, "", presenceOptions{})
			_, err = h.server.CreateRoom(protocol.CodeEntryOpen, nil, "")
			var limit *room.Error
			if !errors.As(err, &limit) || limit.Code != room.CodeRoomLimit {
				t.Fatalf("occupied rooms must not be evicted: %v", err)
			}
		})
	}
}

func TestEmptyExpiryCleansShareAndReconnectState(t *testing.T) {
	clock := &clock{}
	store, err := room.New(room.Options{MaxRooms: 2, MaxViewersPerRoom: 2, Now: clock.now})
	if err != nil {
		t.Fatal(err)
	}
	h := startHarness(t, harnessOptions{store: store, now: clock.now, roomEmptyTimeoutMs: 3_600_000, viewerDisconnectGraceMs: 20_000})
	host := openClient(t, h)
	authenticate(t, host, h.room, protocol.RoleHost, "retention-host", 1, "", presenceOptions{roomSession: true})
	host.ignore("route-update")
	viewer := openClient(t, h)
	authenticate(t, viewer, h.room, protocol.RoleViewer, "retention-viewer", 1, "", presenceOptions{})
	viewer.ignore("route-update")
	clock.advance(7_200_000)
	h.locked(func() {
		h.server.expireEmptyRooms()
		if store.Size() != 1 {
			t.Fatal("connected room expired")
		}
	})
	h.closeClient(viewer)
	h.closeClient(host)
	h.locked(func() {
		if len(h.server.viewerGraceTimers) != 1 || len(h.server.shares) != 1 {
			t.Fatal("test did not retain reconnect/share state")
		}
	})
	clock.advance(3_599_999)
	h.locked(func() {
		h.server.expireEmptyRooms()
		if store.Size() != 1 {
			t.Fatal("room expired before an hour empty")
		}
	})
	clock.advance(1)
	h.locked(func() {
		h.server.expireEmptyRooms()
		if store.Size() != 0 || len(h.server.shares) != 0 || len(h.server.viewerGraceTimers) != 0 {
			t.Fatal("expired room left authority or effects behind")
		}
	})
	created, err := h.server.CreateRoom(protocol.CodeEntryOpen, nil, h.room.RoomID)
	if err != nil {
		t.Fatal(err)
	}
	newHost := openClient(t, h)
	authenticate(t, newHost, created, protocol.RoleHost, "new-host", 1, "", presenceOptions{roomSession: true, roomOnly: true})
}

func TestRoomCapacityPrefersExpiredRoomOverRecentlyVacatedOlderRoom(t *testing.T) {
	clock := &clock{}
	store, err := room.New(room.Options{MaxRooms: 2, MaxViewersPerRoom: 2, Now: clock.now})
	if err != nil {
		t.Fatal(err)
	}
	h := startHarness(t, harnessOptions{store: store, now: clock.now, roomEmptyTimeoutMs: 3_600_000})
	host := openClient(t, h)
	authenticate(t, host, h.room, protocol.RoleHost, "retention-host", 1, "", presenceOptions{roomSession: true, roomOnly: true})
	clock.advance(10)
	newer := h.createRoom(protocol.CodeEntryOpen, "")
	clock.advance(3_600_000)
	h.closeClient(host)
	clock.advance(100)
	created, err := h.server.CreateRoom(protocol.CodeEntryOpen, nil, newer.RoomID)
	if err != nil || created.RoomID != newer.RoomID {
		t.Fatalf("expired room not reclaimed first: %s %v", created.RoomID, err)
	}
	h.locked(func() {
		if _, err := store.HostManagedRoom(h.room.RoomID, h.room.HostToken); err != nil {
			t.Fatal("recent departure lost its room before an already-expired room")
		}
	})
}

func TestRoomReplacementAtAll9000CodesReclaimsAnotherEmptyRoom(t *testing.T) {
	store, err := room.New(room.Options{MaxRooms: room.Capacity, MaxViewersPerRoom: 2, Now: func() int64 { return 0 }})
	if err != nil {
		t.Fatal(err)
	}
	oldest := createStoreRoom(t, store, protocol.CodeEntryOpen, "")
	second := createStoreRoom(t, store, protocol.CodeEntryOpen, "")
	for store.Size() < room.Capacity {
		createStoreRoom(t, store, protocol.CodeEntryOpen, "")
	}
	h := startHarness(t, harnessOptions{store: store, room: &oldest, now: func() int64 { return 51 }, roomEmptyTimeoutMs: 3_600_000})
	if _, err := h.server.ReplaceRoom(oldest.RoomID, "wrong-token", protocol.CodeEntryOpen, nil); err == nil {
		t.Fatal("invalid ownership replaced a room")
	}
	if h.storeSize() != room.Capacity {
		t.Fatal("rejected replacement evicted another room")
	}
	replacement, err := h.server.ReplaceRoom(oldest.RoomID, oldest.HostToken, protocol.CodeEntryOpen, nil)
	if err != nil || replacement.RoomID != second.RoomID || replacement.HostToken == second.HostToken {
		t.Fatalf("replacement did not reclaim the next oldest empty room: %s %v", replacement.RoomID, err)
	}
	if h.storeSize() != room.Capacity-1 {
		t.Fatal("replacement left incorrect room capacity")
	}
	h.locked(func() {
		if _, err := store.HostManagedRoom(oldest.RoomID, oldest.HostToken); err == nil {
			t.Fatal("old replacement authority survived")
		}
	})
}

func TestCapacityReclamationProtectsCreationAndReconnectWindow(t *testing.T) {
	clock := &clock{}
	store, err := room.New(room.Options{MaxRooms: 1, MaxViewersPerRoom: 1, Now: clock.now})
	if err != nil {
		t.Fatal(err)
	}
	h := startHarness(t, harnessOptions{store: store, now: clock.now, roomEmptyTimeoutMs: 3_600_000, viewerDisconnectGraceMs: 20_000})
	assertProtected := func() {
		t.Helper()
		_, err := h.server.CreateRoom(protocol.CodeEntryOpen, nil, "")
		var limit *room.Error
		if !errors.As(err, &limit) || limit.Code != room.CodeRoomLimit {
			t.Fatalf("creation/reconnect window lost its room: %v", err)
		}
	}
	clock.advance(19_999)
	assertProtected()
	host := openClient(t, h)
	authenticate(t, host, h.room, protocol.RoleHost, "retention-host", 1, "", presenceOptions{roomSession: true, roomOnly: true})
	h.closeClient(host)
	clock.advance(19_999)
	assertProtected()
	clock.advance(1)
	if _, err := h.server.CreateRoom(protocol.CodeEntryOpen, nil, ""); err != nil {
		t.Fatalf("reclamation after reconnect window: %v", err)
	}
	assertProtected()
}
