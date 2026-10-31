package share

import (
	"encoding/json"
	"strconv"
	"testing"
)

// routeFramesTo 取出推给某条连接的全部出站帧。
func routeFramesTo(hub *fakeHub, peerID string) []map[string]any {
	frames := make([]map[string]any, 0, len(hub.to))
	for _, item := range hub.to {
		if item.Target != peerID {
			continue
		}
		var message map[string]any
		if err := json.Unmarshal(item.Frame, &message); err != nil {
			continue
		}
		frames = append(frames, message)
	}
	return frames
}

// lastRouteTo 取出推给某条连接的最后一条 route 消息。
func lastRouteTo(t *testing.T, hub *fakeHub, peerID string) map[string]any {
	t.Helper()
	frames := routeFramesTo(hub, peerID)
	for index := len(frames) - 1; index >= 0; index-- {
		if frames[index]["t"] == TypeRoute {
			return frames[index]
		}
	}
	t.Fatalf("%s 没有收到 route 消息", peerID)
	return nil
}

// routePayload 把 route 消息拆成 (revision, phase, connectionId, childPeerId)。
func routePayload(t *testing.T, message map[string]any) (float64, string, string, string) {
	t.Helper()
	revision, _ := message["revision"].(float64)
	phase, _ := message["phase"].(string)
	candidate, ok := message["candidate"].(map[string]any)
	if !ok {
		t.Fatalf("route 消息缺少 candidate: %v", message)
	}
	connectionID, _ := candidate["connectionId"].(string)
	childPeerID, _ := candidate["childPeerId"].(string)
	return revision, phase, connectionID, childPeerID
}

// startSharing 让房主开共享，并在返回前把两个观众都 hello 进来。
func startSharing(t *testing.T, viewers ...string) (*Service, *fakeHub, Conn) {
	t.Helper()
	service, hub := newTestService("host-1")
	host := newConn("host-1", "r1")
	send(t, service, host, `{"t":"share.hello","roomId":"r1"}`)
	for _, viewer := range viewers {
		send(t, service, newConn(viewer, "r1"), `{"t":"share.hello","roomId":"r1"}`)
	}
	send(t, service, host, `{"t":"share.start","roomId":"r1"}`)
	return service, hub, host
}

// 房主开共享后，每条观众连接各得一条 prepare，房主自己也能收到对应候选。
func TestStartSharingPreparesOneRoutePerViewer(t *testing.T) {
	service, hub, _ := startSharing(t, "viewer-1", "viewer-2")

	session := service.Session("r1")
	if session.RouteCount() != 2 {
		t.Fatalf("应有 2 条边，实际 %d", session.RouteCount())
	}
	firstID := session.RouteConnectionID("viewer-1")
	secondID := session.RouteConnectionID("viewer-2")
	if firstID == "" || secondID == "" || firstID == secondID {
		t.Fatalf("connectionId 必须是服务端铸造且互不相同: %q %q", firstID, secondID)
	}
	if firstID[:len(connectionIDPrefix)] != connectionIDPrefix {
		t.Fatalf("connectionId 缺少 route_ 前缀: %q", firstID)
	}

	revision, phase, connectionID, childPeerID := routePayload(t, lastRouteTo(t, hub, "viewer-1"))
	if phase != PhasePrepare {
		t.Fatalf("首次下发必须是 prepare，实际 %q", phase)
	}
	if connectionID != firstID || childPeerID != "viewer-1" {
		t.Fatalf("候选身份不对: %q %q", connectionID, childPeerID)
	}
	// revision 是单调计数器，具体值不重要，只要求它是正数。
	if revision <= 0 {
		t.Fatalf("revision 应为正数: %v", revision)
	}

	// 房主也必须收到同样两条候选，且 childPeerId 指向观众。
	hostFrames := routeFramesTo(hub, "host-1")
	children := make(map[string]struct{}, 2)
	for _, message := range hostFrames {
		if message["t"] != TypeRoute {
			continue
		}
		_, _, _, child := routePayload(t, message)
		children[child] = struct{}{}
	}
	if _, ok := children["viewer-1"]; !ok {
		t.Fatal("房主没有收到 viewer-1 的候选")
	}
	if _, ok := children["viewer-2"]; !ok {
		t.Fatal("房主没有收到 viewer-2 的候选")
	}
}

