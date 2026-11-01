package share

import (
	"crypto/rand"
	"encoding/base64"
	"sort"
	"strconv"
	"time"
)

// MaxRouteAttempts 是同一个观众重建候选的上限。
//
// Piik 没有这个常量：它的候选重试由候选列表里「未尝试次数」驱动，列表空
// 就是 route-exhausted（router_pump.go:258-294）。ZViewer 的候选集合是
// 「当前可当上游的参与者」，每次重试会换一个（`selectParentExceptLocked`），
// 但总次数仍然封顶：状态机必须在有限步内收敛，不能无限换父节点。
const MaxRouteAttempts = 3

// 传输类型。P1 只产生 direct；relay 留给 P3 的 SFU。
const (
	TransportDirect = "direct"
	TransportRelay  = "relay"
)

// connectionIDPrefix 与 Piik 一致（router.go:599）。
//
// 客户端自造带这个前缀的 connectionId 一律拒（router.go:682-684）——
// 服务端铸造是唯一来源，否则两端可以伪造一条不存在的边。
const connectionIDPrefix = "route_"

// TreePolicy 是树形拓扑的上限（Piik `route/candidates.go` 的容量/深度规则）。
//
// 三个 0 值组合出的就是移植前的单层星形：`ViewerChildren=0` 表示观众永远不
// 当父节点，所有边都是「房主 → 观众」。所以默认值不需要任何兼容分支。
type TreePolicy struct {
	// HostChildren 是房主最多直连几个观众；0 表示不设上限。
	HostChildren int
	// ViewerChildren 是一位观众最多转发给几个下游；0 表示观众不当父节点。
	ViewerChildren int
	// MaxDepth 是树的最大深度（房主 = 0）。<=1 等价于「只有房主能当父节点」。
	MaxDepth int
}

// Route 是一条已下发的路由边：某个观众从它的**上游**拉流。
//
// 上游可能是房主（单层，Piik 之前的 ZViewer 形态），也可能是另一位已经收到
// 画面的观众（树形，Piik 的成员互助）。边的方向永远是 Parent → Child，
// 一条边一份编码，所以「房主的出网 = 它的子节点数」。
type Route struct {
	// ChildPeerID 是拉流方（观众）。P0/P1 里 peerId 就是 socketId。
	ChildPeerID string
	// ParentPeerID 是上游是谁：房主或另一位观众。空表示还没选到上游。
	ParentPeerID string
	// ConnectionID 由服务端铸造，两端信号必须携带它。
	ConnectionID string
	// Revision 是这条边下发时的路由版本。
	Revision int64
	// Phase 只有 prepare / active 两个值。
	Phase string
	// Attempts 记录这条边已经被判失败几次。
	Attempts int
	// Connected 记录「传输层连上了」，只是进度，不构成提交（router.go:862-893）。
	Connected bool
}

// RoutePlan 是一条待下发的 route 消息。
//
// 同一条候选要发两份：房主那份用来建发布端 PC，观众那份用来建接收端 PC。
type RoutePlan struct {
	ToPeerID string
	Message  RouteMessage
}

// newConnectionID 铸造一个连接身份。
func newConnectionID() string {
	var buffer [16]byte
	if _, err := rand.Read(buffer[:]); err != nil {
		return connectionIDPrefix + strconv.FormatInt(time.Now().UnixNano(), 36)
	}
	return connectionIDPrefix + base64.RawURLEncoding.EncodeToString(buffer[:])
}

