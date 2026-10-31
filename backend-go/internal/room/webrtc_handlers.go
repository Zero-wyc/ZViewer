package room

import (
	"encoding/json"
	"unicode/utf16"

	"zviewer/backend/internal/sio"
)

// 房主就绪与共享失败广播。
//
// 屏幕共享的信令已经全部迁到 `share` 单一事件（严格信封 + 代际 + 路由版本），
// 旧的 signal-offer / signal-answer / signal-ice-candidate / viewer-ready 四条
// 中继事件在前端切栈后已无收发方，这里一并删除——它们按 socketId 裸转发，
// 没有代际也没有首帧判据，留着只会让人以为还有第二条路可走。
//
// 保留的两条属于「房间级通知」而不是信令：
//   - sharer-ready   房主重连后广播，音乐一起听与观看一起看据此恢复跟随
//   - sharer-error   房主共享启动失败 → 广播明确原因（避免观众无限挂起）

// bindWebRTC 注册房主就绪与共享失败事件。
func (s *Service) bindWebRTC(sc *sio.Socket) {
	sc.On("sharer-ready", func(args []json.RawMessage, ack func(...any)) {
		s.handleSharerReady(sc, args, ack)
	})
	sc.On("sharer-error", func(args []json.RawMessage, ack func(...any)) {
		s.handleSharerError(sc, args, ack)
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

// handleSharerError 处理房主共享启动失败：把原因广播给观众。
//
// 借鉴 mirotalk 的做法：启动失败也必须让房间状态一致，否则观众会停在
// 等待页一直黑屏——一个明确提示远好过无限挂起。
func (s *Service) handleSharerError(sc *sio.Socket, args []json.RawMessage, ack func(...any)) {
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
		s.Logger.Printf("[sharer-error] 权限判定失败: %v", err)
		ackFail(ack, "处理失败")
		return
	}
	if !host {
		ackFail(ack, "无权限")
		return
	}

	message := "房主屏幕共享启动失败，等待房主重试"
	if raw, ok := jsonStringField(firstObject(args), "message"); ok {
		// 长度按 UTF-16 码元算（与 JS 的 String.length 一致）：
		// 用 rune 数会让带 emoji 的提示语在两侧得到不同的截断结果。
		if length := len(utf16.Encode([]rune(raw))); length > 0 && length <= 200 {
			message = raw
		}
	}

	s.Hub.EmitRoomExcept(roomID, sc.ID, "sharer-error", map[string]any{
		"roomId":  roomID,
		"message": message,
	})
	ackOK(ack, nil)
}

// bindShare 挂上屏幕共享控制面的单一 `share` 事件。
//
// 屏幕共享只有这一条上行线路：严格信封 + shareGeneration + 路由版本。
// 旧的三条按 socketId 裸转发的事件已在 P5 删除。
func (s *Service) bindShare(sc *sio.Socket) {
	if s.shareSvc != nil {
		s.shareSvc.Bind(sc)
	}
}
