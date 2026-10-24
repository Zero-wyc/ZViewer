package room

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"time"

	"zviewer/backend/internal/sio"
	"zviewer/backend/internal/store"
)

// 播放控制与心跳事件（对应 Node 的 PlaybackMemoryHandler + HeartbeatHandler）。
//
// 这一组事件的共同点：转发出去的是**客户端原始 JSON**，不是 Go 反序列化
// 再序列化的结果。多走一次会把 SyncStateDto 里没有的字段（hostSocketId /
// updatedAt / currentMovieId）顺手补出去，前端拿到的 state 形状就变了。
// 只有「写进播放记忆」那一步才解析成 Playback。

// IsWatchTogetherRoom 判断房间存在、处于活跃状态且模式为一起看。
//
// 三个条件缺一不可：Node 的 isWatchTogetherRoom 是
// `findOneBy({ roomId, status: 'active' })` 后再看 mode，
// 只判 mode 会让已关闭的房间继续接受播放同步。
func (s *Service) IsWatchTogetherRoom(ctx context.Context, roomID string) (bool, error) {
	if roomID == "" {
		return false, nil
	}
	room, err := s.Rooms.FindByRoomID(ctx, roomID)
	if err != nil {
		if errors.Is(err, store.ErrRoomNotFound) {
			return false, nil
		}
		return false, err
	}
	return room.Status == "active" && room.Mode == "watch-together", nil
}

// ---------- watch-together-state ----------

type syncStatePayload struct {
	RoomID   string          `json:"roomId"`
	State    json.RawMessage `json:"state"`
	Diff     json.RawMessage `json:"diff"`
	Seq      json.RawMessage `json:"seq"`
	ClientTs int64           `json:"clientTs"`
}

type syncStateBroadcast struct {
	State json.RawMessage `json:"state,omitempty"`
	Diff  json.RawMessage `json:"diff,omitempty"`
	Seq   json.RawMessage `json:"seq,omitempty"`
}

func (s *Service) bindPlaybackSync(sc *sio.Socket) {
	sc.On("watch-together-state", func(args []json.RawMessage, ack func(...any)) {
		s.handleWatchTogetherState(sc, args, ack)
	})
	sc.On("watch-together-request-state", func(args []json.RawMessage, ack func(...any)) {
		s.handleWatchTogetherRequestState(sc, args, ack)
	})
	sc.On("watch-together-control", func(args []json.RawMessage, ack func(...any)) {
		s.handleWatchTogetherControl(sc, args, ack)
	})
	sc.On("watch-together-check-status", func(args []json.RawMessage, ack func(...any)) {
		s.handleWatchTogetherCheckStatus(sc, args, ack)
	})
	sc.On("host-heartbeat", func(args []json.RawMessage, ack func(...any)) {
		s.handleHostHeartbeat(sc, args, ack)
	})
}

func (s *Service) handleWatchTogetherState(sc *sio.Socket, args []json.RawMessage, ack func(...any)) {
	ctx, cancel := handlerCtx()
	defer cancel()

	payload, _ := decodePayload[syncStatePayload](args)

	if !s.requireHost(ctx, ack, sc, payload.RoomID, "无权限同步") {
		return
	}
	if ok, err := s.IsWatchTogetherRoom(ctx, payload.RoomID); err != nil || !ok {
		ackFail(ack, "当前房间模式不支持同步播放")
		return
	}

	var state Playback
	if len(payload.State) == 0 {
		ackFail(ack, "同步失败")
		return
	}
	if err := json.Unmarshal(payload.State, &state); err != nil {
		// state 是对象，解析失败说明载荷本身坏了，落库只会写进一条空状态。
		s.Logger.Printf("[watch-together-state] 解析 state 失败: %v", err)
		ackFail(ack, "同步失败")
		return
	}

	if err := s.Playback.SetPlayback(ctx, payload.RoomID, state, sc.ID, payload.ClientTs, s.currentMovieID(payload.RoomID)); err != nil {
		s.Logger.Printf("[watch-together-state] 写入播放状态失败: %v", err)
		ackFail(ack, "同步失败")
		return
	}

	s.emitRoomExcept(sc, payload.RoomID, "watch-together-state", syncStateBroadcast{
		State: payload.State,
		Diff:  payload.Diff,
		Seq:   payload.Seq,
	})
	ackOK(ack, nil)
}

