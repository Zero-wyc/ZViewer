package share

import (
	"crypto/rand"
	"encoding/base64"
	"strconv"
	"time"
)

// MaxRouteAttempts 是同一个观众重建候选的上限。
//
// Piik 没有这个常量：它的候选重试由候选列表里「未尝试次数」驱动，列表空
// 就是 route-exhausted（router_pump.go:258-294）。ZViewer 只做单层直连，
// 候选永远只有「现房主直连」一个，所以用固定次数代替候选列表的自然耗尽，
// 语义对齐：用完就发 route-status{failed, route-exhausted}。
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

// Route 是一条已下发的路由边：某个观众从房主直连拉流。
//
// ZViewer 只有单层（观众的上游永远是房主），所以边就是 (房主, 观众) 一对，
// 不存在 Piik 的树形祖先链与环检测。
type Route struct {
	// ChildPeerID 是拉流方（观众）。P0/P1 里 peerId 就是 socketId。
	ChildPeerID string
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
	var created []*Route
	for peerID, participant := range s.participants {
		if participant.Role != RoleViewer || peerID == host {
			continue
		}
		if _, ok := s.routes[peerID]; ok {
			continue
		}
		route := &Route{
			ChildPeerID:  peerID,
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
	return s.plansLocked(host, created)
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
	s.bumpLocked()
	route.Revision = s.revision
	host := s.hostPeerIDLocked()
	plans := s.plansLocked(host, []*Route{route})
	return append(plans, s.refreshPrepareLocked(host, route)...)
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
func (s *Session) FailRoute(childPeerID string, revision int64, connectionID string) ([]RoutePlan, *StatusMessage) {
	s.mu.Lock()
	defer s.mu.Unlock()
	route, ok := s.routes[childPeerID]
	if !ok || route.ConnectionID != connectionID {
		return nil, nil
	}
	if revision != s.revision {
		return nil, nil
	}
	host := s.hostPeerIDLocked()
	route.Attempts++
	route.Connected = false
	if route.Attempts >= MaxRouteAttempts {
		delete(s.routes, childPeerID)
		s.bumpLocked()
		status := &StatusMessage{
			T:        TypeStatus,
			RoomID:   s.roomID,
			Revision: s.revision,
			State:    StatusFailed,
			Reason:   ReasonRouteExhausted,
		}
		// 其余边也要刷新：放弃一条边同样推进了 revision。
		return s.refreshPrepareLocked(host, nil), status
	}
	// 新候选 = 新 connectionId。旧 PC 立刻作废，不存在复用旧身份的路径。
	route.ConnectionID = newConnectionID()
	route.Phase = PhasePrepare
	s.bumpLocked()
	route.Revision = s.revision
	plans := s.plansLocked(host, []*Route{route})
	return append(plans, s.refreshPrepareLocked(host, route)...), nil
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
	host := s.hostPeerIDLocked()
	plans := s.plansLocked(host, []*Route{route})
	return append(plans, s.refreshPrepareLocked(host, route)...)
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
	host := s.hostPeerIDLocked()
	if host == "" {
		return "", false
	}
	var route *Route
	for _, candidate := range s.routes {
		if candidate.ConnectionID == connectionID {
			route = candidate
			break
		}
	}
	if route == nil {
		return "", false
	}
	switch senderID {
	case host:
		if kind == SignalAnswer {
			// 房主永远发 offer，发 answer 说明两端角色串了。
			return "", false
		}
		return route.ChildPeerID, true
	default:
		if route.ChildPeerID != senderID {
			return "", false
		}
		if kind == SignalOffer {
			return "", false
		}
		return host, true
	}
}

// RouteCount 返回当前边数（测试与诊断用）。
func (s *Session) RouteCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.routes)
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

// plansLocked 把若干条边转成「房主一份 + 观众一份」的下发计划。
func (s *Session) plansLocked(host string, routes []*Route) []RoutePlan {
	if host == "" || len(routes) == 0 {
		return nil
	}
	assignment := s.assignmentLocked()
	plans := make([]RoutePlan, 0, len(routes)*2)
	for _, route := range routes {
		candidate := Candidate{
			ChildPeerID:  route.ChildPeerID,
			ConnectionID: route.ConnectionID,
			Transport:    TransportDirect,
		}
		message := RouteMessage{
			T:          TypeRoute,
			RoomID:     s.roomID,
			Revision:   route.Revision,
			Phase:      route.Phase,
			Assignment: assignment,
			Candidate:  &candidate,
		}
		plans = append(plans,
			RoutePlan{ToPeerID: host, Message: message},
			RoutePlan{ToPeerID: route.ChildPeerID, Message: message},
		)
	}
	return plans
}

// refreshPrepareLocked 给仍在 prepare 的边补发一次 prepare。
//
// 每次 revision 推进都会让在途的 prepare 过期（栅栏要求完全相等），
// 不刷新的话第二个观众的 route-ready 永远被丢弃。exclude 是刚刚处理过的那条。
func (s *Session) refreshPrepareLocked(host string, exclude *Route) []RoutePlan {
	if host == "" {
		return nil
	}
	pending := make([]*Route, 0, len(s.routes))
	for _, route := range s.routes {
		if route == exclude || route.Phase != PhasePrepare {
			continue
		}
		route.Revision = s.revision
		pending = append(pending, route)
	}
	return s.plansLocked(host, pending)
}

// dropRoutesForLocked 移除某条连接相关的边。房主离开时全部移除。
func (s *Session) dropRoutesForLocked(socketID string, isHost bool) {
	for childPeerID := range s.routes {
		if isHost || childPeerID == socketID {
			delete(s.routes, childPeerID)
		}
	}
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
		candidates = append(candidates, Candidate{
			ChildPeerID:  route.ChildPeerID,
			ConnectionID: route.ConnectionID,
			Transport:    TransportDirect,
		})
	}
	return Assignment{Revision: s.revision, Phase: PhaseActive, Candidates: candidates}
}
