package share

import (
	"context"
	"fmt"
	"testing"
)

// newTreeService 构造一个带树形上限的服务（房主固定是 host-1）。
func newTreeService(policy TreePolicy) (*Service, *fakeHub, *fakeTimers) {
	hub := &fakeHub{}
	timers := newFakeTimers()
	service := NewService(Deps{
		Hub: hub,
		IsHost: func(_ context.Context, socketID, _ string) (bool, error) {
			return socketID == "host-1", nil
		},
		DisplayName: func(socketID string) string { return "名字:" + socketID },
		AfterFunc:   timers.AfterFunc,
		Clock:       timers.Now,
	})
	service.tree = policy
	return service, hub, timers
}

// treeRoute 取出某位观众当前那条边（不存在则测试失败）。
func treeRoute(t *testing.T, session *Session, child string) Route {
	t.Helper()
	session.mu.Lock()
	defer session.mu.Unlock()
	route, ok := session.routes[child]
	if !ok {
		t.Fatalf("%s 没有上游边", child)
	}
	return *route
}

// hasRoute 报告某位观众当前是否有上游边。
func hasRoute(session *Session, child string) bool {
	session.mu.Lock()
	defer session.mu.Unlock()
	_, ok := session.routes[child]
	return ok
}

// joinRoom 让一条连接 hello 进来。
func joinRoom(t *testing.T, service *Service, socketID string) {
	t.Helper()
	send(t, service, newConn(socketID, "r1"), `{"t":"share.hello","roomId":"r1"}`)
}

// fillTree 让整个房间跑到没有新边可发为止，返回成功挂上的观众数。
func fillTree(t *testing.T, service *Service, session *Session) int {
	t.Helper()
	attached := 0
	for range 32 {
		session.mu.Lock()
		var pending *Route
		for _, route := range session.routes {
			if route.Phase == PhasePrepare {
				pending = route
				break
			}
		}
		session.mu.Unlock()
		if pending == nil {
			return attached
		}
		send(t, service, newConn(pending.ChildPeerID, "r1"),
			routeReadyFrame(int(session.Revision()), "prepare", pending.ConnectionID))
		attached++
	}
	t.Fatal("房间没有收敛：32 轮仍在产生新边")
	return 0
}

// 铺路是串行的：同一时刻只有一条候选在等客户端回报。
func TestTreeAdmitsViewersOneAtATime(t *testing.T) {
	service, _, _ := newTreeService(DefaultTreePolicy())
	joinRoom(t, service, "host-1")
	for _, viewer := range []string{"viewer-1", "viewer-2", "viewer-3"} {
		joinRoom(t, service, viewer)
	}
	send(t, service, newConn("host-1", "r1"), `{"t":"share.start","roomId":"r1"}`)
	session := service.Session("r1")

	if session.RouteCount() != 1 {
		t.Fatalf("同一时刻只应有一条候选，实际 %d", session.RouteCount())
	}
	if !hasRoute(session, "viewer-1") {
		t.Fatal("第一条候选应给最先入座的观众")
	}
	if hasRoute(session, "viewer-2") || hasRoute(session, "viewer-3") {
		t.Fatal("后面的人要等前一位结算")
	}

	readyViewer(t, service, session, "viewer-1")
	if !hasRoute(session, "viewer-2") {
		t.Fatal("viewer-1 结算后应轮到 viewer-2")
	}
}

// 观众出首帧后成为合法上游：房主满员时后来者挂到它身上。
func TestTreeSpillsOntoReadyViewer(t *testing.T) {
	service, hub, _ := newTreeService(TreePolicy{HostChildren: 1, ViewerChildren: 2, MaxDepth: 2})
	joinRoom(t, service, "host-1")
	for _, viewer := range []string{"viewer-1", "viewer-2", "viewer-3"} {
		joinRoom(t, service, viewer)
	}
	send(t, service, newConn("host-1", "r1"), `{"t":"share.start","roomId":"r1"}`)
	session := service.Session("r1")

	readyViewer(t, service, session, "viewer-1")
	if parent := treeRoute(t, session, "viewer-1").ParentPeerID; parent != "host-1" {
		t.Fatalf("viewer-1 应留在房主上，实际 %q", parent)
	}

	readyViewer(t, service, session, "viewer-2")
	if parent := treeRoute(t, session, "viewer-2").ParentPeerID; parent != "viewer-1" {
		t.Fatalf("房主满员后 viewer-2 应挂到 viewer-1，实际 %q", parent)
	}
	if phase := treeRoute(t, session, "viewer-2").Phase; phase != PhaseActive {
		t.Fatalf("viewer-2 提交后应为 active，实际 %q", phase)
	}

	readyViewer(t, service, session, "viewer-3")
	if parent := treeRoute(t, session, "viewer-3").ParentPeerID; parent != "viewer-1" {
		t.Fatalf("viewer-3 也应挂到 viewer-1，实际 %q", parent)
	}
	// 作为上游的观众必须收到过候选（它要建发布端）。
	if frames := routeFramesTo(hub, "viewer-1"); len(frames) == 0 {
		t.Fatal("viewer-1 作为上游没有收到候选")
	}
}

