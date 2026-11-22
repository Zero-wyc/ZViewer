package main

import (
	"os"
	"path/filepath"
	"testing"
)

// resolveCrawlerRoot 曾经用 fileExists 判断 data/ 目录，而 fileExists 要求
// `!info.IsDir()`——传目录恒为 false，于是所有候选都落空，永远返回第一个候选
// （运行包内 runtime/crawler）。开发期跑 dist/win 时该目录并不存在，界面就报
// 「未找到 crawler 目录」，而仓库根的 crawler/ 就在旁边。
func TestResolveCrawlerRootFindsRepoLayout(t *testing.T) {
	repo := t.TempDir()
	exeDir := filepath.Join(repo, "desktop", "build", "bin")
	if err := os.MkdirAll(exeDir, 0o755); err != nil {
		t.Fatalf("建 exe 目录失败: %v", err)
	}
	runtimeRoot := filepath.Join(repo, "dist", "win")
	if err := os.MkdirAll(runtimeRoot, 0o755); err != nil {
		t.Fatalf("建运行包目录失败: %v", err)
	}
	crawler := filepath.Join(repo, "crawler", "data", "rules")
	if err := os.MkdirAll(crawler, 0o755); err != nil {
		t.Fatalf("建 crawler 目录失败: %v", err)
	}

	got := resolveCrawlerRoot(exeDir, runtimeRoot)
	if want := filepath.Join(repo, "crawler"); got != want {
		t.Fatalf("resolveCrawlerRoot=%s, want %s", got, want)
	}
}

// 分发包：运行包里就带 crawler/，必须优先于 exe 附近的任何同名目录。
func TestResolveCrawlerRootPrefersRuntimePackage(t *testing.T) {
	install := t.TempDir()
	exeDir := filepath.Join(install, "app")
	if err := os.MkdirAll(exeDir, 0o755); err != nil {
		t.Fatalf("建 exe 目录失败: %v", err)
	}
	runtimeRoot := filepath.Join(install, "app", "runtime")
	packaged := filepath.Join(runtimeRoot, "crawler", "data", "rules")
	if err := os.MkdirAll(packaged, 0o755); err != nil {
		t.Fatalf("建包内 crawler 失败: %v", err)
	}
	// exe 同级也放一个（旧安装的残留），包内那份必须赢。
	if err := os.MkdirAll(filepath.Join(exeDir, "crawler", "docs"), 0o755); err != nil {
		t.Fatalf("建同级 crawler 失败: %v", err)
	}

	got := resolveCrawlerRoot(exeDir, runtimeRoot)
	if want := filepath.Join(runtimeRoot, "crawler"); got != want {
		t.Fatalf("resolveCrawlerRoot=%s, want %s", got, want)
	}
}

func TestResolveCrawlerRootHonorsEnv(t *testing.T) {
	override := t.TempDir()
	t.Setenv("ZVIEWER_CRAWLER_ROOT", override)
	if err := os.MkdirAll(filepath.Join(override, "data"), 0o755); err != nil {
		t.Fatalf("建目录失败: %v", err)
	}

	got := resolveCrawlerRoot(t.TempDir(), t.TempDir())
	if got != filepath.Clean(override) {
		t.Fatalf("resolveCrawlerRoot=%s, want %s", got, override)
	}
}

// 目录不存在从来不是错误：引擎会自建 data/rules，这里只是提前建好，
// 顺便把「目录不可写」变成可读的错误。
func TestEnsureRootCreatesMissingDataDir(t *testing.T) {
	root := filepath.Join(t.TempDir(), "crawler")
	bridge := &crawlerBridge{root: root}

	if crawlerDirUsable(root) {
		t.Fatal("初始状态不应可用")
	}
	if err := bridge.ensureRoot(); err != nil {
		t.Fatalf("ensureRoot 失败: %v", err)
	}
	if !dirExists(filepath.Join(root, "data", "rules")) {
		t.Fatal("ensureRoot 未建出 data/rules")
	}
	if err := bridge.ensureRoot(); err != nil {
		t.Fatalf("幂等失败: %v", err)
	}
}

// 回归：fileExists 显式排除目录，拿它测目录永远为 false。
func TestDirExistsVersusFileExists(t *testing.T) {
	dir := t.TempDir()
	if !dirExists(dir) {
		t.Fatalf("dirExists(%s)=false", dir)
	}
	if fileExists(dir) {
		t.Fatalf("fileExists(%s)=true，说明 fileExists 的语义被改了", dir)
	}
}
