package voice

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"

	"github.com/golang-jwt/jwt/v5"
)

// decodeSegments 取 JWT 的 payload（不验签，只断言声明内容）。
func decodePayload(t *testing.T, token string) map[string]any {
	t.Helper()
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		t.Fatalf("JWT 应有 3 段，实际 %d 段", len(parts))
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		t.Fatalf("payload 不是 base64url: %v", err)
	}
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatalf("payload 不是 JSON: %v", err)
	}
	return payload
}

func TestIssueJoinToken(t *testing.T) {
	t.Setenv("LIVEKIT_API_KEY", "test-key")
	t.Setenv("LIVEKIT_API_SECRET", "test-secret")

	svc := New(nil)
	token, err := svc.IssueJoinToken("ROOM1", "user:42", "观众甲")
	if err != nil {
		t.Fatalf("签发失败: %v", err)
	}

	// 签名必须能被同一个 secret 验过（算法与 header 形态也要对）
	parsed, err := jwt.Parse(token, func(*jwt.Token) (any, error) {
		return []byte("test-secret"), nil
	}, jwt.WithValidMethods([]string{"HS256"}))
	if err != nil || !parsed.Valid {
		t.Fatalf("token 验签失败: %v", err)
	}
	if alg := parsed.Header["alg"]; alg != "HS256" {
		t.Errorf("alg = %v", alg)
	}

	payload := decodePayload(t, token)
	if payload["iss"] != "test-key" {
		t.Errorf("iss = %v", payload["iss"])
	}
	if payload["sub"] != "user:42" {
		t.Errorf("sub = %v", payload["sub"])
	}
	if payload["name"] != "观众甲" {
		t.Errorf("name = %v", payload["name"])
	}

	video, ok := payload["video"].(map[string]any)
	if !ok {
		t.Fatalf("video 授权块缺失: %v", payload["video"])
	}
	if video["room"] != "voice:ROOM1" {
		t.Errorf("video.room = %v（必须带 voice: 前缀）", video["room"])
	}
	for _, key := range []string{"roomJoin", "canPublish", "canSubscribe", "canPublishData"} {
		if video[key] != true {
			t.Errorf("video.%s 应为 true，实际 %v", key, video[key])
		}
	}
	if _, has := video["roomAdmin"]; has {
		t.Error("客户端 token 不应带 roomAdmin")
	}

	// 6h：livekit-server-sdk 的默认 TTL，前端按此刷新重连
	exp := int64(payload["exp"].(float64))
	nbf := int64(payload["nbf"].(float64))
	if got := (exp - nbf) / 3600; got != 6 {
		t.Errorf("TTL = %d 小时, want 6", got)
	}
}

func TestIssueJoinTokenWithoutCredentials(t *testing.T) {
	t.Setenv("LIVEKIT_API_KEY", "")
	t.Setenv("LIVEKIT_API_SECRET", "")
	if _, err := New(nil).IssueJoinToken("ROOM1", "user:1", ""); err == nil {
		t.Fatal("未配置密钥时应报错（端点据此回 503）")
	}
}

func TestAdminTokenHasNoSubject(t *testing.T) {
	t.Setenv("LIVEKIT_API_KEY", "test-key")
	t.Setenv("LIVEKIT_API_SECRET", "test-secret")

	token, err := New(nil).adminToken("ROOM1")
	if err != nil {
		t.Fatalf("签发失败: %v", err)
	}
	payload := decodePayload(t, token)
	if _, has := payload["sub"]; has {
		t.Errorf("admin token 不应带 sub: %v", payload["sub"])
	}
	video := payload["video"].(map[string]any)
	if video["roomAdmin"] != true {
		t.Errorf("video.roomAdmin = %v", video["roomAdmin"])
	}
	if video["room"] != "voice:ROOM1" {
		t.Errorf("video.room = %v", video["room"])
	}
}

func TestResolveClientURLPrecedence(t *testing.T) {
	svc := New(nil)

	// 无显式配置：按请求头推导，https → wss
	t.Setenv("LIVEKIT_URL", "")
	req := mustRequest(t, "http://internal:3333/api/voice/token")
	req.Header.Set("X-Forwarded-Host", "chat.example.com")
	req.Header.Set("X-Forwarded-Proto", "https")
	if got := svc.ResolveClientURL(t.Context(), req); got != "wss://chat.example.com" {
		t.Errorf("反代推导 = %q", got)
	}

	// 无反代头：按 Host + 明文 http → ws
	req2 := mustRequest(t, "http://127.0.0.1:3333/api/voice/token")
	if got := svc.ResolveClientURL(t.Context(), req2); got != "ws://127.0.0.1:3333" {
		t.Errorf("Host 推导 = %q", got)
	}

	// 环境变量优先于推导
	t.Setenv("LIVEKIT_URL", "wss://livekit.example.com")
	if got := svc.ResolveClientURL(t.Context(), req); got != "wss://livekit.example.com" {
		t.Errorf("LIVEKIT_URL 未生效: %q", got)
	}
}
