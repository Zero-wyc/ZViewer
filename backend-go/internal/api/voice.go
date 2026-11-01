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

// handleVoiceStatus 报告语音是否可用。
//
// 只有一条实现，所以不再有 mode。媒体面（端口）起不来就是不可用，
// 让面板显示「语音暂不可用」，而不是悄悄换一条没人维护的线路。
func (s *Server) handleVoiceStatus(w http.ResponseWriter, _ *http.Request) {
	available := s.VoiceRTC != nil && s.VoiceRTC.Available()
	httpx.OK(w, map[string]any{"success": true, "available": available})
}
