package api

import (
	"context"
	"encoding/json"
	"log"
	"math"
	"net/http"
	"strconv"
	"strings"

	"zviewer/backend/internal/auth"
	"zviewer/backend/internal/httpx"
	"zviewer/backend/internal/ncm"
)

// registerMusicRoutes 挂载 /api/music（一起听的网易云 REST 面）。
//
// 鉴权模型与 Node 一致：**可选鉴权**——带有效 token 时注入 req.user
// （登录态转发用），未登录/游客也放行，以匿名方式调用 NCM。游客不持久化
// 凭证（userId 唯一索引，避免所有游客共享同一份 cookie）。
func (s *Server) registerMusicRoutes(mux *http.ServeMux) {
	// 通用转发：/api/music/ncm/* → 内部 NCM 服务
	mux.HandleFunc("/api/music/ncm", s.Auth.Optional(s.handleNcmForward))
	mux.HandleFunc("/api/music/ncm/", s.Auth.Optional(s.handleNcmForward))

	mux.HandleFunc("GET /api/music/ncm-cookie", s.Auth.Optional(s.handleNcmCookie))
	mux.HandleFunc("POST /api/music/ncm-cookie-login", s.Auth.Optional(s.handleNcmCookieLogin))
	mux.HandleFunc("POST /api/music/cloud/upload", s.Auth.Optional(s.handleNcmCloudUpload))
	mux.HandleFunc("GET /api/music/album/full", s.Auth.Optional(s.handleNcmAlbumFull))
	mux.HandleFunc("GET /api/music/login/status", s.Auth.Optional(s.handleNcmLoginStatus))
	mux.HandleFunc("POST /api/music/logout", s.Auth.Optional(s.handleNcmLogout))
	// <audio> 标签带不了 Authorization 头，token 从 query 读取（ExtractAccessToken 支持）
	mux.HandleFunc("GET /api/music/stream", s.Auth.Optional(s.handleNcmStream))
	mux.HandleFunc("GET /api/music/song-quality", s.Auth.Optional(s.handleNcmSongQuality))
}

// musicUserID 取当前用户 id（游客/未登录为 0）。
func musicUserID(ctx context.Context) int64 {
	if claims := auth.ClaimsFrom(ctx); claims != nil && claims.UserID > 0 {
		return claims.UserID
	}
	return 0
}

// guestCredentialMessage 是「游客不持有凭证」三个端点的统一文案。
const guestCredentialMessage = "请先登录 ZViewer 账号（游客不持有凭证）"

// handleNcmForward 处理 /api/music/ncm/<任意路径> 的转发。
func (s *Server) handleNcmForward(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/api/music/ncm")
	if rest == "" {
		rest = "/"
	}
	if r.URL.RawQuery != "" {
		rest += "?" + r.URL.RawQuery
	}
	s.NCM.Forward(w, r, rest, musicUserID(r.Context()))
}

// handleNcmCookie 返回当前用户持久化的网易云 Cookie（迁移/备份用）。
func (s *Server) handleNcmCookie(w http.ResponseWriter, r *http.Request) {
	userID := musicUserID(r.Context())
	if userID <= 0 {
		httpx.JSON(w, http.StatusUnauthorized, map[string]any{
			"success": false, "message": guestCredentialMessage,
		})
		return
	}
	credential, err := s.NCM.LoadCredential(r.Context(), userID)
	if err != nil {
		httpx.JSON(w, http.StatusInternalServerError, map[string]any{
			"success": false, "message": "读取 Cookie 失败",
		})
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"success": true,
		"cookie":  ncm.CookieHeaderFor(credential),
	})
}

