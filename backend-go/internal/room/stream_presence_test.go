package room

import (
	"context"
	"testing"
	"time"

	"zviewer/backend/internal/store"
)

type fakeStreamPush struct {
	publishing map[string]bool
	external   bool
}

func (p *fakeStreamPush) Available() bool              { return true }
func (p *fakeStreamPush) TracksPublishing() bool       { return !p.external }
func (p *fakeStreamPush) IsPublishing(key string) bool { return p.publishing[key] }

func setupPushRoom(t *testing.T, env *testEnv, roomID string) *fakeStreamPush {
	t.Helper()
	env.insertRoom(t, roomID, int64p(1), 10, false)
	if _, err := env.db.Exec(`UPDATE "room" SET "mode"='screen-share',
		"shareMethod"='stream-push',"streamKey"='PUSHKEY8' WHERE "roomId"=?`, roomID); err != nil {
		t.Fatal(err)
	}
	push := &fakeStreamPush{publishing: map[string]bool{"PUSHKEY8": true}}
	env.svc.NMS = push
	t.Cleanup(func() { env.svc.CancelReconnectTimer(roomID) })
	return push
}

func TestOBSOutlivesBrowserWithoutKeepingHostPermissions(t *testing.T) {
	env := newTestEnv(t)
	ctx := context.Background()
	push := setupPushRoom(t, env, "OBSLIVE1")
	withCleanupSettings(t, env, true, 24)
	if _, err := env.svc.RegisterHost(ctx, "host", "OBSLIVE1", 1); err != nil {
		t.Fatal(err)
	}
	if host, err := env.svc.IsRoomHost(ctx, "host", "OBSLIVE1"); err != nil || !host {
		t.Fatalf("host registration = %v, %v", host, err)
	}

	env.svc.handleDisconnect("host", "ping timeout")
	if sharer, err := env.svc.Sharer(ctx, "OBSLIVE1"); err != nil || sharer != nil {
		t.Fatalf("disconnected browser retained a host session: %v, %v", sharer, err)
	}
	if host, err := env.svc.IsRoomHost(ctx, "host", "OBSLIVE1"); err != nil || host {
		t.Fatalf("OBS preserved browser host permissions: %v, %v", host, err)
	}
	if env.hub.hasRoomEvent("OBSLIVE1", "host-disconnected") {
		t.Fatal("active OBS source was announced as offline")
	}

	// Exercise four expired grace periods without waiting forty real minutes.
	for range 4 {
		env.svc.CancelReconnectTimer("OBSLIVE1")
		env.svc.CloseAfterHostGrace(ctx, env.svc.Settings, "OBSLIVE1", "host")
		room, err := env.svc.Rooms.FindByRoomID(ctx, "OBSLIVE1")
		if err != nil || room.Status != "active" || !env.svc.HasReconnectTimer("OBSLIVE1") {
			t.Fatalf("live publisher lost its room or next check: %v, %v", room, err)
		}
	}
	if env.hub.hasRoomEvent("OBSLIVE1", "room-closed") || env.hub.hasRoomEvent("OBSLIVE1", "host-disconnected") {
		t.Fatal("grace checks interrupted a live OBS room")
	}

	push.publishing["PUSHKEY8"] = false
	env.svc.CancelReconnectTimer("OBSLIVE1")
	env.svc.CloseAfterHostGrace(ctx, env.svc.Settings, "OBSLIVE1", "host")
	room, err := env.svc.Rooms.FindByRoomID(ctx, "OBSLIVE1")
	if err != nil || room.Status != "active" || !env.svc.HasReconnectTimer("OBSLIVE1") {
		t.Fatalf("old browser timer skipped the new media-offline grace: %v, %v", room, err)
	}
	env.svc.mu.Lock()
	env.svc.streamOfflineAt["OBSLIVE1"] = time.Now().Add(-HostReconnectGrace - time.Second)
	env.svc.mu.Unlock()
	env.svc.CancelReconnectTimer("OBSLIVE1")
	env.svc.CloseAfterHostGrace(ctx, env.svc.Settings, "OBSLIVE1", "host")
	room, err = env.svc.Rooms.FindByRoomID(ctx, "OBSLIVE1")
	if err != nil || room.Status != "closed" {
		t.Fatalf("stopped publisher escaped normal closure: %v, %v", room, err)
	}
	if !env.hub.hasRoomEvent("OBSLIVE1", "host-disconnected") || !env.hub.hasRoomEvent("OBSLIVE1", "room-closed") {
		t.Fatal("stopped publisher did not notify viewers")
	}
}

