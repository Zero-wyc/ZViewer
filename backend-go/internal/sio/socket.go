package sio

import (
	"encoding/json"
	"sync"
)

// EventHandler 处理一个客户端事件。
//
// args 是事件名之后的位置参数，保留原始 JSON（调用方按需 json.Unmarshal）。
// ack 为 nil 表示客户端没有请求回执；非 nil 时可多次调用但只有第一次生效。
//
// 注意：handler 在传输读协程里**同步**执行，与 Node 的单线程事件循环等价。
// 里面做慢操作（几秒级）会同时卡住心跳与后续事件，需要并发时请自行 go 出去。
type EventHandler func(args []json.RawMessage, ack func(...any))

// Socket 是一条已连接的客户端，对应 Node 的 `socket` 对象。
type Socket struct {
	ID   string
	Nsp  string
	Data map[string]any

	srv  *Server
	sess *session

	mu                 sync.Mutex
	handlers           map[string]EventHandler
	rooms              map[string]struct{}
	acks               map[int64]func(...any)
	nextAck            int64
	closed             bool
	disconnectHandlers []func(string)
}

// On 注册事件处理器，对应 `socket.on(event, handler)`。
func (s *Socket) On(event string, fn EventHandler) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return
	}
	s.handlers[event] = fn
}

// OnDisconnect 注册断线回调，对应 `socket.on('disconnect', handler)`。
//
// reason 与 socket.io 的取值保持同名字符串（transport close / ping timeout /
// client namespace disconnect 等），前端按它区分「正常离开」与「掉线」。
func (s *Socket) OnDisconnect(fn func(reason string)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return
	}
	s.disconnectHandlers = append(s.disconnectHandlers, fn)
}

// Emit 向该客户端发送事件，对应 `socket.emit(event, ...args)`。
func (s *Socket) Emit(event string, args ...any) {
	data, err := encodeEventData(event, args)
	if err != nil {
		return
	}
	s.emitEncoded(sioPacket{Type: sioEvent, Data: data}.encode())
}

// EmitWithAck 发送事件并等待客户端回执，对应 `socket.emit(event, args, cb)`。
func (s *Socket) EmitWithAck(event string, ack func(...any), args ...any) {
	data, err := encodeEventData(event, args)
	if err != nil {
		return
	}
	s.mu.Lock()
	id := s.nextAck
	s.nextAck++
	if ack != nil {
		s.acks[id] = ack
	}
	s.mu.Unlock()
	s.emitEncoded(sioPacket{Type: sioEvent, ID: id, HasID: true, Data: data}.encode())
}

// Join 把该连接加入房间，对应 `socket.join(room)`。
func (s *Socket) Join(rooms ...string) {
	for _, room := range rooms {
		if room == "" {
			continue
		}
		s.srv.joinRoom(s, room)
	}
}

// Leave 退出房间，对应 `socket.leave(room)`。
func (s *Socket) Leave(rooms ...string) {
	for _, room := range rooms {
		s.srv.leaveRoom(s, room)
	}
}

// Rooms 返回当前所在房间（拷贝）。
func (s *Socket) Rooms() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]string, 0, len(s.rooms))
	for room := range s.rooms {
		out = append(out, room)
	}
	return out
}

// InRoom 判断是否在指定房间。
func (s *Socket) InRoom(room string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.rooms[room]
	return ok
}

// To 返回面向房间的广播器，**排除自己**——与 `socket.to(room).emit()` 语义一致。
func (s *Socket) To(rooms ...string) *Broadcast {
	return &Broadcast{
		srv:    s.srv,
		rooms:  rooms,
		except: map[*Socket]struct{}{s: {}},
	}
}

// Broadcast 返回面向所有连接、**排除自己**的广播器，对应 `socket.broadcast.emit()`。
func (s *Socket) Broadcast() *Broadcast {
	return &Broadcast{srv: s.srv, except: map[*Socket]struct{}{s: {}}}
}

