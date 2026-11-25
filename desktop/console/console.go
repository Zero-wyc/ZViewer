package console

// Console 是「桌面控制台」的核心：controller 生命周期、命令分发、爬虫桥接、
// 配置导入导出。它不依赖 Wails，也不直接操作系统窗口——所有宿主相关能力都经
// Host 接口（见 host.go）。桌面壳（Wails）与网页端（HTTP）各自实现 Host，
// 于是两边行为一致，Linux 也能用同一份控制台逻辑。

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"zviewer/desktop/controller"
)

// Options 是构造控制台需要的路径与运行信息。
type Options struct {
	ExeDir   string
	StateDir string
	Root     string
	Helper   string
	Frpc     string
	// CliExecutable 高画质代理（zviewer-cli）可执行文件路径。
	CliExecutable string
	// HostExe 是 Windows 下托管后端进程的 ZViewer.ProcessHost.exe。
	HostExe string
	Version string
	// ShellExeName 是 os.Executable() 失败时的入口名兜底（更新脚本用）。
	ShellExeName string
	Packaged     bool
	// DisableUpdateCheck 关闭自动检查更新与更新相关命令：网页端不提供更新功能。
	DisableUpdateCheck bool
	Cipher             controller.Cipher
	Host               Host
}

// Console 是控制台核心对象，可被多个宿主共享。
type Console struct {
	exeDir   string
	stateDir string
	root     string
	helper   string
	frpc     string
	cli      string
	hostExe  string
	version  string
	shellExe string
	packaged bool
	// disableUpdateCheck 为 true 时网页端既不自动查更新，也拒绝更新类命令。
	disableUpdateCheck bool

	ctrl    *controller.Controller
	crawler *crawlerBridge

	hostMu sync.RWMutex
	host   Host

	quitting atomic.Bool
}

// New 初始化控制器与爬虫桥接。此时不会启动任何服务，启动时机由 StartBackground
// 或界面上的「启动服务」决定。
func New(opts Options) (*Console, error) {
	console := &Console{
		exeDir:             opts.ExeDir,
		stateDir:           opts.StateDir,
		root:               opts.Root,
		helper:             opts.Helper,
		frpc:               opts.Frpc,
		cli:                opts.CliExecutable,
		hostExe:            opts.HostExe,
		version:            opts.Version,
		shellExe:           opts.ShellExeName,
		packaged:           opts.Packaged,
		disableUpdateCheck: opts.DisableUpdateCheck,
		host:               opts.Host,
	}
	if console.host == nil {
		console.host = HostBase{}
	}
	if console.shellExe == "" {
		console.shellExe = "ZViewerDesktop.exe"
	}
	crawlerRoot := resolveCrawlerRoot(opts.ExeDir, opts.Root)
	ctrl, err := controller.New(controller.Options{
		Root:          opts.Root,
		StateDir:      opts.StateDir,
		Frpc:          opts.Frpc,
		CliExecutable: opts.CliExecutable,
		HostExe:       opts.HostExe,
		Helper:        opts.Helper,
		Version:       opts.Version,
		CrawlerRoot:   crawlerRoot,
		Cipher:        opts.Cipher,
		OnUpdate:      console.emitUpdate,
		OnInitialAdmin: func(admin controller.InitialAdmin) {
			console.Host().InitialAdmin(admin)
		},
	})
	if err != nil {
		return nil, err
	}
	console.ctrl = ctrl
	console.crawler = newCrawlerBridge(opts.ExeDir, opts.Root, console)
	return console, nil
}

// ---------------------------------------------------------------- 访问器

// Ctrl 暴露底层控制器（托盘菜单等需要直接读写状态）。
func (c *Console) Ctrl() *controller.Controller { return c.ctrl }

func (c *Console) StateDir() string { return c.stateDir }
func (c *Console) Root() string     { return c.root }
func (c *Console) ExeDir() string   { return c.exeDir }
func (c *Console) Version() string  { return c.version }
func (c *Console) Packaged() bool   { return c.packaged }

