package share

import (
	"sort"
	"time"

	"zviewer/backend/internal/share/piikroute"
)

// 传输类型。direct 走 P2P（可能是房主直连，也可能是观众互助），relay 走 SFU。
const (
	TransportDirect = "direct"
	TransportRelay  = "relay"
)

// TreePolicy 是树形拓扑的上限，原样映射到 Piik 的 route 控制器。
//
// 三个 0 值组合出的仍是移植前的单层星形：`ViewerChildren=0` 表示观众永远不
// 当父节点，所有边都是「房主 → 观众」。
type TreePolicy struct {
	// HostChildren 是房主最多直连几个观众；0 表示不设上限。
	HostChildren int
	// ViewerChildren 是一位观众最多转发给几个下游；0 表示观众不当父节点。
	ViewerChildren int
	// MaxDepth 是树的最大深度（房主 = 0）。<=1 等价于「只有房主能当父节点」。
	MaxDepth int
}

// DefaultTreePolicy 是 ZViewer 的出厂值：房主 3 人、观众再带 2 人、最多 3 层。
func DefaultTreePolicy() TreePolicy {
	policy := piikroute.DefaultPolicy()
	return TreePolicy{
		HostChildren:   policy.HostChildren,
		ViewerChildren: policy.ViewerChildren,
		MaxDepth:       policy.MaxDepth,
	}
}

func (t TreePolicy) piikPolicy() piikroute.Policy {
	return piikroute.Policy{
		HostChildren:   t.HostChildren,
		ViewerChildren: t.ViewerChildren,
		MaxDepth:       t.MaxDepth,
	}
}

// Route 是一条已下发的路由边：某个观众从它的**上游**拉流。
//
// 上游可能是房主（单层），也可能是另一位已经收到画面的观众（互助）。边的
// 方向永远是 Parent → Child，一条边一份编码，所以「房主的出网 = 子节点数」。
//
// 会话里这份记录是 Piik 控制器的投影：控制器决定谁挂谁，这里只记「我们
// 告诉过客户端什么」——connectionId、阶段、以及信令该往哪转。
type Route struct {
	// ChildPeerID 是拉流方（观众）。
	ChildPeerID string
	// ParentPeerID 是上游。中继边为空（上游是 SFU，不是某个 peer）。
	ParentPeerID string
	// ConnectionID 由服务端铸造，两端信号必须携带它。
	ConnectionID string
	// Phase 只有 prepare / active 两个值。
	Phase string
	// Connected 记录「传输层连上了」，只是进度，不构成提交。
	Connected bool
}

// RoutePlan 是一条待下发的 route 消息。
//
// 同一条边要发两份：上游那份建发布端 PC，下游那份建接收端 PC。
type RoutePlan struct {
	ToPeerID string
	// Message 是 RouteMessage 或 StatusMessage：两者共用一条下发通道，
	// 装配层只按 ToPeerID 派发，不关心负载类型。
	Message any
}

// PlanRoutes 推进一轮调度，返回需要下发的 route 消息。
//
// 触发点是「房主开始共享」「观众刚 hello」「上一位结算完」「候选超时」。
// Piik 的调度是串行的：一条候选没结算之前不会再开下一条，所以这里最多
// 产生一条新边。
func (s *Session) PlanRoutes() []RoutePlan {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.advanceLocked()
}

// CommitRoute 提交一条 prepare 状态的边。
//
// 只有「观众已经解出首帧」才算提交：transport-connected 只是进度条，
// 提交之后这位观众才具备当上游的资格。
func (s *Session) CommitRoute(childPeerID string, _ int64, connectionID string) []RoutePlan {
	s.mu.Lock()
	defer s.mu.Unlock()
	route, ok := s.routes[childPeerID]
	if !ok || route.ConnectionID != connectionID || route.Phase != PhasePrepare {
		// 边的身份对不上：客户端在拿别人的 connectionId 试。
		return nil
	}
	if !s.relay {
		engine := s.ensureEngineLocked()
		if engine == nil || !engine.Commit(connectionID) {
			return nil
		}
	}
	route.Phase = PhaseActive
	route.Connected = true
	// route-ready 的语义就是「观众已经解出首帧」：它现在可以当上游了。
	if participant, ok := s.participants[childPeerID]; ok && !participant.MediaReady {
		participant.MediaReady = true
		s.participants[childPeerID] = participant
	}
	s.bumpLocked()
	// 先发这条边的 active，再推进下一位：客户端拿到 active 才会开始拉流。
	plans := s.plansLocked([]*Route{route})
	return append(plans, s.advanceLocked()...)
}

