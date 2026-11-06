package api_test

import (
	"context"
	"testing"

	"zviewer/backend/internal/share/piikbridge"
)

// seedRoomUser 直接插一条 session：观众身份按 userId 区分，
// 复用 seedSession 会把两条都写成 user 1。
func (e *testEnv) seedRoomUser(t *testing.T, roomID, socketID, role string, userID int64) {
	t.Helper()
	if _, err := e.conn.Exec(
		`INSERT INTO "session" ("roomId","socketId","role","userId") VALUES (?,?,?,?)`,
		roomID, socketID, role, userID,
	); err != nil {
		t.Fatalf("插入会话失败: %v", err)
	}
}

// TestPiikSessionIssuesRoomCredentials 覆盖「身份 → 凭证」这条适配：
// 房主拿 token，观众拿 grant，没进房的人什么都拿不到。
func TestPiikSessionIssuesRoomCredentials(t *testing.T) {
	bridge, err := piikbridge.New(piikbridge.Options{})
	if err != nil {
		t.Fatalf("构造桥接层失败: %v", err)
	}
	t.Cleanup(func() { _ = bridge.Close(context.Background()) })

	env := newTestEnvWith(t, bridge)
	defer env.teardown()

	const roomID = "ROOMAPI1"
	env.insertPushRoom(t, roomID, "screen-share", nil)

	hostID := env.seedUser(t, "hosty", "pass1234", "user", "active")
	viewerID := env.seedUser(t, "watcher", "pass1234", "user", "active")
	outsiderID := env.seedUser(t, "lurker", "pass1234", "user", "active")
	env.seedRoomUser(t, roomID, "sock-host", "sharer", hostID)
	env.seedRoomUser(t, roomID, "sock-viewer", "viewer", viewerID)

	body := map[string]any{"roomId": roomID}

	host := env.do(t, "POST", "/api/share/piik/session", env.token(t, hostID, "user", "hosty"), body)
	if host.status != 200 {
		t.Fatalf("房主状态 = %d (%s)", host.status, host.raw)
	}
	if role, _ := host.body["role"].(string); role != "host" {
		t.Fatalf("房主角色 = %v", host.body["role"])
	}
	hostToken, _ := host.body["token"].(string)
	piikRoomID, _ := host.body["roomId"].(string)
	if hostToken == "" || piikRoomID == "" {
		t.Fatalf("房主凭证不完整: %s", host.raw)
	}
	if len(host.cookies) != 1 || host.cookies[0].Name != piikbridge.SiteCookie || host.cookies[0].Path != "/signal" {
		t.Fatalf("站点通行证缺失: %+v", host.cookies)
	}

	viewer := env.do(t, "POST", "/api/share/piik/session", env.token(t, viewerID, "user", "watcher"), body)
	if viewer.status != 200 {
		t.Fatalf("观众状态 = %d (%s)", viewer.status, viewer.raw)
	}
	if role, _ := viewer.body["role"].(string); role != "viewer" {
		t.Fatalf("观众角色 = %v", viewer.body["role"])
	}
	if grant, _ := viewer.body["viewerGrant"].(string); grant == "" {
		t.Fatalf("观众没有 grant: %s", viewer.raw)
	}
	if roomID2, _ := viewer.body["roomId"].(string); roomID2 != piikRoomID {
		t.Fatalf("观众房间码 %q 与房主 %q 不一致", roomID2, piikRoomID)
	}

	outsider := env.do(t, "POST", "/api/share/piik/session", env.token(t, outsiderID, "user", "lurker"), body)
	if outsider.status != 403 {
		t.Fatalf("未进房用户状态 = %d (%s)", outsider.status, outsider.raw)
	}
}

// TestPiikSessionRequiresOpenRoom 房主没开播时观众拿不到凭证。
func TestPiikSessionRequiresOpenRoom(t *testing.T) {
	bridge, err := piikbridge.New(piikbridge.Options{})
	if err != nil {
		t.Fatalf("构造桥接层失败: %v", err)
	}
	t.Cleanup(func() { _ = bridge.Close(context.Background()) })

	env := newTestEnvWith(t, bridge)
	defer env.teardown()

	const roomID = "ROOMAPI2"
	env.insertPushRoom(t, roomID, "screen-share", nil)
	viewerID := env.seedUser(t, "watcher2", "pass1234", "user", "active")
	env.seedRoomUser(t, roomID, "sock-viewer", "viewer", viewerID)

	resp := env.do(t, "POST", "/api/share/piik/session", env.token(t, viewerID, "user", "watcher2"),
		map[string]any{"roomId": roomID})
	if resp.status != 409 {
		t.Fatalf("状态 = %d (%s), 期望 409", resp.status, resp.raw)
	}
}

// TestPiikReleaseOnlyBySharer 观众不能替房主关共享。
func TestPiikReleaseOnlyBySharer(t *testing.T) {
	bridge, err := piikbridge.New(piikbridge.Options{})
	if err != nil {
		t.Fatalf("构造桥接层失败: %v", err)
	}
	t.Cleanup(func() { _ = bridge.Close(context.Background()) })

	env := newTestEnvWith(t, bridge)
	defer env.teardown()

	const roomID = "ROOMAPI3"
	env.insertPushRoom(t, roomID, "screen-share", nil)
	hostID := env.seedUser(t, "hostz", "pass1234", "user", "active")
	viewerID := env.seedUser(t, "watcherz", "pass1234", "user", "active")
	env.seedRoomUser(t, roomID, "sock-host", "sharer", hostID)
	env.seedRoomUser(t, roomID, "sock-viewer", "viewer", viewerID)
	body := map[string]any{"roomId": roomID}

	if resp := env.do(t, "POST", "/api/share/piik/session", env.token(t, hostID, "user", "hostz"), body); resp.status != 200 {
		t.Fatalf("房主取凭证失败: %d (%s)", resp.status, resp.raw)
	}

	if resp := env.do(t, "DELETE", "/api/share/piik/session", env.token(t, viewerID, "user", "watcherz"), body); resp.status != 403 {
		t.Fatalf("观众关共享 = %d (%s), 期望 403", resp.status, resp.raw)
	}
	if resp := env.do(t, "DELETE", "/api/share/piik/session", env.token(t, hostID, "user", "hostz"), body); resp.status != 200 {
		t.Fatalf("房主关共享 = %d (%s)", resp.status, resp.raw)
	}
	if resp := env.do(t, "DELETE", "/api/share/piik/session", env.token(t, hostID, "user", "hostz"), body); resp.status != 200 {
		t.Fatalf("重复关闭应幂等: %d (%s)", resp.status, resp.raw)
	}
}
