package sio

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"sync"
	"time"
)

// 默认值与 Node 侧 `new SocketIOServer(httpServer, {...})` 对齐。
// maxHttpBufferSize 特意放到 20MB：房主广播的 subtitle-update 带完整 ASS 轨道时可到数 MB，
// 默认 1MB 会让大字幕同步静默失败（客户端看到的是连接被断开）。
const (
	DefaultPingInterval = 25 * time.Second
	DefaultPingTimeout  = 20 * time.Second
	DefaultMaxPayload   = 20 * 1024 * 1024
)

// errSessionClosed 表示会话已不可用。
var errSessionClosed = errors.New("sio: 会话已关闭")

// Options 是服务端参数。
type Options struct {
	PingInterval time.Duration
	PingTimeout  time.Duration
	MaxPayload   int64
}

func (o Options) withDefaults() Options {
	if o.PingInterval <= 0 {
		o.PingInterval = DefaultPingInterval
	}
	if o.PingTimeout <= 0 {
		o.PingTimeout = DefaultPingTimeout
	}
	if o.MaxPayload <= 0 {
		o.MaxPayload = DefaultMaxPayload
	}
	return o
}

// Handshake 是一次连接握手的输入，对应 Node 的 `socket.handshake`。
type Handshake struct {
	// Query 是建立传输时的 URL 参数（socket.io-client 会把 `query` 选项塞这里）。
	Query url.Values
	// Headers 是首个 HTTP 请求的头，鉴权要靠它拿 Cookie。
	Headers http.Header
	// Auth 是 CONNECT 包里带的 auth 对象（`io(url, { auth: {...} })`）。
	Auth map[string]json.RawMessage
	// Data 由 UseAuth 填充，之后成为 socket.data，等价于 Node 的
	// `Object.assign(socket.data, payload)`。
	Data map[string]any
}

// Server 是 Socket.IO 服务端，实现 http.Handler。
//
// 挂在 `/socket.io/` 路径上即可，其余路径不受影响。
type Server struct {
	opts Options

	mu       sync.Mutex
	sessions map[string]*session

	// roomsMu 同时保护 rooms 与 sockets：两者都在连接建立/断开时更新，
	// 拆成两把锁会在「加入房间的同时断线」时留下幽灵成员。
	roomsMu sync.RWMutex
	rooms   map[string]map[*Socket]struct{}
	sockets map[*Socket]struct{}

	authFn     func(*Handshake) error
	packetAuth func(*Socket) error
	connect    func(*Socket)
}

// NewServer 构造服务端，参数为零值时套用 Node 侧默认值。
func NewServer(opts Options) *Server {
	return &Server{
		opts:     opts.withDefaults(),
		sessions: make(map[string]*session),
		rooms:    make(map[string]map[*Socket]struct{}),
		sockets:  make(map[*Socket]struct{}),
	}
}

// UseAuth 注册鉴权钩子，对应 Node 的 `io.use(socketAuthMiddleware)`。
// 返回错误则给客户端发 connect_error，连接建立不起来。
func (s *Server) UseAuth(fn func(*Handshake) error) { s.authFn = fn }

// UsePacketAuth 注册逐包鉴权钩子，对应 Node 的 `socket.use(...)`。
//
// 返回错误时会先断开连接再丢弃该包。存在的理由很具体：令牌可能在建连之后
// 被撤销（改密码、管理员封禁），只在握手时校验等于「已登录的旧连接永久有效」。
func (s *Server) UsePacketAuth(fn func(*Socket) error) { s.packetAuth = fn }

// OnConnect 注册连接建立后的回调，对应 Node 的 `io.on('connection')`。
func (s *Server) OnConnect(fn func(*Socket)) { s.connect = fn }

// session 是一条 Engine.IO 会话（一个客户端可能先后用轮询和 WebSocket 两条连接）。
type session struct {
	id  string
	srv *Server

	query   url.Values
	headers http.Header

	mu       sync.Mutex
	queue    []string
	wake     chan struct{}
	closed   bool
	upgraded bool
	ws       *wsConn
	lastPong time.Time
	socket   *Socket
}

