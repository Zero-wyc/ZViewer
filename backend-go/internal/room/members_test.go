package room

import (
	"context"
	"encoding/json"
	"testing"

	"zviewer/backend/internal/sio"
)

func TestMemberSnapshotRepairsStaleSocketAndModeratorState(t *testing.T) {
	e := newTestEnv(t)
	ctx := context.Background()
	owner, viewer := int64(1), int64(2)
	e.insertRoom(t, "MEMBERS1", &owner, 10, false)
	if _, err := e.svc.RegisterHost(ctx, "host", "MEMBERS1", owner); err != nil {
		t.Fatal(err)
	}
	for _, socketID := range []string{"old-viewer", "new-viewer"} {
		e.hub.online[socketID] = true
		e.hub.socketData[socketID] = map[string]any{"userId": viewer, "username": "member-fixture", "role": RoleUser}
		if _, err := e.svc.AdmitViewer(ctx, socketID, "MEMBERS1", &viewer, nil); err != nil {
			t.Fatal(err)
		}
	}
	e.hub.online["old-viewer"] = false
	// A retained session row after a lost disconnect must not become a ghost.
	snapshot, err := e.svc.memberSnapshot(ctx, "MEMBERS1")
	if err != nil || len(snapshot.Viewers) != 1 || snapshot.Viewers[0].SocketID != "new-viewer" {
		t.Fatalf("snapshot kept a stale socket: %+v %v", snapshot, err)
	}
	if snapshot.Viewers[0].UserID == nil || *snapshot.Viewers[0].UserID != viewer {
		t.Fatal("snapshot lost the stable account ID")
	}
	raw, _ := json.Marshal(map[string]any{"roomId": "MEMBERS1", "userId": viewer})
	var response AckResponse
	e.svc.handleAppointModerator(&sio.Socket{ID: "host"}, []json.RawMessage{raw}, func(args ...any) {
		response = args[0].(AckResponse)
	})
	if !response.Success {
		t.Fatalf("appointment failed after viewer reconnect: %+v", response)
	}
	snapshot, err = e.svc.memberSnapshot(ctx, "MEMBERS1")
	if err != nil || len(snapshot.Moderators) != 1 || snapshot.Moderators[0] != viewer {
		t.Fatalf("snapshot lost the persistent moderator: %+v %v", snapshot, err)
	}
	for _, socketID := range []string{"host", "outsider"} {
		request, _ := json.Marshal(map[string]any{"roomId": "MEMBERS1"})
		e.svc.handleGetRoomMembers(&sio.Socket{ID: socketID}, []json.RawMessage{request}, func(args ...any) {
			response = args[0].(AckResponse)
		})
		if response.Success != (socketID == "host") {
			t.Fatalf("membership access check failed for %s: %+v", socketID, response)
		}
	}
}
