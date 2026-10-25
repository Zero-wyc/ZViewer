package livekit

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// 端口裁决：四条分支分别对应「部署方手改了环境变量」的一种情况
// ---------------------------------------------------------------------------

func TestResolvePorts(t *testing.T) {
	cases := []struct {
		name string
		env  map[string]string
		want Ports
	}{
		{
			name: "默认（无 TURN、无覆盖）",
			env:  map[string]string{},
			want: Ports{HTTP: 3336, UDP: 3333, TCP: 3337, TURN: 0},
		},
		{
			name: "显式关闭 ICE/TCP",
			env:  map[string]string{"LIVEKIT_RTC_TCP_PORT": "0"},
			want: Ports{HTTP: 3336, UDP: 3333, TCP: 0, TURN: 0, TCPOffReason: tcpOffByUser},
		},
		{
			name: "自定义 ICE/TCP 端口",
			env:  map[string]string{"LIVEKIT_RTC_TCP_PORT": "4337"},
			want: Ports{HTTP: 3336, UDP: 3333, TCP: 4337, TURN: 0},
		},
		{
			name: "TURN 三件套齐全",
			env: map[string]string{
				"LIVEKIT_TURN_DOMAIN": "voice.example.com",
				"LIVEKIT_TURN_CERT":   "/c.pem",
				"LIVEKIT_TURN_KEY":    "/k.pem",
			},
			want: Ports{HTTP: 3336, UDP: 3333, TCP: 3337, TURN: 3338},
		},
		{
			name: "TURN 与 ICE/TCP 同号：让给 TURN、关掉直连",
			env: map[string]string{
				"LIVEKIT_TURN_DOMAIN":   "voice.example.com",
				"LIVEKIT_TURN_CERT":     "/c.pem",
				"LIVEKIT_TURN_KEY":      "/k.pem",
				"LIVEKIT_TURN_TLS_PORT": "3337",
			},
			want: Ports{HTTP: 3336, UDP: 3333, TCP: 0, TURN: 3337, TCPOffReason: tcpOffByTurn},
		},
		{
			name: "TURN 缺证书：整组忽略",
			env: map[string]string{
				"LIVEKIT_TURN_DOMAIN": "voice.example.com",
				"LIVEKIT_TURN_KEY":    "/k.pem",
			},
			want: Ports{HTTP: 3336, UDP: 3333, TCP: 3337, TURN: 0},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			get := func(key string) string { return tc.env[key] }
			if got := resolvePorts(get); got != tc.want {
				t.Fatalf("resolvePorts = %+v, want %+v", got, tc.want)
			}
		})
	}
}

func TestReadTurnConfig(t *testing.T) {
	get := func(key string) string {
		return map[string]string{
			"LIVEKIT_TURN_DOMAIN": " voice.example.com ",
			"LIVEKIT_TURN_CERT":   "/c.pem",
			"LIVEKIT_TURN_KEY":    "/k.pem",
		}[key]
	}
	turn := readTurnConfig(get)
	if turn == nil || turn.Domain != "voice.example.com" {
		t.Fatalf("TURN 配置解析不对: %+v", turn)
	}
}

// ---------------------------------------------------------------------------
// 命令行：`--keys` 的冒号后必须有空格，否则 livekit 直接退出（冒烟实测踩过）
// ---------------------------------------------------------------------------

func TestSpawnArgs(t *testing.T) {
	t.Setenv("LIVEKIT_NODE_IP", "")
	m := New(Config{
		Bind:      "::",
		Ports:     Ports{HTTP: 3336, UDP: 3333, TCP: 3337},
		APIKey:    "devkey",
		APISecret: "zviewer-dev-secret",
		Logf:      func(string, ...any) {},
	})
	args := strings.Join(m.spawnArgs("::"), " ")
	for _, want := range []string{
		"--dev",
		"--bind ::",
		"--port 3336",
		"--udp-port 3333",
		"--keys devkey: zviewer-dev-secret",
	} {
		if !strings.Contains(args, want) {
			t.Errorf("命令行缺少 %q: %s", want, args)
		}
	}
	// livekit-server v1.13.7 没有 --tcp-port；出现这个 flag 就说明又踩了坑
	if strings.Contains(args, "--tcp-port") {
		t.Errorf("命令行不应含 --tcp-port（该 flag 不存在）: %s", args)
	}
}

func TestSpawnArgsWithNodeIPAndTurn(t *testing.T) {
	t.Setenv("LIVEKIT_NODE_IP", "203.0.113.7")
	m := New(Config{
		Ports:     Ports{HTTP: 3336, UDP: 3333, TCP: 3337, TURN: 3338},
		APIKey:    "k",
		APISecret: "s",
		Turn:      &TurnConfig{Domain: "voice.example.com", Cert: "/c.pem", Key: "/k.pem"},
		Logf:      func(string, ...any) {},
	})
	args := strings.Join(m.spawnArgs("0.0.0.0"), " ")
	for _, want := range []string{"--node-ip 203.0.113.7", "--turn-cert /c.pem", "--turn-key /k.pem"} {
		if !strings.Contains(args, want) {
			t.Errorf("命令行缺少 %q: %s", want, args)
		}
	}
}

