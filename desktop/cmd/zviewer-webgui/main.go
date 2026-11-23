// zviewer-webgui 是独立运行的网页控制台入口：不依赖 Wails/WebView，Linux 上
// 直接跑一个进程就能用浏览器访问 GUI。
//
// 典型用法（运行包目录内）：
//
//	./zviewer-webgui                 # 0.0.0.0:33345，状态目录 ./profile
//	./zviewer-webgui --port 33345 --bind 0.0.0.0
//	./zviewer-webgui --root /opt/zviewer/runtime --state-dir /var/lib/zviewer
//
// 设计要点：
//   - 先起网页服务，再考虑主服务：后端没起来页面照样打开，状态面板显示「未运行」，
//     用户点「启动服务」才会拉起 zviewer-backend——这就是「与正常后端分离」；
//   - 不自动拉起主服务（除非显式 ZVIEWER_SHELL_AUTOSTART=1），避免运维只想要
//     控制台时被顺带启动一堆进程；
//   - 信号退出时等控制台把受管进程收干净（最多 60 秒）再走，避免留下孤儿后端。

package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"

	"zviewer/desktop/console"
	"zviewer/desktop/controller"
	"zviewer/desktop/ui"
	"zviewer/desktop/webgui"
)

// appVersion 由构建脚本用 -ldflags "-X main.appVersion=..." 覆盖（与桌面壳一致）。
var appVersion = "0.4.1"

func main() {
	log.SetFlags(log.LstdFlags)
	log.SetPrefix("zviewer-webgui ")

	rootFlag := flag.String("root", "", "运行包根目录（内含 frontend/ 与 zviewer-backend）")
	stateDirFlag := flag.String("state-dir", "", "状态目录（默认 <root>/profile）")
	port := flag.Int("port", envInt("ZVIEWER_WEB_PORT", webgui.DefaultPort), "网页控制台端口")
	bind := flag.String("bind", envString("ZVIEWER_WEB_BIND", webgui.DefaultBind), "监听地址（0.0.0.0 表示所有网卡）")
	showVersion := flag.Bool("version", false, "打印版本后退出")
	flag.Parse()

	if *showVersion {
		fmt.Printf("zviewer-webgui %s (%s/%s)\n", appVersion, runtime.GOOS, runtime.GOARCH)
		return
	}

	exeDir := executableDir()
	root := resolveRoot(exeDir, *rootFlag)
	stateDir := resolveStateDir(root, *stateDirFlag)
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		log.Fatalf("无法创建状态目录 %s：%v", stateDir, err)
	}

	// 首次初始化数据库时 controller 会回调 InitialAdmin；网页宿主此时还没构造，
	// 用一个小桥接把回调暂存下来，等 webgui 建好再补发（否则管理员密码就丢了）。
	bridge := &bootstrapHost{}
	core, err := console.New(console.Options{
		ExeDir:   exeDir,
		StateDir: stateDir,
		Root:     root,
		Helper:   resolveHelper(root, stateDir),
		Frpc:     firstExisting(root, "frpc", "frpc.exe"),
		CliExecutable: firstExisting(root,
			"zviewer-cli-"+runtime.GOOS+"-"+runtime.GOARCH,
			"zviewer-cli-"+runtime.GOOS+"-"+runtime.GOARCH+".exe",
			"zviewer-cli"),
		// Windows 下 controller 通过 ProcessHost 监管后端进程；运行时包里带了就用上，
		// 这样无头网页控制台在 Windows 也能自己拉起主服务（Linux 不需要该组件）。
		HostExe: firstExisting(root,
			"ZViewer.ProcessHost.exe",
			filepath.Join("assets", "ZViewer.ProcessHost.exe")),
		Version: appVersion,
		ShellExeName: "zviewer-webgui",
		Packaged:     looksLikeRuntime(root),
		// 网页端不提供检查更新（入口、后端命令与自动检查一并关闭）。
		DisableUpdateCheck: true,
		Cipher:             controller.Dpapi{},
		Host:               bridge,
	})
	if err != nil {
		log.Fatalf("初始化控制台失败：%v", err)
	}

	server, err := webgui.New(webgui.Config{
		Console:  core,
		UI:       ui.FS(),
		StateDir: stateDir,
		Version:  appVersion,
		Bind:     *bind,
		Port:     *port,
	})
	if err != nil {
		log.Fatalf("初始化网页控制台失败：%v", err)
	}
	core.SetHost(server)
	bridge.attach(server)

	if err := server.Start(); err != nil {
		log.Fatalf("%v", err)
	}
	printBanner(server, stateDir, root)

	// 主服务不自动启动：先让页面可用，用户点「启动服务」或脚本显式要求时才起。
	if strings.TrimSpace(os.Getenv("ZVIEWER_SHELL_AUTOSTART")) == "1" {
		log.Printf("ZVIEWER_SHELL_AUTOSTART=1：后台启动主服务")
	}
	go core.StartBackground()

	waitForSignal()

	log.Printf("正在停止网页控制台…")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = server.Close(shutdownCtx)
	log.Printf("正在停止受管服务（最多 60 秒）…")
	core.ShutdownManaged()
	log.Printf("已退出")
}

