package piikbridge

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// readState 读到一条满足条件的 room-voice-state 为止。
//
// 服务端每次状态变化都会推一份完整快照，且请求调度是异步的：这里必须轮询
// 而不是只读一条，否则用例会在「房主刚 publish、树还没铺」的瞬间失败。
func readState(t *testing.T, conn *websocket.Conn, predicate func(map[string]any) bool) map[string]any {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		ctx, cancel := context.WithTimeout(context.Background(), time.Until(deadline))
		_, data, err := conn.Read(ctx)
		cancel()
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		var message map[string]any
		if err := json.Unmarshal(data, &message); err != nil {
			t.Fatalf("decode %s: %v", data, err)
		}
		if message["type"] != "room-voice-state" {
			continue
		}
		if predicate == nil || predicate(message) {
			return message
		}
	}
	t.Fatal("没有等到期望的 room-voice-state")
	return nil
}

func send(t *testing.T, conn *websocket.Conn, payload map[string]any) {
	t.Helper()
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := conn.Write(ctx, websocket.MessageText, raw); err != nil {
		t.Fatalf("write: %v", err)
	}
}

func voiceMembers(state map[string]any) []map[string]any {
	raw, _ := state["members"].([]any)
	members := make([]map[string]any, 0, len(raw))
	for _, item := range raw {
		if entry, ok := item.(map[string]any); ok {
			members = append(members, entry)
		}
	}
	return members
}

func voiceConnections(state map[string]any) []map[string]any {
	raw, _ := state["connections"].([]any)
	connections := make([]map[string]any, 0, len(raw))
	for _, item := range raw {
		if entry, ok := item.(map[string]any); ok {
			connections = append(connections, entry)
		}
	}
	return connections
}

// TestVoiceHostJoinsAndPublishes 房主连上 /signal 后能进语音并发布。
//
// 这是前端 `usePiikVoice` 依赖的第一个事实：没有房主 join，服务端会让所有
// 其他人收到 not-enabled。
func TestVoiceHostJoinsAndPublishes(t *testing.T) {
	bridge, server := newTestBridge(t)
	creds, err := bridge.Host("ROOMVOICE")
	if err != nil {
		t.Fatalf("Host: %v", err)
	}
	ticket := bridge.signTicket("1", time.Now().Add(time.Minute))
	conn := dialSignal(t, server, ticket)

	payload := hostAuth(creds)
	payload["roomOnly"] = true
	payload["roomSession"] = true
	if kind, message := authenticate(t, conn, payload); kind != "authenticated" {
		t.Fatalf("handshake = %q (%v)", kind, message)
	}

	send(t, conn, map[string]any{"type": "subscribe-room-voice", "deafened": false, "bitrate": true})
	send(t, conn, map[string]any{"type": "room-voice-command", "command": map[string]any{"action": "join"}})

	state := readState(t, conn, func(state map[string]any) bool {
		return state["enabled"] == true
	})
	if len(voiceMembers(state)) != 1 {
		t.Fatalf("成员数 = %d (%v)", len(voiceMembers(state)), state)
	}
	if joined, _ := voiceMembers(state)[0]["joined"].(bool); !joined {
		t.Fatalf("房主没有 join: %v", state)
	}

	send(t, conn, map[string]any{"type": "room-voice-command", "command": map[string]any{"action": "publish"}})
	state = readState(t, conn, func(state map[string]any) bool {
		publications, _ := state["publications"].([]any)
		return len(publications) == 1
	})
	publication := state["publications"].([]any)[0].(map[string]any)
	if publication["peerId"] == "" || publication["id"] == "" {
		t.Fatalf("发布身份不完整: %v", publication)
	}
}

// TestVoiceViewerWaitsForHost 房主没进语音时，观众 join 会拿到 not-enabled。
func TestVoiceViewerWaitsForHost(t *testing.T) {
	bridge, server := newTestBridge(t)
	if _, err := bridge.Host("ROOMVOICE2"); err != nil {
		t.Fatalf("Host: %v", err)
	}
	creds, err := bridge.Viewer("ROOMVOICE2")
	if err != nil {
		t.Fatalf("Viewer: %v", err)
	}
	conn := dialSignal(t, server, "")
	if kind, message := authenticate(t, conn, viewerAuth(creds)); kind != "authenticated" {
		t.Fatalf("handshake = %q (%v)", kind, message)
	}

	send(t, conn, map[string]any{"type": "subscribe-room-voice", "deafened": false})
	send(t, conn, map[string]any{"type": "room-voice-command", "command": map[string]any{"action": "join"}})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		var message map[string]any
		_ = json.Unmarshal(data, &message)
		if message["type"] == "room-voice-error" {
			if code, _ := message["code"].(string); code != "not-enabled" {
				t.Fatalf("code = %q", code)
			}
			return
		}
		if message["type"] == "room-voice-state" {
			if enabled, _ := message["enabled"].(bool); enabled {
				t.Fatalf("房主没进语音时不应 enabled: %v", message)
			}
		}
	}
}

// TestVoiceViewerGetsEdgeToHost 两人都进语音后，服务端要给出「观众挂房主」
// 这条边，并且把发起方指定为房主——前端据此决定谁 offer。
func TestVoiceViewerGetsEdgeToHost(t *testing.T) {
	bridge, server := newTestBridge(t)
	hostCreds, err := bridge.Host("ROOMVOICE3")
	if err != nil {
		t.Fatalf("Host: %v", err)
	}
	viewerCreds, err := bridge.Viewer("ROOMVOICE3")
	if err != nil {
		t.Fatalf("Viewer: %v", err)
	}
	ticket := bridge.signTicket("1", time.Now().Add(time.Minute))
	hostConn := dialSignal(t, server, ticket)
	hostPayload := hostAuth(hostCreds)
	hostPayload["roomOnly"] = true
	hostPayload["roomSession"] = true
	if kind, message := authenticate(t, hostConn, hostPayload); kind != "authenticated" {
		t.Fatalf("host handshake = %q (%v)", kind, message)
	}
	send(t, hostConn, map[string]any{"type": "subscribe-room-voice", "deafened": false})
	send(t, hostConn, map[string]any{"type": "room-voice-command", "command": map[string]any{"action": "join"}})
	send(t, hostConn, map[string]any{"type": "room-voice-command", "command": map[string]any{"action": "publish"}})
	readState(t, hostConn, func(state map[string]any) bool {
		return state["enabled"] == true
	})

	viewerConn := dialSignal(t, server, "")
	if kind, message := authenticate(t, viewerConn, viewerAuth(viewerCreds)); kind != "authenticated" {
		t.Fatalf("viewer handshake = %q (%v)", kind, message)
	}
	send(t, viewerConn, map[string]any{"type": "subscribe-room-voice", "deafened": false})
	send(t, viewerConn, map[string]any{"type": "room-voice-command", "command": map[string]any{"action": "join"}})

	state := readState(t, viewerConn, func(state map[string]any) bool {
		return len(voiceConnections(state)) > 0
	})
	edges := voiceConnections(state)
	edge := edges[0]
	if edge["parentPeerId"] == nil || edge["parentPeerId"] == "" {
		t.Fatalf("边没有上游: %v", edge)
	}
	if edge["transport"] != "peer" {
		t.Fatalf("transport = %v，期望 peer", edge["transport"])
	}
	if edge["childPeerId"] == edge["parentPeerId"] {
		t.Fatalf("自环: %v", edge)
	}
}
