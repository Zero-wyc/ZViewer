package room

import (
	"encoding/json"

	"zviewer/backend/internal/sio"
)

// 字幕 / 轨道同步与「观众申请跳转」事件（对应 Node 的 SubtitleSyncHandler、
// TrackSyncHandler、SeekApprovalHandler）。
//
// 这一组几乎全是纯转发，但有几个细节不能省：
//   - subtitle-update 转发的 payload 是**原样**（含 roomId），不裁剪字段；
//   - subtitle-request 没有 ack，非法输入直接静默返回；
//   - 申请类事件要把申请者身份补进转发载荷，房主端才能弹「谁想跳转」；
//   - 回应类事件直接按 viewerSocketId 定向回发，不走房间广播。

func (s *Service) bindSubtitleAndTracks(sc *sio.Socket) {
	sc.On("subtitle-update", func(args []json.RawMessage, ack func(...any)) {
		s.handleSubtitleUpdate(sc, args, ack)
	})
	sc.On("subtitle-request", func(args []json.RawMessage, _ func(...any)) {
		s.handleSubtitleRequest(sc, args)
	})
	sc.On("track-change", func(args []json.RawMessage, ack func(...any)) {
		s.handleTrackChange(sc, args, ack)
	})
}

func (s *Service) bindSeekApproval(sc *sio.Socket) {
	sc.On("seek-request", func(args []json.RawMessage, ack func(...any)) {
		s.handleViewerRequest(sc, args, ack, "seek-request", "申请跳转失败", true)
	})
	sc.On("pause-request", func(args []json.RawMessage, ack func(...any)) {
		s.handleViewerRequest(sc, args, ack, "pause-request", "申请暂停失败", false)
	})
	sc.On("play-request", func(args []json.RawMessage, ack func(...any)) {
		s.handleViewerRequest(sc, args, ack, "play-request", "申请继续播放失败", false)
	})
	sc.On("seek-response", func(args []json.RawMessage, ack func(...any)) {
		s.handleHostResponse(sc, args, ack, "seek-response", true)
	})
	sc.On("pause-response", func(args []json.RawMessage, ack func(...any)) {
		s.handleHostResponse(sc, args, ack, "pause-response", false)
	})
	sc.On("play-response", func(args []json.RawMessage, ack func(...any)) {
		s.handleHostResponse(sc, args, ack, "play-response", false)
	})
}

// ---------- 字幕 ----------

func (s *Service) handleSubtitleUpdate(sc *sio.Socket, args []json.RawMessage, ack func(...any)) {
	ctx, cancel := handlerCtx()
	defer cancel()

	payload, ok := decodePayload[roomPayload](args)
	if !ok || payload.RoomID == "" {
		ackFail(ack, "缺少 roomId")
		return
	}
	if !s.requireHost(ctx, ack, sc, payload.RoomID, "无权限更新字幕状态") {
		return
	}

	// 缓存最近一次字幕状态：观众中途加入/刷新时补发，否则观众只能在房主
	// 下次改字幕时才收到（加入前就已加载的字幕永远同步不过来）。
	// 缓存原始字节而不是 map：cues 里的时间戳/序号是 double，
	// 走一遍 map 再序列化会改写数字格式。
	s.SetSubtitle(payload.RoomID, json.RawMessage(args[0]))

	// 转发时是**整份原始载荷**（含 roomId）：观众端 useSubtitles 直接把它
	// 合并进本地状态，少了哪个键就少同步一项。
	if s.Hub != nil {
		s.Hub.EmitRoomExcept(payload.RoomID, sc.ID, "subtitle-update", json.RawMessage(args[0]))
	}
	ackOK(ack, nil)
}

// handleSubtitleRequest 回发房主缓存的字幕状态（无 ack，失败静默）。
//
// 观众挂载监听器后主动拉一次：加入时的那条 subtitle-update 往往早于
// 前端 useEffect 挂载，已经丢了。
func (s *Service) handleSubtitleRequest(sc *sio.Socket, args []json.RawMessage) {
	ctx, cancel := handlerCtx()
	defer cancel()

	payload, ok := decodePayload[roomPayload](args)
	if !ok || payload.RoomID == "" {
		return
	}
	if inRoom, err := s.IsInRoom(ctx, sc.ID, payload.RoomID); err != nil || !inRoom {
		return
	}
	if cached := s.Subtitle(payload.RoomID); cached != nil {
		sc.Emit("subtitle-update", cached)
	}
}

