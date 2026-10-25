package room

import (
	"context"
	"testing"
	"time"

	"zviewer/backend/internal/store"
)

func TestKickViewerRequiresActiveViewerInSameRoom(t *testing.T) {
	for _, tc := range []struct {
		name, targetRoom, role string
		want                   bool
	}{
		{"other room viewer", "other", store.SessionRoleViewer, false},
		{"other room host", "other", store.SessionRoleSharer, false},
		{"same room host", "room", store.SessionRoleSharer, false},
		{"same room viewer", "room", store.SessionRoleViewer, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			env := newTestEnv(t)
			env.insertRoom(t, "room", int64p(1), 10, false)
			env.insertRoom(t, "other", int64p(2), 10, false)
			env.hub.online["target"] = true
			if err := env.svc.Sessions.Create(context.Background(), &store.Session{RoomID: tc.targetRoom, SocketID: "target", Role: tc.role, UserID: int64p(2)}); err != nil {
				t.Fatal(err)
			}
			got, err := env.svc.kickViewer(context.Background(), "room", "target")
			if err != nil || got != tc.want {
				t.Errorf("kick = %v, %v; want %v", got, err, tc.want)
			}
			if !tc.want {
				active, err := env.svc.Sessions.FindActiveBySocket(context.Background(), "target")
				if err != nil || active == nil || len(env.hub.kicked) != 0 || len(env.hub.direct) != 0 {
					t.Error("invalid kick affected target session or sent a kick notification")
				}
			}
		})
	}
}

func TestTransferHostRejectsUnrelatedOrEndedSession(t *testing.T) {
	for _, tc := range []struct {
		name, targetRoom string
		ended            bool
		requestedUID     int64
	}{
		{"different room", "other", false, 2},
		{"ended session", "room", true, 2},
		{"wrong user identity", "room", false, 3},
	} {
		t.Run(tc.name, func(t *testing.T) {
			env := newTestEnv(t)
			env.insertRoom(t, "room", int64p(1), 10, false)
			env.insertRoom(t, "other", int64p(2), 10, false)
			ctx := context.Background()
			for _, sess := range []*store.Session{
				{RoomID: "room", SocketID: "old", Role: store.SessionRoleSharer, UserID: int64p(1)},
				{RoomID: tc.targetRoom, SocketID: "new", Role: store.SessionRoleViewer, UserID: int64p(2)},
			} {
				if err := env.svc.Sessions.Create(ctx, sess); err != nil {
					t.Fatal(err)
				}
			}
			if tc.ended {
				if _, err := env.svc.Sessions.EndBySocket(ctx, "new"); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := env.svc.transferHost(ctx, "room", "new", "old", tc.requestedUID); err == nil {
				t.Error("invalid host transfer was accepted")
			}
			room, err := env.svc.Rooms.FindByRoomID(ctx, "room")
			if err != nil || room.OwnerUserID == nil || *room.OwnerUserID != 1 {
				t.Error("rejected transfer changed room ownership")
			}
			old, err := env.svc.Sessions.FindActiveByRoomSocket(ctx, "room", "old")
			if err != nil || old == nil || old.Role != store.SessionRoleSharer {
				t.Error("rejected transfer demoted the original host")
			}
		})
	}
}

func TestTransferHostPreservesEndedSessionHistory(t *testing.T) {
	env := newTestEnv(t)
	env.insertRoom(t, "room", int64p(1), 10, false)
	ctx := context.Background()
	for _, sess := range []*store.Session{
		{RoomID: "room", SocketID: "old", Role: store.SessionRoleSharer, UserID: int64p(1)},
		{RoomID: "room", SocketID: "new", Role: store.SessionRoleViewer, UserID: int64p(2)},
	} {
		if err := env.svc.Sessions.Create(ctx, sess); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := env.db.Exec(`INSERT INTO "session" ("roomId","socketId","role","userId","endedAt") VALUES ('room','new','viewer',2,datetime('now'))`); err != nil {
		t.Fatal(err)
	}
	if _, err := env.svc.transferHost(ctx, "room", "new", "old", 2); err != nil {
		t.Fatal(err)
	}
	var role string
	if err := env.db.QueryRow(`SELECT "role" FROM "session" WHERE "socketId"='new' AND "endedAt" IS NOT NULL`).Scan(&role); err != nil {
		t.Fatal(err)
	}
	if role != store.SessionRoleViewer {
		t.Error("host transfer rewrote an ended historical session")
	}
}

func TestCleanupSchedulerStopCancelsOwnContext(t *testing.T) {
	s := NewService(Deps{})
	stop := s.StartCleanupScheduler(context.Background())
	done := make(chan struct{})
	go func() { stop(); close(done) }()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("scheduler stop depends on its caller canceling the parent context")
	}
}
