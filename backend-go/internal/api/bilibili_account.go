package api

import (
	"errors"
	"log"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"zviewer/backend/internal/auth"
	"zviewer/backend/internal/bilibili"
	"zviewer/backend/internal/httpx"
)

// registerBilibiliAccountRoutes 挂载 B站 账号域的 7 个端点。
//
// 对应 routes/stream/bilibili-account.routes.ts。全部要求登录 ZViewer 账号
// （父路由 router.use(authenticateToken)），但**不要求已绑定 B站**——
// 未绑定时各端点回自己的文案，前端据此显示「去登录 B站」。
func (s *Server) registerBilibiliAccountRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/stream/bilibili/qr", s.Auth.Require(s.handleBilibiliQR))
	mux.HandleFunc("GET /api/stream/bilibili/qr/poll", s.Auth.Require(s.handleBilibiliQRPoll))
	mux.HandleFunc("GET /api/stream/bilibili/login-status", s.Auth.Require(s.handleBilibiliLoginStatus))
	mux.HandleFunc("GET /api/stream/bilibili/cookie", s.Auth.Require(s.handleBilibiliCookie))
	mux.HandleFunc("POST /api/stream/bilibili/cookie-login", s.Auth.Require(s.handleBilibiliCookieLogin))
	mux.HandleFunc("POST /api/stream/bilibili/logout", s.Auth.Require(s.handleBilibiliLogout))
	mux.HandleFunc("GET /api/stream/bilibili/user-info", s.Auth.Require(s.handleBilibiliUserInfo))
}

// bilibiliUserID 返回当前登录用户在凭证表里的 key。
func bilibiliUserID(r *http.Request) (string, int64) {
	claims := auth.ClaimsFrom(r.Context())
	if claims == nil {
		return "", 0
	}
	return strconv.FormatInt(claims.UserID, 10), claims.UserID
}

// handleBilibiliQR 生成扫码登录二维码。
func (s *Server) handleBilibiliQR(w http.ResponseWriter, r *http.Request) {
	qr, err := s.Bilibili.GenerateQRCode(r.Context())
	if err != nil {
		log.Printf("[bilibili] qr generate error: %v", err)
		// 两种失败文案是分开的：上游缺字段回「获取二维码失败」，
		// 渲染 PNG 失败（或上游报错）回「生成二维码失败」。
		if errors.Is(err, bilibili.ErrQRCodeInvalid) {
			httpx.Fail(w, http.StatusInternalServerError, "获取二维码失败")
			return
		}
		httpx.Fail(w, http.StatusInternalServerError, "生成二维码失败")
		return
	}
	dataURL, err := bilibili.QRDataURL(qr.URL)
	if err != nil {
		log.Printf("[bilibili] qr render error: %v", err)
		httpx.Fail(w, http.StatusInternalServerError, "生成二维码失败")
		return
	}
	httpx.OK(w, map[string]any{
		"success":   true,
		"qrcodeKey": qr.QrcodeKey,
		"qrUrl":     qr.URL,
		"qrDataUrl": dataURL,
	})
}

// handleBilibiliQRPoll 轮询扫码状态；确认登录时收 Cookie 并落库。
func (s *Server) handleBilibiliQRPoll(w http.ResponseWriter, r *http.Request) {
	key := r.URL.Query().Get("qrcode_key")
	userID, numericID := bilibiliUserID(r)
	if key == "" {
		httpx.Fail(w, http.StatusBadRequest, "缺少 qrcode_key")
		return
	}

	poll, err := s.Bilibili.PollQRCode(r.Context(), key)
	if err != nil {
		log.Printf("[bilibili] qr poll error: %v", err)
		httpx.Fail(w, http.StatusInternalServerError, "轮询二维码状态失败")
		return
	}

	status := bilibili.QRLoginStatus(poll)
	if status == 2 && numericID > 0 {
		cookie := ""
		// 新版流程：扫码成功后返回的跨域 URL 里才有真正的登录 Cookie。
		if poll.URL != "" {
			if collected, ssoErr := s.Bilibili.CollectSSOCookie(r.Context(), poll.URL); ssoErr == nil {
				cookie = collected
			} else {
				log.Printf("[bilibili] sso cookie error: %v", ssoErr)
			}
		}
		// 兼容旧版：poll 响应头里直接带 Set-Cookie。
		if cookie == "" {
			cookie = poll.SetCookie
		}
		if cookie == "" {
			httpx.Fail(w, http.StatusInternalServerError, "登录确认成功，但未能获取 B站 Cookie")
			return
		}
		if _, ok := s.Bilibili.ValidateCookie(r.Context(), userID, cookie); !ok {
			httpx.Fail(w, http.StatusInternalServerError, "获取到 Cookie，但无法通过 B站 登录验证")
			return
		}
		if err := s.Bilibili.Creds.Save(r.Context(), userID, cookie, poll.RefreshToken); err != nil {
			log.Printf("[bilibili] save credential error: %v", err)
			httpx.Fail(w, http.StatusInternalServerError, "轮询二维码状态失败")
			return
		}
		log.Printf("[bilibili] login success, cookie saved for user %s", userID)
	}

	httpx.OK(w, map[string]any{
		"success":  true,
		"status":   status,
		"message":  poll.Message,
		"loggedIn": s.Bilibili.Creds.GetCookie(r.Context(), userID) != "",
	})
}