// ---------- watch-together-request-state ----------

type roomPayload struct {
	RoomID string `json:"roomId"`
}

func (s *Service) handleWatchTogetherRequestState(sc *sio.Socket, args []json.RawMessage, ack func(...any)) {
	ctx, cancel := handlerCtx()
	defer cancel()

	payload, _ := decodePayload[roomPayload](args)

	if !s.requireInRoom(ctx, ack, sc, payload.RoomID, "不在该房间中") {
		return
	}

	state, err := s.Playback.Advanced(ctx, payload.RoomID)
	if errors.Is(err, ErrNoPlayback) {
		// 房间还没有播放状态：让房主主动同步一次。这条事件**不带参数**
		// （Node 是 emit('watch-together-request-state') 零参）。
		if s.Hub != nil {
			s.Hub.EmitRoomExceptNoArgs(payload.RoomID, sc.ID, "watch-together-request-state")
		}
		// data 必须是显式 null：前端据此区分「没数据」与「字段缺失」。
		// AckResponse 的 Data 带 omitempty 表达不了，这里直接给 map。
		ackRaw(ack, map[string]any{"success": true, "data": nil})
		return
	}
	if err != nil {
		s.Logger.Printf("[watch-together-request-state] 读取播放状态失败: %v", err)
		ackFail(ack, "请求失败")
		return
	}

	hostOnline, onlineErr := s.IsSharerOnline(ctx, payload.RoomID)
	if onlineErr != nil {
		s.Logger.Printf("[watch-together-request-state] 查询房主在线状态失败: %v", onlineErr)
	}

	ackOK(ack, map[string]any{
		"state":      state,
		"serverTs":   nowMillis(),
		"hostOnline": hostOnline,
	})
}

// ---------- watch-together-control ----------

type syncControlPayload struct {
	RoomID   string   `json:"roomId"`
	Action   string   `json:"action"`
	Value    *float64 `json:"value"`
	ClientTs int64    `json:"clientTs"`
}

type syncControlBroadcast struct {
	Action string   `json:"action"`
	Value  *float64 `json:"value,omitempty"`
}

func (s *Service) handleWatchTogetherControl(sc *sio.Socket, args []json.RawMessage, ack func(...any)) {
	ctx, cancel := handlerCtx()
	defer cancel()

	payload, _ := decodePayload[syncControlPayload](args)

	if !s.requireHost(ctx, ack, sc, payload.RoomID, "无权限控制") {
		return
	}
	if ok, err := s.IsWatchTogetherRoom(ctx, payload.RoomID); err != nil || !ok {
		ackFail(ack, "当前房间模式不支持同步播放")
		return
	}

	// 先广播再落库：控制指令的价值在「亚 500ms 到达观众」，
	// 等数据库往返完再发，观众端会明显滞后于房主。
	s.emitRoomExcept(sc, payload.RoomID, "watch-together-control", syncControlBroadcast{
		Action: payload.Action,
		Value:  payload.Value,
	})

	if err := s.applyControlToPlayback(ctx, payload.RoomID, payload.Action, payload.Value, sc.ID, payload.ClientTs); err != nil {
		s.Logger.Printf("[watch-together-control] 更新播放状态失败: %v", err)
		ackFail(ack, "控制失败")
		return
	}
	ackOK(ack, nil)
}

