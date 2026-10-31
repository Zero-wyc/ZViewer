package controller

// 控制台核心：desktop/lib/controller.cjs 的 Go 移植。
// 保留原有状态机、错误文案与就绪判定顺序，前端 UI 无需改动即可对接。

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const FrpVersion = "0.71.1"

// frpcPath 返回实际可用的 frpc.exe。
//
// frpc 已改为按需下载的组件（见 components.go）：随包带的旧位置（壳启动时算出来的
// runtime/frpc.exe）优先，其次是从组件库解到运行包根目录的那一份。下载完成后
// 无需重启 GUI 即可直接连接，因为这里是每次用时现算的。
func (c *Controller) frpcPath() string {
	if c.frpc != "" && fileExists(c.frpc) {
		return c.frpc
	}
	if c.root != "" {
		return filepath.Join(c.root, frpSpec.installName())
	}
	return c.frpc
}

type Event struct {
	Time    string `json:"time"`
	At      string `json:"at"`
	Source  string `json:"source"`
	Level   string `json:"level"`
	Message string `json:"message"`
}

type RuntimeFiles struct {
	Backend bool `json:"backend"`
	Cert    bool `json:"cert"`
	Livekit bool `json:"livekit"`
	Web     bool `json:"web"`
}

type Snapshot struct {
	Config     Config       `json:"config"`
	Active     *Config      `json:"active"`
	WebURL     string       `json:"webUrl"`
	Backend    string       `json:"backend"`
	Voice      string       `json:"voice"`
	Frp        string       `json:"frp"`
	Cli        CliSnapshot  `json:"cli"`
	Mesh       MeshStatus   `json:"mesh"`
	Tunnel     TunnelReport `json:"tunnel"`
	Update     UpdateReport `json:"update"`
	Pid        *int         `json:"pid"`
	VoicePid   *int         `json:"voicePid"`
	FrpPid     *int         `json:"frpPid"`
	TokenSaved bool         `json:"tokenSaved"`
	// MeshSecretSaved 只表示组网密钥有密文，界面据此显示「已保存，留空沿用」。
	MeshSecretSaved bool         `json:"meshSecretSaved"`
	Certificate     CertInfo     `json:"certificate"`
	Events          []Event      `json:"events"`
	Root            string       `json:"root"`
	FrpcAvailable   bool         `json:"frpcAvailable"`
	Runtime         RuntimeFiles `json:"runtime"`
	// Components 是可选组件的状态（cloudflared / easytier）：
	// 它们不再随运行包分发，界面按 available 决定显示「下载」还是「已就绪」。
	Components ComponentsReport `json:"components"`
}

type Options struct {
	Root           string
	StateDir       string
	Frpc           string
	CliExecutable  string
	HostExe        string
	Helper         string
	Version        string
	Cipher         Cipher
	OnUpdate       func()
	OnInitialAdmin func(InitialAdmin)
}

type Controller struct {
	root    string
	dir     string
	frpc    string
	hostExe string
	helper  string
	version string

	store *Store
	certs *Certificates
	cli   *CliProxy
	mesh  *MeshManager
	// components 记录可选组件的下载进度（本体不随运行包分发）。
	components componentState

	mu                 sync.RWMutex
	events             []Event
	redactions         []string
	backend            *Proc
	frp                *Proc
	livekit            *Proc
	tunnel             *Proc
	backendState       string
	voiceState         string
	frpState           string
	tunnelState        string
	tunnelURL          string
	tunnelMessage      string
	tunnelErrorCode    string
	tunnelExe          string
	tunnelHealth       string
	tunnelLatencyMs    int64
	tunnelGeneration   uint64
	tunnelCancel       context.CancelFunc
	tunnelDone         chan struct{}
	tunnelLifecycleMu  sync.Mutex
	tunnelRefreshCount int
	active             *Config
	frpRegistered      map[string]bool
	voiceKey           string
	voiceSecret        string

	ipv6Mu sync.Mutex
	ipv6   *IPv6Report
	ipv6At time.Time

	updateMu   sync.Mutex
	update     UpdateReport
	updateAt   time.Time
	updateBusy bool
	updateURL  string
	// updateFallbackURL 是反代不可用时的备用下载地址，为空表示没有备用。
	updateFallbackURL string

	operation   int32
	livekitMu   sync.Mutex
	livekitStop bool
	// livekitWatchStop 是「等语音组件下载完成」的退出信号。
	// 组件随包分发，正常安装里文件一定在；这个等待只兜「用户删了它、又从网页端补回」。
	livekitWatchStop chan struct{}

	onUpdate       func()
	onInitialAdmin func(InitialAdmin)
}

func New(opts Options) (*Controller, error) {
	c := &Controller{
		root:           opts.Root,
		dir:            opts.StateDir,
		frpc:           opts.Frpc,
		hostExe:        opts.HostExe,
		helper:         opts.Helper,
		version:        opts.Version,
		onUpdate:       opts.OnUpdate,
		onInitialAdmin: opts.OnInitialAdmin,
		events:         []Event{},
		backendState:   "stopped", voiceState: "stopped", frpState: "stopped", tunnelState: "stopped",
		frpRegistered: map[string]bool{},
		update:        UpdateReport{State: "idle", Current: opts.Version},
	}
	cipher := opts.Cipher
	if cipher == nil {
		cipher = Dpapi{}
	}
	store, err := NewStore(c.dir, c.root, cipher)
	if err != nil {
		return nil, err
	}
	c.store = store
	key := make([]byte, 12)
	secret := make([]byte, 48)
	_, _ = rand.Read(key)
	_, _ = rand.Read(secret)
	c.voiceKey = hex.EncodeToString(key)
	c.voiceSecret = hex.EncodeToString(secret)
	c.certs = NewCertificates(c.dir, c.log)
	c.cli = NewCliProxy(c.root, opts.CliExecutable, c.hostExe, c.kill, c.verifyCli, c.log, c.emit)
	c.mesh = NewMeshManager(c.root, filepath.Join(c.dir, "mesh"), c.hostExe, c.kill, c.log, c.emit)
	c.log("桌面控制台已就绪；配置将在下次启动自动读取", "console", "INFO")
	return c, nil
}

