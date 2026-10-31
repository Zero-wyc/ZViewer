package share

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"sort"
	"strconv"
	"sync"
	"time"
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
	// routes 以 childPeerID 为键：每个观众最多一条上游边（Piik 的拓扑不变量）。
	routes map[string]*Route
}

// newSession 构造一个空会话。
func newSession(roomID string) *Session {
	return &Session{
		roomID:       roomID,
		participants: make(map[string]Participant),
		routes:       make(map[string]*Route),
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
	// 房主走了所有边都失效；观众走了只拆它自己那条。
	// 不清理的话后会话里留着一堆指向已消失连接的边，重新 hello 时
	// PlanRoutes 会认为「已有边」而不补发。
	// 房主走了所有边都失效；观众走了只拆它自己那条。
	// 不清理的话会话里会留着一堆指向已消失连接的边，重新 hello 时
	// PlanRoutes 会认为「已有边」而不补发。
	s.dropRoutesForLocked(socketID, participant.Role == RoleHost)
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
	s.paused = paused
	if quality != nil {
		s.quality = *quality
	}
	// 新代际作废所有旧边（旧 connectionId 属于上一代，不能复用）。
	// 重连分支（hint 命中）刻意不清：房主刷新后观众还能沿着原 connectionId
	// 走恢复链，不必等全量重建。
	s.routes = make(map[string]*Route)
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
	s.paused = false
	s.routes = make(map[string]*Route)
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
