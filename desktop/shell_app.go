package main

// 桌面壳：把不依赖 GUI 框架的控制台核心（console.Console）嵌进 Wails 窗口。
//
// 托盘、系统对话框、更新脚本、注册表开机启动这些桌面专属能力由本文件实现
// （console.Host）；其余命令分发、爬虫桥接、配置导入导出都在 console 包里，
// Linux 网页端（cmd/zviewer-webgui）复用同一份实现。
//
// 同一个进程里还会起一份 HTTP 网页端（webgui.Server，默认 33345）：桌面窗口
// 与浏览器共享同一份控制台状态，事件同时推给 Wails 与 SSE 客户端。

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
	"zviewer/desktop/console"
	"zviewer/desktop/controller"
	uiapp "zviewer/desktop/ui"
	"zviewer/desktop/webgui"
)

// maxPickedFileBytes 限制网页/桌面导入时一次读入的文件大小，避免把界面拖死。
const maxPickedFileBytes = 16 << 20

// App 是绑定给前端的对象（window.go.main.App）。
type App struct {
	ctx      context.Context
	core     *console.Console
	web      *webgui.Server
	webErr   string
	tray     *trayIcon
	quitting atomic.Bool
}

// ---------------------------------------------------------------- 生命周期

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	a.tray = newTray(a)
	a.startWebGUI()
	go a.core.StartBackground()
}

// startWebGUI 在桌面进程里同时起网页端。端口被占用等失败只记日志：
// 桌面窗口本身不依赖网页端，网页端也不依赖后端服务是否启动。
func (a *App) startWebGUI() {
	server, err := webgui.New(webgui.Config{
		Console:  a.core,
		UI:       uiapp.FS(),
		StateDir: a.core.StateDir(),
		Version:  a.core.Version(),
		Bind:     envString("ZVIEWER_WEB_BIND", ""),
		Port:     envInt("ZVIEWER_WEB_PORT", 0),
	})
	if err != nil {
		a.webErr = err.Error()
		a.core.Ctrl().Log("网页端初始化失败："+err.Error(), "console", "ERROR")
		return
	}
	if err := server.Start(); err != nil {
		a.webErr = err.Error()
		a.core.Ctrl().Log("网页端未启动（不影响桌面控制台）："+err.Error(), "console", "WARN")
		return
	}
	a.web = server
	a.core.Ctrl().Log("GUI 网页端已启动："+strings.Join(server.URLs(), " "), "console", "INFO")
}

// assetMiddleware 让 WebView 里的验证页 / 网页内登录弹窗走同源反代。
//
// Wails 的资源服务只认内嵌文件；/api/crawler/challenge/ 必须转给控制台，
// 弹窗 iframe 才能用相对地址加载、并让 Cookie 落在 wails.localhost 这一侧。
func (a *App) assetMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/crawler/challenge/") {
			a.core.ServeCrawlerProxy(w, r)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (a *App) beforeClose(ctx context.Context) bool {
	if a.quitting.Load() {
		return false
	}
	a.requestClose()
	return true
}

func (a *App) shutdown(ctx context.Context) {
	a.core.StopCrawler()
	if a.tray != nil {
		a.tray.remove()
	}
}

func (a *App) requestClose() {
	if a.tray != nil && a.core.Ctrl().Snapshot().Config.CloseToTray && !a.quitting.Load() {
		runtime.WindowHide(a.ctx)
		return
	}
	a.quit()
}

func (a *App) quit() {
	if !a.quitting.CompareAndSwap(false, true) {
		return
	}
	a.core.SetQuitting()
	go func() {
		// 等正在进行的启停操作收尾，最多 60 秒，避免留下半截进程。
		for index := 0; index < 600 && a.core.Ctrl().Busy(); index++ {
			sleep(100)
		}
		a.core.ShutdownManaged()
		if a.web != nil {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			_ = a.web.Close(ctx)
			cancel()
		}
		if a.tray != nil {
			a.tray.remove()
		}
		if a.ctx != nil {
			runtime.Quit(a.ctx)
		}
	}()
}

