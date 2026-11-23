package webgui

// 网页端控制台服务：把 console 包的命令暴露成 HTTP + SSE，并托管同一套界面。
//
// 关键约束（来自需求）：
//   1. 不依赖 Windows/Wails，Linux 上也能跑——所以只有标准库 + console 包；
//   2. 与「正常后端」解耦：控制台服务本身永远先起来，主服务（zviewer-backend）
//      起没起只影响状态面板，不影响页面可访问（页面里 start 按钮负责拉起后端）；
//   3. 固定端口 3332（可用 --port / ZVIEWER_WEB_PORT 覆盖），默认绑定 0.0.0.0，
//      方便局域网/远程机器访问；登录口径是 ZViewer 的超级管理员账号
//      （user 表 role=root，bcrypt 校验），库还没初始化时用 root / root 兜底，
//      任何来源（含本机/反代）都必须先登录，不做回环免密。
//
// 与桌面壳的关系：桌面壳也内嵌这个服务（同一进程、同一端口），这样 Windows 用户
// 点开桌面控制台就同时拥有网页端；Linux 用户只跑 cmd/zviewer-webgui（无 GUI 依赖）。

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"path"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"zviewer/desktop/console"
	"zviewer/desktop/controller"
)

// DefaultPort 是网页控制台的固定端口。
const DefaultPort = 3332

// DefaultBind 默认监听所有网卡：Linux 服务器/远程桌面场景下只绑回环等于没法用。
const DefaultBind = "0.0.0.0"

// Config 是启动网页端所需的全部信息。
type Config struct {
	// Console 是共享的控制台核心（必填）。
	Console *console.Console
	// UI 是桌面控制台界面资源（ui.FS()），必填。
	UI fs.FS
	// StateDir 保存运行期数据；鉴权信息不再落盘（账号密码来自后端数据库）。
	StateDir string
	// Version 显示在页面底部。
	Version string
	// Bind / Port 默认 0.0.0.0:3332。
	Bind string
	Port int
	// CertFile / KeyFile 同时给出时启用 HTTPS（会话 cookie 也会带上 Secure）。
	CertFile string
	KeyFile  string
	// Logger 默认写 stderr。
	Logger *log.Logger
}

// Server 是网页控制台服务。
type Server struct {
	cfg    Config
	logger *log.Logger
	auth   *authStore
	hub    *hub
	webFS  fs.FS

	httpServer *http.Server
	listener   net.Listener
	urls       []string
	startedAt  time.Time

	downloadMu sync.Mutex
	downloads  map[string]downloadEntry
}

// New 构造服务（不监听端口）；Start 才开始对外服务。
func New(cfg Config) (*Server, error) {
	if cfg.Console == nil {
		return nil, errors.New("webgui: 缺少控制台实例")
	}
	if cfg.UI == nil {
		return nil, errors.New("webgui: 缺少界面资源")
	}
	if strings.TrimSpace(cfg.Bind) == "" {
		cfg.Bind = DefaultBind
	}
	if cfg.Port <= 0 {
		cfg.Port = DefaultPort
	}
	if cfg.StateDir == "" {
		cfg.StateDir = cfg.Console.StateDir()
	}
	if cfg.Version == "" {
		cfg.Version = cfg.Console.Version()
	}
	logger := cfg.Logger
	if logger == nil {
		logger = log.New(os.Stderr, "zviewer-webgui ", log.LstdFlags)
	}
	webFS, err := fs.Sub(webAssets, "web")
	if err != nil {
		return nil, err
	}
	return &Server{
		cfg:       cfg,
		logger:    logger,
		auth:      newAuthStore(),
		hub:       newHub(),
		webFS:     webFS,
		downloads: map[string]downloadEntry{},
	}, nil
}