// PlanRoutes 补齐当前代际缺的边，返回需要下发的 route 消息。
//
// 触发点是「房主开始共享」与「观众刚 hello」：这两件事都会让期望边集变大。
// 幂等：已有的边不会重建，也不会推进 revision。
func (s *Session) PlanRoutes() []RoutePlan {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.sharing {
		return nil
	}
	host := s.hostPeerIDLocked()
	if host == "" {
		// 房主还没进会话，没有上游可连；等它的 hello 再来一次。
		return nil
	}
	// 按 peerId 排序再分配：树形下「谁先被处理」会决定谁能当父节点，
	// 遍历 map 的随机顺序会让同一个房间每次分配的树不一样（也测不稳）。
	viewers := make([]string, 0, len(s.participants))
	for peerID, participant := range s.participants {
		if participant.Role != RoleViewer || peerID == host {
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
	var created []*Route
	for _, peerID := range viewers {
		parent := s.selectParentLocked(peerID)
		if parent == "" {
			continue
		}
		route := &Route{
			ChildPeerID:  peerID,
			ParentPeerID: parent,
			ConnectionID: newConnectionID(),
			Phase:        PhasePrepare,
		}
		s.routes[peerID] = route
		created = append(created, route)
	}
	if len(created) == 0 {
		return nil
	}
	// 先推进版本，再回填：新边携带的 revision 必须是它被创建时的那个值，
	// 否则客户端拿它发 route-ready 会被版本栅栏挡掉。
	s.bumpLocked()
	for _, route := range created {
		route.Revision = s.revision
	}
	return s.plansLocked(created)
}

// CommitRoute 提交一条 prepare 状态的边。
//
// 只接受 prepare（router.go:796-846）：transport-connected 只是进度条，
// 真正的提交条件是「观众已经解出首帧」。
//
// 返回的 plans 里除了这条边的 active，还包含其余仍在 prepare 的边的
// prepare 刷新——提交会推进 revision，不刷新它们就会被自己的旧版本卡死。
func (s *Session) CommitRoute(childPeerID string, revision int64, connectionID string) []RoutePlan {
	s.mu.Lock()
	defer s.mu.Unlock()
	route, ok := s.routes[childPeerID]
	if !ok || route.ChildPeerID != childPeerID || route.ConnectionID != connectionID {
		// 边的身份对不上：客户端在拿别人的 connectionId 试。
		return nil
	}
	if route.Phase != PhasePrepare {
		return nil
	}
	if revision != s.revision {
		// 版本不匹配 → 静默丢弃，不回报错（router.go:810-815）。
		return nil
	}
	route.Phase = PhaseActive
	route.Connected = true
	// route-ready 的语义就是「观众已经解出首帧」（router.go:796-846）。
	// 树形拓扑靠这个标志决定「谁能当父节点」——没有源的节点转发出去是空流。
	if participant, ok := s.participants[childPeerID]; ok && !participant.MediaReady {
		participant.MediaReady = true
		s.participants[childPeerID] = participant
	}
	s.bumpLocked()
	// 新节点拿到画面 = 它现在可以当父节点了：把超额挂在房主身上的边迁过来
	// （Piik 的 opportunities 的简化版：只在「父节点超额」时才搬）。
	moved := s.rebalanceLocked()
	route.Revision = s.revision
	plans := s.plansLocked([]*Route{route})
	return append(append(plans, moved...), s.refreshPrepareLocked(route)...)
}

// MarkRouteConnected 记录「传输层连上了」。
//
// 不提交、不推进 revision：Piik 的 route-transport-connected 只更新进度
// （router.go:862-893）。版本不匹配静默丢弃。
func (s *Session) MarkRouteConnected(childPeerID string, revision int64, connectionID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	route, ok := s.routes[childPeerID]
	if !ok || route.ConnectionID != connectionID {
		return
	}
	if revision != s.revision {
		return
	}
	route.Connected = true
}

// FailRoute 处理一条候选失败：换一个新 connectionId 重试，用完次数就放弃。
//
// 返回 plans 与放弃标志。放弃时调用方负责发 route-status{failed, route-exhausted}。
//
// **逐边自适应的第一层**：重试时优先换一个上游（Piik `candidates.go:62-79` 的
// 「未尝试过的父节点优先」），换不到才留在原上游再赌一次 NAT。
func (s *Session) FailRoute(peerID string, revision int64, connectionID string) ([]RoutePlan, *StatusMessage) {
	s.mu.Lock()
	defer s.mu.Unlock()
	route := s.routeByConnectionLocked(connectionID)
	if route == nil || revision != s.revision {
		return nil, nil
	}
	// 失败可能由任何一端上报（父节点发现发不出去、子节点发现收不到）。
	if route.ChildPeerID != peerID && route.ParentPeerID != peerID {
		return nil, nil
	}
	childPeerID := route.ChildPeerID
	route.Attempts++
	route.Connected = false
	if route.Attempts >= MaxRouteAttempts {
		delete(s.routes, childPeerID)
		if participant, ok := s.participants[childPeerID]; ok && participant.MediaReady {
			participant.MediaReady = false
			s.participants[childPeerID] = participant
		}
		s.bumpLocked()
		// 这个节点彻底没有上游了，它下游的整棵子树也跟着断源：重挂它们。
		plans := s.reparentDescendantsLocked(childPeerID)
		status := &StatusMessage{
			T:        TypeStatus,
			RoomID:   s.roomID,
			Revision: s.revision,
			State:    StatusFailed,
			Reason:   ReasonRouteExhausted,
		}
		// 其余边也要刷新：放弃一条边同样推进了 revision。
		return append(plans, s.refreshPrepareLocked(nil)...), status
	}
	// 换一个上游再试（避开刚失败的那个）；没有别的可选就留在原上游。
	if next := s.selectParentExceptLocked(childPeerID, route.ParentPeerID); next != "" {
		route.ParentPeerID = next
	}
	// 新候选 = 新 connectionId。旧 PC 立刻作废，不存在复用旧身份的路径。
	route.ConnectionID = newConnectionID()
	route.Phase = PhasePrepare
	s.bumpLocked()
	route.Revision = s.revision
	plans := s.plansLocked([]*Route{route})
	return append(plans, s.refreshPrepareLocked(route)...), nil
}

// RestartRoute 处理观众的恢复请求。
//
// rebuild=false 保留 connectionId（房主在上面做 ICE restart）；
// rebuild=true 换新 connectionId（两端都拆了重建，Piik 第 2 次恢复的做法，
// viewer-peer.ts:518）。
func (s *Session) RestartRoute(childPeerID, connectionID string, rebuild bool) []RoutePlan {
	s.mu.Lock()
	defer s.mu.Unlock()
	route, ok := s.routes[childPeerID]
	if !ok || route.ConnectionID != connectionID {
		return nil
	}
	if rebuild {
		route.ConnectionID = newConnectionID()
	}
	route.Phase = PhasePrepare
	route.Connected = false
	s.bumpLocked()
	route.Revision = s.revision
	plans := s.plansLocked([]*Route{route})
	return append(plans, s.refreshPrepareLocked(route)...)
}

// SignalTarget 校验一条信号能不能从 sender 走这条边，返回转发目标。
//
// 角色约束照 Piik（server.go:1750-1757）：offer 只能房主发，answer 只能
// 观众发，candidate 双向。返回空表示拒发（静默丢弃）。
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
	// 角色只认边上的两端：上游发 offer / 候选，下游发 answer / 候选。
	// 上游可能是房主，也可能是一位观众——这里不再假设「房主」。
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
//
// 中继侧信令只认这个判定：观众拿别人的 connectionId 或直连边的 id 来订流，
// 一律拒。
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

// plansLocked 把若干条边转成下发计划：**上游一份 + 下游一份**。
//
// 上游是房主还是另一位观众由 `route.ParentPeerID` 决定——这是树形与单层唯一
// 的差别。两条消息内容相同，客户端靠 `candidate.childPeerId` / `parentPeerId`
// 判断自己在这条边上是哪一端。
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
			Revision:   route.Revision,
			Phase:      route.Phase,
			Assignment: assignment,
			Candidate:  &candidate,
		}
		// 中继模式下这条边在房主侧根本不存在：房主只有一条到 SFU 的上行。
		// 把候选发给它会让它照着建一条直连 PC——白多一份编码，而且它真的会
		// 给观众发 offer，形成一条绕开 SFU 的旁路（观众可能同时收到两份媒体）。
		if candidate.Transport != TransportRelay && route.ParentPeerID != "" {
			plans = append(plans, RoutePlan{ToPeerID: route.ParentPeerID, Message: message})
		}
		plans = append(plans, RoutePlan{ToPeerID: route.ChildPeerID, Message: message})
	}
	return plans
}

