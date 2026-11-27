package config

import (
	"os"
	"path/filepath"
	"testing"
)

// 项目根探测的判据是「同时有 frontend 与后端源码目录」。
//
// 这里刻意把 backend-go 也当作合法后端目录：Node 的 backend/ 退场之后，
// 开发态 `go run ./cmd/zviewer-server` 的 cwd 是 backend-go、exe 在临时目录，
// 只认 backend 会让探测一路向上失败，最终把 PROJECT_ROOT 落到临时目录
// （数据库、设置、上传目录全部"消失"）。这条用例就是为了钉住这个退场条件。
func TestFindProjectRootAcceptsBackendGo(t *testing.T) {
	root := t.TempDir()
	for _, dir := range []string{"frontend", "backend-go", filepath.Join("backend-go", "internal", "config")} {
		if err := os.MkdirAll(filepath.Join(root, dir), 0o755); err != nil {
			t.Fatalf("建目录失败: %v", err)
		}
	}

	got := findProjectRootUpward(filepath.Join(root, "backend-go", "internal", "config"))
	if got != root {
		t.Fatalf("只认 backend-go 时探测到 %q，want %q", got, root)
	}
}

// 只有 frontend 没有后端目录时不应误判（否则会在任意前端项目里命中）。
func TestFindProjectRootNeedsBackend(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "frontend", "src"), 0o755); err != nil {
		t.Fatalf("建目录失败: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(root, "frontend", "src", "deep"), 0o755); err != nil {
		t.Fatalf("建目录失败: %v", err)
	}

	if got := findProjectRootUpward(filepath.Join(root, "frontend", "src", "deep")); got != "" {
		t.Fatalf("没有后端目录时不应命中，得到 %q", got)
	}
}

// 分发包布局（<root>/frontend/dist + 可执行文件在 <root>）不靠这个函数兜底：
// 它由 resolveProjectRoot 的 exe 目录回退处理。这里只固定「不会向上误命中」。
func TestFindProjectRootStopsAtFilesystemRoot(t *testing.T) {
	if got := findProjectRootUpward(t.TempDir()); got != "" {
		t.Fatalf("空目录不应命中，得到 %q", got)
	}
}

// 媒体 TCP 端口不能与网页端口同号。
//
// 这条规则是踩出来的：默认值曾经写成「与 UDP 同号」=3333，媒体面先把
// 3333/tcp 绑走，后端随后监听 0.0.0.0:3333 失败，整个进程起不来。
func TestResolveMediaTCPPort(t *testing.T) {
	cases := []struct {
		name     string
		tcpPort  int
		httpPort int
		want     int
	}{
		{"未配置退回 3337", 0, 3333, 3337},
		{"与网页同号换成 3337", 3333, 3333, 3337},
		{"显式 3337 保持不变", 3337, 3333, 3337},
		{"自定义端口不干预", 40000, 3333, 40000},
		{"网页占了 3337 就只开 UDP", 0, 3337, 0},
		{"同号且网页是 3337 也退成只开 UDP", 3337, 3337, 0},
	}
	for _, tc := range cases {
		if got := resolveMediaTCPPort(tc.tcpPort, tc.httpPort); got != tc.want {
			t.Fatalf("%s: 期望 %d，得到 %d", tc.name, tc.want, got)
		}
	}
}

// 屏幕共享的中继策略只有三档，非法值必须在启动期就失败，而不是悄悄退成直连。
func TestParseShareSfuMode(t *testing.T) {
	cases := []struct {
		in      string
		want    string
		invalid bool
	}{
		{"", shareSfuFallback, false},
		{"fallback", shareSfuFallback, false},
		{"FALLBACK", shareSfuFallback, false},
		{" off ", shareSfuOff, false},
		{"only", shareSfuOnly, false},
		{"sfu", "", true},
	}
	for _, tc := range cases {
		got, err := parseShareSfuMode(tc.in)
		if tc.invalid {
			if err == nil {
				t.Fatalf("%q 应被拒绝，得到 %q", tc.in, got)
			}
			continue
		}
		if err != nil || got != tc.want {
			t.Fatalf("%q: 期望 %q，得到 %q（err=%v）", tc.in, tc.want, got, err)
		}
	}

	if !(&Config{ShareSfuMode: shareSfuFallback}).ShareSfuEnabled() {
		t.Fatal("fallback 应视为启用中继")
	}
	if (&Config{ShareSfuMode: shareSfuOff}).ShareSfuEnabled() {
		t.Fatal("off 不应启用中继")
	}
	if !(&Config{ShareSfuMode: shareSfuOnly}).ShareSfuOnly() {
		t.Fatal("only 应报告强制中继")
	}
}

// 自带 STUN 默认与 RTMP 的 3334/tcp 同号不同协议：默认值被改动时必须同步
// README、compose 与镜像 EXPOSE，否则部署方按文档映射会漏掉 UDP。
func TestStunPortDefaults(t *testing.T) {
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.StunPort != 3334 {
		t.Fatalf("STUN 默认端口应为 3334，得到 %d", cfg.StunPort)
	}
	// 与媒体 UDP 端口同号会 bind 失败、静默退回公共 STUN，启动期就该拦住。
	if cfg.StunPort == cfg.ShareMediaPort {
		t.Fatalf("STUN 不能与媒体共用 UDP 端口 %d", cfg.ShareMediaPort)
	}
}
