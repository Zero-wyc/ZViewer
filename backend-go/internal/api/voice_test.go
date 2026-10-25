package api_test

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
)

func (e *testEnv) insertVoiceRoom(t *testing.T, roomID, status string, ownerID int64) {
	t.Helper()
	if _, err := e.conn.Exec(
		`INSERT INTO "room" ("roomId","name","status","mode","shareMethod","ownerUserId")
		 VALUES (?,?,?,?,?,?)`,
		roomID, "语音房", status, "screen-share", "webrtc", ownerID,
	); err != nil {
		t.Fatalf("插入房间失败: %v", err)
	}
}

// ===========================================================================
// 假 LiveKit（只覆盖语音用到的 Twirp 方法）
// ===========================================================================

type livekitStub struct {
	mu    sync.Mutex
	calls []string
	// rooms 控制「目标是否在语音里」
	participants string
}

func newLiveKitStub(t *testing.T) (*httptest.Server, *livekitStub) {
	t.Helper()
	stub := &livekitStub{
		participants: `[{"identity":"user:1","tracks":[{"sid":"TR_AUDIO_1","type":"AUDIO"},{"sid":"TR_VIDEO_1","type":"VIDEO"}]}]`,
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		method := strings.TrimPrefix(r.URL.Path, "/twirp/livekit.RoomService/")
		stub.mu.Lock()
		stub.calls = append(stub.calls, method)
		stub.mu.Unlock()

		w.Header().Set("Content-Type", "application/json")
		switch method {
		case "ListParticipants":
			_, _ = w.Write([]byte(`{"participants":` + stub.participants + `}`))
		case "UpdateParticipant":
			_, _ = w.Write([]byte(`{"participant":{"identity":"user:1"}}`))
		default:
			_, _ = w.Write([]byte(`{}`))
		}
	}))
	t.Cleanup(srv.Close)
	return srv, stub
}

func (s *livekitStub) takeCalls() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := s.calls
	s.calls = nil
	return out
}

func decodeJWTPayload(t *testing.T, token string) map[string]any {
	t.Helper()
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		t.Fatalf("JWT 段数 = %d", len(parts))
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		t.Fatalf("payload 解码失败: %v", err)
	}
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatalf("payload 不是 JSON: %v", err)
	}
	return payload
}

// ===========================================================================
// /api/voice/token
// ===========================================================================

func TestVoiceTokenRequiresAuth(t *testing.T) {
	env := newTestEnv(t)
	defer env.teardown()

	resp := env.do(t, http.MethodPost, "/api/voice/token", "", map[string]any{"roomId": "X"})
	if resp.status != http.StatusUnauthorized {
		t.Fatalf("未登录应 401，得到 %d", resp.status)
	}
}

func TestVoiceTokenUnconfiguredIs503(t *testing.T) {
	t.Setenv("LIVEKIT_API_KEY", "")
	t.Setenv("LIVEKIT_API_SECRET", "")
	env := newTestEnv(t)
	defer env.teardown()

	rootID := env.seedUser(t, "root1", "pass1234", "root", "active")
	token := env.token(t, rootID, "root", "root1")
	env.insertVoiceRoom(t, "VOICE503", "active", rootID)

	resp := env.do(t, http.MethodPost, "/api/voice/token", token, map[string]any{"roomId": "VOICE503"})
	if resp.status != http.StatusServiceUnavailable {
		t.Fatalf("未配置 LiveKit 应 503，得到 %d（%s）", resp.status, resp.raw)
	}
	if resp.message() != "语音服务未配置（需要 LIVEKIT_API_KEY/API_SECRET）" {
		t.Fatalf("503 文案不对: %q", resp.message())
	}
}

func TestVoiceTokenValidation(t *testing.T) {
	t.Setenv("LIVEKIT_API_KEY", "k")
	t.Setenv("LIVEKIT_API_SECRET", "s")
	env := newTestEnv(t)
	defer env.teardown()

	userID := env.seedUser(t, "alice", "pass1234", "user", "active")
	token := env.token(t, userID, "user", "alice")
	env.insertVoiceRoom(t, "VOICE404", "closed", userID)

	// 缺 roomId（0 / 空串 / null 都算缺失）
	for _, body := range []map[string]any{{}, {"roomId": ""}, {"roomId": nil}, {"roomId": 0}} {
		resp := env.do(t, http.MethodPost, "/api/voice/token", token, body)
		if resp.status != http.StatusBadRequest {
			t.Fatalf("body=%v 应 400，得到 %d（%s）", body, resp.status, resp.raw)
		}
		if resp.message() != "roomId 为必填项" {
			t.Fatalf("400 文案不对: %q", resp.message())
		}
	}

	// 房间不存在 / 已关闭 → 同一句 404
	for _, roomID := range []string{"NOSUCHRM", "VOICE404"} {
		resp := env.do(t, http.MethodPost, "/api/voice/token", token, map[string]any{"roomId": roomID})
		if resp.status != http.StatusNotFound {
			t.Fatalf("room=%s 应 404，得到 %d（%s）", roomID, resp.status, resp.raw)
		}
		if resp.message() != "房间不存在或已关闭" {
			t.Fatalf("404 文案不对: %q", resp.message())
		}
	}
}

