// Package livekit 负责把 livekit-server 作为**伴生进程**拉起。
//
// 为什么后端要管这个进程：LiveKit 是独立 Go 二进制（SFU），语音聊天的媒体面
// 全在它手里，而 ZViewer 只签 token / 调 Twirp。单文件部署（源码运行、Docker
// 单容器、桌面壳）没有外部编排，必须由后端自己把它拉起来，否则语音直接不可用。
//
// 与 Node 版 `services/livekit-server.manager.ts`（499 行）行为对齐：
//
//   - `LIVEKIT_EXTERNAL=1` 时完全不碰（外置 LiveKit 交给部署方）；
//   - 默认注入 API Key/Secret 与 API Host（否则 /api/voice/token 直接 503）；
//   - 默认开启 STUN 外部 IP 发现 + 内外网双候选（NAT / 多网卡场景必需）；
//   - 端口裁决：HTTP 3336、UDP 3333、ICE/TCP 3337、TURN/TLS 3338；
//   - 二进制查找：exe 同目录（生产）→ dev-bin（开发）；开发构建缺失时联网下载；
//   - 启动后等 HTTP 端口就绪（15s），`--bind ::` 失败回退 `0.0.0.0`；
//   - 启动成功且本机全是私网地址、又没配 NODE_IP/TURN 时，打一条外网可达性警告。
package livekit

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// 默认值与 Node 版逐字一致（端口编排见 package 注释）。
const (
	defaultAPIKey    = "devkey"
	defaultAPISecret = "zviewer-dev-secret"
	defaultHTTPPort  = 3336
	defaultUDPPort   = 3333
	defaultTCPPort   = 3337
	defaultTURNPort  = 3338
	defaultBind      = "::"

	readyTimeout = 15 * time.Second
	probeEvery   = 300 * time.Millisecond

	// BinaryVersion 是开发模式自动下载的版本，与 build-all.js 的
	// LIVEKIT_VERSION 必须一致，否则「开发能跑、打包后跑不了」。
	BinaryVersion = "v1.13.7"
)

// devBuild 由开发构建注入（`-ldflags -X zviewer/backend/internal/livekit.devBuild=1`）。
//
// 只有开发构建才允许「二进制缺失时联网下载」：生产包在用户机器上静默联网抓
// 56MB 的东西是不可接受的（企业内网必然失败，还会让启动卡 15s 以上）。
var devBuild = "0"

func isDevBuild() bool { return devBuild == "1" }

// TurnConfig 是 TURN/TLS 中继的三件套（缺一即视为未配置）。
type TurnConfig struct {
	Domain string
	Cert   string
	Key    string
}

// Ports 是端口裁决结果。TCP 为 0 表示 ICE/TCP 已关闭，
// TCPOffReason 说明是用户显式关的（"user"）还是被 TURN 抢了同号端口（"turn-conflict"）。
type Ports struct {
	HTTP int
	UDP  int
	TCP  int
	TURN int

	TCPOffReason string
}

const (
	tcpOffByUser   = "user"
	tcpOffByTurn   = "turn-conflict"
	tcpOffNoneText = ""
)

// Config 是启动所需的全部输入（进程启动时解析一次）。
type Config struct {
	// External 为 true 时不拉起本地 LiveKit（LIVEKIT_EXTERNAL=1）。
	External bool
	// Bind 是监听地址，默认 `::`（双栈）。
	Bind string
	// Ports 是裁决后的端口。
	Ports Ports
	// Turn 非 nil 表示 TURN/TLS 三件套齐全。
	Turn *TurnConfig
	// NodeIP 是显式的媒体广播地址（LIVEKIT_NODE_IP），空则由 LiveKit 自己 STUN 探测。
	NodeIP string
	// APIKey / APISecret / APIHost 是注入给 voice 包的默认值。
	APIKey    string
	APISecret string
	APIHost   string
	// BinPath 显式指定二进制（测试或自定义安装位置），优先级最高。
	BinPath string
	// DevBinDir 是开发模式二进制目录与下载落点，默认 <cwd>/dev-bin。
	DevBinDir string
	// ExecDir 是可执行文件目录（生产产物把 livekit-server 放在它旁边）。
	ExecDir string
	// Logf 默认 log.Printf；测试可替换。
	Logf func(format string, args ...any)
}

// Manager 持有伴生进程。零值不可用，用 New 构造。
type Manager struct {
	cfg Config

	mu  sync.Mutex
	cmd *exec.Cmd
}

