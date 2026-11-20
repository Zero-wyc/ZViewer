package api

// 桌面壳「独立评论窗口」的准入与启动。
//
// 背景：评论区在浏览器里只能以内嵌浮层或 window.open 弹窗打开，都受浏览器
// 窗口管理限制（无法真正置顶、无法脱离标签页）。桌面客户端（desktop/ Wails 壳）
// 可以开一个真正的无边框窗口内嵌评论页面，因此这里提供两个端点：
//
//	GET  /api/desktop/capabilities      当前浏览器所在设备能否唤起桌面壳窗口
//	POST /api/desktop/comments-window   让桌面壳按给定房间开一个评论窗口
//
// 安全边界：
//   - 只有「桌面壳托管的实例」才允许（ZVIEWER_DESKTOP=1 且壳可执行文件存在）
//   - 只有「请求来自本机」才允许：桌面壳只能在本机启动，跨机请求没有意义，
//     而且签发出来的一次性登录票据不该发给远端
//   - 房间读取权限复用 canReadRoom，游客也能开（评论区游客可发言）

import (
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"zviewer/backend/internal/auth"
	"zviewer/backend/internal/httpx"
)

// commentsWindowLaunchGap 抑制重复点击：极短时间内对同一房间重复请求只开一个窗。
const commentsWindowLaunchGap = 2 * time.Second

var (
	commentsWindowMu   sync.Mutex
	commentsWindowLast = map[string]time.Time{}
)

func (s *Server) registerDesktopWindowRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/desktop/capabilities", s.Auth.Require(s.handleDesktopCapabilities))
	mux.HandleFunc("POST /api/desktop/comments-window", s.Auth.Require(s.handleDesktopCommentsWindow))
}

// desktopCapabilities 是 /api/desktop/capabilities 的返回体。
type desktopCapabilities struct {
	Available   bool   `json:"available"`
	SameMachine bool   `json:"sameMachine"`
	Reason      string `json:"reason,omitempty"`
}

func (s *Server) handleDesktopCapabilities(w http.ResponseWriter, r *http.Request) {
	caps := resolveDesktopCapabilities(r)
	httpx.OK(w, map[string]any{
		"success":     true,
		"available":   caps.Available,
		"sameMachine": caps.SameMachine,
		"reason":      caps.Reason,
	})
}

