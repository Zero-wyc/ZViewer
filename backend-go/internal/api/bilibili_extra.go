package api

import (
	"log"
	"net/http"
	"strconv"

	"zviewer/backend/internal/auth"
	"zviewer/backend/internal/bilibili"
	"zviewer/backend/internal/httpx"
)

// registerBilibiliExtraRoutes 挂载弹幕与字幕两个端点（阶段 3E）。
//
// 它们都挂在 /api/stream 下，与 resolve.ts / bilibili-videos.routes.ts 的路径一致。
func (s *Server) registerBilibiliExtraRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/stream/bilibili/danmaku", s.Auth.Require(s.handleBilibiliDanmaku))
	mux.HandleFunc("GET /api/stream/bilibili/ai-subtitle", s.Auth.Require(s.handleBilibiliAISubtitle))
}

// handleBilibiliDanmaku 复刻 resolve.ts#GET /bilibili/danmaku。
//
// cid 优先；只给 bvid 时先查一次 view 接口补 cid（vid 可能对应多 P，取首 P）。
func (s *Server) handleBilibiliDanmaku(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()

	var cid int64
	if raw := query.Get("cid"); raw != "" {
		if v, err := strconv.ParseInt(raw, 10, 64); err == nil {
			cid = v
		}
	}

	if cid == 0 {
		rawBvid := query.Get("bvid")
		if rawBvid == "" {
			httpx.BadRequest(w, "缺少 cid 或 bvid 参数")
			return
		}
		bvid := bilibili.ExtractBvid(rawBvid)
		if bvid == "" {
			httpx.BadRequest(w, "无法解析 BV 号")
			return
		}
		info, err := s.Bilibili.GetVideoInfo(r.Context(), bvid, s.requestCookie(r))
		if err != nil {
			log.Printf("[bilibili] danmaku video info error: %v", err)
			httpx.Fail(w, http.StatusInternalServerError, err.Error())
			return
		}
		if info == nil || info.Cid == 0 {
			httpx.Fail(w, http.StatusInternalServerError, "获取视频信息失败")
			return
		}
		cid = info.Cid
	}

	if cid <= 0 {
		httpx.BadRequest(w, "缺少 cid 或 bvid 参数")
		return
	}

	items, err := s.Bilibili.GetDanmaku(r.Context(), cid)
	if err != nil {
		log.Printf("[bilibili] danmaku fetch error: %v", err)
		httpx.Fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	httpx.OK(w, map[string]any{"success": true, "danmaku": items})
}

// handleBilibiliAISubtitle 复刻 bilibili-videos.routes.ts#GET /bilibili/ai-subtitle。
//
// 注意响应形状：**校验失败也是 200 + success:true + lines:[]**，
// 只多一个 message 说明原因。调用方据此显示「无歌词」，
// 而不是把它当成请求失败去重试——重试只会继续掷骰子。
func (s *Server) handleBilibiliAISubtitle(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	bvid := query.Get("bvid")
	cid, err := strconv.ParseInt(query.Get("cid"), 10, 64)
	if bvid == "" || err != nil || cid <= 0 {
		httpx.BadRequest(w, "参数无效")
		return
	}

	// 视频时长（秒，可选）：带内校验基准；非法值时服务端用官方时长兜底。
	durationSec := 0
	if raw := query.Get("duration"); raw != "" {
		if v, convErr := strconv.ParseFloat(raw, 64); convErr == nil && v > 0 && v < 86400 {
			durationSec = int(v)
		}
	}

	outcome := s.Bilibili.FetchSubtitle(r.Context(), bvid, cid, s.requestCookie(r), durationSec)
	if outcome.OK() {
		httpx.OK(w, map[string]any{
			"success": true,
			"lines":   outcome.Lines,
			"source":  outcome.Source,
		})
		return
	}
	payload := map[string]any{"success": true, "lines": []bilibili.SubtitleLine{}}
	if outcome.Reason != "" {
		payload["message"] = outcome.Reason
	}
	httpx.OK(w, payload)
}

// requestCookie 取当前登录用户的 B站 Cookie（未绑定则为空串）。
func (s *Server) requestCookie(r *http.Request) string {
	claims := auth.ClaimsFrom(r.Context())
	if claims == nil || s.Bilibili == nil || claims.UserID <= 0 {
		return ""
	}
	return s.Bilibili.Creds.GetCookie(r.Context(), strconv.FormatInt(claims.UserID, 10))
}
