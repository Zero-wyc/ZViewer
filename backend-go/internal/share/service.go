package share

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log"
	"sync"
	"time"

	"zviewer/backend/internal/sio"
)

// Hub 是共享控制面需要的实时层能力子集。
//
// 用接口而不是直接依赖 *sio.Server：房间域已经这么做了（room.Hub），
// 好处是这里能用假 Hub 单测，不必起一条真的 socket.io 连接。
type Hub interface {
	// EmitRoom 向房间内所有连接广播（含发送者）。
	EmitRoom(roomID, event string, payload any)
	// EmitTo 只推给指定连接。
	EmitTo(socketID, event string, payload any)
}

// HostChecker 判定某条连接是否是房间房主。
//
// 由房间域实现（内部走 session 表 + 5s 缓存）。共享控制面不重复实现权限推理，
// 也不 import internal/room —— 那会形成循环依赖。
type HostChecker func(ctx context.Context, socketID, roomID string) (bool, error)

// Deps 是共享服务的依赖集合。
type Deps struct {
	Hub    Hub
	IsHost HostChecker
	Logger *log.Logger
	// DisplayName 返回连接的展示名（可选）。为 nil 时快照里的名字是空串。
	DisplayName func(socketID string) string
	// Relay 是 SFU 中继面（可选）。为 nil 时观众直连房主。
	Relay *Relay
	// Tree 是树形拓扑上限（可选）。零值 = 只有房主当上游。
	Tree TreePolicy
}

// Service 管理所有房间的共享会话。
//
// 生命周期：会话随第一条 hello 创建，最后一条连接 Detach 后删除。
// 不落库——与现状一致，进程重启后由房主重新 start 恢复。
type Service struct {
	hub         Hub
	isHost      HostChecker
	logger      *log.Logger
	displayName func(socketID string) string
	relay       *Relay
	tree        TreePolicy

	mu sync.Mutex
	// sessions 以 roomId 为键。
	sessions map[string]*Session
	// roomsBySocket 记录「哪条连接进过哪些房间」，Detach 时据此清理。
	// socket.io 的 rooms 列表在断线后已经没了，必须在连接期间自己记。
	roomsBySocket map[string]map[string]struct{}
}

// NewService 构造共享服务。
func NewService(deps Deps) *Service {
	logger := deps.Logger
	if logger == nil {
		logger = log.Default()
	}
	displayName := deps.DisplayName
	if displayName == nil {
		displayName = func(string) string { return "" }
	}
	return &Service{
		hub:           deps.Hub,
		isHost:        deps.IsHost,
		logger:        logger,
		displayName:   displayName,
		relay:         deps.Relay,
		tree:          deps.Tree,
		sessions:      make(map[string]*Session),
		roomsBySocket: make(map[string]map[string]struct{}),
	}
}

// Conn 是共享控制面需要的一条连接。
//
// 不直接收 *sio.Socket：那个类型只能由 sio.Server 构造，收到它就没法在
// 包外写单测。这里只留三个真正用到的东西，Bind 时装配一次。
type Conn struct {
	ID         string
	InRoom     func(roomID string) bool
	Disconnect func(reason string)
}

// connOf 把一条真实连接适配成 Conn。
func connOf(sc *sio.Socket) Conn {
	return Conn{
		ID:         sc.ID,
		InRoom:     sc.InRoom,
		Disconnect: sc.Disconnect,
	}
}

// Bind 把 `share` 事件挂到一条连接上。
func (s *Service) Bind(sc *sio.Socket) {
	conn := connOf(sc)
	sc.On(Event, func(args []json.RawMessage, _ func(...any)) {
		s.Handle(conn, args)
	})
}

// Session 返回某房间的共享会话（不存在时返回 nil）。
//
// 只给测试与后续阶段（P1 路由）用，外部改不到会话内部状态。
func (s *Service) Session(roomID string) *Session {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.sessions[roomID]
}

// EnsureSession 返回房间会话，不存在时创建。
func (s *Service) EnsureSession(roomID string) *Session {
	s.mu.Lock()
	defer s.mu.Unlock()
	session, ok := s.sessions[roomID]
	if !ok {
		session = newSession(roomID)
		// 中继模式与树形上限都是进程级配置，会话一建立就定死，运行期不再改。
		session.SetRelay(s.relay != nil)
		session.SetTree(s.tree)
		s.sessions[roomID] = session
	}
	return session
}