// ConfigFromEnv 读取环境变量并裁决端口。
func ConfigFromEnv() Config {
	ports := resolvePorts(os.Getenv)

	cfg := Config{
		External:  strings.TrimSpace(os.Getenv("LIVEKIT_EXTERNAL")) == "1",
		Bind:      strings.TrimSpace(os.Getenv("LIVEKIT_BIND")),
		Ports:     ports,
		Turn:      readTurnConfig(os.Getenv),
		NodeIP:    strings.TrimSpace(os.Getenv("LIVEKIT_NODE_IP")),
		APIKey:    firstNonEmpty(os.Getenv("LIVEKIT_API_KEY"), defaultAPIKey),
		APISecret: firstNonEmpty(os.Getenv("LIVEKIT_API_SECRET"), defaultAPISecret),
		APIHost:   firstNonEmpty(os.Getenv("LIVEKIT_API_HOST"), fmt.Sprintf("http://127.0.0.1:%d", defaultHTTPPort)),
		Logf:      log.Printf,
	}
	if cfg.Bind == "" {
		cfg.Bind = defaultBind
	}
	if cwd, err := os.Getwd(); err == nil {
		cfg.DevBinDir = filepath.Join(cwd, "dev-bin")
	}
	if exe, err := os.Executable(); err == nil {
		cfg.ExecDir = filepath.Dir(exe)
	}
	return cfg
}

// New 构造管理器。
func New(cfg Config) *Manager {
	if cfg.Logf == nil {
		cfg.Logf = log.Printf
	}
	if cfg.Bind == "" {
		cfg.Bind = defaultBind
	}
	if cfg.Ports.HTTP == 0 {
		cfg.Ports.HTTP = defaultHTTPPort
	}
	if cfg.Ports.UDP == 0 {
		cfg.Ports.UDP = defaultUDPPort
	}
	return &Manager{cfg: cfg}
}

func (m *Manager) logf(format string, args ...any) { m.cfg.Logf(format, args...) }

// PrepareEnv 注入默认环境变量（同步、幂等）。
//
// 必须与 HTTP 服务启动之前调用：/api/voice/token 的密钥就是从这里读的，
// 晚一步就会先返回 503。真正的「找二进制 / 下载 / 等端口」才放到 Run 里。
func (m *Manager) PrepareEnv() {
	if m.cfg.External {
		return
	}
	setDefault("LIVEKIT_API_KEY", m.cfg.APIKey)
	setDefault("LIVEKIT_API_SECRET", m.cfg.APISecret)
	setDefault("LIVEKIT_API_HOST", m.cfg.APIHost)

	// 未显式指定广播地址时，让 LiveKit 自己用 STUN 探测公网 IP：
	// 云主机（网卡只有内网 IP）与容器 bridge 网络都靠它才能被外网连上。
	if strings.TrimSpace(os.Getenv("LIVEKIT_NODE_IP")) == "" {
		setDefault("LIVEKIT_RTC_USE_EXTERNAL_IP", "true")
		// 内外网双候选：只开 STUN 时 LiveKit 会用 NAT1To1 把本地候选「替换」成
		// 探测到的外网地址，于是同一部署只能服务一侧（局域网用户拿到公网地址后
		// 常因路由器不支持 hairpin 而连不上）。保留内网地址 + 追加外网地址，
		// 两侧各自选中可达的那条。
		setDefault("LIVEKIT_RTC_ADVERTISE_INTERNAL_IP", "true")
	}

	if m.cfg.Turn != nil {
		setDefault("LIVEKIT_TURN_ENABLED", "true")
		setDefault("LIVEKIT_TURN_TLS_PORT", strconv.Itoa(m.cfg.Ports.TURN))
		setDefault("LIVEKIT_TURN_EXTERNAL_TLS", "false")
	}

	// 必须显式写值（0 或端口），不能「不设」：不设时 LiveKit 回落到默认 7881，
	// 而 7881 从未做过端口映射，客户端只会拿到必然连不上的候选。
	_ = os.Setenv("LIVEKIT_RTC_TCP_PORT", strconv.Itoa(m.cfg.Ports.TCP))
}

