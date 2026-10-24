package api

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"regexp"
	"strings"

	"golang.org/x/crypto/bcrypt"

	"zviewer/backend/internal/auth"
	"zviewer/backend/internal/httpx"
	"zviewer/backend/internal/store"
)

// usernamePattern 用户名格式：2-24 位，中文/字母/数字/下划线/连字符/空格。
//
// 用 \p{Han} 而非 TS 侧的 \u4e00-\u9fa5：Go 正则不支持 \u 区间写法，
// 且 \p{Han} 覆盖更完整（含扩展区汉字），实际只会放宽不会收紧。
var usernamePattern = regexp.MustCompile(`^[\p{Han}A-Za-z0-9_\- ]{2,24}$`)

func (s *Server) registerAuthRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/auth/login", s.handleLogin)
	mux.HandleFunc("POST /api/auth/register", s.handleRegister)
	mux.HandleFunc("POST /api/auth/guest", s.handleGuest)
	mux.HandleFunc("POST /api/auth/refresh", s.handleRefresh)
	mux.HandleFunc("POST /api/auth/logout", s.handleLogout)
	mux.HandleFunc("GET /api/auth/registration-mode", s.handleRegistrationMode)
	mux.HandleFunc("GET /api/auth/public-settings", s.handlePublicSettings)
	mux.HandleFunc("GET /api/auth/me", s.Auth.Require(s.handleMe))
}

// credentialsRequest 是登录/注册的请求体。
type credentialsRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

// userView 是用户对外视图，字段与 Node 版逐字一致。
//
// avatar 为 nil 时序列化成 JSON null（前端靠它区分默认头像），
// 因此不能加 omitempty。
type userView struct {
	ID       int64   `json:"id"`
	Username string  `json:"username"`
	Role     string  `json:"role"`
	Status   string  `json:"status"`
	Avatar   *string `json:"avatar"`
}

func toUserView(u *store.User) userView {
	return userView{ID: u.ID, Username: u.Username, Role: u.Role, Status: u.Status, Avatar: u.Avatar}
}

func guestUserView() userView {
	return userView{ID: 0, Username: "guest", Role: auth.RoleGuest, Status: auth.StatusActive, Avatar: nil}
}

// handleLogin 复刻 routes/auth.ts#POST /login。
//
// 注意 mustChangePassword：root 仍在用默认密码 'root' 时返回该标记，
// 前端据此弹出强提示。这不是"建议"，是历史遗留的安全兜底，别删。
func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req credentialsRequest
	if err := httpx.DecodeJSON(r, &req); err != nil {
		httpx.BadRequest(w, "用户名或密码格式不正确")
		return
	}
	username := strings.TrimSpace(req.Username)
	if username == "" || req.Password == "" {
		httpx.BadRequest(w, "用户名或密码格式不正确")
		return
	}

	user, err := s.Users.FindByUsername(r.Context(), username)
	if err != nil || bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(req.Password)) != nil {
		s.writeAudit(r.Context(), store.AuditEntry{
			ActorUsername: username,
			Action:        "login_failed",
			IP:            clientIP(r),
			Success:       false,
			Detail:        "用户名或密码错误",
		})
		httpx.Unauthorized(w, "用户名或密码错误")
		return
	}
	if user.Status == auth.StatusPending {
		httpx.Forbidden(w, "账号正在审核中，请稍后再试")
		return
	}

	tokens, err := s.Tokens.Generate(user.ID, user.Role, user.Username)
	if err != nil {
		httpx.InternalError(w, "login", err)
		return
	}
	auth.SetAuthCookies(w, r, tokens)

	s.writeAudit(r.Context(), store.AuditEntry{
		ActorUserID:   &user.ID,
		ActorUsername: user.Username,
		ActorRole:     user.Role,
		Action:        "login",
		IP:            clientIP(r),
		Success:       true,
	})

	payload := map[string]any{
		"success":      true,
		"accessToken":  tokens.AccessToken,
		"refreshToken": tokens.RefreshToken,
		"user":         toUserView(user),
	}
	if user.Role == auth.RoleRoot && bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte("root")) == nil {
		payload["mustChangePassword"] = true
	}
	httpx.OK(w, payload)
}