// Detach 清理一条断开的连接。房间域在断线回调里调用。
func (s *Service) Detach(socketID string) {
	s.mu.Lock()
	rooms := make([]string, 0, len(s.roomsBySocket[socketID]))
	for roomID := range s.roomsBySocket[socketID] {
		rooms = append(rooms, roomID)
	}
	delete(s.roomsBySocket, socketID)
	s.mu.Unlock()

	for _, roomID := range rooms {
		session := s.Session(roomID)
		if session == nil {
			continue
		}
		s.releaseRelayFor(socketID, roomID)
		snapshot, remaining := session.Leave(socketID)
		if !remaining {
			s.dropSession(roomID, session)
			continue
		}
		if s.hub != nil {
			s.hub.EmitRoom(roomID, Event, snapshot)
		}
		// 离开的如果是一位父节点，它下游的边已经随子树一起拆掉：这里补一次
		// 分配，把那批观众重挂到别的上游（Piik `route/departure_test.go` 的语义）。
		s.emitPlans(session.PlanRoutes())
	}
}

// DropRoom 丢弃整个房间的会话（房间关闭时调用）。
func (s *Service) DropRoom(roomID string) {
	s.releaseRelay(roomID)
	s.mu.Lock()
	session, ok := s.sessions[roomID]
	delete(s.sessions, roomID)
	s.mu.Unlock()
	if ok && session != nil && s.hub != nil {
		// 广播一份空快照，让还在房间里的客户端清掉画面。
		empty := newSession(roomID).Snapshot()
		s.hub.EmitRoom(roomID, Event, empty)
	}
}

// dropSession 只删「同一个对象」的会话，避免把别人的新会话误删。
func (s *Service) dropSession(roomID string, session *Session) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if current, ok := s.sessions[roomID]; ok && current == session && session.Empty() {
		delete(s.sessions, roomID)
	}
}

// trackRoom 记录「这条连接进过这个房间」。
func (s *Service) trackRoom(socketID, roomID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rooms, ok := s.roomsBySocket[socketID]
	if !ok {
		rooms = make(map[string]struct{}, 1)
		s.roomsBySocket[socketID] = rooms
	}
	rooms[roomID] = struct{}{}
}

// Handle 解码并分发一帧客户端消息。
func (s *Service) Handle(conn Conn, args []json.RawMessage) {
	raw := firstObject(args)
	if raw == nil {
		s.fail(conn, "", CodeInvalidMessage, "共享消息必须是 JSON 对象")
		return
	}
	message, err := DecodeClient(raw)
	if err != nil {
		// 未知 `t` 视为策略违例（Piik session.go:307-310 直接关闭连接）；
		// 其余解码失败只回报错误——字段写错不该踢掉观众的整个会话。
		s.fail(conn, "", CodeInvalidMessage, err.Error())
		if isUnknownType(err) {
			conn.Disconnect("share: unknown message type")
		}
		return
	}

	switch typed := message.(type) {
	case HelloMessage:
		s.handleHello(conn, typed)
	case StartMessage:
		s.handleStart(conn, typed)
	case StopMessage:
		s.handleStop(conn, typed)
	case PauseMessage:
		s.handlePause(conn, typed)
	case RouteReadyMessage:
		s.handleRouteReady(conn, typed)
	case TransportConnectedMessage:
		s.handleTransportConnected(conn, typed)
	case RouteFailedMessage:
		s.handleRouteFailed(conn, typed)
	case QualityMessage:
		s.handleQuality(conn, typed)
	case RestartMessage:
		s.handleRestart(conn, typed)
	case SignalMessage:
		s.handleSignal(conn, typed)
	case SFUSignalMessage:
		s.handleSFUSignal(conn, typed)
	default:
		s.fail(conn, roomIDOf(message), CodeNotImplemented, "该消息在当前版本尚未实现")
	}
}