// ---------------------------------------------------------------------------
// HTTP 入口
// ---------------------------------------------------------------------------

// ServeHTTP 处理 `/socket.io/` 下的全部请求。
//
// 请求形态由 EIO / transport / sid 三个参数决定，与 engine.io 服务端的
// handleRequest 判定顺序一致。
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	if q.Get("EIO") != "4" {
		// 客户端只可能是 v4（socket.io-client 4.x）；v3 的编码完全不同，
		// 与其半懂不懂地兼容，不如明确拒绝。
		writeJSONError(w, http.StatusBadRequest, 5, "Unsupported protocol version")
		return
	}
	transport := q.Get("transport")
	sid := q.Get("sid")

	switch {
	case transport == "polling" && r.Method == http.MethodGet && sid == "":
		s.handlePollingOpen(w, r)
	case transport == "polling" && r.Method == http.MethodGet:
		s.handlePollingPoll(w, r, sid)
	case transport == "polling" && r.Method == http.MethodPost:
		s.handlePollingPost(w, r, sid)
	case transport == "websocket" && r.Method == http.MethodGet:
		s.handleWebSocket(w, r, sid)
	default:
		writeJSONError(w, http.StatusBadRequest, 3, "Bad request")
	}
}

func writeJSONError(w http.ResponseWriter, status, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	body, _ := json.Marshal(map[string]any{"code": code, "message": msg})
	_, _ = w.Write(body)
}

// handshakeJSON 生成 open 包载荷。
//
// 直连 WebSocket（没走轮询）时 upgrades 必须是空数组，
// 否则客户端会尝试再次升级自己。
func (s *Server) handshakeJSON(sid string, allowUpgrade bool) string {
	upgrades := []string{}
	if allowUpgrade {
		upgrades = []string{"websocket"}
	}
	payload := struct {
		Sid          string   `json:"sid"`
		Upgrades     []string `json:"upgrades"`
		PingInterval int      `json:"pingInterval"`
		PingTimeout  int      `json:"pingTimeout"`
		MaxPayload   int      `json:"maxPayload"`
	}{
		Sid:          sid,
		Upgrades:     upgrades,
		PingInterval: int(s.opts.PingInterval / time.Millisecond),
		PingTimeout:  int(s.opts.PingTimeout / time.Millisecond),
		MaxPayload:   int(s.opts.MaxPayload),
	}
	b, _ := json.Marshal(payload)
	return string(b)
}

// handlePollingOpen 处理首个 GET：建会话并返回 open 包。
func (s *Server) handlePollingOpen(w http.ResponseWriter, r *http.Request) {
	sess := s.newSession(r)
	w.Header().Set("Content-Type", "text/plain; charset=UTF-8")
	w.WriteHeader(http.StatusOK)
	_, _ = io.WriteString(w, string(eioOpen)+s.handshakeJSON(sess.id, true))
}

// handlePollingPoll 处理长轮询 GET。
func (s *Server) handlePollingPoll(w http.ResponseWriter, r *http.Request, sid string) {
	sess := s.session(sid)
	if sess == nil {
		writeJSONError(w, http.StatusBadRequest, 1, "Session ID unknown")
		return
	}
	payload, err := sess.poll(r)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, 1, "Session ID unknown")
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=UTF-8")
	w.WriteHeader(http.StatusOK)
	_, _ = io.WriteString(w, payload)
}

// handlePollingPost 处理客户端上行包。
//
// 响应体必须是字面量 `ok`（engine.io 客户端只检查状态码，但代理/测试会比对内容），
// Content-Type 用 text/html 与 engine.io 服务端一致。
func (s *Server) handlePollingPost(w http.ResponseWriter, r *http.Request, sid string) {
	sess := s.session(sid)
	if sess == nil {
		writeJSONError(w, http.StatusBadRequest, 1, "Session ID unknown")
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, s.opts.MaxPayload))
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, 3, "Bad request")
		return
	}
	for _, pkt := range splitPayload(string(body)) {
		if pkt == "" {
			continue
		}
		s.handleEnginePacket(sess, pkt)
	}
	w.Header().Set("Content-Type", "text/html")
	w.WriteHeader(http.StatusOK)
	_, _ = io.WriteString(w, "ok")
}