// ---------------------------------------------------------------------------
// 环境变量注入：等价于 Node 的 `??=`，显式配置必须优先
// ---------------------------------------------------------------------------

func TestPrepareEnvInjectsDefaults(t *testing.T) {
	for _, key := range []string{
		"LIVEKIT_API_KEY", "LIVEKIT_API_SECRET", "LIVEKIT_API_HOST",
		"LIVEKIT_RTC_USE_EXTERNAL_IP", "LIVEKIT_RTC_ADVERTISE_INTERNAL_IP",
		"LIVEKIT_RTC_TCP_PORT", "LIVEKIT_NODE_IP",
	} {
		t.Setenv(key, "")
	}
	m := New(Config{
		Ports:     Ports{HTTP: 3336, UDP: 3333, TCP: 3337},
		APIKey:    defaultAPIKey,
		APISecret: defaultAPISecret,
		APIHost:   "http://127.0.0.1:3336",
		Logf:      func(string, ...any) {},
	})
	m.PrepareEnv()

	if got := os.Getenv("LIVEKIT_API_KEY"); got != "devkey" {
		t.Errorf("API_KEY = %q", got)
	}
	if got := os.Getenv("LIVEKIT_API_SECRET"); got != "zviewer-dev-secret" {
		t.Errorf("API_SECRET = %q", got)
	}
	if got := os.Getenv("LIVEKIT_API_HOST"); got != "http://127.0.0.1:3336" {
		t.Errorf("API_HOST = %q", got)
	}
	if got := os.Getenv("LIVEKIT_RTC_USE_EXTERNAL_IP"); got != "true" {
		t.Errorf("STUN 外部 IP 发现未默认开启: %q", got)
	}
	if got := os.Getenv("LIVEKIT_RTC_ADVERTISE_INTERNAL_IP"); got != "true" {
		t.Errorf("内外网双候选未默认开启: %q", got)
	}
	// ICE/TCP 必须显式写值：不设会回落未映射的 7881
	if got := os.Getenv("LIVEKIT_RTC_TCP_PORT"); got != "3337" {
		t.Errorf("RTC_TCP_PORT = %q, want 3337", got)
	}
}

func TestPrepareEnvKeepsExplicitValues(t *testing.T) {
	t.Setenv("LIVEKIT_API_KEY", "my-key")
	t.Setenv("LIVEKIT_API_SECRET", "my-secret")
	t.Setenv("LIVEKIT_NODE_IP", "203.0.113.9")

	m := New(Config{
		Ports:     Ports{HTTP: 3336, UDP: 3333, TCP: 3337},
		APIKey:    defaultAPIKey,
		APISecret: defaultAPISecret,
		APIHost:   "http://127.0.0.1:3336",
		Logf:      func(string, ...any) {},
	})
	m.PrepareEnv()

	if got := os.Getenv("LIVEKIT_API_KEY"); got != "my-key" {
		t.Errorf("显式 API_KEY 被覆盖成 %q", got)
	}
	if got := os.Getenv("LIVEKIT_API_SECRET"); got != "my-secret" {
		t.Errorf("显式 API_SECRET 被覆盖成 %q", got)
	}
	// 指定了 NODE_IP 就不该再开 STUN 自动探测（两者不叠加）
	if got := os.Getenv("LIVEKIT_RTC_USE_EXTERNAL_IP"); got != "" {
		t.Errorf("指定 NODE_IP 时不应注入 STUN 开关，得到 %q", got)
	}
}

func TestPrepareEnvSkippedWhenExternal(t *testing.T) {
	t.Setenv("LIVEKIT_API_KEY", "")
	m := New(Config{External: true, Ports: Ports{HTTP: 3336, UDP: 3333}, Logf: func(string, ...any) {}})
	m.PrepareEnv()
	if got := os.Getenv("LIVEKIT_API_KEY"); got != "" {
		t.Errorf("LIVEKIT_EXTERNAL=1 时不该注入任何东西，API_KEY = %q", got)
	}
}

// ---------------------------------------------------------------------------
// 二进制候选：BinPath > exe 同目录 > dev-bin（并去重）
// ---------------------------------------------------------------------------