func (s *Service) handleHello(conn Conn, message HelloMessage) {
	if !s.inRoom(conn, message.RoomID) {
		s.fail(conn, message.RoomID, CodeNoRoom, "不在该房间中")
		return
	}
	host, err := s.hostOf(conn, message.RoomID)
	if err != nil {
		s.logger.Printf("[share] 房主判定失败 room=%s socket=%s: %v", message.RoomID, conn.ID, err)
		s.fail(conn, message.RoomID, CodeNoRoom, "房间状态不可用")
		return
	}
	s.trackRoom(conn.ID, message.RoomID)
	session := s.EnsureSession(message.RoomID)
	snapshot := session.Join(conn.ID, s.displayName(conn.ID), host)
	s.emitTo(conn, snapshot)
	// 共享进行中新加入的观众要立刻拿到候选，不能等房主再点一次开始。
	s.reconcile(message.RoomID)
}

func (s *Service) handleStart(conn Conn, message StartMessage) {
	if !s.requireHost(conn, message.RoomID) {
		return
	}
	paused := message.Paused != nil && *message.Paused
	session := s.EnsureSession(message.RoomID)
	snapshot, err := session.Start(message.ShareGeneration, paused, message.QualitySettings)
	if err != nil {
		// 启动失败只回报错误、不断连：这是「房主重复点了开始」，
		// 与 stop/pause 携带过期代际（客户端已被替换）不是一回事。
		if errors.Is(err, ErrAlreadySharing) {
			s.fail(conn, message.RoomID, CodeForbidden, "共享已在进行中")
			return
		}
		s.fail(conn, message.RoomID, CodeForbidden, "共享启动失败")
		return
	}
	s.trackRoom(conn.ID, message.RoomID)
	// 发布身份必须在 reconcile 之前就位：候选要带上 publicationGeneration，
	// 观众拿到 route 才写得对 sfu-signal。
	s.bindRelayPublication(conn, session, message.RoomID, session.Generation())
	s.broadcast(message.RoomID, snapshot)
	s.reconcile(message.RoomID)
}

func (s *Service) handleStop(conn Conn, message StopMessage) {
	if !s.requireHost(conn, message.RoomID) {
		return
	}
	session := s.EnsureSession(message.RoomID)
	snapshot, err := session.Stop(message.ShareGeneration)
	if err != nil {
		s.failGeneration(conn, message.RoomID, err)
		return
	}
	s.releaseRelay(message.RoomID)
	s.broadcast(message.RoomID, snapshot)
}

func (s *Service) handlePause(conn Conn, message PauseMessage) {
	if !s.requireHost(conn, message.RoomID) {
		return
	}
	if message.Paused == nil {
		s.fail(conn, message.RoomID, CodeInvalidMessage, "paused is required")
		return
	}
	session := s.EnsureSession(message.RoomID)
	snapshot, err := session.SetPaused(message.ShareGeneration, *message.Paused)
	if err != nil {
		s.failGeneration(conn, message.RoomID, err)
		return
	}
	s.broadcast(message.RoomID, snapshot)
}

// handleRouteReady 提交一条候选（只接受 phase=prepare）。
//
// transport-connected 只是进度，route-ready 才是「观众已解出首帧」的证明
// （router.go:796-846）。两者不能合并。
func (s *Service) handleRouteReady(conn Conn, message RouteReadyMessage) {
	if !s.inRoom(conn, message.RoomID) {
		return
	}
	if message.Phase != PhasePrepare {
		// active 表示客户端重复上报，已经提交过，静默忽略。
		return
	}
	session := s.Session(message.RoomID)
	if session == nil {
		return
	}
	s.emitPlans(session.CommitRoute(conn.ID, message.Revision, message.ConnectionID))
}

// handleTransportConnected 只记进度，不提交、不推进版本。
func (s *Service) handleTransportConnected(
	conn Conn,
	message TransportConnectedMessage,
) {
	if !s.inRoom(conn, message.RoomID) {
		return
	}
	if session := s.Session(message.RoomID); session != nil {
		session.MarkRouteConnected(conn.ID, message.Revision, message.ConnectionID)
	}
}

