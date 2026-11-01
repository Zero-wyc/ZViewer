package share

import (
	"context"
	"testing"
)

// newTreeService 构造一个带树形上限的服务（房主固定是 host-1）。
func newTreeService(policy TreePolicy) (*Service, *fakeHub) {
	hub := &fakeHub{}
	service := NewService(Deps{
		Hub: hub,
		IsHost: func(_ context.Context, socketID, _ string) (bool, error) {
			return socketID == "host-1", nil
		},
		DisplayName: func(socketID string) string { return "名字:" + socketID },
	})
	service.tree = policy
	return service, hub
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

// commitRoute 帮某位观众提交一条边（等价于「已解出首帧」）。
//
// 直接读会话里的连接身份：树形下同一位观众还会收到「我当上游」的别人的候选，
// 用「最后一条发给它的 route」取身份会取错。
func commitRoute(t *testing.T, service *Service, session *Session, viewer string) {
	t.Helper()
	connectionID := treeRoute(t, session, viewer).ConnectionID
	send(t, service, newConn(viewer, "r1"),
		routeReadyFrame(int(session.Revision()), "prepare", connectionID))
}

// failOwnRoute 让某位观众上报「我这条边失败了」。
func failOwnRoute(t *testing.T, service *Service, session *Session, viewer string) {
	t.Helper()
	connectionID := treeRoute(t, session, viewer).ConnectionID
	send(t, service, newConn(viewer, "r1"),
		routeFailedFrame(int(session.Revision()), connectionID))
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

// 默认策略（ViewerChildren=0）必须与移植前的单层星形完全一致。
func TestTreeDegeneratesToStarWhenViewersCannotParent(t *testing.T) {
	service, hub := newTreeService(TreePolicy{MaxDepth: 1})
	joinRoom(t, service, "host-1")
	for _, viewer := range []string{"viewer-1", "viewer-2", "viewer-3"} {
		joinRoom(t, service, viewer)
	}
	send(t, service, newConn("host-1", "r1"), `{"t":"share.start","roomId":"r1"}`)

	session := service.Session("r1")
	for _, viewer := range []string{"viewer-1", "viewer-2", "viewer-3"} {
		if parent := treeRoute(t, session, viewer).ParentPeerID; parent != "host-1" {
			t.Fatalf("%s 的上游应是房主，实际 %q", viewer, parent)
		}
	}
	_ = hub
}

// 房主容量满了、并且有观众出了首帧 → 超额的边迁到那位观众身上。
func TestTreeSpillsOntoReadyViewer(t *testing.T) {
	service, hub := newTreeService(TreePolicy{HostChildren: 1, ViewerChildren: 2, MaxDepth: 2})
	joinRoom(t, service, "host-1")
	for _, viewer := range []string{"viewer-1", "viewer-2", "viewer-3"} {
		joinRoom(t, service, viewer)
	}
	send(t, service, newConn("host-1", "r1"), `{"t":"share.start","roomId":"r1"}`)

	session := service.Session("r1")
	// 开局时还没有任何人出首帧：全部先挂房主（宁可超额，不能让观众没画面）。
	for _, viewer := range []string{"viewer-1", "viewer-2", "viewer-3"} {
		if parent := treeRoute(t, session, viewer).ParentPeerID; parent != "host-1" {
			t.Fatalf("开局 %s 应先在房主上，实际 %q", viewer, parent)
		}
	}
	survivingID := treeRoute(t, session, "viewer-2").ConnectionID

	// viewer-1 出首帧 → 它成了合法上游，超额的边迁过去。
	commitRoute(t, service, session, "viewer-1")

	if parent := treeRoute(t, session, "viewer-1").ParentPeerID; parent != "host-1" {
		t.Fatalf("viewer-1 应留在房主上，实际 %q", parent)
	}
	for _, viewer := range []string{"viewer-2", "viewer-3"} {
		if parent := treeRoute(t, session, viewer).ParentPeerID; parent != "viewer-1" {
			t.Fatalf("%s 应迁到 viewer-1，实际 %q", viewer, parent)
		}
	}
	// 换上游必须换 connectionId：对端是另一条 PC。
	if treeRoute(t, session, "viewer-2").ConnectionID == survivingID {
		t.Fatal("迁移后必须换一个新的 connectionId")
	}
	// 迁过去的两条边必须是 prepare，且两端都收到了新候选。
	if phase := treeRoute(t, session, "viewer-2").Phase; phase != PhasePrepare {
		t.Fatalf("迁移后的边应重新 prepare，实际 %q", phase)
	}
	frames := routeFramesTo(hub, "viewer-1")
	if len(frames) == 0 {
		t.Fatal("viewer-1 作为新上游没有收到候选")
	}
}

// 深度到顶就不再往下挂：MaxDepth=1 时观众永远不能当父节点。
func TestTreeRespectsDepthLimit(t *testing.T) {
	service, _ := newTreeService(TreePolicy{HostChildren: 1, ViewerChildren: 2, MaxDepth: 1})
	joinRoom(t, service, "host-1")
	joinRoom(t, service, "viewer-1")
	joinRoom(t, service, "viewer-2")
	send(t, service, newConn("host-1", "r1"), `{"t":"share.start","roomId":"r1"}`)
	session := service.Session("r1")
	commitRoute(t, service, session, "viewer-1")

	if parent := treeRoute(t, session, "viewer-2").ParentPeerID; parent != "host-1" {
		t.Fatalf("MaxDepth=1 时 viewer-2 只能挂房主，实际 %q", parent)
	}
}

// 一位观众最多带 ViewerChildren 个下游，多出来的留在房主身上。
func TestTreeRespectsViewerCapacity(t *testing.T) {
	service, _ := newTreeService(TreePolicy{HostChildren: 1, ViewerChildren: 1, MaxDepth: 2})
	joinRoom(t, service, "host-1")
	for _, viewer := range []string{"viewer-1", "viewer-2", "viewer-3"} {
		joinRoom(t, service, viewer)
	}
	send(t, service, newConn("host-1", "r1"), `{"t":"share.start","roomId":"r1"}`)
	session := service.Session("r1")
	commitRoute(t, service, session, "viewer-1")

	children := map[string]int{}
	for _, viewer := range []string{"viewer-1", "viewer-2", "viewer-3"} {
		children[treeRoute(t, session, viewer).ParentPeerID]++
	}
	if children["viewer-1"] != 1 {
		t.Fatalf("viewer-1 只能带 1 个下游，实际 %d", children["viewer-1"])
	}
	if children["host-1"] != 2 {
		t.Fatalf("房主应留 2 条（超额容忍），实际 %d", children["host-1"])
	}
}

// 失败重试时换上游，但绝不能把自己的下游当上游（成环）。
func TestTreeNeverUsesOwnDescendantAsUpstream(t *testing.T) {
	service, _ := newTreeService(TreePolicy{HostChildren: 1, ViewerChildren: 2, MaxDepth: 3})
	joinRoom(t, service, "host-1")
	for _, viewer := range []string{"viewer-1", "viewer-2"} {
		joinRoom(t, service, viewer)
	}
	send(t, service, newConn("host-1", "r1"), `{"t":"share.start","roomId":"r1"}`)
	session := service.Session("r1")
	commitRoute(t, service, session, "viewer-1")

	if parent := treeRoute(t, session, "viewer-2").ParentPeerID; parent != "viewer-1" {
		t.Fatalf("前置条件不成立：viewer-2 应在 viewer-1 上，实际 %q", parent)
	}
	// viewer-1 的上游（房主）失败一次：可选上游只剩 viewer-2，而那是它的下游。
	failOwnRoute(t, service, session, "viewer-1")

	if parent := treeRoute(t, session, "viewer-1").ParentPeerID; parent != "host-1" {
		t.Fatalf("不能把下游当上游：viewer-1 应留在房主上，实际 %q", parent)
	}
	if parent := treeRoute(t, session, "viewer-2").ParentPeerID; parent != "viewer-1" {
		t.Fatalf("viewer-2 的上游不该被动过，实际 %q", parent)
	}
}

// 父节点离开：整棵子树拆掉重挂（否则下游会停在最后一张画面上）。
func TestTreeReparentsSubtreeWhenParentLeaves(t *testing.T) {
	service, _ := newTreeService(TreePolicy{HostChildren: 1, ViewerChildren: 2, MaxDepth: 2})
	joinRoom(t, service, "host-1")
	for _, viewer := range []string{"viewer-1", "viewer-2", "viewer-3"} {
		joinRoom(t, service, viewer)
	}
	send(t, service, newConn("host-1", "r1"), `{"t":"share.start","roomId":"r1"}`)
	session := service.Session("r1")
	commitRoute(t, service, session, "viewer-1")

	before := treeRoute(t, session, "viewer-2").ConnectionID
	if treeRoute(t, session, "viewer-2").ParentPeerID != "viewer-1" {
		t.Fatal("前置条件不成立：viewer-2 应挂在 viewer-1 上")
	}

	service.Detach("viewer-1")

	if hasRoute(session, "viewer-1") {
		t.Fatal("离开的观众不该还留着上游边")
	}
	for _, viewer := range []string{"viewer-2", "viewer-3"} {
		route := treeRoute(t, session, viewer)
		if route.ParentPeerID != "host-1" {
			t.Fatalf("%s 应重挂到房主，实际 %q", viewer, route.ParentPeerID)
		}
	}
	if treeRoute(t, session, "viewer-2").ConnectionID == before {
		t.Fatal("重挂必须换新的 connectionId")
	}
}

// 上游彻底失败（次数用完）：它自己下线，下游整棵子树重挂。
func TestTreeRehangsSubtreeWhenUpstreamExhausted(t *testing.T) {
	service, _ := newTreeService(TreePolicy{HostChildren: 1, ViewerChildren: 2, MaxDepth: 2})
	joinRoom(t, service, "host-1")
	for _, viewer := range []string{"viewer-1", "viewer-2"} {
		joinRoom(t, service, viewer)
	}
	send(t, service, newConn("host-1", "r1"), `{"t":"share.start","roomId":"r1"}`)
	session := service.Session("r1")
	commitRoute(t, service, session, "viewer-1")

	if treeRoute(t, session, "viewer-2").ParentPeerID != "viewer-1" {
		t.Fatal("前置条件不成立：viewer-2 应挂在 viewer-1 上")
	}

	for attempt := 0; attempt < MaxRouteAttempts; attempt += 1 {
		failOwnRoute(t, service, session, "viewer-1")
	}

	if hasRoute(session, "viewer-1") {
		t.Fatal("次数用完后 viewer-1 的边应被移除")
	}
	if parent := treeRoute(t, session, "viewer-2").ParentPeerID; parent != "host-1" {
		t.Fatalf("viewer-2 应重挂到房主，实际 %q", parent)
	}
}

// 信令只允许在边的两端之间流动：上游发 offer，下游发 answer。
func TestTreeSignalOnlyBetweenEdgeEnds(t *testing.T) {
	service, hub := newTreeService(TreePolicy{HostChildren: 1, ViewerChildren: 2, MaxDepth: 2})
	joinRoom(t, service, "host-1")
	for _, viewer := range []string{"viewer-1", "viewer-2", "viewer-3"} {
		joinRoom(t, service, viewer)
	}
	send(t, service, newConn("host-1", "r1"), `{"t":"share.start","roomId":"r1"}`)
	session := service.Session("r1")
	commitRoute(t, service, session, "viewer-1")

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

	// 下游发 offer → 拒（answer 只能由下游发，offer 只能由上游发）。
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
	for _, plan := range plans {
		if plan.ToPeerID != "viewer-1" {
			t.Fatalf("中继模式下候选只应发给观众，实际发给 %q", plan.ToPeerID)
		}
		if plan.Message.Candidate == nil {
			continue
		}
		if plan.Message.Candidate.ParentPeerID != "" {
			t.Fatalf("中继边不该有 P2P 上游，实际 %q", plan.Message.Candidate.ParentPeerID)
		}
	}
}
