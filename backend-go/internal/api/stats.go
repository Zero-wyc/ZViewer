package api

import (
	"net/http"

	"zviewer/backend/internal/httpx"
	"zviewer/backend/internal/traffic"
)

// registerStatsRoutes 挂载统计端点（复刻 routes/stats.ts）。
func (s *Server) registerStatsRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/stats/traffic", s.Auth.RequireRoot(s.handleTrafficStats))
}

// handleTrafficStats 返回服务端网卡累计流量与即时速度（仅 root）。
//
// 取不到时回 501 而不是 0：前端据此隐藏「服务端流量」区块，
// 回 0 会让用户以为服务器真的没有流量。
func (s *Server) handleTrafficStats(w http.ResponseWriter, r *http.Request) {
	stats, ok := traffic.Get(r.Context())
	if !ok {
		httpx.Fail(w, http.StatusNotImplemented, "当前平台不支持网络流量统计")
		return
	}
	httpx.OK(w, map[string]any{"success": true, "stats": stats})
}
