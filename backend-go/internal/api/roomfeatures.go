package api

import (
	"context"
	"encoding/json"
	"log"
	"strings"
	"time"

	"zviewer/backend/internal/auth"
	"zviewer/backend/internal/sio"
	"zviewer/backend/internal/store"
)

// 房间功能开关（屏幕加密 / 语音 / 自动入语音 / 一起听）。
//
// 四个开关都持久化在 room 表上：读取任何房间成员都可以，修改只允许房主。
// 语音与一起听的实际门禁在各自的服务端入口处（voice.go /
// room/music_handlers.go），这里只负责读写与广播。
const roomFeaturesEvent = "room-features"

// roomFeatureState 是四个开关的完整快照，同时也是广播/ack 的载荷形状。
type roomFeatureState struct {
	VoiceEnabled      bool `json:"voiceEnabled"`
	VoiceAutoJoin     bool `json:"voiceAutoJoin"`
	MusicEnabled      bool `json:"musicEnabled"`
	ScreenE2EEEnabled bool `json:"screenE2EEEnabled"`
}

// roomFeatureStateOf 从房间行取开关快照。
func roomFeatureStateOf(room *store.Room) roomFeatureState {
	return roomFeatureState{
		VoiceEnabled:      room.VoiceEnabled,
		VoiceAutoJoin:     room.VoiceAutoJoin,
		MusicEnabled:      room.MusicEnabled,
		ScreenE2EEEnabled: room.ScreenE2EEEnabled,
	}
}

// roomFeaturesPayload 是 room-features-set 的解析结果；nil 表示该字段未给出。
type roomFeaturesPayload struct {
	RoomID            string
	VoiceEnabled      *bool
	VoiceAutoJoin     *bool
	MusicEnabled      *bool
	ScreenE2EEEnabled *bool
}

// hasAnyField 判断补丁里是否至少给了一个开关（空补丁没有意义，直接拒绝）。
func (p roomFeaturesPayload) hasAnyField() bool {
	return p.VoiceEnabled != nil || p.VoiceAutoJoin != nil ||
		p.MusicEnabled != nil || p.ScreenE2EEEnabled != nil
}

// applyTo 在给定快照上叠加补丁，返回写库后应当广播的完整值。
func (p roomFeaturesPayload) applyTo(base roomFeatureState) roomFeatureState {
	if p.VoiceEnabled != nil {
		base.VoiceEnabled = *p.VoiceEnabled
	}
	if p.VoiceAutoJoin != nil {
		base.VoiceAutoJoin = *p.VoiceAutoJoin
	}
	if p.MusicEnabled != nil {
		base.MusicEnabled = *p.MusicEnabled
	}
	if p.ScreenE2EEEnabled != nil {
		base.ScreenE2EEEnabled = *p.ScreenE2EEEnabled
	}
	return base
}

// parseRoomFeaturesSet 解析 room-features-set 参数（纯函数，便于单测）。
func parseRoomFeaturesSet(args []json.RawMessage) roomFeaturesPayload {
	raw := struct {
		RoomID            string `json:"roomId"`
		VoiceEnabled      *bool  `json:"voiceEnabled"`
		VoiceAutoJoin     *bool  `json:"voiceAutoJoin"`
		MusicEnabled      *bool  `json:"musicEnabled"`
		ScreenE2EEEnabled *bool  `json:"screenE2EEEnabled"`
	}{}
	if len(args) > 0 && len(args[0]) > 0 {
		_ = json.Unmarshal(args[0], &raw)
	}
	return roomFeaturesPayload{
		RoomID:            strings.TrimSpace(raw.RoomID),
		VoiceEnabled:      raw.VoiceEnabled,
		VoiceAutoJoin:     raw.VoiceAutoJoin,
		MusicEnabled:      raw.MusicEnabled,
		ScreenE2EEEnabled: raw.ScreenE2EEEnabled,
	}
}

// parseRoomFeaturesGet 解析 room-features-get 参数（纯函数，便于单测）。
func parseRoomFeaturesGet(args []json.RawMessage) (string, bool) {
	raw := struct {
		RoomID string `json:"roomId"`
	}{}
	if len(args) > 0 && len(args[0]) > 0 {
		_ = json.Unmarshal(args[0], &raw)
	}
	roomID := strings.TrimSpace(raw.RoomID)
	return roomID, roomID != ""
}

// roomFeaturesAck 回应 socket 调用方：成功只给 success，失败带 message。
func roomFeaturesAck(ack func(...any), ok bool, message string) {
	if ack == nil {
		return
	}
	if ok {
		ack(map[string]any{"success": true})
		return
	}
	ack(map[string]any{"success": false, "message": message})
}