func (c *Controller) Store() *Store               { return c.store }
func (c *Controller) Certificates() *Certificates { return c.certs }
func (c *Controller) Root() string                { return c.root }
func (c *Controller) Busy() bool                  { return atomic.LoadInt32(&c.operation) == 1 }

// Log 供宿主层记录捕获到的异常。
func (c *Controller) Log(message, source, level string) { c.log(message, source, level) }

func (c *Controller) emit() {
	if c.onUpdate != nil {
		c.onUpdate()
	}
}

var ansiPattern = regexp.MustCompile("\x1b\\[[0-9;]*m")
var secretPattern = regexp.MustCompile(`(?i)((?:token|secret|password|密码|authorization|cookie|SESSDATA|bili_jct)\s*[:=：]\s*)([^\r\n]+)`)

func (c *Controller) sanitize(text string) string {
	message := ansiPattern.ReplaceAllString(text, "")
	c.mu.RLock()
	redactions := append([]string(nil), c.redactions...)
	c.mu.RUnlock()
	for _, secret := range redactions {
		if len([]rune(secret)) >= 4 {
			message = strings.ReplaceAll(message, secret, "[已隐藏]")
		}
	}
	message = secretPattern.ReplaceAllString(message, "$1[已隐藏]")
	runes := []rune(message)
	if len(runes) > 4000 {
		message = string(runes[:4000])
	}
	return message
}

func (c *Controller) log(message, source, level string) {
	text := c.sanitize(message)
	if strings.TrimSpace(text) == "" {
		return
	}
	now := time.Now()
	event := Event{
		Time:   now.Format("15:04:05"),
		At:     now.UTC().Format("2006-01-02T15:04:05.000Z"),
		Source: source, Level: level, Message: text,
	}
	c.mu.Lock()
	c.events = append([]Event{event}, c.events...)
	if len(c.events) > 500 {
		c.events = c.events[:500]
	}
	c.mu.Unlock()
	c.appendLogFile(event)
	c.emit()
}

