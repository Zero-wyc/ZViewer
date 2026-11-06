package voicertc

// 语音控制面：成员表 + 计划计算 + 信令透传。
//
// 分工与 share 一致：这里只决定「谁在语音里、各自该收到谁」，媒体层的
// ConfigureVoice 只负责「按已授权的计划建连接、转发 RTP」。权限判定不落在
// 媒体层——媒体层拿到的每一份 plan 都是这里算过的。

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"log"
	"sort"
	"sync"

	"github.com/pion/webrtc/v4"

	"zviewer/backend/internal/share/sfu"
)

// HostChecker 判定某条连接是不是房间房主（复用房间域的 5 秒权限缓存）。
type HostChecker func(ctx context.Context, socketID, roomID string) (bool, error)

// Conn 是控制面需要的连接抽象。
//
// 不直接用 sio.Socket 是为了让整个包能脱离 socket 单测；装配层负责构造。
type Conn struct {
	ID     string
	InRoom func(roomID string) bool
}

// Deps 是语音控制面的依赖集合。
type Deps struct {
	// Media 是与屏幕共享共用的媒体面（同一对 UDP/TCP 端口）。
	Media *sfu.Media
	// Emit 把消息推给某条连接。
	Emit func(socketID string, message ServerMessage)
	// IsHost 判定房主（强制静音 / 移出语音要用）。
	IsHost HostChecker
	Logger *log.Logger
}

// Service 是语音控制面。
type Service struct {
	media  *sfu.Media
	emit   func(socketID string, message ServerMessage)
	isHost HostChecker
	logger *log.Logger

	mu    sync.Mutex
	rooms map[string]*roomVoice
}

// roomVoice 是一个房间的语音状态。
type roomVoice struct {
	revision int64
	// members 以 socketId 为键：ZViewer 一条 socket 就是一个成员，
	// 多标签页各自建 socket，天然就是多个成员。
	members map[string]*member
}

type member struct {
	connectionID string
	name         string
	muted        bool
}

// New 构造语音控制面。deps.Media 为 nil 时返回 nil（装配层按「未启用」处理）。
func New(deps Deps) *Service {
	if deps.Media == nil {
		return nil
	}
	logger := deps.Logger
	if logger == nil {
		logger = log.Default()
	}
	return &Service{
		media:  deps.Media,
		emit:   deps.Emit,
		isHost: deps.IsHost,
		logger: logger,
		rooms:  make(map[string]*roomVoice),
	}
}

// Available 报告语音控制面是否可用。
func (s *Service) Available() bool { return s != nil && s.media != nil }

// Handle 处理一帧上行消息。
func (s *Service) Handle(conn Conn, args []json.RawMessage) {
	if s == nil || len(args) == 0 {
		return
	}
	message, err := DecodeClient(args[0])
	if err != nil {
		// 畸形帧没有可信的 roomId，只能退化成一条不带房间的错误。
		s.fail(conn, "", CodeInvalidMessage, err.Error())
		return
	}
	switch typed := message.(type) {
	case JoinMessage:
		s.handleJoin(conn, typed)
	case LeaveMessage:
		s.handleLeave(conn, typed)
	case SignalMessage:
		s.handleSignal(conn, typed)
	case MuteMessage:
		s.handleMute(conn, typed)
	case KickMessage:
		s.handleKick(conn, typed)
	}
}

// Detach 在连接断开时清理它所有房间的语音成员身份。
func (s *Service) Detach(socketID string) {
	if s == nil || socketID == "" {
		return
	}
	s.mu.Lock()
	var rooms []string
	for roomID, room := range s.rooms {
		if _, ok := room.members[socketID]; ok {
			rooms = append(rooms, roomID)
		}
	}
	s.mu.Unlock()
	for _, roomID := range rooms {
		s.dropMember(roomID, socketID)
	}
}

// DropRoom 关闭整个房间的语音（房间关闭时调用）。
func (s *Service) DropRoom(roomID string) {
	if s == nil || roomID == "" {
		return
	}
	s.mu.Lock()
	room := s.rooms[roomID]
	delete(s.rooms, roomID)
	s.mu.Unlock()
	if room == nil {
		return
	}
	for peerID, m := range room.members {
		s.closeVoiceConnection(roomID, peerID, m.connectionID)
	}
}

// ==================== 处理函数 ====================