// handleNcmCookieLogin 用 Cookie 登录网易云，并校验登录态有效性。
func (s *Server) handleNcmCookieLogin(w http.ResponseWriter, r *http.Request) {
	userID := musicUserID(r.Context())
	if userID <= 0 {
		httpx.JSON(w, http.StatusUnauthorized, map[string]any{
			"success": false, "message": guestCredentialMessage,
		})
		return
	}

	var body struct {
		Cookie string `json:"cookie"`
	}
	// 请求体缺失/非法按空串处理（Node 是 `String(req.body?.cookie ?? '')`）
	_ = json.NewDecoder(r.Body).Decode(&body)
	raw := strings.TrimSpace(body.Cookie)
	if raw == "" {
		httpx.JSON(w, http.StatusBadRequest, map[string]any{
			"success": false, "message": "请输入 Cookie",
		})
		return
	}

	incoming := parseIncomingCookies(raw)
	if !hasMusicU(incoming) {
		httpx.JSON(w, http.StatusBadRequest, map[string]any{
			"success": false, "message": "Cookie 中缺少 MUSIC_U（请从已登录网易云音乐的浏览器复制）",
		})
		return
	}

	credential, err := s.NCM.LoadCredential(r.Context(), userID)
	if err != nil {
		log.Printf("[music] 读取凭证失败: %v", err)
		httpx.JSON(w, http.StatusInternalServerError, map[string]any{
			"success": false, "message": "Cookie 登录失败",
		})
		return
	}
	existing := []string(nil)
	if credential != nil {
		existing = ncm.ParseStoredCookies(credential.Cookies)
	}
	merged := ncm.MergeCookies(existing, incoming)

	// 用新 cookie 校验登录态并拉账号资料（昵称/头像缓存同步）
	encoded, err := json.Marshal(merged)
	if err != nil {
		httpx.JSON(w, http.StatusInternalServerError, map[string]any{
			"success": false, "message": "Cookie 登录失败",
		})
		return
	}
	result, err := s.NCM.Call(r.Context(), "/user/account", ncm.ToCookieHeader(string(encoded)))
	if err != nil {
		log.Printf("[music] ncm cookie-login error: %v", err)
		httpx.JSON(w, http.StatusInternalServerError, map[string]any{
			"success": false, "message": "Cookie 登录失败",
		})
		return
	}
	if len(result.Cookies) > 0 {
		merged = ncm.MergeCookies(merged, result.Cookies)
	}
	profile := ncm.ExtractProfile(result.Body)
	if profile == nil {
		httpx.JSON(w, http.StatusBadRequest, map[string]any{
			"success": false, "message": "Cookie 无效或已过期（未能取到网易云账号资料）",
		})
		return
	}

	if err := s.NCM.PersistCredential(r.Context(), userID, merged, result.Body); err != nil {
		log.Printf("[music] 凭证落库失败: %v", err)
		httpx.JSON(w, http.StatusInternalServerError, map[string]any{
			"success": false, "message": "Cookie 登录失败",
		})
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"success": true,
		"profile": map[string]any{
			"nickname":  profile.Nickname,
			"avatarUrl": profile.AvatarURL,
		},
	})
}

// handleNcmCloudUpload 处理云盘上传（multipart 流转发）。
func (s *Server) handleNcmCloudUpload(w http.ResponseWriter, r *http.Request) {
	s.NCM.CloudUpload(w, r, musicUserID(r.Context()))
}

// handleNcmAlbumFull 返回专辑详情（含全量歌曲补齐）。
func (s *Server) handleNcmAlbumFull(w http.ResponseWriter, r *http.Request) {
	id := biliNumber(r.URL.Query().Get("id"))
	if math.IsNaN(id) || math.IsInf(id, 0) || id <= 0 {
		httpx.JSON(w, http.StatusBadRequest, map[string]any{
			"code": "BAD_REQUEST", "message": "缺少有效的专辑 id",
		})
		return
	}
	credential, err := s.NCM.LoadCredential(r.Context(), musicUserID(r.Context()))
	if err != nil {
		log.Printf("[music] 读取凭证失败: %v", err)
	}
	body, err := s.NCM.AlbumWithFullSongs(r.Context(), id, ncm.CookieHeaderFor(credential))
	if err != nil {
		log.Printf("[music] 专辑详情获取失败: %v", err)
		httpx.JSON(w, http.StatusBadGateway, map[string]any{
			"code": "UPSTREAM_ERROR", "message": "专辑详情获取失败",
		})
		return
	}
	if body == nil {
		httpx.JSON(w, http.StatusBadGateway, map[string]any{
			"code": "UPSTREAM_ERROR", "message": "NCM 服务返回了无法解析的响应",
		})
		return
	}
	httpx.JSON(w, http.StatusOK, body)
}

// handleNcmLoginStatus 查询当前用户的网易云登录状态。
func (s *Server) handleNcmLoginStatus(w http.ResponseWriter, r *http.Request) {
	status, err := s.NCM.GetLoginStatus(r.Context(), musicUserID(r.Context()))
	if err != nil {
		log.Printf("[music] login/status error: %v", err)
		httpx.JSON(w, http.StatusInternalServerError, map[string]any{
			"code": "INTERNAL_ERROR", "message": "查询登录状态失败",
		})
		return
	}
	httpx.JSON(w, http.StatusOK, status)
}

// handleNcmLogout 删除当前用户持久化的网易云凭证。
func (s *Server) handleNcmLogout(w http.ResponseWriter, r *http.Request) {
	userID := musicUserID(r.Context())
	if userID > 0 {
		if err := s.NCM.Creds.DeleteByUserID(r.Context(), userID); err != nil {
			log.Printf("[music] logout error: %v", err)
			httpx.JSON(w, http.StatusInternalServerError, map[string]any{
				"code": "INTERNAL_ERROR", "message": "退出登录失败",
			})
			return
		}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"success": true})
}