// handleRegister 复刻 POST /register：按 registrationMode 决定是否需要审核。
func (s *Server) handleRegister(w http.ResponseWriter, r *http.Request) {
	var req credentialsRequest
	if err := httpx.DecodeJSON(r, &req); err != nil {
		httpx.BadRequest(w, "用户名需 2-24 位（中文/字母/数字/下划线/连字符/空格），密码至少 4 位")
		return
	}
	username := strings.TrimSpace(req.Username)
	if username == "" || !usernamePattern.MatchString(username) || len(req.Password) < 4 {
		httpx.BadRequest(w, "用户名需 2-24 位（中文/字母/数字/下划线/连字符/空格），密码至少 4 位")
		return
	}

	settings, err := s.Settings.Get(r.Context())
	if err != nil {
		httpx.InternalError(w, "register", err)
		return
	}
	if settings.RegistrationMode == "closed" {
		httpx.Forbidden(w, "注册已关闭")
		return
	}

	if _, err := s.Users.FindByUsername(r.Context(), username); err == nil {
		httpx.Fail(w, http.StatusConflict, "用户名已存在")
		return
	} else if !errors.Is(err, store.ErrUserNotFound) {
		httpx.InternalError(w, "register", err)
		return
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	if err != nil {
		httpx.InternalError(w, "register", err)
		return
	}

	isOpen := settings.RegistrationMode == "open"
	status := auth.StatusPending
	if isOpen {
		status = auth.StatusActive
	}
	user, err := s.Users.Create(r.Context(), username, string(hash), auth.RoleUser, status)
	if err != nil {
		httpx.InternalError(w, "register", err)
		return
	}

	if isOpen {
		tokens, err := s.Tokens.Generate(user.ID, user.Role, user.Username)
		if err != nil {
			httpx.InternalError(w, "register", err)
			return
		}
		auth.SetAuthCookies(w, r, tokens)
	}

	message := "注册成功，请等待管理员审核通过后再登录"
	if isOpen {
		message = "注册成功"
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"success": true,
		"message": message,
		"user":    toUserView(user),
	})
}

// handleGuest 签发游客令牌。无需任何凭证，因此有效期比正式用户短。
func (s *Server) handleGuest(w http.ResponseWriter, r *http.Request) {
	tokens, err := s.Tokens.GenerateGuest("")
	if err != nil {
		httpx.InternalError(w, "guest", err)
		return
	}
	auth.SetAuthCookies(w, r, tokens)
	httpx.OK(w, map[string]any{
		"success":      true,
		"accessToken":  tokens.AccessToken,
		"refreshToken": tokens.RefreshToken,
		"user":         guestUserView(),
	})
}

// refreshRequest 兼容旧客户端把 refreshToken 放在 body 的用法。
type refreshRequest struct {
	RefreshToken string `json:"refreshToken"`
}

// handleRefresh 续签 access token（refresh 不轮换）。
func (s *Server) handleRefresh(w http.ResponseWriter, r *http.Request) {
	refreshToken := auth.ExtractRefreshToken(r)
	if refreshToken == "" {
		var req refreshRequest
		// body 解析失败不算错误：老客户端可能压根没带 body
		if err := httpx.DecodeJSON(r, &req); err == nil {
			refreshToken = req.RefreshToken
		}
	}
	if refreshToken == "" {
		httpx.Unauthorized(w, "未提供刷新令牌")
		return
	}

	claims, err := s.Tokens.VerifyRefresh(refreshToken)
	if err != nil {
		httpx.Forbidden(w, "刷新令牌无效或已过期")
		return
	}

	if claims.IsGuest() {
		accessToken, err := s.Tokens.GenerateGuestAccess(claims.GuestID)
		if err != nil {
			httpx.Forbidden(w, "刷新令牌无效或已过期")
			return
		}
		auth.SetAccessTokenCookie(w, r, accessToken)
		httpx.OK(w, map[string]any{"success": true, "accessToken": accessToken})
		return
	}

	user, err := s.Users.FindByID(r.Context(), claims.UserID)
	if err != nil {
		httpx.Forbidden(w, "用户不存在")
		return
	}
	if user.Status == auth.StatusPending {
		httpx.Forbidden(w, "账号正在审核中")
		return
	}
	// 复核吊销时间戳：改密后旧 refresh 必须立刻失效
	if user.TokenInvalidBefore != nil && !claims.IssuedAtTime().After(*user.TokenInvalidBefore) {
		httpx.Forbidden(w, "刷新令牌无效或已过期")
		return
	}

	accessToken, err := s.Tokens.GenerateAccess(user.ID, user.Role, user.Username)
	if err != nil {
		httpx.Forbidden(w, "刷新令牌无效或已过期")
		return
	}
	auth.SetAccessTokenCookie(w, r, accessToken)
	httpx.OK(w, map[string]any{"success": true, "accessToken": accessToken})
}

