package room

import (
	"encoding/json"
	"errors"
	"strings"

	"golang.org/x/crypto/bcrypt"

	"zviewer/backend/internal/sio"
	"zviewer/backend/internal/store"
)

// ==================== 事件注册 ====================

// bindRoomSettings 注册房间设置类事件。
//
// 对应 Node 的 RoomSettingsHandler（registry 里紧跟在 RoomLifecycleHandler 之后，
// 第三位是 RoomDisconnectHandler，见 AttachSocket 的注册顺序）。
func (s *Service) bindRoomSettings(sc *sio.Socket) {
	sc.On("update-room-name", func(args []json.RawMessage, ack func(...any)) {
		s.handleUpdateRoomName(sc, args, ack)
	})
	sc.On("update-room-mode", func(args []json.RawMessage, ack func(...any)) {
		s.handleUpdateRoomMode(sc, args, ack)
	})
	sc.On("update-room-settings", func(args []json.RawMessage, ack func(...any)) {
		s.handleUpdateRoomSettings(sc, args, ack)
	})
	sc.On("p2p-mode-change", func(args []json.RawMessage, ack func(...any)) {
		s.handleP2PModeChange(sc, args, ack)
	})
}

// ==================== update-room-name ====================

type updateRoomNamePayload struct {
	RoomID string `json:"roomId"`
	Name   string `json:"name"`
}

// handleUpdateRoomName 修改房间名称：仅 root 或房间 owner。
//
// 注意这里**不是** sharer 判定：admin 改自己创建的房间也算，而 root 改谁
// 的都算；用 isRoomHost 会把「房主掉线由 admin 改名」挡在外面。
func (s *Service) handleUpdateRoomName(sc *sio.Socket, args []json.RawMessage, ack func(...any)) {
	ctx, cancel := handlerCtx()
	defer cancel()

	payload, _ := decodePayload[updateRoomNamePayload](args)
	room, err := s.Rooms.FindByRoomID(ctx, payload.RoomID)
	if errors.Is(err, store.ErrRoomNotFound) || (err == nil && room == nil) {
		ackFail(ack, "房间不存在")
		return
	}
	if err != nil {
		s.Logger.Printf("[update-room-name] 读取房间失败: %v", err)
		ackFail(ack, "修改房间名称失败")
		return
	}

	role := socketRole(sc)
	uid := socketUserID(sc)
	isOwner := uid != nil && *uid > 0 && room.OwnerUserID != nil && *room.OwnerUserID == *uid
	if role != RoleRoot && !isOwner {
		ackFail(ack, "无权限：仅 root 或房间创建者可修改房间名称")
		return
	}

	trimmed := strings.TrimSpace(payload.Name)
	if trimmed == "" {
		ackFail(ack, "房间名称不能为空")
		return
	}

	if err := s.Rooms.Rename(ctx, payload.RoomID, trimmed); err != nil {
		s.Logger.Printf("[update-room-name] 写入失败: %v", err)
		ackFail(ack, "修改房间名称失败")
		return
	}

	if s.Hub != nil {
		s.Hub.EmitRoom(payload.RoomID, "room-name-updated", map[string]any{
			"roomId": payload.RoomID,
			"name":   trimmed,
		})
	}
	ackOK(ack, nil)
}

// ==================== update-room-mode ====================

type updateRoomModePayload struct {
	RoomID string `json:"roomId"`
	Mode   string `json:"mode"`
}