// MarkRouteConnected 记录「传输层连上了」。
//
// 不提交、不推进版本：Piik 的 route-transport-connected 只更新进度。
func (s *Session) MarkRouteConnected(childPeerID string, _ int64, connectionID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	route, ok := s.routes[childPeerID]
	if !ok || route.ConnectionID != connectionID {
		return
	}
	route.Connected = true
}

// FailRoute 处理一条候选失败：换下一个上游，没有可选就放弃。
//
// 返回 plans 与放弃标志。放弃时调用方负责发 route-status{failed, route-exhausted}。
func (s *Session) FailRoute(childPeerID string, _ int64, connectionID string) ([]RoutePlan, *StatusMessage) {
	s.mu.Lock()
	defer s.mu.Unlock()
	route, ok := s.routes[childPeerID]
	if !ok || route.ConnectionID != connectionID {
		return nil, nil
	}
	if !s.relay {
		engine := s.ensureEngineLocked()
		if engine == nil {
			return nil, nil
		}
		exhausted := engine.Fail(connectionID)
		delete(s.routes, childPeerID)
		s.bumpLocked()
		plans := s.advanceLocked()
		if exhausted {
			if participant, ok := s.participants[childPeerID]; ok && participant.MediaReady {
				participant.MediaReady = false
				s.participants[childPeerID] = participant
			}
			return plans, s.exhaustedStatusLocked()
		}
		return plans, nil
	}
	// 中继边没有可换的上游：换一个连接身份重试。
	route.ConnectionID = piikroute.NewConnectionID()
	route.Phase = PhasePrepare
	route.Connected = false
	s.bumpLocked()
	return s.plansLocked([]*Route{route}), nil
}

// RestartRoute 处理观众的恢复请求。
//
// rebuild=false 保留 connectionId 让房主在上面做 ICE restart；
// rebuild=true 换一个上游（控制器把这次失败记进候选账本）。
func (s *Session) RestartRoute(childPeerID, connectionID string, rebuild bool) ([]RoutePlan, *StatusMessage) {
	s.mu.Lock()
	defer s.mu.Unlock()
	route, ok := s.routes[childPeerID]
	if !ok || route.ConnectionID != connectionID {
		return nil, nil
	}
	if rebuild && !s.relay {
		engine := s.ensureEngineLocked()
		if engine == nil {
			return nil, nil
		}
		exhausted := engine.Fail(connectionID)
		delete(s.routes, childPeerID)
		s.bumpLocked()
		plans := s.advanceLocked()
		if exhausted {
			return plans, s.exhaustedStatusLocked()
		}
		return plans, nil
	}
	if rebuild {
		route.ConnectionID = piikroute.NewConnectionID()
	}
	route.Phase = PhasePrepare
	route.Connected = false
	s.bumpLocked()
	return s.plansLocked([]*Route{route}), nil
}

// SignalTarget 校验一条信号能不能从 sender 走这条边，返回转发目标。
//
// 角色约束照 Piik：offer 只能上游发，answer 只能下游发，candidate 双向。
// 返回空表示拒发（静默丢弃）。
func (s *Session) SignalTarget(senderID, roomID, connectionID, kind string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if roomID != s.roomID {
		return "", false
	}
	route := s.routeByConnectionLocked(connectionID)
	if route == nil {
		return "", false
	}
	switch senderID {
	case route.ParentPeerID:
		if kind == SignalAnswer {
			return "", false
		}
		return route.ChildPeerID, true
	case route.ChildPeerID:
		if kind == SignalOffer {
			return "", false
		}
		return route.ParentPeerID, true
	default:
		return "", false
	}
}

// RouteCount 返回当前边数（测试与诊断用）。
func (s *Session) RouteCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.routes)
}