// route-ready 必须携带当前 revision，提交后两端收到 active。
func TestRouteReadyCommitsAndNotifiesBothSides(t *testing.T) {
	service, hub, _ := startSharing(t, "viewer-1")
	session := service.Session("r1")
	connectionID := session.RouteConnectionID("viewer-1")
	revision, _, _, _ := routePayload(t, lastRouteTo(t, hub, "viewer-1"))

	send(t, service, newConn("viewer-1", "r1"), routeReadyFrame(int(revision), "prepare", connectionID))

	if session.RoutePhase("viewer-1") != PhaseActive {
		t.Fatalf("提交后应为 active，实际 %q", session.RoutePhase("viewer-1"))
	}
	if _, phase, _, _ := routePayload(t, lastRouteTo(t, hub, "host-1")); phase != PhaseActive {
		t.Fatalf("房主应收到 active，实际 %q", phase)
	}
	if _, phase, _, _ := routePayload(t, lastRouteTo(t, hub, "viewer-1")); phase != PhaseActive {
		t.Fatalf("观众应收到 active，实际 %q", phase)
	}
	// 快照里出现已提交的 assignment。
	snapshot := session.Snapshot()
	if snapshot.Assignment == nil || len(snapshot.Assignment.Candidates) != 1 {
		t.Fatalf("快照应包含 1 条已提交候选: %+v", snapshot.Assignment)
	}
}

// 过期 revision 的 route-ready 必须静默丢弃（不推进状态、不回报错）。
func TestRouteReadyWithStaleRevisionIsDropped(t *testing.T) {
	service, hub, _ := startSharing(t, "viewer-1")
	session := service.Session("r1")
	connectionID := session.RouteConnectionID("viewer-1")
	before := len(hub.to)

	send(t, service, newConn("viewer-1", "r1"), routeReadyFrame(999, "prepare", connectionID))

	if session.RoutePhase("viewer-1") != PhasePrepare {
		t.Fatal("过期 revision 不应提交")
	}
	if len(hub.to) != before {
		t.Fatalf("过期 revision 不应产生出站消息，多出 %d 条", len(hub.to)-before)
	}
}

// 第一个观众提交会推进 revision，第二个观众的 prepare 必须被刷新到新版本，
// 否则它的 route-ready 永远被挡在栅栏外。
func TestCommitRefreshesOtherPendingRoutes(t *testing.T) {
	service, hub, _ := startSharing(t, "viewer-1", "viewer-2")
	session := service.Session("r1")
	firstID := session.RouteConnectionID("viewer-1")
	firstRevision, _, _, _ := routePayload(t, lastRouteTo(t, hub, "viewer-1"))

	send(t, service, newConn("viewer-1", "r1"), routeReadyFrame(int(firstRevision), "prepare", firstID))

	secondRevision, phase, secondID, _ := routePayload(t, lastRouteTo(t, hub, "viewer-2"))
	if phase != PhasePrepare {
		t.Fatalf("第二条边仍应是 prepare，实际 %q", phase)
	}
	if secondRevision <= firstRevision {
		t.Fatalf("刷新后 revision 应更大: %v <= %v", secondRevision, firstRevision)
	}
	send(t, service, newConn("viewer-2", "r1"), routeReadyFrame(int(secondRevision), "prepare", secondID))
	if session.RoutePhase("viewer-2") != PhaseActive {
		t.Fatal("刷新后的第二条边应能提交")
	}
}

// offer 只能房主发，answer 只能观众发；串了角色一律丢弃。
func TestSignalForwardingHonoursRoles(t *testing.T) {
	service, hub, host := startSharing(t, "viewer-1")
	connectionID := service.Session("r1").RouteConnectionID("viewer-1")

	send(t, service, host, signalFrame("offer", connectionID, `{"sdp":"host-offer"}`))
	relay := lastServerMessage(t, hub.to)
	if relay["t"] != TypeSignalRelay || relay["fromPeerId"] != "host-1" {
		t.Fatalf("房主的 offer 应被转发给观众: %v", relay)
	}
	if relay["kind"] != SignalOffer {
		t.Fatalf("转发类型不对: %v", relay["kind"])
	}

	viewer := newConn("viewer-1", "r1")
	send(t, service, viewer, signalFrame("answer", connectionID, `{"sdp":"viewer-answer"}`))
	relay = lastServerMessage(t, hub.to)
	if relay["fromPeerId"] != "viewer-1" || relay["kind"] != SignalAnswer {
		t.Fatalf("观众的 answer 应被转发给房主: %v", relay)
	}

	before := len(hub.to)
	// 观众发 offer → 丢弃；房主发 answer → 丢弃。
	send(t, service, viewer, signalFrame("offer", connectionID, `{"sdp":"viewer-offer"}`))
	send(t, service, host, signalFrame("answer", connectionID, `{"sdp":"host-answer"}`))
	if len(hub.to) != before {
		t.Fatalf("角色越权的信号不应转发，多出 %d 条", len(hub.to)-before)
	}
}

// 观众拿别人的 connectionId 发信号必须被拒（身份栅栏）。
func TestSignalWithForeignConnectionIsDropped(t *testing.T) {
	service, hub, _ := startSharing(t, "viewer-1", "viewer-2")
	firstID := service.Session("r1").RouteConnectionID("viewer-1")
	before := len(hub.to)

	send(t, service, newConn("viewer-2", "r1"), signalFrame("candidate", firstID, `{"candidate":"x"}`))
	if len(hub.to) != before {
		t.Fatalf("跨边信号应被丢弃，多出 %d 条", len(hub.to)-before)
	}
}