// 深度到顶就不再往下挂：第三层的观众容量是 0。
func TestTreeRespectsDepthLimit(t *testing.T) {
	service, _, _ := newTreeService(TreePolicy{HostChildren: 1, ViewerChildren: 2, MaxDepth: 2})
	joinRoom(t, service, "host-1")
	for _, viewer := range []string{"viewer-1", "viewer-2", "viewer-3", "viewer-4"} {
		joinRoom(t, service, viewer)
	}
	send(t, service, newConn("host-1", "r1"), `{"t":"share.start","roomId":"r1"}`)
	session := service.Session("r1")

	// 容量：房主 1 + 第二层 2 = 3，第四位没有位置。
	if attached := fillTree(t, service, session); attached != 3 {
		t.Fatalf("MaxDepth=2 时最多挂 3 位，实际 %d", attached)
	}
	if hasRoute(session, "viewer-4") {
		t.Fatal("第四位不该有上游边")
	}
	for _, viewer := range []string{"viewer-2", "viewer-3"} {
		if parent := treeRoute(t, session, viewer).ParentPeerID; parent != "viewer-1" {
			t.Fatalf("%s 应在第二层（挂 viewer-1），实际 %q", viewer, parent)
		}
	}
}

// 父节点离开：下游重挂，不会继续指向已经走人的上游。
func TestTreeReparentsSubtreeWhenParentLeaves(t *testing.T) {
	service, _, _ := newTreeService(TreePolicy{HostChildren: 2, ViewerChildren: 2, MaxDepth: 3})
	joinRoom(t, service, "host-1")
	for _, viewer := range []string{"viewer-1", "viewer-2", "viewer-3"} {
		joinRoom(t, service, viewer)
	}
	send(t, service, newConn("host-1", "r1"), `{"t":"share.start","roomId":"r1"}`)
	session := service.Session("r1")
	readyViewer(t, service, session, "viewer-1")
	readyViewer(t, service, session, "viewer-2")
	readyViewer(t, service, session, "viewer-3")

	if treeRoute(t, session, "viewer-3").ParentPeerID != "viewer-1" {
		t.Fatalf("前置条件不成立：viewer-3 应挂在 viewer-1 上，实际 %q",
			treeRoute(t, session, "viewer-3").ParentPeerID)
	}
	before := treeRoute(t, session, "viewer-3").ConnectionID

	service.Detach("viewer-1")

	if hasRoute(session, "viewer-1") {
		t.Fatal("离开的观众不该还留着上游边")
	}
	route := treeRoute(t, session, "viewer-3")
	if route.ParentPeerID == "viewer-1" {
		t.Fatal("viewer-3 仍挂在已离开的 viewer-1 上")
	}
	if route.ConnectionID == before {
		t.Fatal("重挂必须换新的 connectionId")
	}
	// 重挂之后要能真的连上，而不是停在 prepare。
	readyViewer(t, service, session, "viewer-3")
	if treeRoute(t, session, "viewer-3").Phase != PhaseActive {
		t.Fatal("重挂后的边应能提交")
	}
}

// 信令只允许在边的两端之间流动：上游发 offer，下游发 answer。
func TestTreeSignalOnlyBetweenEdgeEnds(t *testing.T) {
	service, hub, _ := newTreeService(TreePolicy{HostChildren: 1, ViewerChildren: 2, MaxDepth: 2})
	joinRoom(t, service, "host-1")
	for _, viewer := range []string{"viewer-1", "viewer-2", "viewer-3"} {
		joinRoom(t, service, viewer)
	}
	send(t, service, newConn("host-1", "r1"), `{"t":"share.start","roomId":"r1"}`)
	session := service.Session("r1")
	readyViewer(t, service, session, "viewer-1")
	readyViewer(t, service, session, "viewer-2")

	connectionID := treeRoute(t, session, "viewer-2").ConnectionID
	offer := `{"t":"share.signal","roomId":"r1","connectionId":"` + connectionID +
		`","kind":"offer","payload":{"type":"offer","sdp":"v=0"}}`

	// 上游（viewer-1）发 offer → 转给下游（viewer-2）。
	before := len(hub.to)
	send(t, service, newConn("viewer-1", "r1"), offer)
	if len(hub.to) != before+1 {
		t.Fatalf("上游的 offer 应被转发一次，实际 %d 条", len(hub.to)-before)
	}
	if hub.to[len(hub.to)-1].Target != "viewer-2" {
		t.Fatalf("offer 应转给下游，实际 %q", hub.to[len(hub.to)-1].Target)
	}

	// 下游发 offer → 拒。
	before = len(hub.to)
	send(t, service, newConn("viewer-2", "r1"), offer)
	if len(hub.to) != before {
		t.Fatal("下游发 offer 必须被拒")
	}

	// 无关的第三方拿这条 connectionId 发信令 → 拒。
	before = len(hub.to)
	send(t, service, newConn("viewer-3", "r1"), offer)
	if len(hub.to) != before {
		t.Fatal("第三方不能借用这条边")
	}
}