// Start 监听端口并开始服务。端口被占用时返回可读错误，由调用方决定是否致命：
// 桌面壳选择「记日志继续」，独立进程选择退出。
func (s *Server) Start() error {
	address := net.JoinHostPort(s.cfg.Bind, strconv.Itoa(s.cfg.Port))
	listener, err := net.Listen("tcp", address)
	if err != nil {
		return fmt.Errorf("网页控制台无法监听 %s：%w", address, err)
	}
	s.listener = listener
	s.startedAt = time.Now()
	s.urls = buildURLs(s.cfg.Bind, s.cfg.Port)
	s.logger.Printf("网页控制台：%s", s.urls[0])
	s.logger.Printf("登录账号：ZViewer 超级管理员（数据库 user 表中 role=root 的账号）")
	if info, err := os.Stat(controller.BackendDatabasePath(s.cfg.Console.Root())); err != nil || info.IsDir() {
		s.logger.Printf("数据库尚未初始化：首次可用 root / root 登录，后端启动完成后自动改用真实管理员密码")
	}
	s.httpServer = &http.Server{
		Handler:           s.routes(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		var serveErr error
		if s.cfg.CertFile != "" && s.cfg.KeyFile != "" {
			serveErr = s.httpServer.ServeTLS(listener, s.cfg.CertFile, s.cfg.KeyFile)
		} else {
			serveErr = s.httpServer.Serve(listener)
		}
		if serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			s.logger.Printf("网页控制台已停止：%v", serveErr)
		}
	}()
	go s.maintenance()
	return nil
}

// URLs 返回可访问地址（首个是本机回环）。
func (s *Server) URLs() []string {
	if len(s.urls) == 0 {
		return nil
	}
	out := make([]string, len(s.urls))
	copy(out, s.urls)
	return out
}

// PrimaryURL 返回给人看的首选地址。
func (s *Server) PrimaryURL() string {
	if len(s.urls) == 0 {
		return ""
	}
	return s.urls[0]
}

// Addr 返回实际监听地址。
func (s *Server) Addr() string {
	if s.listener == nil {
		return ""
	}
	return s.listener.Addr().String()
}

// Close 优雅关闭：先断开 SSE，再关 HTTP。
func (s *Server) Close(ctx context.Context) error {
	s.hub.closeAll()
	if s.httpServer == nil {
		return nil
	}
	return s.httpServer.Shutdown(ctx)
}

// maintenance 周期性清理会话、下载令牌与限速记录。
func (s *Server) maintenance() {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	for range ticker.C {
		s.auth.pruneSessions()
		s.pruneDownloads()
	}
}

// ---------------------------------------------------------------- 路由

func (s *Server) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", s.handleHealth)
	mux.HandleFunc("/api/auth/status", s.handleAuthStatus)
	mux.HandleFunc("/api/auth/login", s.handleLogin)
	mux.HandleFunc("/api/auth/logout", s.handleLogout)
	mux.HandleFunc("/api/info", s.guard(s.handleInfo))
	mux.HandleFunc("/api/command", s.guard(s.handleCommand))
	mux.HandleFunc("/api/events", s.guard(s.handleEvents))
	mux.HandleFunc("/api/export", s.guard(s.handleExport))
	mux.HandleFunc("/api/crawler/import", s.guard(s.handleCrawlerImport))
	// 验证页 / 登录页同源反代：改成网页端自己的地址，iframe 才有第一方 Cookie。
	mux.HandleFunc("/api/crawler/challenge/", s.guard(s.handleCrawlerProxy))
	mux.HandleFunc("/api/window", s.guard(s.handleWindow))
	mux.HandleFunc("/api/download", s.handleDownload)
	mux.HandleFunc("/login", s.handleLoginPage)
	mux.HandleFunc("/setup", s.handleSetupPage)
	mux.HandleFunc("/web/", s.handleWebAsset)
	// 兼容入口：前端「设置密码」链接统一指向 /auth，具体页面在 /web/auth.html。
	mux.HandleFunc("/auth", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/web/auth.html", http.StatusFound)
	})
	mux.HandleFunc("/", s.handleApp)
	return withCommonHeaders(mux)
}

// withCommonHeaders 给所有响应加安全头；HTML 页面的 CSP 由各 handler 单独设定。
func withCommonHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		next.ServeHTTP(w, r)
	})
}

// guard 要求已登录（或未设密码时的本机访问）。
func (s *Server) guard(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.authorized(r) {
			writeJSON(w, http.StatusUnauthorized, map[string]any{
				"ok":         false,
				"error":      "需要登录",
				"needsLogin": true,
			})
			return
		}
		next(w, r)
	}
}

