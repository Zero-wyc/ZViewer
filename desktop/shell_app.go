package main

// App 是暴露给前端的绑定对象：方法经 Wails 生成 window.go.main.App，
// 再由 ui/bridge.js 包装成界面唯一认的 window.zviewerDesktop。

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"

	"zviewer/desktop/controller"
)

type App struct {
	ctx context.Context

	exeDir   string
	stateDir string
	root     string
	helper   string
	frpc     string
	cli      string
	hostExe  string
	version  string
	packaged bool

	ctrl     *controller.Controller
	quitting atomic.Bool
	tray     *trayIcon
}

func (a *App) bootstrap() error {
	ctrl, err := controller.New(controller.Options{
		Root:          a.root,
		StateDir:      a.stateDir,
		Frpc:          a.frpc,
		CliExecutable: a.cli,
		HostExe:       a.hostExe,
		Helper:        a.helper,
		Version:       a.version,
		Cipher:        controller.Dpapi{},
		OnUpdate:      a.emitUpdate,
		OnInitialAdmin: func(admin controller.InitialAdmin) {
			_, _ = runtime.MessageDialog(a.ctx, runtime.MessageDialogOptions{
				Type:    runtime.InfoDialog,
				Title:   "首次启动 · 管理员登录信息",
				Message: fmt.Sprintf("数据库已初始化。\n\n管理员账号：%s\n初始密码：%s\n\n登录后请在个人设置中修改初始密码。\n密码不会写入运行日志。", admin.Username, admin.Password),
			})
		},
	})
	if err != nil {
		return err
	}
	a.ctrl = ctrl
	return nil
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	a.tray = newTray(a)
	go a.afterStartup()
}

// afterStartup 按配置自动启动服务。
func (a *App) afterStartup() {
	if a.ctrl.Store().Value.AutoStart || os.Getenv("ZVIEWER_SHELL_AUTOSTART") == "1" {
		if _, err := a.ctrl.Start(); err != nil {
			a.ctrl.Log(err.Error(), "backend", "ERROR")
		}
	}
	// 组网与主服务解耦：即使主服务没自动启动，配过自动入网的也会自己起来。
	go a.ctrl.AutoStartMesh()
	go a.checkUpdatesPeriodically()
}

// checkUpdatesPeriodically 启动后延迟检查一次，此后每 6 小时复检；只检查，不自动下载。
func (a *App) checkUpdatesPeriodically() {
	timer := time.NewTimer(6 * time.Second)
	defer timer.Stop()
	for {
		<-timer.C
		if a.quitting.Load() {
			return
		}
		if a.ctrl.Store().Value.AutoCheckUpdate {
			report := a.ctrl.CheckUpdate(false)
			if report.Available {
				a.ctrl.Log("发现新版本 "+report.Latest+"（当前 "+report.Current+"）", "update", "INFO")
			}
		}
		timer.Reset(6 * time.Hour)
	}
}

func (a *App) emitUpdate() {
	if a.ctx == nil {
		return
	}
	runtime.EventsEmit(a.ctx, "desktop-update", a.snapshotMap())
	if a.tray != nil {
		a.tray.refresh()
	}
}

// confirm 弹系统「是 / 否」确认框，只有选「是」才算确认。
//
// Wails v2 的 Windows 后端用 MessageBox 的固定按钮组渲染问询框，自定义的
// Buttons 文案不会生效，返回值恒为 "Yes" / "No" / "Cancel"，所以判断结果必须
// 比对 Yes，不能比对按钮文案（否则任何选择都会被当成取消）。
func (a *App) confirm(title, message string) (bool, error) {
	answer, err := runtime.MessageDialog(a.ctx, runtime.MessageDialogOptions{
		Type:          runtime.QuestionDialog,
		Title:         title,
		Message:       message,
		DefaultButton: "No",
	})
	if err != nil {
		return false, err
	}
	return dialogConfirmed(answer), nil
}