func (c *Controller) appendLogFile(event Event) {
	logFile := filepath.Join(c.dir, "logs", "desktop.log")
	if err := os.MkdirAll(filepath.Dir(logFile), 0o700); err != nil {
		return
	}
	if info, err := os.Stat(logFile); err == nil && info.Size() > 2*1024*1024 {
		_ = os.Rename(logFile, logFile+".previous")
	}
	raw, err := json.Marshal(event)
	if err != nil {
		return
	}
	file, err := os.OpenFile(logFile, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer file.Close()
	_, _ = file.Write(append(raw, '\n'))
}

func (c *Controller) Snapshot() Snapshot {
	c.mu.RLock()
	events := make([]Event, len(c.events))
	copy(events, c.events)
	backend, voice, frp := c.backendState, c.voiceState, c.frpState
	var active *Config
	if c.active != nil {
		clone := c.active.Clone()
		active = &clone
	}
	livekid := processPid(c.livekit)
	backendPid := processPid(c.backend)
	frpPid := processPid(c.frp)
	c.mu.RUnlock()

	config := c.store.Value
	// 公共中继候选来自内置列表，随快照下发，界面不用再单独请求一次。
	mesh := c.mesh.Snapshot()
	mesh.PublicPeers = MeshPublicPeers()
	out := Snapshot{
		Config: config, Active: active,
		WebURL: c.WebURL(), Backend: backend, Voice: voice, Frp: frp,
		Cli:  c.cli.Snapshot(),
		Mesh: mesh,
		Pid:  backendPid, VoicePid: livekid, FrpPid: frpPid,
		Tunnel:          c.tunnelReport(),
		Update:          c.UpdateReport(),
		Components:      c.componentReport(),
		TokenSaved:      c.store.HasToken(),
		MeshSecretSaved: c.store.HasMeshSecret(),
		Certificate:     c.certs.Inspect(),
		Events:          events,
		Root:            c.root,
		FrpcAvailable:   fileExists(c.frpcPath()),
		Runtime: RuntimeFiles{
			Backend: fileExists(filepath.Join(c.root, "zviewer-backend.exe")),
			Cert:    true,
			Livekit: fileExists(filepath.Join(c.root, "livekit-server.exe")),
			Web:     fileExists(filepath.Join(c.root, "frontend", "dist", "index.html")),
		},
	}
	return out
}

func processPid(proc *Proc) *int {
	if proc == nil || proc.Exited() {
		return nil
	}
	pid := proc.Pid()
	return &pid
}

func (c *Controller) WebURL() string {
	c.mu.RLock()
	active := c.active
	c.mu.RUnlock()
	config := c.store.Value
	if active != nil {
		config = *active
	}
	scheme := "http"
	if config.Https {
		scheme = "https"
	}
	return fmt.Sprintf("%s://localhost:%d/", scheme, config.Port)
}

func (c *Controller) ManagementURL() string { return c.WebURL() + "admin" }

// Save 保存前端提交的配置补丁。
func (c *Controller) Save(patch map[string]any, token *string) (Config, error) {
	config, err := c.store.Save(patch, token)
	if err != nil {
		return config, err
	}
	c.log("用户配置已保存，服务参数在下次启动或重启后生效", "console", "INFO")
	return config, nil
}

func (c *Controller) exclusive(task func() (any, error)) (any, error) {
	if !atomic.CompareAndSwapInt32(&c.operation, 0, 1) {
		return nil, errors.New("正在执行另一项服务操作，请稍后")
	}
	defer func() {
		atomic.StoreInt32(&c.operation, 0)
		c.emit()
	}()
	result, err := task()
	if err != nil {
		c.mu.RLock()
		starting := c.backendState == "starting"
		c.mu.RUnlock()
		if starting {
			if cleanup := c.stopBackend(); cleanup != nil {
				c.log(cleanup.Error(), "backend", "ERROR")
			}
			c.setBackendState("error")
		}
		return nil, err
	}
	return result, nil
}

func (c *Controller) setBackendState(state string) {
	c.mu.Lock()
	c.backendState = state
	c.mu.Unlock()
}

func (c *Controller) setVoiceState(state string) {
	c.mu.Lock()
	c.voiceState = state
	c.mu.Unlock()
}

func (c *Controller) setFrpState(state string) {
	c.mu.Lock()
	c.frpState = state
	c.mu.Unlock()
}

func (c *Controller) environment() ([]string, error) {
	values := EnvValues(c.root)
	envFile := filepath.Join(c.root, ".env")
	if !fileExists(envFile) {
		jwt1 := make([]byte, 48)
		jwt2 := make([]byte, 48)
		_, _ = rand.Read(jwt1)
		_, _ = rand.Read(jwt2)
		content := fmt.Sprintf("# Generated locally by ZViewer Desktop\nPORT=3333\nHOST=127.0.0.1\nNODE_ENV=production\nJWT_ACCESS_SECRET=%s\nJWT_REFRESH_SECRET=%s\n",
			hex.EncodeToString(jwt1), hex.EncodeToString(jwt2))
		if err := Atomic(envFile, content); err != nil {
			return nil, err
		}
		values = EnvValues(c.root)
	}
	config := c.store.Value
	paths := c.certs.Paths()

	redactions := []string{c.voiceKey, c.voiceSecret}
	for key, value := range values {
		if regexp.MustCompile(`SECRET|TOKEN|PASSWORD|API_KEY`).MatchString(key) && value != "" {
			redactions = append(redactions, value)
		}
	}
	c.mu.Lock()
	c.redactions = redactions
	c.mu.Unlock()

	env := map[string]string{}
	for _, entry := range os.Environ() {
		if index := strings.Index(entry, "="); index > 0 {
			env[entry[:index]] = entry[index+1:]
		}
	}
	for key, value := range values {
		env[key] = value
	}
	env["NODE_ENV"] = "production"
	env["PORT"] = strconv.Itoa(config.Port)
	env["HOST"] = config.BindHost
	env["HTTPS"] = strconv.FormatBool(config.Https)
	env["RTMP_PORT"] = strconv.Itoa(config.RtmpPort)
	env["HTTP_FLV_PORT"] = strconv.Itoa(config.FlvPort)
	// 标记后端运行在桌面 GUI 壳内：网页管理端的「版本更新」会因此禁用，
	// 整包版本由 GUI 自己的更新链路维护（详见 backend services/desktop-runtime.ts）
	env["ZVIEWER_DESKTOP"] = "1"
	env["LIVEKIT_EXTERNAL"] = "1"
	// 二进制由壳拉起，但下载走网页端：后端需要这个开关才会在 External 下也接受下载请求。
	env["LIVEKIT_COMPONENT_DOWNLOAD"] = "1"
	env["LIVEKIT_API_HOST"] = fmt.Sprintf("http://127.0.0.1:%d", config.LivekitPort)
	env["LIVEKIT_API_KEY"] = c.voiceKey
	env["LIVEKIT_API_SECRET"] = c.voiceSecret
	env["LIVEKIT_URL"] = ""
	if config.Https {
		env["SSL_CERT_PATH"] = paths.Cert
		env["SSL_KEY_PATH"] = paths.Key
	}
	if config.BindHost == "127.0.0.1" && values["LIVEKIT_BIND"] == "" {
		env["LIVEKIT_BIND"] = "127.0.0.1"
		if _, exists := env["LIVEKIT_NODE_IP"]; !exists || values["LIVEKIT_NODE_IP"] == "" {
			env["LIVEKIT_NODE_IP"] = "127.0.0.1"
		}
		env["LIVEKIT_RTC_USE_EXTERNAL_IP"] = "false"
	}
	if config.Frp.AdvertiseIP != "" {
		env["LIVEKIT_NODE_IP"] = config.Frp.AdvertiseIP
		env["LIVEKIT_RTC_USE_EXTERNAL_IP"] = "false"
	}
	out := make([]string, 0, len(env))
	for key, value := range env {
		out = append(out, key+"="+value)
	}
	return out, nil
}

func (c *Controller) startLivekit(env []string) error {
	config := c.store.Value
	exe := filepath.Join(c.root, "livekit-server.exe")
	if !fileExists(exe) {
		// 组件随包分发，正常安装走不到这里。只有用户删了 livekit-server.exe 才缺文件：
		// 先把主服务起起来，等网页端把组件补下载下来后再由 watchLivekit 拉起，
		// 不能因为它缺失就让整个服务起不来。
		c.setVoiceState("missing")
		c.watchLivekit(env)
		return nil
	}
	envMap := map[string]string{}
	for _, entry := range env {
		if index := strings.Index(entry, "="); index > 0 {
			envMap[entry[:index]] = entry[index+1:]
		}
	}
	nodeIP := config.Frp.AdvertiseIP
	if nodeIP == "" {
		nodeIP = envMap["LIVEKIT_NODE_IP"]
	}
	rtc := map[string]any{
		"udp_port":                  config.Port,
		"tcp_port":                  config.LivekitTcpPort,
		"enable_loopback_candidate": true,
		"use_external_ip":           nodeIP == "" && envMap["LIVEKIT_RTC_USE_EXTERNAL_IP"] == "true",
	}
	if config.BindHost == "127.0.0.1" && config.Frp.AdvertiseIP == "" {
		rtc["ips"] = map[string]any{"includes": []string{"127.0.0.0/8", "::1/128"}}
	}
	livekitConfig := map[string]any{
		"port":           config.LivekitPort,
		"bind_addresses": []string{config.BindHost},
		"rtc":            rtc,
		"keys":           map[string]string{c.voiceKey: c.voiceSecret},
		"logging":        map[string]any{"level": "info"},
	}
	payload, err := json.Marshal(livekitConfig)
	if err != nil {
		return err
	}
	childEnv := append([]string(nil), env...)
	childEnv = append(childEnv, "LIVEKIT_CONFIG="+string(payload), "NODE_IP="+nodeIP)
	proc, err := startProcess(c.hostExe, exe, nil, childEnv, c.root, func(line string) {
		c.log(line, "voice", classifyLevel(line))
	})
	if err != nil {
		return err
	}
	c.mu.Lock()
	c.livekit = proc
	c.livekitStop = false
	c.mu.Unlock()
	go func() {
		code := proc.Wait()
		c.mu.Lock()
		if c.livekit != proc {
			c.mu.Unlock()
			return
		}
		intentional := c.livekitStop
		c.livekit = nil
		failed := !intentional
		if failed {
			c.voiceState = "error"
		} else {
			c.voiceState = "stopped"
		}
		c.mu.Unlock()
		level := "INFO"
		if failed {
			level = "ERROR"
		}
		c.log(fmt.Sprintf("LiveKit 进程已退出（%d）", code), "voice", level)
	}()

	deadline := time.Now().Add(20 * time.Second)
	verification := ""
	for time.Now().Before(deadline) {
		c.mu.RLock()
		current := c.livekit
		c.mu.RUnlock()
		if current != proc || proc.Exited() {
			break
		}
		if livekitReady(config.LivekitPort) {
			if isWindows() {
				// WMI 索引有延迟：进程树与套接字都要可见，失败就重试到截止时间。
				inspected, err := c.inspect(proc.Pid(), config.LivekitPort, c.hostExe, config.Port, config.LivekitTcpPort)
				if err == nil {
					switch {
					case !inspected.owns(inspected.Owner):
						err = errors.New("LiveKit 信令端口不属于 GUI 启动的进程树")
					case !inspected.owns(inspected.UDPOwner) || !inspected.owns(inspected.RTCOwner):
						err = errors.New("LiveKit 语音 UDP / TCP 端口未由受管进程监听")
					case !containsString(inspected.UDPAddresses, "127.0.0.1") && !containsString(inspected.UDPAddresses, "0.0.0.0"):
						err = errors.New("LiveKit 未监听 UDP 回环地址，本机访问与 FRP 转发不可用")
					}
				}
				if err != nil {
					verification = err.Error()
					time.Sleep(400 * time.Millisecond)
					continue
				}
			}
			c.setVoiceState("running")
			c.log(fmt.Sprintf("LiveKit 已就绪：信令 TCP %d，媒体 UDP %d，RTC TCP %d",
				config.LivekitPort, config.Port, config.LivekitTcpPort), "voice", "INFO")
			return nil
		}
		time.Sleep(250 * time.Millisecond)
	}
	if verification != "" {
		return fmt.Errorf("LiveKit 未通过就绪检查（%s），请检查端口或查看运行日志", verification)
	}
	return errors.New("LiveKit 未通过就绪检查，请检查端口或查看运行日志")
}

// watchLivekit 在语音组件缺失时等它出现，然后拉起 livekit-server。
//
// 组件随包分发（runtime/livekit-server.exe），这里只兜「文件被删掉」的情况：
// 用户在网页端房间右下角点「下载语音聊天组件」，后端把 livekit-server.exe 写回
// runtime/。每 3 秒看一眼，出现就启动，不用重开 GUI，也不需要壳里做下载入口。
func (c *Controller) watchLivekit(env []string) {
	c.mu.Lock()
	if c.livekitWatchStop != nil {
		c.mu.Unlock()
		return
	}
	stop := make(chan struct{})
	c.livekitWatchStop = stop
	c.mu.Unlock()

	go func() {
		ticker := time.NewTicker(3 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				if !fileExists(filepath.Join(c.root, "livekit-server.exe")) {
					continue
				}
				c.mu.Lock()
				if c.livekitWatchStop != stop {
					c.mu.Unlock()
					return
				}
				c.livekitWatchStop = nil
				c.mu.Unlock()
				c.log("检测到语音组件已下载，正在启动 LiveKit", "voice", "INFO")
				if err := c.startLivekit(env); err != nil {
					c.log(err.Error(), "voice", "ERROR")
					c.setVoiceState("error")
				}
				return
			}
		}
	}()
}