// authorized 判断请求是否可访问受保护资源。
// 一律要求登录会话：不做「本机免密」——反向代理后面回环判断不可靠，
// 反代没配好时会把公网请求当成 127.0.0.1，等于把控制台裸奔出去。
func (s *Server) authorized(r *http.Request) bool {
	cookie, err := r.Cookie(sessionCookie)
	if err != nil || cookie.Value == "" {
		return false
	}
	return s.auth.validSession(cookie.Value)
}

// ---------------------------------------------------------------- 基础 handler

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":       true,
		"service":  "zviewer-webgui",
		"version":  s.cfg.Version,
		"platform": runtime.GOOS,
		"uptime":   int(time.Since(s.startedAt).Seconds()),
	})
}

func (s *Server) handleAuthStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		// passwordSet 是给旧前端留的兼容字段：控制台不再有「还没设密码」的状态，
		// 恒为 true；新前端应看 databaseReady / account。
		"passwordSet":   true,
		"authenticated": s.authorized(r),
		"needsSetup":    false,
		"account":       "ZViewer 超级管理员",
		"databaseReady": s.databaseReady(),
		"loopback":      isLoopback(r),
		"platform":      runtime.GOOS,
		"version":       s.cfg.Version,
		"webgui":        s.webguiInfo(),
	})
}

// databaseReady 报告后端数据库是否已经存在：false 说明登录走的是 root/root 兜底。
func (s *Server) databaseReady() bool {
	info, err := os.Stat(controller.BackendDatabasePath(s.cfg.Console.Root()))
	return err == nil && !info.IsDir()
}

func (s *Server) webguiInfo() map[string]any {
	return map[string]any{
		"bind":          net.JoinHostPort(s.cfg.Bind, strconv.Itoa(s.cfg.Port)),
		"port":          s.cfg.Port,
		"urls":          s.urls,
		"passwordSet":   true,
		"databaseReady": s.databaseReady(),
		"account":       "ZViewer 超级管理员",
	}
}

// Info 暴露服务自身的地址与鉴权状态，供桌面端 Info() 一并返回。
func (s *Server) Info() map[string]any { return s.webguiInfo() }

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	ip := clientIP(r)
	if !s.auth.loginAllowed(ip) {
		writeJSON(w, http.StatusTooManyRequests, map[string]any{"ok": false, "error": "尝试过于频繁，请稍后再试"})
		return
	}
	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "请求格式不正确"})
		return
	}
	verdict := verifyAdminLogin(s.cfg.Console.Root(), body.Username, body.Password)
	if !verdict.OK {
		s.auth.recordFailure(ip)
		time.Sleep(loginFailureWait)
		writeJSON(w, http.StatusUnauthorized, map[string]any{"ok": false, "error": verdict.Reason})
		return
	}
	s.issueSession(w, r)
	source := "数据库"
	if !verdict.DatabaseReady {
		source = "兜底口令（数据库未初始化）"
	}
	s.logger.Printf("网页端登录成功（%s，账号 %s，%s）", ip, strings.TrimSpace(body.Username), source)
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":                 true,
		"mustChangePassword": verdict.MustChangePassword,
		"databaseReady":      verdict.DatabaseReady,
	})
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	if cookie, err := r.Cookie(sessionCookie); err == nil {
		s.auth.dropSession(cookie.Value)
	}
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookie, Value: "", Path: "/", MaxAge: -1,
		HttpOnly: true, SameSite: http.SameSiteLaxMode,
	})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleInfo(w http.ResponseWriter, r *http.Request) {
	info, err := s.cfg.Console.Info()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	info["web"] = true
	info["native"] = false
	info["platform"] = runtime.GOOS
	info["tray"] = false
	info["webgui"] = s.webguiInfo()
	writeJSON(w, http.StatusOK, info)
}