func (s *Service) handleJoin(conn Conn, message JoinMessage) {
	if !s.inRoom(conn, message.RoomID) {
		s.fail(conn, message.RoomID, CodeNotInRoom, "不在该房间中")
		return
	}
	s.mu.Lock()
	room := s.rooms[message.RoomID]
	if room == nil {
		room = &roomVoice{members: make(map[string]*member)}
		s.rooms[message.RoomID] = room
	}
	existing, existed := room.members[conn.ID]
	if !existed {
		room.members[conn.ID] = &member{connectionID: newConnectionID(), name: message.Name}
	} else if message.Name != "" && existing.name != message.Name {
		// 重连后昵称可能变了（改了用户名再进来）。
		existing.name = message.Name
	}
	s.mu.Unlock()

	if existed {
		// 重复 join 是幂等的：客户端重连后可能没收到上一次的 state。
		s.publish(message.RoomID)
		return
	}
	s.recompute(message.RoomID)
}

func (s *Service) handleLeave(conn Conn, message LeaveMessage) {
	if !s.inRoom(conn, message.RoomID) {
		return
	}
	s.mu.Lock()
	_, ok := s.memberLocked(message.RoomID, conn.ID)
	s.mu.Unlock()
	if !ok {
		return
	}
	s.dropMember(message.RoomID, conn.ID)
}

func (s *Service) handleSignal(conn Conn, message SignalMessage) {
	s.mu.Lock()
	member, ok := s.memberLocked(message.RoomID, conn.ID)
	if !ok {
		s.mu.Unlock()
		s.fail(conn, message.RoomID, CodeNotJoined, "尚未加入语音")
		return
	}
	// 信令只能打在自己那条连接上：拿别人的 connectionId 过来一律丢弃。
	if message.ConnectionID != member.connectionID {
		s.mu.Unlock()
		return
	}
	s.mu.Unlock()

	var signal sfu.VoiceSignal
	switch message.Kind {
	case "description":
		var description sfu.VoiceDescription
		if err := json.Unmarshal(message.Payload, &description); err != nil {
			return
		}
		signal.Description = &description
	case "candidate":
		var candidate webrtc.ICECandidateInit
		if err := json.Unmarshal(message.Payload, &candidate); err != nil {
			return
		}
		signal.Candidate = &candidate
	default:
		return
	}
	if err := s.media.SignalVoice(message.RoomID, conn.ID, conn.ID, message.ConnectionID, signal); err != nil {
		// 连接已退役（典型场景：成员刚被移出语音，迟到的 answer）。
		// 不回错误：客户端马上会收到新的 state，重发没有意义。
		s.logger.Printf("[voice] 信令被拒 room=%s peer=%s: %v", message.RoomID, conn.ID, err)
	}
}

func (s *Service) handleMute(conn Conn, message MuteMessage) {
	if !s.requireHost(conn, message.RoomID) {
		return
	}
	if message.PeerID == conn.ID {
		// 自己静音走客户端本地，不需要服务端中转。
		return
	}
	s.mu.Lock()
	room := s.rooms[message.RoomID]
	target := (*member)(nil)
	if room != nil {
		target = room.members[message.PeerID]
	}
	if target == nil {
		s.mu.Unlock()
		s.fail(conn, message.RoomID, CodePeerNotFound, "对方不在语音中")
		return
	}
	changed := target.muted != message.Muted
	target.muted = message.Muted
	s.mu.Unlock()
	if !changed {
		return
	}

	// 目标本人要知道「你被静音了」；其他人只需要一张新的成员表。
	s.emitTo(message.PeerID, MutedMessage{
		T: TypeMuted, RoomID: message.RoomID, PeerID: message.PeerID, Muted: message.Muted,
	})
	s.publish(message.RoomID)
}

func (s *Service) handleKick(conn Conn, message KickMessage) {
	if !s.requireHost(conn, message.RoomID) {
		return
	}
	s.mu.Lock()
	_, ok := s.memberLocked(message.RoomID, message.PeerID)
	s.mu.Unlock()
	if !ok {
		s.fail(conn, message.RoomID, CodePeerNotFound, "对方不在语音中")
		return
	}
	// 先告诉被移出的人，再改状态：反过来他会先收到一张「自己已经不在了」的
	// 成员表，却没有被移出的理由。
	s.emitTo(message.PeerID, KickedMessage{
		T: TypeKicked, RoomID: message.RoomID, PeerID: message.PeerID, Reason: "kicked",
	})
	s.dropMember(message.RoomID, message.PeerID)
}

// ==================== 计划与广播 ====================