func TestVoiceTokenForbiddenWhenNotAdmitted(t *testing.T) {
	t.Setenv("LIVEKIT_API_KEY", "k")
	t.Setenv("LIVEKIT_API_SECRET", "s")
	env := newTestEnv(t)
	defer env.teardown()

	ownerID := env.seedUser(t, "owner1", "pass1234", "user", "active")
	otherID := env.seedUser(t, "bob", "pass1234", "user", "active")
	env.insertVoiceRoom(t, "VOICE403", "active", ownerID)
	otherToken := env.token(t, otherID, "user", "bob")

	resp := env.do(t, http.MethodPost, "/api/voice/token", otherToken, map[string]any{"roomId": "VOICE403"})
	if resp.status != http.StatusForbidden {
		t.Fatalf("无会话用户应 403，得到 %d（%s）", resp.status, resp.raw)
	}
	if resp.message() != "尚未获准进入房间" {
		t.Fatalf("403 文案不对: %q", resp.message())
	}
}

func TestVoiceTokenOk(t *testing.T) {
	t.Setenv("LIVEKIT_API_KEY", "parity-key")
	t.Setenv("LIVEKIT_API_SECRET", "parity-secret")
	t.Setenv("LIVEKIT_URL", "wss://livekit.example.com")
	env := newTestEnv(t)
	defer env.teardown()

	rootID := env.seedUser(t, "root1", "pass1234", "root", "active")
	token := env.token(t, rootID, "root", "root1")
	env.insertVoiceRoom(t, "VOICEOK", "active", rootID)

	resp := env.do(t, http.MethodPost, "/api/voice/token", token,
		map[string]any{"roomId": "VOICEOK", "username": "张三"})
	if resp.status != http.StatusOK {
		t.Fatalf("应 200，得到 %d（%s）", resp.status, resp.raw)
	}
	if resp.body["success"] != true {
		t.Fatalf("success 应为 true: %v", resp.body)
	}
	if resp.body["url"] != "wss://livekit.example.com" {
		t.Errorf("url = %v", resp.body["url"])
	}
	rawToken, _ := resp.body["token"].(string)
	if rawToken == "" {
		t.Fatal("缺少 token")
	}
	payload := decodeJWTPayload(t, rawToken)
	if payload["sub"] != "user:1" {
		t.Errorf("sub = %v（登录用户应为 user:<id>）", payload["sub"])
	}
	if payload["name"] != "张三" {
		t.Errorf("name = %v", payload["name"])
	}
	video, _ := payload["video"].(map[string]any)
	if video["room"] != "voice:VOICEOK" || video["roomJoin"] != true {
		t.Errorf("video 授权块不对: %v", video)
	}
}

// ===========================================================================
// /api/voice/mute、/api/voice/kick
// ===========================================================================

func TestVoiceMuteFlow(t *testing.T) {
	t.Setenv("LIVEKIT_API_KEY", "parity-key")
	t.Setenv("LIVEKIT_API_SECRET", "parity-secret")
	lk, stub := newLiveKitStub(t)
	t.Setenv("LIVEKIT_API_HOST", lk.URL)

	env := newTestEnv(t)
	defer env.teardown()

	ownerID := env.seedUser(t, "owner1", "pass1234", "user", "active")
	viewerID := env.seedUser(t, "viewer1", "pass1234", "user", "active")
	env.insertVoiceRoom(t, "VOICEMUTE", "active", ownerID)
	ownerToken := env.token(t, ownerID, "user", "owner1")
	viewerToken := env.token(t, viewerID, "user", "viewer1")

	// 缺参数
	resp := env.do(t, http.MethodPost, "/api/voice/mute", ownerToken, map[string]any{"roomId": "VOICEMUTE"})
	if resp.status != http.StatusBadRequest || resp.message() != "roomId/identity/muted 为必填项" {
		t.Fatalf("缺参数应 400，得到 %d %q", resp.status, resp.message())
	}

	// 非房主/房管
	resp = env.do(t, http.MethodPost, "/api/voice/mute", viewerToken,
		map[string]any{"roomId": "VOICEMUTE", "identity": "user:1", "muted": true})
	if resp.status != http.StatusForbidden || resp.message() != "无权限：仅房主或房管可操作" {
		t.Fatalf("无权限应 403，得到 %d %q", resp.status, resp.message())
	}

	// 目标不在语音
	resp = env.do(t, http.MethodPost, "/api/voice/mute", ownerToken,
		map[string]any{"roomId": "VOICEMUTE", "identity": "user:99", "muted": true})
	if resp.status != http.StatusNotFound || resp.message() != "目标不在语音中" {
		t.Fatalf("目标不存在应 404，得到 %d %q", resp.status, resp.message())
	}

	// 禁言成功：只静音 AUDIO 轨，然后写 metadata
	stub.takeCalls()
	resp = env.do(t, http.MethodPost, "/api/voice/mute", ownerToken,
		map[string]any{"roomId": "VOICEMUTE", "identity": "user:1", "muted": true})
	if resp.status != http.StatusOK || resp.body["success"] != true {
		t.Fatalf("禁言应 200，得到 %d（%s）", resp.status, resp.raw)
	}
	calls := stub.takeCalls()
	want := []string{"ListParticipants", "MutePublishedTrack", "UpdateParticipant"}
	if strings.Join(calls, ",") != strings.Join(want, ",") {
		t.Fatalf("Twirp 调用序列 = %v, want %v", calls, want)
	}

	// 解禁：不再 mute 轨道，但仍要更新 metadata（客户端据此恢复麦克风）
	stub.takeCalls()
	resp = env.do(t, http.MethodPost, "/api/voice/mute", ownerToken,
		map[string]any{"roomId": "VOICEMUTE", "identity": "user:1", "muted": false})
	if resp.status != http.StatusOK {
		t.Fatalf("解禁应 200，得到 %d（%s）", resp.status, resp.raw)
	}
	calls = stub.takeCalls()
	want = []string{"ListParticipants", "UpdateParticipant"}
	if strings.Join(calls, ",") != strings.Join(want, ",") {
		t.Fatalf("解禁的 Twirp 调用序列 = %v, want %v", calls, want)
	}
}