// stopLivekitWatch 结束等待（服务停止或显式停语音时调用）。
func (c *Controller) stopLivekitWatch() {
	c.mu.Lock()
	stop := c.livekitWatchStop
	c.livekitWatchStop = nil
	c.mu.Unlock()
	if stop != nil {
		close(stop)
	}
}

func containsString(list []string, value string) bool {
	for _, item := range list {
		if item == value {
			return true
		}
	}
	return false
}

func (c *Controller) stopLivekit() error {
	c.livekitMu.Lock()
	defer c.livekitMu.Unlock()
	c.stopLivekitWatch()
	c.mu.Lock()
	proc := c.livekit
	if proc == nil {
		c.voiceState = "stopped"
		c.mu.Unlock()
		return nil
	}
	c.voiceState = "stopping"
	c.livekitStop = true
	c.mu.Unlock()
	target := c.hostExe
	if !isWindows() {
		target = filepath.Join(c.root, "livekit-server.exe")
	}
	err := c.kill(proc, target)
	c.setVoiceState("stopped")
	return err
}

func (c *Controller) startBackend() (any, error) {
	c.mu.RLock()
	running := c.backend != nil
	hasLivekit := c.livekit != nil
	c.mu.RUnlock()
	if running {
		return c.Snapshot(), nil
	}
	if hasLivekit {
		if err := c.stopLivekit(); err != nil {
			return nil, err
		}
	}
	config := c.store.Value
	exe := filepath.Join(c.root, "zviewer-backend.exe")
	if !fileExists(exe) || !fileExists(filepath.Join(c.root, "frontend", "dist", "index.html")) {
		return nil, errors.New("缺少后端或网页运行文件")
	}
	for _, port := range []int{config.Port, config.RtmpPort, config.FlvPort, config.LivekitPort, config.LivekitTcpPort} {
		if err := portAvailable(port, config.BindHost); err != nil {
			return nil, err
		}
	}
	if err := udpAvailable(config.Port, config.BindHost); err != nil {
		return nil, err
	}
	if config.Https {
		if _, err := c.certs.Ensure(config.Domain, config.LanIP); err != nil {
			return nil, err
		}
	}
	c.setBackendState("starting")
	c.setVoiceState("starting")
	c.emit()
	if isWindows() && !fileExists(c.hostExe) {
		return nil, errors.New("缺少进程监管组件 ZViewer.ProcessHost.exe")
	}
	env, err := c.environment()
	if err != nil {
		return nil, err
	}
	if err := c.ensureDatabase(exe, env); err != nil {
		return nil, err
	}
	if err := c.startLivekit(env); err != nil {
		return nil, err
	}
	proc, err := startProcess(c.hostExe, exe, nil, env, c.root, func(line string) {
		c.log(line, "backend", classifyLevel(line))
	})
	if err != nil {
		return nil, err
	}
	c.mu.Lock()
	c.backend = proc
	active := config.Clone()
	c.active = &active
	c.mu.Unlock()

	go func() {
		code := proc.Wait()
		c.mu.Lock()
		if c.backend != proc {
			c.mu.Unlock()
			return
		}
		intentional := c.backendState == "stopping"
		c.backend = nil
		c.active = nil
		if intentional {
			c.backendState = "stopped"
		} else {
			c.backendState = "error"
		}
		c.mu.Unlock()
		level := "INFO"
		if !intentional {
			level = "ERROR"
		}
		c.log(fmt.Sprintf("后端进程已退出（%d）", code), "backend", level)
		c.stopFrpSafely()
		if !intentional {
			c.stopTunnelForOriginFailure()
			c.mu.RLock()
			livekitRunning := c.livekit != nil
			c.mu.RUnlock()
			if livekitRunning {
				if err := c.stopLivekit(); err != nil {
					c.log(err.Error(), "voice", "ERROR")
				}
			}
			if _, err := c.cli.Stop(); err != nil {
				c.log(err.Error(), "cli", "ERROR")
			}
		}
		c.emit()
	}()

	deadline := time.Now().Add(45 * time.Second)
	verification := ""
	for time.Now().Before(deadline) {
		c.mu.RLock()
		current := c.backend
		c.mu.RUnlock()
		if current != proc || proc.Exited() {
			return nil, fmt.Errorf("后端启动后提前退出（退出码 %d），请查看运行日志", proc.Wait())
		}
		probeCA := ""
		if config.Https {
			probeCA = c.certs.Paths().CA
		}
		if probeBackend(config.Port, config.Https, probeCA) {
			if isWindows() {
				// 后端可能先回 /health 再由 WMI 补上进程树，归属校验在窗口内重试。
				inspected, err := c.inspect(proc.Pid(), config.Port, c.hostExe, 0, 0)
				if err == nil && !inspected.owns(inspected.Owner) {
					err = errors.New("监听端口不属于 GUI 启动的进程树")
				}
				if err != nil {
					verification = err.Error()
					time.Sleep(300 * time.Millisecond)
					continue
				}
			}
			c.setBackendState("running")
			scheme := "http"
			if config.Https {
				scheme = "https"
			}
			c.log(fmt.Sprintf("服务已就绪：%s://localhost:%d，PID %d", scheme, config.Port, proc.Pid()), "backend", "INFO")
			if config.Cli.AutoStart {
				if _, err := c.cli.Start(config.Cli.Port); err != nil {
					c.log("高画质代理启动失败："+err.Error(), "cli", "ERROR")
				}
			}
			return c.Snapshot(), nil
		}
		time.Sleep(350 * time.Millisecond)
	}
	c.mu.RLock()
	stillRunning := c.backend == proc
	c.mu.RUnlock()
	if stillRunning {
		_ = c.stopBackend()
	}
	c.setBackendState("error")
	if verification != "" {
		return nil, fmt.Errorf("后端未在 45 秒内通过健康检查（%s），请查看运行日志", verification)
	}
	return nil, errors.New("后端未在 45 秒内通过健康检查，请查看运行日志")
}

