package room

// 自建语音（VOICE_MODE=sfu）的控制面接线。
//
// 与 LiveKit 路线并存但互斥：process 模式下 voiceRTC 为 nil，这一层完全不注册，
// 语音仍走 /api/voice/token + livekit-client。

import (
	"encoding/json"

	"zviewer/backend/internal/sio"
	"zviewer/backend/internal/voicertc"
)

// bindVoiceRTC 挂上 `voice` 事件。
func (s *Service) bindVoiceRTC(sc *sio.Socket) {
	if s.voiceRTC == nil {
		return
	}
	conn := voicertc.Conn{ID: sc.ID, InRoom: sc.InRoom}
	sc.On(voicertc.Event, func(args []json.RawMessage, _ func(...any)) {
		s.voiceRTC.Handle(conn, args)
	})
}

// detachVoiceRTC 在连接断开时清理语音成员身份。
func (s *Service) detachVoiceRTC(socketID string) {
	if s.voiceRTC == nil {
		return
	}
	s.voiceRTC.Detach(socketID)
}

// dropVoiceRTCRoom 在房间关闭时收掉整个语音。
func (s *Service) dropVoiceRTCRoom(roomID string) {
	if s.voiceRTC == nil {
		return
	}
	s.voiceRTC.DropRoom(roomID)
}
