package auth

import (
	"context"
	"crypto/subtle"
	"net/http"
	"os"
	"strings"

	"zviewer/backend/internal/httpx"
	"zviewer/backend/internal/store"
)

type claimsKey struct{}

// Authenticator 把令牌校验接到 HTTP 中间件上。
type Authenticator struct {
	Manager *Manager
	Users   *store.Users
}

// NewAuthenticator 构造中间件集合。
func NewAuthenticator(manager *Manager, users *store.Users) *Authenticator {
	return &Authenticator{Manager: manager, Users: users}
}

// Require 强制鉴权：失败直接返回 401，文案与 Node 版逐字一致。
func (a *Authenticator) Require(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := ExtractAccessToken(r)
		if token == "" {
			httpx.Unauthorized(w, "未提供认证令牌")
			return
		}
		claims, err := a.Manager.VerifyAccess(token)
		if err != nil {
			httpx.Unauthorized(w, "认证令牌无效、已撤销或已过期")
			return
		}
		if err := a.assertActive(r.Context(), claims); err != nil {
			httpx.Unauthorized(w, "认证令牌无效、已撤销或已过期")
			return
		}
		next(w, r.WithContext(context.WithValue(r.Context(), claimsKey{}, claims)))
	}
}

// Optional 可选鉴权：无 token 或 token 失效都按匿名放行。
func (a *Authenticator) Optional(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := ExtractAccessToken(r)
		if token == "" {
			next(w, r)
			return
		}
		claims, err := a.Manager.VerifyAccess(token)
		if err != nil {
			next(w, r)
			return
		}
		if err := a.assertActive(r.Context(), claims); err != nil {
			next(w, r)
			return
		}
		next(w, r.WithContext(context.WithValue(r.Context(), claimsKey{}, claims)))
	}
}

// RequireRoot 仅允许超级管理员。
func (a *Authenticator) RequireRoot(next http.HandlerFunc) http.HandlerFunc {
	return a.Require(func(w http.ResponseWriter, r *http.Request) {
		if claims := ClaimsFrom(r.Context()); claims == nil || claims.Role != RoleRoot {
			httpx.Forbidden(w, "无权限：仅超级管理员可操作")
			return
		}
		next(w, r)
	})
}

// RequireAdmin 允许超级管理员与管理员（对应 Node 的 adminOnly）。
//
// 文案是 `routes/admin.ts#adminOnly` 的原文，与 RequireRoot 的
// 「仅超级管理员可操作」不同——两条 403 分属不同模块，对拍要逐字相等。
func (a *Authenticator) RequireAdmin(next http.HandlerFunc) http.HandlerFunc {
	return a.Require(func(w http.ResponseWriter, r *http.Request) {
		claims := ClaimsFrom(r.Context())
		if claims == nil || (claims.Role != RoleRoot && claims.Role != RoleAdmin) {
			httpx.Forbidden(w, "无权限：仅管理员可操作")
			return
		}
		next(w, r)
	})
}

// RequireRootExact 与 RequireRoot 判定相同，但文案取
// `routes/admin.ts#rootOnly` / `routes/updater.ts` 的「仅 root 可操作」。
//
// 同一个权限判定在两处模块有两套文案，是 Node 侧的历史事实：
// `middleware/auth.ts#requireRoot` 用「仅超级管理员可操作」（serverFiles 走它），
// admin / updater 各自内联了一份「仅 root 可操作」。不要为了"统一"合并成一个。
func (a *Authenticator) RequireRootExact(next http.HandlerFunc) http.HandlerFunc {
	return a.Require(func(w http.ResponseWriter, r *http.Request) {
		if claims := ClaimsFrom(r.Context()); claims == nil || claims.Role != RoleRoot {
			httpx.Forbidden(w, "无权限：仅 root 可操作")
			return
		}
		next(w, r)
	})
}

// AssertActive 是 assertActive 的对外入口，供实时层逐包校验复用。
//
// HTTP 中间件与 socket 逐包鉴权必须用同一套判定，否则会出现
// 「HTTP 已 401 但 socket 还能发包」这种半失效状态。
func (a *Authenticator) AssertActive(ctx context.Context, claims *Claims) error {
	return a.assertActive(ctx, claims)
}

// assertActive 复刻 assertTokenActive：
// 游客只校验 guestId 存在；正式用户还要核对状态、角色与吊销时间戳。
func (a *Authenticator) assertActive(ctx context.Context, claims *Claims) error {
	if claims.IsGuest() {
		if claims.GuestID == "" {
			return ErrTokenInactive
		}
		return nil
	}
	user, err := a.Users.FindByID(ctx, claims.UserID)
	if err != nil {
		return ErrTokenInactive
	}
	if user.Status != StatusActive || user.Role != claims.Role {
		return ErrTokenInactive
	}
	// 改密后签发的 tokenInvalidBefore 会淘汰此前所有 token（含被盗的 refresh）
	if user.TokenInvalidBefore != nil && !claims.IssuedAtTime().After(*user.TokenInvalidBefore) {
		return ErrTokenInactive
	}
	return nil
}

// ClaimsFrom 取出当前请求的身份，未登录返回 nil。
func ClaimsFrom(ctx context.Context) *Claims {
	claims, _ := ctx.Value(claimsKey{}).(*Claims)
	return claims
}

// 桌面壳管理通道。
//
// GUI 启动台不是网页登录用户，没有 JWT；它需要调用爬虫引擎的管理接口
// （规则、Agent 对话、配置、浏览器登录）。做法与 Node 版爬虫引擎的
// admin_token 相同：壳在后端进程启动时注入一个每次随机生成的
// ZVIEWER_DESKTOP_TOKEN，请求带 X-Desktop-Token 即可。
//
// 只对显式标注的接口生效（当前仅 /api/crawler/* 管理段），不改变其它路由的鉴权。
const desktopTokenHeader = "X-Desktop-Token"

// desktopClaims 是壳内请求的伪身份：等同 root，但没有 userId。
func desktopClaims() *Claims {
	return &Claims{
		UserID:   0,
		Role:     RoleRoot,
		Username: "desktop",
	}
}

// RequireDesktopOrAdmin 允许「桌面壳令牌」或管理员 JWT 访问。
//
// 令牌判定：ZVIEWER_DESKTOP_TOKEN 非空且请求头逐字相等（constant-time），
// 并且进程确实由 GUI 托管（ZVIEWER_DESKTOP=1）。两者缺一不可，未托管部署
// 即使猜到 header 名也不生效。
func (a *Authenticator) RequireDesktopOrAdmin(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if token := desktopTokenFromEnv(); token != "" {
			provided := strings.TrimSpace(r.Header.Get(desktopTokenHeader))
			if provided != "" && subtle.ConstantTimeCompare([]byte(provided), []byte(token)) == 1 {
				next(w, r.WithContext(context.WithValue(r.Context(), claimsKey{}, desktopClaims())))
				return
			}
		}
		a.RequireAdmin(next)(w, r)
	}
}

func desktopTokenFromEnv() string {
	if os.Getenv("ZVIEWER_DESKTOP") != "1" {
		return ""
	}
	return strings.TrimSpace(os.Getenv("ZVIEWER_DESKTOP_TOKEN"))
}