func (c *Controller) stopBackend() error {
	if err := c.stopFrp(); err != nil {
		c.log(err.Error(), "frp", "ERROR")
	}
	if err := c.stopTunnel(); err != nil {
		c.log(err.Error(), "tunnel", "ERROR")
	}
	if _, err := c.cli.Stop(); err != nil {
		c.log(err.Error(), "cli", "ERROR")
	}
	c.mu.RLock()
	proc := c.backend
	c.mu.RUnlock()
	if proc == nil {
		if err := c.stopLivekit(); err != nil {
			c.log(err.Error(), "voice", "ERROR")
		}
		c.setBackendState("stopped")
		return nil
	}
	c.setBackendState("stopping")
	c.emit()
	target := c.hostExe
	if !isWindows() {
		target = filepath.Join(c.root, "zviewer-backend.exe")
	}
	if err := c.kill(proc, target); err != nil {
		return err
	}
	if err := c.stopLivekit(); err != nil {
		c.log(err.Error(), "voice", "ERROR")
	}
	c.setBackendState("stopped")
	c.setVoiceState("stopped")
	c.log("已停止本控制台启动的后端及其伴生进程", "backend", "INFO")
	return nil
}

func (c *Controller) Start() (any, error) {
	return c.exclusive(func() (any, error) { return c.startBackend() })
}

