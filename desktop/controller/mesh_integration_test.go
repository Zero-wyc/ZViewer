package controller

// 集成测试：真的拉起 easytier-core，跑通「生成 TOML → 启动 → RPC 读回状态 → 双节点互连 → 停止」。
// 组件由 scripts/fetch-components.ps1 下载后解到 desktop/.runtime/tools/easytier，缺失时跳过，
// 不让普通 `go test ./...` 依赖网络或第三方二进制。

import (
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func meshTestBinaries(t *testing.T) (core, host string) {
	t.Helper()
	binDir := filepath.Join("..", ".runtime", "tools", "easytier")
	core = filepath.Join(binDir, "easytier-core.exe")
	cli := filepath.Join(binDir, "easytier-cli.exe")
	host = filepath.Join("..", "assets", "ZViewer.ProcessHost.exe")
	for _, file := range []string{core, cli, host} {
		if _, err := os.Stat(file); err != nil {
			t.Skipf("缺少 %s，先跑 desktop/scripts/fetch-components.ps1，再把 easytier 解到 desktop/.runtime/tools/easytier", file)
		}
	}
	// startProcess 会把工作目录切到组件目录，宿主的相对路径会失效，先转绝对路径。
	if absolute, err := filepath.Abs(host); err == nil {
		host = absolute
	}
	return core, host
}

// newMeshTestNode 按分发包的目录结构铺一份组件：runtime/mesh 放二进制与依赖 DLL。
func newMeshTestNode(t *testing.T, core, host string) *MeshManager {
	t.Helper()
	root := t.TempDir()
	binDir := filepath.Join(root, "mesh")
	if err := os.MkdirAll(binDir, 0o700); err != nil {
		t.Fatalf("创建目录失败：%v", err)
	}
	// easytier-core 会加载同目录下的 Packet.dll / WinDivert64.sys，缺了直接报
	// “packet.dll: cannot open shared object file”，所以整份组件一起复制。
	entries, err := os.ReadDir(filepath.Dir(core))
	if err != nil {
		t.Fatalf("读取组件目录失败：%v", err)
	}
	for _, entry := range entries {
		if entry.IsDir() || strings.HasSuffix(entry.Name(), ".txt") {
			continue
		}
		raw, readErr := os.ReadFile(filepath.Join(filepath.Dir(core), entry.Name()))
		if readErr != nil {
			t.Fatalf("读取组件失败：%v", readErr)
		}
		if writeErr := os.WriteFile(filepath.Join(binDir, entry.Name()), raw, 0o700); writeErr != nil {
			t.Fatalf("复制组件失败：%v", writeErr)
		}
	}
	manager := NewMeshManager(root, filepath.Join(root, "state"), host,
		func(proc *Proc, _ string) error {
			if proc.cmd != nil && proc.cmd.Process != nil {
				return proc.cmd.Process.Kill()
			}
			return nil
		}, func(string, string, string) {}, func() {})
	if !manager.Available() {
		t.Fatal("组件已复制，Available 应为 true")
	}
	return manager
}

func freeTCPPort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("找不到空闲端口：%v", err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	_ = listener.Close()
	return port
}

func waitUntil(t *testing.T, timeout time.Duration, condition func() bool) bool {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if condition() {
			return true
		}
		time.Sleep(250 * time.Millisecond)
	}
	return false
}

func TestMeshManagerLifecycle(t *testing.T) {
	if !isWindows() {
		t.Skip("组网组件只有 Windows 版本")
	}
	core, host := meshTestBinaries(t)
	manager := newMeshTestNode(t, core, host)

	cfg := MeshConfig{
		NetworkName: RandomMeshName(),
		Peers:       []string{},
		ListenPort:  freeTCPPort(t),
		InstanceID:  NewMeshInstanceID(),
	}
	status, err := manager.Start(cfg, RandomMeshSecret())
	if err != nil {
		t.Fatalf("启动组网失败：%v", err)
	}
	defer func() {
		if _, stopErr := manager.Stop(); stopErr != nil {
			t.Fatalf("停止组网失败：%v", stopErr)
		}
		if state := manager.Snapshot().State; state != "stopped" {
			t.Fatalf("停止后状态应为 stopped，得到 %q", state)
		}
	}()

	// 单节点拿不到虚拟 IP：DHCP 要等有对端接入。这里只要求进程与 RPC 就绪。
	if status.State != "running" {
		t.Fatalf("状态应为 running，得到 %q（%s）", status.State, status.Message)
	}
	if status.VirtualIP != "" {
		t.Fatalf("单节点不应分配虚拟 IP，得到 %q", status.VirtualIP)
	}
	if status.Message != meshWaitingMessage {
		t.Fatalf("应提示等待接入，得到 %q", status.Message)
	}
	if len(status.LanPeers) == 0 {
		t.Fatal("应给出局域网接入地址")
	}

	// 生成的配置必须带免 TUN 的两个硬要求。
	raw, err := os.ReadFile(filepath.Join(manager.dir, "config.toml"))
	if err != nil {
		t.Fatalf("读取生成的配置失败：%v", err)
	}
	text := string(raw)
	for _, want := range []string{"no_tun = true", "bind_device = false", "dhcp = true", cfg.NetworkName} {
		if !strings.Contains(text, want) {
			t.Fatalf("生成的配置缺少 %q：\n%s", want, text)
		}
	}
}

