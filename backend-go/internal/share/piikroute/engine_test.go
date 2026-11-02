package piikroute

import (
	"fmt"
	"testing"

	"zviewer/backend/internal/piik/server/protocol"
)

// drain 反复 Next 并立刻提交，直到没有新边为止。
//
// 控制器一次只允许一个在途操作，所以「全部准备好」只能靠循环推进；真实
// 链路里每次推进都等客户端回报 route-ready，这里为了看清形状直接提交。
func drain(t *testing.T, engine *Engine) []Edge {
	t.Helper()
	var edges []Edge
	for range 64 {
		edge := engine.Next()
		if edge == nil {
			return edges
		}
		edges = append(edges, *edge)
		engine.Commit(*edge)
	}
	t.Fatal("调度没有收敛：64 轮仍在产生新边")
	return nil
}

// join 让 n 位观众进房（都还没出首帧）。
func join(engine *Engine, n int) {
	for i := 1; i <= n; i++ {
		engine.Upsert(fmt.Sprintf("viewer-%02d", i), protocol.RoleViewer, false)
	}
}

// 单层星形（观众不能当父节点）时，房主的直连数被端点拷贝预算卡死。
//
// 这是 Piik 与 ZViewer 原实现最本质的差别：它的 `EndpointMediaCopyCapacity`
// 上限是 3（协议常量），超出的观众不会「先挂上再说」，而是等观众互助或 SFU。
// ZViewer 的 `HostChildren=0`（不限）在 Piik 里表达不出来。
func TestStarIsCappedByEndpointCopyBudget(t *testing.T) {
	engine := New("host-1", Policy{MaxDepth: 1})
	engine.Upsert("host-1", protocol.RoleHost, true)
	join(engine, 20)

	edges := drain(t, engine)
	// 控制器默认端点拷贝预算为 2（protocol.DefaultEndpointMediaCopyCapacity）。
	if len(edges) != protocol.DefaultEndpointMediaCopyCapacity {
		t.Fatalf("单层星形只应挂上 %d 位观众，实际 %d", protocol.DefaultEndpointMediaCopyCapacity, len(edges))
	}
	for _, edge := range edges {
		if edge.ParentPeerID != "host-1" {
			t.Fatalf("%s 应挂在房主上，实际 %q", edge.ChildPeerID, edge.ParentPeerID)
		}
	}
}

// 打开观众互助后，20 人的房间能全部挂上，且没人挂自己。
func TestTreeCoversFullRoom(t *testing.T) {
	engine := New("host-1", Policy{HostChildren: 3, ViewerChildren: 3, MaxDepth: 4})
	engine.Upsert("host-1", protocol.RoleHost, true)
	join(engine, 20)
	drain(t, engine)

	assigned := engine.Assigned()
	if len(assigned) != 20 {
		t.Fatalf("20 位观众应全部有上游，实际 %d：%v", len(assigned), assigned)
	}
	for child, parent := range assigned {
		if child == parent {
			t.Fatalf("%s 把自己当上游", child)
		}
	}
	// 房主的直连数同样受端点拷贝预算约束。
	children := 0
	for _, parent := range assigned {
		if parent == "host-1" {
			children++
		}
	}
	if children > protocol.DefaultEndpointMediaCopyCapacity {
		t.Fatalf("房主直连 %d 条，超过端点拷贝预算", children)
	}
}

// 没出首帧的观众不能当上游：它的容量是 0，控制器不会把它排进候选。
func TestViewerCannotParentBeforeFirstFrame(t *testing.T) {
	engine := New("host-1", Policy{HostChildren: 1, ViewerChildren: 2, MaxDepth: 2})
	engine.Upsert("host-1", protocol.RoleHost, true)
	join(engine, 3)

	// 只推进、不提交：第一位观众的边在途，后两位没有上游可用。
	first := engine.Next()
	if first == nil {
		t.Fatal("第一条边应该先给 viewer-01")
	}
	if first.ChildPeerID != "viewer-01" || first.ParentPeerID != "host-1" {
		t.Fatalf("首条边 = %+v", *first)
	}
	// 控制器串行：第一条没提交之前不会开始下一条，只会把同一条候选再发一次。
	again := engine.Next()
	if again == nil || again.ConnectionID != first.ConnectionID || again.ChildPeerID != first.ChildPeerID {
		t.Fatalf("在途时应重发同一条候选，实际 %+v", again)
	}
	// 提交后 viewer-01 才有资格当上游。
	engine.Commit(*first)
	second := engine.Next()
	if second == nil || second.ParentPeerID != "viewer-01" {
		t.Fatalf("第二条边应挂到 viewer-01，实际 %+v", second)
	}
}

// 观众离开：它的边作废，下游重挂（不能继续挂在一个已经走人的上游上）。
func TestDepartureReparentsSubtree(t *testing.T) {
	engine := New("host-1", Policy{HostChildren: 1, ViewerChildren: 3, MaxDepth: 3})
	engine.Upsert("host-1", protocol.RoleHost, true)
	join(engine, 4)
	drain(t, engine)

	assigned := engine.Assigned()
	dependents := 0
	for _, parent := range assigned {
		if parent == "viewer-01" {
			dependents++
		}
	}
	if dependents == 0 {
		t.Fatalf("前置条件不成立：应有人挂在 viewer-01 上，实际 %v", assigned)
	}

	engine.Depart("viewer-01")
	// 离开会推进版本并留下待办操作，逐轮推进直到收敛。
	for range 8 {
		edge := engine.Next()
		if edge == nil {
			break
		}
		engine.Commit(*edge)
	}
	after := engine.Assigned()
	if _, still := after["viewer-01"]; still {
		t.Fatalf("离开者的边应被移除：%v", after)
	}
	for child, parent := range after {
		if parent == "viewer-01" {
			t.Fatalf("%s 仍挂在已离开的 viewer-01 上", child)
		}
	}
}