func TestOBSGraceRespectsReconnectAndAutoDeleteSetting(t *testing.T) {
	for _, reconnect := range []bool{false, true} {
		t.Run(map[bool]string{false: "auto delete disabled", true: "host reconnected"}[reconnect], func(t *testing.T) {
			env := newTestEnv(t)
			ctx := context.Background()
			push := setupPushRoom(t, env, "OBSGRACE")
			withCleanupSettings(t, env, false, 24)
			push.publishing["PUSHKEY8"] = false
			if reconnect {
				env.hub.online["new-host"] = true
				if _, err := env.svc.RegisterHost(ctx, "new-host", "OBSGRACE", 1); err != nil {
					t.Fatal(err)
				}
			}
			env.svc.CloseAfterHostGrace(ctx, env.svc.Settings, "OBSGRACE", "old-host")
			room, err := env.svc.Rooms.FindByRoomID(ctx, "OBSGRACE")
			if err != nil || room.Status != "active" {
				t.Fatalf("room was closed: %v, %v", room, err)
			}
			if reconnect && env.hub.hasRoomEvent("OBSGRACE", "host-disconnected") {
				t.Fatal("stale grace callback announced the reconnected host as offline")
			}
		})
	}
}

func TestCleanupSkipsLiveOBSButReclaimsStoppedStream(t *testing.T) {
	env := newTestEnv(t)
	push := setupPushRoom(t, env, "OBSSTALE")
	withCleanupSettings(t, env, true, 24)
	setLastAccessed(t, env, "OBSSTALE", -48)
	if n := env.svc.CleanupInactiveRooms(context.Background()); n != 0 {
		t.Fatalf("removed %d rooms while OBS was active", n)
	}
	push.publishing["PUSHKEY8"] = false
	if n := env.svc.CleanupInactiveRooms(context.Background()); n != 1 {
		t.Fatalf("removed %d rooms after OBS stopped, want 1", n)
	}
}

