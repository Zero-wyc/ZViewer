// Package piikroute 用 Piik 的 route 控制器做 ZViewer 房间的选路决定。
//
// 这是 S2 的引擎层：只负责「谁挂谁」，不碰协议、不碰媒体。ZViewer 的
// share.Session 仍是边的唯一记账方（connectionId、revision、下发计划），
// 这里只回答两个问题——下一条边该给谁、它该挂到哪个上游。
//
// 与上游的接线方式完全按 route 包的契约来：调用方持锁、传 nowMs、按顺序
// 释放返回的 Resource。本层没有 Resource（只做直连），所以 Released 一律为空。
package piikroute

import (
	"crypto/rand"
	"encoding/base64"
	"time"

	"zviewer/backend/internal/piik/server/protocol"
	"zviewer/backend/internal/piik/server/route"
)

// connectionIDPrefix 必须与 share 包一致：客户端只把它当不透明字符串，
// 但两端日志与排查都按这个前缀认边。
const connectionIDPrefix = "route_"

// Policy 是树形上限，语义与 share.TreePolicy 相同。
type Policy struct {
	// HostChildren 是房主最多直连几个观众；0 表示不设上限。
	HostChildren int
	// ViewerChildren 是一位观众最多转发给几个下游；0 表示观众不当父节点。
	ViewerChildren int
	// MaxDepth 是树的最大深度（房主 = 0）。
	MaxDepth int
}

// unlimitedCapacity 是「0 表示不限」在控制器里的表达。
// 控制器按 `slots <= capacity` 判定，没有「无限」这个值，取一个远超单房间
// 人数上限的数即可（协议单房间上限 20）。
const unlimitedCapacity = 64

// Edge 是一条待下发的边，字段与 share.RoutePlan 的候选一致。
type Edge struct {
	ChildPeerID  string
	ParentPeerID string
	ConnectionID string
	Revision     int64
}

// Engine 是一个房间的选路状态机。
type Engine struct {
	ctrl   *route.Controller
	host   string
	policy Policy
	// now 供测试注入；生产取墙钟毫秒。
	now func() int64
}

// New 构造一个房间的引擎。hostPeerID 必须与之后 Upsert 的房主一致。
func New(hostPeerID string, policy Policy) *Engine {
	return &Engine{
		host:   hostPeerID,
		policy: policy,
		now:    func() int64 { return time.Now().UnixMilli() },
		ctrl: route.New(route.Options{
			HostPeerID:                hostPeerID,
			EndpointMediaCopyCapacity: protocol.DefaultEndpointMediaCopyCapacity,
			OperationTimeoutMs:        10_000,
			// 直连模式：不要 SFU 候选，也不要质量/根收敛这些需要真实媒体
			// 度量才能成立的后台操作。
			SfuEnabled:                false,
			SfuOnly:                   false,
			QualityConvergenceEnabled: false,
			NatPredictionEnabled:      false,
		}),
	}
}

// Upsert 登记/更新一位参与者。ready 表示「已经解出首帧」——在 ZViewer 里
// 那就是它可以当上游的唯一条件，在这里用「下游容量」表达：没出首帧时
// 容量为 0，控制器自然会把它排除在候选之外。
func (e *Engine) Upsert(peerID, role string, ready bool) {
	capacity := 0
	if role == protocol.RoleHost {
		capacity = e.hostCapacity()
	} else if ready {
		capacity = e.viewerCapacity()
	}
	now := e.now()
	e.ctrl.UpsertParticipant(route.ParticipantInput{
		PeerID:                      peerID,
		Role:                        role,
		SessionID:                   peerID,
		EffectiveDownstreamCapacity: capacity,
	}, &now)
}

// Depart 处理一位参与者离开：先断开会话，再确认离开（控制器据此拆边并重挂）。
func (e *Engine) Depart(peerID string) {
	now := e.now()
	e.ctrl.DisconnectSession(peerID, peerID)
	e.ctrl.ConfirmDeparture(peerID, &now)
}

