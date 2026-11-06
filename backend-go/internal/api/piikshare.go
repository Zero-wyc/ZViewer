package api

import (
	"errors"
	"net/http"
	"strconv"

	"zviewer/backend/internal/auth"
	"zviewer/backend/internal/httpx"
	"zviewer/backend/internal/piik/server/protocol"
	"zviewer/backend/internal/share/piikbridge"
	"zviewer/backend/internal/store"
)

// registerPiikShareRoutes 挂载 Piik 信令与凭证下发。
//
// 两道门分工明确：REST 决定「这个人在这间房里是什么身份」，Piik 只认
// 房主 token / 观众 grant。中间不经过 socket.io——WebSocket 升级没法带
// Authorization 头，Piik 的客户端也只会自己连 /signal。
func (s *Server) registerPiikShareRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/share/piik/session", s.Auth.Require(s.handlePiikSession))
	mux.HandleFunc("DELETE /api/share/piik/session", s.Auth.Require(s.handlePiikRelease))
	// 必须在 mux.Handle("/", SPA 回退) 之前，否则升级请求会被回成 index.html。
	mux.Handle(piikbridge.SignalPath, s.handlePiikSignal())
}

// handlePiikSignal 返回 /signal 的处理器；桥接层没起来时显式 503。
func (s *Server) handlePiikSignal() http.Handler {
	if s.PiikShare != nil {
		return s.PiikShare.Handler()
	}
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		httpx.Fail(w, http.StatusServiceUnavailable, "共享信令未启用")
	})
}

type piikSessionRequest struct {
	RoomID string `json:"roomId"`
}

type piikSessionResponse struct {
	Success     bool               `json:"success"`
	RoomID      string             `json:"roomId"`
	Role        string             `json:"role"`
	Token       string             `json:"token,omitempty"`
	ViewerGrant string             `json:"viewerGrant,omitempty"`
	SignalPath  string             `json:"signalPath"`
	Protocol    string             `json:"protocol"`
	IceConfig   protocol.IceConfig `json:"iceConfig"`
}

// handlePiikSession 按当前身份签发一份 Piik 房间凭证。
//
// 房主每次调用都会拿到同一份 token（房间没被回收时）；观众拿到的是同一份
// grant。重连前重新调用即可，顺带刷新站点通行证的有效期。
func (s *Server) handlePiikSession(w http.ResponseWriter, r *http.Request) {
	if s.PiikShare == nil {
		httpx.Fail(w, http.StatusServiceUnavailable, "共享信令未启用")
		return
	}
	claims := auth.ClaimsFrom(r.Context())
	if claims == nil {
		httpx.Unauthorized(w, "未提供认证令牌")
		return
	}
	var body piikSessionRequest
	if err := httpx.DecodeJSON(r, &body); err != nil {
		httpx.BadRequest(w, "请求体无效")
		return
	}
	if body.RoomID == "" {
		httpx.BadRequest(w, "缺少 roomId")
		return
	}

	room, err := s.Rooms.FindByRoomID(r.Context(), body.RoomID)
	if errors.Is(err, store.ErrRoomNotFound) {
		httpx.NotFound(w, "房间不存在")
		return
	}
	if err != nil {
		httpx.InternalError(w, "读取房间失败", err)
		return
	}
	if room.Status != "active" {
		httpx.Fail(w, http.StatusConflict, "房间已关闭")
		return
	}

	role, err := s.Sessions.FindActiveRole(r.Context(), room.RoomID, claims.UserID, claims.GuestID)
	if err != nil {
		httpx.InternalError(w, "读取房间身份失败", err)
		return
	}
	if role == "" {
		httpx.Forbidden(w, "请先进入房间")
		return
	}

	var credentials piikbridge.Credentials
	if role == store.SessionRoleSharer {
		credentials, err = s.PiikShare.Host(room.RoomID)
	} else {
		credentials, err = s.PiikShare.Viewer(room.RoomID)
		if errors.Is(err, piikbridge.ErrNoRoom) {
			// 带 code：观众比房主先到是常态，前端要把它当「再等等」而不是错误。
			httpx.FailWithCode(
				w, http.StatusConflict, "房主还没有开始共享", "HOST_NOT_SHARING",
			)
			return
		}
	}
	if errors.Is(err, piikbridge.ErrClosed) {
		httpx.Fail(w, http.StatusServiceUnavailable, "共享信令正在重启")
		return
	}
	if err != nil {
		httpx.InternalError(w, "签发共享凭证失败", err)
		return
	}

	subject := claims.GuestID
	if claims.UserID > 0 {
		subject = "u" + strconv.FormatInt(claims.UserID, 10)
	}
	s.PiikShare.GrantSiteAccess(w, r, subject)

	httpx.OK(w, piikSessionResponse{
		Success:     true,
		RoomID:      credentials.RoomID,
		Role:        credentials.Role,
		Token:       credentials.Token,
		ViewerGrant: credentials.Grant,
		SignalPath:  piikbridge.SignalPath,
		Protocol:    protocol.SignalingProtocol,
		IceConfig:   s.PiikShare.ICE(),
	})
}

// handlePiikRelease 结束该房间的 Piik 房间，已连接的人会收到 room-closed。
// 只有房主能调：观众手里的 grant 本来也解不开别人的房间。
func (s *Server) handlePiikRelease(w http.ResponseWriter, r *http.Request) {
	if s.PiikShare == nil {
		httpx.Fail(w, http.StatusServiceUnavailable, "共享信令未启用")
		return
	}
	claims := auth.ClaimsFrom(r.Context())
	if claims == nil {
		httpx.Unauthorized(w, "未提供认证令牌")
		return
	}
	var body piikSessionRequest
	if err := httpx.DecodeJSON(r, &body); err != nil {
		httpx.BadRequest(w, "请求体无效")
		return
	}
	if body.RoomID == "" {
		httpx.BadRequest(w, "缺少 roomId")
		return
	}
	role, err := s.Sessions.FindActiveRole(r.Context(), body.RoomID, claims.UserID, claims.GuestID)
	if err != nil {
		httpx.InternalError(w, "读取房间身份失败", err)
		return
	}
	if role != store.SessionRoleSharer {
		httpx.Forbidden(w, "只有房主可以结束共享")
		return
	}
	if err := s.PiikShare.Release(body.RoomID); err != nil && !errors.Is(err, piikbridge.ErrNoRoom) {
		httpx.InternalError(w, "结束共享失败", err)
		return
	}
	httpx.OK(w, map[string]any{"success": true})
}