func (a *App) showWindow() {
	if a.ctx == nil {
		return
	}
	runtime.WindowUnminimise(a.ctx)
	runtime.WindowShow(a.ctx)
	bringToFront(mainWindowHandle())
}

func (a *App) Navigate(page string) {
	if a.ctx == nil {
		return
	}
	runtime.EventsEmit(a.ctx, "navigate", page)
	if a.web != nil {
		a.web.Navigate(page)
	}
}

// ---------------------------------------------------------------- 前端绑定

// Info 返回完整快照，前端据此判断是否运行在真实宿主里（live/native）。
func (a *App) Info() (map[string]any, error) {
	out, err := a.core.Info()
	if err != nil {
		return nil, err
	}
	out["native"] = true
	out["web"] = false
	out["platform"] = "windows"
	if a.web != nil {
		info := a.web.Info()
		// 桌面窗口里回显网页端密码：用户第一次访问网页端要知道输什么。
		info["password"] = a.web.Credential()
		out["webgui"] = info
	} else {
		// 网页端起不来（端口被占用之类）时也给前端一份结构一致的信息，
		// 界面据此提示「网页版 GUI 未启动」而不是显示空白卡片。
		port := envInt("ZVIEWER_WEB_PORT", webgui.DefaultPort)
		bind := envString("ZVIEWER_WEB_BIND", webgui.DefaultBind)
		out["webgui"] = map[string]any{
			"available":   false,
			"bind":        fmt.Sprintf("%s:%d", bind, port),
			"port":        port,
			"urls":        []string{},
			"passwordSet": false,
			"error":       a.webErr,
		}
	}
	return out, nil
}

// Command 执行界面上的操作（与网页端 POST /api/command 等价）。
func (a *App) Command(action string, payload map[string]any) (any, error) {
	return a.core.Command(action, payload)
}

// Window 处理窗口栏按钮：最小化/最大化/关闭/收起到托盘/托盘菜单。
func (a *App) Window(action string) error {
	if a.ctx == nil {
		return nil
	}
	switch action {
	case "minimize":
		runtime.WindowMinimise(a.ctx)
	case "maximize":
		runtime.WindowToggleMaximise(a.ctx)
	case "close":
		a.requestClose()
	case "tray":
		runtime.WindowHide(a.ctx)
	case "tray-menu":
		if a.tray != nil {
			a.tray.popup()
		}
	default:
		return errors.New("未知窗口操作")
	}
	return nil
}

// OpenDocs 用系统浏览器打开使用文档。
func (a *App) OpenDocs() error {
	if a.ctx == nil {
		return console.ErrUnsupported
	}
	runtime.BrowserOpenURL(a.ctx, "https://docx.zviewer.zero251.xyz/")
	return nil
}

// SetTheme 让 Mica 材质的深浅跟随页面主题。
func (a *App) SetTheme(dark bool) {
	setBackdropTheme(windowTitle, dark)
}

// DebugLog 是开发期诊断通道：页面把关键状态写回配置目录下的 probe.log。
func (a *App) DebugLog(message string) error {
	return a.core.DebugLog(message)
}

// ---------------------------------------------------------------- Host：桌面实现

// EmitUpdate 同时推给 Wails 页面、托盘与网页端 SSE 客户端。
func (a *App) EmitUpdate(snapshot map[string]any) {
	if a.ctx != nil {
		runtime.EventsEmit(a.ctx, "desktop-update", snapshot)
	}
	if a.tray != nil {
		a.tray.refresh()
	}
	if a.web != nil {
		a.web.EmitUpdate(snapshot)
	}
}

func (a *App) Emit(name string, payload any) {
	if a.ctx != nil {
		runtime.EventsEmit(a.ctx, name, payload)
	}
	if a.web != nil {
		a.web.Emit(name, payload)
	}
}