// handleWebSocket 处理 WebSocket 传输：sid 为空是直连，否则是轮询→WebSocket 升级。
func (s *Server) handleWebSocket(w http.ResponseWriter, r *http.Request, sid string) {
	var sess *session
	probing := false
	if sid != "" {
		sess = s.session(sid)
		if sess == nil {
			writeJSONError(w, http.StatusBadRequest, 1, "Session ID unknown")
			return
		}
		probing = true
	}
	ws, err := upgradeWebSocket(w, r, s.opts.MaxPayload)
	if err != nil {
		return
	}
	if sess == nil {
		sess = s.newSession(r)
		sess.mu.Lock()
		sess.upgraded = true
		sess.ws = ws
		sess.mu.Unlock()
		_ = ws.WriteText(string(eioOpen) + s.handshakeJSON(sess.id, false))
	}
	go s.readWSLoop(sess, ws, probing)
}

// readWSLoop 是 WebSocket 的读循环，同时负责 probe 升级握手。
func (s *Server) readWSLoop(sess *session, ws *wsConn, probing bool) {
	defer ws.Close()
	upgraded := !probing
	for {
		msg, err := ws.ReadMessage()
		if err != nil {
			if upgraded {
				s.closeSession(sess, "transport close")
			}
			return
		}
		switch {
		case msg == "2probe":
			// engine.io 服务端收到 probe 后会在**轮询**通道上补一个 noop，
			// 让挂起的长轮询立刻返回——否则客户端要等满 pingInterval 才能
			// 暂停轮询并完成升级，表现为「页面打开 25 秒后才转成 WebSocket」。
			_ = ws.WriteText("3probe")
			sess.enqueueRaw(string(eioNoop))
			continue
		case msg == string(eioUpgrade) && !upgraded:
			sess.mu.Lock()
			pending := sess.queue
			sess.queue = nil
			sess.upgraded = true
			sess.ws = ws
			sess.mu.Unlock()
			upgraded = true
			for _, pkt := range pending {
				_ = ws.WriteText(pkt)
			}
			continue
		}
		s.handleEnginePacket(sess, msg)
	}
}

// ---------------------------------------------------------------------------
// 会话
// ---------------------------------------------------------------------------

func (s *Server) newSession(r *http.Request) *session {
	sess := &session{
		id:       randomID(),
		srv:      s,
		query:    r.URL.Query(),
		headers:  r.Header.Clone(),
		wake:     make(chan struct{}),
		lastPong: time.Now(),
	}
	s.mu.Lock()
	s.sessions[sess.id] = sess
	s.mu.Unlock()
	go s.pingLoop(sess)
	return sess
}

func (s *Server) session(id string) *session {
	s.mu.Lock()
	defer s.mu.Unlock()
	sess := s.sessions[id]
	if sess == nil {
		return nil
	}
	sess.mu.Lock()
	closed := sess.closed
	sess.mu.Unlock()
	if closed {
		return nil
	}
	return sess
}

// enqueueRaw 投递一个 engine.io 包：已升级走 WebSocket，否则进轮询队列。
func (sess *session) enqueueRaw(pkt string) {
	sess.mu.Lock()
	if sess.closed {
		sess.mu.Unlock()
		return
	}
	if sess.upgraded && sess.ws != nil {
		ws := sess.ws
		sess.mu.Unlock()
		// 写失败说明连接已断，读循环会自行收尾
		_ = ws.WriteText(pkt)
		return
	}
	sess.queue = append(sess.queue, pkt)
	sess.signalLocked()
	sess.mu.Unlock()
}

// signalLocked 唤醒挂起的轮询。调用方必须持有 sess.mu。
func (sess *session) signalLocked() {
	close(sess.wake)
	sess.wake = make(chan struct{})
}

