package api

import (
	"net/http"
	"strconv"

	"zviewer/backend/internal/auth"
	"zviewer/backend/internal/bilibili"
	"zviewer/backend/internal/httpx"
	"zviewer/backend/internal/store"
)

// handleResolveBilibiliLive 解析 B站 直播间取流地址。
//
// 与点播的 resolve-bilibili 不同，这里直接返回 JSON 而不是 NDJSON：
// 直播只需两次上游请求（房间信息 + 取流），没有「选 CDN / 校验可用性」
// 的长流程，流式进度没有可展示的内容。
//
// 响应里的 videoUrl 是 B站 直播 CDN 的签名地址，必须带 Referer
// live.bilibili.com 才能拉流——浏览器直连必然被拒，前端会把 format=flv
// 的 B站 域名地址统一包成服务器代理。
func (s *Server) handleResolveBilibiliLive(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	rawURL := query.Get("url")
	if rawURL == "" {
		httpx.BadRequest(w, "缺少直播间链接")
		return
	}

	// 观众端播放时带 movieId：与点播一致，改用房主的 B站 身份取流
	//（大会员账号能拿到原画，匿名只有低清晰度）。
	var sharedMovie *store.Movie
	if _, supplied := query["movieId"]; supplied {
		var ok bool
		sharedMovie, ok = s.requireMovieReadAccess(w, r)
		if !ok {
			return
		}
	}

	expanded := bilibili.ExpandShortLink(r.Context(), rawURL)
	roomID := bilibili.LiveRoomID(expanded)
	if roomID <= 0 {
		httpx.BadRequest(w, "无法解析直播间链接")
		return
	}

	var cookieOwnerID int64
	if claims := auth.ClaimsFrom(r.Context()); claims != nil {
		cookieOwnerID = claims.UserID
	}
	if sharedMovie != nil {
		if !s.liveMovieMatches(r, sharedMovie, roomID) {
			httpx.FailWithCode(w, http.StatusBadRequest, "请求资源不属于当前影片", "MOVIE_RESOURCE_MISMATCH")
			return
		}
		owner, err := s.Movies.RoomOwnerUserID(r.Context(), sharedMovie.ID)
		if err != nil {
			httpx.InternalError(w, "解析影片房主", err)
			return
		}
		cookieOwnerID = owner
	}

	cookie := ""
	if s.Bilibili != nil && cookieOwnerID > 0 {
		cookie = s.Bilibili.Creds.GetCookie(r.Context(), strconv.FormatInt(cookieOwnerID, 10))
	}

	qn := 0
	if v := query.Get("qn"); v != "" {
		if parsed, err := strconv.Atoi(v); err == nil && parsed > 0 {
			qn = parsed
		}
	}

	result, err := s.Bilibili.ResolveLive(r.Context(), roomID, qn, cookie)
	if err != nil {
		code, message := bilibili.NormalizeResolveError(err)
		httpx.FailWithCode(w, http.StatusBadGateway, message, code)
		return
	}

	room := result.Room
	payload := map[string]any{
		"success":     true,
		"roomId":      room.RoomID,
		"shortId":     room.ShortID,
		"uid":         room.UID,
		"title":       room.Title,
		"uname":       room.Uname,
		"cover":       room.Cover,
		"keyframe":    room.Keyframe,
		"area":        room.Area,
		"liveStatus":  room.LiveStatus,
		"liveTime":    room.LiveTime,
		"online":      room.Online,
		"format":      result.Format,
		"protocol":    result.Protocol,
		"codec":       result.Codec,
		"videoUrl":    result.VideoURL,
		"currentQn":   result.CurrentQn,
		"qualities":   result.Qualities,
		"expiresAt":   result.ExpiresAt,
		"resolvedUrl": bilibili.LiveRoomURL(room.RoomID),
	}
	if room.LiveStatus != 1 {
		payload["message"] = "主播当前未开播"
	}
	httpx.JSON(w, http.StatusOK, payload)
}

// liveMovieMatches 校验直播间是否就是该影片记录的房间。
func (s *Server) liveMovieMatches(r *http.Request, movie *store.Movie, roomID int64) bool {
	if movie.Source == nil || *movie.Source != "bilibili" {
		return false
	}
	stored := bilibili.LiveRoomID(bilibili.ExpandShortLink(r.Context(), movie.URL))
	return stored > 0 && stored == roomID
}
