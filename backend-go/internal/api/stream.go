package api

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strconv"
	"time"

	"zviewer/backend/internal/auth"
	"zviewer/backend/internal/bilibili"
	"zviewer/backend/internal/httpx"
	"zviewer/backend/internal/store"
)

// registerStreamRoutes 挂载 /api/stream 下的解析端点。
func (s *Server) registerStreamRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/stream/resolve-bilibili", s.Auth.Require(s.handleResolveBilibili))
}

// ndjsonWriter 逐行写 NDJSON 并 flush。
//
// 不显式设置 Connection / Transfer-Encoding：这些是 hop-by-hop 头，
// 由 HTTP 服务器自己管；手写会和反向代理的头部冲突，浏览器拿不到增量数据。
type ndjsonWriter struct {
	w       http.ResponseWriter
	flusher http.Flusher
}

func newNDJSONWriter(w http.ResponseWriter) *ndjsonWriter {
	w.Header().Set("Content-Type", "application/x-ndjson")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	flusher, _ := w.(http.Flusher)
	return &ndjsonWriter{w: w, flusher: flusher}
}

func (n *ndjsonWriter) send(payload any) {
	line, err := json.Marshal(payload)
	if err != nil {
		log.Printf("[bilibili] NDJSON 序列化失败: %v", err)
		return
	}
	line = append(line, '\n')
	if _, err := n.w.Write(line); err != nil {
		return
	}
	if n.flusher != nil {
		n.flusher.Flush()
	}
}

func (n *ndjsonWriter) fail(message, code string) {
	n.send(map[string]any{"success": false, "status": "error", "message": message, "code": code})
}

// resolveProgressMessage 是进度行。
type resolveProgressMessage struct {
	Status  string `json:"status"`
	Step    string `json:"step,omitempty"`
	Message string `json:"message,omitempty"`
}

// resolveDoneMessage 是结果行：成功标记 + 解析结果全部字段。
type resolveDoneMessage struct {
	Success bool   `json:"success"`
	Status  string `json:"status"`
	*bilibili.ResolveResult
}

// handleResolveBilibili 复刻 routes/stream/resolve.ts#GET /resolve-bilibili。
//
// 输出走 NDJSON：解析过程有 4~8 秒，逐行推送进度让前端能显示「正在选择可用 CDN...」，
// 而不是干等一个空响应。
func (s *Server) handleResolveBilibili(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	rawURL := query.Get("url")
	if rawURL == "" {
		httpx.BadRequest(w, "缺少视频链接")
		return
	}

	claims := auth.ClaimsFrom(r.Context())
	var requesterID int64
	if claims != nil {
		requesterID = claims.UserID
	}

	// 短链展开：b23.tv 分享链接先 302 展开为完整地址，BV 识别与 ?p=N 才能生效。
	expanded := bilibili.ExpandShortLink(r.Context(), rawURL)

	// 提前校验：避免已经开始流式输出后才报 400（那时状态码已无法修改）。
	if bilibili.ExtractBvid(expanded) == "" && bilibili.ExtractBangumiID(expanded) == nil {
		httpx.BadRequest(w, "无法解析 B站 视频/番剧链接")
		return
	}

	qn := 0
	if v := query.Get("qn"); v != "" {
		if parsed, err := strconv.Atoi(v); err == nil {
			qn = parsed
		}
	}
	codec := query.Get("codec")
	page := 0
	if v := query.Get("page"); v != "" {
		if parsed, err := strconv.Atoi(v); err == nil {
			page = parsed
		}
	}
	preferMp4Param := query.Get("preferMp4") == "true" || query.Get("preferMp4") == "1"
	forceDashParam := query.Get("forceDash") == "true" || query.Get("forceDash") == "1"

	// 服务器端禁用 DASH 时强制 MP4，并禁止 forceDash
	//（只影响服务器端解析，CLI 代理模式走独立端点）。
	dashDisabled := false
	if s.Settings != nil {
		if settings, err := s.Settings.Get(r.Context()); err == nil {
			dashDisabled = settings.DashDisabled
		}
	}
	preferMp4 := dashDisabled || preferMp4Param
	forceDash := !dashDisabled && forceDashParam

	// 解析身份默认是请求者自己；带 movieId 时改用影片所属房间房主的 Cookie，
	// 让观众拿到与房主一致的解析结果（房主是大会员时才有完整会员集）。
	cookieOwnerID := requesterID
	if movieIDParam := query.Get("movieId"); movieIDParam != "" {
		if movieID, err := strconv.ParseInt(movieIDParam, 10, 64); err == nil && movieID > 0 && s.Movies != nil {
			ownerID, ownerErr := s.Movies.RoomOwnerUserID(r.Context(), movieID)
			switch {
			case ownerErr == nil:
				cookieOwnerID = ownerID
			case errors.Is(ownerErr, store.ErrMovieNotFound):
				log.Printf("[bilibili] movieId=%d 房间无房主或影片不存在，回退请求者 Cookie", movieID)
			default:
				log.Printf("[bilibili] movieId=%d 查询房主失败，回退请求者 Cookie: %v", movieID, ownerErr)
			}
		}
	}

	cookie := ""
	if s.Bilibili != nil && cookieOwnerID > 0 {
		cookie = s.Bilibili.Creds.GetCookie(r.Context(), strconv.FormatInt(cookieOwnerID, 10))
	}

	ownerLabel := "self"
	if cookieOwnerID != requesterID {
		ownerLabel = "host(" + strconv.FormatInt(cookieOwnerID, 10) + ")"
	}
	started := time.Now()
	log.Printf("[bilibili] resolve-bilibili start preferMp4=%t forceDash=%t qn=%d cookie=%t cookieOwner=%s url=%s",
		preferMp4, forceDash, qn, cookie != "", ownerLabel, truncate(expanded, 60))

	writer := newNDJSONWriter(w)
	result, err := s.Bilibili.Resolve(r.Context(), bilibili.ResolveOptions{
		URL:    expanded,
		Cookie: cookie,
		Qn:     qn,
		Codec:  codec,
		Page:   page,
		OnProgress: func(msg bilibili.ResolveProgress) {
			writer.send(resolveProgressMessage{Status: msg.Status, Step: msg.Step, Message: msg.Message})
		},
		PreferMp4: preferMp4,
		ForceDash: forceDash,
	})
	if err != nil {
		log.Printf("[bilibili] resolve-bilibili error: %v", err)
		code, message := bilibili.NormalizeResolveError(err)
		writer.fail(message, code)
		return
	}

	log.Printf("[bilibili] resolve-bilibili done format=%s qn=%d %s url=%s",
		result.Format, result.CurrentQn, time.Since(started).Round(time.Millisecond), truncate(expanded, 60))

	writer.send(resolveDoneMessage{Success: true, Status: "done", ResolveResult: result})
}

func truncate(s string, limit int) string {
	if len(s) <= limit {
		return s
	}
	return s[:limit]
}