// recompute 重算整个房间的语音计划、重建媒体连接并广播新状态。
//
// 星形拓扑：每位成员的 Publish 只有自己的麦克风，Subscribe 是其他人的全部。
// 成员进出是低频事件，全量重算比增量维护简单得多，也不会有「漏算一条边」
// 这种只有现场才复现的故障。
func (s *Service) recompute(roomID string) {
	s.mu.Lock()
	room := s.rooms[roomID]
	if room == nil {
		s.mu.Unlock()
		return
	}
	room.revision++
	peers := sortedPeers(room)
	publications := make([]sfu.VoicePublication, 0, len(peers))
	for _, peerID := range peers {
		publications = append(publications, publicationOf(peerID))
	}
	plans := make([]sfu.VoiceConnectionPlan, 0, len(peers))
	for _, peerID := range peers {
		own := publicationOf(peerID)
		subscribe := make([]sfu.VoicePublication, 0, len(publications)-1)
		for _, pub := range publications {
			if pub.ID != own.ID {
				subscribe = append(subscribe, pub)
			}
		}
		plans = append(plans, sfu.VoiceConnectionPlan{
			RoomID:       roomID,
			PeerID:       peerID,
			SessionID:    peerID,
			ConnectionID: room.members[peerID].connectionID,
			Publish:      []sfu.VoicePublication{own},
			Subscribe:    subscribe,
		})
	}
	snapshots := make(map[string]StateMessage, len(peers))
	for _, peerID := range peers {
		snapshots[peerID] = s.snapshotLocked(room, roomID, peerID)
	}
	s.mu.Unlock()

	// ConfigureVoice 在锁内完成授权记账，返回的 work 必须在锁外跑：
	// 它要做 SDP 协商，可能阻塞几十毫秒。
	//
	// **顺序不能反**：先把 work 收齐、把 `voice.state` 推到各成员，再跑协商。
	// 反过来（边配置边 `go work()`）offer 会抢在 state 之前到达客户端——那时
	// 客户端还没有 connectionId，按「不是我的连接」把 offer 丢掉，表现就是
	// 「已经在语音里，但媒体永远连不上」。
	type pendingWork struct {
		peerID string
		run    func() error
	}
	works := make([]pendingWork, 0, len(plans))
	for _, plan := range plans {
		work, err := s.media.ConfigureVoice(plan, s.onMediaEvent)
		if err != nil {
			s.logger.Printf("[voice] 连接配置失败 room=%s peer=%s: %v", roomID, plan.PeerID, err)
			continue
		}
		works = append(works, pendingWork{peerID: plan.PeerID, run: work})
	}
	for peerID, snapshot := range snapshots {
		s.emitTo(peerID, snapshot)
	}
	for _, item := range works {
		go func() {
			if err := item.run(); err != nil {
				s.logger.Printf("[voice] 协商失败 room=%s peer=%s: %v", roomID, item.peerID, err)
			}
		}()
	}
}

// publish 只刷新成员表（静音这类不改变计划的变化走这里）。
func (s *Service) publish(roomID string) {
	s.mu.Lock()
	room := s.rooms[roomID]
	if room == nil {
		s.mu.Unlock()
		return
	}
	room.revision++
	peers := sortedPeers(room)
	snapshots := make(map[string]StateMessage, len(peers))
	for _, peerID := range peers {
		snapshots[peerID] = s.snapshotLocked(room, roomID, peerID)
	}
	s.mu.Unlock()
	for peerID, snapshot := range snapshots {
		s.emitTo(peerID, snapshot)
	}
}

// onMediaEvent 把媒体层的 SDP / ICE 送回对端。
func (s *Service) onMediaEvent(event sfu.VoiceMediaEvent) {
	if s == nil || event.PeerID == "" {
		return
	}
	switch {
	case event.Description != nil:
		payload, err := json.Marshal(event.Description)
		if err != nil {
			return
		}
		s.emitTo(event.PeerID, SignalOutMessage{
			T: TypeSignal, RoomID: event.RoomID, ConnectionID: event.ConnectionID,
			Kind: "description", Payload: payload,
		})
	case event.Candidate != nil:
		payload, err := json.Marshal(event.Candidate)
		if err != nil {
			return
		}
		s.emitTo(event.PeerID, SignalOutMessage{
			T: TypeSignal, RoomID: event.RoomID, ConnectionID: event.ConnectionID,
			Kind: "candidate", Payload: payload,
		})
	case event.State == webrtc.PeerConnectionStateFailed:
		// 媒体层已判定这条连接失败：把它从成员表摘掉，让客户端看到
		// 「语音断了」，而不是「连着但没声音」。
		s.dropMember(event.RoomID, event.PeerID)
	}
}

// ==================== 内部 ====================

