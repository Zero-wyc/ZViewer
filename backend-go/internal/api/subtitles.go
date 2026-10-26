// 字幕自动搜索 / 目录浏览 / 内嵌字幕路由。
//
// 迁移自 backend/src/routes/subtitles.ts，挂载路径 /api/subtitles：
//
//	GET /search?movieId=                   搜索影片同目录下的同名字幕
//	GET /browse?movieId=&path=             浏览影片所在目录
//	GET /load?movieId=&path=               读取字幕文件内容
//	GET /embedded-tracks?movieId=          列出 Emby 内嵌字幕轨道
//	GET /embedded-extract?movieId=&index=  提取内嵌字幕轨道内容
//
// 每源编排已下沉 internal/subtitle，这里只做参数校验、源类型门禁与响应组装。
package api

import (
	"errors"
	"log"
	"math"
	"net/http"
	"strconv"
	"strings"

	"zviewer/backend/internal/auth"
	"zviewer/backend/internal/httpx"
	"zviewer/backend/internal/subtitle"
)

func (s *Server) registerSubtitleRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/subtitles/search", s.Auth.Require(s.handleSubtitleSearch))
	mux.HandleFunc("GET /api/subtitles/browse", s.Auth.Require(s.handleSubtitleBrowse))
	mux.HandleFunc("GET /api/subtitles/load", s.Auth.Require(s.handleSubtitleLoad))
	mux.HandleFunc("GET /api/subtitles/embedded-tracks", s.Auth.Require(s.handleSubtitleEmbeddedTracks))
	mux.HandleFunc("GET /api/subtitles/embedded-extract", s.Auth.Require(s.handleSubtitleEmbeddedExtract))
}

// sendSubtitleError 按 *subtitle.ServiceError 的状态码回写，其余用 fallback。
//
// 刻意不用 httpx.InternalError：Node 侧字幕路由的 catch 是直接
//
//	res.status(500).json({ message: err.message })
//
// 也就是说上游（WebDAV / FTP / Emby）的原始错误文案会原样透给前端。
// 换成通用「服务器内部错误」会让用户彻底无从下手（比如「AList 认证失败」
// 被吞成「服务器内部错误」，用户永远不知道该去改挂载密码）。
//
// fallbackStatus 按端点区分：/browse 与 /load 的 catch 默认 500，
// 两条 /embedded-* 的 catch 默认 400（见 routes/subtitles.ts 各 catch 块）。
func sendSubtitleError(w http.ResponseWriter, scope string, err error, message string, fallbackStatus int) {
	status := fallbackStatus
	var se *subtitle.ServiceError
	if errors.As(err, &se) {
		status = se.Status
	} else {
		log.Printf("[subtitles] %s error: %v", scope, err)
	}
	if msg := err.Error(); msg != "" {
		message = msg
	}
	if status == http.StatusRequestEntityTooLarge {
		httpx.FailWithCode(w, status, message, "SUBTITLE_TOO_LARGE")
		return
	}
	httpx.Fail(w, status, message)
}

// handleSubtitleSearch 复刻 routes/subtitles.ts#GET /search。
func (s *Server) handleSubtitleSearch(w http.ResponseWriter, r *http.Request) {
	movie, ok := s.requireMovieReadAccess(w, r)
	if !ok {
		return
	}
	results, err := s.Subtitles.SearchSubtitlesInMovieDir(r.Context(), movie)
	if err != nil {
		sendSubtitleError(w, "search", err, "搜索字幕失败", http.StatusInternalServerError)
		return
	}
	if results == nil {
		results = []subtitle.SearchResult{}
	}
	httpx.OK(w, map[string]any{"success": true, "subtitles": results})
}

// handleSubtitleBrowse 复刻 routes/subtitles.ts#GET /browse。
func (s *Server) handleSubtitleBrowse(w http.ResponseWriter, r *http.Request) {
	movie, ok := s.requireMovieReadAccess(w, r)
	if !ok {
		return
	}
	source := strings.ToLower(derefOr(movie.Source, ""))
	if !subtitle.IsFileSource(source) {
		httpx.BadRequest(w, "该影片源类型不支持目录浏览")
		return
	}
	if derefOr(movie.Path, "") == "" {
		httpx.BadRequest(w, "影片没有路径信息")
		return
	}

	// 目标目录：优先 query path，否则用影片所在目录。
	targetPath := subtitle.Dirname(*movie.Path)
	if raw := strings.TrimSpace(r.URL.Query().Get("path")); raw != "" {
		targetPath = raw
	}

	if !s.subtitlePathAllowed(r, movie.RoomID, *movie.Path, targetPath, true) {
		httpx.Forbidden(w, "只能浏览当前影片的字幕目录")
		return
	}
	result, err := s.Subtitles.BrowseMovieDirectory(r.Context(), movie, targetPath)
	if err != nil {
		sendSubtitleError(w, "browse", err, "浏览目录失败", http.StatusInternalServerError)
		return
	}
	httpx.OK(w, map[string]any{
		"success":     true,
		"entries":     result.Entries,
		"currentPath": result.CurrentPath,
		"parentPath":  result.ParentPath,
	})
}