// Run 拉起伴生进程并等它就绪。调用方应放在 goroutine 里（会阻塞到进程退出）。
//
// ctx 取消时 CommandContext 会杀掉子进程（Windows 上是 TerminateProcess，
// Go 版每个事务都直接落盘，没有需要 flush 的内存快照）。
func (m *Manager) Run(ctx context.Context) {
	if m.cfg.External {
		m.logf("[voice] LIVEKIT_EXTERNAL=1，使用外置 LiveKit，跳过内嵌")
		return
	}

	m.logPorts()

	bin := m.findBinary()
	if bin == "" {
		if !isDevBuild() {
			m.logf("[voice] 未找到 livekit-server 伴生二进制且未配置外置 LiveKit——语音功能不可用。" +
				"容器部署：请用最新镜像重建（构建前先跑 node build-all.js --linux 生成 dist/linux/livekit-server）；" +
				"单文件部署：请使用完整 build-all 产物包（含 livekit-server）")
			return
		}
		downloaded, err := m.downloadDevBinary(ctx)
		if err != nil {
			m.logf("[voice] livekit-server 自动下载失败（%v）。可手动下载 %s 放置到 %s 后重启",
				err, downloadURL(), m.cfg.DevBinDir)
			return
		}
		bin = downloaded
	}

	m.logf("[voice] 启动嵌入式 LiveKit: %s (bind %s, HTTP %d, UDP %d)",
		bin, m.cfg.Bind, m.cfg.Ports.HTTP, m.cfg.Ports.UDP)

	err := m.spawnAndWait(ctx, bin, m.cfg.Bind)
	// 无 IPv6 协议栈的环境绑 :: 会直接退出，回退纯 IPv4 重试一次：
	// 代价是 IPv6 媒体不可用，但语音整体可用。
	if err != nil && m.cfg.Bind == "::" {
		m.logf("[voice] bind :: 启动失败（%v），回退 0.0.0.0 (仅 IPv4) 重试", err)
		err = m.spawnAndWait(ctx, bin, "0.0.0.0")
	}
	if err != nil {
		m.logf("[voice] 嵌入式 LiveKit 启动失败——语音将不可用，请检查端口占用与二进制完整性: %v", err)
		return
	}

	m.warnIfMediaUnreachable()
}

// Stop 立刻终止伴生进程（幂等）。ctx 取消也会带走它，这里给「显式收尾」用。
func (m *Manager) Stop() {
	m.mu.Lock()
	cmd := m.cmd
	m.cmd = nil
	m.mu.Unlock()
	kill(cmd)
}

// Running 报告伴生进程是否还在（主要给测试与运维排查用）。
func (m *Manager) Running() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.cmd != nil
}

// ---------------------------------------------------------------------------
// 端口裁决
// ---------------------------------------------------------------------------

// resolvePorts 按 Node 版的规则裁决端口。抽成纯函数（传 getenv）便于单测：
// 四条分支各自对应一种「部署方手改了环境变量」的情况。
func resolvePorts(get func(string) string) Ports {
	p := Ports{HTTP: defaultHTTPPort, UDP: defaultUDPPort, TCP: defaultTCPPort, TURN: defaultTURNPort}

	tcpRaw := strings.TrimSpace(get("LIVEKIT_RTC_TCP_PORT"))
	tcpDisabled := tcpRaw == "0"
	if n, err := strconv.Atoi(tcpRaw); err == nil && n > 0 {
		p.TCP = n
	}
	if n, err := strconv.Atoi(strings.TrimSpace(get("LIVEKIT_TURN_TLS_PORT"))); err == nil && n > 0 {
		p.TURN = n
	}

	turn := readTurnConfig(get)
	switch {
	case turn != nil && p.TURN == p.TCP:
		// 两个都是 TCP 监听，同号时 LiveKit 直接 bind 失败退出（实测），
		// 所以让给中继、关掉直连——中继是穿透最差网络的最后兜底。
		p.TCP = 0
		p.TCPOffReason = tcpOffByTurn
	case tcpDisabled:
		p.TCP = 0
		p.TCPOffReason = tcpOffByUser
	}
	if turn == nil {
		p.TURN = 0
	}
	return p
}

func readTurnConfig(get func(string) string) *TurnConfig {
	domain := strings.TrimSpace(get("LIVEKIT_TURN_DOMAIN"))
	cert := strings.TrimSpace(get("LIVEKIT_TURN_CERT"))
	key := strings.TrimSpace(get("LIVEKIT_TURN_KEY"))
	if domain == "" || cert == "" || key == "" {
		return nil
	}
	return &TurnConfig{Domain: domain, Cert: cert, Key: key}
}

