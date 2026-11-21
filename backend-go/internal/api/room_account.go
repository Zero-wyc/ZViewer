package api

import (
	"context"
	"errors"
	"log"
	"net/http"
	"strconv"
	"strings"

	"zviewer/backend/internal/auth"
	"zviewer/backend/internal/bilibili"
	"zviewer/backend/internal/httpx"
	"zviewer/backend/internal/realtime"
	"zviewer/backend/internal/store"
)

// 房间共享账号：房间内任意成员登录网易云 / B站 后，凭证绑定到房间，
// 房间内其他人（含游客）的搜索、解析与播放直链都复用同一份凭证。
//
// 前端每个请求都带 X-Room-Id（当前房间），后端只在「房间上下文校验通过」
// 时才使用房间绑定；任何校验失败都静默降级到旧逻辑，绝不中断请求。
const (
	roomAccountProviderNCM      = "ncm"
	roomAccountProviderBilibili = "bilibili"
)

var roomAccountProviderNames = map[string]struct{}{
	roomAccountProviderNCM:      {},
	roomAccountProviderBilibili: {},
}

// requestRoomID 从请求里取当前房间：优先 header X-Room-Id，其次 query roomId。
//
// 取不到或格式明显异常时返回空串（调用方据此降级），不报错。
func requestRoomID(r *http.Request) string {
	if r == nil {
		return ""
	}
	roomID := strings.TrimSpace(r.Header.Get("X-Room-Id"))
	if roomID == "" {
		roomID = strings.TrimSpace(r.URL.Query().Get("roomId"))
	}
	if roomID == "" || len(roomID) > 64 {
		return ""
	}
	return roomID
}

// roomMemberContext 校验「请求者当前在房间内」，失败一律静默返回 ok=false。
func (s *Server) roomMemberContext(ctx context.Context, r *http.Request) (string, *auth.Claims, bool) {
	claims := auth.ClaimsFrom(ctx)
	if claims == nil || s.Rooms == nil {
		return "", nil, false
	}
	roomID := requestRoomID(r)
	if roomID == "" {
		return "", nil, false
	}
	room, err := s.Rooms.FindByRoomID(ctx, roomID)
	if err != nil || room == nil || room.Status != "active" {
		return "", nil, false
	}
	active, err := s.Rooms.HasActiveSession(ctx, roomID, claims.UserID, claims.GuestID)
	if err != nil || !active {
		return "", nil, false
	}
	return roomID, claims, true
}

// roomAccountUserID 读取房间当前绑定的共享账号（未绑定 / 读失败返回 0）。
func (s *Server) roomAccountUserID(ctx context.Context, roomID, provider string) int64 {
	if s.RoomAccounts == nil || roomID == "" || provider == "" {
		return 0
	}
	userID, ok, err := s.RoomAccounts.GetRoomAccount(ctx, provider, roomID)
	if err != nil {
		log.Printf("[room-account] 读取共享账号失败 provider=%s room=%s: %v", provider, roomID, err)
		return 0
	}
	if !ok || userID <= 0 {
		return 0
	}
	return userID
}

// resolveRoomAccountUserID 是「带房间上下文」版本的 roomAccountUserID。
func (s *Server) resolveRoomAccountUserID(ctx context.Context, r *http.Request, provider string) int64 {
	roomID, _, ok := s.roomMemberContext(ctx, r)
	if !ok {
		return 0
	}
	return s.roomAccountUserID(ctx, roomID, provider)
}

// effectiveRoomAccountUserID 返回房间内「当前生效」的账号用户 id：
// 房间绑定（成员登录后全房共用）→ 房主自己的凭证（旧行为）→ 请求者自己。
//
// 与 /accounts 的展示口径保持一致：展示说「房主账号 · 全房间共用」，
// 那么搜索、歌单、播放直链这些请求也必须真的用房主凭证，否则成员侧
// 会拿到空账号（例如「我的歌单」永远是空的）。
// 房间上下文不成立时退化成请求者自己，行为与改造前完全一致。
func (s *Server) effectiveRoomAccountUserID(ctx context.Context, r *http.Request, provider string) int64 {
	claims := auth.ClaimsFrom(ctx)
	userID := int64(0)
	if claims != nil {
		userID = claims.UserID
	}
	roomID, memberClaims, ok := s.roomMemberContext(ctx, r)
	if !ok {
		return userID
	}
	return s.effectiveRoomAccountUserIDIn(ctx, roomID, memberClaims, provider)
}

// effectiveRoomAccountUserIDIn 是 effectiveRoomAccountUserID 的「已校验房间」版本，
// 供手里已经有 roomID / claims 的调用方复用，避免重复查房间。
func (s *Server) effectiveRoomAccountUserIDIn(ctx context.Context, roomID string, claims *auth.Claims, provider string) int64 {
	if binder := s.roomAccountUserID(ctx, roomID, provider); binder > 0 && s.hasRoomAccountCredential(ctx, provider, binder) {
		return binder
	}
	if s.Rooms != nil {
		if room, err := s.Rooms.FindByRoomID(ctx, roomID); err == nil && room != nil &&
			room.OwnerUserID != nil && *room.OwnerUserID > 0 {
			ownerID := *room.OwnerUserID
			if s.hasRoomAccountCredential(ctx, provider, ownerID) {
				return ownerID
			}
		}
	}
	if claims != nil && claims.UserID > 0 {
		return claims.UserID
	}
	return 0
}