// SetHost 绑定宿主。网页端在构造后、桌面壳在 startup 之前调用。
func (c *Console) SetHost(h Host) {
	if h == nil {
		return
	}
	c.hostMu.Lock()
	c.host = h
	c.hostMu.Unlock()
}

// Host 返回当前宿主；未绑定时返回空实现，避免 nil 判断散落各处。
func (c *Console) Host() Host {
	c.hostMu.RLock()
	defer c.hostMu.RUnlock()
	if c.host == nil {
		return HostBase{}
	}
	return c.host
}

// CrawlerRoot 是爬虫数据目录（已解析），供入口打印诊断信息。
func (c *Console) CrawlerRoot() string {
	if c.crawler == nil {
		return ""
	}
	return c.crawler.root
}

// SetQuitting 通知后台轮询（更新检查/人机验证）退出。
func (c *Console) SetQuitting() { c.quitting.Store(true) }

// ---------------------------------------------------------------- 生命周期

// StartBackground 按配置自动启动服务。与旧桌面壳的 afterStartup 行为一致：
// 主服务、组网、更新检查与爬虫引擎互不阻塞。
func (c *Console) StartBackground() {
	if c.ctrl.Store().Value.AutoStart || os.Getenv("ZVIEWER_SHELL_AUTOSTART") == "1" {
		if _, err := c.ctrl.Start(); err != nil {
			c.ctrl.Log(err.Error(), "backend", "ERROR")
		}
	}
	// 组网与主服务解耦：即使主服务没自动启动，配过自动入网的也会自己起来。
	go c.ctrl.AutoStartMesh()
	// 外部托管的后端（start.sh / start.ps1 / 容器入口拉起）不在 controller
	// 的进程表里，靠 .runtime.json 定期发现；状态变化时推一次快照。
	go c.watchExternalBackend()
	if !c.disableUpdateCheck {
		go c.checkUpdatesPeriodically()
	}
	// 爬虫引擎是网页端「全网搜片」的后端依赖：随控制台启动。
	go func() {
		if c.crawler == nil {
			return
		}
		if available, reason := c.crawler.available(); !available {
			c.ctrl.Log("爬虫引擎不可用："+reason, "crawler", "WARN")
			return
		}
		if _, err := c.crawler.start(); err != nil {
			c.ctrl.Log("爬虫引擎启动失败："+err.Error(), "crawler", "WARN")
			return
		}
		go c.watchChallenges()
	}()
}

// watchExternalBackend 每 2 秒重新发现一次外部托管的后端。
//
// 为什么不是事件驱动：脚本/容器入口起后端时不会通知控制台，两边唯一的
// 交汇点是运行根目录下的 .runtime.json。轮询一个小文件（外加一次 /proc
// 读取）成本可以忽略，换来的是状态最多晚 2 秒、且不依赖启动顺序。
func (c *Console) watchExternalBackend() {
	// 先同步刷一次：网页一打开就该看到真实状态，而不是等两秒。
	if c.ctrl.RefreshExternal() {
		c.emitUpdate()
	}
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		if c.quitting.Load() {
			return
		}
		if c.ctrl.RefreshExternal() {
			c.emitUpdate()
		}
	}
}

// checkUpdatesPeriodically 启动后延迟检查一次，此后每 6 小时复检；只检查，不自动下载。
func (c *Console) checkUpdatesPeriodically() {
	timer := time.NewTimer(6 * time.Second)
	defer timer.Stop()
	for {
		<-timer.C
		if c.quitting.Load() {
			return
		}
		if c.ctrl.Store().Value.AutoCheckUpdate {
			report := c.ctrl.CheckUpdate(false)
			if report.Available {
				c.ctrl.Log("发现新版本 "+report.Latest+"（当前 "+report.Current+"）", "update", "INFO")
			}
		}
		timer.Reset(6 * time.Hour)
	}
}

// emitUpdate 把最新快照推给宿主（桌面事件 / 网页 SSE）。
//
// controller.New 内部会先写一条启动日志再返回，此时 c.ctrl 还没赋值：
// 回调必须能容忍这次「早到」的更新，否则整个进程启动即空指针崩溃。
func (c *Console) emitUpdate() {
	if c.ctrl == nil {
		return
	}
	c.Host().EmitUpdate(c.SnapshotMap())
}