// applyControlToPlayback 把控制指令应用到持久化播放状态。
//
// 各动作的补偿方式不同，照抄 synctv 的语义：
//   - play：进度取推算值后再补在途推进（播放已按下 delay × rate）；
//   - pause：进度凝固在推算值，不补偿；
//   - seek：**不改变 isPlaying**——旧实现强制置 false，观众端会在 seek 后
//     暂停、等下次心跳才恢复，肉眼可见地抖一下；
//   - rate：先推算当前进度再换倍速，不额外补偿。
//
// 这里已经做过显式补偿，下面的 SetPlayback 不能再传 clientTs，
// 否则同一段延迟会被补两次。
func (s *Service) applyControlToPlayback(
	ctx context.Context,
	roomID, action string,
	value *float64,
	hostSocketID string,
	clientTs int64,
) error {
	current, err := s.Playback.Raw(ctx, roomID)
	if errors.Is(err, ErrNoPlayback) {
		// 房主还没广播过完整状态：没有基线可改，指令本身已经广播出去了。
		return nil
	}
	if err != nil {
		return err
	}

	next := *current
	advanced := func() *Playback {
		adv, err := s.Playback.Advanced(ctx, roomID)
		if err != nil {
			return nil
		}
		return adv
	}

	switch action {
	case "play":
		next.IsPlaying = true
		base := next.CurrentTime
		if adv := advanced(); adv != nil {
			base = adv.CurrentTime
		}
		next.CurrentTime = CompensateTransportDelay(TransportDelayParams{
			CurrentTime:  base,
			ClientTs:     clientTs,
			PlaybackRate: next.PlaybackRate,
			IsPlaying:    true,
		})
	case "pause":
		next.IsPlaying = false
		if adv := advanced(); adv != nil {
			next.CurrentTime = adv.CurrentTime
		}
	case "seek":
		if validNumber(value) && *value >= 0 {
			next.CurrentTime = CompensateTransportDelay(TransportDelayParams{
				CurrentTime:  *value,
				ClientTs:     clientTs,
				PlaybackRate: next.PlaybackRate,
				IsPlaying:    next.IsPlaying,
			})
		}
	case "rate":
		if validNumber(value) && *value > 0 {
			if adv := advanced(); adv != nil {
				next.CurrentTime = adv.CurrentTime
			}
			next.PlaybackRate = *value
		}
	}

	return s.Playback.SetPlayback(ctx, roomID, next, hostSocketID, 0, s.currentMovieID(roomID))
}

// ---------- watch-together-check-status ----------

type checkStatusPayload struct {
	RoomID       string  `json:"roomId"`
	CurrentTime  float64 `json:"currentTime"`
	IsPlaying    bool    `json:"isPlaying"`
	PlaybackRate float64 `json:"playbackRate"`
	ClientTs     int64   `json:"clientTs"`
}

func (s *Service) handleWatchTogetherCheckStatus(sc *sio.Socket, args []json.RawMessage, ack func(...any)) {
	ctx, cancel := handlerCtx()
	defer cancel()

	payload, _ := decodePayload[checkStatusPayload](args)

	if !s.requireInRoom(ctx, ack, sc, payload.RoomID, "不在该房间中") {
		return
	}

	serverTs := nowMillis()
	serverState, err := s.Playback.Advanced(ctx, payload.RoomID)
	if errors.Is(err, ErrNoPlayback) {
		ackOK(ack, map[string]any{"needsSync": false, "serverTs": serverTs})
		return
	}
	if err != nil {
		s.Logger.Printf("[watch-together-check-status] 读取播放状态失败: %v", err)
		ackFail(ack, "自检失败")
		return
	}

	needsSync := NeedsProgressSync(NeedsProgressSyncParams{
		ClientCurrentTime:  payload.CurrentTime,
		ClientIsPlaying:    payload.IsPlaying,
		ClientPlaybackRate: payload.PlaybackRate,
		ClientTs:           payload.ClientTs,
		ServerCurrentTime:  serverState.CurrentTime,
		ServerIsPlaying:    serverState.IsPlaying,
	})
	if needsSync {
		ackOK(ack, map[string]any{
			"needsSync": true,
			"state":     serverState,
			"serverTs":  serverTs,
		})
		return
	}
	ackOK(ack, map[string]any{"needsSync": false, "serverTs": serverTs})
}

// ---------- host-heartbeat ----------

type heartbeatPayload struct {
	RoomID       string  `json:"roomId"`
	CurrentTime  float64 `json:"currentTime"`
	IsPlaying    bool    `json:"isPlaying"`
	PlaybackRate float64 `json:"playbackRate"`
	Suppressed   *bool   `json:"suppressed"`
	ClientTs     int64   `json:"clientTs"`
}