func (c *Controller) Stop() (any, error) {
	return c.exclusive(func() (any, error) {
		if err := c.stopBackend(); err != nil {
			return nil, err
		}
		return c.Snapshot(), nil
	})
}

func (c *Controller) Restart() (any, error) {
	return c.exclusive(func() (any, error) {
		if err := c.stopBackend(); err != nil {
			return nil, err
		}
		return c.startBackend()
	})
}

func (c *Controller) EnableHTTPS(domain, ip string) (any, error) {
	if domain == "" {
		domain = "localhost"
	}
	return c.exclusive(func() (any, error) {
		c.mu.RLock()
		hasBackend := c.backend != nil
		state := c.backendState
		c.mu.RUnlock()
		if hasBackend && state != "running" {
			return nil, errors.New("请等待当前服务操作完成")
		}
		cert, err := c.certs.Ensure(domain, ip)
		if err != nil {
			return nil, err
		}
		// IPv6 只进证书 SAN，不覆盖局域网 IPv4 字段（hosts 导出与 FRP 提示都按 IPv4 展示）。
		patch := map[string]any{"https": true, "domain": domain}
		if !strings.Contains(ip, ":") {
			patch["lanIp"] = ip
		}
		if _, err := c.store.Save(patch, nil); err != nil {
			return nil, err
		}
		if hasBackend {
			if err := c.stopBackend(); err != nil {
				return nil, err
			}
		}
		if _, err := c.startBackend(); err != nil {
			return nil, err
		}
		return cert, nil
	})
}

// StartHTTP 改为 HTTP 启动并按新协议重启服务。
//
// 证书与信任都保留，只是不再以 HTTPS 提供页面；随时可以再点“签发并启用
// HTTPS”切回去（重复签发会复用同一本机 CA，已装的信任仍然有效）。
func (c *Controller) StartHTTP() (any, error) {
	return c.exclusive(func() (any, error) {
		c.mu.RLock()
		hasBackend := c.backend != nil
		state := c.backendState
		c.mu.RUnlock()
		if hasBackend && state != "running" {
			return nil, errors.New("请等待当前服务操作完成")
		}
		if _, err := c.store.Save(map[string]any{"https": false}, nil); err != nil {
			return nil, err
		}
		if hasBackend {
			if err := c.stopBackend(); err != nil {
				return nil, err
			}
		}
		if _, err := c.startBackend(); err != nil {
			return nil, err
		}
		c.log("已改为 HTTP 启动，证书保留，可随时切回 HTTPS", "cert", "INFO")
		return c.Snapshot(), nil
	})
}

// FrpConfig 生成 frpc.toml；桌面版只做客户端，服务端 frps 由用户自行在 VPS 上部署。
func (c *Controller) FrpConfig() string {
	config := c.store.Value
	f := config.Frp
	token := "auth.method = \"token\"\nauth.token = \"{{ .Envs.FRP_TOKEN }}\""
	proxy := func(name, kind string, local, remote int) string {
		return fmt.Sprintf("\n[[proxies]]\nname = \"zviewer-%s\"\ntype = \"%s\"\nlocalIP = \"127.0.0.1\"\nlocalPort = %d\nremotePort = %d\n",
			name, kind, local, remote)
	}
	host := f.Host
	if host == "" {
		host = "YOUR_VPS_IP"
	}
	quoted, _ := json.Marshal(host)
	text := fmt.Sprintf("serverAddr = %s\nserverPort = %d\n%s\ntransport.tls.enable = true\n", quoted, f.Port, token)
	text += proxy("backend", "tcp", config.Port, f.WebPort)
	if f.Voice {
		text += proxy("voice", "udp", config.Port, f.VoicePort)
	}
	if f.Rtmp {
		text += proxy("rtmp", "tcp", config.RtmpPort, f.RtmpPort)
	}
	if f.Tcp {
		text += proxy("voice-tcp", "tcp", config.LivekitTcpPort, f.TcpPort)
	}
	return text
}

