// Package piikroute 用 Piik 的 route 控制器做 ZViewer 房间的选路决定。
//
// 这是 S2 的引擎层：只负责「谁挂谁、什么时候挂」，不碰协议、不碰媒体。
// 边的记录（connectionId、下发计划、信令路由）仍在 share.Session 里，
// 本层只回答两个问题——下一条边给谁、它挂到哪个上游。
//
// 与上游的接线方式完全按 route 包的契约来：调用方持锁、传 nowMs、按顺序
// 释放返回的 Resource。本层只做直连，没有 Resource，所以都不释放。
package piikroute

import (
	"crypto/rand"
	"encoding/base64"
	"slices"
	"time"

	"zviewer/backend/internal/piik/server/protocol"
	"zviewer/backend/internal/piik/server/route"
)

// ConnectionIDPrefix 是服务端铸造的连接身份前缀，与 Piik 一致。
// 客户端只把它当不透明字符串，但两端日志与排查都按这个前缀认边。
const ConnectionIDPrefix = "route_"

const connectionIDPrefix = ConnectionIDPrefix

// Policy 是树形上限，语义与 share.TreePolicy 相同。
type Policy struct {
	// HostChildren 是房主最多直连几个观众；0 表示不设上限。
	HostChildren int
	// ViewerChildren 是一位观众最多转发给几个下游；0 表示观众不当父节点。
	ViewerChildren int
	// MaxDepth 是树的最大深度（房主 = 0）。
	MaxDepth int
}

// DefaultPolicy 是 ZViewer 的默认树形参数。
//
// 20 位观众时的容量：房主 3 + 第二层 6 + 第三层 12 = 21，刚好覆盖协议的
// 单房间上限。第三层不再往下带人，靠 MaxDepth 把容量压到 0 实现。
func DefaultPolicy() Policy {
	return Policy{HostChildren: 3, ViewerChildren: 2, MaxDepth: 3}
}

// Edge 是一条待下发的边，字段与 share.RoutePlan 的候选一致。
type Edge struct {
	ChildPeerID  string
	ParentPeerID string
	ConnectionID string
	// Revision 是控制器铸造这条边时的版本，结算时必须原样带回。
	Revision int64
}

// Advance 是一次调度的结果。
type Advance struct {
	// Edge 是本轮新开的候选；nil 表示没有新边（在途、或在等上游）。
	Edge *Edge
	// Failed 是控制器判定「已经没有可用上游」的观众。
	Failed []string
}

// member 是引擎记的一位参与者。控制器自己也知道角色，但容量要按这里的
// ready/深度重算，所以本层必须自己留一份。
type member struct {
	role     protocol.Role
	ready    bool
	capacity int
}

// Engine 是一个房间的选路状态机。
type Engine struct {
	ctrl   *route.Controller
	host   string
	policy Policy
	// now 供测试注入；生产取墙钟毫秒。
	now func() int64

	members map[string]*member
	// attempts 记住每条在途候选的结算凭据（观众 + 控制器版本）。
	attempts map[string]attempt
}

type attempt struct {
	child    string
	revision int64
}

// New 构造一个房间的引擎。hostPeerID 必须与之后 Join 的房主一致。
func New(hostPeerID string, policy Policy) *Engine {
	if policy.MaxDepth <= 0 {
		policy.MaxDepth = 1
	}
	return &Engine{
		host:     hostPeerID,
		policy:   policy,
		members:  make(map[string]*member),
		attempts: make(map[string]attempt),
		now:      func() int64 { return time.Now().UnixMilli() },
		ctrl: route.New(route.Options{
			HostPeerID: hostPeerID,
			// 端点拷贝预算是硬上限（协议最大 3）：房主的 HostChildren 再大
			// 也会被它 clamp，所以这里取协议上限，让策略参数说了算。
			EndpointMediaCopyCapacity: protocol.MaxEndpointMediaCopyCapacity,
			OperationTimeoutMs:        operationTimeoutMs,
			// 直连模式：不要 SFU 候选，也不要质量/根收敛这些需要真实媒体
			// 度量才能成立的后台操作。
			SfuEnabled:                false,
			SfuOnly:                   false,
			QualityConvergenceEnabled: false,
			NatPredictionEnabled:      false,
		}),
	}
}

