package piikbridge

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// readUntil 读到第一条满足条件的消息为止，中途的消息全部丢弃。
//
// 服务端的 route 调度是异步的：`route-update` 会先来一条 revision 0 的空
// 分配，再来带 candidate 的那条。只读一条一定会读到空的那条。
func readUntil(
	t *testing.T,
	conn *websocket.Conn,
	kind string,
	predicate func(map[string]any) bool,
) map[string]any {
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
		if message["type"] != kind {
			continue
		}
		if predicate == nil || predicate(message) {
			return message
		}
	}
	t.Fatalf("没有等到期望的 %s", kind)
	return nil
}

func candidateOf(message map[string]any) map[string]any {
	candidate, _ := message["candidate"].(map[string]any)
	return candidate
}

func assignmentOf(message map[string]any) map[string]any {
	assignment, _ := message["assignment"].(map[string]any)
	return assignment
}

// TestShareHostStartsSharingAndAssignsViewer 走通 S3b 的服务端主干：
// 房主只进房不开播（roomOnly + roomSession）→ start-sharing → 观众接入 →
// 两端各自拿到同一条候选边。
//
// 这条链路之前在 Piik 上游只被它自己的 UI 覆盖；ZViewer 的桥接层换了房间
// 模型（自己的 roomId、自己的身份表），必须单独锁住。
func TestShareHostStartsSharingAndAssignsViewer(t *testing.T) {
	bridge, server := newTestBridge(t)
	hostCred, err := bridge.Host("ROOMSHARE1")
	if err != nil {
		t.Fatalf("Host: %v", err)
	}

	hostTicket := bridge.signTicket("1", time.Now().Add(time.Minute))
	hostConn := dialSignal(t, server, hostTicket)
	// 先进房、后开播：roomOnly 让认证不产生 publication，roomSession 才允许
	// 之后用 start-sharing 补一次。缺任意一个都会失败（见下面两条用例）。
	payload := hostAuth(hostCred)
	payload["roomOnly"] = true
	payload["roomSession"] = true
	kind, message := authenticate(t, hostConn, payload)
	if kind != "authenticated" {
		t.Fatalf("房主握手 = %q (%v)", kind, message)
	}
	hostPeerID, _ := message["peerId"].(string)
	if hostPeerID == "" {
		t.Fatalf("房主没有 peerId: %v", message)
	}

	send(t, hostConn, map[string]any{
		"type":            "start-sharing",
		"shareGeneration": "sggeneration01",
		"routePolicy": map[string]any{
			"peerOnly":             false,
			"topologyOptimization": true,
			"natPrediction":        false,
		},
	})
	started := readUntil(t, hostConn, "sharing-started", nil)
	if started["shareGeneration"] != "sggeneration01" {
		t.Fatalf("sharing-started 代际不对: %v", started)
	}

	viewerCred, err := bridge.Viewer("ROOMSHARE1")
	if err != nil {
		t.Fatalf("Viewer: %v", err)
	}
	viewerConn := dialSignal(t, server, "")
	kind, message = authenticate(t, viewerConn, viewerAuth(viewerCred))
	if kind != "authenticated" {
		t.Fatalf("观众握手 = %q (%v)", kind, message)
	}
	viewerPeerID, _ := message["peerId"].(string)
	if viewerPeerID == "" {
		t.Fatalf("观众没有 peerId: %v", message)
	}

	// 房主侧：新边挂在它下面。
	hostUpdate := readUntil(t, hostConn, "route-update", func(m map[string]any) bool {
		return candidateOf(m) != nil
	})
	candidate := candidateOf(hostUpdate)
	if candidate["childPeerId"] != viewerPeerID {
		t.Fatalf("候选边的子节点 = %v，期望 %s", candidate["childPeerId"], viewerPeerID)
	}
	if connectionID, _ := candidate["connectionId"].(string); connectionID == "" {
		t.Fatalf("候选边没有 connectionId: %v", candidate)
	}
	children, _ := assignmentOf(hostUpdate)["childPeerIds"].([]any)
	if len(children) != 1 || children[0] != viewerPeerID {
		t.Fatalf("房主的下游 = %v，期望只有 %s", children, viewerPeerID)
	}

	// 观众侧：上游指向房主。
	viewerUpdate := readUntil(t, viewerConn, "route-update", func(m map[string]any) bool {
		return candidateOf(m) != nil
	})
	upstream, _ := assignmentOf(viewerUpdate)["upstream"].(map[string]any)
	if upstream["kind"] != "peer" || upstream["peerId"] != hostPeerID {
		t.Fatalf("观众的上游 = %v，期望 peer/%s", upstream, hostPeerID)
	}
	if candidateOf(viewerUpdate)["connectionId"] != candidate["connectionId"] {
		t.Fatalf("两端拿到的 connectionId 不一致: %v / %v",
			candidateOf(viewerUpdate), candidate)
	}
}

