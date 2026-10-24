package api

import (
	"net/http"
	"time"

	"zviewer/backend/internal/httpx"
)

// handleHealth 健康检查。
//
// 字段与 Node 版一致：startedAt 是毫秒时间戳（数字，不是字符串），
// 前端靠它判断后端是否发生过自动重启并提示用户刷新。
func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	httpx.OK(w, map[string]any{
		"status":       "ok",
		"timestamp":    time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
		"startedAt":    s.Cfg.StartedAt.UnixMilli(),
		"restartCount": s.Cfg.RestartCount,
	})
}