func (s *Server) handleCommand(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	var body struct {
		Action  string         `json:"action"`
		Payload map[string]any `json:"payload"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "请求格式不正确"})
		return
	}
	if strings.TrimSpace(body.Action) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "缺少 action"})
		return
	}
	// 用 Server 自己当 Host：导出走一次性下载令牌，打开链接走 SSE，窗口操作无操作。
	result, err := s.cfg.Console.CommandWith(s, body.Action, body.Payload)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "result": result})
}

func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": "当前连接不支持 SSE"})
		return
	}
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	messages, cancel := s.hub.subscribe()
	defer cancel()

	// 先推一份当前快照：页面可能在事件广播之后才连上来，靠 ready 补状态。
	ready := map[string]any{}
	if info, err := s.cfg.Console.Info(); err == nil {
		ready = info
	}
	if payload, err := encodeEvent("ready", ready); err == nil {
		_, _ = w.Write(payload)
		flusher.Flush()
	}

	heartbeat := time.NewTicker(25 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case message, ok := <-messages:
			if !ok {
				return
			}
			payload, err := encodeEvent(message.event, message.data)
			if err != nil {
				continue
			}
			if _, err := w.Write(payload); err != nil {
				return
			}
			flusher.Flush()
		case <-heartbeat.C:
			if _, err := io.WriteString(w, ": ping\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

func (s *Server) handleExport(w http.ResponseWriter, r *http.Request) {
	kind := strings.TrimSpace(r.URL.Query().Get("kind"))
	if kind == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "缺少 kind"})
		return
	}
	name, data, err := s.cfg.Console.ExportRaw(kind)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeAttachment(w, name, data)
}

func (s *Server) handleDownload(w http.ResponseWriter, r *http.Request) {
	entry, ok := s.takeDownload(strings.TrimSpace(r.URL.Query().Get("token")))
	if !ok {
		http.Error(w, "下载链接已失效", http.StatusNotFound)
		return
	}
	writeAttachment(w, entry.name, entry.data)
}

// handleCrawlerProxy 把引擎的同源反代页面（人机验证 / 网页内登录）转给浏览器。
//
// 网页端不直接访问 3333，也不暴露引擎端口：弹窗 iframe 用的是本进程的
// /api/crawler/challenge/... 地址，Cookie 落在 3332 这一侧。
func (s *Server) handleCrawlerProxy(w http.ResponseWriter, r *http.Request) {
	s.cfg.Console.ServeCrawlerProxy(w, r)
}

func (s *Server) handleCrawlerImport(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	var body struct {
		Content string `json:"content"`
		Name    string `json:"name"`
		Mode    string `json:"mode"`
		DryRun  bool   `json:"dryRun"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "请求格式不正确"})
		return
	}
	result, err := s.cfg.Console.ImportCrawlerRules(body.Content, body.Name, body.Mode, body.DryRun)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "result": result})
}

// handleWindow 让界面上的窗口按钮在网页端变成无害操作：最小化/最大化/关闭都
// 交给浏览器（关闭标签页是用户的动作），这里只回 ok，避免前端报错。
func (s *Server) handleWindow(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "noop": true})
}

// ---------------------------------------------------------------- 静态资源

func (s *Server) handleLoginPage(w http.ResponseWriter, r *http.Request) {
	if s.authorized(r) {
		http.Redirect(w, r, "/", http.StatusFound)
		return
	}
	s.serveWebPage(w, r, "login.html", "form-action 'self'")
}

// handleSetupPage 只做兼容：账号密码来自 ZViewer 超级管理员，不再有「首次设置密码」这一步，
// 旧书签/旧链接统一回落到登录页。
func (s *Server) handleSetupPage(w http.ResponseWriter, r *http.Request) {
	http.Redirect(w, r, "/login", http.StatusFound)
}

