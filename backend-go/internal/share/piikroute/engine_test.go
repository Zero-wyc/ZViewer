package piikroute

import (
	"fmt"
	"testing"

	"zviewer/backend/internal/piik/server/protocol"
)

// newTestEngine 构造一个房主已就位的引擎，时钟可控。
func newTestEngine(t *testing.T, policy Policy) (*Engine, *int64) {
	t.Helper()
	clock := int64(1_000_000)
	engine := New("host-1", policy)
	engine.SetClock(func() int64 { return clock })
	engine.Join("host-1", string(protocol.RoleHost), true)
	return engine, &clock
}

// join 让 n 位观众进房（都还没出首帧）。
func join(engine *Engine, from, to int) {
	for index := from; index <= to; index++ {
		engine.Join(fmt.Sprintf("viewer-%02d", index), string(protocol.RoleViewer), false)
	}
}

// drain 反复推进并立刻提交，直到没有新边为止。
//
// 真实链路里每推进一条都要等客户端回报 route-ready；这里为了看清树的形状
// 直接提交，等价于「每个人都秒连上」。
func drain(t *testing.T, engine *Engine) []Edge {
	t.Helper()
	var edges []Edge
	for range 128 {
		advance := engine.Advance()
		if advance.Edge == nil {
			return edges
		}
		edges = append(edges, *advance.Edge)
		if !engine.Commit(advance.Edge.ConnectionID) {
			t.Fatalf("提交被拒: %+v", *advance.Edge)
		}
	}
	t.Fatal("调度没有收敛：128 轮仍在产生新边")
	return nil
}

// 控制器一次只开一条候选：第二个人要等第一个人结算完。
func TestAdmissionIsSerial(t *testing.T) {
	engine, _ := newTestEngine(t, DefaultPolicy())
	join(engine, 1, 3)

	first := engine.Advance()
	if first.Edge == nil || first.Edge.ChildPeerID != "viewer-01" {
		t.Fatalf("第一条候选应给 viewer-01，实际 %+v", first.Edge)
	}
	if next := engine.Advance(); next.Edge != nil {
		t.Fatalf("未结算时不应再开新候选，实际 %+v", next.Edge)
	}
	if !engine.Commit(first.Edge.ConnectionID) {
		t.Fatal("提交第一条候选失败")
	}
	second := engine.Advance()
	if second.Edge == nil || second.Edge.ChildPeerID != "viewer-02" {
		t.Fatalf("结算后应轮到 viewer-02，实际 %+v", second.Edge)
	}
}

// 20 位观众全部挂上，房主直连不超过 3 条，深度不超过 3 层。
func TestTreeCoversRoomOfTwenty(t *testing.T) {
	engine, _ := newTestEngine(t, DefaultPolicy())
	join(engine, 1, 20)

	if edges := drain(t, engine); len(edges) != 20 {
		t.Fatalf("应为 20 位观众各开一条边，实际 %d", len(edges))
	}

	parents := map[string]string{}
	for _, edge := range engine.Edges() {
		parents[edge.ChildPeerID] = edge.ParentPeerID
	}
	if len(parents) != 20 {
		t.Fatalf("20 位观众应全部有上游，实际 %d", len(parents))
	}
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
	// 深度：任何一位观众往上数都不该超过 3 跳。
	for child := range parents {
		depth, hops := child, 0
		for depth != "host-1" {
			next, ok := parents[depth]
			if !ok || hops > 8 {
				t.Fatalf("%s 的上游链断裂：%v", child, parents)
			}
			depth = next
			hops++
		}
		if hops > 3 {
			t.Fatalf("%s 在第 %d 层，超过 MaxDepth=3", child, hops)
		}
	}
}