// logPorts 打出端口裁决结果（与 Node 版三条日志同义）。
func (m *Manager) logPorts() {
	p := m.cfg.Ports
	switch p.TCPOffReason {
	case tcpOffByTurn:
		m.logf("[voice] TURN 与 ICE/TCP 端口同号（%d），同端口无法并存，已让给 TURN/TLS 中继并关闭 ICE/TCP 直连；"+
			"如需两者共存，请把 LIVEKIT_TURN_TLS_PORT 设为 3338 之类的独立端口", p.TURN)
	case tcpOffByUser:
		msg := "[voice] ICE/TCP 已关闭（LIVEKIT_RTC_TCP_PORT=0，仅 " + strconv.Itoa(p.UDP) + "/udp）"
		if p.TURN != 0 {
			msg += fmt.Sprintf("，TURN 中继仍在 %d/tcp", p.TURN)
		}
		m.logf("%s；UDP 被拦的网络将无法建立媒体", msg)
	default:
		msg := fmt.Sprintf("[voice] ICE/TCP 已启用: %d/tcp（UDP 不通时自动回退）", p.TCP)
		if p.TURN != 0 {
			msg += fmt.Sprintf("；TURN 中继并存于 %d/tcp", p.TURN)
		}
		m.logf("%s", msg)
	}
	if m.cfg.Turn != nil {
		m.logf("[voice] TURN/TLS 已启用: %s:%d (TCP 中继兜底)", m.cfg.Turn.Domain, p.TURN)
	} else if anyTurnVarSet() {
		m.logf("[voice] TURN 配置不完整（需 LIVEKIT_TURN_DOMAIN + LIVEKIT_TURN_CERT + LIVEKIT_TURN_KEY 三者），已忽略")
	}
	if strings.TrimSpace(os.Getenv("LIVEKIT_NODE_IP")) == "" {
		m.logf("[voice] 已启用 LiveKit 原生 STUN 外部 IP 发现")
		m.logf("[voice] 已启用内外网双 IP 候选（advertise_internal_ip）")
	}
}