// serveWebPage 返回 web/ 下的鉴权页，附一份严格 CSP。
func (s *Server) serveWebPage(w http.ResponseWriter, r *http.Request, name, extra string) {
	raw, err := fs.ReadFile(s.webFS, name)
	if err != nil {
		http.Error(w, "页面缺失", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Security-Policy",
		"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "+
			"connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; "+extra)
	_, _ = w.Write(raw)
}

// handleWebAsset 提供 /web/ 下的静态文件（auth.css、auth.js、web.css、web.js）。
func (s *Server) handleWebAsset(w http.ResponseWriter, r *http.Request) {
	name := path.Clean(strings.TrimPrefix(r.URL.Path, "/web/"))
	if name == "." || strings.Contains(name, "..") {
		http.NotFound(w, r)
		return
	}
	switch path.Ext(name) {
	case ".css", ".js", ".html", ".png", ".svg":
	default:
		http.NotFound(w, r)
		return
	}
	raw, err := fs.ReadFile(s.webFS, name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	contentType := "application/octet-stream"
	switch path.Ext(name) {
	case ".css":
		contentType = "text/css; charset=utf-8"
	case ".js":
		contentType = "text/javascript; charset=utf-8"
	case ".html":
		contentType = "text/html; charset=utf-8"
	case ".png":
		contentType = "image/png"
	case ".svg":
		contentType = "image/svg+xml"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = w.Write(raw)
}

// handleApp 是主界面与 ui 静态资源。
func (s *Server) handleApp(w http.ResponseWriter, r *http.Request) {
	requestPath := r.URL.Path
	if requestPath == "/" || requestPath == "/index.html" {
		if !s.authorized(r) {
			http.Redirect(w, r, "/login", http.StatusFound)
			return
		}
		raw, err := fs.ReadFile(s.cfg.UI, "index.html")
		if err != nil {
			http.Error(w, "界面资源缺失", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write(raw)
		return
	}
	// 其余是界面资源（app.js、styles.css、app-icon.png…）。它们不含任何秘密，
	// 登录页也要用 tokens.css，所以不做鉴权，只防目录穿越。
	clean := path.Clean("/" + requestPath)
	if strings.Contains(clean, "..") {
		http.NotFound(w, r)
		return
	}
	file, err := s.cfg.UI.Open(strings.TrimPrefix(clean, "/"))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer file.Close()
	stat, err := file.Stat()
	if err != nil || stat.IsDir() {
		http.NotFound(w, r)
		return
	}
	// 界面资源不带哈希文件名，改用 no-cache 让浏览器每次回源校验，
	// 避免升级后仍命中旧 CSS/JS（内嵌资源的 ModTime 为零，无法靠 Last-Modified 判断）。
	w.Header().Set("Cache-Control", "no-cache")
	if seeker, ok := file.(io.ReadSeeker); ok {
		http.ServeContent(w, r, stat.Name(), stat.ModTime(), seeker)
		return
	}
	raw, err := io.ReadAll(file)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	_, _ = w.Write(raw)
}

// ---------------------------------------------------------------- console.Host
//
// 网页端自己实现 Host，独立运行时（cmd/zviewer-webgui）直接把它设为控制台宿主；
// 桌面壳则用 App 作为宿主，并调用 Broadcast* 把同一份事件推给浏览器。

// EmitUpdate 推送快照。
func (s *Server) EmitUpdate(snapshot map[string]any) { s.hub.broadcast("desktop-update", snapshot) }

// Emit 推送命名事件。
func (s *Server) Emit(name string, payload any) { s.hub.broadcast(name, payload) }

// Navigate 让浏览器切页。
func (s *Server) Navigate(page string) { s.hub.broadcast("navigate", page) }

// OpenURL 网页端不能直接开系统浏览器：推给已连接的页面，由前端 window.open。
func (s *Server) OpenURL(url string) error {
	s.hub.broadcast("open-url", map[string]any{"url": url})
	return nil
}

// Message 网页端没有系统消息框：记日志并推一条提示。
func (s *Server) Message(title, message string) {
	s.logger.Printf("%s：%s", title, message)
	s.hub.broadcast("notice", map[string]any{"title": title, "message": message})
}

// DeliverFile 生成一次性下载令牌并通知前端触发下载。
func (s *Server) DeliverFile(name string, data []byte) error {
	token, err := s.deliverFile(name, data)
	if err != nil {
		return err
	}
	s.hub.broadcast("download", map[string]any{
		"url":  "/api/download?token=" + token,
		"name": name,
	})
	return nil
}

// PickFile 网页端不弹系统文件对话框：导入类命令由前端把内容放进 payload。
func (s *Server) PickFile(console.FileRequest) (string, []byte, error) {
	return "", nil, errors.New("网页端不支持选择本地文件，请在页面上直接上传")
}

// OpenDataDir 网页端拿不到资源管理器。
func (s *Server) OpenDataDir(string) error {
	return errors.New("网页端无法打开本地文件夹，请到控制台所在机器上查看")
}

// Notify 网页端用页面内提示代替系统通知。
func (s *Server) Notify(title, message string) {
	s.hub.broadcast("notice", map[string]any{"title": title, "message": message})
}

// ShowWindow 网页端没有窗口可显示：已连接的页面本身就是窗口。
func (s *Server) ShowWindow() {}

// SetLoginItem 开机启动是桌面壳的能力。
func (s *Server) SetLoginItem(bool) error {
	return errors.New("网页端无法设置开机启动，请在桌面程序中设置")
}

// LaunchUpdate 网页端不能执行本地更新脚本。
func (s *Server) LaunchUpdate(string) error {
	return errors.New("网页端无法自动更新，请下载新版本后在控制台机器上替换")
}

// FinishAndQuit 更新流程里的延迟退出；网页端不自杀（可能有人正在远程使用）。
func (s *Server) FinishAndQuit(int) {}

// DownloadsDir 网页端没有默认下载目录。
func (s *Server) DownloadsDir() string { return "" }

// TrayAvailable 网页端没有系统托盘。
func (s *Server) TrayAvailable() bool { return false }

// InitialAdmin 把首次初始化的管理员账号推给页面（只在首次启动出现）。
func (s *Server) InitialAdmin(admin controller.InitialAdmin) {
	s.hub.broadcast("initial-admin", map[string]any{
		"username": admin.Username,
		"password": admin.Password,
	})
	s.logger.Printf("已创建初始管理员账号：%s / %s", admin.Username, admin.Password)
}

// ---------------------------------------------------------------- 工具函数

func (s *Server) issueSession(w http.ResponseWriter, r *http.Request) {
	secure := s.cfg.CertFile != "" || r.TLS != nil ||
		strings.EqualFold(strings.TrimSpace(r.Header.Get("X-Forwarded-Proto")), "https")
	token, expiry := s.auth.newSession()
	cookie := &http.Cookie{
		Name:     sessionCookie,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Expires:  expiry,
		MaxAge:   int(time.Until(expiry).Seconds()),
		Secure:   secure,
	}
	http.SetCookie(w, cookie)
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	encoder := json.NewEncoder(w)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(value)
}

func decodeJSON(r *http.Request, target any) error {
	defer r.Body.Close()
	decoder := json.NewDecoder(io.LimitReader(r.Body, 16<<20))
	return decoder.Decode(target)
}

func methodNotAllowed(w http.ResponseWriter) {
	writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "不支持的请求方法"})
}

func writeAttachment(w http.ResponseWriter, name string, data []byte) {
	if name == "" {
		name = "zviewer-export.bin"
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", "attachment; filename=\""+sanitizeFileName(name)+"\"")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	_, _ = w.Write(data)
}

func sanitizeFileName(name string) string {
	name = path.Base(strings.ReplaceAll(name, "\\", "/"))
	name = strings.ReplaceAll(name, "\"", "")
	name = strings.ReplaceAll(name, "\r", "")
	name = strings.ReplaceAll(name, "\n", "")
	if name == "" || name == "." {
		return "zviewer-export.bin"
	}
	return name
}

func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func isLoopback(r *http.Request) bool {
	ip := net.ParseIP(clientIP(r))
	return ip != nil && ip.IsLoopback()
}

// buildURLs 列出可访问地址：回环优先（本机打开最省事），再列各网卡 IPv4。
func buildURLs(bind string, port int) []string {
	scheme := "http"
	urls := []string{scheme + "://127.0.0.1:" + strconv.Itoa(port)}
	ip := net.ParseIP(bind)
	if ip != nil && !ip.IsUnspecified() {
		if ip.IsLoopback() {
			return urls
		}
		return append(urls, scheme+"://"+ip.String()+":"+strconv.Itoa(port))
	}
	if ip == nil && bind != "" && bind != "0.0.0.0" && bind != "::" {
		return append(urls, scheme+"://"+bind+":"+strconv.Itoa(port))
	}
	interfaces, err := net.Interfaces()
	if err != nil {
		return urls
	}
	for _, iface := range interfaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addresses, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, address := range addresses {
			ipNet, ok := address.(*net.IPNet)
			if !ok {
				continue
			}
			v4 := ipNet.IP.To4()
			if v4 == nil {
				continue
			}
			urls = append(urls, scheme+"://"+v4.String()+":"+strconv.Itoa(port))
		}
	}
	return urls
}

// 编译期确认网页端实现了控制台宿主接口。
var _ console.Host = (*Server)(nil)
