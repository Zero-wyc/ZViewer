package piikbridge

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"zviewer/backend/internal/piik/server/protocol"
)

// newTestBridge 起一个只挂 /signal 的桥接层。返回的凭证由调用方自己取。
func newTestBridge(t *testing.T) (*Bridge, *httptest.Server) {
	t.Helper()
	bridge, err := New(Options{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	server := httptest.NewServer(bridge.Handler())
	t.Cleanup(func() {
		server.Close()
		_ = bridge.Close(context.Background())
	})
	return bridge, server
}

// dialSignal 按浏览器的方式连接：带 Origin，带站点通行证。
func dialSignal(t *testing.T, server *httptest.Server, cookie string) *websocket.Conn {
	t.Helper()
	header := http.Header{}
	header.Set("Origin", server.URL)
	if cookie != "" {
		header.Set("Cookie", SiteCookie+"="+cookie)
	}
	conn, _, err := websocket.Dial(context.Background(),
		"ws"+strings.TrimPrefix(server.URL, "http")+SignalPath,
		&websocket.DialOptions{HTTPHeader: header})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close(websocket.StatusNormalClosure, "") })
	return conn
}

// authenticate 发一条 authenticate，返回服务端第一条消息的 type。
func authenticate(t *testing.T, conn *websocket.Conn, payload map[string]any) (string, map[string]any) {
	t.Helper()
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := conn.Write(ctx, websocket.MessageText, raw); err != nil {
		t.Fatalf("write: %v", err)
	}
	_, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var message map[string]any
	if err := json.Unmarshal(data, &message); err != nil {
		t.Fatalf("decode %s: %v", data, err)
	}
	kind, _ := message["type"].(string)
	return kind, message
}

func hostAuth(creds Credentials) map[string]any {
	return map[string]any{
		"type":     "authenticate",
		"protocol": protocol.SignalingProtocol,
		"roomId":   creds.RoomID,
		"role":     "host",
		"token":    creds.Token,
		"clientId": "host-client-1",
		"routePolicy": map[string]any{
			"peerOnly":             false,
			"topologyOptimization": true,
			"natPrediction":        false,
		},
	}
}

func viewerAuth(creds Credentials) map[string]any {
	return map[string]any{
		"type":        "authenticate",
		"protocol":    protocol.SignalingProtocol,
		"roomId":      creds.RoomID,
		"role":        "viewer",
		"clientId":    "viewer-client-1",
		"viewerGrant": creds.Grant,
	}
}

func TestHostHandshake(t *testing.T) {
	bridge, server := newTestBridge(t)
	creds, err := bridge.Host("ROOM0001")
	if err != nil {
		t.Fatalf("Host: %v", err)
	}
	if creds.RoomID == "" || creds.Token == "" || creds.Role != protocol.RoleHost {
		t.Fatalf("unexpected credentials: %+v", creds)
	}

	ticket := bridge.signTicket("1", time.Now().Add(time.Minute))
	conn := dialSignal(t, server, ticket)
	kind, message := authenticate(t, conn, hostAuth(creds))
	if kind != "authenticated" {
		t.Fatalf("first message = %q (%v), want authenticated", kind, message)
	}
	if peerID, _ := message["peerId"].(string); peerID == "" {
		t.Fatalf("authenticated without peerId: %v", message)
	}
	if role, _ := message["role"].(string); role != protocol.RoleHost {
		t.Fatalf("role = %q", role)
	}
	if ice, ok := message["iceConfig"].(map[string]any); !ok || len(ice["iceServers"].([]any)) == 0 {
		t.Fatalf("iceConfig missing: %v", message["iceConfig"])
	}
}

func TestHostWithoutSiteTicketRejected(t *testing.T) {
	bridge, server := newTestBridge(t)
	creds, err := bridge.Host("ROOM0002")
	if err != nil {
		t.Fatalf("Host: %v", err)
	}
	conn := dialSignal(t, server, "")
	kind, message := authenticate(t, conn, hostAuth(creds))
	if kind != "error" {
		t.Fatalf("first message = %q (%v), want error", kind, message)
	}
	if code, _ := message["code"].(string); code != "AUTH_REQUIRED" {
		t.Fatalf("code = %q (%v)", code, message)
	}
}

func TestViewerHandshakeWithGrant(t *testing.T) {
	bridge, server := newTestBridge(t)
	if _, err := bridge.Host("ROOM0003"); err != nil {
		t.Fatalf("Host: %v", err)
	}
	creds, err := bridge.Viewer("ROOM0003")
	if err != nil {
		t.Fatalf("Viewer: %v", err)
	}
	if creds.Grant == "" || creds.Role != protocol.RoleViewer {
		t.Fatalf("unexpected credentials: %+v", creds)
	}

	// 观众走 Piik 的邀请链接分支，不需要站点通行证。
	conn := dialSignal(t, server, "")
	kind, message := authenticate(t, conn, viewerAuth(creds))
	if kind != "authenticated" {
		t.Fatalf("first message = %q (%v), want authenticated", kind, message)
	}
	if role, _ := message["role"].(string); role != protocol.RoleViewer {
		t.Fatalf("role = %q", role)
	}
}

