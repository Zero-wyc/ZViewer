package crawler

// 规则根目录兜底（UseDefaultRoot）的边界测试。
//
// 这里必须 t.Chdir：ResolveRoot 会探测工作目录及其上一级的 crawler/，
// 而本包所在的目录名就叫 crawler——不换目录的话，「包目录」会被当成
// 一个合法规则根，测出来的结论全是假的。

import (
	"os"
	"path/filepath"
	"testing"
)

// isolateRootEnv 清掉可能影响探测的两个环境变量，并把工作目录换到空目录。
func isolateRootEnv(t *testing.T) {
	t.Helper()
	t.Setenv("CRAWLER_ROOT", "")
	t.Setenv("ZVIEWER_CRAWLER_ROOT", "")
	t.Chdir(t.TempDir())
}

func TestUseDefaultRootCreatesConfigDir(t *testing.T) {
	isolateRootEnv(t)
	configDir := t.TempDir()

	root, err := UseDefaultRoot(configDir)
	if err != nil {
		t.Fatalf("UseDefaultRoot: %v", err)
	}
	want := filepath.Join(configDir, "crawler")
	if root != want {
		t.Fatalf("root = %q, want %q", root, want)
	}
	if info, err := os.Stat(filepath.Join(want, "data", "rules")); err != nil || !info.IsDir() {
		t.Fatalf("data/rules 未创建: %v", err)
	}
	// 写回环境变量是「其它调用方也能拿到」的关键：MCP 与 lazy 单例都读它。
	if got := os.Getenv("CRAWLER_ROOT"); got != want {
		t.Fatalf("CRAWLER_ROOT = %q, want %q", got, want)
	}
	if got := ResolveRoot(); got != want {
		t.Fatalf("ResolveRoot = %q, want %q", got, want)
	}
}

func TestUseDefaultRootKeepsExplicitEnv(t *testing.T) {
	isolateRootEnv(t)
	explicit := t.TempDir()
	t.Setenv("CRAWLER_ROOT", explicit)
	configDir := t.TempDir()

	root, err := UseDefaultRoot(configDir)
	if err != nil {
		t.Fatalf("UseDefaultRoot: %v", err)
	}
	if root != explicit {
		t.Fatalf("root = %q, want 显式配置 %q", root, explicit)
	}
	if _, err := os.Stat(filepath.Join(configDir, "crawler")); !os.IsNotExist(err) {
		t.Fatalf("显式配置时不该在 config 下另建目录: %v", err)
	}
}

// GUI 版与源码树里都有现成的 crawler/：必须优先用它，不能把规则搬去 config。
func TestUseDefaultRootKeepsExistingCrawlerDir(t *testing.T) {
	isolateRootEnv(t)
	workDir := t.TempDir()
	existing := filepath.Join(workDir, "crawler")
	if err := os.MkdirAll(filepath.Join(existing, "data", "rules"), 0o755); err != nil {
		t.Fatalf("准备目录: %v", err)
	}
	t.Chdir(workDir)
	configDir := t.TempDir()

	root, err := UseDefaultRoot(configDir)
	if err != nil {
		t.Fatalf("UseDefaultRoot: %v", err)
	}
	if root != existing {
		t.Fatalf("root = %q, want 已存在的 %q", root, existing)
	}
	if _, err := os.Stat(filepath.Join(configDir, "crawler")); !os.IsNotExist(err) {
		t.Fatalf("已有 crawler/ 时不该在 config 下另建目录: %v", err)
	}
}

func TestUseDefaultRootRejectsEmptyConfigDir(t *testing.T) {
	isolateRootEnv(t)
	if _, err := UseDefaultRoot("  "); err == nil {
		t.Fatal("空配置目录应当报错，而不是回落成相对路径")
	}
}
