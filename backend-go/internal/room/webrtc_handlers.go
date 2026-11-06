package room

import (
	"encoding/json"

	"zviewer/backend/internal/sio"
)

// 房主就绪广播。
//
// 屏幕共享的信令已经全部走 Piik 的 `/signal`，socket.io 这边不再承担任何
// 共享信令。留下的 sharer-ready 属于「房间级通知」：房主重连后广播一句，
// 一起听/一起看据此恢复跟随，与共享怎么建连无关。
//
// sharer-error 随旧链路一起删了——它唯一的产消双方都在旧前端的房主侧，
// Piik 链路的失败提示由会话自己给。

// bindWebRTC 注册房主就绪事件。
func (s *Service) bindWebRTC(sc *sio.Socket) {
	sc.On("sharer-ready", func(args []json.RawMessage, ack func(...any)) {
		s.handleSharerReady(sc, args, ack)
	})
}

// handleSharerReady 处理房主就绪：通知房间内观众恢复跟随。
func (s *Service) handleSharerReady(sc *sio.Socket, args []json.RawMessage, ack func(...any)) {
	ctx, cancel := handlerCtx()
	defer cancel()

	raw := firstObject(args)
	if raw == nil {
		ackFail(ack, "处理失败")
		return
	}
	roomID, ok := jsonStringField(raw, "roomId")
	if !ok {
		ackFail(ack, "无权限")
		return
	}
	host, err := s.IsRoomHost(ctx, sc.ID, roomID)
	if err != nil {
		s.Logger.Printf("[sharer-ready] 权限判定失败: %v", err)
		ackFail(ack, "处理失败")
		return
	}
	if !host {
		ackFail(ack, "无权限")
		return
	}

	s.Hub.EmitRoomExcept(roomID, sc.ID, "sharer-ready", map[string]any{"roomId": roomID})
	ackOK(ack, nil)
}
