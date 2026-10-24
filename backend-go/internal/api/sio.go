package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"zviewer/backend/internal/room"
	"zviewer/backend/internal/sio"
)

// registerSocketRoutes 把 Socket.IO 挂到 `/socket.io/` 上。
//
// 注意中间件顺序：这个 handler 和其余路由一样经过 cors / requestLogger，
// 因为 Node 侧 socket.io 也是挂在同一个 express 实例上。WebSocket 升级
// 走 Hijack，日志里只会看到那次 HTTP 101 请求，属正常。
func (s *Server) registerSocketRoutes(mux *http.ServeMux) {
	if s.Socket == nil {
		return
	}
	s.Socket.UseAuth(s.socketAuth)
	s.Socket.UsePacketAuth(s.socketPacketAuth)
	s.Socket.OnConnect(func(sc *sio.Socket) {
		s.armTokenExpiry(sc)
		if s.RoomSvc != nil {
			s.RoomSvc.AttachSocket(sc)
		}
	})
	mux.Handle("/socket.io/", s.Socket)
}

// socketAuth 复刻 middleware/socket-auth.ts。
//
// 取令牌的顺序必须一致：cookie → handshake.auth.token → query.token。
// 只认 auth.token 会让「浏览器同源带 cookie」的常规场景全部掉到 connect_error，
// 前端表现是「刷新后一直显示未连接」。
func (s *Server) socketAuth(h *sio.Handshake) error {
	// zcontrol-cli 代理走独立通道，不带用户令牌（Node 侧同样直接放行）。
	if raw, ok := h.Auth["agent"]; ok {
		var agent string
		if json.Unmarshal(raw, &agent) == nil && agent == "zcontrol-cli" {
			h.Data["isCliAgent"] = true
			return nil
		}
	}

	token := accessTokenFromHandshake(h)
	if token == "" {
		return errors.New("未提供认证令牌")
	}
	claims, err := s.Tokens.VerifyAccess(token)
	if err != nil {
		return errors.New("认证令牌无效或已过期")
	}
	if s.Auth != nil {
		if err := s.Auth.AssertActive(context.Background(), claims); err != nil {
			return errors.New("认证令牌无效或已过期")
		}
	}

	// 与 Object.assign(socket.data, payload) 等价：后续所有 handler 都从
	// socket.data 读身份，包括房间归属与角色判定。
	h.Data["userId"] = claims.UserID
	h.Data["role"] = claims.Role
	if claims.Username != "" {
		h.Data["username"] = claims.Username
	}
	if claims.GuestID != "" {
		h.Data["guestId"] = claims.GuestID
	}
	h.Data["issuedAtMs"] = claims.IssuedAtMs
	if claims.ExpiresAt != nil {
		h.Data["exp"] = claims.ExpiresAt.Unix()
	}
	// 原始令牌留在连接上供逐包复核（Node 也是闭包里捕获 token）。
	h.Data["__token"] = token
	return nil
}

// socketPacketAuth 复刻 Node 的 `socket.use(...)` 逐包校验。
//
// 为什么不能在握手时校验一次就够：令牌可能在连接存活期间被撤销
// （改密码 / 管理员封禁 / 角色变更），只校验握手等于给旧连接发永久通行证。
func (s *Server) socketPacketAuth(sc *sio.Socket) error {
	if v, ok := sc.Data["isCliAgent"].(bool); ok && v {
		return nil
	}
	token, _ := sc.Data["__token"].(string)
	if token == "" {
		return errors.New("认证令牌已撤销或已过期")
	}
	claims, err := s.Tokens.VerifyAccess(token)
	if err != nil {
		return err
	}
	if s.Auth != nil {
		return s.Auth.AssertActive(context.Background(), claims)
	}
	return nil
}

// armTokenExpiry 在令牌到期时主动断开连接。
//
// 与 Node 的 `setTimeout(revoke, exp*1000 - Date.now())` 一致：光靠逐包校验
// 只能拦住「还在发包的连接」，静默挂着的长连接会一直活着。
func (s *Server) armTokenExpiry(sc *sio.Socket) {
	exp, ok := sc.Data["exp"].(int64)
	if !ok || exp <= 0 {
		return
	}
	delay := time.Until(time.Unix(exp, 0))
	if delay < 0 {
		delay = 0
	}
	time.AfterFunc(delay, func() {
		if s.Socket != nil && s.Socket.Connected(sc.ID) {
			sc.Disconnect("io server disconnect")
		}
	})
}

// accessTokenFromHandshake 按 Node 的优先级取访问令牌。
func accessTokenFromHandshake(h *sio.Handshake) string {
	if raw := h.Headers.Get("Cookie"); raw != "" {
		for _, part := range strings.Split(raw, ";") {
			part = strings.TrimSpace(part)
			if !strings.HasPrefix(part, "access_token=") {
				continue
			}
			value := part[len("access_token="):]
			if decoded, err := url.QueryUnescape(value); err == nil {
				return decoded
			}
			return value
		}
	}
	if raw, ok := h.Auth["token"]; ok {
		var token string
		if json.Unmarshal(raw, &token) == nil && token != "" {
			return token
		}
	}
	return h.Query.Get("token")
}

// movieList 是注入给房间层的影片列表读取器。
//
// DTO 由 api 层构造（字段定义在这里），房间层只负责广播与判断
// currentMovieId 是否还在列表中。
func (s *Server) movieList(ctx context.Context, roomID string) (*room.MovieList, error) {
	movies, err := s.Movies.ListByRoom(ctx, roomID)
	if err != nil {
		return nil, err
	}
	dtos := make([]any, 0, len(movies))
	ids := make([]int64, 0, len(movies))
	for _, m := range movies {
		dtos = append(dtos, toMovieDTO(m))
		ids = append(ids, m.ID)
	}
	return &room.MovieList{DTOs: dtos, IDs: ids}, nil
}