// Emit 向界面广播一个自定义事件（桌面端 = Wails 事件，网页端 = SSE）。
// 用于刷新不在快照里的信息（例如规则导入结果这类一次性状态）。
func (c *Console) Emit(name string, payload any) {
	c.Host().Emit(name, payload)
}

// ShutdownManaged 等待进行中的操作结束（最多 60 秒）后停止受管进程。
func (c *Console) ShutdownManaged() {
	for index := 0; index < 600 && c.ctrl.Busy(); index++ {
		time.Sleep(100 * time.Millisecond)
	}
	if err := c.ctrl.Shutdown(); err != nil {
		c.ctrl.Log("停止受管服务失败："+err.Error(), "console", "ERROR")
	}
	c.StopCrawler()
}

// StopCrawler 回收爬虫桥接（引擎随后端退出，这里只是清钩子）。
func (c *Console) StopCrawler() {
	if c.crawler != nil {
		c.crawler.stopQuietly()
	}
}

// SnapshotMap 把控制器快照转成 map，供前端直接消费。
func (c *Console) SnapshotMap() map[string]any {
	if c.ctrl == nil {
		return map[string]any{}
	}
	raw, err := json.Marshal(c.ctrl.Snapshot())
	if err != nil {
		return map[string]any{}
	}
	out := map[string]any{}
	if json.Unmarshal(raw, &out) != nil {
		return map[string]any{}
	}
	return out
}

// Info 返回完整快照，对应前端 preload 的 info()。
func (c *Console) Info() (map[string]any, error) {
	out := c.SnapshotMap()
	out["live"] = true
	out["tray"] = c.Host().TrayAvailable()
	out["version"] = c.version
	return out, nil
}

// EnsureBackend 保证主服务已运行：内嵌网页端和外部浏览器打开都先走这里。
func (c *Console) EnsureBackend() error {
	if c.ctrl.Snapshot().Backend == "running" {
		return nil
	}
	_, err := c.ctrl.Start()
	return err
}

