package api

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"log"
	"strings"
	"time"

	"zviewer/backend/internal/sio"
	"zviewer/backend/internal/store"
)

// 房间功能开关（屏幕加密 / 语音 / 自动入语音 / 一起听）。
//
// 四个开关都持久化在 room 表上：读取任何房间成员都可以，修改只允许房主。
// 语音与一起听的实际门禁在各自的服务端入口处（voice.go / voicerelay.go /
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

// voiceInvitePayload 是 voice-invite 的解析结果。
type voiceInvitePayload struct {
	RoomID         string
	TargetSocketID string
	Kind           string
}

// validVoiceInviteKind 只接受 livekit / relay 两种邀请方式。
func validVoiceInviteKind(kind string) bool {
	return kind == "livekit" || kind == "relay"
}

// parseVoiceInvite 解析 voice-invite 参数（纯函数，便于单测）。
// ok 为 false 表示缺字段或 kind 非法；调用方据此回 ack。
func parseVoiceInvite(args []json.RawMessage) (voiceInvitePayload, bool) {
	raw := struct {
		RoomID         string `json:"roomId"`
		TargetSocketID string `json:"targetSocketId"`
		Kind           string `json:"kind"`
	}{}
	if len(args) > 0 && len(args[0]) > 0 {
		_ = json.Unmarshal(args[0], &raw)
	}
	invite := voiceInvitePayload{
		RoomID:         strings.TrimSpace(raw.RoomID),
		TargetSocketID: strings.TrimSpace(raw.TargetSocketID),
		Kind:           strings.ToLower(strings.TrimSpace(raw.Kind)),
	}
	if invite.RoomID == "" || invite.TargetSocketID == "" || !validVoiceInviteKind(invite.Kind) {
		return invite, false
	}
	return invite, true
}

// screenE2EEKeyB64 返回房间的媒体密钥（base64 标准编码），开关关闭时为空串。
//
// 密钥直接随广播下发，观众不必再请求 /api/stream-push/watch：那条 HTTP 请求
// 会经过用户的反向代理（会覆盖 Cache-Control），一旦被缓存一小时，观众就会
// 拿着旧的「加密 + 旧密钥」去解已经切成明文的流，表现为永久黑屏。
// socket 广播走同一条已鉴权的长连接，没有缓存层，且观众本来就能通过 watch
// 接口拿到同一把密钥，信任边界不变。
//
// 密钥与加密上行（relayuplink）、watch 接口共用 mediaKey，因此广播里的值
// 一定和当前链路匹配；关闭时给空串，避免前端继续用解密 loader 解明文。
func (s *Server) screenE2EEKeyB64(roomID string, enabled bool) string {
	if !enabled {
		return ""
	}
	key := s.mediaKey(roomID)
	if len(key) == 0 {
		return ""
	}
	return base64.StdEncoding.EncodeToString(key)
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
		"screenE2EEKey":     s.screenE2EEKeyB64(roomID, state.ScreenE2EEEnabled),
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
	sc.On("voice-invite", func(args []json.RawMessage, ack func(...any)) {
		s.handleVoiceInvite(sc, args, ack)
	})
}

// handleRoomFeaturesGet 读取四个开关：房间成员可读。
func (s *Server) handleRoomFeaturesGet(sc *sio.Socket, args []json.RawMessage, ack func(...any)) {
	roomID, ok := parseRoomFeaturesGet(args)
	if !ok {
		voiceRelayAck(ack, false, "roomId 为必填项")
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	room, err := s.Rooms.FindByRoomID(ctx, roomID)
	if err != nil || room == nil || room.Status != "active" {
		voiceRelayAck(ack, false, "房间不存在或已关闭")
		return
	}
	if allowed, err := s.canReadRoom(ctx, roomID, voiceRelayClaims(sc)); err != nil || !allowed {
		voiceRelayAck(ack, false, "无权限：不在房间内")
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
			"screenE2EEKey":     s.screenE2EEKeyB64(roomID, state.ScreenE2EEEnabled),
		})
	}
}