// dialogConfirmed 判断问询框返回值是否代表「确认」。
//
// 只认 Yes（以及中文系统的「是」）：Wails 的 Windows 后端固定返回
// Yes / No / Cancel，不能拿自定义按钮文案做比较。
func dialogConfirmed(answer string) bool {
	switch strings.ToLower(strings.TrimSpace(answer)) {
	case "yes", "是":
		return true
	default:
		return false
	}
}

func (a *App) snapshotMap() map[string]any {
	raw, err := json.Marshal(a.ctrl.Snapshot())
	if err != nil {
		return map[string]any{}
	}
	out := map[string]any{}
	if json.Unmarshal(raw, &out) != nil {
		return map[string]any{}
	}
	return out
}

// DebugLog 是开发期诊断通道：页面把关键状态写回配置目录下的 probe.log。
func (a *App) DebugLog(message string) error {
	file, err := os.OpenFile(filepath.Join(a.stateDir, "probe.log"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer file.Close()
	_, err = file.WriteString(message + "\n")
	return err
}

// Info 返回完整快照，对应 preload 的 info()。
func (a *App) Info() (map[string]any, error) {
	out := a.snapshotMap()
	out["native"] = true
	out["live"] = true
	out["tray"] = a.tray != nil
	out["version"] = a.version
	return out, nil
}

func payloadConfig(payload map[string]any) map[string]any {
	if raw, ok := payload["config"].(map[string]any); ok {
		return raw
	}
	return map[string]any{}
}

func payloadString(payload map[string]any, key string) string {
	if raw, ok := payload[key].(string); ok {
		return raw
	}
	return ""
}

// payloadStrings 取字符串数组，兼容前端直接传 []string 或 JSON 解出来的 []any。
func payloadStrings(payload map[string]any, key string) []string {
	switch raw := payload[key].(type) {
	case []string:
		return raw
	case []any:
		out := make([]string, 0, len(raw))
		for _, item := range raw {
			if text, ok := item.(string); ok && text != "" {
				out = append(out, text)
			}
		}
		return out
	}
	return nil
}

// Command 对应 preload 的 command(action, payload)。
func (a *App) Command(action string, payload map[string]any) (any, error) {
	if payload == nil {
		payload = map[string]any{}
	}
	result, err := a.dispatch(action, payload)
	if err != nil {
		a.ctrl.Log(err.Error(), "console", "ERROR")
		return nil, err
	}
	return result, nil
}

func (a *App) dispatch(action string, payload map[string]any) (any, error) {
	switch action {
	case "start":
		return a.ctrl.Start()
	case "stop":
		return a.ctrl.Stop()
	case "restart":
		return a.ctrl.Restart()
	case "save":
		patch := payloadConfig(payload)
		if !a.packaged {
			if flag, ok := patch["launchAtLogin"].(bool); ok && flag {
				return nil, errors.New("开机启动请在已构建的桌面程序中设置")
			}
		}
		var token *string
		if text := payloadString(payload, "token"); text != "" {
			token = &text
		}
		config, err := a.ctrl.Save(patch, token)
		if err != nil {
			return nil, err
		}
		if a.packaged {
			// 写注册表失败不能静默：开关会显示"已打开"，但登录后其实不会自启。
			// 配置已经落盘，所以这里只报失败原因，不回滚 launchAtLogin。
			if itemErr := setLoginItem(config.LaunchAtLogin); itemErr != nil {
				a.ctrl.Log("写入开机启动项失败: "+itemErr.Error(), "console", "ERROR")
				return config, errors.New("配置已保存，但写入 Windows 开机启动项失败：" + itemErr.Error())
			}
		}
		return config, nil
	case "https":
		return a.ctrl.EnableHTTPS(payloadString(payload, "domain"), payloadString(payload, "ip"))
	case "start-http":
		return a.ctrl.StartHTTP()
	case "open-manager":
		if err := a.openLocalPage(true); err != nil {
			return nil, err
		}
		return true, nil
	case "open-web":
		if err := a.openLocalPage(false); err != nil {
			return nil, err
		}
		return true, nil
	case "cli-start":
		return a.ctrl.StartCli()
	case "cli-stop":
		return a.ctrl.StopCli()
	case "cli-save":
		return a.ctrl.SaveCli(payload)
	case "cli-open":
		url, err := a.ctrl.CliSettingsURL()
		if err != nil {
			return nil, err
		}
		return map[string]any{"url": url}, nil
	case "mesh-start":
		return a.ctrl.StartMesh()
	case "mesh-stop":
		return a.ctrl.StopMesh()
	case "mesh-save":
		var secret *string
		if text := payloadString(payload, "networkSecret"); text != "" {
			secret = &text
		}
		config, err := a.ctrl.SaveMesh(payloadConfig(payload), secret)
		if err != nil {
			return nil, err
		}
		a.emitUpdate()
		return config, nil
	case "mesh-generate":
		return a.ctrl.NewMeshCredentials(), nil
	case "mesh-config":
		return a.ctrl.MeshConfigFile()
	case "mesh-config-save":
		saved, err := a.ctrl.SaveMeshConfigFile(payloadString(payload, "content"), payloadString(payload, "format"))
		if err != nil {
			return nil, err
		}
		a.emitUpdate()
		return saved, nil
	case "mesh-config-import":
		return a.importMeshConfig()
	case "mesh-config-template":
		return a.ctrl.MeshConfigTemplate()
	case "mesh-probe":
		return a.ctrl.ProbePublicPeers(payloadStrings(payload, "peers")), nil
	case "mesh-invite":
		text, err := a.ctrl.MeshInvite()
		if err != nil {
			return nil, err
		}
		return map[string]any{"text": text}, nil
	case "frp-start":
		return a.ctrl.StartFrp()
	case "frp-stop":
		if err := a.ctrl.StopFrp(); err != nil {
			return nil, err
		}
		a.emitUpdate()
		return true, nil
	case "frp-config":
		return a.ctrl.FrpConfigFile()
	case "frp-config-save":
		var token *string
		if text := payloadString(payload, "token"); text != "" {
			token = &text
		}
		saved, err := a.ctrl.SaveFrpConfigFile(payloadString(payload, "content"), payloadString(payload, "format"), token)
		if err != nil {
			return nil, err
		}
		a.emitUpdate()
		return saved, nil
	case "frp-config-import":
		return a.importFrpConfig()
	case "probe-ipv6":
		return a.ctrl.ProbeIPv6(true), nil
	case "tunnel-start":
		return a.ctrl.StartTunnel()
	case "tunnel-stop":
		if err := a.ctrl.StopTunnel(); err != nil {
			return nil, err
		}
		a.emitUpdate()
		return true, nil
	case "tunnel-refresh":
		return a.ctrl.RefreshTunnel()
	case "update-check":
		return a.ctrl.CheckUpdate(true), nil
	case "update-download":
		return a.ctrl.StartUpdateDownload()
	case "update-apply":
		return a.applyUpdate()
	case "update-page":
		report := a.ctrl.UpdateReport()
		target := report.PageURL
		if target == "" {
			// 没有具体发布页时给仓库的 releases 列表，按当前来源站给对应地址。
			if report.Source == "gitcode" {
				target = "https://gitcode.com/Zero-wyc/ZViewer/releases"
			} else {
				target = "https://github.com/Zero-wyc/ZViewer/releases"
			}
		}
		runtime.BrowserOpenURL(a.ctx, target)
		return true, nil
	case "update-proxy":
		// 前端只提交反代相关字段，保存成功后立即重查，界面可直接看到新链路的结果。
		patch := map[string]any{}
		if flag, ok := payload["enabled"].(bool); ok {
			patch["updateProxy"] = flag
		}
		if text, ok := payload["url"].(string); ok {
			patch["updateProxyUrl"] = text
		}
		if len(patch) == 0 {
			return nil, errors.New("缺少反代参数")
		}
		if _, err := a.ctrl.Save(patch, nil); err != nil {
			return nil, err
		}
		report := a.ctrl.CheckUpdate(true)
		a.emitUpdate()
		return report, nil
	case "update-source":
		// 更新源开关（GitCode / GitHub）：保存后立即重查，界面直接显示新源的结果。
		enabled, ok := payload["enabled"].(bool)
		if !ok {
			return nil, errors.New("缺少更新源参数")
		}
		if _, err := a.ctrl.Save(map[string]any{"updateGitCode": enabled}, nil); err != nil {
			return nil, err
		}
		report := a.ctrl.CheckUpdate(true)
		a.emitUpdate()
		return report, nil
	case "export":
		return a.exportFile(payloadString(payload, "kind"))
	case "open-data":
		return a.openDataDir()
	}
	return nil, errors.New("不支持的操作")
}

// applyUpdate 交给独立脚本接管：本进程退出后解压覆盖运行目录，再启动新版本。
func (a *App) applyUpdate() (bool, error) {
	// 用当前进程的真实路径，而不是写死入口名：改名后旧版本仍能正确指回自己，
	// 新包里的入口由安装脚本按解压结果决定。
	exe, err := os.Executable()
	if err != nil {
		exe = filepath.Join(a.exeDir, shellExeName)
	}
	script, err := a.ctrl.PrepareUpdate(a.exeDir, exe, os.Getpid())
	if err != nil {
		return false, err
	}
	cmd := exec.Command("powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", script)
	hideWindow(cmd)
	if err := cmd.Start(); err != nil {
		return false, fmt.Errorf("无法启动更新程序：%w", err)
	}
	a.ctrl.Log("更新包已就绪，程序即将退出并安装", "update", "INFO")
	go func() {
		sleep(600)
		a.quit()
	}()
	return true, nil
}

func (a *App) openLocalPage(manager bool) error {
	snapshot := a.ctrl.Snapshot()
	if snapshot.Backend != "running" {
		if _, err := a.ctrl.Start(); err != nil {
			return err
		}
	}
	// 未安装本机信任也照常打开：自签证书在浏览器里只会提示一次不安全，
	// 选择继续访问即可，不必把用户踢回证书页。
	target := a.ctrl.WebURL()
	if manager {
		target = a.ctrl.ManagementURL()
	}
	runtime.BrowserOpenURL(a.ctx, target)
	return nil
}

func (a *App) exportFile(kind string) (bool, error) {
	name, contents, err := a.ctrl.Export(kind)
	if err != nil {
		return false, err
	}
	path, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		Title:            "导出",
		DefaultFilename:  name,
		DefaultDirectory: downloadsDir(),
	})
	if err != nil || path == "" {
		return false, nil
	}
	if err := os.WriteFile(path, contents, 0o600); err != nil {
		return false, err
	}
	return true, nil
}

