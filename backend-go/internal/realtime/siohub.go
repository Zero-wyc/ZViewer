package realtime

import (
	"zviewer/backend/internal/sio"
)

// SocketHub 把 *sio.Server 适配成实时层需要的两种能力：
//
//   - realtime.Bus：REST 处理器向房间广播（room-name-updated / 弹幕轨道变更…）
//   - room.Hub：房间业务的生命周期广播、定向推送与踢人
//
// 两个接口的方法签名刻意设计成一致（EmitRoom），因此一个类型同时满足两者，
// 上层只需注入一次。
type SocketHub struct {
	srv *sio.Server
}

// NewSocketHub 构造适配器。
func NewSocketHub(srv *sio.Server) *SocketHub { return &SocketHub{srv: srv} }

// EmitRoom 向房间内所有连接广播（对应 `io.to(roomId).emit()`）。
//
// 房间不存在时不会报错——事件本来就是「有缘人收到」的语义。
func (h *SocketHub) EmitRoom(roomID, event string, payload any) {
	if h == nil || h.srv == nil || roomID == "" {
		return
	}
	h.srv.To(roomID).Emit(event, payload)
}

// EmitRoomExcept 向房间内除指定连接外的所有连接广播。
//
// 对应 Node 的 `socket.to(roomId).emit()`：发送者自己**收不到**。
// p2p-mode-change 这类「我改了、通知别人」的事件必须走这条，
// 用 EmitRoom 会让发起端收到自己刚发的状态，前端做乐观更新时来回抖。
func (h *SocketHub) EmitRoomExcept(roomID, exceptSocketID, event string, payload any) {
	if h == nil || h.srv == nil || roomID == "" {
		return
	}
	b := h.srv.To(roomID)
	if exceptSocketID != "" {
		if sc := h.srv.SocketByID(exceptSocketID); sc != nil {
			b = b.Except(sc)
		}
	}
	b.Emit(event, payload)
}

// EmitRoomExceptNoArgs 向房间内除指定连接外的连接发送一个**无参数**事件。
//
// 对应 Node 的 `socket.to(roomId).emit('event')`。用 EmitRoomExcept 传 nil
// 会编成 `["event", null]`，客户端 handler 的 payload 是 null 而不是
// undefined，按条件判断 `if (payload)` 的代码两边的走法就不同了。
func (h *SocketHub) EmitRoomExceptNoArgs(roomID, exceptSocketID, event string) {
	if h == nil || h.srv == nil || roomID == "" {
		return
	}
	b := h.srv.To(roomID)
	if exceptSocketID != "" {
		if sc := h.srv.SocketByID(exceptSocketID); sc != nil {
			b = b.Except(sc)
		}
	}
	b.Emit(event)
}

// EmitTo 只推给指定连接（对应 `io.to(socketId).emit()`）。
func (h *SocketHub) EmitTo(socketID, event string, payload any) {
	if h == nil || h.srv == nil || socketID == "" {
		return
	}
	h.srv.To(socketID).Emit(event, payload)
}

// SocketIDs 返回房间内所有在线连接 ID。
func (h *SocketHub) SocketIDs(roomID string) []string {
	if h == nil || h.srv == nil {
		return nil
	}
	socks := h.srv.RoomSockets(roomID)
	out := make([]string, 0, len(socks))
	for _, sc := range socks {
		out = append(out, sc.ID)
	}
	return out
}

// Connected 判断连接是否仍在线。
func (h *SocketHub) Connected(socketID string) bool {
	if h == nil || h.srv == nil {
		return false
	}
	return h.srv.Connected(socketID)
}

// Leave 让连接退出房间但保持连接。
func (h *SocketHub) Leave(socketID, roomID string) {
	if h == nil || h.srv == nil {
		return
	}
	if sc := h.srv.SocketByID(socketID); sc != nil {
		sc.Leave(roomID)
	}
}

// Join 让指定连接加入房间。
//
// 审批通过时房主要替**观众**那条连接加房间（对应 Node 的
// `roomSessionService.admitViewer(viewerSocket, ...)` 里的 `socket.join`）。
func (h *SocketHub) Join(socketID, roomID string) {
	if h == nil || h.srv == nil || socketID == "" || roomID == "" {
		return
	}
	if sc := h.srv.SocketByID(socketID); sc != nil {
		sc.Join(roomID)
	}
}

// DeleteSocketData 清除连接上的 data 键（拒绝审批时清 pendingRoomId）。
func (h *SocketHub) DeleteSocketData(socketID, key string) {
	if h == nil || h.srv == nil || socketID == "" {
		return
	}
	if sc := h.srv.SocketByID(socketID); sc != nil {
		sc.DeleteData(key)
	}
}

// Disconnect 断开连接。
//
// 关闭房间时逐个踢人用它：先 leave 再 disconnect，与 Node 的
// `sock.leave(roomId); sock.disconnect(true)` 顺序一致。
func (h *SocketHub) Disconnect(socketID string) {
	if h == nil || h.srv == nil {
		return
	}
	if sc := h.srv.SocketByID(socketID); sc != nil {
		sc.Disconnect("io server disconnect")
	}
}

// SocketData 返回连接上的身份数据副本。
//
// 返回拷贝而不是原 map：读取方（房间列表补发）与写入方（鉴权中间件）
// 可能并发访问，直接把 map 交出去等于埋一个数据竞争。
func (h *SocketHub) SocketData(socketID string) map[string]any {
	if h == nil || h.srv == nil {
		return nil
	}
	sc := h.srv.SocketByID(socketID)
	if sc == nil || sc.Data == nil {
		return nil
	}
	out := make(map[string]any, len(sc.Data))
	for k, v := range sc.Data {
		out[k] = v
	}
	return out
}