// handleSubtitleLoad 复刻 routes/subtitles.ts#GET /load。
func (s *Server) handleSubtitleLoad(w http.ResponseWriter, r *http.Request) {
	movie, ok := s.requireMovieReadAccess(w, r)
	if !ok {
		return
	}
	filePath := strings.TrimSpace(r.URL.Query().Get("path"))
	if filePath == "" {
		httpx.BadRequest(w, "缺少 path 参数")
		return
	}
	source := strings.ToLower(derefOr(movie.Source, ""))
	if !subtitle.IsFileSource(source) {
		httpx.BadRequest(w, "该影片源类型不支持字幕加载")
		return
	}

	if movie.Path == nil || !s.subtitlePathAllowed(r, movie.RoomID, *movie.Path, filePath, false) {
		httpx.Forbidden(w, "字幕不属于当前影片目录")
		return
	}
	result, err := s.Subtitles.LoadSubtitleFile(r.Context(), movie, filePath)
	if err != nil {
		sendSubtitleError(w, "load", err, "加载字幕失败", http.StatusInternalServerError)
		return
	}
	httpx.OK(w, map[string]any{
		"success":  true,
		"filename": result.Filename,
		"format":   result.Format,
		"content":  result.Content,
	})
}

// handleSubtitleEmbeddedTracks 复刻 routes/subtitles.ts#GET /embedded-tracks。
//
// 只有 emby / jellyfin 有后端探测能力；其余源的内嵌字幕提取已前端化
// （浏览器端自行 MKV demux），后端再探测没有意义。
func (s *Server) handleSubtitleEmbeddedTracks(w http.ResponseWriter, r *http.Request) {
	movie, ok := s.requireMovieReadAccess(w, r)
	if !ok {
		return
	}
	source := strings.ToLower(derefOr(movie.Source, ""))
	if source != "emby" && source != "jellyfin" {
		httpx.BadRequest(w, "该来源的内嵌字幕提取已前端化，后端不再提供探测")
		return
	}
	tracks, err := s.Subtitles.ListEmbyEmbeddedTracks(r.Context(), movie)
	if err != nil {
		// Node 这条路径的 catch 固定回 400，不打 500。
		httpx.Fail(w, http.StatusBadRequest, subtitleErrorMessage(err, "获取内嵌字幕轨道失败"))
		return
	}
	if tracks == nil {
		tracks = []subtitle.Track{}
	}
	httpx.OK(w, map[string]any{"success": true, "tracks": tracks})
}

// handleSubtitleEmbeddedExtract 复刻 routes/subtitles.ts#GET /embedded-extract。
func (s *Server) handleSubtitleEmbeddedExtract(w http.ResponseWriter, r *http.Request) {
	movie, ok := s.requireMovieReadAccess(w, r)
	if !ok {
		return
	}
	// movieId 已被中间件保证合法，这里只需 index 是有限数。
	//
	// 必须区分「参数缺失」与「参数为空串」：
	//   - `?movieId=4`            → req.query.index 是 undefined → Number()=NaN → 400
	//   - `?movieId=4&index=`     → ''                → Number('')=0   → 合法（轨道 0）
	// 只看「解析出来是不是有限数」会把前者误判成 0，进而落到
	// 「该影片未挂载服务器信息」，与 Node 的文案分叉。
	query := r.URL.Query()
	if !query.Has("index") {
		httpx.BadRequest(w, "缺少或无效的 movieId/index 参数")
		return
	}
	index, err := jsNumber(query.Get("index"))
	if err != nil || math.IsNaN(index) || math.IsInf(index, 0) {
		httpx.BadRequest(w, "缺少或无效的 movieId/index 参数")
		return
	}

	source := strings.ToLower(derefOr(movie.Source, ""))
	if source != "emby" && source != "jellyfin" {
		httpx.BadRequest(w, "该来源的内嵌字幕提取已前端化，后端不再提供提取")
		return
	}
	result, err := s.Subtitles.ExtractEmbyEmbeddedTrack(r.Context(), movie, index)
	if err != nil {
		sendSubtitleError(w, "embedded-extract", err, "提取内嵌字幕失败", http.StatusBadRequest)
		return
	}
	httpx.OK(w, map[string]any{
		"success":  true,
		"content":  result.Content,
		"format":   result.Format,
		"label":    result.Label,
		"language": result.Language,
	})
}

// subtitleErrorMessage 取错误文案（空时用兜底）。
func subtitleErrorMessage(err error, fallback string) string {
	if err == nil {
		return fallback
	}
	if msg := err.Error(); msg != "" {
		return msg
	}
	return fallback
}

// jsNumber 复刻 JS 的 `Number(str)` 语义中本端点会用到的子集。
//
// 与 strconv.ParseFloat 的差异必须补齐：
//   - `Number(”)` → 0（ParseFloat 报错）
//   - `Number('  12  ')` → 12（ParseFloat 认前后空白，行为一致）
//   - `Number('abc')` → NaN（返回错误，等价）
//   - `Number(null)` 不适用（query 取不到是空串）
//
// 十六进制/Infinity 等形态在这里直接用 ParseFloat 的失败路径挡掉即可：
// 它们最终都落到「400 缺少或无效的 movieId/index 参数」，与 Node 里
// `Number.isFinite` 为 false 的结果一致。
func jsNumber(raw string) (float64, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return 0, nil
	}
	return strconv.ParseFloat(trimmed, 64)
}

func (s *Server) subtitlePathAllowed(r *http.Request, roomID, moviePath, target string, directory bool) bool {
	if subtitle.WithinMovieDirectory(moviePath, target, directory) {
		return true
	}
	room, err := s.Rooms.FindByRoomID(r.Context(), roomID)
	return err == nil && canControlRoom(auth.ClaimsFrom(r.Context()), room)
}