func anyTurnVarSet() bool {
	for _, key := range []string{"LIVEKIT_TURN_DOMAIN", "LIVEKIT_TURN_CERT", "LIVEKIT_TURN_KEY"} {
		if strings.TrimSpace(os.Getenv(key)) != "" {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------------------
// 进程拉起
// ---------------------------------------------------------------------------

// spawnArgs 构造 livekit-server 的命令行。抽出来便于单测校对每个参数。
func (m *Manager) spawnArgs(bind string) []string {
	args := []string{
		"--dev",
		"--bind", bind,
		"--port", strconv.Itoa(m.cfg.Ports.HTTP),
		"--udp-port", strconv.Itoa(m.cfg.Ports.UDP),
		// 格式是硬性要求：冒号后**必须带一个空格**，缺空格 livekit 直接退出
		"--keys", m.cfg.APIKey + ": " + m.cfg.APISecret,
	}
	if nodeIP := strings.TrimSpace(os.Getenv("LIVEKIT_NODE_IP")); nodeIP != "" {
		args = append(args, "--node-ip", nodeIP)
	}
	// 注意：livekit-server v1.13.7 没有 --tcp-port 这个 flag（实测报
	// "flag provided but not defined"），rtc.tcp_port 只能经环境变量
	// LIVEKIT_RTC_TCP_PORT 下发（PrepareEnv 已写）。
	if m.cfg.Turn != nil {
		args = append(args, "--turn-cert", m.cfg.Turn.Cert, "--turn-key", m.cfg.Turn.Key)
	}
	return args
}

// spawnAndWait 启动子进程并等 HTTP 端口可连接。
func (m *Manager) spawnAndWait(ctx context.Context, bin, bind string) error {
	cmd := exec.CommandContext(ctx, bin, m.spawnArgs(bind)...)
	cmd.Stdout = &prefixWriter{prefix: "[livekit] ", out: os.Stdout}
	cmd.Stderr = &prefixWriter{prefix: "[livekit] ", out: os.Stderr}
	prepareCmd(cmd)

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("启动进程失败: %w", err)
	}
	// 加入「父死子死」的托管（Windows job / Linux pdeathsig），覆盖强杀场景
	if err := afterStart(cmd); err != nil {
		m.logf("[voice] 伴生进程强杀清理不可用（%v）：正常退出仍会停止它", err)
	}

	m.mu.Lock()
	m.cmd = cmd
	m.mu.Unlock()

	if err := waitForPort(ctx, m.cfg.Ports.HTTP, readyTimeout); err != nil {
		// 等待失败时进程可能还在（如启动过慢）：先杀掉，避免残留占端口
		kill(cmd)
		m.clearCmd(cmd)
		return err
	}

	m.logf("[voice] 嵌入式 LiveKit 已就绪 (bind %s)", bind)

	// 必须有人 Wait，否则子进程退出后 OS 句柄不会释放；这里顺手记录退出。
	go func() {
		err := cmd.Wait()
		if ctx.Err() != nil {
			return // 主动停止，不当作异常
		}
		m.clearCmd(cmd)
		m.logf("[voice] 嵌入式 LiveKit 进程退出 (err=%v)", err)
	}()
	return nil
}

func (m *Manager) clearCmd(cmd *exec.Cmd) {
	m.mu.Lock()
	if m.cmd == cmd {
		m.cmd = nil
	}
	m.mu.Unlock()
}

func kill(cmd *exec.Cmd) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	_ = cmd.Process.Kill()
}

// waitForPort 轮询等待 TCP 端口可连接（LiveKit 的 HTTP/信令端口）。
func waitForPort(ctx context.Context, port int, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	addr := net.JoinHostPort("127.0.0.1", strconv.Itoa(port))
	for {
		conn, err := (&net.Dialer{Timeout: probeEvery}).DialContext(ctx, "tcp", addr)
		if err == nil {
			_ = conn.Close()
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("LiveKit 端口 %d 等待超时", port)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(probeEvery):
		}
	}
}

// warnIfMediaUnreachable 把「局域网能通、外网连不上」这种静默失败变成启动日志。
//
// 触发条件与 Node 版一致：没有显式 NODE_IP、没有 TURN、且本机网卡全是私网地址。
// 云主机 EIP 场景网卡是私网但 STUN 能探到公网 IP，此时这条警告可以忽略。
func (m *Manager) warnIfMediaUnreachable() {
	if strings.TrimSpace(os.Getenv("LIVEKIT_NODE_IP")) != "" || m.cfg.Turn != nil {
		return
	}
	if ProbePublicInterfaceIP() != nil {
		return
	}
	m.logf("[voice] ⚠️ 语音媒体外网可达性警告：本机网卡均为私网地址，且未配置 LIVEKIT_NODE_IP 与 TURN。\n" +
		"[voice] 局域网内语音正常；外网用户经 EdgeOne/CDN/反向代理访问时页面与信令正常，" +
		"但 WebRTC 媒体（UDP/TCP）不经过七层代理，语音将无法连接。\n" +
		"[voice] 解决路径（三选一）：\n" +
		"[voice]   ① 部署到有公网 IP 的主机，安全组/防火墙放行 3333/udp（容器场景 docker-compose 已含映射）；\n" +
		"[voice]   ② 用支持端口转发的穿透（frp 等）把 3333/udp 映射到公网，并设 LIVEKIT_NODE_IP=穿透公网地址；\n" +
		"[voice]   ③ 配置 TURN/TLS 中继：LIVEKIT_TURN_DOMAIN + LIVEKIT_TURN_CERT + LIVEKIT_TURN_KEY 三项，" +
		"并把 3338/tcp 映射到公网（需正式证书，浏览器不信任自签）。")
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

// setDefault 等价于 Node 的 `process.env.X ??= v`：只在未设置时写入。
func setDefault(key, value string) {
	if strings.TrimSpace(os.Getenv(key)) != "" {
		return
	}
	_ = os.Setenv(key, value)
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

// prefixWriter 给子进程每行日志加固定前缀（Node 版也是逐块加前缀）。
type prefixWriter struct {
	prefix string
	out    *os.File
	mu     sync.Mutex
	bol    bool // 行首标记：true 时下一块要先写前缀
}

func (w *prefixWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if !w.bol {
		if _, err := w.out.WriteString(w.prefix); err != nil {
			return 0, err
		}
		w.bol = true
	}
	if _, err := w.out.Write(p); err != nil {
		return 0, err
	}
	if len(p) > 0 && p[len(p)-1] == '\n' {
		w.bol = false
	}
	return len(p), nil
}

var errUnsupportedPlatform = errors.New("当前平台没有可自动下载的 livekit-server 构建，请手动放置到 dev-bin")