// IsRelayRoute 报告这条连接是不是某位观众的、且走中继的那条边。
func (s *Session) IsRelayRoute(childPeerID, connectionID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.relay || connectionID == "" {
		return false
	}
	route, ok := s.routes[childPeerID]
	return ok && route.ConnectionID == connectionID
}

// RoutePhase 返回某条边的阶段（测试用；不存在返回空串）。
func (s *Session) RoutePhase(childPeerID string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if route, ok := s.routes[childPeerID]; ok {
		return route.Phase
	}
	return ""
}

// RouteConnectionID 返回某条边的连接身份（测试用）。
func (s *Session) RouteConnectionID(childPeerID string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if route, ok := s.routes[childPeerID]; ok {
		return route.ConnectionID
	}
	return ""
}

// ==================== 内部 ====================

// advanceLocked 推进一轮：直连交给 Piik 控制器，中继走整场扇出。
func (s *Session) advanceLocked() []RoutePlan {
	if !s.sharing {
		return nil
	}
	if s.relay {
		return s.planRelayLocked()
	}
	engine := s.ensureEngineLocked()
	if engine == nil {
		return nil
	}
	result := engine.Advance()
	changed := s.syncRoutesLocked(engine)
	if len(changed) > 0 || result.Edge != nil {
		s.bumpLocked()
	}
	s.armTimerLocked()

	plans := s.plansLocked(changed)
	plans = append(plans, s.exhaustedPlansLocked(result.Failed)...)
	return plans
}

// ensureEngineLocked 返回（必要时构造）本房间的选路引擎。
//
// 房主没进会话时不建：控制器构造时就钉死房主身份，之后换不了。
func (s *Session) ensureEngineLocked() *piikroute.Engine {
	if !s.sharing {
		return nil
	}
	host := s.hostPeerIDLocked()
	if host == "" {
		return nil
	}
	if s.engine != nil && s.engineHost == host {
		return s.engine
	}
	engine := piikroute.New(host, s.tree.piikPolicy())
	if s.clock != nil {
		engine.SetClock(s.clock)
	}
	// 观众可能早就 hello 过了：重新开局或换房主时要把在座的都登记一遍。
	// 必须按入座顺序登记：控制器按 join order 决定先服务谁。
	peerIDs := make([]string, 0, len(s.participants))
	for peerID := range s.participants {
		peerIDs = append(peerIDs, peerID)
	}
	sort.Slice(peerIDs, func(i, j int) bool {
		left, right := s.joinOrder[peerIDs[i]], s.joinOrder[peerIDs[j]]
		if left != right {
			return left < right
		}
		return peerIDs[i] < peerIDs[j]
	})
	for _, peerID := range peerIDs {
		participant := s.participants[peerID]
		engine.Join(peerID, participant.Role, participant.MediaReady)
	}
	s.engine = engine
	s.engineHost = host
	return engine
}

// dropEngineLocked 丢掉选路引擎（房主离开、共享结束）。
func (s *Session) dropEngineLocked() {
	s.engine = nil
	s.engineHost = ""
	s.stopTimerLocked()
}

// syncRoutesLocked 把本地记录同步成控制器的投影，返回需要重新下发 prepare 的边。
//
// 控制器会自己重挂子树（父节点离开、容量收缩），本地记录不跟着改就会发出
// 指向旧上游的信令。
func (s *Session) syncRoutesLocked(engine *piikroute.Engine) []*Route {
	committed := make(map[string]piikroute.Edge)
	for _, edge := range engine.Edges() {
		committed[edge.ChildPeerID] = edge
	}
	pending, hasPending := engine.Pending()

	var changed []*Route
	for childPeerID, edge := range committed {
		local, ok := s.routes[childPeerID]
		if ok && local.ConnectionID == edge.ConnectionID && local.Phase == PhaseActive {
			local.ParentPeerID = edge.ParentPeerID
			continue
		}
		// 只会在开局时命中：控制器已经有这条边，本地还没记上。
		s.routes[childPeerID] = &Route{
			ChildPeerID:  childPeerID,
			ParentPeerID: edge.ParentPeerID,
			ConnectionID: edge.ConnectionID,
			Phase:        PhaseActive,
			Connected:    true,
		}
	}
	if hasPending {
		local, ok := s.routes[pending.ChildPeerID]
		if !ok || local.ConnectionID != pending.ConnectionID || local.Phase != PhasePrepare {
			local = &Route{
				ChildPeerID:  pending.ChildPeerID,
				ParentPeerID: pending.ParentPeerID,
				ConnectionID: pending.ConnectionID,
				Phase:        PhasePrepare,
			}
			s.routes[pending.ChildPeerID] = local
			changed = append(changed, local)
		}
	}
	// 既不在已提交图里、也不是在途候选的边：控制器已经放弃了它。
	for childPeerID, local := range s.routes {
		if _, ok := committed[childPeerID]; ok {
			continue
		}
		if hasPending && childPeerID == pending.ChildPeerID && local.ConnectionID == pending.ConnectionID {
			continue
		}
		delete(s.routes, childPeerID)
	}
	sort.Slice(changed, func(i, j int) bool { return changed[i].ChildPeerID < changed[j].ChildPeerID })
	return changed
}