// TestShareStartSharingNeedsRoomOnly 锁住协议细节：只带 roomSession 时，
// 认证会把 shareGeneration 自动填成 sessionID，随后的 start-sharing 撞上
// 「已有一个代际」，只能拿到 sharing-start-failed。
func TestShareStartSharingNeedsRoomOnly(t *testing.T) {
	bridge, server := newTestBridge(t)
	creds, err := bridge.Host("ROOMSHARE2")
	if err != nil {
		t.Fatalf("Host: %v", err)
	}
	conn := dialSignal(t, server, bridge.signTicket("1", time.Now().Add(time.Minute)))
	payload := hostAuth(creds)
	payload["roomSession"] = true
	if kind, message := authenticate(t, conn, payload); kind != "authenticated" {
		t.Fatalf("握手 = %q (%v)", kind, message)
	}

	send(t, conn, map[string]any{
		"type":            "start-sharing",
		"shareGeneration": "sggeneration02",
		"routePolicy": map[string]any{
			"peerOnly":             false,
			"topologyOptimization": true,
			"natPrediction":        false,
		},
	})
	failed := readUntil(t, conn, "sharing-start-failed", nil)
	if failed["code"] != "FORBIDDEN" {
		t.Fatalf("期望 FORBIDDEN，实际 %v", failed)
	}
}

// TestShareStartSharingRequiresRoomSession 没有 roomSession 时 start-sharing
// 直接被拒——这是「旧客户端」的路径，不能悄悄放行。
func TestShareStartSharingRequiresRoomSession(t *testing.T) {
	bridge, server := newTestBridge(t)
	creds, err := bridge.Host("ROOMSHARE3")
	if err != nil {
		t.Fatalf("Host: %v", err)
	}
	conn := dialSignal(t, server, bridge.signTicket("1", time.Now().Add(time.Minute)))
	payload := hostAuth(creds)
	payload["roomOnly"] = true
	payload["roomSession"] = true
	if kind, message := authenticate(t, conn, payload); kind != "authenticated" {
		t.Fatalf("握手 = %q (%v)", kind, message)
	}

	// 重新连一条不带 roomSession 的会话：同一个 token 会顶掉上一条。
	second := dialSignal(t, server, bridge.signTicket("1", time.Now().Add(time.Minute)))
	bare := hostAuth(creds)
	if kind, message := authenticate(t, second, bare); kind != "authenticated" {
		t.Fatalf("握手 = %q (%v)", kind, message)
	}

	send(t, second, map[string]any{
		"type":            "start-sharing",
		"shareGeneration": "sggeneration03",
		"routePolicy": map[string]any{
			"peerOnly":             false,
			"topologyOptimization": true,
			"natPrediction":        false,
		},
	})
	errorMessage := readUntil(t, second, "error", nil)
	if errorMessage["code"] != "FORBIDDEN" {
		t.Fatalf("期望 FORBIDDEN，实际 %v", errorMessage)
	}
}
