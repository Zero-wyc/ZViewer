package room

// 语音控制面的接线。
//
// 媒体端口没起来时 voiceRTC 为 nil，这一层完全不注册：前端从
// /api/voice/status 读到不可用，面板显示「语音暂不可用」。

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
