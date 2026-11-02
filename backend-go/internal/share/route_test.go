package share

import (
	"encoding/json"
	"strconv"
	"testing"

	"zviewer/backend/internal/share/piikroute"
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

// startSharing 让房主开共享，并在返回前把观众都 hello 进来。
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

// readyViewer 让某位观众提交它当前的候选（等价于「已解出首帧」）。
func readyViewer(t *testing.T, service *Service, session *Session, viewer string) {
	t.Helper()
	route := treeRoute(t, session, viewer)
	send(t, service, newConn(viewer, "r1"),
		routeReadyFrame(int(session.Revision()), "prepare", route.ConnectionID))
}

// 控制器一次只发一条候选：第二个人要等第一个人结算完。
func TestStartSharingPreparesOneRouteAtATime(t *testing.T) {
	service, hub, _ := startSharing(t, "viewer-1", "viewer-2")

	session := service.Session("r1")
	if session.RouteCount() != 1 {
		t.Fatalf("同一时刻只应有一条候选，实际 %d", session.RouteCount())
	}
	firstID := session.RouteConnectionID("viewer-1")
	if firstID == "" {
		t.Fatal("viewer-1 应该有候选")
	}
	if firstID[:len(piikroute.ConnectionIDPrefix)] != piikroute.ConnectionIDPrefix {
		t.Fatalf("connectionId 缺少 route_ 前缀: %q", firstID)
	}

	revision, phase, connectionID, childPeerID := routePayload(t, lastRouteTo(t, hub, "viewer-1"))
	if phase != PhasePrepare {
		t.Fatalf("首次下发必须是 prepare，实际 %q", phase)
	}
	if connectionID != firstID || childPeerID != "viewer-1" {
		t.Fatalf("候选身份不对: %q %q", connectionID, childPeerID)
	}
	if revision <= 0 {
		t.Fatalf("revision 应为正数: %v", revision)
	}
	// 房主也要收到同一条候选（它是上游）。
	_, _, _, hostChild := routePayload(t, lastRouteTo(t, hub, "host-1"))
	if hostChild != "viewer-1" {
		t.Fatalf("房主收到的候选应指向 viewer-1，实际 %q", hostChild)
	}

	readyViewer(t, service, session, "viewer-1")
	if session.RouteConnectionID("viewer-2") == "" {
		t.Fatal("viewer-1 结算后应轮到 viewer-2")
	}
	if session.RoutePhase("viewer-2") != PhasePrepare {
		t.Fatalf("viewer-2 应处于 prepare，实际 %q", session.RoutePhase("viewer-2"))
	}
}

// route-ready 提交后两端收到 active，快照里出现已提交候选。
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
	snapshot := session.Snapshot()
	if snapshot.Assignment == nil || len(snapshot.Assignment.Candidates) != 1 {
		t.Fatalf("快照应包含 1 条已提交候选: %+v", snapshot.Assignment)
	}
}

// 拿别人的 connectionId 提交必须被丢弃（身份栅栏）。
func TestRouteReadyWithForeignConnectionIsDropped(t *testing.T) {
	service, hub, _ := startSharing(t, "viewer-1")
	session := service.Session("r1")
	before := len(hub.to)

	send(t, service, newConn("viewer-1", "r1"), routeReadyFrame(1, "prepare", "route_not-mine"))

	if session.RoutePhase("viewer-1") != PhasePrepare {
		t.Fatal("不存在的连接身份不应提交")
	}
	if len(hub.to) != before {
		t.Fatalf("无效提交不应产生出站消息，多出 %d 条", len(hub.to)-before)
	}
}

// offer 只能上游发，answer 只能下游发；串了角色一律丢弃。
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