// planRelayLocked 给每位观众发一条到 SFU 的边。
//
// 中继模式下没有 P2P 拓扑，观众互助和树形都不存在：一条上行进 SFU，
// 每条下行各自一份。所以这里不做任何选路。
func (s *Session) planRelayLocked() []RoutePlan {
	viewers := make([]string, 0, len(s.participants))
	for peerID, participant := range s.participants {
		if participant.Role != RoleViewer {
			continue
		}
		if _, ok := s.routes[peerID]; ok {
			continue
		}
		viewers = append(viewers, peerID)
	}
	if len(viewers) == 0 {
		return nil
	}
	sort.Strings(viewers)
	created := make([]*Route, 0, len(viewers))
	for _, peerID := range viewers {
		route := &Route{
			ChildPeerID:  peerID,
			ConnectionID: piikroute.NewConnectionID(),
			Phase:        PhasePrepare,
		}
		s.routes[peerID] = route
		created = append(created, route)
	}
	s.bumpLocked()
	return s.plansLocked(created)
}

// plansLocked 把若干条边转成下发计划：**上游一份 + 下游一份**。
//
// 上游是房主还是另一位观众由 `route.ParentPeerID` 决定——这是树形与单层
// 唯一的差别。两条消息内容相同，客户端靠 `candidate.childPeerId` /
// `parentPeerId` 判断自己在这条边上是哪一端。
func (s *Session) plansLocked(routes []*Route) []RoutePlan {
	if len(routes) == 0 {
		return nil
	}
	assignment := s.assignmentLocked()
	plans := make([]RoutePlan, 0, len(routes)*2)
	for _, route := range routes {
		candidate := Candidate{
			ChildPeerID:  route.ChildPeerID,
			ParentPeerID: route.ParentPeerID,
			ConnectionID: route.ConnectionID,
			Transport:    s.transportLocked(),
		}
		if candidate.Transport == TransportRelay {
			// 观众要知道订的是哪一路发布；直连时这个字段为空。
			candidate.PublicationGeneration = s.publication
			// 中继边没有 P2P 上游：父节点是 SFU，不是某个 peer。
			candidate.ParentPeerID = ""
		}
		message := RouteMessage{
			T:          TypeRoute,
			RoomID:     s.roomID,
			Revision:   s.revision,
			Phase:      route.Phase,
			Assignment: assignment,
			Candidate:  &candidate,
		}
		// 中继模式下这条边在房主侧根本不存在：房主只有一条到 SFU 的上行。
		// 把候选发给它会让它照着建一条直连 PC——白多一份编码，而且它真的会
		// 给观众发 offer，形成一条绕开 SFU 的旁路。
		if candidate.Transport != TransportRelay && route.ParentPeerID != "" {
			plans = append(plans, RoutePlan{ToPeerID: route.ParentPeerID, Message: message})
		}
		plans = append(plans, RoutePlan{ToPeerID: route.ChildPeerID, Message: message})
	}
	return plans
}