// 深度到顶的观众不再收下游：容量被压到 0。
func TestDepthLimitStopsGrowth(t *testing.T) {
	policy := Policy{HostChildren: 1, ViewerChildren: 2, MaxDepth: 2}
	engine, _ := newTestEngine(t, policy)
	join(engine, 1, 8)
	drain(t, engine)

	parents := map[string]string{}
	for _, edge := range engine.Edges() {
		parents[edge.ChildPeerID] = edge.ParentPeerID
	}
	// MaxDepth=2 只有两层：房主带 1 位，那位再带 2 位，容量到顶。
	if len(parents) != 3 {
		t.Fatalf("MaxDepth=2 时最多挂 3 位，实际 %d：%v", len(parents), parents)
	}
	for child := range parents {
		depth, hops := child, 0
		for depth != "host-1" {
			next, ok := parents[depth]
			if !ok || hops > 4 {
				t.Fatalf("%s 的上游链断裂：%v", child, parents)
			}
			depth = next
			hops++
		}
		if hops > 2 {
			t.Fatalf("%s 在第 %d 层，超过 MaxDepth=2", child, hops)
		}
	}
}

// 父节点离开：它下游的人重新挂到别处，不会继续指向已经走人的上游。
func TestLeaveReparentsSubtree(t *testing.T) {
	policy := Policy{HostChildren: 1, ViewerChildren: 2, MaxDepth: 3}
	engine, _ := newTestEngine(t, policy)
	join(engine, 1, 5)
	drain(t, engine)

	before := map[string]string{}
	for _, edge := range engine.Edges() {
		before[edge.ChildPeerID] = edge.ParentPeerID
	}
	dependents := []string{}
	for child, parent := range before {
		if parent == "viewer-01" {
			dependents = append(dependents, child)
		}
	}
	if len(dependents) == 0 {
		t.Fatalf("前置条件不成立：应有人挂在 viewer-01 上，实际 %v", before)
	}

	engine.Leave("viewer-01")
	drain(t, engine)

	after := map[string]string{}
	for _, edge := range engine.Edges() {
		after[edge.ChildPeerID] = edge.ParentPeerID
	}
	if _, still := after["viewer-01"]; still {
		t.Fatalf("离开者的边应被移除：%v", after)
	}
	for _, child := range dependents {
		parent, ok := after[child]
		if !ok {
			continue // 暂时没有上游，等下一轮；不算挂错
		}
		if parent == "viewer-01" {
			t.Fatalf("%s 仍挂在已离开的 viewer-01 上", child)
		}
	}
}

// 没有任何可用上游时把观众报成失败，而不是无限等。
func TestNoUpstreamReportsFailed(t *testing.T) {
	// 树只有两个位置：房主 1 条、第二层 1 条，第三位观众无处可挂。
	engine, _ := newTestEngine(t, Policy{HostChildren: 1, ViewerChildren: 1, MaxDepth: 2})
	join(engine, 1, 3)

	edges := 0
	var failed []string
	for range 16 {
		advance := engine.Advance()
		failed = append(failed, advance.Failed...)
		if advance.Edge == nil {
			break
		}
		edges++
		engine.Commit(advance.Edge.ConnectionID)
	}
	if edges != 2 {
		t.Fatalf("树只能挂 2 位，实际开了 %d 条边", edges)
	}
	if len(failed) != 1 || failed[0] != "viewer-03" {
		t.Fatalf("应把 viewer-03 报成失败，实际 %v", failed)
	}
}

// 候选卡住时，超时后必须被推进：否则一条不回报的连接会冻住整屋的串行铺路。
func TestDeadlineReleasesStuckCandidate(t *testing.T) {
	engine, clock := newTestEngine(t, DefaultPolicy())
	join(engine, 1, 2)

	first := engine.Advance()
	if first.Edge == nil {
		t.Fatal("第一条候选应该先发出去")
	}
	if _, ok := engine.WakeAt(); !ok {
		t.Fatal("在途候选必须带一个唤醒时刻")
	}
	// 不发 route-ready，直接把时钟推过操作超时。
	*clock += operationTimeoutMs + 1

	advance := engine.Advance()
	if advance.Edge == nil {
		t.Fatalf("超时后应换一条候选，实际 %+v", advance)
	}
	if advance.Edge.ChildPeerID != "viewer-02" {
		t.Fatalf("超时后应轮到 viewer-02，实际 %+v", *advance.Edge)
	}
}