// 候选卡住不回报时，定时器要把调度推进到下一位。
func TestCandidateTimeoutAdvancesTheQueue(t *testing.T) {
	service, hub, timers := newTreeService(DefaultTreePolicy())
	joinRoom(t, service, "host-1")
	for _, viewer := range []string{"viewer-1", "viewer-2"} {
		joinRoom(t, service, viewer)
	}
	send(t, service, newConn("host-1", "r1"), `{"t":"share.start","roomId":"r1"}`)
	session := service.Session("r1")

	if !hasRoute(session, "viewer-1") || hasRoute(session, "viewer-2") {
		t.Fatal("前置条件不成立：应只有 viewer-1 有候选")
	}
	before := len(routeFramesTo(hub, "viewer-2"))

	timers.Fire()

	if len(routeFramesTo(hub, "viewer-2")) == before {
		t.Fatal("超时后应把候选推进给 viewer-2")
	}
	if !hasRoute(session, "viewer-2") {
		t.Fatal("viewer-2 应拿到新的上游边")
	}
}

// 中继模式下候选不带 P2P 上游，房主也不会收到候选（它只有一条上行）。
func TestTreeRelayCandidateHasNoParent(t *testing.T) {
	session := newSession("r1")
	session.SetRelay(true)
	session.Join("host-1", "host", true)
	session.Join("viewer-1", "viewer", false)
	if _, err := session.Start(nil, false, nil); err != nil {
		t.Fatalf("start 失败: %v", err)
	}
	plans := session.PlanRoutes()
	if len(plans) == 0 {
		t.Fatal("中继模式应给观众发候选")
	}
	for _, plan := range plans {
		if plan.ToPeerID != "viewer-1" {
			t.Fatalf("中继模式下候选只应发给观众，实际发给 %q", plan.ToPeerID)
		}
		message, ok := plan.Message.(RouteMessage)
		if !ok || message.Candidate == nil {
			continue
		}
		if message.Candidate.ParentPeerID != "" {
			t.Fatalf("中继边不该有 P2P 上游，实际 %q", message.Candidate.ParentPeerID)
		}
	}
}

// 20 人的满房：按顺序铺满，房主直连不超过 3 条，最深的观众在第 3 层。
func TestTreeFillsRoomOfTwenty(t *testing.T) {
	service, _, _ := newTreeService(DefaultTreePolicy())
	joinRoom(t, service, "host-1")
	viewers := make([]string, 0, 20)
	for index := 1; index <= 20; index++ {
		viewer := fmt.Sprintf("viewer-%02d", index)
		viewers = append(viewers, viewer)
		joinRoom(t, service, viewer)
	}
	send(t, service, newConn("host-1", "r1"), `{"t":"share.start","roomId":"r1"}`)
	session := service.Session("r1")

	if attached := fillTree(t, service, session); attached != 20 {
		t.Fatalf("20 位观众应全部挂上，实际 %d", attached)
	}

	session.mu.Lock()
	parents := make(map[string]string, len(session.routes))
	for child, route := range session.routes {
		parents[child] = route.ParentPeerID
		if route.Phase != PhaseActive {
			session.mu.Unlock()
			t.Fatalf("%s 仍停在 %q", child, route.Phase)
		}
	}
	session.mu.Unlock()

	children := map[string]int{}
	for child, parent := range parents {
		if child == parent {
			t.Fatalf("%s 把自己当上游", child)
		}
		children[parent]++
	}
	if children["host-1"] > 3 {
		t.Fatalf("房主直连 %d 条，超过 HostChildren=3", children["host-1"])
	}
	for peerID, count := range children {
		if peerID != "host-1" && count > 2 {
			t.Fatalf("%s 带了 %d 个下游，超过 ViewerChildren=2", peerID, count)
		}
	}
	for child := range parents {
		depth, hops := child, 0
		for depth != "host-1" {
			depth = parents[depth]
			hops++
			if hops > 3 {
				t.Fatalf("%s 超过 MaxDepth=3", child)
			}
		}
	}
}