// handleDesktopCommentsWindow 让壳开一个独立评论窗口。
//
// 登录态问题：桌面壳的新窗口是独立的 WebView2 进程（独立 profile），
// 拿不到浏览器里那份 httpOnly cookie，因此这里签发一组短期票据放进 URL，
// 页面加载时先把它写进本地存储，后续请求走 Bearer。
func (s *Server) handleDesktopCommentsWindow(w http.ResponseWriter, r *http.Request) {
	var payload struct {
		RoomID string `json:"roomId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil || strings.TrimSpace(payload.RoomID) == "" {
		httpx.BadRequest(w, "缺少房间号")
		return
	}
	roomID := strings.TrimSpace(payload.RoomID)

	caps := resolveDesktopCapabilities(r)
	if !caps.Available {
		httpx.Fail(w, http.StatusServiceUnavailable, caps.Reason)
		return
	}

	claims := auth.ClaimsFrom(r.Context())
	allowed, err := s.canReadRoom(r.Context(), roomID, claims)
	if err != nil {
		httpx.InternalError(w, "POST /api/desktop/comments-window", err)
		return
	}
	if !allowed {
		httpx.Forbidden(w, "没有该房间的查看权限")
		return
	}

	tokens, err := s.issueDesktopWindowTokens(claims)
	if err != nil {
		httpx.InternalError(w, "POST /api/desktop/comments-window", err)
		return
	}

	target := s.desktopCommentsWindowURL(roomID, tokens.AccessToken, tokens.RefreshToken)
	if target == "" {
		httpx.Fail(w, http.StatusServiceUnavailable, "未找到可用的本机回环地址")
		return
	}

	commentsWindowMu.Lock()
	last := commentsWindowLast[roomID]
	if time.Since(last) < commentsWindowLaunchGap {
		commentsWindowMu.Unlock()
		httpx.OK(w, map[string]any{"success": true, "launched": false, "url": target})
		return
	}
	commentsWindowLast[roomID] = time.Now()
	commentsWindowMu.Unlock()

	if err := launchDesktopWindow(desktopShellExecutable(), target); err != nil {
		httpx.Fail(w, http.StatusInternalServerError, "启动独立窗口失败："+err.Error())
		return
	}
	httpx.OK(w, map[string]any{"success": true, "launched": true})
}

// issueDesktopWindowTokens 为当前身份签发一组票据。
//
// 有效期沿用常规 access（1h）/ refresh（30d 或游客 7d）：页面里的 apiFetch
// 在 access 过期时会用 refresh token 自动续签，窗口可以长时间挂着。
func (s *Server) issueDesktopWindowTokens(claims *auth.Claims) (auth.Tokens, error) {
	if claims == nil {
		return auth.Tokens{}, errors.New("缺少登录身份")
	}
	if claims.UserID > 0 {
		return s.Tokens.Generate(claims.UserID, claims.Role, claims.Username)
	}
	return s.Tokens.GenerateGuest(claims.GuestID)
}

// desktopCommentsWindowURL 拼出壳加载的页面地址。
//
// 必须是回环 HTTP：HTTPS 模式下壳给内嵌页单独开了一个 127.0.0.1 的 HTTP 端口
// （LOOPBACK_HTTP_PORT），HTTP 模式下页面本身就是 http，可直接复用 PORT。
// 页面只有运行在 http 上，前端的分离式鉴权才会用 Bearer（而不是等 cookie）。
func (s *Server) desktopCommentsWindowURL(roomID, accessToken, refreshToken string) string {
	origin := ""
	if port := strings.TrimSpace(os.Getenv("LOOPBACK_HTTP_PORT")); port != "" {
		origin = "http://127.0.0.1:" + port
	} else if strings.EqualFold(os.Getenv("HTTPS"), "false") {
		if port := strings.TrimSpace(os.Getenv("PORT")); port != "" {
			origin = "http://127.0.0.1:" + port
		}
	}
	if origin == "" {
		return ""
	}
	query := url.Values{}
	query.Set("desktopWindow", "1")
	query.Set("desktopToken", accessToken)
	query.Set("desktopRefresh", refreshToken)
	return origin + "/room/" + url.PathEscape(roomID) + "/comments-window?" + query.Encode()
}

// resolveDesktopCapabilities 汇总「能不能开独立窗口」的全部条件。
func resolveDesktopCapabilities(r *http.Request) desktopCapabilities {
	sameMachine := requestFromLocalMachine(r)
	caps := desktopCapabilities{SameMachine: sameMachine}
	switch {
	case !isDesktopManaged():
		caps.Reason = "当前不是桌面客户端托管的服务，无法创建独立窗口"
	case desktopShellExecutable() == "":
		caps.Reason = "未找到桌面客户端程序"
	case desktopLoopbackOrigin() == "":
		caps.Reason = "未找到本机回环地址"
	case !sameMachine:
		caps.Reason = "浏览器与桌面客户端不在同一台设备"
	default:
		caps.Available = true
	}
	return caps
}

// desktopShellExecutable 返回壳程序路径（由 desktop/controller 注入）。
func desktopShellExecutable() string {
	path := strings.TrimSpace(os.Getenv("ZVIEWER_DESKTOP_EXE"))
	if path == "" {
		return ""
	}
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		return ""
	}
	return path
}

// desktopLoopbackOrigin 与 desktopCommentsWindowURL 的口径保持一致，只做可用性判断。
func desktopLoopbackOrigin() string {
	if strings.TrimSpace(os.Getenv("LOOPBACK_HTTP_PORT")) != "" {
		return "loopback"
	}
	if strings.EqualFold(os.Getenv("HTTPS"), "false") && strings.TrimSpace(os.Getenv("PORT")) != "" {
		return "http"
	}
	return ""
}

func launchDesktopWindow(exePath, target string) error {
	cmd := exec.Command(exePath, "--comments-window-url="+target)
	cmd.Dir = filepath.Dir(exePath)
	if err := cmd.Start(); err != nil {
		return err
	}
	// 子进程由它自己退出，这里只负责回收，避免僵尸进程。
	go func() { _ = cmd.Wait() }()
	return nil
}

// requestFromLocalMachine 判断请求是否来自本机（回环或本机网卡地址）。
func requestFromLocalMachine(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	ip := net.ParseIP(strings.Trim(host, "[]"))
	if ip == nil {
		return strings.EqualFold(host, "localhost")
	}
	if ip.IsLoopback() {
		return true
	}
	for _, local := range localInterfaceIPs() {
		if local.Equal(ip) {
			return true
		}
	}
	return false
}

var (
	localIPsOnce sync.Once
	localIPs     []net.IP
)

func localInterfaceIPs() []net.IP {
	localIPsOnce.Do(func() {
		addrs, err := net.InterfaceAddrs()
		if err != nil {
			return
		}
		for _, addr := range addrs {
			if netAddr, ok := addr.(*net.IPNet); ok {
				localIPs = append(localIPs, netAddr.IP)
			}
		}
	})
	return localIPs
}