// bindRoomAccount 把「谁登录的」写进房间绑定并广播给房间内其它成员。
func (s *Server) bindRoomAccount(ctx context.Context, roomID, provider string, userID int64) {
	if s.RoomAccounts == nil || roomID == "" || provider == "" || userID <= 0 {
		return
	}
	if err := s.RoomAccounts.SetRoomAccount(ctx, provider, roomID, userID); err != nil {
		log.Printf("[room-account] 绑定共享账号失败 provider=%s room=%s user=%d: %v", provider, roomID, userID, err)
		return
	}
	s.emitRoomAccountChanged(roomID, provider)
}

// clearRoomAccount 解除房间绑定（只动 room_account，不删任何人的个人凭证）。
func (s *Server) clearRoomAccount(ctx context.Context, roomID, provider string) {
	if s.RoomAccounts == nil || roomID == "" || provider == "" {
		return
	}
	if err := s.RoomAccounts.ClearRoomAccount(ctx, provider, roomID); err != nil {
		log.Printf("[room-account] 解绑共享账号失败 provider=%s room=%s: %v", provider, roomID, err)
		return
	}
	s.emitRoomAccountChanged(roomID, provider)
}

// emitRoomAccountChanged 通知房间内其它成员刷新账号状态。
func (s *Server) emitRoomAccountChanged(roomID, provider string) {
	if s.Bus == nil || roomID == "" {
		return
	}
	s.Bus.EmitRoom(roomID, realtime.EventRoomAccountChanged, map[string]any{
		"roomId":   roomID,
		"provider": provider,
	})
}

// bilibiliCookieForRequest 是 B站 全站凭证入口：房间共享账号优先，其次请求者自己。
//
// 搜索、浏览、番剧/视频解析、服务器文件下载都走这里，所以「房间共享账号」
// 在这些场景天然生效；房间上下文不成立时与旧行为完全一致。
func (s *Server) bilibiliCookieForRequest(r *http.Request) string {
	if s.Bilibili == nil || r == nil {
		return ""
	}
	ctx := r.Context()
	// 房间绑定 → 房主（旧行为：观众用房主 Cookie 解析）→ 请求者自己。
	userID := s.effectiveRoomAccountUserID(ctx, r, roomAccountProviderBilibili)
	if userID <= 0 {
		return ""
	}
	return s.Bilibili.Creds.GetCookie(ctx, strconv.FormatInt(userID, 10))
}

// roomAccountStatus 是单个平台的账号状态（/accounts 的 accounts.<provider>）。
type roomAccountStatus struct {
	LoggedIn   bool   `json:"loggedIn"`
	UserID     int64  `json:"userId"`
	Nickname   string `json:"nickname"`
	AvatarURL  string `json:"avatarUrl"`
	Source     string `json:"source"`
	BinderName string `json:"binderName"`
}

// registerRoomAccountRoutes 挂载房间共享账号路由（/api/rooms/{roomId}/accounts）。
func (s *Server) registerRoomAccountRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/rooms/{roomId}/accounts", s.Auth.Require(s.handleGetRoomAccounts))
	mux.HandleFunc("POST /api/rooms/{roomId}/accounts/logout", s.Auth.Require(s.handleRoomAccountLogout))
}

// handleGetRoomAccounts 返回房间内两个平台的「当前可用账号」及其来源。
func (s *Server) handleGetRoomAccounts(w http.ResponseWriter, r *http.Request) {
	roomID := r.PathValue("roomId")
	if !s.requireRoomRead(w, r, roomID) {
		return
	}
	room, err := s.Rooms.FindByRoomID(r.Context(), roomID)
	if err != nil {
		if errors.Is(err, store.ErrRoomNotFound) {
			httpx.NotFound(w, "房间不存在")
			return
		}
		httpx.InternalError(w, "GET /rooms/:roomId/accounts", err)
		return
	}
	claims := auth.ClaimsFrom(r.Context())
	httpx.OK(w, map[string]any{
		"success": true,
		"accounts": map[string]any{
			roomAccountProviderNCM:      s.roomAccountStatusFor(r.Context(), room, claims, roomAccountProviderNCM),
			roomAccountProviderBilibili: s.roomAccountStatusFor(r.Context(), room, claims, roomAccountProviderBilibili),
		},
	})
}