// bootstrapHost 暂存 InitialAdmin 回调，attach 后补发。
type bootstrapHost struct {
	console.HostBase
	mu      sync.Mutex
	target  console.Host
	pending []controller.InitialAdmin
}

func (h *bootstrapHost) InitialAdmin(admin controller.InitialAdmin) {
	h.mu.Lock()
	target := h.target
	if target == nil {
		h.pending = append(h.pending, admin)
	}
	h.mu.Unlock()
	if target != nil {
		target.InitialAdmin(admin)
	}
}

func (h *bootstrapHost) attach(target console.Host) {
	h.mu.Lock()
	h.target = target
	pending := h.pending
	h.pending = nil
	h.mu.Unlock()
	for _, admin := range pending {
		target.InitialAdmin(admin)
	}
}

func waitForSignal() {
	channel := make(chan os.Signal, 1)
	signal.Notify(channel, os.Interrupt, syscall.SIGTERM)
	<-channel
}

func printBanner(server *webgui.Server, stateDir, root string) {
	log.Printf("运行包根目录：%s", root)
	log.Printf("状态目录：%s", stateDir)
	for index, url := range server.URLs() {
		if index == 0 {
			log.Printf("网页控制台地址：%s", url)
			continue
		}
		log.Printf("局域网访问：%s", url)
	}
	setupFile := filepath.Join(stateDir, "webgui-setup.txt")
	if _, err := os.Stat(setupFile); err == nil {
		log.Printf("尚未设置鉴权密码：设置码在 %s（本机访问免密）", setupFile)
	}
	log.Printf("主服务未自动启动；打开页面点「启动服务」即可拉起后端。")
}

// ---------------------------------------------------------------- 路径解析

func executableDir() string {
	exe, err := os.Executable()
	if err != nil {
		if wd, wdErr := os.Getwd(); wdErr == nil {
			return wd
		}
		return "."
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	return filepath.Dir(exe)
}

// resolveRoot 找运行包根：优先 --root，其次可执行文件所在目录，再看它的 runtime/。
func resolveRoot(exeDir, override string) string {
	if override != "" {
		return absolute(override)
	}
	candidates := []string{exeDir, filepath.Join(exeDir, "runtime"), filepath.Dir(exeDir)}
	for _, candidate := range candidates {
		if looksLikeRuntime(candidate) {
			return candidate
		}
	}
	return exeDir
}

// looksLikeRuntime 判断目录是否像运行包：有 frontend 或后端可执行文件。
func looksLikeRuntime(dir string) bool {
	if !dirExists(filepath.Join(dir, "frontend")) {
		return false
	}
	return fileExists(filepath.Join(dir, "zviewer-backend")) ||
		fileExists(filepath.Join(dir, "zviewer-backend.exe"))
}

func resolveStateDir(root, override string) string {
	if override != "" {
		return absolute(override)
	}
	if env := strings.TrimSpace(os.Getenv("ZVIEWER_STATE_DIR")); env != "" {
		return absolute(env)
	}
	return filepath.Join(root, "profile")
}

// resolveHelper 只有 Windows 需要 PowerShell 助手脚本；运行包里没有就留空，
// controller 会退回「不校验端口归属」的路径。
func resolveHelper(root, stateDir string) string {
	if runtime.GOOS != "windows" {
		return ""
	}
	candidates := []string{
		filepath.Join(root, "windows-process.ps1"),
		filepath.Join(stateDir, "windows-process.ps1"),
	}
	for _, candidate := range candidates {
		if fileExists(candidate) {
			return candidate
		}
	}
	return ""
}

func firstExisting(root string, names ...string) string {
	for _, name := range names {
		candidate := filepath.Join(root, name)
		if fileExists(candidate) {
			return candidate
		}
	}
	return ""
}

func absolute(path string) string {
	if resolved, err := filepath.Abs(path); err == nil {
		return resolved
	}
	return path
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

func dirExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
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
	parsed := fallback
	_, _ = fmt.Sscanf(value, "%d", &parsed)
	return parsed
}