// handleBilibiliLoginStatus 查询是否已绑定 B站。
func (s *Server) handleBilibiliLoginStatus(w http.ResponseWriter, r *http.Request) {
	userID, _ := bilibiliUserID(r)
	httpx.OK(w, map[string]any{
		"success":  true,
		"loggedIn": s.Bilibili.Creds.GetCookie(r.Context(), userID) != "",
	})
}

// handleBilibiliCookie 返回当前绑定的 B站 Cookie（个人中心「复制 Cookie」）。
func (s *Server) handleBilibiliCookie(w http.ResponseWriter, r *http.Request) {
	userID, _ := bilibiliUserID(r)
	cookie := s.Bilibili.Creds.GetCookie(r.Context(), userID)
	if cookie == "" {
		httpx.OK(w, map[string]any{"success": false, "message": "未登录 B站"})
		return
	}
	httpx.OK(w, map[string]any{"success": true, "cookie": cookie})
}

// sessDataPattern 是 Cookie 登录的最低校验：必须带 SESSDATA。
var sessDataPattern = regexp.MustCompile(`SESSDATA\s*=`)

// handleBilibiliCookieLogin 手动粘贴 Cookie 登录。
func (s *Server) handleBilibiliCookieLogin(w http.ResponseWriter, r *http.Request) {
	userID, numericID := bilibiliUserID(r)
	if numericID <= 0 {
		httpx.Unauthorized(w, "未登录")
		return
	}

	var body struct {
		Cookie string `json:"cookie"`
	}
	// 请求体缺失/非法时按空 Cookie 处理（Node 是 req.body?.cookie 兜底）。
	_ = httpx.DecodeJSON(r, &body)
	cookie := strings.TrimSpace(body.Cookie)

	if cookie == "" {
		httpx.Fail(w, http.StatusBadRequest, "请输入 Cookie")
		return
	}
	if !sessDataPattern.MatchString(cookie) {
		httpx.Fail(w, http.StatusBadRequest, "Cookie 中未找到 SESSDATA，请确认已复制完整的 Cookie")
		return
	}

	info, ok := s.Bilibili.ValidateCookie(r.Context(), userID, cookie)
	if !ok {
		httpx.Fail(w, http.StatusBadRequest, "Cookie 验证失败，可能已过期或不正确")
		return
	}
	if err := s.Bilibili.Creds.Save(r.Context(), userID, cookie, ""); err != nil {
		log.Printf("[bilibili] cookie login save error: %v", err)
		httpx.Fail(w, http.StatusInternalServerError, "Cookie 登录失败")
		return
	}
	log.Printf("[bilibili] cookie login success, user: %s for user %s", info.Name, userID)

	httpx.OK(w, map[string]any{
		"success": true,
		"message": "B站 Cookie 登录成功",
		"name":    info.Name,
		"avatar":  info.Avatar,
	})
}

// handleBilibiliLogout 退出 B站 登录（删凭证 + 清用户信息缓存）。
func (s *Server) handleBilibiliLogout(w http.ResponseWriter, r *http.Request) {
	userID, numericID := bilibiliUserID(r)
	if numericID > 0 {
		if err := s.Bilibili.Creds.Clear(r.Context(), userID); err != nil {
			log.Printf("[bilibili] logout clear error: %v", err)
			httpx.Fail(w, http.StatusInternalServerError, "退出登录失败")
			return
		}
		s.Bilibili.Caches.InvalidateUserInfo(userID)
	}
	httpx.OK(w, map[string]any{"success": true, "message": "已退出登录"})
}

// handleBilibiliUserInfo 返回当前绑定的 B站 账号信息。
//
// 注意失败也是 200：前端把它当「有没有昵称」读，不是请求成败。
func (s *Server) handleBilibiliUserInfo(w http.ResponseWriter, r *http.Request) {
	userID, _ := bilibiliUserID(r)
	cookie := s.Bilibili.Creds.GetCookie(r.Context(), userID)
	if cookie == "" {
		httpx.OK(w, map[string]any{"success": false, "message": "未登录 B站"})
		return
	}

	if cached, ok := s.Bilibili.Caches.GetUserInfo(userID); ok {
		log.Printf("[bilibili] user-info served from cache: %s", cached.Name)
		httpx.OK(w, map[string]any{
			"success":   true,
			"name":      cached.Name,
			"avatar":    cached.Avatar,
			"vipStatus": cached.VipStatus,
		})
		return
	}

	nav, err := s.Bilibili.Nav(r.Context(), cookie)
	if err != nil {
		log.Printf("[bilibili] user-info error: %v", err)
		httpx.OK(w, map[string]any{"success": false, "message": err.Error()})
		return
	}
	if !nav.IsLogin {
		httpx.OK(w, map[string]any{"success": false, "message": "获取 B站 用户信息失败"})
		return
	}
	info := bilibili.UserInfo{
		Name:      nav.Uname,
		Avatar:    bilibili.NormalizeImageURL(nav.Face),
		Mid:       nav.Mid,
		VipStatus: nav.VipStatus,
		VipType:   nav.VipType,
	}
	s.Bilibili.Caches.SetUserInfo(userID, info)
	httpx.OK(w, map[string]any{
		"success":   true,
		"name":      info.Name,
		"avatar":    info.Avatar,
		"vipStatus": info.VipStatus,
	})
}