// handleNcmStream 是音频流代理/直链解析。
//
// 流程：凭证回退链 → 沿音质降级链解析 → 直链域名校验（防 SSRF）→
// 直链模式 302 / 否则 Range 流式转发。
func (s *Server) handleNcmStream(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	songID := biliNumber(query.Get("songId"))
	if math.IsNaN(songID) || math.IsInf(songID, 0) || songID != math.Trunc(songID) || songID <= 0 {
		httpx.JSON(w, http.StatusBadRequest, map[string]any{
			"code": "INVALID_PARAMS", "message": "songId 参数无效",
		})
		return
	}
	userID := musicUserID(r.Context())
	requestedLevel := query.Get("level")
	if requestedLevel == "" {
		requestedLevel = "exhigh"
	}
	levels := ncm.QualityLevels(requestedLevel)
	roomID := query.Get("roomId")

	credential, err := s.NCM.CredentialForRequest(r.Context(), userID, roomID)
	if err != nil {
		log.Printf("[music] 读取凭证失败: %v", err)
	}
	cookieHeader := ncm.CookieHeaderFor(credential)
	credKey := ncm.CredentialKey(credential, userID)
	songIDInt := int64(songID)
	directMode := query.Get("direct") == "1"

	if directMode {
		if cached, hit := ncm.DirectURLCache.Get(credKey + ":" + requestedLevel + ":" + strconv.FormatInt(songIDInt, 10)); hit {
			httpx.JSON(w, http.StatusOK, map[string]any{
				"success": true, "url": cached, "level": requestedLevel, "cached": true,
			})
			return
		}
	}

	resolved, lastData := s.NCM.ResolveSongURLAlongChain(r.Context(), songIDInt, levels, cookieHeader)
	if resolved == nil {
		if lastData != nil && lastData["freeTrialInfo"] != nil {
			httpx.JSON(w, http.StatusForbidden, map[string]any{
				"code": "VIP_REQUIRED", "message": "需要登录网易云 VIP 账号",
			})
			return
		}
		// 全档都失败且不是试听 → 再问一次上游「这首歌到底能不能播」，
		// 用它把「本身没版权/已下架」与「上游偶发失败」分开。
		check, err := s.NCM.Call(r.Context(), "/check/music?id="+strconv.FormatInt(songIDInt, 10), cookieHeader)
		if err != nil {
			log.Printf("[music] 版权检查失败: %v", err)
			httpx.JSON(w, http.StatusBadGateway, map[string]any{
				"code": "UPSTREAM_ERROR", "message": "音频流代理失败",
			})
			return
		}
		if checkBody, ok := check.Body.(map[string]any); ok {
			if playable, ok := checkBody["success"].(bool); ok && !playable {
				log.Printf("[music] 歌曲 %d 不可播（上游 songCode=%v）", songIDInt, checkBody["songCode"])
				httpx.JSON(w, http.StatusNotFound, map[string]any{
					"code": "NO_COPYRIGHT", "message": "该歌曲暂无版权",
				})
				return
			}
		}
		httpx.JSON(w, http.StatusBadGateway, map[string]any{
			"code": "RESOLVE_FAILED", "message": "歌曲播放地址解析失败",
		})
		return
	}

	audioURL, _ := resolved["url"].(string)
	safeURL, valid := ncm.ValidateAudioURL(audioURL)
	if !valid {
		httpx.JSON(w, http.StatusBadGateway, map[string]any{
			"code": "RESOLVE_FAILED", "message": "歌曲播放地址解析失败",
		})
		return
	}

	if directMode {
		// 实际解析档位可能与请求档位不同（降级链），按实际档位缓存
		resolvedLevel, ok := resolved["level"].(string)
		if !ok || resolvedLevel == "" {
			resolvedLevel = requestedLevel
		}
		ncm.DirectURLCache.Set(credKey+":"+resolvedLevel+":"+strconv.FormatInt(songIDInt, 10), safeURL)
		// 302 把 CDN 直链交给 <audio> 直连（媒体元素自动跟随，Range 原样带到 CDN）；
		// 直链过期/失效时客户端 error 回退到 direct=0 的代理流
		w.Header().Set("Location", safeURL)
		w.WriteHeader(http.StatusFound)
		return
	}

	// 代理模式用原始地址（http 回源可行；https 改写只影响交给浏览器的直链）
	ncm.ProxyAudio(w, r, audioURL)
}