// DebugLog 是开发期诊断通道：页面把关键状态写回配置目录下的 probe.log。
func (c *Console) DebugLog(message string) error {
	file, err := os.OpenFile(filepath.Join(c.stateDir, "probe.log"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer file.Close()
	_, err = file.WriteString(message + "\n")
	return err
}

// ---------------------------------------------------------------- 命令分发

// Command 对应前端的 command(action, payload)，使用控制台默认宿主。
func (c *Console) Command(action string, payload map[string]any) (any, error) {
	return c.CommandWith(c.Host(), action, payload)
}

// CommandWith 用指定宿主执行命令：网页端每个请求构造一个请求级宿主，
// 这样导出文件能生成一次性下载令牌、打开链接能推给发起请求的页面。
func (c *Console) CommandWith(h Host, action string, payload map[string]any) (any, error) {
	if h == nil {
		h = c.Host()
	}
	if payload == nil {
		payload = map[string]any{}
	}
	result, err := c.dispatch(h, action, payload)
	if err != nil {
		c.ctrl.Log(err.Error(), "console", "ERROR")
		return nil, err
	}
	return result, nil
}

func (c *Console) dispatch(h Host, action string, payload map[string]any) (any, error) {
	// 网页端不提供检查更新：UI 已隐藏入口，后端也拒绝这类命令，避免残留旧页面误触发。
	if c.disableUpdateCheck && strings.HasPrefix(action, "update-") {
		return nil, errors.New("网页端不提供检查更新")
	}
	switch action {
	case "start":
		return c.ctrl.Start()
	case "stop":
		// 停止只结束受管服务与伴生进程，控制台窗口必须继续运行；
		// 退出程序只走托盘「退出并停止受管服务」或关闭窗口（未开启关闭到托盘时）。
		snapshot, err := c.ctrl.Stop()
		if err != nil {
			return nil, err
		}
		c.ctrl.Log("服务已停止，控制台保持运行；关闭窗口只会收起到托盘。", "console", "INFO")
		return snapshot, nil
	case "restart":
		return c.ctrl.Restart()
	case "save":
		patch := payloadConfig(payload)
		if !c.packaged {
			if flag, ok := patch["launchAtLogin"].(bool); ok && flag {
				return nil, errors.New("开机启动请在已构建的桌面程序中设置")
			}
		}
		var token *string
		if text := payloadString(payload, "token"); text != "" {
			token = &text
		}
		config, err := c.ctrl.Save(patch, token)
		if err != nil {
			return nil, err
		}
		if c.packaged {
			// 写注册表失败不能静默：开关会显示"已打开"，但登录后其实不会自启。
			// 配置已经落盘，所以这里只报失败原因，不回滚 launchAtLogin。
			if itemErr := h.SetLoginItem(config.LaunchAtLogin); itemErr != nil {
				c.ctrl.Log("写入开机启动项失败: "+itemErr.Error(), "console", "ERROR")
				return config, errors.New("配置已保存，但写入开机启动项失败：" + itemErr.Error())
			}
		}
		return config, nil
	case "https":
		return c.ctrl.EnableHTTPS(payloadString(payload, "domain"), payloadString(payload, "ip"))
	case "start-http":
		return c.ctrl.StartHTTP()
	case "open-manager":
		if err := c.openLocalPage(h, true); err != nil {
			return nil, err
		}
		return true, nil
	case "open-web":
		// 网页端内嵌在控制台的「网页端」页；服务没起来时先拉起，再切到该页。
		if err := c.EnsureBackend(); err != nil {
			return nil, err
		}
		h.ShowWindow()
		h.Navigate("web")
		return true, nil
	case "open-web-external":
		if err := c.openLocalPage(h, false); err != nil {
			return nil, err
		}
		return true, nil
	case "cli-start":
		return c.ctrl.StartCli()
	case "cli-stop":
		return c.ctrl.StopCli()
	case "cli-save":
		return c.ctrl.SaveCli(payload)
	case "cli-open":
		url, err := c.ctrl.CliSettingsURL()
		if err != nil {
			return nil, err
		}
		return map[string]any{"url": url}, nil
	case "component-install":
		// 可选组件（cloudflared / easytier）：后台下载，进度随快照推送。
		return c.ctrl.InstallComponent(payloadString(payload, "name"))
	case "mesh-start":
		return c.ctrl.StartMesh()
	case "mesh-stop":
		return c.ctrl.StopMesh()
	case "mesh-save":
		var secret *string
		if text := payloadString(payload, "networkSecret"); text != "" {
			secret = &text
		}
		config, err := c.ctrl.SaveMesh(payloadConfig(payload), secret)
		if err != nil {
			return nil, err
		}
		c.emitUpdate()
		return config, nil
	case "mesh-generate":
		return c.ctrl.NewMeshCredentials(), nil
	case "mesh-config":
		return c.ctrl.MeshConfigFile()
	case "mesh-config-save":
		saved, err := c.ctrl.SaveMeshConfigFile(payloadString(payload, "content"), payloadString(payload, "format"))
		if err != nil {
			return nil, err
		}
		c.emitUpdate()
		return saved, nil
	case "mesh-config-import":
		return c.importMeshConfig(h, payload)
	case "mesh-config-template":
		return c.ctrl.MeshConfigTemplate()
	case "mesh-probe":
		return c.ctrl.ProbePublicPeers(payloadStrings(payload, "peers")), nil
	case "mesh-invite":
		text, err := c.ctrl.MeshInvite()
		if err != nil {
			return nil, err
		}
		return map[string]any{"text": text}, nil
	case "frp-start":
		return c.ctrl.StartFrp()
	case "frp-stop":
		if err := c.ctrl.StopFrp(); err != nil {
			return nil, err
		}
		c.emitUpdate()
		return true, nil
	case "frp-config":
		return c.ctrl.FrpConfigFile()
	case "frp-config-save":
		var token *string
		if text := payloadString(payload, "token"); text != "" {
			token = &text
		}
		saved, err := c.ctrl.SaveFrpConfigFile(payloadString(payload, "content"), payloadString(payload, "format"), token)
		if err != nil {
			return nil, err
		}
		c.emitUpdate()
		return saved, nil
	case "frp-config-import":
		return c.importFrpConfig(h, payload)
	case "probe-ipv6":
		return c.ctrl.ProbeIPv6(true), nil
	case "tunnel-start":
		return c.ctrl.StartTunnel()
	case "tunnel-stop":
		if err := c.ctrl.StopTunnel(); err != nil {
			return nil, err
		}
		c.emitUpdate()
		return true, nil
	case "tunnel-refresh":
		return c.ctrl.RefreshTunnel()
	case "crawler-info":
		return c.crawlerInfo()
	case "mcp-info":
		return c.mcpInfo()
	case "crawler-start":
		return c.crawler.start()
	case "crawler-stop":
		return c.crawler.stop()
	case "crawler-api":
		return c.crawlerAPI(payload)
	case "crawler-rules":
		return c.crawler.rules()
	case "crawler-doc":
		return c.crawler.docs()
	case "crawler-config":
		return c.crawler.llmConfig(), nil
	case "crawler-config-save":
		return c.crawler.saveLLM(payload)
	case "crawler-export":
		return c.crawler.exportRules(payloadStrings(payload, "ids"), h)
	case "crawler-import":
		return c.crawler.importRules(payload, h)
	case "update-check":
		return c.ctrl.CheckUpdate(true), nil
	case "update-download":
		return c.ctrl.StartUpdateDownload()
	case "update-apply":
		return c.applyUpdate(h)
	case "update-page":
		report := c.ctrl.UpdateReport()
		target := report.PageURL
		if target == "" {
			// 没有具体发布页时给仓库的 releases 列表，按当前来源站给对应地址。
			if report.Source == "gitcode" {
				target = "https://gitcode.com/Zero-wyc/ZViewer/releases"
			} else {
				target = "https://github.com/Zero-wyc/ZViewer/releases"
			}
		}
		if err := h.OpenURL(target); err != nil {
			return nil, err
		}
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
		if _, err := c.ctrl.Save(patch, nil); err != nil {
			return nil, err
		}
		report := c.ctrl.CheckUpdate(true)
		c.emitUpdate()
		return report, nil
	case "update-source":
		// 更新源开关（GitCode / GitHub）：保存后立即重查，界面直接显示新源的结果。
		enabled, ok := payload["enabled"].(bool)
		if !ok {
			return nil, errors.New("缺少更新源参数")
		}
		if _, err := c.ctrl.Save(map[string]any{"updateGitCode": enabled}, nil); err != nil {
			return nil, err
		}
		report := c.ctrl.CheckUpdate(true)
		c.emitUpdate()
		return report, nil
	case "export":
		return c.exportFile(h, payloadString(payload, "kind"))
	case "open-data":
		if err := h.OpenDataDir(c.stateDir); err != nil {
			return nil, err
		}
		return true, nil
	}
	return nil, errors.New("不支持的操作")
}

// ---------------------------------------------------------------- 文件类操作

// applyUpdate 交给独立脚本接管：本进程退出后解压覆盖运行目录，再启动新版本。
func (c *Console) applyUpdate(h Host) (bool, error) {
	// 用当前进程的真实路径，而不是写死入口名：改名后旧版本仍能正确指回自己。
	exe, err := os.Executable()
	if err != nil {
		exe = filepath.Join(c.exeDir, c.shellExe)
	}
	script, err := c.ctrl.PrepareUpdate(c.exeDir, exe, os.Getpid())
	if err != nil {
		return false, err
	}
	if err := h.LaunchUpdate(script); err != nil {
		return false, err
	}
	c.ctrl.Log("更新包已就绪，程序即将退出并安装", "update", "INFO")
	go func() {
		time.Sleep(600 * time.Millisecond)
		h.FinishAndQuit(0)
	}()
	return true, nil
}

func (c *Console) openLocalPage(h Host, manager bool) error {
	if err := c.EnsureBackend(); err != nil {
		return err
	}
	// 未安装本机信任也照常打开：自签证书在浏览器里只会提示一次不安全，
	// 选择继续访问即可。
	target := c.ctrl.WebURL()
	if manager {
		target = c.ctrl.ManagementURL()
	}
	return h.OpenURL(target)
}

func (c *Console) exportFile(h Host, kind string) (bool, error) {
	name, contents, err := c.ctrl.Export(kind)
	if err != nil {
		return false, err
	}
	if err := h.DeliverFile(name, contents); err != nil {
		if errors.Is(err, ErrCanceled) {
			return false, nil
		}
		return false, err
	}
	return true, nil
}

// importFrpConfig 让用户挑一个现成的 frpc 配置文件，读入后直接成为当前配置。
//
// 桌面端经 Host.PickFile 弹文件对话框；网页端由前端读文件后把 content 放在
// payload 里（浏览器不能给服务端弹本地文件框）。只读取与保存，不启动 frpc：
// 界面还需要让用户确认内容与密钥。
func (c *Console) importFrpConfig(h Host, payload map[string]any) (any, error) {
	content := payloadString(payload, "content")
	format := payloadString(payload, "format")
	name := payloadString(payload, "name")
	if content == "" {
		pickedName, data, err := h.PickFile(FileRequest{
			Title:            "导入 frpc 配置文件",
			DefaultDirectory: h.DownloadsDir(),
			Filters: []FileFilter{
				{DisplayName: "frpc 配置（TOML / YAML / JSON）", Pattern: "*.toml;*.yaml;*.yml;*.json"},
			},
		})
		if err != nil {
			if errors.Is(err, ErrCanceled) {
				return map[string]any{"canceled": true}, nil
			}
			return nil, err
		}
		if pickedName == "" {
			return map[string]any{"canceled": true}, nil
		}
		if len(data) > controller.MaxFrpConfigBytes {
			return nil, errors.New("配置文件不能超过 256 KB")
		}
		content = string(data)
		name = pickedName
		format = filepath.Ext(pickedName)
	}
	if len(content) > controller.MaxFrpConfigBytes {
		return nil, errors.New("配置文件不能超过 256 KB")
	}
	saved, err := c.ctrl.SaveFrpConfigFile(content, format, nil)
	if err != nil {
		return nil, err
	}
	if name != "" {
		saved["name"] = filepath.Base(name)
	}
	c.emitUpdate()
	return saved, nil
}

// importMeshConfig 让用户从磁盘挑一份 EasyTier TOML 直接导入并保存。
func (c *Console) importMeshConfig(h Host, payload map[string]any) (any, error) {
	content := payloadString(payload, "content")
	format := payloadString(payload, "format")
	name := payloadString(payload, "name")
	if content == "" {
		pickedName, data, err := h.PickFile(FileRequest{
			Title:            "导入 EasyTier 配置文件",
			DefaultDirectory: h.DownloadsDir(),
			Filters: []FileFilter{
				{DisplayName: "EasyTier 配置（TOML）", Pattern: "*.toml"},
			},
		})
		if err != nil {
			if errors.Is(err, ErrCanceled) {
				return map[string]any{"canceled": true}, nil
			}
			return nil, err
		}
		if pickedName == "" {
			return map[string]any{"canceled": true}, nil
		}
		if len(data) > controller.MaxMeshConfigBytes {
			return nil, errors.New("配置文件不能超过 256 KB")
		}
		content = string(data)
		name = pickedName
		format = filepath.Ext(pickedName)
	}
	if len(content) > controller.MaxMeshConfigBytes {
		return nil, errors.New("配置文件不能超过 256 KB")
	}
	saved, err := c.ctrl.SaveMeshConfigFile(content, format)
	if err != nil {
		return nil, err
	}
	if name != "" {
		saved["name"] = filepath.Base(name)
	}
	c.emitUpdate()
	return saved, nil
}

// ExportRaw 供网页端把导出内容直接作为下载响应返回（不经宿主）。
func (c *Console) ExportRaw(kind string) (string, []byte, error) {
	return c.ctrl.Export(kind)
}

// ImportCrawlerRules 供网页端上传接口使用。
func (c *Console) ImportCrawlerRules(content, name, mode string, dryRun bool) (any, error) {
	return c.crawler.importContent([]byte(content), name, mode, dryRun)
}