// 一条候选失败就换下一个上游；换完没有可选才放弃。
func TestRouteFailureMovesToAnotherParent(t *testing.T) {
	service, hub, _ := startSharing(t, "viewer-1", "viewer-2")
	session := service.Session("r1")
	readyViewer(t, service, session, "viewer-1")

	if parent := treeRoute(t, session, "viewer-1").ParentPeerID; parent != "host-1" {
		t.Fatalf("前置条件不成立：viewer-1 应挂在房主上，实际 %q", parent)
	}
	second := treeRoute(t, session, "viewer-2")
	if second.ParentPeerID != "host-1" {
		t.Fatalf("前置条件不成立：viewer-2 应先在房主上，实际 %q", second.ParentPeerID)
	}

	send(t, service, newConn("viewer-2", "r1"),
		routeFailedFrame(int(session.Revision()), second.ConnectionID))

	replaced := treeRoute(t, session, "viewer-2")
	if replaced.ConnectionID == second.ConnectionID {
		t.Fatal("失败后必须换一个新的 connectionId")
	}
	if replaced.ParentPeerID != "viewer-1" {
		t.Fatalf("应换到另一位已出首帧的观众，实际 %q", replaced.ParentPeerID)
	}
	if last := lastServerMessage(t, hub.to); last["t"] == TypeStatus {
		t.Fatalf("还有可选上游时不应报失败: %v", last)
	}
}

// 没有任何可选上游时回报 route-exhausted，并把这条边撤掉。
func TestRouteFailureExhaustsWithoutAlternative(t *testing.T) {
	service, hub, _ := startSharing(t, "viewer-1")
	session := service.Session("r1")
	connectionID := session.RouteConnectionID("viewer-1")

	send(t, service, newConn("viewer-1", "r1"),
		routeFailedFrame(int(session.Revision()), connectionID))

	if session.RouteCount() != 0 {
		t.Fatalf("没有别的上游时应撤掉这条边，实际仍有 %d 条", session.RouteCount())
	}
	last := lastServerMessage(t, hub.to)
	if last["t"] != TypeStatus || last["reason"] != ReasonRouteExhausted {
		t.Fatalf("应回报 route-exhausted，实际 %v", last)
	}
}

// restart:rebuild=false 保留身份，rebuild=true 重新选路。
func TestRestartKeepsOrReplacesConnection(t *testing.T) {
	service, hub, _ := startSharing(t, "viewer-1", "viewer-2")
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

	readyViewer(t, service, session, "viewer-1")
	// 让 viewer-2 拿到候选，再让它重建：换上游必然换身份。
	second := treeRoute(t, session, "viewer-2")
	send(t, service, newConn("viewer-2", "r1"),
		`{"t":"share.restart","roomId":"r1","connectionId":"`+second.ConnectionID+`","rebuild":true}`)

	replaced := treeRoute(t, session, "viewer-2")
	if replaced.ConnectionID == second.ConnectionID {
		t.Fatal("rebuild=true 应换新 connectionId")
	}
}

// 观众断线拆掉自己的边，房主断线拆掉全部。
func TestLeaveDropsRoutes(t *testing.T) {
	service, _, _ := startSharing(t, "viewer-1", "viewer-2")
	session := service.Session("r1")

	service.Detach("viewer-1")
	if hasRoute(session, "viewer-1") {
		t.Fatal("断线的观众不该还留着上游边")
	}
	if !hasRoute(session, "viewer-2") {
		t.Fatal("腾出位置后，排队的观众应立刻拿到候选")
	}
	service.Detach("host-1")
	if session.RouteCount() != 0 {
		t.Fatalf("房主断线应拆掉全部边，剩余 %d", session.RouteCount())
	}
}

// 观众在共享中途 hello 进来，只要队列空着就立刻收到候选。
func TestLateViewerGetsCandidateImmediately(t *testing.T) {
	service, hub, _ := startSharing(t, "viewer-1")
	session := service.Session("r1")
	readyViewer(t, service, session, "viewer-1")

	send(t, service, newConn("viewer-2", "r1"), `{"t":"share.hello","roomId":"r1"}`)

	_, phase, connectionID, _ := routePayload(t, lastRouteTo(t, hub, "viewer-2"))
	if phase != PhasePrepare || connectionID == "" {
		t.Fatalf("迟到观众应拿到候选: %q %q", phase, connectionID)
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