// 失败一次换新 connectionId；用完次数回报 route-exhausted。
func TestRouteFailureReplacesConnectionThenExhausts(t *testing.T) {
	service, hub, _ := startSharing(t, "viewer-1")
	session := service.Session("r1")
	connectionID := session.RouteConnectionID("viewer-1")
	revision, _, _, _ := routePayload(t, lastRouteTo(t, hub, "viewer-1"))

	send(t, service, newConn("viewer-1", "r1"), routeFailedFrame(int(revision), connectionID))
	if replaced := session.RouteConnectionID("viewer-1"); replaced == connectionID || replaced == "" {
		t.Fatalf("失败后应换新 connectionId: %q", replaced)
	}
	_, phase, _, _ := routePayload(t, lastRouteTo(t, hub, "viewer-1"))
	if phase != PhasePrepare {
		t.Fatalf("重试应回到 prepare，实际 %q", phase)
	}

	for attempt := 1; attempt < MaxRouteAttempts; attempt++ {
		currentRevision, _, currentID, _ := routePayload(t, lastRouteTo(t, hub, "viewer-1"))
		send(t, service, newConn("viewer-1", "r1"), routeFailedFrame(int(currentRevision), currentID))
	}
	if session.RouteCount() != 0 {
		t.Fatalf("失败次数用完后应放弃这条边，实际仍有 %d 条", session.RouteCount())
	}
	if last := lastServerMessage(t, hub.to); last["t"] != TypeStatus || last["reason"] != ReasonRouteExhausted {
		t.Fatalf("应回报 route-exhausted，实际 %v", last)
	}
}

// restart:rebuild=false 保留身份，rebuild=true 换身份。
func TestRestartKeepsOrReplacesConnection(t *testing.T) {
	service, hub, _ := startSharing(t, "viewer-1")
	session := service.Session("r1")
	connectionID := session.RouteConnectionID("viewer-1")
	viewer := newConn("viewer-1", "r1")

	send(t, service, viewer, `{"t":"share.restart","roomId":"r1","connectionId":"`+connectionID+`","rebuild":false}`)
	if session.RouteConnectionID("viewer-1") != connectionID {
		t.Fatal("rebuild=false 应保留 connectionId")
	}
	if _, phase, _, _ := routePayload(t, lastRouteTo(t, hub, "viewer-1")); phase != PhasePrepare {
		t.Fatal("恢复应回到 prepare")
	}

	send(t, service, viewer, `{"t":"share.restart","roomId":"r1","connectionId":"`+connectionID+`","rebuild":true}`)
	if session.RouteConnectionID("viewer-1") == connectionID {
		t.Fatal("rebuild=true 应换新 connectionId")
	}
}

// 观众断线要拆掉它自己的边，房主断线要拆掉全部。
func TestLeaveDropsRoutes(t *testing.T) {
	service, _, _ := startSharing(t, "viewer-1", "viewer-2")
	session := service.Session("r1")

	service.Detach("viewer-1")
	if session.RouteCount() != 1 {
		t.Fatalf("观众断线应只拆自己那条，剩余 %d", session.RouteCount())
	}
	service.Detach("host-1")
	if session.RouteCount() != 0 {
		t.Fatalf("房主断线应拆掉全部边，剩余 %d", session.RouteCount())
	}
}

// 观众在共享中途 hello 进来，必须立刻收到候选，不用等房主重开。
func TestLateViewerGetsCandidateImmediately(t *testing.T) {
	service, hub, _ := startSharing(t, "viewer-1")
	send(t, service, newConn("viewer-2", "r1"), `{"t":"share.hello","roomId":"r1"}`)

	_, phase, connectionID, childPeerID := routePayload(t, lastRouteTo(t, hub, "viewer-2"))
	if phase != PhasePrepare || connectionID == "" || childPeerID != "viewer-2" {
		t.Fatalf("迟到观众应立刻拿到候选: %q %q %q", phase, connectionID, childPeerID)
	}
}

func routeReadyFrame(revision int, phase, connectionID string) string {
	return `{"t":"share.route-ready","roomId":"r1","revision":` + strconv.Itoa(revision) +
		`,"phase":"` + phase + `","connectionId":"` + connectionID + `"}`
}

func routeFailedFrame(revision int, connectionID string) string {
	return `{"t":"share.route-failed","roomId":"r1","revision":` + strconv.Itoa(revision) +
		`,"phase":"prepare","connectionId":"` + connectionID + `"}`
}

func signalFrame(kind, connectionID, payload string) string {
	return `{"t":"share.signal","roomId":"r1","connectionId":"` + connectionID +
		`","kind":"` + kind + `","payload":` + payload + `}`
}

