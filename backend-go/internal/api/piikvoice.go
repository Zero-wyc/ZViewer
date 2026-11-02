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

// registerPiikVoiceRoutes 挂载语音用的 Piik 凭证端点。
//
// 与 /api/share/piik/session 是同一个 Piik 房间：共享与语音共用一条 WS、
// 一棵 P2P 树（Piik 的语音转发路径就是共享那棵树）。分开成两个端点只是
// 因为失败语义不同——共享失败是「房主还没开播」，语音失败是「房主还没进
// 语音」，对用户要能说清是哪件事没做。
func (s *Server) registerPiikVoiceRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/voice/piik/session", s.Auth.Require(s.handlePiikVoiceSession))
}

type piikVoiceSessionResponse struct {
	Success     bool               `json:"success"`
	RoomID      string             `json:"roomId"`
	Role        string             `json:"role"`
	Token       string             `json:"token,omitempty"`
	ViewerGrant string             `json:"viewerGrant,omitempty"`
	SignalPath  string             `json:"signalPath"`
	Protocol    string             `json:"protocol"`
	IceConfig   protocol.IceConfig `json:"iceConfig"`
}

// handlePiikVoiceSession 按身份签发 Piik 语音凭证。
//
// 房主调用会顺带把 Piik 房间建出来（语音的树根就是房主，房主不在就没有
// 转发节点，Piik 的语义如此）；观众在房主之前调用会拿到 409。
func (s *Server) handlePiikVoiceSession(w http.ResponseWriter, r *http.Request) {
	if s.PiikShare == nil {
		httpx.Fail(w, http.StatusServiceUnavailable, "语音信令未启用")
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
			httpx.Fail(w, http.StatusConflict, "房主还没有进入语音")
			return
		}
	}
	if errors.Is(err, piikbridge.ErrClosed) {
		httpx.Fail(w, http.StatusServiceUnavailable, "语音信令正在重启")
		return
	}
	if err != nil {
		httpx.InternalError(w, "签发语音凭证失败", err)
		return
	}

	subject := claims.GuestID
	if claims.UserID > 0 {
		subject = "u" + strconv.FormatInt(claims.UserID, 10)
	}
	s.PiikShare.GrantSiteAccess(w, r, subject)

	httpx.OK(w, piikVoiceSessionResponse{
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
