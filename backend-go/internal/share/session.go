package share

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"sort"
	"strconv"
	"sync"
	"time"

	"zviewer/backend/internal/share/piikroute"
)

// 会话级错误。文案不会直接透给用户（share 事件没有 ack 通道），
// 但错误码会经 share.error 下发，前端据此决定是重试还是重建。
var (
	// ErrGenerationReplaced 表示客户端手里的共享代际已过期。
	// Piik 的处理是关闭连接 4001（server.go:1382-1390），不是忽略消息。
	ErrGenerationReplaced = errors.New("sharing generation replaced")
	// ErrAlreadySharing 表示房主在共享进行中又发了一次 start。
	// Piik 回 sharing-start-failed/FORBIDDEN，但**不断连**（server.go:1453-1459）。
	ErrAlreadySharing = errors.New("already sharing")
	// ErrNotSharing 表示当前没有共享，却收到了 stop/pause。
	ErrNotSharing = errors.New("not sharing")
)

// Session 是一个房间的共享状态。
//
// 并发模型：所有字段都由 mu 保护，对外只暴露返回值——没有返回内部引用的
// 方法，避免调用方在锁外读写切片/map。Piik 的同名结构靠「回调一律在锁外」
// 保证不出错，这里用「不交出引用」达到同样效果，代码少一半。
type Session struct {
	mu sync.Mutex

	roomID string
	// sharing 为 true 表示房主已开始共享（快照里的 sharing 字段）。
	sharing bool
	// generation 是共享代际。每次 start 铸造一个新的，
	// stop/pause 必须携带它，携带错了就是过期客户端。
	generation string
	// revision 是路由版本，任何状态变化都要 +1。
	revision int64
	paused   bool
	quality  QualitySettings
	// participants 以 socketId 为键：P0 里 peerId 就等于 socketId。
	participants map[string]Participant
	// joinOrder 记入座顺序，只用于把参与者交给选路引擎时的确定性排序。
	// 遍历 map 的随机顺序会让「谁先被服务」在每次重建引擎时都不一样。
	joinOrder map[string]int64
	nextOrder int64
	// routes 以 childPeerID 为键：每个观众最多一条上游边（Piik 的拓扑不变量）。
	routes map[string]*Route
	// tree 是树形拓扑的上限。零值 = 单层星形（只有房主当上游）。
	tree TreePolicy
	// engine 是直连模式的选路控制器（Piik route），由房主出现时惰性构造。
	engine     *piikroute.Engine
	engineHost string
	// afterFunc 排候选超时（测试注入）。nil 表示不排定时器。
	afterFunc func(time.Duration, func()) func()
	// onPlans 把定时器推进出来的计划交给装配层下发。
	onPlans func([]RoutePlan)
	// clock 是选路引擎的时间源（测试注入）。
	clock           func() int64
	timerStop       func()
	timerGeneration int
	// relay 表示本房间的观众走 SFU 中继（candidate.transport = relay）。
	// 由装配层按配置设置，进程内不变。
	relay bool
	// publication 是本代际里房主那条上行的身份（relay 模式才有）。
	// 它必须随代际作废：上一代的发布代际在新一代里是伪身份。
	publication string
}

// newSession 构造一个空会话。
func newSession(roomID string) *Session {
	return &Session{
		roomID:       roomID,
		participants: make(map[string]Participant),
		joinOrder:    make(map[string]int64),
		routes:       make(map[string]*Route),
		// 会话自己的默认值保持单层星形：出厂值由装配层（config / Service）
		// 显式传进来，这里不替它猜。
		tree: TreePolicy{MaxDepth: 1},
	}
}

// RoomID 返回所属房间。
func (s *Session) RoomID() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.roomID
}

// Generation 返回当前共享代际（未共享时为空串）。
func (s *Session) Generation() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.generation
}

// SetRelay 设置本房间是否走 SFU 中继。
//
// 只在装配时调用一次；运行期改它会让在跑的边和新的候选语义不一致。
func (s *Session) SetRelay(enabled bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.relay = enabled
}

// SetTree 设置本房间的树形上限（装配期一次，运行期不改）。
//
// 改它不会重排已有的边：控制器按新的容量在下一轮调度里自然收敛。
func (s *Session) SetTree(policy TreePolicy) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.tree = policy
	if s.engine != nil {
		// 已经有引擎在跑：参数变了只能重建，控制器构造时才会读这些值。
		s.dropEngineLocked()
	}
}

