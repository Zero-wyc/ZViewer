package api_test

import (
	"context"
	"testing"

	"zviewer/backend/internal/share/piikbridge"
)

// TestPiikVoiceSessionHostOpensRoom 房主取语音凭证时应顺手把 Piik 房间建出来，
// 这样后面的观众才有地方可进。
func TestPiikVoiceSessionHostOpensRoom(t *testing.T) {
	bridge, err := piikbridge.New(piikbridge.Options{})
	if err != nil {
		t.Fatalf("构造桥接层失败: %v", err)
	}
	t.Cleanup(func() { _ = bridge.Close(context.Background()) })

	env := newTestEnvWith(t, bridge)
	defer env.teardown()

	const roomID = "ROOMVOICE1"
	env.insertPushRoom(t, roomID, "screen-share", nil)
	hostID := env.seedUser(t, "voicehost", "pass1234", "user", "active")
	env.seedRoomUser(t, roomID, "sock-host", "sharer", hostID)

	resp := env.do(t, "POST", "/api/voice/piik/session", env.token(t, hostID, "user", "voicehost"),
		map[string]any{"roomId": roomID})
	if resp.status != 200 {
		t.Fatalf("房主状态 = %d (%s)", resp.status, resp.raw)
	}
	if role, _ := resp.body["role"].(string); role != "host" {
		t.Fatalf("房主角色 = %v", resp.body["role"])
	}
	if token, _ := resp.body["token"].(string); token == "" {
		t.Fatalf("房主没有 token: %s", resp.raw)
	}
	if len(resp.cookies) != 1 || resp.cookies[0].Name != piikbridge.SiteCookie {
		t.Fatalf("站点通行证缺失: %+v", resp.cookies)
	}
}

// TestPiikVoiceSessionViewerBeforeHost 房主还没进语音时，观众拿到的是 409
// 而不是「房间不存在」——两者对用户是不同的事。
func TestPiikVoiceSessionViewerBeforeHost(t *testing.T) {
	bridge, err := piikbridge.New(piikbridge.Options{})
	if err != nil {
		t.Fatalf("构造桥接层失败: %v", err)
	}
	t.Cleanup(func() { _ = bridge.Close(context.Background()) })

	env := newTestEnvWith(t, bridge)
	defer env.teardown()

	const roomID = "ROOMVOICE2"
	env.insertPushRoom(t, roomID, "screen-share", nil)
	viewerID := env.seedUser(t, "voiceviewer", "pass1234", "user", "active")
	env.seedRoomUser(t, roomID, "sock-viewer", "viewer", viewerID)

	resp := env.do(t, "POST", "/api/voice/piik/session", env.token(t, viewerID, "user", "voiceviewer"),
		map[string]any{"roomId": roomID})
	if resp.status != 409 {
		t.Fatalf("状态 = %d (%s), 期望 409", resp.status, resp.raw)
	}
}

// TestPiikVoiceSessionSharesRoomWithShare 语音与共享用同一间 Piik 房间：
// 房主先取了共享凭证，语音拿到的房间码必须一致，否则两边会各自建树。
func TestPiikVoiceSessionSharesRoomWithShare(t *testing.T) {
	bridge, err := piikbridge.New(piikbridge.Options{})
	if err != nil {
		t.Fatalf("构造桥接层失败: %v", err)
	}
	t.Cleanup(func() { _ = bridge.Close(context.Background()) })

	env := newTestEnvWith(t, bridge)
	defer env.teardown()

	const roomID = "ROOMVOICE3"
	env.insertPushRoom(t, roomID, "screen-share", nil)
	hostID := env.seedUser(t, "sharedhost", "pass1234", "user", "active")
	env.seedRoomUser(t, roomID, "sock-host", "sharer", hostID)
	body := map[string]any{"roomId": roomID}
	token := env.token(t, hostID, "user", "sharedhost")

	share := env.do(t, "POST", "/api/share/piik/session", token, body)
	if share.status != 200 {
		t.Fatalf("共享凭证失败: %d (%s)", share.status, share.raw)
	}
	voice := env.do(t, "POST", "/api/voice/piik/session", token, body)
	if voice.status != 200 {
		t.Fatalf("语音凭证失败: %d (%s)", voice.status, voice.raw)
	}
	if shareRoom, _ := share.body["roomId"].(string); shareRoom != voice.body["roomId"] {
		t.Fatalf("共享房间 %v 与语音房间 %v 不一致", share.body["roomId"], voice.body["roomId"])
	}
}
