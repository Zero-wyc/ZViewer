package api

import (
	"fmt"
	"io"
	"math"
	"net/http"
	"strconv"

	"zviewer/backend/internal/auth"
	"zviewer/backend/internal/clientlog"
	"zviewer/backend/internal/httpx"
)

// maxClientLogBody 是上报体上限：一次最多几百条，4MB 已是极宽松的上限。
const maxClientLogBody int64 = 4 << 20

// registerClientLogRoutes 挂载前端控制台日志上报端点。
//
// 刻意不强制鉴权：未登录用户 / 游客的报错恰恰是最需要收集的部分。
// 有登录态时从 cookie 里解析 userId 附到日志上，解析失败按匿名处理。
func (s *Server) registerClientLogRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/client-logs", s.handleClientLogs)
}

func (s *Server) handleClientLogs(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, maxClientLogBody))
	if err != nil {
		httpx.BadRequest(w, "读取请求体失败")
		return
	}
	entries := clientlog.UnmarshalBatch(body)
	if len(entries) == 0 {
		httpx.BadRequest(w, "entries 必须是数组")
		return
	}

	userID := s.userIDFromCookie(r)
	for i := range entries {
		if uid := userIDStringOf(entries[i].UserID); uid == "" {
			if userID != "" {
				entries[i].UserID = userID
			}
		}
	}

	// 异步写盘：日志量可能很大，不能让它拖慢上报请求的响应。
	go clientlog.WriteAll(s.Cfg.ProjectRoot, entries)

	w.WriteHeader(http.StatusNoContent)
}

// userIDFromCookie 从 access_token 解析当前用户 ID（失败返回空串）。
func (s *Server) userIDFromCookie(r *http.Request) string {
	token := auth.ExtractAccessToken(r)
	if token == "" {
		return ""
	}
	claims, err := s.Auth.Manager.VerifyAccess(token)
	if err != nil {
		return ""
	}
	return itoa64(claims.UserID)
}

// userIDStringOf 把上报里的 userId 归一成字符串（数字不能写成 3.0）。
func userIDStringOf(v any) string {
	switch val := v.(type) {
	case nil:
		return ""
	case string:
		return val
	case float64:
		if val == math.Trunc(val) {
			return strconv.FormatInt(int64(val), 10)
		}
		return strconv.FormatFloat(val, 'f', -1, 64)
	default:
		return fmt.Sprint(val)
	}
}