// SetHooks 注入超时定时器与下发回调（装配期一次）。
func (s *Session) SetHooks(afterFunc func(time.Duration, func()) func(), onPlans func([]RoutePlan)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.afterFunc = afterFunc
	s.onPlans = onPlans
}

// Close 释放会话持有的定时器。
func (s *Session) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.dropEngineLocked()
}

// SetPublication 记录本代际的发布身份（由 relay 铸造）。
func (s *Session) SetPublication(publicationGeneration string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.publication = publicationGeneration
}

// Relay 报告本房间是否走中继。
func (s *Session) Relay() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.relay
}

// Revision 返回当前路由版本。
func (s *Session) Revision() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.revision
}

// Snapshot 生成一份完整快照。
//
// 返回值一律是拷贝：participants 切片每次新建，调用方改它不会污染会话。
func (s *Session) Snapshot() SnapshotMessage {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.snapshotLocked()
}

func (s *Session) snapshotLocked() SnapshotMessage {
	participants := make([]Participant, 0, len(s.participants))
	for _, participant := range s.participants {
		participants = append(participants, participant)
	}
	// 房主在前，其余按 peerId 稳定排序：前端据此渲染名单，
	// 靠 map 的随机顺序会让列表每帧重排。
	sort.Slice(participants, func(i, j int) bool {
		leftHost := participants[i].Role == RoleHost
		rightHost := participants[j].Role == RoleHost
		if leftHost != rightHost {
			return leftHost
		}
		return participants[i].PeerID < participants[j].PeerID
	})
	var assignment *Assignment
	if computed := s.assignmentLocked(); len(computed.Candidates) > 0 {
		copied := computed
		copied.Candidates = append([]Candidate(nil), computed.Candidates...)
		assignment = &copied
	}
	return SnapshotMessage{
		T:               TypeSnapshot,
		RoomID:          s.roomID,
		ShareGeneration: s.generation,
		Revision:        s.revision,
		Paused:          s.paused,
		Sharing:         s.sharing,
		QualitySettings: s.quality,
		Participants:    participants,
		Assignment:      assignment,
	}
}

// Join 把一条连接登记为参与者（幂等）。
//
// 角色是房主还是观众由房间域判定后传入，会话本身不做权限推理。
func (s *Session) Join(socketID, displayName string, host bool) SnapshotMessage {
	s.mu.Lock()
	defer s.mu.Unlock()
	role := RoleViewer
	if host {
		role = RoleHost
	}
	existing, ok := s.participants[socketID]
	if ok && existing.Role == role && existing.DisplayName == displayName {
		// 重复 hello：状态没变就不推进 revision，避免前端被无意义的新版本号推着重建。
		return s.snapshotLocked()
	}
	s.participants[socketID] = Participant{
		PeerID:      socketID,
		SocketID:    socketID,
		Role:        role,
		DisplayName: displayName,
		MediaReady:  existing.MediaReady,
	}
	if _, ok := s.joinOrder[socketID]; !ok {
		s.nextOrder++
		s.joinOrder[socketID] = s.nextOrder
	}
	// 房主换了身份，整个选路图作废：控制器的房主是构造期钉死的。
	if host && s.engine != nil && s.engineHost != socketID {
		s.dropEngineLocked()
	}
	if s.engine != nil {
		s.engine.Join(socketID, role, existing.MediaReady)
	}
	s.bumpLocked()
	return s.snapshotLocked()
}

// Leave 移除一条连接。返回移除后是否还有参与者，以及新的快照。
func (s *Session) Leave(socketID string) (SnapshotMessage, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	participant, ok := s.participants[socketID]
	if !ok {
		return s.snapshotLocked(), len(s.participants) > 0
	}
	delete(s.participants, socketID)
	delete(s.joinOrder, socketID)
	// 房主走了所有边都失效；观众走了只拆它自己那条。
	// 不清理的话后会话里留着一堆指向已消失连接的边，重新 hello 时
	// PlanRoutes 会认为「已有边」而不补发。
	// 房主走了所有边都失效；观众走了只拆它自己那条。
	// 不清理的话会话里会留着一堆指向已消失连接的边，重新 hello 时
	// PlanRoutes 会认为「已有边」而不补发。
	s.dropRoutesForLocked(socketID, participant.Role == RoleHost)
	if participant.Role == RoleHost {
		s.dropEngineLocked()
	} else if s.engine != nil {
		s.engine.Leave(socketID)
	}
	s.bumpLocked()
	return s.snapshotLocked(), len(s.participants) > 0
}