// operationTimeoutMs 是一条候选的存活时间。
//
// 控制器只记 deadline，不会自己跑；本层的 WakeAt 把它交给上层定时器。
// 取 15s 与客户端 `VIEWER_INITIAL_CONNECTION_TIMEOUT_MS` 对齐：两边对
// 「这次建连已经死了」的判断必须一致，否则服务端会在客户端还相信这条边
// 的时候把它换掉。串行铺路下这是最坏情况的排队延迟。
const operationTimeoutMs = 15_000

// SetClock 注入时钟（测试用）。
func (e *Engine) SetClock(now func() int64) {
	if now != nil {
		e.now = now
	}
}

// Join 登记或更新一位参与者。ready 表示「已经解出首帧」。
func (e *Engine) Join(peerID, role string, ready bool) {
	parsed := protocol.Role(role)
	current, ok := e.members[peerID]
	if ok && current.role != parsed {
		// 角色不能变：先按离开处理，再重新登记。
		e.Leave(peerID)
		current, ok = e.members[peerID]
	}
	if !ok {
		current = &member{role: parsed, capacity: -1}
		e.members[peerID] = current
	}
	current.ready = ready
	current.capacity = e.capacity(peerID, current, e.depths())
	now := e.now()
	e.ctrl.UpsertParticipant(e.input(peerID, current), &now)
}

// SetReady 更新某位观众「已出首帧」。首帧是它能当上游的唯一条件。
func (e *Engine) SetReady(peerID string, ready bool) {
	current, ok := e.members[peerID]
	if !ok || current.ready == ready {
		return
	}
	current.ready = ready
	current.capacity = e.capacity(peerID, current, e.depths())
	now := e.now()
	e.ctrl.UpsertParticipant(e.input(peerID, current), &now)
}

// Leave 处理一位参与者离开：先断会话，再确认离开（控制器据此拆边）。
func (e *Engine) Leave(peerID string) {
	delete(e.members, peerID)
	for connectionID, att := range e.attempts {
		if att.child == peerID {
			delete(e.attempts, connectionID)
		}
	}
	now := e.now()
	e.ctrl.DisconnectSession(peerID, peerID)
	e.ctrl.ConfirmDeparture(peerID, &now)
}

// Advance 推进一轮调度，最多开一条新候选。
//
// 控制器的调度是串行的：一条候选没结算之前不会再开下一条。所以「铺满整张
// 图」不是一次调用能做完的，要靠每次 route-ready / 超时再推进一轮。
func (e *Engine) Advance() Advance {
	now := e.now()
	failed := e.ctrl.OperationExpired(now).FailedPeerIDs
	e.refreshCapacities(now)

	result := e.ctrl.Reconcile(now)
	failed = append(failed, result.FailedPeerIDs...)
	if result.Operation == nil || result.Operation.Current != nil {
		e.pruneAttempts()
		return Advance{Failed: dedupe(failed)}
	}

	for range 4 {
		begin := e.ctrl.BeginCurrentCandidate(route.BeginInput{
			Guard:        guardOf(result.Operation),
			NowMs:        now,
			ConnectionID: newConnectionID(),
			Reservation:  route.CandidateReservation{Kind: route.ReservationDirect},
		})
		failed = append(failed, begin.FailedPeerIDs...)
		if begin.Accepted && begin.Operation != nil && begin.Operation.Current != nil {
			edge := edgeOf(begin.Operation)
			e.attempts[edge.ConnectionID] = attempt{child: edge.ChildPeerID, revision: edge.Revision}
			e.pruneAttempts()
			return Advance{Edge: edge, Failed: dedupe(failed)}
		}
		// 候选被拒（守卫过期或候选失效）：让控制器重选一次。
		next := e.ctrl.Reconcile(now)
		failed = append(failed, next.FailedPeerIDs...)
		if next.Operation == nil || next.Operation.Current != nil {
			break
		}
		result.Operation = next.Operation
	}
	e.pruneAttempts()
	return Advance{Failed: dedupe(failed)}
}