// heartbeatBroadcast 同时用于两个事件：老名字 host-heartbeat（兼容已连接
// 客户端）与统一协议 sync-heartbeat（多一个 source 字段）。
type heartbeatBroadcast struct {
	Source       string  `json:"source,omitempty"`
	CurrentTime  float64 `json:"currentTime"`
	IsPlaying    bool    `json:"isPlaying"`
	PlaybackRate float64 `json:"playbackRate"`
	Suppressed   *bool   `json:"suppressed,omitempty"`
}

func (s *Service) handleHostHeartbeat(sc *sio.Socket, args []json.RawMessage, ack func(...any)) {
	ctx, cancel := handlerCtx()
	defer cancel()

	payload, _ := decodePayload[heartbeatPayload](args)

	// 心跳**不校验房间模式**：screen-share 模式下房主同样要发心跳，
	// 观众端靠它重置「房主已离线」计时器，漏转发就是 6 秒后误报离线。
	if !s.requireHost(ctx, ack, sc, payload.RoomID, "无权限发送心跳") {
		return
	}

	// 落盘失败不影响转发：心跳的价值是「让观众知道房主还活着」，
	// 卡在数据库上会把心跳本身拖慢。另起协程 + 独立超时。
	go func() {
		hbCtx, hbCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer hbCancel()
		if err := s.Playback.ApplyHostHeartbeat(hbCtx, payload.RoomID, HostHeartbeat{
			CurrentTime:  payload.CurrentTime,
			IsPlaying:    payload.IsPlaying,
			PlaybackRate: payload.PlaybackRate,
		}, payload.ClientTs); err != nil {
			s.Logger.Printf("[host-heartbeat] 合并心跳失败: %v", err)
		}
	}()

	s.emitRoomExcept(sc, payload.RoomID, "host-heartbeat", heartbeatBroadcast{
		CurrentTime:  payload.CurrentTime,
		IsPlaying:    payload.IsPlaying,
		PlaybackRate: payload.PlaybackRate,
		Suppressed:   payload.Suppressed,
	})
	s.emitRoomExcept(sc, payload.RoomID, "sync-heartbeat", heartbeatBroadcast{
		Source:       "host",
		CurrentTime:  payload.CurrentTime,
		IsPlaying:    payload.IsPlaying,
		PlaybackRate: payload.PlaybackRate,
		Suppressed:   payload.Suppressed,
	})
	ackOK(ack, nil)
}

// ---------- 共用小工具 ----------

// requireHost 判定「当前连接是该房间的活跃房主」，不满足时给出指定文案。
func (s *Service) requireHost(ctx context.Context, ack func(...any), sc *sio.Socket, roomID, denyMessage string) bool {
	ok, err := s.IsRoomHost(ctx, sc.ID, roomID)
	if err != nil {
		s.Logger.Printf("[room] 房主判定失败 %s: %v", roomID, err)
		ackFail(ack, denyMessage)
		return false
	}
	if !ok {
		ackFail(ack, denyMessage)
		return false
	}
	return true
}

// requireInRoom 判定「当前连接在这个房间里」。
func (s *Service) requireInRoom(ctx context.Context, ack func(...any), sc *sio.Socket, roomID, denyMessage string) bool {
	ok, err := s.IsInRoom(ctx, sc.ID, roomID)
	if err != nil {
		s.Logger.Printf("[room] 在房判定失败 %s: %v", roomID, err)
		ackFail(ack, denyMessage)
		return false
	}
	if !ok {
		ackFail(ack, denyMessage)
		return false
	}
	return true
}

// emitRoomExcept 广播给房间内除发送者外的连接。
func (s *Service) emitRoomExcept(sc *sio.Socket, roomID, event string, payload any) {
	if s.Hub == nil || roomID == "" {
		return
	}
	s.Hub.EmitRoomExcept(roomID, sc.ID, event, payload)
}

// currentMovieID 取运行时状态里的当前影片 ID。
func (s *Service) currentMovieID(roomID string) *int64 {
	v := s.CurrentMovieID(roomID)
	if v == nil {
		return nil
	}
	id, ok := asInt64(v)
	if !ok {
		return nil
	}
	return &id
}

func validNumber(v *float64) bool {
	if v == nil {
		return false
	}
	return !math.IsNaN(*v) && !math.IsInf(*v, 0)
}