// roomAccountStatusFor 按「房间绑定 → 房主 → 请求者自己」判定当前生效的账号。
func (s *Server) roomAccountStatusFor(ctx context.Context, room *store.Room, claims *auth.Claims, provider string) roomAccountStatus {
	status := roomAccountStatus{}
	if room == nil {
		return status
	}
	// 1) 房间绑定：成员登录后全房复用。
	if userID := s.roomAccountUserID(ctx, room.RoomID, provider); userID > 0 {
		status.UserID = userID
		status.Source = "room"
		if s.hasRoomAccountCredential(ctx, provider, userID) {
			status.LoggedIn = true
		}
	}
	// 2) 房主自己的凭证（旧行为）。
	if status.UserID == 0 && room.OwnerUserID != nil && *room.OwnerUserID > 0 {
		ownerID := *room.OwnerUserID
		if s.hasRoomAccountCredential(ctx, provider, ownerID) {
			status.UserID = ownerID
			status.Source = "owner"
			status.LoggedIn = true
		}
	}
	// 3) 请求者自己的凭证。
	if status.UserID == 0 && claims != nil && claims.UserID > 0 {
		if s.hasRoomAccountCredential(ctx, provider, claims.UserID) {
			status.UserID = claims.UserID
			status.Source = "self"
			status.LoggedIn = true
		}
	}
	if status.UserID > 0 {
		status.BinderName = s.roomAccountUsername(ctx, status.UserID)
		s.fillRoomAccountProfile(ctx, provider, &status)
	}
	return status
}

// hasRoomAccountCredential 判断某个用户在该平台是否有可用凭证。
func (s *Server) hasRoomAccountCredential(ctx context.Context, provider string, userID int64) bool {
	if userID <= 0 {
		return false
	}
	switch provider {
	case roomAccountProviderNCM:
		if s.NCM == nil {
			return false
		}
		credential, err := s.NCM.LoadCredential(ctx, userID)
		return err == nil && credential != nil
	case roomAccountProviderBilibili:
		if s.Bilibili == nil {
			return false
		}
		return s.Bilibili.Creds.GetCookie(ctx, strconv.FormatInt(userID, 10)) != ""
	}
	return false
}

// roomAccountUsername 取用户昵称用于 binderName（查不到返回空串）。
func (s *Server) roomAccountUsername(ctx context.Context, userID int64) string {
	if s.Users == nil || userID <= 0 {
		return ""
	}
	names, err := s.Users.UsernamesByIDs(ctx, []int64{userID})
	if err != nil {
		return ""
	}
	return names[userID]
}

// fillRoomAccountProfile 补全账号昵称 / 头像（失败只降级为只报登录态）。
func (s *Server) fillRoomAccountProfile(ctx context.Context, provider string, status *roomAccountStatus) {
	if status == nil || status.UserID <= 0 {
		return
	}
	switch provider {
	case roomAccountProviderNCM:
		if s.NCM == nil {
			return
		}
		login, err := s.NCM.GetLoginStatus(ctx, status.UserID)
		if err != nil || login == nil {
			log.Printf("[room-account] 读取网易云账号资料失败 user=%d: %v", status.UserID, err)
			return
		}
		status.LoggedIn = login.LoggedIn
		status.Nickname = derefString(login.Nickname)
		status.AvatarURL = derefString(login.AvatarURL)
	case roomAccountProviderBilibili:
		if s.Bilibili == nil {
			return
		}
		cookie := s.Bilibili.Creds.GetCookie(ctx, strconv.FormatInt(status.UserID, 10))
		if cookie == "" {
			status.LoggedIn = false
			return
		}
		status.LoggedIn = true
		userKey := strconv.FormatInt(status.UserID, 10)
		if info, ok := s.Bilibili.Caches.GetUserInfo(userKey); ok {
			status.Nickname = info.Name
			status.AvatarURL = bilibili.NormalizeImageURL(info.Avatar)
			return
		}
		nav, err := s.Bilibili.Nav(ctx, cookie)
		if err != nil || nav == nil || !nav.IsLogin {
			if err != nil {
				log.Printf("[room-account] 读取 B站 账号资料失败 user=%d: %v", status.UserID, err)
			}
			return
		}
		status.Nickname = nav.Uname
		status.AvatarURL = bilibili.NormalizeImageURL(nav.Face)
		s.Bilibili.Caches.SetUserInfo(userKey, bilibili.UserInfo{
			Name:      nav.Uname,
			Avatar:    status.AvatarURL,
			Mid:       nav.Mid,
			VipStatus: nav.VipStatus,
			VipType:   nav.VipType,
		})
	}
}

// handleRoomAccountLogout 只解除房间绑定：个人凭证原样保留。
func (s *Server) handleRoomAccountLogout(w http.ResponseWriter, r *http.Request) {
	roomID := r.PathValue("roomId")
	if !s.requireRoomRead(w, r, roomID) {
		return
	}
	var body struct {
		Provider string `json:"provider"`
	}
	if err := httpx.DecodeJSON(r, &body); err != nil {
		httpx.BadRequest(w, "参数无效")
		return
	}
	provider := strings.TrimSpace(body.Provider)
	if _, ok := roomAccountProviderNames[provider]; !ok {
		httpx.BadRequest(w, "不支持的平台")
		return
	}
	s.clearRoomAccount(r.Context(), roomID, provider)
	httpx.OK(w, map[string]any{"success": true})
}
