package api

import (
	"errors"
	"log"
	"net/http"
	"strconv"

	"zviewer/backend/internal/auth"
	"zviewer/backend/internal/httpx"
	"zviewer/backend/internal/openlist"
	"zviewer/backend/internal/proxy"
	"zviewer/backend/internal/store"
)

// registerMountStreamRoutes 挂载影片流代理。
//
// 目前只接 OpenList —— 它是唯一「先换签名直链再代理」的源；webdav/ftp/
// emby/jellyfin 是直接把文件字节转发出去，实现方式不同，随后单独接。
func (s *Server) registerMountStreamRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/openlist/stream", s.Auth.Require(s.handleOpenListStream))
}

// requireMovieReadAccess 校验 movieId 参数 + 影片存在 + 房间可读。
//
// 返回影片实体，失败时已写好响应。与 room-access.ts#requireMovieReadAccess
// 一致：先 400（参数）、再 404（影片）、最后 403（准入）。
//
// 为什么媒体流也要过房间准入：影片流地址是可以被随意拼接的
// `/api/openlist/stream?movieId=1`，不校验准入等于把房主的 NAS 开放给全站。
func (s *Server) requireMovieReadAccess(w http.ResponseWriter, r *http.Request) (*store.Movie, bool) {
	raw := r.URL.Query().Get("movieId")
	if raw == "" {
		raw = r.PathValue("movieId")
	}
	if raw == "" {
		httpx.BadRequest(w, "movieId 参数无效")
		return nil, false
	}
	id, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || id <= 0 {
		httpx.BadRequest(w, "movieId 参数无效")
		return nil, false
	}
	movie, err := s.Movies.FindByID(r.Context(), id)
	if err != nil {
		if errors.Is(err, store.ErrMovieNotFound) {
			httpx.NotFound(w, "影片不存在")
			return nil, false
		}
		httpx.InternalError(w, "GET /api/*/stream", err)
		return nil, false
	}
	allowed, err := s.canReadRoom(r.Context(), movie.RoomID, auth.ClaimsFrom(r.Context()))
	if err != nil {
		httpx.InternalError(w, "GET /api/*/stream", err)
		return nil, false
	}
	if !allowed {
		httpx.Forbidden(w, "请先通过房间准入验证")
		return nil, false
	}
	return movie, true
}

// sendStreamError 统一输出影片流解析错误。
//
// 状态码与 code 都下发：前端按 code 分流（比如 AUTH_FAILED 提示去检查挂载
// 密码，NOT_FOUND 提示文件被移动）。从缓存命中的「影片不存在」不打日志——
// 观众端自动重试会把它刷成风暴。
func sendStreamError(w http.ResponseWriter, tag string, err error) {
	var se *proxy.StreamError
	if errors.As(err, &se) {
		if !se.FromCache {
			log.Printf("[%s] stream %s %d: %s", tag, se.Code, se.Status, se.Message)
		}
		httpx.FailWithCode(w, se.Status, se.Message, se.Code)
		return
	}
	var oe *openlist.Error
	if errors.As(err, &oe) {
		status := http.StatusBadRequest
		switch oe.Code {
		case openlist.CodeAuthFailed:
			status = http.StatusUnauthorized
		case openlist.CodeNotFound:
			status = http.StatusNotFound
		}
		log.Printf("[%s] stream %s %d: %s", tag, oe.Code, status, oe.Message)
		httpx.FailWithCode(w, status, oe.Message, oe.Code)
		return
	}
	log.Printf("[%s] stream 内部错误: %v", tag, err)
	httpx.InternalError(w, "GET /api/*/stream", err)
}

func (s *Server) handleOpenListStream(w http.ResponseWriter, r *http.Request) {
	// 参数区分两种失败：完全没传 vs 传了非数字。文案与 Node 一致。
	if r.URL.Query().Get("movieId") == "" {
		httpx.BadRequest(w, "缺少 movieId 参数")
		return
	}
	if _, ok := s.requireMovieReadAccess(w, r); !ok {
		return
	}

	movieID, err := proxy.MovieIDFromRequest(r)
	if err != nil {
		httpx.BadRequest(w, "movieId 不正确")
		return
	}

	resolved, err := s.Stream.Resolve(r.Context(), movieID, "openlist", &proxy.ResolveOptions{
		NormalizeServerURL: openlist.NormalizeServerURL,
	})
	if err != nil {
		sendStreamError(w, "openlist", err)
		return
	}

	serverURL := openlist.NormalizeServerURL(*resolved.Movie.ServerURL)
	moviePath := *resolved.Movie.Path
	cacheKey := "movie:" + strconv.FormatInt(movieID, 10)

	info, err := s.OpenList.CachedFileInfo(r.Context(), cacheKey, serverURL, resolved.Username, resolved.Password, moviePath)
	if err != nil {
		// 签名可能已过期：清缓存重取一次。第二次仍失败才算真失败。
		s.OpenList.InvalidateRawURL(cacheKey)
		info, err = s.OpenList.CachedFileInfo(r.Context(), cacheKey, serverURL, resolved.Username, resolved.Password, moviePath)
		if err != nil {
			sendStreamError(w, "openlist", err)
			return
		}
	}

	name := info.Name
	if name == "" {
		name = moviePath
	}
	contentType := proxy.ContentTypeForFormat(proxy.DetectMediaFormat(name))

	rec := &statusRecorder{ResponseWriter: w}
	proxy.ProxyHTTPUpstream(rec, r, proxy.HTTPOptions{
		URL:                info.RawURL,
		CORS:               proxy.CORSWildcard,
		DefaultContentType: contentType,
		LogTag:             "openlist-stream",
		ErrorMessage:       "OpenList 影片流错误",
	})
	// 上游回 401/403/410 意味着签名失效：清掉缓存，客户端下一次 Range
	// 请求就会重新 fs/get 拿新直链。这里不能直接重发响应（头已经出去了）。
	if rec.status == http.StatusUnauthorized || rec.status == http.StatusForbidden || rec.status == http.StatusGone {
		s.OpenList.InvalidateRawURL(cacheKey)
	}
}