// refreshPrepareLocked 给仍在 prepare 的边补发一次 prepare。
//
// 每次 revision 推进都会让在途的 prepare 过期（栅栏要求完全相等），
// 不刷新的话第二个观众的 route-ready 永远被丢弃。exclude 是刚刚处理过的那条。
func (s *Session) refreshPrepareLocked(exclude *Route) []RoutePlan {
	pending := make([]*Route, 0, len(s.routes))
	for _, route := range s.routes {
		if route == exclude || route.Phase != PhasePrepare {
			continue
		}
		route.Revision = s.revision
		pending = append(pending, route)
	}
	return s.plansLocked(pending)
}

// ==================== 树形拓扑 ====================

// SetTree 设置本房间的树形上限（装配期一次，运行期不改）。
func (s *Session) SetTree(policy TreePolicy) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.tree = policy
}

// rebalanceLocked 把「父节点超额」的边迁到别的上游。
//
// 这是树形与单层的第二个差别：分配是贪心的（新观众先挂房主），所以「谁先
// 拿到画面」会决定这棵树长什么样。等到某位观众出了首帧，它就成了新的可用
// 上游，这时必须回头把房主身上超额的边搬过去——否则树永远长不出来，只是
// 一开始凑巧排出来的形状。
//
// 只在**超额**时迁移：不超额就不动，避免把稳定的连接拿去做无意义的抖动。
// 迁移必然换 connectionId（换了对端就是另一条 PC），代价是那一位观众要重连。
func (s *Session) rebalanceLocked() []RoutePlan {
	var moved []*Route
	// 两轮：第一轮搬走超额的边，第二轮处理「搬过去之后新父节点又满了」。
	for pass := 0; pass < 2; pass++ {
		progress := false
		for _, childPeerID := range s.sortedChildrenLocked() {
			route, ok := s.routes[childPeerID]
			if !ok {
				continue
			}
			limit := s.capacityLocked(route.ParentPeerID)
			if limit <= 0 {
				continue
			}
			if s.childCountLocked(route.ParentPeerID) <= limit {
				continue
			}
			next := s.selectParentExceptLocked(childPeerID, route.ParentPeerID)
			if next == "" {
				continue
			}
			route.ParentPeerID = next
			route.ConnectionID = newConnectionID()
			route.Phase = PhasePrepare
			route.Connected = false
			moved = append(moved, route)
			progress = true
		}
		if !progress {
			break
		}
	}
	if len(moved) == 0 {
		return nil
	}
	s.bumpLocked()
	for _, route := range moved {
		route.Revision = s.revision
	}
	return s.plansLocked(moved)
}