// poll 实现长轮询：有包立刻返回，否则等到有新包或超时（超时返回 noop）。
func (sess *session) poll(r *http.Request) (string, error) {
	sess.mu.Lock()
	if sess.closed {
		sess.mu.Unlock()
		return "", errSessionClosed
	}
	if len(sess.queue) > 0 {
		out := joinPayload(sess.queue)
		sess.queue = nil
		sess.mu.Unlock()
		return out, nil
	}
	wake := sess.wake
	sess.mu.Unlock()

	timer := time.NewTimer(sess.srv.opts.PingInterval)
	defer timer.Stop()

	for {
		select {
		case <-wake:
			sess.mu.Lock()
			if sess.closed {
				sess.mu.Unlock()
				return "", errSessionClosed
			}
			if len(sess.queue) > 0 {
				out := joinPayload(sess.queue)
				sess.queue = nil
				sess.mu.Unlock()
				return out, nil
			}
			wake = sess.wake
			sess.mu.Unlock()
		case <-timer.C:
			// 长轮询到期必须回一个 noop 维持通道，空响应会被客户端当成错误
			return string(eioNoop), nil
		case <-r.Context().Done():
			return "", r.Context().Err()
		}
	}
}

// pingLoop 每 pingInterval 发一次 ping，并在超过 pingInterval+pingTimeout
// 没收到 pong 时判定连接死亡。
//
// EIO v4 的 ping 由**服务端**发起（v3 是客户端发），所以这条主动链路必须存在，
// 否则半开连接（拔网线、休眠）永远不回收。
func (s *Server) pingLoop(sess *session) {
	ticker := time.NewTicker(s.opts.PingInterval)
	defer ticker.Stop()
	for range ticker.C {
		sess.mu.Lock()
		if sess.closed {
			sess.mu.Unlock()
			return
		}
		silent := time.Since(sess.lastPong)
		sess.mu.Unlock()
		if silent > s.opts.PingInterval+s.opts.PingTimeout {
			s.closeSession(sess, "ping timeout")
			return
		}
		sess.enqueueRaw(string(eioPing))
	}
}

func (s *Server) closeSession(sess *session, reason string) {
	sess.mu.Lock()
	if sess.closed {
		sess.mu.Unlock()
		return
	}
	sess.closed = true
	sc := sess.socket
	ws := sess.ws
	close(sess.wake)
	sess.wake = make(chan struct{})
	sess.queue = nil
	sess.mu.Unlock()

	s.mu.Lock()
	delete(s.sessions, sess.id)
	s.mu.Unlock()

	if sc != nil {
		s.detachSocket(sc, reason)
	}
	if ws != nil {
		_ = ws.Close()
	}
}

// ---------------------------------------------------------------------------
// 包分发
// ---------------------------------------------------------------------------

func (s *Server) handleEnginePacket(sess *session, pkt string) {
	if pkt == "" {
		return
	}
	switch pkt[0] {
	case eioPing:
		// 客户端主动 ping 只出现在 probe 阶段（`2probe` 的应答由读循环处理），
		// 其余情况按协议原样回 pong。
		sess.enqueueRaw(string(eioPong) + pkt[1:])
	case eioPong:
		sess.mu.Lock()
		sess.lastPong = time.Now()
		sess.mu.Unlock()
	case eioMessage:
		s.dispatchSio(sess, pkt)
	case eioUpgrade:
		// 直连 WebSocket 时客户端也会补一个 upgrade 包，忽略即可
	case eioClose:
		s.closeSession(sess, "client close")
	}
}

func (s *Server) dispatchSio(sess *session, raw string) {
	p, err := decodeSioPacket(raw)
	if err != nil {
		return
	}
	if p.Nsp != "/" {
		// 本项目没有多命名空间；按协议回 connect_error 而不是静默丢弃，
		// 否则客户端会一直挂在 "connecting" 状态。
		sess.enqueueRaw(sioPacket{
			Type: sioConnectError,
			Nsp:  p.Nsp,
			Data: `{"message":"Invalid namespace"}`,
		}.encode())
		return
	}
	switch p.Type {
	case sioConnect:
		s.attachSocket(sess, p.Data)
	case sioDisconnect:
		s.closeSession(sess, "client namespace disconnect")
	case sioEvent, sioBinaryEvent:
		s.dispatchEvent(sess, p)
	case sioAck, sioBinaryAck:
		sess.mu.Lock()
		sc := sess.socket
		sess.mu.Unlock()
		if sc != nil {
			sc.resolveAck(p)
		}
	}
}