// handleNcmSongQuality 返回当前歌曲实际解析到的音质元数据。
func (s *Server) handleNcmSongQuality(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	songID := biliNumber(query.Get("songId"))
	if math.IsNaN(songID) || math.IsInf(songID, 0) || songID != math.Trunc(songID) || songID <= 0 {
		httpx.JSON(w, http.StatusBadRequest, map[string]any{
			"code": "INVALID_PARAMS", "message": "songId 参数无效",
		})
		return
	}
	userID := musicUserID(r.Context())
	requestedLevel := query.Get("level")
	if requestedLevel == "" {
		requestedLevel = "exhigh"
	}
	levels := ncm.QualityLevels(requestedLevel)
	roomID := query.Get("roomId")

	credential, err := s.NCM.CredentialForRequest(r.Context(), userID, roomID)
	if err != nil {
		log.Printf("[music] 读取凭证失败: %v", err)
	}
	cookieHeader := ncm.CookieHeaderFor(credential)
	credKey := ncm.CredentialKey(credential, userID)
	songIDInt := int64(songID)

	cacheKey := credKey + ":" + requestedLevel + ":" + strconv.FormatInt(songIDInt, 10)
	if cached, hit := ncm.QualityMetaCache.Get(cacheKey); hit {
		httpx.JSON(w, http.StatusOK, map[string]any{
			"success": true, "songId": songIDInt, "cached": true,
			"sr": cached.SR, "br": cached.BR, "type": cached.Type, "level": cached.Level,
		})
		return
	}

	resolved, lastData := s.NCM.ResolveSongURLAlongChain(r.Context(), songIDInt, levels, cookieHeader)
	if resolved == nil {
		if lastData != nil && lastData["freeTrialInfo"] != nil {
			httpx.JSON(w, http.StatusForbidden, map[string]any{
				"code": "VIP_REQUIRED", "message": "需要登录网易云 VIP 账号",
			})
			return
		}
		httpx.JSON(w, http.StatusBadGateway, map[string]any{
			"code": "RESOLVE_FAILED", "message": "音质信息解析失败",
		})
		return
	}

	meta := ncm.SongQualityMeta{
		SR:    readPositiveInt(resolved, "sr"),
		BR:    readPositiveInt(resolved, "br"),
		Type:  stringOrEmpty(resolved["type"]),
		Level: stringOrEmpty(resolved["level"]),
	}
	if meta.Level == "" {
		meta.Level = requestedLevel
	}
	// 上游缺 sr 时对 flac 走 STREAMINFO 探测兜底
	if meta.SR == 0 && strings.EqualFold(meta.Type, "flac") {
		if audioURL, ok := resolved["url"].(string); ok && audioURL != "" {
			meta.SR = ncm.ResolveFlacSampleRate(r.Context(), audioURL)
		}
	}
	ncm.QualityMetaCache.Set(cacheKey, meta)

	httpx.JSON(w, http.StatusOK, map[string]any{
		"success": true, "songId": songIDInt,
		"sr": meta.SR, "br": meta.BR, "type": meta.Type, "level": meta.Level,
	})
}

// readPositiveInt 复刻 `typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0`。
func readPositiveInt(source map[string]any, key string) int64 {
	value, ok := source[key].(float64)
	if !ok || math.IsNaN(value) || math.IsInf(value, 0) || value <= 0 {
		return 0
	}
	return int64(math.Round(value))
}

// stringOrEmpty 取字符串字段，类型不符时返回空串。
func stringOrEmpty(value any) string {
	text, _ := value.(string)
	return text
}

// parseIncomingCookies 解析用户粘贴的 Cookie。
//
// 两种输入都要认：请求头格式（"MUSIC_U=xxx; __csrf=yyy"）与
// Set-Cookie JSON 数组（'["MUSIC_U=xxx; Path=/", "__csrf=yyy"]'）。
// JSON 解析失败按空数组处理——后面还有 MUSIC_U 校验兜底，会给出可读提示。
func parseIncomingCookies(raw string) []string {
	if strings.HasPrefix(raw, "[") {
		var arr []any
		if err := json.Unmarshal([]byte(raw), &arr); err != nil {
			return nil
		}
		out := make([]string, 0, len(arr))
		for _, item := range arr {
			if text, ok := item.(string); ok && strings.Contains(text, "=") {
				out = append(out, text)
			}
		}
		return out
	}
	out := make([]string, 0, 8)
	for _, part := range strings.Split(raw, ";") {
		trimmed := strings.TrimSpace(part)
		if strings.Contains(trimmed, "=") {
			out = append(out, trimmed)
		}
	}
	return out
}

// hasMusicU 判断 cookie 列表里有没有 MUSIC_U（网易云登录态的关键 cookie）。
func hasMusicU(cookies []string) bool {
	for _, item := range cookies {
		if strings.HasPrefix(strings.ToLower(item), "music_u=") {
			return true
		}
	}
	return false
}