func TestStreamPresenceOnlyProtectsTheCurrentPushMode(t *testing.T) {
	env := newTestEnv(t)
	setupPushRoom(t, env, "OBSMODES")
	room, err := env.svc.Rooms.FindByRoomID(context.Background(), "OBSMODES")
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name   string
		change func(*store.Room)
		want   bool
	}{
		{"live OBS", func(*store.Room) {}, true},
		{"closed", func(r *store.Room) { r.Status = "closed" }, false},
		{"watch together", func(r *store.Room) { r.Mode = "watch-together" }, false},
		{"webrtc", func(r *store.Room) { r.ShareMethod = "webrtc" }, false},
		{"no key", func(r *store.Room) { r.StreamKey = nil }, false},
		{"another stream", func(r *store.Room) { key := "OTHERKEY"; r.StreamKey = &key }, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			copy := *room
			tc.change(&copy)
			if got := env.svc.IsStreamPublishing(&copy); got != tc.want {
				t.Errorf("publishing = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestExplicitCloseStillClosesLiveOBSRoom(t *testing.T) {
	env := newTestEnv(t)
	setupPushRoom(t, env, "OBSCLOSE")
	if err := env.svc.CloseAndNotify(context.Background(), "OBSCLOSE", "host"); err != nil {
		t.Fatal(err)
	}
	if !env.hub.hasRoomEvent("OBSCLOSE", "room-closed") {
		t.Fatal("explicit close was bypassed by active publishing")
	}
}

func TestOBSStatusUsesMediaPresenceWithoutPlaybackMemory(t *testing.T) {
	env := newTestEnv(t)
	push := setupPushRoom(t, env, "OBSSTATE")
	env.hub.members["OBSSTATE"] = []string{"viewer"}
	b := NewBroadcaster(env.svc, nil)
	b.broadcastAll()
	if !b.streams["OBSSTATE"] || !env.hub.hasRoomEvent("OBSSTATE", "stream-status") {
		t.Fatal("OBS source without playback memory did not report live")
	}
	if env.hub.hasRoomEvent("OBSSTATE", "host-disconnected") {
		t.Fatal("live source was announced offline")
	}

	push.publishing["PUSHKEY8"] = false
	b.broadcastAll()
	if b.streams["OBSSTATE"] || !env.hub.hasRoomEvent("OBSSTATE", "host-disconnected") {
		t.Fatal("expired source presence did not notify existing viewers")
	}
	if !env.svc.HasReconnectTimer("OBSSTATE") || env.hub.hasRoomEvent("OBSSTATE", "room-closed") {
		t.Fatal("media offline must leave the separate host reconnect grace")
	}
	events := len(env.hub.rooms)
	b.broadcastAll()
	for _, event := range env.hub.rooms[events:] {
		if event == "OBSSTATE|host-disconnected" {
			t.Fatal("unchanged offline state repeated the disconnect notification")
		}
	}

	push.publishing["PUSHKEY8"] = true
	b.broadcastAll()
	if !b.streams["OBSSTATE"] {
		t.Fatal("restarted OBS source did not become live")
	}
}

func TestOBSStatusDoesNotInventPresenceForExternalMedia(t *testing.T) {
	env := newTestEnv(t)
	push := setupPushRoom(t, env, "OBSEXTER")
	push.external = true
	env.hub.members["OBSEXTER"] = []string{"viewer"}
	b := NewBroadcaster(env.svc, nil)
	b.broadcastAll()
	if env.hub.hasRoomEvent("OBSEXTER", "stream-status") || env.hub.hasRoomEvent("OBSEXTER", "host-disconnected") {
		t.Fatal("external media was assigned an untrusted source state")
	}
}

func TestOBSStatusDoesNotAnnounceConnectedHostOffline(t *testing.T) {
	env := newTestEnv(t)
	ctx := context.Background()
	push := setupPushRoom(t, env, "OBSHOST1")
	env.hub.online["host"] = true
	env.hub.members["OBSHOST1"] = []string{"host", "viewer"}
	if _, err := env.svc.RegisterHost(ctx, "host", "OBSHOST1", 1); err != nil {
		t.Fatal(err)
	}
	b := NewBroadcaster(env.svc, nil)
	b.broadcastAll()
	push.publishing["PUSHKEY8"] = false
	b.broadcastAll()
	if env.hub.hasRoomEvent("OBSHOST1", "host-disconnected") || env.svc.HasReconnectTimer("OBSHOST1") {
		t.Fatal("media stop removed the connected browser host")
	}
	room, err := env.svc.Rooms.FindByRoomID(ctx, "OBSHOST1")
	if err != nil {
		t.Fatal(err)
	}
	env.svc.sendStreamStatus("viewer", room)
	if !env.hub.hasDirect("viewer", "stream-status") {
		t.Fatal("joining viewer did not receive the current source state")
	}
}

func TestOBSStateCleanupPreservesLiveSourceAndGrace(t *testing.T) {
	env := newTestEnv(t)
	push := setupPushRoom(t, env, "OBSCACHE")
	env.svc.SetMovies("OBSCACHE", []any{}, nil)
	env.svc.StartReconnectTimer("OBSCACHE", func() {})
	env.svc.CleanupStaleStates(func(string) bool { return false })
	if !env.svc.HasState("OBSCACHE") || !env.svc.HasReconnectTimer("OBSCACHE") {
		t.Fatal("background cache cleanup removed the live OBS room or its reconnect check")
	}
	push.publishing["PUSHKEY8"] = false
	env.svc.noteStreamOffline("OBSCACHE")
	env.svc.CleanupStaleStates(func(string) bool { return false })
	if !env.svc.HasState("OBSCACHE") || !env.svc.HasReconnectTimer("OBSCACHE") {
		t.Fatal("cache cleanup cancelled the offline source's reconnect grace")
	}
}