// Commit 提交一条候选（观众已解出首帧）。返回 false 表示守卫已失效。
func (e *Engine) Commit(connectionID string) bool {
	att, ok := e.attempts[connectionID]
	if !ok {
		return false
	}
	delete(e.attempts, connectionID)
	settled := e.ctrl.CandidateReady(
		route.CandidateGuard{
			ChildPeerID:    att.child,
			ChildSessionID: att.child,
			Revision:       att.revision,
			ConnectionID:   connectionID,
		},
		e.now(),
		func(route.CandidateReservation) bool { return true },
		route.CandidateProof{},
	)
	if !settled.Accepted || !settled.Committed {
		return false
	}
	// 提交之后这位观众就具备当上游的资格了。
	if current, ok := e.members[att.child]; ok {
		current.ready = true
	}
	return true
}

// Fail 结算一条失败的候选。返回 true 表示这位观众已经没有可用上游。
func (e *Engine) Fail(connectionID string) bool {
	att, ok := e.attempts[connectionID]
	if !ok {
		return false
	}
	delete(e.attempts, connectionID)
	settled := e.ctrl.CandidateFailed(route.CandidateGuard{
		ChildPeerID:    att.child,
		ChildSessionID: att.child,
		Revision:       att.revision,
		ConnectionID:   connectionID,
	}, e.now())
	for _, peerID := range settled.FailedPeerIDs {
		if peerID != att.child {
			continue
		}
		if current, ok := e.members[peerID]; ok {
			current.ready = false
		}
		return true
	}
	return false
}

// Edges 返回已提交且可用的边。
func (e *Engine) Edges() []Edge {
	snapshot := e.ctrl.Snapshot()
	edges := make([]Edge, 0, snapshot.UpstreamByViewer.Len())
	for _, childPeerID := range snapshot.UpstreamByViewer.Keys() {
		committed, _ := snapshot.UpstreamByViewer.Get(childPeerID)
		if committed.Kind != route.UpstreamPeer || !committed.Usable || !committed.PhysicalActive {
			continue
		}
		edges = append(edges, Edge{
			ChildPeerID:  childPeerID,
			ParentPeerID: committed.ParentPeerID,
			ConnectionID: committed.ConnectionID,
		})
	}
	return edges
}

// Pending 返回在途的那条候选。
func (e *Engine) Pending() (Edge, bool) {
	operation := e.ctrl.Operation()
	if operation == nil || operation.Current == nil {
		return Edge{}, false
	}
	return *edgeOf(operation), true
}

// WakeAt 返回控制器下一次需要被叫醒的时刻（毫秒）。false 表示不用定时。
func (e *Engine) WakeAt() (int64, bool) {
	operation := e.ctrl.Operation()
	if operation == nil {
		return 0, false
	}
	wakeAt := operation.WakeAtMs
	if wakeAt <= 0 {
		wakeAt = operation.DeadlineAtMs
	}
	if wakeAt <= 0 {
		return 0, false
	}
	return wakeAt, true
}

// Revision 返回控制器当前的路由版本（诊断用）。
func (e *Engine) Revision() int64 { return e.ctrl.Revision() }

// depths 返回每位参与者到房主的跳数（房主 = 0）。只认已提交的边。
func (e *Engine) depths() map[string]int {
	parents := make(map[string]string)
	snapshot := e.ctrl.Snapshot()
	for _, childPeerID := range snapshot.UpstreamByViewer.Keys() {
		committed, _ := snapshot.UpstreamByViewer.Get(childPeerID)
		if committed.Kind == route.UpstreamPeer && committed.Usable && committed.PhysicalActive {
			parents[childPeerID] = committed.ParentPeerID
		}
	}
	depths := map[string]int{e.host: 0}
	for childPeerID := range parents {
		if depth, ok := walkDepth(childPeerID, parents, depths); ok {
			depths[childPeerID] = depth
		}
	}
	return depths
}