func TestCandidateBinariesOrder(t *testing.T) {
	dir := t.TempDir()
	m := New(Config{
		BinPath:   filepath.Join(dir, "explicit", binName()),
		ExecDir:   filepath.Join(dir, "exec"),
		DevBinDir: filepath.Join(dir, "dev"),
		Logf:      func(string, ...any) {},
	})
	cands := m.candidateBinaries()
	if len(cands) < 3 {
		t.Fatalf("候选路径太少: %v", cands)
	}
	if cands[0] != m.cfg.BinPath {
		t.Errorf("首选应是显式 BinPath，得到 %q", cands[0])
	}
	if cands[1] != filepath.Join(m.cfg.ExecDir, binName()) {
		t.Errorf("第二应是 exe 同目录，得到 %q", cands[1])
	}
	// 去重：DevBinDir 与 cwd 推算出的路径重复时只留一份
	seen := map[string]bool{}
	for _, c := range cands {
		if seen[c] {
			t.Errorf("候选路径重复: %q", c)
		}
		seen[c] = true
	}
}

func TestFindBinaryPicksExisting(t *testing.T) {
	dir := t.TempDir()
	want := filepath.Join(dir, "dev", binName())
	if err := os.MkdirAll(filepath.Dir(want), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(want, []byte("fake"), 0o755); err != nil {
		t.Fatal(err)
	}
	m := New(Config{
		ExecDir:   filepath.Join(dir, "exec"), // 不存在
		DevBinDir: filepath.Join(dir, "dev"),
		Logf:      func(string, ...any) {},
	})
	if got := m.findBinary(); got != want {
		t.Errorf("findBinary = %q, want %q", got, want)
	}
}

func TestFindBinaryMissing(t *testing.T) {
	dir := t.TempDir()
	m := New(Config{ExecDir: filepath.Join(dir, "exec"), DevBinDir: filepath.Join(dir, "dev"), Logf: func(string, ...any) {}})
	if got := m.findBinary(); got != "" {
		t.Errorf("不该找到二进制，得到 %q", got)
	}
}

// ---------------------------------------------------------------------------
// 解压：下载下来的包必须能解出正确的文件（zip 走 Windows，tar.gz 走 Linux）
// ---------------------------------------------------------------------------

func TestExtractZip(t *testing.T) {
	dir := t.TempDir()
	archive := filepath.Join(dir, "a.zip")
	f, err := os.Create(archive)
	if err != nil {
		t.Fatal(err)
	}
	zw := zip.NewWriter(f)
	// 包内路径带目录前缀，解压要按 basename 匹配
	w, err := zw.Create("livekit_1.13.7_windows_amd64/" + binName())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write([]byte("binary-bytes")); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	f.Close()

	dest := filepath.Join(dir, "out", binName())
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := extractBinary(archive, dest); err != nil {
		t.Fatalf("解压失败: %v", err)
	}
	got, err := os.ReadFile(dest)
	if err != nil || string(got) != "binary-bytes" {
		t.Fatalf("解出的内容不对: %q (%v)", got, err)
	}
}

func TestExtractTarGz(t *testing.T) {
	dir := t.TempDir()
	archive := filepath.Join(dir, "a.tar.gz")
	f, err := os.Create(archive)
	if err != nil {
		t.Fatal(err)
	}
	gz := gzip.NewWriter(f)
	tw := tar.NewWriter(gz)
	body := []byte("binary-bytes")
	if err := tw.WriteHeader(&tar.Header{Name: binName(), Mode: 0o755, Size: int64(len(body))}); err != nil {
		t.Fatal(err)
	}
	if _, err := tw.Write(body); err != nil {
		t.Fatal(err)
	}
	tw.Close()
	gz.Close()
	f.Close()

	dest := filepath.Join(dir, "out", binName())
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := extractBinary(archive, dest); err != nil {
		t.Fatalf("解压失败: %v", err)
	}
	got, err := os.ReadFile(dest)
	if err != nil || string(got) != "binary-bytes" {
		t.Fatalf("解出的内容不对: %q (%v)", got, err)
	}
	if runtime.GOOS != "windows" {
		info, _ := os.Stat(dest)
		if info != nil && info.Mode().Perm()&0o100 == 0 {
			t.Errorf("解出的二进制没有执行权限: %v", info.Mode())
		}
	}
}

func TestDownloadURLContainsPinnedVersion(t *testing.T) {
	url := downloadURL()
	if !strings.Contains(url, BinaryVersion) {
		t.Errorf("下载地址没带固定版本 %s: %s", BinaryVersion, url)
	}
	if !strings.Contains(url, "livekit-server/releases/download") {
		t.Errorf("下载地址不对: %s", url)
	}
}

func TestExternalSkipsEverything(t *testing.T) {
	m := New(Config{External: true, Logf: func(string, ...any) {}})
	// Run 应立即返回、不碰文件系统；用已取消的 ctx 也不该 panic
	done := make(chan struct{})
	go func() {
		m.Run(t.Context())
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("LIVEKIT_EXTERNAL=1 时 Run 应立即返回")
	}
}
