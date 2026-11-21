package api

import (
	"log"
	"net/http"
	"strconv"
	"strings"

	"zviewer/backend/internal/httpx"
	"zviewer/backend/internal/ncm"
)

const ncmLoginRequiredMessage = "请先登录网易云账号（面板底部账号区可扫码登录）"

// handleMusicUserSearch 搜索网易云用户。
func (s *Server) handleMusicUserSearch(w http.ResponseWriter, r *http.Request) {
	keywords := strings.TrimSpace(r.URL.Query().Get("keywords"))
	if keywords == "" {
		httpx.JSON(w, http.StatusBadRequest, map[string]any{
			"success": false, "code": "BAD_REQUEST", "message": "请输入要搜索的用户名",
		})
		return
	}
	cookie, _ := s.musicAccountForRequest(r)
	limit := musicQueryInt(r, "limit", 20, 1, 50)
	offset := musicQueryInt(r, "offset", 0, 0, 100000)
	users, total, err := s.NCM.SearchUsers(r.Context(), keywords, limit, offset, cookie)
	if err != nil {
		s.writeMusicUserError(w, "搜索用户失败", err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"success": true, "users": users, "total": total,
	})
}

// handleMusicUserFollows 读取当前账号（或指定 uid）关注的人。
func (s *Server) handleMusicUserFollows(w http.ResponseWriter, r *http.Request) {
	cookie, _ := s.musicAccountForRequest(r)
	uid, ok := s.resolveMusicUserUID(w, r, cookie)
	if !ok {
		return
	}
	limit := musicQueryInt(r, "limit", 30, 1, 100)
	offset := musicQueryInt(r, "offset", 0, 0, 100000)
	users, more, err := s.NCM.UserFollows(r.Context(), uid, limit, offset, true, cookie)
	if err != nil {
		s.writeMusicUserError(w, "获取关注列表失败", err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"success": true, "uid": uid, "users": users, "more": more,
	})
}

// handleMusicUserFollowers 读取当前账号（或指定 uid）的粉丝。
func (s *Server) handleMusicUserFollowers(w http.ResponseWriter, r *http.Request) {
	cookie, _ := s.musicAccountForRequest(r)
	uid, ok := s.resolveMusicUserUID(w, r, cookie)
	if !ok {
		return
	}
	limit := musicQueryInt(r, "limit", 30, 1, 100)
	offset := musicQueryInt(r, "offset", 0, 0, 100000)
	users, more, err := s.NCM.UserFolloweds(r.Context(), uid, limit, offset, cookie)
	if err != nil {
		s.writeMusicUserError(w, "获取粉丝列表失败", err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"success": true, "uid": uid, "users": users, "more": more,
	})
}

// handleMusicUserPlaylists 读取某个用户的歌单；uid 省略时用当前账号。
func (s *Server) handleMusicUserPlaylists(w http.ResponseWriter, r *http.Request) {
	cookie, _ := s.musicAccountForRequest(r)
	uid, ok := s.resolveMusicUserUID(w, r, cookie)
	if !ok {
		return
	}
	limit := musicQueryInt(r, "limit", 100, 1, 500)
	offset := musicQueryInt(r, "offset", 0, 0, 100000)
	playlists, more, err := s.NCM.UserPlaylists(r.Context(), uid, limit, offset, cookie)
	if err != nil {
		s.writeMusicUserError(w, "获取用户歌单失败", err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"success": true, "uid": uid, "playlists": playlists, "more": more,
	})
}

// handleMusicPlaylistSongs 解析歌单歌曲并归一化成前端可直接入队的结构。
func (s *Server) handleMusicPlaylistSongs(w http.ResponseWriter, r *http.Request) {
	rawID := strings.TrimSpace(r.URL.Query().Get("id"))
	id, err := strconv.ParseInt(rawID, 10, 64)
	if err != nil || id <= 0 {
		httpx.JSON(w, http.StatusBadRequest, map[string]any{
			"success": false, "code": "BAD_REQUEST", "message": "缺少有效的歌单 id",
		})
		return
	}
	cookie, _ := s.musicAccountForRequest(r)
	limit := musicQueryInt(r, "limit", 200, 1, 500)
	offset := musicQueryInt(r, "offset", 0, 0, 100000)
	songs, err := s.NCM.PlaylistSongs(r.Context(), id, limit, offset, cookie)
	if err != nil {
		s.writeMusicUserError(w, "获取歌单歌曲失败", err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"success": true, "songs": songs,
	})
}

// musicAccountForRequest 取房间内当前生效的网易云凭证 cookie。
func (s *Server) musicAccountForRequest(r *http.Request) (string, int64) {
	userID := s.effectiveRoomAccountUserID(r.Context(), r, roomAccountProviderNCM)
	credential, err := s.NCM.LoadCredential(r.Context(), userID)
	if err != nil {
		log.Printf("[music] 读取用户凭证失败: %v", err)
		return "", userID
	}
	return ncm.CookieHeaderFor(credential), userID
}

// resolveMusicUserUID 解析 uid 参数；省略时取当前生效账号。
func (s *Server) resolveMusicUserUID(w http.ResponseWriter, r *http.Request, cookie string) (int64, bool) {
	raw := strings.TrimSpace(r.URL.Query().Get("uid"))
	if raw != "" {
		uid, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || uid <= 0 {
			httpx.JSON(w, http.StatusBadRequest, map[string]any{
				"success": false, "code": "BAD_REQUEST", "message": "uid 参数无效",
			})
			return 0, false
		}
		return uid, true
	}
	if cookie == "" {
		httpx.JSON(w, http.StatusUnauthorized, map[string]any{
			"success": false, "code": "NCM_NOT_LOGGED_IN", "message": ncmLoginRequiredMessage,
		})
		return 0, false
	}
	uid, err := s.NCM.CurrentAccountUID(r.Context(), cookie)
	if err != nil {
		s.writeMusicUserError(w, "获取当前账号失败", err)
		return 0, false
	}
	if uid <= 0 {
		httpx.JSON(w, http.StatusUnauthorized, map[string]any{
			"success": false, "code": "NCM_NOT_LOGGED_IN", "message": ncmLoginRequiredMessage,
		})
		return 0, false
	}
	return uid, true
}

func (s *Server) writeMusicUserError(w http.ResponseWriter, message string, err error) {
	log.Printf("[music] %s: %v", message, err)
	httpx.JSON(w, http.StatusBadGateway, map[string]any{
		"success": false, "code": "UPSTREAM_ERROR", "message": message,
	})
}

func musicQueryInt(r *http.Request, key string, fallback, min, max int) int {
	raw := strings.TrimSpace(r.URL.Query().Get(key))
	if raw == "" {
		return fallback
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		return fallback
	}
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}