// 双节点互连：第二个节点把第一个节点的监听地址填进对端地址，
// 两边都由 DHCP 分配虚拟 IP，并且对端列表互相可见。
func TestMeshManagerTwoNodes(t *testing.T) {
	if !isWindows() {
		t.Skip("组网组件只有 Windows 版本")
	}
	core, host := meshTestBinaries(t)
	first := newMeshTestNode(t, core, host)
	second := newMeshTestNode(t, core, host)

	name := RandomMeshName()
	secret := RandomMeshSecret()
	firstPort := freeTCPPort(t)
	if _, err := first.Start(MeshConfig{
		NetworkName: name, ListenPort: firstPort, InstanceID: NewMeshInstanceID(),
	}, secret); err != nil {
		t.Fatalf("节点 A 启动失败：%v", err)
	}
	defer func() { _, _ = first.Stop() }()

	// 用局域网地址互连：no_tun + bind_device=false 时不限制出站网卡，
	// 但回环在这套实现里仍不走隧道，所以照真实用法填非回环地址。
	interfaces, err := net.Interfaces()
	if err != nil {
		t.Skip("读不到网卡")
	}
	var target string
	for _, item := range interfaces {
		if item.Flags&net.FlagUp == 0 || item.Flags&net.FlagLoopback != 0 {
			continue
		}
		addresses, _ := item.Addrs()
		for _, address := range addresses {
			if ipNet, ok := address.(*net.IPNet); ok && ipNet.IP.To4() != nil && !ipNet.IP.IsLinkLocalUnicast() {
				target = net.JoinHostPort(ipNet.IP.To4().String(), strconv.Itoa(firstPort))
			}
		}
		if target != "" {
			break
		}
	}
	if target == "" {
		t.Skip("没有可用的局域网 IPv4")
	}

	started, err := second.Start(MeshConfig{
		NetworkName: name,
		Peers:       []string{"tcp://" + target},
		ListenPort:  freeTCPPort(t),
		InstanceID:  NewMeshInstanceID(),
	}, secret)
	if err != nil {
		t.Fatalf("节点 B 启动失败：%v", err)
	}
	defer func() { _, _ = second.Stop() }()
	if started.State != "running" {
		t.Fatalf("节点 B 状态应为 running，得到 %q", started.State)
	}

	// 两边都应当很快拿到地址并看见对方。
	bothReady := waitUntil(t, 20*time.Second, func() bool {
		a, b := first.Snapshot(), second.Snapshot()
		return a.VirtualIP != "" && b.VirtualIP != "" && len(a.Peers) >= 2 && len(b.Peers) >= 2
	})
	if !bothReady {
		t.Fatalf("双节点未互连：A=%+v B=%+v", first.Snapshot(), second.Snapshot())
	}
	for _, snapshot := range []MeshStatus{first.Snapshot(), second.Snapshot()} {
		online := 0
		for _, peer := range snapshot.Peers {
			if !peer.Self && peer.IPv4 != "" {
				online++
			}
		}
		if online == 0 {
			t.Fatalf("对端列表里没有其他节点：%+v", snapshot.Peers)
		}
		if snapshot.Message != "" {
			t.Fatalf("互连后不应再提示等待：%q", snapshot.Message)
		}
	}
}

// 回归：GUI 走的是 DefaultMeshConfig（没有实例标识）这条路径。
// 之前生成的 TOML 是 instance_id = ""，easytier-core 200ms 内退出（1），
// 界面只显示「组网进程已退出（1）」——这里直接用默认配置跑通启动。
func TestMeshManagerStartsWithDefaultConfig(t *testing.T) {
	if !isWindows() {
		t.Skip("组网组件只有 Windows 版本")
	}
	core, host := meshTestBinaries(t)
	manager := newMeshTestNode(t, core, host)
	cfg := DefaultMeshConfig()
	cfg.NetworkName = RandomMeshName()
	cfg.ListenPort = freeTCPPort(t)
	status, err := manager.Start(cfg, RandomMeshSecret())
	if err != nil {
		t.Fatalf("默认配置应能启动组网：%v（message=%q）", err, status.Message)
	}
	defer func() { _, _ = manager.Stop() }()
	if status.State != "running" {
		t.Fatalf("状态应为 running，得到 %q（%s）", status.State, status.Message)
	}
	raw, readErr := os.ReadFile(filepath.Join(manager.dir, "config.toml"))
	if readErr != nil {
		t.Fatalf("读取生成的配置失败：%v", readErr)
	}
	if strings.Contains(string(raw), `instance_id = ""`) {
		t.Fatalf("生成的配置不能是空实例标识：\n%s", string(raw))
	}
}
