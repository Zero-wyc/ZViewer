package api

import (
	"net/http"

	"zviewer/backend/internal/httpx"
)

// registerVoiceRoutes 挂载 /api/voice。
//
// 只剩一个状态端点。语音已经全部走自建 SFU（internal/voicertc），
// 凭证签发、服务端禁言、踢人这些以前需要 REST 的能力，现在都在房间连接
// 上用 `voice` 事件完成，权限在服务端校验——房间里本来就只有一条实时通道，
// 再为它们开三条 HTTP 端点只会让「谁在管权限」变得含糊。
func (s *Server) registerVoiceRoutes(mux *http.ServeMux) {
	// 状态无需鉴权：游客也要能在房间里看到语音入口能不能点。
	mux.HandleFunc("GET /api/voice/status", s.handleVoiceStatus)
}

// handleVoiceStatus 报告语音是否可用，以及走哪条链路。
//
// backend 只有两个取值：`piik` 表示信令与媒体都由 Piik 的 /signal 承载；
// `sfu` 是旧的 socket.io + 服务端 SFU。前端按这个值选实现，不需要自己
// 探测——探测失败的表现是「点加入语音一直转圈」，最难自查。
func (s *Server) handleVoiceStatus(w http.ResponseWriter, _ *http.Request) {
	backend := "sfu"
	// Piik 的语音不需要服务端媒体面：树是客户端之间的 P2P。
	if s.PiikShare != nil {
		backend = "piik"
	}
	available := s.PiikShare != nil || (s.VoiceRTC != nil && s.VoiceRTC.Available())
	httpx.OK(w, map[string]any{
		"success":   true,
		"available": available,
		"backend":   backend,
	})
}