// socketAuthClaims 从连接数据还原鉴权 claims，供需要复用 HTTP 侧权限判定
// （canReadRoom）的 socket 事件使用。
//
// 握手成功时 socketAuth 已把同一份 claims 的各个字段写进 socket.data，
// 逐包复核（socketPacketAuth）在事件之前执行，因此这里读到的身份与
// REST 侧一致。
func socketAuthClaims(sc *sio.Socket) *auth.Claims {
	if sc == nil {
		return nil
	}
	claims := &auth.Claims{}
	if value, ok := sc.GetData("userId"); ok {
		if id, ok := value.(int64); ok {
			claims.UserID = id
		}
	}
	if value, ok := sc.GetData("role"); ok {
		if role, ok := value.(string); ok {
			claims.Role = role
		}
	}
	if value, ok := sc.GetData("username"); ok {
		if username, ok := value.(string); ok {
			claims.Username = username
		}
	}
	if value, ok := sc.GetData("guestId"); ok {
		if guestID, ok := value.(string); ok {
			claims.GuestID = guestID
		}
	}
	if value, ok := sc.GetData("issuedAtMs"); ok {
		if issuedAt, ok := value.(int64); ok {
			claims.IssuedAtMs = issuedAt
		}
	}
	return claims
}

// emitRoomFeatures 把完整开关值广播给整个房间（含尚未进入语音/一起听的人）。
func (s *Server) emitRoomFeatures(roomID string, state roomFeatureState) {
	if s.Socket == nil || roomID == "" {
		return
	}
	s.Socket.To(roomID).Emit(roomFeaturesEvent, map[string]any{
		"roomId":            roomID,
		"voiceEnabled":      state.VoiceEnabled,
		"voiceAutoJoin":     state.VoiceAutoJoin,
		"musicEnabled":      state.MusicEnabled,
		"screenE2EEEnabled": state.ScreenE2EEEnabled,
	})
}

// attachRoomFeatures 把房间功能开关事件挂到一条已通过鉴权的新连接上。
func (s *Server) attachRoomFeatures(sc *sio.Socket) {
	sc.On("room-features-get", func(args []json.RawMessage, ack func(...any)) {
		s.handleRoomFeaturesGet(sc, args, ack)
	})
	sc.On("room-features-set", func(args []json.RawMessage, ack func(...any)) {
		s.handleRoomFeaturesSet(sc, args, ack)
	})
}

// handleRoomFeaturesGet 读取四个开关：房间成员可读。
func (s *Server) handleRoomFeaturesGet(sc *sio.Socket, args []json.RawMessage, ack func(...any)) {
	roomID, ok := parseRoomFeaturesGet(args)
	if !ok {
		roomFeaturesAck(ack, false, "roomId 为必填项")
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	room, err := s.Rooms.FindByRoomID(ctx, roomID)
	if err != nil || room == nil || room.Status != "active" {
		roomFeaturesAck(ack, false, "房间不存在或已关闭")
		return
	}
	if allowed, err := s.canReadRoom(ctx, roomID, socketAuthClaims(sc)); err != nil || !allowed {
		roomFeaturesAck(ack, false, "无权限：不在房间内")
		return
	}
	state := roomFeatureStateOf(room)
	if ack != nil {
		ack(map[string]any{
			"success":           true,
			"roomId":            roomID,
			"voiceEnabled":      state.VoiceEnabled,
			"voiceAutoJoin":     state.VoiceAutoJoin,
			"musicEnabled":      state.MusicEnabled,
			"screenE2EEEnabled": state.ScreenE2EEEnabled,
		})
	}
}

// handleRoomFeaturesSet 修改四个开关：仅房主，至少给一个字段。
func (s *Server) handleRoomFeaturesSet(sc *sio.Socket, args []json.RawMessage, ack func(...any)) {
	payload := parseRoomFeaturesSet(args)
	if payload.RoomID == "" {
		roomFeaturesAck(ack, false, "roomId 为必填项")
		return
	}
	if !payload.hasAnyField() {
		roomFeaturesAck(ack, false, "参数不完整：至少提供一个开关")
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	host, err := s.RoomSvc.IsRoomHost(ctx, sc.ID, payload.RoomID)
	if err != nil {
		log.Printf("[room-features] 校验房主失败: %v", err)
		roomFeaturesAck(ack, false, "校验房主失败")
		return
	}
	if !host {
		roomFeaturesAck(ack, false, "无权限：仅房主可设置房间功能")
		return
	}

	room, err := s.Rooms.FindByRoomID(ctx, payload.RoomID)
	if err != nil || room == nil {
		roomFeaturesAck(ack, false, "房间不存在或已关闭")
		return
	}

	patch := store.RoomSettingsPatch{
		VoiceEnabled:      payload.VoiceEnabled,
		VoiceAutoJoin:     payload.VoiceAutoJoin,
		MusicEnabled:      payload.MusicEnabled,
		ScreenE2EEEnabled: payload.ScreenE2EEEnabled,
	}
	if err := s.Rooms.PatchSettings(ctx, payload.RoomID, patch); err != nil {
		log.Printf("[room-features] 保存房间功能开关失败: %v", err)
		roomFeaturesAck(ack, false, "保存房间功能设置失败")
		return
	}

	state := payload.applyTo(roomFeatureStateOf(room))
	s.emitRoomFeatures(payload.RoomID, state)
	if ack != nil {
		ack(map[string]any{
			"success":           true,
			"roomId":            payload.RoomID,
			"voiceEnabled":      state.VoiceEnabled,
			"voiceAutoJoin":     state.VoiceAutoJoin,
			"musicEnabled":      state.MusicEnabled,
			"screenE2EEEnabled": state.ScreenE2EEEnabled,
		})
	}
}