func (s *Service) dropMember(roomID, peerID string) {
	s.mu.Lock()
	room := s.rooms[roomID]
	if room == nil {
		s.mu.Unlock()
		return
	}
	m, ok := room.members[peerID]
	if !ok {
		s.mu.Unlock()
		return
	}
	delete(room.members, peerID)
	if len(room.members) == 0 {
		delete(s.rooms, roomID)
	}
	s.mu.Unlock()

	s.closeVoiceConnection(roomID, peerID, m.connectionID)
	s.recompute(roomID)
}

// closeVoiceConnection 退役媒体层的一条连接并完成物理关闭。
//
// 调用时不能持有 s.mu：close 会等在读的 goroutine 结束。
func (s *Service) closeVoiceConnection(roomID, peerID, connectionID string) {
	work := s.media.CloseVoice(roomID, peerID, peerID, connectionID)
	if work == nil {
		return
	}
	if err := work(); err != nil {
		s.logger.Printf("[voice] 关闭连接失败 room=%s peer=%s: %v", roomID, peerID, err)
	}
}

func (s *Service) memberLocked(roomID, peerID string) (*member, bool) {
	room := s.rooms[roomID]
	if room == nil {
		return nil, false
	}
	m, ok := room.members[peerID]
	return m, ok
}

// snapshotLocked 组装一份针对某个成员的快照。
//
// connectionId 只给**本人**：别人的连接身份对他没用，下发了反而给
// 「拿别人的 connectionId 发信令」留了试错素材。
func (s *Service) snapshotLocked(room *roomVoice, roomID, peerID string) StateMessage {
	self := room.members[peerID]
	peers := sortedPeers(room)
	members := make([]Member, 0, len(peers))
	for _, peer := range peers {
		m := room.members[peer]
		entry := Member{PeerID: peer, Name: m.name, Publishing: true, Muted: m.muted}
		if peer == peerID {
			entry.ConnectionID = m.connectionID
		}
		members = append(members, entry)
	}
	return StateMessage{
		T:        TypeState,
		RoomID:   roomID,
		Revision: room.revision,
		Self:     SelfState{PeerID: peerID, ConnectionID: self.connectionID, Muted: self.muted},
		Members:  members,
	}
}

func sortedPeers(room *roomVoice) []string {
	peers := make([]string, 0, len(room.members))
	for peerID := range room.members {
		peers = append(peers, peerID)
	}
	sort.Strings(peers)
	return peers
}

func (s *Service) requireHost(conn Conn, roomID string) bool {
	if !s.inRoom(conn, roomID) {
		s.fail(conn, roomID, CodeNotInRoom, "不在该房间中")
		return false
	}
	if s.isHost == nil {
		s.fail(conn, roomID, CodeUnavailable, "语音服务不可用")
		return false
	}
	host, err := s.isHost(context.Background(), conn.ID, roomID)
	if err != nil {
		s.fail(conn, roomID, CodeUnavailable, "房间状态不可用")
		return false
	}
	if !host {
		s.fail(conn, roomID, CodeNotHost, "只有房主可以操作")
		return false
	}
	return true
}

func (s *Service) inRoom(conn Conn, roomID string) bool {
	return roomID != "" && conn.InRoom != nil && conn.InRoom(roomID)
}

func (s *Service) emitTo(socketID string, message ServerMessage) {
	if socketID == "" || s.emit == nil {
		return
	}
	s.emit(socketID, message)
}

func (s *Service) fail(conn Conn, roomID, code, message string) {
	s.emitTo(conn.ID, ErrorMessage{T: TypeError, RoomID: roomID, Code: code, Message: message})
}

// newConnectionID 铸造一条语音连接身份。
func newConnectionID() string {
	var buffer [16]byte
	if _, err := rand.Read(buffer[:]); err != nil {
		// 随机源不可用时退回固定前缀：连接身份不是安全边界，
		// 它只需要在房间内唯一，而调用方会立刻覆盖这一次的返回值。
		return "vc_" + base64.RawURLEncoding.EncodeToString([]byte(randFallback))
	}
	return "vc_" + base64.RawURLEncoding.EncodeToString(buffer[:])
}

// randFallback 是随机源失效时的退路（几乎不可能发生，但不留 panic）。
const randFallback = "zviewer-voice"

// publicationOf 返回某位成员的发布身份。
//
// 刻意用「成员 id 派生」而不是每次随机：静音、换设备、重连期间只要成员还是
// 同一个人，订阅方的发送槽就一直是同一个 publication——重新铸造会让每个
// 订阅者每静音一次就重建一次 track。
func publicationOf(peerID string) sfu.VoicePublication {
	return sfu.VoicePublication{ID: "voice_" + peerID, PeerID: peerID}
}