func (c *Controller) StartFrp() (any, error) {
	return c.exclusive(func() (any, error) {
		c.mu.RLock()
		frpProc := c.frp
		frpState := c.frpState
		backendState := c.backendState
		c.mu.RUnlock()
		if frpProc != nil && frpState != "error" {
			return c.Snapshot(), nil
		}
		if frpProc != nil {
			if err := c.stopFrp(); err != nil {
				return nil, err
			}
		}
		if backendState != "running" {
			return nil, errors.New("请先启动本地服务")
		}
		config, err := Validate(c.store.Value.Map())
		if err != nil {
			return nil, err
		}
		c.mu.RLock()
		active := c.active
		c.mu.RUnlock()
		if active == nil {
			return nil, errors.New("请先启动本地服务")
		}
		// 自定义配置里可能映射任意本机端口，无法与运行中的服务端口比对，跳过这项检查。
		custom := config.Frp.Mode == "config"
		if !custom && (active.Port != config.Port || active.RtmpPort != config.RtmpPort ||
			active.LivekitPort != config.LivekitPort || active.LivekitTcpPort != config.LivekitTcpPort ||
			active.Frp.AdvertiseIP != config.Frp.AdvertiseIP) {
			return nil, errors.New("服务端口或语音公布地址已修改，请先重启本地服务再连接 FRP")
		}
		if !custom && config.Frp.Host == "" {
			return nil, errors.New("请先保存 VPS 地址")
		}
		if !fileExists(c.frpcPath()) {
			return nil, errors.New("frpc 组件尚未下载，请先点「下载 frpc 组件」")
		}
		file := filepath.Join(c.dir, "frp", "frpc.toml")
		content := ""
		expected := 0
		if custom {
			file = c.FrpCustomPath()
			raw, readErr := os.ReadFile(file)
			if readErr != nil {
				return nil, errors.New("请先粘贴或导入 frpc 配置文件")
			}
			content = string(raw)
			if strings.TrimSpace(content) == "" {
				return nil, errors.New("frpc 配置文件内容为空，请粘贴或导入后再连接")
			}
			if len(content) > MaxFrpConfigBytes {
				return nil, errors.New("配置文件不能超过 256 KB")
			}
			expected = countFrpProxies(content, c.FrpConfigFormat())
			if expected < 1 {
				expected = 1
			}
		}
		token, err := c.store.Token()
		if err != nil {
			return nil, err
		}
		// 表单模式固定用环境变量注入密钥；自定义配置只有在引用占位符时才必须填。
		if token == "" && (custom && strings.Contains(content, "FRP_TOKEN") || !custom) {
			return nil, errors.New("请填写并保存 FRP 密钥")
		}
		if token != "" {
			c.mu.Lock()
			c.redactions = append(c.redactions, token)
			c.mu.Unlock()
		}
		if err := c.checkFrpVersion(); err != nil {
			return nil, err
		}
		if !custom {
			if err := Atomic(file, c.FrpConfig()); err != nil {
				return nil, err
			}
			expected = 1
			if config.Frp.Voice {
				expected++
			}
			if config.Frp.Rtmp {
				expected++
			}
			if config.Frp.Tcp {
				expected++
			}
		}
		env := append([]string(nil), os.Environ()...)
		if token != "" {
			env = append(env, "FRP_TOKEN="+token)
		}
		verify := exec.Command(c.frpcPath(), "verify", "-c", file)
		verify.Env = env
		hideWindow(verify)
		if out, err := verify.CombinedOutput(); err != nil {
			return nil, fmt.Errorf("FRP 配置校验失败：%s", strings.TrimSpace(string(out)))
		}
		c.setFrpState("connecting")
		c.mu.Lock()
		c.frpRegistered = map[string]bool{}
		c.mu.Unlock()
		proc, err := startProcess("", c.frpcPath(), []string{"-c", file}, env, filepath.Dir(file), func(line string) {
			c.log(line, "frp", classifyLevel(line))
			c.handleFrpLine(line, expected)
		})
		if err != nil {
			c.setFrpState("error")
			return nil, err
		}
		c.mu.Lock()
		c.frp = proc
		c.mu.Unlock()
		go func() {
			code := proc.Wait()
			c.mu.Lock()
			if c.frp != proc {
				c.mu.Unlock()
				return
			}
			c.frp = nil
			if c.frpState == "stopping" {
				c.frpState = "stopped"
			} else {
				c.frpState = "error"
			}
			failed := c.frpState == "error"
			c.mu.Unlock()
			level := "INFO"
			if failed {
				level = "ERROR"
			}
			c.log(fmt.Sprintf("FRP 已退出（%d）", code), "frp", level)
			c.emit()
		}()
		if custom {
			c.log("FRP 配置校验通过，正在按自定义配置连接", "frp", "INFO")
		} else {
			c.log("FRP 配置校验通过，正在连接自建 VPS", "frp", "INFO")
		}
		return c.Snapshot(), nil
	})
}

// 代理名不一定带 zviewer- 前缀（自定义配置来自服务商），只认紧贴
// “start proxy success”的那个方括号，前面的日志级别标记不会被误匹配。
var frpSuccess = regexp.MustCompile(`\[([^\[\]]+)\]\s+start proxy success`)

