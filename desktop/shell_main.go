package main

// 桌面壳入口：解析运行包与配置目录位置、准备进程监管助手，
// 并把绑定对象交给 WebView2 窗口。

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	windowsopts "github.com/wailsapp/wails/v2/pkg/options/windows"
)

// appVersion 由构建脚本用 -ldflags "-X main.appVersion=..." 覆盖。
var appVersion = "0.4.1"

// shellExeName 是分发目录里的唯一入口文件名，与 scripts/shell-entry.mjs 保持一致。
// 仅作为 os.Executable() 取不到自身路径时的兜底。
const shellExeName = "ZViewerDesktop.exe"

func argValue(key string) string {
	prefix := "--" + key + "="
	for _, item := range os.Args[1:] {
		if strings.HasPrefix(item, prefix) {
			return strings.TrimPrefix(item, prefix)
		}
	}
	return ""
}

func executableDir() string {
	exe, err := os.Executable()
	if err != nil {
		dir, _ := os.Getwd()
		return dir
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	return filepath.Dir(exe)
}

func resolveStateDir(exeDir string) string {
	if value := argValue("state-dir"); value != "" {
		return absolute(value)
	}
	if value := os.Getenv("ZVIEWER_STATE_DIR"); value != "" {
		return absolute(value)
	}
	if appData := os.Getenv("APPDATA"); appData != "" {
		return filepath.Join(appData, "ZViewerDesktop")
	}
	return filepath.Join(exeDir, "profile")
}

func absolute(path string) string {
	if resolved, err := filepath.Abs(path); err == nil {
		return resolved
	}
	return path
}

func looksLikeRuntime(dir string) bool {
	return fileExists(filepath.Join(dir, "zviewer-backend.exe")) &&
		fileExists(filepath.Join(dir, "frontend", "dist", "index.html"))
}

// packagedInstall 判断当前是否为分发版（exe 同级带 runtime/）。
//
// 判据必须是「runtime 目录里真的有后端与前端产物」，不能写成
// `fileExists(filepath.Join(exeDir, "runtime"))`——fileExists 内部要求
// `!info.IsDir()`，传目录永远返回 false。曾经就是这么写的，后果是分发版里
// packaged 恒为 false：开机启动开关点了报「请在已构建的桌面程序中设置」，
// 而且即便放行也永远不会去写 HKCU 的 Run 项。
func packagedInstall(exeDir string) bool {
	return looksLikeRuntime(filepath.Join(exeDir, "runtime"))
}

// resolveRuntimeRoot 与 desktop/lib/runtime.cjs 的选择顺序一致。
func resolveRuntimeRoot(exeDir string) string {
	override := argValue("runtime-root")
	if override == "" {
		override = os.Getenv("ZVIEWER_RUNTIME_ROOT")
	}
	if override != "" {
		return absolute(override)
	}
	for _, base := range searchRoots(exeDir) {
		for _, dir := range []string{filepath.Join(base, "runtime"), filepath.Join(base, "dist", "win"), base} {
			if looksLikeRuntime(dir) {
				return absolute(dir)
			}
		}
	}
	return absolute(filepath.Join(exeDir, "runtime"))
}

// searchRoots 给出"当前可执行文件附近"的若干目录：
// 打包后是 安装目录/，开发期是 desktop/build/bin 上溯到 desktop/ 与仓库根。
func searchRoots(exeDir string) []string {
	roots := []string{exeDir}
	current := exeDir
	for index := 0; index < 3; index++ {
		current = filepath.Dir(current)
		roots = append(roots, current)
	}
	if cwd, err := os.Getwd(); err == nil {
		roots = append(roots, cwd, filepath.Dir(cwd))
	}
	return roots
}

// companion 依次查找运行包内、打包 runtime/ 与开发期 .runtime/tools/ 下的伴生程序。
func companion(root, exeDir, name string, development []string) string {
	roots := searchRoots(exeDir)
	candidates := []string{filepath.Join(exeDir, "runtime", name), filepath.Join(root, name)}
	if len(development) > 0 {
		for _, base := range roots {
			parts := append([]string{base, ".runtime", "tools"}, development...)
			candidates = append(candidates, filepath.Join(parts...))
		}
	}
	for _, file := range candidates {
		if fileExists(file) {
			return file
		}
	}
	return candidates[0]
}

func resolveHostExe(exeDir, root string) string {
	candidates := []string{filepath.Join(root, "assets", "ZViewer.ProcessHost.exe")}
	for _, base := range searchRoots(exeDir) {
		candidates = append(candidates, filepath.Join(base, "assets", "ZViewer.ProcessHost.exe"))
	}
	for _, file := range candidates {
		if fileExists(file) {
			return file
		}
	}
	return candidates[0]
}

func main() {
	exeDir := executableDir()
	stateDir := resolveStateDir(exeDir)
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		fatalDialog("ZViewer 启动失败", err.Error())
		return
	}
	helper := filepath.Join(stateDir, "windows-process.ps1")
	if err := os.WriteFile(helper, []byte(processHelperScript), 0o600); err != nil {
		fatalDialog("ZViewer 启动失败", "无法写入进程监管助手："+err.Error())
		return
	}

	root := resolveRuntimeRoot(exeDir)
	app := &App{
		exeDir:   exeDir,
		stateDir: stateDir,
		version:  appVersion,
		helper:   helper,
		root:     root,
		frpc:     companion(root, exeDir, "frpc.exe", []string{"frp_0.71.1_windows_amd64", "frpc.exe"}),
		cli:      companion(root, exeDir, "zviewer-cli-windows-amd64.exe", []string{"zviewer-cli", "zviewer-cli-windows-amd64.exe"}),
		hostExe:  resolveHostExe(exeDir, root),
		packaged: packagedInstall(exeDir),
	}
	if err := app.bootstrap(); err != nil {
		fatalDialog("ZViewer 配置读取失败", err.Error()+"\n配置目录："+stateDir)
		return
	}

	// Windows N 无重定向位图的窗口无法被 GDI 截屏，调试时用该开关切成不透明。
	opaque := os.Getenv("ZVIEWER_SHELL_OPAQUE") == "1"
	windowOptions := &windowsopts.Options{
		Theme:        windowsopts.SystemDefault,
		BackdropType: windowsopts.Mica,
		// 浏览器配置随运行状态目录走，避免与其它 WebView2 宿主抢同一份配置。
		WebviewUserDataPath: filepath.Join(stateDir, "webview"),
		WindowClassName:     "zviewerWindow",
	}
	background := &options.RGBA{R: 0, G: 0, B: 0, A: 0}
	if opaque {
		windowOptions.BackdropType = windowsopts.None
		background = &options.RGBA{R: 243, G: 243, B: 243, A: 255}
	} else {
		windowOptions.WebviewIsTransparent = true
		windowOptions.WindowIsTranslucent = true
	}

	appOptions := &options.App{
		Title:            "ZViewer · Windows 控制台",
		Width:            1320,
		Height:           910,
		MinWidth:         1040,
		MinHeight:        740,
		Frameless:        true,
		BackgroundColour: background,
		AssetServer:      &assetserver.Options{Assets: uiFS()},
		Bind:             []interface{}{app},
		OnStartup:        app.startup,
		OnBeforeClose:    app.beforeClose,
		OnShutdown:       app.shutdown,
		SingleInstanceLock: &options.SingleInstanceLock{
			UniqueId:               "xyz.zviewer.desktop",
			OnSecondInstanceLaunch: func(_ options.SecondInstanceData) { app.showWindow() },
		},
		Windows: windowOptions,
	}
	if err := wails.Run(appOptions); err != nil && !errors.Is(err, context.Canceled) {
		fatalDialog("ZViewer 启动失败", err.Error())
	}
}