func TestViewerBeforeHost(t *testing.T) {
	bridge, _ := newTestBridge(t)
	if _, err := bridge.Viewer("ROOM0004"); err != ErrNoRoom {
		t.Fatalf("Viewer error = %v, want ErrNoRoom", err)
	}
}

func TestOriginPolicy(t *testing.T) {
	_, server := newTestBridge(t)

	cases := []struct {
		name   string
		origin string
		want   int
	}{
		{"same-origin", server.URL, http.StatusSwitchingProtocols},
		{"foreign", "https://evil.example", http.StatusForbidden},
		{"path-suffixed", server.URL + "/app", http.StatusForbidden},
		{"empty", "", http.StatusForbidden},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			request, err := http.NewRequest(http.MethodGet, server.URL+SignalPath, nil)
			if err != nil {
				t.Fatalf("new request: %v", err)
			}
			if tc.origin != "" {
				request.Header.Set("Origin", tc.origin)
			}
			request.Header.Set("Connection", "Upgrade")
			request.Header.Set("Upgrade", "websocket")
			request.Header.Set("Sec-WebSocket-Version", "13")
			request.Header.Set("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
			response, err := server.Client().Do(request)
			if err != nil {
				t.Fatalf("do: %v", err)
			}
			defer response.Body.Close()
			if response.StatusCode != tc.want {
				t.Fatalf("status = %d, want %d", response.StatusCode, tc.want)
			}
		})
	}
}

func TestCORSAllowListOrigin(t *testing.T) {
	bridge, err := New(Options{AllowedOrigins: []string{"https://viewer.example"}})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer bridge.Close(context.Background())
	server := httptest.NewServer(bridge.Handler())
	defer server.Close()

	request, _ := http.NewRequest(http.MethodGet, server.URL+SignalPath, nil)
	request.Header.Set("Origin", "https://viewer.example")
	request.Header.Set("Connection", "Upgrade")
	request.Header.Set("Upgrade", "websocket")
	request.Header.Set("Sec-WebSocket-Version", "13")
	request.Header.Set("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
	response, err := server.Client().Do(request)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("status = %d, want 101", response.StatusCode)
	}
}

func TestTicketTampering(t *testing.T) {
	bridge, _ := newTestBridge(t)
	now := time.Now()
	if !bridge.verifyTicket(bridge.signTicket("7", now.Add(time.Minute)), now) {
		t.Fatal("fresh ticket rejected")
	}
	if bridge.verifyTicket(bridge.signTicket("7", now.Add(-time.Second)), now) {
		t.Fatal("expired ticket accepted")
	}
	valid := bridge.signTicket("7", now.Add(time.Minute))
	encoded, signature, _ := strings.Cut(valid, ".")
	tampered := encoded + "x." + signature
	if bridge.verifyTicket(tampered, now) {
		t.Fatal("tampered payload accepted")
	}
	if bridge.verifyTicket("garbage", now) {
		t.Fatal("garbage accepted")
	}
}

func TestGrantSiteAccessSetsScopedCookie(t *testing.T) {
	bridge, _ := newTestBridge(t)
	request := httptest.NewRequest(http.MethodPost, "http://example.test/api/share/piik/session", nil)
	request.Header.Set("X-Forwarded-Proto", "https")
	recorder := httptest.NewRecorder()
	bridge.GrantSiteAccess(recorder, request, "42")

	cookies := recorder.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatalf("cookies = %v", cookies)
	}
	cookie := cookies[0]
	if cookie.Name != SiteCookie || cookie.Path != SignalPath {
		t.Fatalf("cookie = %+v", cookie)
	}
	if !cookie.HttpOnly || !cookie.Secure {
		t.Fatalf("cookie flags = %+v", cookie)
	}
	if !bridge.verifyTicket(cookie.Value, time.Now()) {
		t.Fatal("cookie value is not a valid ticket")
	}
}

func TestReleaseEndsRoom(t *testing.T) {
	bridge, _ := newTestBridge(t)
	creds, err := bridge.Host("ROOM0005")
	if err != nil {
		t.Fatalf("Host: %v", err)
	}
	if err := bridge.Release("ROOM0005"); err != nil {
		t.Fatalf("Release: %v", err)
	}
	if bridge.signal.RoomAuthorityValid(creds.RoomID, creds.Token) {
		t.Fatal("room survived Release")
	}
	if _, err := bridge.Viewer("ROOM0005"); err != ErrNoRoom {
		t.Fatalf("Viewer after Release = %v, want ErrNoRoom", err)
	}
}

func TestHostRecreatesExpiredRoom(t *testing.T) {
	bridge, _ := newTestBridge(t)
	first, err := bridge.Host("ROOM0006")
	if err != nil {
		t.Fatalf("Host: %v", err)
	}
	if err := bridge.Release("ROOM0006"); err != nil {
		t.Fatalf("Release: %v", err)
	}
	second, err := bridge.Host("ROOM0006")
	if err != nil {
		t.Fatalf("Host again: %v", err)
	}
	if second.Token == first.Token {
		t.Fatal("stale binding reused after the room was released")
	}
	if second.RoomID == "" {
		t.Fatal("recreated room has no code")
	}
}