// handleUpdateRoomMode 切换房间模式：仅 sharer（带 socket 重连自愈）。
//
// Node 侧这个事件**不校验 mode 枚举**，只信任前端的三个取值。这里刻意
// 保持一致：加一道校验就会在下发新旧前端混用时报出 Node 不会报的错。
func (s *Service) handleUpdateRoomMode(sc *sio.Socket, args []json.RawMessage, ack func(...any)) {
	ctx, cancel := handlerCtx()
	defer cancel()

	payload, _ := decodePayload[updateRoomModePayload](args)
	sharer, err := s.GetOrReactivateSharer(ctx, sc.ID, payload.RoomID, userIDOrZero(socketUserID(sc)), socketRole(sc))
	if err != nil {
		s.Logger.Printf("[update-room-mode] 校验房主失败: %v", err)
		ackFail(ack, "切换房间模式失败")
		return
	}
	if sharer == nil || sharer.RoomID != payload.RoomID {
		ackFail(ack, "无权限切换房间模式")
		return
	}

	room, err := s.Rooms.FindByRoomID(ctx, payload.RoomID)
	if errors.Is(err, store.ErrRoomNotFound) || (err == nil && room == nil) {
		ackFail(ack, "房间不存在")
		return
	}
	if err != nil {
		s.Logger.Printf("[update-room-mode] 读取房间失败: %v", err)
		ackFail(ack, "切换房间模式失败")
		return
	}

	if err := s.Rooms.SetMode(ctx, payload.RoomID, payload.Mode); err != nil {
		s.Logger.Printf("[update-room-mode] 写入失败: %v", err)
		ackFail(ack, "切换房间模式失败")
		return
	}

	if s.Hub != nil {
		s.Hub.EmitRoom(payload.RoomID, "room-mode-changed", map[string]any{"mode": payload.Mode})
	}
	ackOK(ack, map[string]any{"mode": payload.Mode})
}

// ==================== update-room-settings ====================

// updateRoomSettingsPayload 用 RawMessage 保留「缺失 / null / 类型不符」三种形态。
//
// 必要之处：password 传 null 表示「不动」，传空串才表示「清空密码」；
// maxViewers 传字符串按 Node 的 `typeof === 'number'` 判定应当被忽略而不是报错。
type updateRoomSettingsPayload struct {
	RoomID          string          `json:"roomId"`
	Password        json.RawMessage `json:"password"`
	MaxViewers      json.RawMessage `json:"maxViewers"`
	RequireApproval json.RawMessage `json:"requireApproval"`
}

// handleUpdateRoomSettings 修改房间设置（密码 / 人数上限 / 需审批）：仅房主。
func (s *Service) handleUpdateRoomSettings(sc *sio.Socket, args []json.RawMessage, ack func(...any)) {
	ctx, cancel := handlerCtx()
	defer cancel()

	payload, _ := decodePayload[updateRoomSettingsPayload](args)
	host, err := s.IsRoomHost(ctx, sc.ID, payload.RoomID)
	if err != nil {
		s.Logger.Printf("[update-room-settings] 校验房主失败: %v", err)
		ackFail(ack, "修改房间设置失败")
		return
	}
	if !host {
		ackFail(ack, "无权限：仅房主可修改房间设置")
		return
	}

	room, err := s.Rooms.FindByRoomID(ctx, payload.RoomID)
	if errors.Is(err, store.ErrRoomNotFound) || (err == nil && room == nil) {
		ackFail(ack, "房间不存在")
		return
	}
	if err != nil {
		s.Logger.Printf("[update-room-settings] 读取房间失败: %v", err)
		ackFail(ack, "修改房间设置失败")
		return
	}

	var patch store.RoomSettingsPatch
	// 广播用的最终值，从当前行起手（对应 Node 的 `room.password` 等字段）。
	effectivePassword := room.Password
	effectiveMax := room.MaxViewers
	effectiveApproval := room.RequireApproval

	// 密码：只认字符串；trim 后为空表示清空（密文列写 NULL）。
	if pw, ok := jsonString(payload.Password); ok {
		trimmed := strings.TrimSpace(pw)
		if trimmed == "" {
			empty := ""
			patch.Password = &empty
			effectivePassword = nil
		} else {
			hash, hashErr := bcrypt.GenerateFromPassword([]byte(trimmed), 10)
			if hashErr != nil {
				s.Logger.Printf("[update-room-settings] 加密密码失败: %v", hashErr)
				ackFail(ack, "修改房间设置失败")
				return
			}
			h := string(hash)
			patch.Password = &h
			effectivePassword = &h
		}
	}

	if raw, ok := jsonNumber(payload.MaxViewers); ok {
		// Number.isInteger 等价：3.5 属于 number 但不合法，必须报错而不是忽略。
		if raw != float64(int64(raw)) || raw < 1 || raw > 100 {
			ackFail(ack, "观众上限必须在 1-100 之间")
			return
		}
		v := int64(raw)
		patch.MaxViewers = &v
		effectiveMax = v
	}

	if v, ok := jsonBool(payload.RequireApproval); ok {
		b := v
		patch.RequireApproval = &b
		effectiveApproval = b
	}

	if err := s.Rooms.PatchSettings(ctx, payload.RoomID, patch); err != nil {
		s.Logger.Printf("[update-room-settings] 写入失败: %v", err)
		ackFail(ack, "修改房间设置失败")
		return
	}

	if s.Hub != nil {
		// 下发的是密文本身（与 Node 一致：`password: room.password`）。
		// 前端只用它判断「有没有密码」，不是拿来展示的。
		var password any
		if effectivePassword != nil {
			password = *effectivePassword
		}
		s.Hub.EmitRoom(payload.RoomID, "room-settings-updated", map[string]any{
			"password":        password,
			"maxViewers":      effectiveMax,
			"requireApproval": effectiveApproval,
		})
	}
	ackOK(ack, nil)
}