// walkDepth 沿着已提交的边往上数到房主；成环或断链返回 false。
func walkDepth(peerID string, parents map[string]string, known map[string]int) (int, bool) {
	if depth, ok := known[peerID]; ok {
		return depth, true
	}
	trail := []string{peerID}
	current := peerID
	for range 64 {
		parent, ok := parents[current]
		if !ok {
			return 0, false
		}
		if depth, ok := known[parent]; ok {
			total := depth + len(trail)
			for index, peer := range trail {
				known[peer] = total - index
			}
			return known[peerID], true
		}
		trail = append(trail, parent)
		current = parent
	}
	return 0, false
}

// refreshCapacities 按当前深度重算每位观众的下游容量。
//
// 控制器的容量是调用方给的：深度到顶的节点必须把自己的容量压到 0，
// 否则它还会继续往下带人——Piik 自己只有深度排序，没有 MaxDepth 这种闸门。
func (e *Engine) refreshCapacities(now int64) {
	depths := e.depths()
	for peerID, current := range e.members {
		want := e.capacity(peerID, current, depths)
		if want == current.capacity {
			continue
		}
		current.capacity = want
		e.ctrl.UpsertParticipant(e.input(peerID, current), &now)
	}
}

// capacity 计算某位参与者的下游容量。0 表示不能当上游。
func (e *Engine) capacity(peerID string, current *member, depths map[string]int) int {
	if current.role == protocol.RoleHost {
		if e.policy.HostChildren > 0 {
			return e.policy.HostChildren
		}
		return protocol.MaxEndpointMediaCopyCapacity
	}
	if e.policy.ViewerChildren <= 0 || !current.ready {
		return 0
	}
	depth, known := depths[peerID]
	if !known || depth <= 0 {
		return 0
	}
	if depth >= e.policy.MaxDepth {
		return 0
	}
	return e.policy.ViewerChildren
}

// input 把本层的成员状态翻译成控制器的输入。
func (e *Engine) input(peerID string, current *member) route.ParticipantInput {
	return route.ParticipantInput{
		PeerID:                      peerID,
		Role:                        current.role,
		SessionID:                   peerID,
		EffectiveDownstreamCapacity: current.capacity,
	}
}

// pruneAttempts 丢掉已经不在控制器手里的候选凭据。
func (e *Engine) pruneAttempts() {
	operation := e.ctrl.Operation()
	current := ""
	if operation != nil && operation.Current != nil {
		current = operation.Current.ConnectionID
	}
	for connectionID := range e.attempts {
		if connectionID != current {
			delete(e.attempts, connectionID)
		}
	}
}

func edgeOf(operation *route.OperationSnapshot) *Edge {
	if operation == nil || operation.Current == nil {
		return nil
	}
	return &Edge{
		ChildPeerID:  operation.ChildPeerID,
		ParentPeerID: operation.Current.Tuple.ParentPeerID,
		ConnectionID: operation.Current.ConnectionID,
		Revision:     operation.Current.Revision,
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

func dedupe(peerIDs []string) []string {
	if len(peerIDs) < 2 {
		return peerIDs
	}
	unique := peerIDs[:1]
	for _, peerID := range peerIDs[1:] {
		if !slices.Contains(unique, peerID) {
			unique = append(unique, peerID)
		}
	}
	return unique
}

// NewConnectionID 铸造一个连接身份。前缀与 Piik 一致（`route_`）：
// 客户端自造带这个前缀的 id 一律拒，服务端铸造是唯一来源。
func NewConnectionID() string { return newConnectionID() }

func newConnectionID() string {
	var buffer [16]byte
	if _, err := rand.Read(buffer[:]); err != nil {
		return connectionIDPrefix + time.Now().Format("150405.000000")
	}
	return connectionIDPrefix + base64.RawURLEncoding.EncodeToString(buffer[:])
}