// Disconnect 主动断开该连接（先发 DISCONNECT 包让客户端知道是服务端断的）。
func (s *Socket) Disconnect(reason string) {
	s.emitEncoded(sioPacket{Type: sioDisconnect}.encode())
	s.srv.closeSession(s.sess, reason)
}

// emitEncoded 投递一个已编码的包。
func (s *Socket) emitEncoded(pkt string) {
	s.mu.Lock()
	closed := s.closed
	s.mu.Unlock()
	if closed {
		return
	}
	s.sess.enqueueRaw(pkt)
}

// handleEvent 在传输读协程里执行注册的处理器。
func (s *Socket) handleEvent(name string, args []json.RawMessage, ackID int64) {
	s.mu.Lock()
	fn := s.handlers[name]
	s.mu.Unlock()
	if fn == nil {
		return
	}
	var ack func(...any)
	if ackID >= 0 {
		var once sync.Once
		ack = func(vals ...any) {
			once.Do(func() { s.sendAck(ackID, vals) })
		}
	}
	fn(args, ack)
}

func (s *Socket) sendAck(id int64, vals []any) {
	if vals == nil {
		// json.Marshal(nil) 得到 `null` 而不是 `[]`，客户端会当成非数组回执
		vals = []any{}
	}
	body, err := json.Marshal(vals)
	if err != nil {
		return
	}
	s.emitEncoded(sioPacket{Type: sioAck, ID: id, HasID: true, Data: string(body)}.encode())
}

// resolveAck 处理客户端回来的 ACK 包。
func (s *Socket) resolveAck(p sioPacket) {
	var vals []json.RawMessage
	if p.Data != "" {
		if err := json.Unmarshal([]byte(p.Data), &vals); err != nil {
			return
		}
	}
	s.mu.Lock()
	fn := s.acks[p.ID]
	delete(s.acks, p.ID)
	s.mu.Unlock()
	if fn == nil {
		return
	}
	args := make([]any, len(vals))
	for i, raw := range vals {
		var v any
		// 与 JS 一致：数字统一按 float64 解释
		if err := json.Unmarshal(raw, &v); err == nil {
			args[i] = v
		}
	}
	fn(args...)
}

// Broadcast 是面向一组目标的广播器，对应 `io.to(...)` / `socket.to(...)`。
type Broadcast struct {
	srv    *Server
	rooms  []string
	except map[*Socket]struct{}
}

// Except 追加排除的 socket（返回新对象，便于链式复用同一 rooms）。
func (b *Broadcast) Except(sockets ...*Socket) *Broadcast {
	except := make(map[*Socket]struct{}, len(b.except)+len(sockets))
	for sc := range b.except {
		except[sc] = struct{}{}
	}
	for _, sc := range sockets {
		except[sc] = struct{}{}
	}
	return &Broadcast{srv: b.srv, rooms: b.rooms, except: except}
}

// Emit 向目标广播事件。
func (b *Broadcast) Emit(event string, args ...any) {
	data, err := encodeEventData(event, args)
	if err != nil {
		return
	}
	pkt := sioPacket{Type: sioEvent, Data: data}.encode()
	for _, sc := range b.targets() {
		if _, skip := b.except[sc]; skip {
			continue
		}
		sc.emitEncoded(pkt)
	}
}

func (b *Broadcast) targets() []*Socket {
	if len(b.rooms) == 0 {
		return b.srv.allSockets()
	}
	seen := make(map[*Socket]struct{})
	out := make([]*Socket, 0, 8)
	for _, room := range b.rooms {
		for _, sc := range b.srv.roomSockets(room) {
			if _, ok := seen[sc]; ok {
				continue
			}
			seen[sc] = struct{}{}
			out = append(out, sc)
		}
	}
	return out
}

// encodeEventData 把事件名与参数编码成 socket.io 的 JSON 数组载荷。
func encodeEventData(event string, args []any) (string, error) {
	arr := make([]any, 0, len(args)+1)
	arr = append(arr, event)
	arr = append(arr, args...)
	b, err := json.Marshal(arr)
	if err != nil {
		return "", err
	}
	return string(b), nil
}