// Empty 返回会话里是否已经没有参与者。
func (s *Session) Empty() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.participants) == 0
}

// Start 开始一代新共享。
//
// hint 是客户端上次看到的代际：
//   - hint 非空且等于当前代际 → 视为重连，沿用同一代（不铸造新代际，
//     否则房主刷新会把所有观众刚建立的连接判成过期）；
//   - 否则铸造新代际，并清空路由与暂停态。
func (s *Session) Start(hint *string, paused bool, quality *QualitySettings) (SnapshotMessage, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if hint != nil && *hint != "" && *hint == s.generation && s.sharing {
		// 重连：只同步暂停态与档位，不新开一代。
		s.paused = paused
		if quality != nil {
			s.quality = *quality
		}
		s.bumpLocked()
		return s.snapshotLocked(), nil
	}
	if s.sharing {
		// 已经有另一代在跑：这是「房主重复点开始」，不断连也不替换。
		return s.snapshotLocked(), ErrAlreadySharing
	}
	s.sharing = true
	s.generation = newGeneration()
	s.publication = ""
	s.paused = paused
	if quality != nil {
		s.quality = *quality
	}
	// 新代际作废所有旧边（旧 connectionId 属于上一代，不能复用）。
	// 重连分支（hint 命中）刻意不清：房主刷新后观众还能沿着原 connectionId
	// 走恢复链，不必等全量重建。
	s.routes = make(map[string]*Route)
	s.dropEngineLocked()
	s.bumpLocked()
	return s.snapshotLocked(), nil
}

// Stop 结束共享。generation 必须是当前代际。
func (s *Session) Stop(generation string) (SnapshotMessage, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.sharing {
		return s.snapshotLocked(), ErrNotSharing
	}
	if generation != s.generation {
		return s.snapshotLocked(), ErrGenerationReplaced
	}
	s.sharing = false
	s.generation = ""
	s.publication = ""
	s.paused = false
	s.routes = make(map[string]*Route)
	s.dropEngineLocked()
	s.bumpLocked()
	return s.snapshotLocked(), nil
}

// SetPaused 暂停/恢复共享。generation 必须是当前代际。
func (s *Session) SetPaused(generation string, paused bool) (SnapshotMessage, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.sharing {
		return s.snapshotLocked(), ErrNotSharing
	}
	if generation != s.generation {
		return s.snapshotLocked(), ErrGenerationReplaced
	}
	if s.paused == paused {
		// 幂等：同值重复设置不推进 revision。
		return s.snapshotLocked(), nil
	}
	s.paused = paused
	s.bumpLocked()
	return s.snapshotLocked(), nil
}

// MarkMediaReady 记录某个参与者已出首帧。
//
// P0 只维护标志位；P2 的路由提交（route-ready）会复用它。
func (s *Session) MarkMediaReady(socketID string, ready bool) SnapshotMessage {
	s.mu.Lock()
	defer s.mu.Unlock()
	participant, ok := s.participants[socketID]
	if !ok || participant.MediaReady == ready {
		return s.snapshotLocked()
	}
	participant.MediaReady = ready
	s.participants[socketID] = participant
	if s.engine != nil {
		s.engine.SetReady(socketID, ready)
	}
	s.bumpLocked()
	return s.snapshotLocked()
}

// bumpLocked 推进路由版本。调用方必须持有 mu。
func (s *Session) bumpLocked() {
	s.revision++
}

// newGeneration 铸造一个共享代际。
//
// 前缀 `share_` 让日志与抓包里一眼能看出这是服务端铸造的值——
// 客户端自造的同名字段会被代际比对挡掉，不需要额外校验。
func newGeneration() string {
	var buffer [16]byte
	if _, err := rand.Read(buffer[:]); err != nil {
		return "share_" + strconv.FormatInt(time.Now().UnixNano(), 36)
	}
	return "share_" + base64.RawURLEncoding.EncodeToString(buffer[:])
}