func (s *Server) dispatchEvent(sess *session, p sioPacket) {
	var arr []json.RawMessage
	if err := json.Unmarshal([]byte(p.Data), &arr); err != nil || len(arr) == 0 {
		return
	}
	var name string
	if err := json.Unmarshal(arr[0], &name); err != nil {
		return
	}
	sess.mu.Lock()
	sc := sess.socket
	sess.mu.Unlock()
	if sc == nil {
		// 还没发 CONNECT 就发事件，按协议属于非法序列，丢弃
		return
	}
	if s.packetAuth != nil {
		// 与 Node 一致：鉴权失败直接断开，不执行处理器（也不回 ack）。
		if err := s.packetAuth(sc); err != nil {
			sc.Disconnect("io server disconnect")
			return
		}
	}
	ackID := int64(-1)
	if p.HasID {
		ackID = p.ID
	}
	sc.handleEvent(name, arr[1:], ackID)
}

func (s *Server) attachSocket(sess *session, authData string) {
	sess.mu.Lock()
	if sess.socket != nil || sess.closed {
		sess.mu.Unlock()
		return
	}
	sess.mu.Unlock()

	hs := &Handshake{
		Query:   sess.query,
		Headers: sess.headers,
		Auth:    map[string]json.RawMessage{},
		Data:    map[string]any{},
	}
	if authData != "" {
		_ = json.Unmarshal([]byte(authData), &hs.Auth)
	}
	if s.authFn != nil {
		if err := s.authFn(hs); err != nil {
			body, _ := json.Marshal(map[string]string{"message": err.Error()})
			sess.enqueueRaw(sioPacket{Type: sioConnectError, Data: string(body)}.encode())
			return
		}
	}

	sc := &Socket{
		ID:       sess.id,
		Nsp:      "/",
		Data:     hs.Data,
		srv:      s,
		sess:     sess,
		handlers: make(map[string]EventHandler),
		rooms:    make(map[string]struct{}),
		acks:     make(map[int64]func(...any)),
	}

	sess.mu.Lock()
	// Authentication can block while another POST connects, or the transport
	// closes. Recheck before publishing a socket, under the same lock as close.
	if sess.closed || sess.socket != nil {
		sess.mu.Unlock()
		return
	}
	sess.socket = sc
	// Publish the socket and its private room together, before closeSession can
	// detach it. Otherwise disconnect can finish just before these indexes grow.
	sc.rooms[sc.ID] = struct{}{}
	s.roomsMu.Lock()
	s.sockets[sc] = struct{}{}
	if s.rooms[sc.ID] == nil {
		s.rooms[sc.ID] = make(map[*Socket]struct{})
	}
	s.rooms[sc.ID][sc] = struct{}{}
	s.roomsMu.Unlock()
	sess.mu.Unlock()

	// CONNECT must precede events emitted by the business callback.
	sess.enqueueRaw(sioPacket{Type: sioConnect, Data: `{"sid":` + strconv.Quote(sc.ID) + `}`}.encode())

	if s.connect != nil {
		s.connect(sc)
	}
}

// ---------------------------------------------------------------------------
// 房间（服务端级）
// ---------------------------------------------------------------------------

// Membership mutations hold sc.mu then roomsMu, in that order. Both indexes
// must change atomically with respect to other mutations of the same socket.
// Readers of roomsMu release it before acquiring any socket lock.
func (s *Server) joinRoom(sc *Socket, room string) {
	sc.mu.Lock()
	defer sc.mu.Unlock()
	if sc.closed {
		return
	}
	sc.rooms[room] = struct{}{}

	s.roomsMu.Lock()
	set := s.rooms[room]
	if set == nil {
		set = make(map[*Socket]struct{})
		s.rooms[room] = set
	}
	set[sc] = struct{}{}
	s.roomsMu.Unlock()
}