// handleLogout 清除鉴权 cookie。HTTP 场景本就没有 cookie，调用无害。
func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	auth.ClearAuthCookies(w, r)
	httpx.OK(w, map[string]any{"success": true, "message": "已退出登录"})
}

// handleMe 返回当前登录用户。
func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	claims := auth.ClaimsFrom(r.Context())
	if claims == nil {
		httpx.Unauthorized(w, "未提供认证令牌")
		return
	}
	if claims.IsGuest() {
		httpx.OK(w, map[string]any{"success": true, "user": guestUserView()})
		return
	}
	user, err := s.Users.FindByID(r.Context(), claims.UserID)
	if errors.Is(err, store.ErrUserNotFound) {
		httpx.NotFound(w, "用户不存在")
		return
	}
	if err != nil {
		httpx.InternalError(w, "me", err)
		return
	}
	httpx.OK(w, map[string]any{"success": true, "user": toUserView(user)})
}

// handleRegistrationMode 公开接口，登录/注册页用来决定展示方式。
func (s *Server) handleRegistrationMode(w http.ResponseWriter, r *http.Request) {
	settings, err := s.Settings.Get(r.Context())
	if err != nil {
		httpx.InternalError(w, "registration-mode", err)
		return
	}
	httpx.OK(w, map[string]any{"success": true, "mode": settings.RegistrationMode})
}

// handlePublicSettings 返回前端启动所需的公开设置（无需鉴权）。
//
// 只暴露非敏感字段；dataSourceConfig、bilibili 凭证等一律不下发。
func (s *Server) handlePublicSettings(w http.ResponseWriter, r *http.Request) {
	settings, err := s.Settings.Get(r.Context())
	if err != nil {
		httpx.InternalError(w, "public-settings", err)
		return
	}

	matrix := settings.RoomPermissionMatrix
	if len(matrix) == 0 {
		matrix = json.RawMessage("null")
	}

	httpx.OK(w, map[string]any{
		"success": true,
		"settings": map[string]any{
			"registrationMode":          settings.RegistrationMode,
			"roomCreationMode":          settings.RoomCreationMode,
			"betaFeaturesEnabled":       settings.BetaFeaturesEnabled,
			"dashDisabled":              settings.DashDisabled,
			"bilibiliDefaultParseMode":  settings.BilibiliDefaultParseMode,
			"bilibiliPgcDefaultMode":    settings.BilibiliPgcDefaultMode,
			"playsvideoEnabled":         settings.PlaysvideoEnabled,
			"roomPermissionMatrix":      matrix,
			"announceAutoPopupOnUpdate": settings.AnnounceAutoPopupOnUpdate,
			"roomDefaultMusicVolume":    settings.RoomDefaultMusicVolume,
			"appVersion":                localVersion(s.Cfg.ProjectRoot),
			"desktopManaged":            isDesktopManaged(),
		},
	})
}

// writeAudit 尽力写审计日志：失败只记日志，不影响主流程。
func (s *Server) writeAudit(ctx context.Context, entry store.AuditEntry) {
	if s.Audit == nil {
		return
	}
	if err := s.Audit.Write(ctx, entry); err != nil {
		logAuditError(err)
	}
}

// clientIP 取真实客户端 IP：反代优先 X-Forwarded-For 的第一跳。
func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		if first := strings.TrimSpace(strings.Split(xff, ",")[0]); first != "" {
			return first
		}
	}
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return host
	}
	return r.RemoteAddr
}