// handleRoomFeaturesSet 修改四个开关：仅房主，至少给一个字段。
func (s *Server) handleRoomFeaturesSet(sc *sio.Socket, args []json.RawMessage, ack func(...any)) {
	payload := parseRoomFeaturesSet(args)
	if payload.RoomID == "" {
		voiceRelayAck(ack, false, "roomId 为必填项")
		return
	}
	if !payload.hasAnyField() {
		voiceRelayAck(ack, false, "参数不完整：至少提供一个开关")
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	host, err := s.RoomSvc.IsRoomHost(ctx, sc.ID, payload.RoomID)
	if err != nil {
		log.Printf("[room-features] 校验房主失败: %v", err)
		voiceRelayAck(ack, false, "校验房主失败")
		return
	}
	if !host {
		voiceRelayAck(ack, false, "无权限：仅房主可设置房间功能")
		return
	}

	room, err := s.Rooms.FindByRoomID(ctx, payload.RoomID)
	if err != nil || room == nil {
		voiceRelayAck(ack, false, "房间不存在或已关闭")
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
		voiceRelayAck(ack, false, "保存房间功能设置失败")
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
			"screenE2EEKey":     s.screenE2EEKeyB64(payload.RoomID, state.ScreenE2EEEnabled),
		})
	}
}

// handleVoiceInvite 让房主邀请房间里的某个成员加入语音。
//
// 只转发事件，不代替对方加入：是否接受由被邀请人决定，真正的加入仍然走
// /api/voice/token（livekit）或 voice-relay-join（relay），所以语音总开关
// 关闭时这里直接拒绝，避免发出必然失败的邀请。
func (s *Server) handleVoiceInvite(sc *sio.Socket, args []json.RawMessage, ack func(...any)) {
	invite, ok := parseVoiceInvite(args)
	if !ok {
		voiceRelayAck(ack, false, "参数不完整或邀请类型无效")
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	host, err := s.RoomSvc.IsRoomHost(ctx, sc.ID, invite.RoomID)
	if err != nil {
		log.Printf("[room-features] 校验房主失败: %v", err)
		voiceRelayAck(ack, false, "校验房主失败")
		return
	}
	if !host {
		voiceRelayAck(ack, false, "无权限：仅房主可邀请成员加入语音")
		return
	}

	room, err := s.Rooms.FindByRoomID(ctx, invite.RoomID)
	if err != nil || room == nil || room.Status != "active" {
		voiceRelayAck(ack, false, "房间不存在或已关闭")
		return
	}
	if !room.VoiceEnabled {
		voiceRelayAck(ack, false, "房主已关闭本房间语音")
		return
	}
	if invite.Kind == "relay" && !room.VoiceRelayEnabled {
		voiceRelayAck(ack, false, "房主已关闭中继语音")
		return
	}
	if s.Socket == nil || !s.Socket.Connected(invite.TargetSocketID) {
		voiceRelayAck(ack, false, "目标成员不在线")
		return
	}
	inRoom, err := s.RoomSvc.IsInRoom(ctx, invite.TargetSocketID, invite.RoomID)
	if err != nil {
		log.Printf("[room-features] 校验目标成员房间失败: %v", err)
		voiceRelayAck(ack, false, "校验目标成员失败")
		return
	}
	if !inRoom {
		voiceRelayAck(ack, false, "目标成员不在房间内")
		return
	}

	from := voiceRelayUsername(sc)
	if from == "" {
		from = "房主"
	}
	s.Socket.To(invite.TargetSocketID).Emit("voice-invite-received", map[string]any{
		"roomId": invite.RoomID,
		"kind":   invite.Kind,
		"from":   from,
	})
	if ack != nil {
		ack(map[string]any{
			"success":        true,
			"roomId":         invite.RoomID,
			"targetSocketId": invite.TargetSocketID,
			"kind":           invite.Kind,
		})
	}
}