// importFrpConfig 让用户挑一个现成的 frpc 配置文件，读入后直接成为当前配置。
// 只读取与保存，不在这里启动 frpc：界面还需要让用户确认内容与密钥。
func (a *App) importFrpConfig() (any, error) {
	path, err := runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title:            "导入 frpc 配置文件",
		DefaultDirectory: downloadsDir(),
		Filters: []runtime.FileFilter{
			{DisplayName: "frpc 配置（TOML / YAML / JSON）", Pattern: "*.toml;*.yaml;*.yml;*.json"},
		},
	})
	if err != nil {
		return nil, err
	}
	if path == "" {
		return map[string]any{"canceled": true}, nil
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, fmt.Errorf("无法读取配置文件：%w", err)
	}
	if info.Size() > controller.MaxFrpConfigBytes {
		return nil, errors.New("配置文件不能超过 256 KB")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("无法读取配置文件：%w", err)
	}
	saved, err := a.ctrl.SaveFrpConfigFile(string(raw), filepath.Ext(path), nil)
	if err != nil {
		return nil, err
	}
	saved["name"] = filepath.Base(path)
	a.emitUpdate()
	return saved, nil
}

// importMeshConfig 让用户从磁盘挑一份 EasyTier TOML 直接导入并保存。
func (a *App) importMeshConfig() (any, error) {
	path, err := runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title:            "导入 EasyTier 配置文件",
		DefaultDirectory: downloadsDir(),
		Filters: []runtime.FileFilter{
			{DisplayName: "EasyTier 配置（TOML）", Pattern: "*.toml"},
		},
	})
	if err != nil {
		return nil, err
	}
	if path == "" {
		return map[string]any{"canceled": true}, nil
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, fmt.Errorf("无法读取配置文件：%w", err)
	}
	if info.Size() > controller.MaxMeshConfigBytes {
		return nil, errors.New("配置文件不能超过 256 KB")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("无法读取配置文件：%w", err)
	}
	saved, err := a.ctrl.SaveMeshConfigFile(string(raw), filepath.Ext(path))
	if err != nil {
		return nil, err
	}
	saved["name"] = filepath.Base(path)
	a.emitUpdate()
	return saved, nil
}