// exhaustedPlansLocked 把「没有上游了」的观众转成 route-status。
//
// 只发给还在房间里的人：控制器会把「暂时没有可用上游」也报成失败，客户端
// 收到之后显示连接失败；等树上腾出位置，下一轮调度会重新给它一条边。
func (s *Session) exhaustedPlansLocked(peerIDs []string) []RoutePlan {
	plans := make([]RoutePlan, 0, len(peerIDs))
	for _, peerID := range peerIDs {
		if _, ok := s.participants[peerID]; !ok {
			continue
		}
		plans = append(plans, RoutePlan{ToPeerID: peerID, Message: *s.exhaustedStatusLocked()})
	}
	return plans
}

// transportLocked 返回本房间当前使用的传输类型。
func (s *Session) transportLocked() string {
	if s.relay {
		return TransportRelay
	}
	return TransportDirect
}

// hostPeerIDLocked 返回房主的 peerId（没有则空串）。
func (s *Session) hostPeerIDLocked() string {
	for peerID, participant := range s.participants {
		if participant.Role == RoleHost {
			return peerID
		}
	}
	return ""
}

// assignmentLocked 汇总已提交的边。
func (s *Session) assignmentLocked() Assignment {
	candidates := make([]Candidate, 0, len(s.routes))
	for _, route := range s.routes {
		if route.Phase != PhaseActive {
			continue
		}
		candidate := Candidate{
			ChildPeerID:  route.ChildPeerID,
			ParentPeerID: route.ParentPeerID,
			ConnectionID: route.ConnectionID,
			Transport:    s.transportLocked(),
		}
		if candidate.Transport == TransportRelay {
			candidate.PublicationGeneration = s.publication
			candidate.ParentPeerID = ""
		}
		candidates = append(candidates, candidate)
	}
	return Assignment{Revision: s.revision, Phase: PhaseActive, Candidates: candidates}
}

// dropRoutesForLocked 移除某条连接相关的边。房主离开时全部移除。
//
// 观众离开时它下游的边由控制器重挂：这里只删本地记录，剩下的事下一轮
// 调度会重新下发候选。
func (s *Session) dropRoutesForLocked(socketID string, isHost bool) {
	if isHost {
		s.routes = make(map[string]*Route)
		return
	}
	delete(s.routes, socketID)
}

// exhaustedStatusLocked 造一条 route-exhausted 状态。
func (s *Session) exhaustedStatusLocked() *StatusMessage {
	return &StatusMessage{
		T:        TypeStatus,
		RoomID:   s.roomID,
		Revision: s.revision,
		State:    StatusFailed,
		Reason:   ReasonRouteExhausted,
	}
}

// routeByConnectionLocked 按 connectionId 找边。调用方必须持有 mu。
func (s *Session) routeByConnectionLocked(connectionID string) *Route {
	if connectionID == "" {
		return nil
	}
	for _, route := range s.routes {
		if route.ConnectionID == connectionID {
			return route
		}
	}
	return nil
}

// ==================== 候选超时 ====================

// armTimerLocked 按控制器的唤醒时刻排一个定时器。
//
// 控制器只记 deadline，不会自己跑。没有这个定时器，一条不回报的候选会把
// 整屋的串行铺路冻住——后面的人永远等不到自己的 prepare。
func (s *Session) armTimerLocked() {
	if s.afterFunc == nil {
		return
	}
	s.stopTimerLocked()
	if s.engine == nil {
		return
	}
	wakeAt, ok := s.engine.WakeAt()
	if !ok {
		return
	}
	delay := time.Until(time.UnixMilli(wakeAt))
	if delay < time.Millisecond {
		delay = time.Millisecond
	}
	generation := s.timerGeneration
	s.timerStop = s.afterFunc(delay, func() {
		s.mu.Lock()
		if generation != s.timerGeneration || s.engine == nil {
			s.mu.Unlock()
			return
		}
		s.timerStop = nil
		plans := s.advanceLocked()
		s.mu.Unlock()
		s.emitPlans(plans)
	})
}

// stopTimerLocked 取消已排的定时器。代数自增让已经进入回调的旧定时器作废。
func (s *Session) stopTimerLocked() {
	if s.timerStop != nil {
		s.timerStop()
	}
	s.timerStop = nil
	s.timerGeneration++
}

// emitPlans 把定时器推进出来的计划交给装配层下发。
func (s *Session) emitPlans(plans []RoutePlan) {
	if len(plans) == 0 || s.onPlans == nil {
		return
	}
	s.onPlans(plans)
}