func (c *Controller) handleFrpLine(line string, expected int) {
	if match := frpSuccess.FindStringSubmatch(line); match != nil {
		c.mu.Lock()
		c.frpRegistered[match[1]] = true
		size := len(c.frpRegistered)
		if size >= expected {
			c.frpState = "registered"
		}
		c.mu.Unlock()
		if size >= expected {
			c.log("FRP 代理已注册；外网访问仍需实际验收", "frp", "INFO")
		}
	}
	lower := strings.ToLower(line)
	if strings.Contains(lower, "login to server failed") || strings.Contains(lower, "connect to server error") || strings.Contains(lower, "start error") {
		c.setFrpState("error")
	}
	c.emit()
}

func (c *Controller) checkFrpVersion() error {
	cmd := exec.Command(c.frpcPath(), "--version")
	hideWindow(cmd)
	out, err := cmd.Output()
	if err != nil {
		return fmt.Errorf("无法读取 frpc 版本：%w", err)
	}
	version := strings.TrimSpace(string(out))
	version = strings.TrimPrefix(version, "v")
	if version != FrpVersion {
		return fmt.Errorf("需要 FRP %s", FrpVersion)
	}
	return nil
}

func (c *Controller) stopFrp() error {
	c.mu.RLock()
	proc := c.frp
	c.mu.RUnlock()
	if proc == nil {
		c.setFrpState("stopped")
		return nil
	}
	c.setFrpState("stopping")
	if err := c.kill(proc, c.frpcPath()); err != nil {
		c.setFrpState("error")
		return err
	}
	c.setFrpState("stopped")
	return nil
}

func (c *Controller) stopFrpSafely() {
	if err := c.stopFrp(); err != nil {
		c.log(err.Error(), "frp", "ERROR")
	}
}

func (c *Controller) StopFrp() error {
	err := c.stopFrp()
	c.emit()
	return err
}

func (c *Controller) StartCli() (any, error) {
	return c.exclusive(func() (any, error) {
		port := c.store.Value.Cli.Port
		if _, err := c.cli.Start(port); err != nil {
			return nil, err
		}
		return c.Snapshot(), nil
	})
}

func (c *Controller) StopCli() (any, error) {
	return c.exclusive(func() (any, error) {
		if _, err := c.cli.Stop(); err != nil {
			return nil, err
		}
		return c.Snapshot(), nil
	})
}

func (c *Controller) SaveCli(patch map[string]any) (Config, error) {
	user := c.store.Value.Cli.User
	if raw, exists := patch["user"]; exists {
		if text, ok := raw.(string); ok {
			user = text
		}
	}
	cli := map[string]any{"port": patch["port"], "autoStart": patch["autoStart"], "user": user}
	return c.Save(map[string]any{"cli": cli}, nil)
}

// CliSettingsURL 启动代理并返回内嵌设置页地址。
func (c *Controller) CliSettingsURL() (string, error) {
	if _, err := c.StartCli(); err != nil {
		return "", err
	}
	return c.cli.URL(c.WebURL(), c.store.Value.Cli.User, true)
}

func (c *Controller) verifyCli(pid, port int) error {
	inspected, err := c.inspect(pid, port, c.hostExe, 0, 0)
	if err != nil {
		return err
	}
	if !inspected.owns(inspected.Owner) {
		return errors.New("CLI 监听端口不属于 GUI 启动的进程树")
	}
	return nil
}

func (c *Controller) Shutdown() error {
	// 组网节点独立于主服务，单独收一次。
	if _, err := c.mesh.Stop(); err != nil {
		c.log("停止EasyTier 虚拟组网失败："+err.Error(), "mesh", "WARN")
	}
	// stopBackend 会一并回收 FRP、隧道与 CLI 进程。
	_, err := c.Stop()
	return err
}

// Export 生成导出文件内容；返回文件名与字节内容。
func (c *Controller) Export(kind string) (string, []byte, error) {
	config := c.store.Value
	switch kind {
	case "frpc":
		// 自定义配置导出的就是用户手上的那份文件，不做任何重写。
		if config.Frp.Mode == "config" {
			path := c.FrpCustomPath()
			raw, err := os.ReadFile(path)
			if err != nil {
				return "", nil, errors.New("尚未保存 FRP 配置文件")
			}
			return filepath.Base(path), raw, nil
		}
		return "frpc.toml", []byte(c.FrpConfig()), nil
	case "logs":
		c.mu.RLock()
		events := make([]Event, len(c.events))
		copy(events, c.events)
		c.mu.RUnlock()
		var builder strings.Builder
		for index := len(events) - 1; index >= 0; index-- {
			event := events[index]
			fmt.Fprintf(&builder, "%s %s [%s] %s\n", event.At, event.Level, event.Source, event.Message)
		}
		return "zviewer-desktop.log", []byte(builder.String()), nil
	case "ca":
		raw, err := os.ReadFile(c.certs.Paths().CA)
		if err != nil {
			return "", nil, errors.New("尚未签发本地 CA")
		}
		return "ZViewer-Local-CA.crt", raw, nil
	case "hosts":
		text := fmt.Sprintf("%s %s\n\n在访问设备 hosts 或内网 DNS 配置以上记录。修改 hosts 需要管理员权限。\nhttps://%s:%d/admin\n其他设备仅安装公开 CA 证书，禁止分享 CA 私钥。\n",
			config.LanIP, config.Domain, config.Domain, config.Port)
		return "zviewer-lan-domain.txt", []byte(text), nil
	}
	return "", nil, errors.New("不支持的导出类型")
}