// capacityLocked 返回某个节点的下游上限；0 表示不限。
func (s *Session) capacityLocked(peerID string) int {
	if peerID == s.hostPeerIDLocked() {
		return s.tree.HostChildren
	}
	return s.tree.ViewerChildren
}

// sortedChildrenLocked 按 childPeerID 排序后的边集合，保证迁移顺序确定。
func (s *Session) sortedChildrenLocked() []string {
	children := make([]string, 0, len(s.routes))
	for childPeerID := range s.routes {
		children = append(children, childPeerID)
	}
	sort.Strings(children)
	return children
}

// selectParentLocked 给一位观众选上游。返回空表示没有可用的上游。
func (s *Session) selectParentLocked(childPeerID string) string {
	return s.selectParentExceptLocked(childPeerID, "")
}

// selectParentExceptLocked 同 selectParentLocked，但排除一个刚失败的父节点。
//
// 排序照 Piik `candidates.go:62-79`：**深度小的优先**（尽量贴着房主，跳数少）、
// 其次是剩余容量大的（把压力摊平），最后按 peerId 保证确定性。
// 房主永远是可选项：全都满了也要让房主超额接，总比观众没画面好。
//
// 多一条软信号：最近被观众投诉过的上游排到最后（`parentPenalty`，见
// quality.go）。它只在**别的选项同样可行**时起作用——不排除任何人，因为
// 排除会让「唯一可用的上游恰好刚被投诉」变成「这个观众没有画面」。
func (s *Session) selectParentExceptLocked(childPeerID, avoid string) string {
	host := s.hostPeerIDLocked()
	if host == "" {
		return ""
	}
	now := time.Now()
	type option struct {
		peerID    string
		depth     int
		children  int
		penalized bool
	}
	options := make([]option, 0, len(s.participants))
	for peerID, participant := range s.participants {
		if peerID == childPeerID || peerID == avoid {
			continue
		}
		penalized := s.parentPenalizedLocked(peerID, now)
		if peerID == host {
			if s.tree.HostChildren > 0 && s.childCountLocked(host) >= s.tree.HostChildren {
				continue
			}
			options = append(options, option{
				peerID:    host,
				depth:     0,
				children:  s.childCountLocked(host),
				penalized: penalized,
			})
			continue
		}
		if participant.Role != RoleViewer {
			continue
		}
		// 观众要当父节点，必须自己已经在收画面（否则转发的是空流）。
		if s.tree.ViewerChildren <= 0 || !participant.MediaReady {
			continue
		}
		depth := s.depthLocked(peerID)
		if depth < 0 {
			continue
		}
		if s.tree.MaxDepth > 0 && depth+1 > s.tree.MaxDepth {
			continue
		}
		// 让「自己的下游」当自己的上游 = 环。
		if s.isInSubtreeLocked(peerID, childPeerID) {
			continue
		}
		if s.childCountLocked(peerID) >= s.tree.ViewerChildren {
			continue
		}
		options = append(options, option{
			peerID:    peerID,
			depth:     depth,
			children:  s.childCountLocked(peerID),
			penalized: penalized,
		})
	}
	if len(options) == 0 {
		// 谁都不能当上游（房主满员、还没有观众拿到画面）时，宁可让房主超额，
		// 也不要让这位观众拿不到画面。Piik 在这一步会转向 SFU，ZViewer 的
		// 中继是整场开关，没有「单边升级」这种中间态。
		if avoid != host {
			return host
		}
		return ""
	}
	sort.SliceStable(options, func(i, j int) bool {
		if options[i].penalized != options[j].penalized {
			// 没被投诉的排前面。
			return !options[i].penalized
		}
		if options[i].depth != options[j].depth {
			return options[i].depth < options[j].depth
		}
		if options[i].children != options[j].children {
			return options[i].children < options[j].children
		}
		return options[i].peerID < options[j].peerID
	})
	return options[0].peerID
}