// ---------- 轨道 ----------

type trackChangePayload struct {
	RoomID string          `json:"roomId"`
	Type   string          `json:"type"`
	Value  json.RawMessage `json:"value"`
}

type trackChangeBroadcast struct {
	Type string `json:"type"`
	// Value 用 omitempty 表达「键缺失」：null 是合法值（关闭该轨道），
	// 而 undefined 的键会整块消失——两者前端走的分支不同。
	Value json.RawMessage `json:"value,omitempty"`
}

func (s *Service) handleTrackChange(sc *sio.Socket, args []json.RawMessage, ack func(...any)) {
	ctx, cancel := handlerCtx()
	defer cancel()

	payload, _ := decodePayload[trackChangePayload](args)

	if !s.requireHost(ctx, ack, sc, payload.RoomID, "无权限切换轨道") {
		return
	}

	s.emitRoomExcept(sc, payload.RoomID, "track-change", trackChangeBroadcast{
		Type:  payload.Type,
		Value: payload.Value,
	})
	ackOK(ack, nil)
}

// ---------- 观众申请 / 房主回应 ----------

type viewerRequestPayload struct {
	RoomID string   `json:"roomId"`
	Time   *float64 `json:"time"`
}

type viewerRequestBroadcast struct {
	RoomID         string   `json:"roomId"`
	ViewerSocketID string   `json:"viewerSocketId"`
	ViewerUsername *string  `json:"viewerUsername,omitempty"`
	Time           *float64 `json:"time,omitempty"`
}

// handleViewerRequest 把观众的申请转给在线房主（附申请者信息）。
func (s *Service) handleViewerRequest(
	sc *sio.Socket,
	args []json.RawMessage,
	ack func(...any),
	event, failMessage string,
	withTime bool,
) {
	ctx, cancel := handlerCtx()
	defer cancel()

	payload, _ := decodePayload[viewerRequestPayload](args)

	if !s.requireInRoom(ctx, ack, sc, payload.RoomID, "不在该房间中") {
		return
	}
	sharer, err := s.Sharer(ctx, payload.RoomID)
	if err != nil {
		s.Logger.Printf("[%s] 查询房主失败: %v", event, err)
		ackFail(ack, failMessage)
		return
	}
	if sharer == nil {
		// 房主不在线时直接拒：申请发不到人手，前端不该停在「等待房主确认」。
		ackFail(ack, "房主不在线")
		return
	}

	out := viewerRequestBroadcast{
		RoomID:         payload.RoomID,
		ViewerSocketID: sc.ID,
		ViewerUsername: socketUsername(sc),
	}
	if withTime {
		out.Time = payload.Time
	}
	if s.Hub != nil {
		s.Hub.EmitTo(sharer.SocketID, event, out)
	}
	ackOK(ack, nil)
}

type hostResponsePayload struct {
	RoomID         string   `json:"roomId"`
	ViewerSocketID string   `json:"viewerSocketId"`
	Accept         *bool    `json:"accept"`
	Time           *float64 `json:"time"`
}

type seekResponseBroadcast struct {
	Accept *bool    `json:"accept,omitempty"`
	Time   *float64 `json:"time,omitempty"`
}

type acceptResponseBroadcast struct {
	Accept *bool `json:"accept,omitempty"`
}

// handleHostResponse 把房主的回应定向转发给申请者。
//
// 注意 accept=true 时房主端已经自己 seek/pause/play 过并通过
// watch-together-control 广播了状态，这里**只转发结果**，不再动播放状态。
func (s *Service) handleHostResponse(
	sc *sio.Socket,
	args []json.RawMessage,
	ack func(...any),
	event string,
	withTime bool,
) {
	ctx, cancel := handlerCtx()
	defer cancel()

	payload, _ := decodePayload[hostResponsePayload](args)

	if !s.requireHost(ctx, ack, sc, payload.RoomID, "无权限") {
		return
	}
	if s.Hub == nil || payload.ViewerSocketID == "" {
		ackOK(ack, nil)
		return
	}

	if withTime {
		s.Hub.EmitTo(payload.ViewerSocketID, event, seekResponseBroadcast{
			Accept: payload.Accept,
			Time:   payload.Time,
		})
	} else {
		s.Hub.EmitTo(payload.ViewerSocketID, event, acceptResponseBroadcast{Accept: payload.Accept})
	}
	ackOK(ack, nil)
}