func (s *Server) leaveRoom(sc *Socket, room string) {
	sc.mu.Lock()
	defer sc.mu.Unlock()
	delete(sc.rooms, room)

	s.roomsMu.Lock()
	if set := s.rooms[room]; set != nil {
		delete(set, sc)
		if len(set) == 0 {
			delete(s.rooms, room)
		}
	}
	s.roomsMu.Unlock()
}

func (s *Server) leaveAllRooms(sc *Socket) {
	sc.mu.Lock()
	defer sc.mu.Unlock()
	rooms := make([]string, 0, len(sc.rooms))
	for room := range sc.rooms {
		rooms = append(rooms, room)
	}
	sc.rooms = make(map[string]struct{})

	s.roomsMu.Lock()
	for _, room := range rooms {
		if set := s.rooms[room]; set != nil {
			delete(set, sc)
			if len(set) == 0 {
				delete(s.rooms, room)
			}
		}
	}
	s.roomsMu.Unlock()
}

// roomSockets 返回房间内当前在线成员（拷贝，便于无锁遍历）。
func (s *Server) roomSockets(room string) []*Socket {
	s.roomsMu.RLock()
	defer s.roomsMu.RUnlock()
	set := s.rooms[room]
	if len(set) == 0 {
		return nil
	}
	out := make([]*Socket, 0, len(set))
	for sc := range set {
		out = append(out, sc)
	}
	return out
}

func (s *Server) detachSocket(sc *Socket, reason string) {
	sc.mu.Lock()
	if sc.closed {
		sc.mu.Unlock()
		return
	}
	sc.closed = true
	handlers := sc.disconnectHandlers
	sc.disconnectHandlers = nil
	sc.acks = make(map[int64]func(...any))
	sc.mu.Unlock()

	// Mark closed before clearing memberships, so an in-flight Join cannot
	// reinsert this socket after leaveAllRooms has taken its snapshot.
	s.leaveAllRooms(sc)
	s.roomsMu.Lock()
	delete(s.sockets, sc)
	s.roomsMu.Unlock()

	for _, fn := range handlers {
		fn(reason)
	}
}

// allSockets 返回所有在线连接（拷贝），供 `io.emit` 这类全局广播使用。
func (s *Server) allSockets() []*Socket {
	s.roomsMu.RLock()
	defer s.roomsMu.RUnlock()
	out := make([]*Socket, 0, len(s.sockets))
	for sc := range s.sockets {
		out = append(out, sc)
	}
	return out
}

// To 返回面向指定房间的广播器。
func (s *Server) To(rooms ...string) *Broadcast {
	return &Broadcast{srv: s, rooms: rooms}
}

// SocketByID 返回指定 ID 的连接，不存在或已断开时返回 nil。
//
// 对应 Node 的 `io.sockets.sockets.get(id)`。socket ID 就是会话 ID，
// 直接查会话表即可，不必遍历全部连接（房间广播与踢人都是高频路径）。
func (s *Server) SocketByID(id string) *Socket {
	if id == "" {
		return nil
	}
	sess := s.session(id)
	if sess == nil {
		return nil
	}
	sess.mu.Lock()
	sc := sess.socket
	closed := sess.closed
	sess.mu.Unlock()
	if sc == nil || closed {
		return nil
	}
	sc.mu.Lock()
	gone := sc.closed
	sc.mu.Unlock()
	if gone {
		return nil
	}
	return sc
}

// Connected 判断指定 ID 的连接是否仍在线。
func (s *Server) Connected(id string) bool { return s.SocketByID(id) != nil }

// RoomSockets 返回房间内所有在线连接（拷贝，便于在遍历中踢人）。
func (s *Server) RoomSockets(room string) []*Socket { return s.roomSockets(room) }

// Emit 向所有已连接 socket 广播（io.emit）。
func (s *Server) Emit(event string, args ...any) {
	s.To().Emit(event, args...)
}

func randomID() string {
	var b [15]byte
	if _, err := rand.Read(b[:]); err != nil {
		return strconv.FormatInt(time.Now().UnixNano(), 36)
	}
	return base64.RawURLEncoding.EncodeToString(b[:])
}