// maxTreeWalk 是向上回溯的硬上限：脏数据成环时也不会死循环。
const maxTreeWalk = 64

// depthLocked 返回某位参与者离房主的跳数；不在树上（还没有上游）返回 -1。
func (s *Session) depthLocked(peerID string) int {
	host := s.hostPeerIDLocked()
	if peerID == host {
		return 0
	}
	visited := make(map[string]struct{}, len(s.routes))
	current := peerID
	depth := 0
	for current != "" {
		if _, seen := visited[current]; seen {
			return -1
		}
		visited[current] = struct{}{}
		route, ok := s.routes[current]
		if !ok {
			return -1
		}
		depth++
		if route.ParentPeerID == host {
			return depth
		}
		current = route.ParentPeerID
		if depth > maxTreeWalk {
			return -1
		}
	}
	return -1
}

// childCountLocked 返回某位参与者当前有几个下游。
func (s *Session) childCountLocked(peerID string) int {
	count := 0
	for _, route := range s.routes {
		if route.ParentPeerID == peerID {
			count++
		}
	}
	return count
}

// isInSubtreeLocked 判断 candidate 是否在 root 的子树里（含 root 自己）。
//
// 用于否决「让下游当上游」：那会成一个环。visited 防御历史脏数据。
func (s *Session) isInSubtreeLocked(candidate, root string) bool {
	visited := make(map[string]struct{}, len(s.routes))
	current := candidate
	for current != "" {
		if current == root {
			return true
		}
		if _, seen := visited[current]; seen {
			return false
		}
		visited[current] = struct{}{}
		route, ok := s.routes[current]
		if !ok {
			return false
		}
		current = route.ParentPeerID
	}
	return false
}

// descendantsLocked 返回某位参与者的全部下游（父在子前）。
func (s *Session) descendantsLocked(peerID string) []string {
	children := make(map[string][]string, len(s.routes))
	for _, route := range s.routes {
		children[route.ParentPeerID] = append(children[route.ParentPeerID], route.ChildPeerID)
	}
	var ordered []string
	queue := append([]string(nil), children[peerID]...)
	for len(queue) > 0 {
		current := queue[0]
		queue = queue[1:]
		ordered = append(ordered, current)
		queue = append(queue, children[current]...)
	}
	return ordered
}

// reparentDescendantsLocked 给某个节点的整棵子树重新找上游。
//
// 触发场景只有一个：这个节点**永久**失去上游（次数用完）或它离开了房间。
// 它的下游边本身没坏，但源断了——不重挂的话，那批观众会一直停在一张静止
// 画面上，而服务端以为一切正常。
func (s *Session) reparentDescendantsLocked(peerID string) []RoutePlan {
	descendants := s.descendantsLocked(peerID)
	if len(descendants) == 0 {
		return nil
	}
	for _, childPeerID := range descendants {
		delete(s.routes, childPeerID)
	}
	created := make([]*Route, 0, len(descendants))
	for _, childPeerID := range descendants {
		parent := s.selectParentLocked(childPeerID)
		if parent == "" {
			continue
		}
		route := &Route{
			ChildPeerID:  childPeerID,
			ParentPeerID: parent,
			ConnectionID: newConnectionID(),
			Phase:        PhasePrepare,
		}
		s.routes[childPeerID] = route
		created = append(created, route)
	}
	if len(created) == 0 {
		return nil
	}
	s.bumpLocked()
	for _, route := range created {
		route.Revision = s.revision
	}
	return s.plansLocked(created)
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

// dropRoutesForLocked 移除某条连接相关的边。房主离开时全部移除。
//
// 离开者如果是父节点，它下游的整棵子树也一并拆掉（源已经没了，且这些
// connectionId 属于它）——由服务端在 Leave 之后调 PlanRoutes 重挂。
func (s *Session) dropRoutesForLocked(socketID string, isHost bool) {
	if isHost {
		s.routes = make(map[string]*Route)
		return
	}
	for _, childPeerID := range s.descendantsLocked(socketID) {
		delete(s.routes, childPeerID)
	}
	delete(s.routes, socketID)
}

// transportLocked 返回本房间当前使用的传输类型。
//
// 中继模式下房主的上行只走 SFU，观众不再直连房主——这正是 SFU 省上行的
// 那个收益，也是「房主上行 1 份」的前提。
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