func TestVoiceKickFlow(t *testing.T) {
	t.Setenv("LIVEKIT_API_KEY", "parity-key")
	t.Setenv("LIVEKIT_API_SECRET", "parity-secret")
	lk, stub := newLiveKitStub(t)
	t.Setenv("LIVEKIT_API_HOST", lk.URL)

	env := newTestEnv(t)
	defer env.teardown()

	ownerID := env.seedUser(t, "owner1", "pass1234", "user", "active")
	viewerID := env.seedUser(t, "viewer1", "pass1234", "user", "active")
	env.insertVoiceRoom(t, "VOICEKICK", "active", ownerID)
	ownerToken := env.token(t, ownerID, "user", "owner1")
	viewerToken := env.token(t, viewerID, "user", "viewer1")

	resp := env.do(t, http.MethodPost, "/api/voice/kick", ownerToken, map[string]any{"roomId": "VOICEKICK"})
	if resp.status != http.StatusBadRequest || resp.message() != "roomId/identity 为必填项" {
		t.Fatalf("缺参数应 400，得到 %d %q", resp.status, resp.message())
	}

	resp = env.do(t, http.MethodPost, "/api/voice/kick", viewerToken,
		map[string]any{"roomId": "VOICEKICK", "identity": "user:1"})
	if resp.status != http.StatusForbidden {
		t.Fatalf("无权限应 403，得到 %d", resp.status)
	}

	stub.takeCalls()
	resp = env.do(t, http.MethodPost, "/api/voice/kick", ownerToken,
		map[string]any{"roomId": "VOICEKICK", "identity": "user:1"})
	if resp.status != http.StatusOK || resp.body["success"] != true {
		t.Fatalf("踢人应 200，得到 %d（%s）", resp.status, resp.raw)
	}
	if calls := stub.takeCalls(); len(calls) != 1 || calls[0] != "RemoveParticipant" {
		t.Fatalf("Twirp 调用 = %v, want [RemoveParticipant]", calls)
	}
}

// TestVoiceAdminIncludesRoomModerator 房管也能禁言（不只房主）。
func TestVoiceAdminIncludesRoomModerator(t *testing.T) {
	t.Setenv("LIVEKIT_API_KEY", "parity-key")
	t.Setenv("LIVEKIT_API_SECRET", "parity-secret")
	lk, _ := newLiveKitStub(t)
	t.Setenv("LIVEKIT_API_HOST", lk.URL)

	env := newTestEnv(t)
	defer env.teardown()

	ownerID := env.seedUser(t, "owner1", "pass1234", "user", "active")
	modID := env.seedUser(t, "mod1", "pass1234", "user", "active")
	env.insertVoiceRoom(t, "VOICEMOD", "active", ownerID)
	if _, err := env.conn.Exec(
		`UPDATE "room" SET "moderators" = ? WHERE "roomId" = ?`,
		"["+strconv.FormatInt(modID, 10)+"]", "VOICEMOD",
	); err != nil {
		t.Fatalf("设置房管失败: %v", err)
	}
	modToken := env.token(t, modID, "user", "mod1")

	resp := env.do(t, http.MethodPost, "/api/voice/mute", modToken,
		map[string]any{"roomId": "VOICEMOD", "identity": "user:1", "muted": true})
	if resp.status != http.StatusOK {
		t.Fatalf("房管应能禁言，得到 %d（%s）", resp.status, resp.raw)
	}
}