// handleRouteFailed 换下一个候选；次数用完就彻底放弃并回报失败。
func (s *Service) handleRouteFailed(conn Conn, message RouteFailedMessage) {
	if !s.inRoom(conn, message.RoomID) {
		return
	}
	session := s.Session(message.RoomID)
	if session == nil {
		return
	}
	plans, status := session.FailRoute(conn.ID, message.Revision, message.ConnectionID)
	s.emitPlans(plans)
	if status != nil {
		s.emitTo(conn, *status)
	}
}

// handleQuality 收下一个观众侧质量窗口。
//
// 没有回报也没有错误：证据是尽力而为的输入，字段写错、版本过期、边已经不
// 存在的唯一处理就是忽略（观众不该因为「多报了一条统计」被踢掉会话）。
// 换父时返回的 plans 会把新候选发给上下游两端，与失败换父走同一条链路。
func (s *Service) handleQuality(conn Conn, message QualityMessage) {
	if !s.inRoom(conn, message.RoomID) {
		return
	}
	session := s.Session(message.RoomID)
	if session == nil {
		return
	}
	plans := session.ObserveQuality(conn.ID, message.Revision, message.ConnectionID, message.Window)
	if len(plans) == 0 {
		// 绝大多数窗口只是记账：不换父就没有任何下发。
		return
	}
	s.emitPlans(plans)
	// 换父改变了已提交的分配，必须广播一次快照：旧上游不会收到任何 route
	// 消息（它的边已经不属于它了），只能靠快照发现「这条边不在了」并销毁
	// 对应的 PC。否则它会继续为一条已作废的边编码，直到 ICE 自己超时。
	s.broadcast(message.RoomID, session.Snapshot())
}

// handleRestart 处理观众的恢复请求：重建则换新连接身份，否则原地 ICE 重启。
func (s *Service) handleRestart(conn Conn, message RestartMessage) {
	if !s.inRoom(conn, message.RoomID) {
		return
	}
	session := s.Session(message.RoomID)
	if session == nil {
		return
	}
	if s.relay != nil && session.IsRelayRoute(conn.ID, message.ConnectionID) && !message.Rebuild {
		// 不换身份的重启交给中继做 ICE restart；换身份（rebuild）走下面的
		// 常规链路：新 connectionId 会触发一次全新的订阅。
		s.relay.Restart(message.RoomID, conn.ID, message.ConnectionID)
		return
	}
	s.emitPlans(session.RestartRoute(conn.ID, message.ConnectionID, message.Rebuild))
}

// handleSignal 中继一条 SDP 或 ICE。
//
// 角色由会话判定（offer 只能房主发、answer 只能观众发），不是靠客户端自觉。
func (s *Service) handleSignal(conn Conn, message SignalMessage) {
	if !s.inRoom(conn, message.RoomID) {
		return
	}
	session := s.Session(message.RoomID)
	if session == nil {
		return
	}
	target, ok := session.SignalTarget(conn.ID, message.RoomID, message.ConnectionID, message.Kind)
	if !ok {
		// 未授权 / 角色串了 / 身份不存在一律静默丢弃（router.go:705-708）。
		return
	}
	if s.hub == nil {
		return
	}
	s.hub.EmitTo(target, Event, SignalRelayMessage{
		T:            TypeSignalRelay,
		RoomID:       message.RoomID,
		FromPeerID:   conn.ID,
		ConnectionID: message.ConnectionID,
		Kind:         message.Kind,
		Payload:      message.Payload,
	})
}

// reconcile 补齐缺的路由边并下发。
//
// 触发：房主开始共享、观众刚进会话。PlanRoutes 幂等，重复调用只补差额。
func (s *Service) reconcile(roomID string) {
	session := s.Session(roomID)
	if session == nil {
		return
	}
	s.emitPlans(session.PlanRoutes())
}

// emitPlans 下发一批 route 消息。
func (s *Service) emitPlans(plans []RoutePlan) {
	if s.hub == nil || len(plans) == 0 {
		return
	}
	for _, plan := range plans {
		s.hub.EmitTo(plan.ToPeerID, Event, plan.Message)
	}
}