// Next 推进一轮调度：返回本轮开始准备的边（没有则 nil）。
//
// 控制器一次只允许一个在途操作，所以每次最多返回一条边——这是与 ZViewer
// 原实现最大的行为差别（原实现一次把缺的边全发出去）。
func (e *Engine) Next() *Edge {
	now := e.now()
	result := e.ctrl.Reconcile(now)
	operation := result.Operation
	if operation == nil {
		return nil
	}
	if operation.Current != nil {
		// 已经有一条候选在途：幂等重发，别再 begin 一次。
		return edgeOf(operation)
	}
	begin := e.ctrl.BeginCurrentCandidate(route.BeginInput{
		Guard:        guardOf(operation),
		NowMs:        now,
		ConnectionID: newConnectionID(),
		Reservation:  route.CandidateReservation{Kind: route.ReservationDirect},
	})
	if !begin.Accepted || begin.Operation == nil || begin.Operation.Current == nil {
		return nil
	}
	return edgeOf(begin.Operation)
}

// Commit 提交一条边（观众已解出首帧）。
func (e *Engine) Commit(edge Edge) {
	now := e.now()
	e.ctrl.CandidateReady(route.CandidateGuard{
		ChildPeerID:    edge.ChildPeerID,
		ChildSessionID: edge.ChildPeerID,
		Revision:       edge.Revision,
		ConnectionID:   edge.ConnectionID,
	}, now, func(route.CandidateReservation) bool { return true }, route.CandidateProof{})
	// 提交之后这位观众就具备当上游的资格了。
	e.Upsert(edge.ChildPeerID, protocol.RoleViewer, true)
}

// Fail 上报一条边失败。返回 true 表示这位观众已经没有可用上游
// （重试次数用尽），调用方据此下发 route-exhausted。
func (e *Engine) Fail(edge Edge) bool {
	now := e.now()
	result := e.ctrl.CandidateFailed(route.CandidateGuard{
		ChildPeerID:    edge.ChildPeerID,
		ChildSessionID: edge.ChildPeerID,
		Revision:       edge.Revision,
		ConnectionID:   edge.ConnectionID,
	}, now)
	for _, peerID := range result.FailedPeerIDs {
		if peerID == edge.ChildPeerID {
			// 没有上游了：它自己也不再是合法上游。
			e.Upsert(edge.ChildPeerID, protocol.RoleViewer, false)
			return true
		}
	}
	return false
}

// Revision 返回控制器当前的路由版本。
func (e *Engine) Revision() int64 { return e.ctrl.Revision() }

// Assigned 返回已提交的边（child → parent），用于与 share.Session 对账。
func (e *Engine) Assigned() map[string]string {
	snapshot := e.ctrl.Snapshot()
	assigned := make(map[string]string, snapshot.UpstreamByViewer.Len())
	for _, childPeerID := range snapshot.UpstreamByViewer.Keys() {
		edge, _ := snapshot.UpstreamByViewer.Get(childPeerID)
		if edge.Kind != route.UpstreamPeer || !edge.Usable || !edge.PhysicalActive {
			continue
		}
		assigned[childPeerID] = edge.ParentPeerID
	}
	return assigned
}

func (e *Engine) hostCapacity() int {
	if e.policy.HostChildren > 0 {
		return e.policy.HostChildren
	}
	return unlimitedCapacity
}

func (e *Engine) viewerCapacity() int {
	if e.policy.ViewerChildren <= 0 || e.policy.MaxDepth <= 1 {
		return 0
	}
	return e.policy.ViewerChildren
}

func edgeOf(operation *route.OperationSnapshot) *Edge {
	if operation == nil || operation.Current == nil {
		return nil
	}
	current := operation.Current
	return &Edge{
		ChildPeerID:  operation.ChildPeerID,
		ParentPeerID: current.Tuple.ParentPeerID,
		ConnectionID: current.ConnectionID,
		Revision:     current.Revision,
	}
}

func guardOf(operation *route.OperationSnapshot) route.CandidateCursorGuard {
	var plan route.CandidatePlan
	if operation.Cursor >= 0 && operation.Cursor < len(operation.Candidates) {
		plan = operation.Candidates[operation.Cursor]
	}
	return route.CandidateCursorGuard{
		ChildPeerID:    operation.ChildPeerID,
		ChildSessionID: operation.ChildSessionID,
		BaseRevision:   operation.BaseRevision,
		FactVersion:    operation.FactVersion,
		Cursor:         operation.Cursor,
		Plan:           plan,
	}
}

func newConnectionID() string {
	var buffer [16]byte
	if _, err := rand.Read(buffer[:]); err != nil {
		return connectionIDPrefix + time.Now().Format("150405.000000")
	}
	return connectionIDPrefix + base64.RawURLEncoding.EncodeToString(buffer[:])
}
