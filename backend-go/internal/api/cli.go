package api

import (
	"log"
	"net/http"
	"strconv"
	"strings"

	"zviewer/backend/internal/bilibili"
	"zviewer/backend/internal/httpx"
)

// registerCLIRoutes 挂载 CLI 本地代理专用端点（复刻 routes/cli.ts）。
//
// 这个端点**不做 ZViewer 鉴权**：调用方是用户本机运行的 ZViewer CLI，
// 它用自己的 B站 Cookie（请求头直接带上来）解析高画质，再由 CLI 把流转给
// 浏览器。加 ZViewer 登录态反而会让「只想用 CLI 看视频」的用户卡住。
func (s *Server) registerCLIRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/cli/resolve", s.handleCLIResolve)
}

// handleCLIResolve 解析 B站 视频并返回直链（与 /api/stream/resolve-bilibili
// 的 done 消息同构，但非流式：CLI 不需要进度）。
func (s *Server) handleCLIResolve(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	bvid := query.Get("bvid")
	if strings.TrimSpace(bvid) == "" {
		httpx.Fail(w, http.StatusBadRequest, "缺少 bvid 参数")
		return
	}

	var cid int64
	if raw := strings.TrimSpace(query.Get("cid")); raw != "" {
		parsed, err := strconv.ParseFloat(raw, 64)
		if err != nil {
			httpx.Fail(w, http.StatusBadRequest, "cid 格式错误")
			return
		}
		cid = int64(parsed)
	}

	qn := 0
	if raw := strings.TrimSpace(query.Get("qn")); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil {
			qn = parsed
		}
	}
	preferMp4 := query.Get("preferMp4") == "true" || query.Get("preferMp4") == "1"
	forceDash := query.Get("forceDash") == "true" || query.Get("forceDash") == "1"

	// CLI 用的是用户自己的 Cookie，整串原样透传给解析链。
	cookie := r.Header.Get("Cookie")

	result, err := s.Bilibili.Resolve(r.Context(), bilibili.ResolveOptions{
		URL:    "https://www.bilibili.com/video/" + bvid,
		Cookie: cookie,
		Qn:     qn,
		Cid:    cid,
		// CLI 走本地代理播放：视频流由用户本机拉取，服务端的 CDN 探测结果
		// 不能代表用户网络，误判会导致降级成 MP4。
		SkipCdnCheck: true,
		PreferMp4:    preferMp4,
		ForceDash:    forceDash,
		OnProgress:   func(bilibili.ResolveProgress) {},
	})
	if err != nil {
		log.Printf("[cli] resolve error: %v", err)
		code, message := bilibili.NormalizeResolveError(err)
		httpx.FailWithCode(w, http.StatusInternalServerError, message, code)
		return
	}

	httpx.OK(w, map[string]any{
		"success":       true,
		"title":         result.Title,
		"duration":      result.Duration,
		"cid":           result.Cid,
		"videoUrl":      result.VideoURL,
		"audioUrl":      result.AudioURL,
		"videoCodec":    result.VideoCodec,
		"audioCodec":    result.AudioCodec,
		"format":        result.Format,
		"loggedIn":      result.LoggedIn,
		"vipStatus":     result.VipStatus,
		"currentQn":     result.CurrentQn,
		"acceptQuality": result.AcceptQuality,
		"isHdr":         result.IsHDR,
		"hdrType":       result.HdrType,
		"videoCodecid":  result.VideoCodecid,
		"pages":         result.Pages,
		"currentPage":   result.CurrentPage,
	})
}