func (a *App) OpenURL(url string) error {
	if a.ctx == nil {
		return console.ErrUnsupported
	}
	runtime.BrowserOpenURL(a.ctx, url)
	return nil
}

func (a *App) Message(title, message string) {
	if a.ctx == nil {
		return
	}
	runtime.MessageDialog(a.ctx, runtime.MessageDialogOptions{
		Type:    runtime.InfoDialog,
		Title:   title,
		Message: message,
	})
}

func (a *App) DeliverFile(name string, data []byte) error {
	if a.ctx == nil {
		return console.ErrUnsupported
	}
	target, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		Title:            "导出",
		DefaultFilename:  name,
		DefaultDirectory: a.DownloadsDir(),
	})
	if err != nil {
		return err
	}
	if strings.TrimSpace(target) == "" {
		return console.ErrCanceled
	}
	return os.WriteFile(target, data, 0o600)
}

func (a *App) PickFile(req console.FileRequest) (string, []byte, error) {
	if a.ctx == nil {
		return "", nil, console.ErrUnsupported
	}
	filters := make([]runtime.FileFilter, 0, len(req.Filters))
	for _, item := range req.Filters {
		filters = append(filters, runtime.FileFilter{DisplayName: item.DisplayName, Pattern: item.Pattern})
	}
	path, err := runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title:            req.Title,
		DefaultDirectory: firstNonEmpty(req.DefaultDirectory, a.DownloadsDir()),
		Filters:          filters,
	})
	if err != nil {
		return "", nil, err
	}
	if strings.TrimSpace(path) == "" {
		return "", nil, console.ErrCanceled
	}
	if info, err := os.Stat(path); err == nil && info.Size() > maxPickedFileBytes {
		return "", nil, fmt.Errorf("文件超过 %d MB，请先在本地裁剪", maxPickedFileBytes>>20)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", nil, err
	}
	return path, data, nil
}

func (a *App) OpenDataDir(path string) error {
	cmd := exec.Command("explorer.exe", path)
	hideWindow(cmd)
	return cmd.Start()
}

func (a *App) Notify(title, message string) {
	if a.tray != nil {
		a.tray.balloon(title, message)
	}
}

func (a *App) ShowWindow() { a.showWindow() }

func (a *App) SetLoginItem(enabled bool) error { return setLoginItem(enabled) }

func (a *App) LaunchUpdate(scriptPath string) error {
	cmd := exec.Command("powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass",
		"-WindowStyle", "Hidden", "-File", scriptPath)
	hideWindow(cmd)
	return cmd.Start()
}

func (a *App) FinishAndQuit(delayMillis int) {
	go func() {
		sleep(delayMillis)
		a.quit()
	}()
}

func (a *App) DownloadsDir() string {
	if profile := os.Getenv("USERPROFILE"); profile != "" {
		return filepath.Join(profile, "Downloads")
	}
	home, _ := os.UserHomeDir()
	if home == "" {
		return ""
	}
	return filepath.Join(home, "Downloads")
}

func (a *App) TrayAvailable() bool { return a.tray != nil }

func (a *App) InitialAdmin(admin controller.InitialAdmin) {
	if a.ctx == nil {
		return
	}
	runtime.MessageDialog(a.ctx, runtime.MessageDialogOptions{
		Type:    runtime.InfoDialog,
		Title:   "首次启动：管理员账号已创建",
		Message: fmt.Sprintf("用户名：%s\n密码：%s\n\n请登录后立即修改密码。", admin.Username, admin.Password),
	})
}

// ---------------------------------------------------------------- 辅助

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func envString(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func envInt(key string, fallback int) int {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed <= 0 {
		return fallback
	}
	return parsed
}

// 编译期确认：桌面壳实现了控制台需要的宿主接口。
var _ console.Host = (*App)(nil)