// requireHost 校验房主身份，失败时已经回报错误。
func (s *Service) requireHost(conn Conn, roomID string) bool {
	if !s.inRoom(conn, roomID) {
		s.fail(conn, roomID, CodeNoRoom, "不在该房间中")
		return false
	}
	host, err := s.hostOf(conn, roomID)
	if err != nil {
		s.logger.Printf("[share] 房主判定失败 room=%s socket=%s: %v", roomID, conn.ID, err)
		s.fail(conn, roomID, CodeNoRoom, "房间状态不可用")
		return false
	}
	if !host {
		s.fail(conn, roomID, CodeForbidden, "只有房主可以操作共享")
		return false
	}
	return true
}

func (s *Service) inRoom(conn Conn, roomID string) bool {
	return roomID != "" && conn.InRoom(roomID)
}

func (s *Service) hostOf(conn Conn, roomID string) (bool, error) {
	if s.isHost == nil {
		return false, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return s.isHost(ctx, conn.ID, roomID)
}

// failGeneration 处理代际不匹配。
//
// 与 Piik 一致：stop/pause 携带过期代际 = 客户端已被替换，关闭连接
// （server.go:1382-1390）。这不是可以忽略的竞态，是「同一个房间有两个房主
// 标签页」的明确信号。
func (s *Service) failGeneration(conn Conn, roomID string, err error) {
	switch err {
	case ErrGenerationReplaced:
		s.fail(conn, roomID, CodeGenerationReplaced, "共享代际已被替换")
		conn.Disconnect("share: sharing generation replaced")
	case ErrNotSharing:
		s.fail(conn, roomID, CodeForbidden, "当前没有进行中的共享")
	default:
		s.fail(conn, roomID, CodeForbidden, "操作失败")
	}
}

// emitTo 只推给触发者。
func (s *Service) emitTo(conn Conn, message ServerMessage) {
	if s.hub == nil {
		return
	}
	s.hub.EmitTo(conn.ID, Event, message)
}

// broadcast 向房间内所有连接广播。
func (s *Service) broadcast(roomID string, message ServerMessage) {
	if s.hub == nil {
		return
	}
	s.hub.EmitRoom(roomID, Event, message)
}

// fail 回报一次失败。
func (s *Service) fail(conn Conn, roomID, code, message string) {
	if s.hub == nil {
		return
	}
	s.hub.EmitTo(conn.ID, Event, ErrorMessage{
		T:       TypeError,
		RoomID:  roomID,
		Code:    code,
		Message: message,
	})
}

// firstObject 取出事件参数里的第一个 JSON 对象。
func firstObject(args []json.RawMessage) json.RawMessage {
	if len(args) == 0 {
		return nil
	}
	trimmed := bytes.TrimSpace(args[0])
	if len(trimmed) == 0 {
		return nil
	}
	if trimmed[0] == '{' {
		return args[0]
	}
	// 兼容「被 stringify 两次」的帧。Socket.IO 自己就是 JSON 传输，客户端如果
	// 再 JSON.stringify 一次，这里收到的就是一个字符串字面量；不剥这一层的话
	// 整条 share 协议会静默失效（客户端一切正常，服务端一条都不认）。
	// 只认「字符串里裹着一个对象」，别的一律当非法帧。
	if trimmed[0] == '"' {
		var text string
		if err := json.Unmarshal(trimmed, &text); err == nil {
			inner := bytes.TrimSpace([]byte(text))
			if len(inner) > 0 && inner[0] == '{' {
				return json.RawMessage(inner)
			}
		}
	}
	return nil
}

// roomIDOf 取出消息的 roomId（用于失败回报时回填）。
func roomIDOf(message ClientMessage) string {
	switch typed := message.(type) {
	case HelloMessage:
		return typed.RoomID
	case StartMessage:
		return typed.RoomID
	case StopMessage:
		return typed.RoomID
	case PauseMessage:
		return typed.RoomID
	case RouteReadyMessage:
		return typed.RoomID
	case TransportConnectedMessage:
		return typed.RoomID
	case RouteFailedMessage:
		return typed.RoomID
	case RestartMessage:
		return typed.RoomID
	case SignalMessage:
		return typed.RoomID
	case SFUSignalMessage:
		return typed.RoomID
	default:
		return ""
	}
}

// isUnknownType 判断错误是否来自未知 `t`。
func isUnknownType(err error) bool {
	return errors.Is(err, ErrUnknownType)
}