// ==================== p2p-mode-change ====================

type p2pModeChangePayload struct {
	RoomID  string `json:"roomId"`
	Enabled bool   `json:"enabled"`
}

// handleP2PModeChange 广播 P2P 模式切换：在房间内即可（房主或观众都行）。
//
// 用 `socket.to(room)` 语义（发送者自己收不到）：前端发起端已经做过乐观更新，
// 再回推一次会让状态来回抖。
func (s *Service) handleP2PModeChange(sc *sio.Socket, args []json.RawMessage, ack func(...any)) {
	ctx, cancel := handlerCtx()
	defer cancel()

	payload, _ := decodePayload[p2pModeChangePayload](args)
	inRoom, err := s.IsInRoom(ctx, sc.ID, payload.RoomID)
	if err != nil {
		s.Logger.Printf("[p2p-mode-change] 校验房间失败: %v", err)
		ackFail(ack, "广播 P2P 模式失败")
		return
	}
	if !inRoom {
		ackFail(ack, "不在该房间中")
		return
	}

	if s.Hub != nil {
		s.Hub.EmitRoomExcept(payload.RoomID, sc.ID, "p2p-mode-change", map[string]any{
			"roomId":  payload.RoomID,
			"enabled": payload.Enabled,
		})
	}
	ackOK(ack, nil)
}

// ==================== payload 类型探测 ====================

// jsonString 判断该字段是否「存在且为字符串」（null / 缺失 / 数字都不算）。
func jsonString(raw json.RawMessage) (string, bool) {
	if len(raw) == 0 {
		return "", false
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return "", false
	}
	return s, true
}

// jsonNumber 判断该字段是否「存在且为数字」。
func jsonNumber(raw json.RawMessage) (float64, bool) {
	if len(raw) == 0 {
		return 0, false
	}
	var f float64
	if err := json.Unmarshal(raw, &f); err != nil {
		return 0, false
	}
	return f, true
}

// jsonBool 判断该字段是否「存在且为布尔」。
func jsonBool(raw json.RawMessage) (bool, bool) {
	if len(raw) == 0 {
		return false, false
	}
	var b bool
	if err := json.Unmarshal(raw, &b); err != nil {
		return false, false
	}
	return b, true
}

func userIDOrZero(v *int64) int64 {
	if v == nil {
		return 0
	}
	return *v
}