func (a *App) openDataDir() (bool, error) {
	cmd := exec.Command("explorer.exe", a.stateDir)
	hideWindow(cmd)
	if err := cmd.Start(); err != nil {
		return false, fmt.Errorf("无法打开配置目录：%w", err)
	}
	return true, nil
}

func downloadsDir() string {
	if profile := os.Getenv("USERPROFILE"); profile != "" {
		return filepath.Join(profile, "Downloads")
	}
	return ""
}

// Window 对应 preload 的 window(action)。
func (a *App) Window(action string) error {
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
		if a.tray == nil {
			return errors.New("系统托盘不可用")
		}
		a.tray.popup()
	default:
		return errors.New("未知窗口操作")
	}
	return nil
}

// OpenDocs 打开使用文档。
func (a *App) OpenDocs() error {
	runtime.BrowserOpenURL(a.ctx, "https://docx.zviewer.zero251.xyz/")
	return nil
}

// SetTheme 让 DWM 材质的深浅与页面主题保持一致。
func (a *App) SetTheme(dark bool) error {
	setBackdropTheme("ZViewer · Windows 控制台", dark)
	return nil
}

func (a *App) requestClose() {
	if a.tray != nil && a.ctrl.Store().Value.CloseToTray && !a.quitting.Load() {
		runtime.WindowHide(a.ctx)
		return
	}
	a.quit()
}

func (a *App) quit() {
	if !a.quitting.CompareAndSwap(false, true) {
		return
	}
	go func() {
		// 等待正在进行的服务操作结束，最多 60 秒，再回收受管进程。
		for index := 0; index < 600 && a.ctrl.Busy(); index++ {
			sleep(100)
		}
		if err := a.ctrl.Shutdown(); err != nil {
			a.ctrl.Log("停止受管服务失败："+err.Error(), "console", "ERROR")
		}
		if a.tray != nil {
			a.tray.remove()
		}
		runtime.Quit(a.ctx)
	}()
}

func (a *App) beforeClose(context.Context) bool {
	if a.quitting.Load() {
		return false
	}
	a.requestClose()
	return true
}

func (a *App) shutdown(context.Context) {
	if a.tray != nil {
		a.tray.remove()
	}
}

func (a *App) showWindow() {
	if a.ctx == nil {
		return
	}
	runtime.WindowUnminimise(a.ctx)
	runtime.WindowShow(a.ctx)
	bringToFront(mainWindowHandle())
}

// navigate 让界面切换到指定页面（托盘菜单用）。
func (a *App) navigate(page string) {
	if a.ctx == nil {
		return
	}
	runtime.EventsEmit(a.ctx, "navigate", page)
}
