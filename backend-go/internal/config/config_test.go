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
