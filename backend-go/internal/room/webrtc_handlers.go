package room

import (
	"encoding/json"
	"unicode/utf16"

	"zviewer/backend/internal/sio"
	"zviewer/backend/internal/store"
)

// WebRTC 信令与观众就绪（迁移自 modules/webrtc-signaling/）。
//
// 6 个事件：
//   - signal-offer / signal-answer / signal-ice-candidate  同房间中继
//   - viewer-ready   观众就绪 → 通知房主 + 补发影片列表与当前影片
//   - sharer-ready   房主就绪 → 通知房间内观众重发 viewer-ready
//   - sharer-error   房主共享启动失败 → 广播明确失败原因（避免观众无限挂起）
//
// 媒体面（LiveKit / 屏幕捕获）不在这一层：这里只是「替两个浏览器转发
// SDP 与 ICE」。

// bindWebRTC 注册信令与观众就绪事件。
func (s *Service) bindWebRTC(sc *sio.Socket) {
	for _, event := range []string{"signal-offer", "signal-answer", "signal-ice-candidate"} {
		name := event
		sc.On(name, func(args []json.RawMessage, ack func(...any)) {
			s.handleSignalRelay(sc, name, args, ack)
		})
	}
	sc.On("viewer-ready", func(args []json.RawMessage, ack func(...any)) {
		s.handleViewerReady(sc, args, ack)
	})
	sc.On("sharer-ready", func(args []json.RawMessage, ack func(...any)) {
		s.handleSharerReady(sc, args, ack)
	})
	sc.On("sharer-error", func(args []json.RawMessage, ack func(...any)) {
		s.handleSharerError(sc, args, ack)
	})
}

// handleSignalRelay 是三条信令事件共用的中继实现。
//
// 三条事件的校验与转发完全一致，只用事件名区分——分别抄三遍只会让
// 「同一房间」的判定规则慢慢分叉。
func (s *Service) handleSignalRelay(sc *sio.Socket, event string, args []json.RawMessage, ack func(...any)) {
	raw := firstObject(args)
	if raw == nil {
		// Node 侧 payload 为 undefined/null 时 `payload.to` 抛 TypeError，
		// 落到 catch 分支回「信令转发失败」——不是「不在同一房间」。
		ackFail(ack, "信令转发失败")
		return
	}
	to, ok := jsonStringField(raw, "to")
	if !ok || to == "" {
		ackFail(ack, "不在同一房间")
		return
	}
	if !s.signalPairSharesRoom(sc, to) {
		ackFail(ack, "不在同一房间")
		return
	}

	var data any
	if v, ok := raw["data"]; ok && !isJSONNull(v) {
		// 原样透传（SDP 是对象、ICE 是对象），不做结构校验：
		// 信令内容属于 WebRTC 协商，服务器不该理解也不需要改写。
		_ = json.Unmarshal(v, &data)
	}
	if data == nil {
		// Node 的 `data: payload.data` 在缺失时是 undefined → 键消失。
		s.Hub.EmitTo(to, event, map[string]any{"from": sc.ID})
	} else {
		s.Hub.EmitTo(to, event, map[string]any{"from": sc.ID, "data": data})
	}
	ackOK(ack, nil)
}

// signalPairSharesRoom 判断目标连接是否与当前连接同处一个房间。
//
// 与 Node 的 validateSignalPair 一致：遍历目标连接的房间，跳过它自己的
// socketId（socket.io 把「自己」也当成一个房间），只要与发起方有交集即通过。
func (s *Service) signalPairSharesRoom(from *sio.Socket, toSocketID string) bool {
	if s.Hub == nil || toSocketID == "" {
		return false
	}
	if !s.Hub.Connected(toSocketID) {
		return false
	}
	fromRooms := from.Rooms()
	set := make(map[string]struct{}, len(fromRooms))
	for _, r := range fromRooms {
		set[r] = struct{}{}
	}
	for _, r := range s.Hub.SocketRooms(toSocketID) {
		if r == toSocketID {
			continue
		}
		if _, ok := set[r]; ok {
			return true
		}
	}
	return false
}

// handleViewerReady 处理观众就绪：通知房主 + 给观众补发列表。
func (s *Service) handleViewerReady(sc *sio.Socket, args []json.RawMessage, ack func(...any)) {
	ctx, cancel := handlerCtx()
	defer cancel()

	raw := firstObject(args)
	if raw == nil {
		ackFail(ack, "处理失败")
		return
	}
	roomID, ok := jsonStringField(raw, "roomId")
	if !ok || !sc.InRoom(roomID) {
		ackFail(ack, "不在该房间中")
		return
	}

	sharer, err := s.Sessions.FindActiveByRoomRole(ctx, roomID, store.SessionRoleSharer)
	if err != nil {
		s.Logger.Printf("[viewer-ready] 查询分享端失败: %v", err)
		ackFail(ack, "处理失败")
		return
	}
	if sharer == nil {
		ackFail(ack, "分享端不在线")
		return
	}

	s.Hub.EmitTo(sharer.SocketID, "viewer-ready", map[string]any{"from": sc.ID})

	// 补发影片列表与当前影片：观众就绪时房间状态可能已经推进过，
	// 只靠 join 时的推送不够（重发 viewer-ready 的场景尤其明显）。
	s.Hub.EmitTo(sc.ID, "movie-list", map[string]any{"movies": s.Movies(roomID)})
	s.Hub.EmitTo(sc.ID, "current-movie", map[string]any{"movieId": s.CurrentMovieID(roomID)})

	ackOK(ack, nil)
}

// handleSharerReady 处理房主就绪：通知房间内观众重发 viewer-ready。
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
