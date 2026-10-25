package updater

import (
	"os"
	"path/filepath"
	"testing"
)

// writeFile 在测试里造文件（自动建父目录）。
func mustWriteFile(t *testing.T, path string, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("建目录失败: %v", err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("写文件失败: %v", err)
	}
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// TestCleanLegacyArtifactsReleaseLayout 覆盖发布包布局：
// Node 专属可执行文件、node_modules、backend、媒体切片全部清掉，其他文件原样保留。
func TestCleanLegacyArtifactsReleaseLayout(t *testing.T) {
	root := t.TempDir()
	mediaDir := filepath.Join(root, "config", "media")

	// 发布包布局标志：有前端产物、没有前端源码、没有 .git
	mustWriteFile(t, filepath.Join(root, "frontend", "dist", "index.html"), "<html></html>")
	mustWriteFile(t, filepath.Join(root, "frontend", "dist", "assets", "app.js"), "console.log(1)")
	// 必须保留的
	mustWriteFile(t, filepath.Join(root, "zviewer-backend.exe"), "go-binary")
	mustWriteFile(t, filepath.Join(root, "start.ps1"), "start")
	mustWriteFile(t, filepath.Join(root, "config", "dev.sqlite"), "db")
	// Node 时代遗留
	mustWriteFile(t, filepath.Join(root, "zviewer-frontend.exe"), "node-frontend")
	mustWriteFile(t, filepath.Join(root, "zviewer-cert"), "node-cert")
	mustWriteFile(t, filepath.Join(root, "node_modules", "express", "index.js"), "module")
	mustWriteFile(t, filepath.Join(root, "backend", "src", "index.ts"), "node-source")
	// 媒体缓存：只该删已知后缀
	mustWriteFile(t, filepath.Join(mediaDir, "live", "abcd", "seg-1.ts"), "ts")
	mustWriteFile(t, filepath.Join(mediaDir, "live", "abcd", "index.m3u8"), "m3u8")
	mustWriteFile(t, filepath.Join(mediaDir, "live", "abcd", "keep.txt"), "keep")

	var logs []string
	result := CleanLegacyArtifacts(root, mediaDir, func(format string, args ...any) {
		logs = append(logs, format)
	})

	for _, gone := range []string{
		"zviewer-frontend.exe", "zviewer-cert", "node_modules/", "backend/",
	} {
		found := false
		for _, item := range result.Removed {
			if item == gone {
				found = true
			}
		}
		if !found {
			t.Errorf("应删除 %s，实际删除清单: %v（日志: %v）", gone, result.Removed, logs)
		}
	}
	if exists(filepath.Join(root, "zviewer-frontend.exe")) {
		t.Error("zviewer-frontend.exe 仍在")
	}
	if exists(filepath.Join(root, "node_modules")) {
		t.Error("node_modules 仍在")
	}
	if exists(filepath.Join(root, "backend")) {
		t.Error("backend 仍在")
	}
	for _, kept := range []string{
		filepath.Join(root, "zviewer-backend.exe"),
		filepath.Join(root, "start.ps1"),
		filepath.Join(root, "config", "dev.sqlite"),
		filepath.Join(root, "frontend", "dist", "index.html"),
		filepath.Join(mediaDir, "live", "abcd", "keep.txt"),
	} {
		if !exists(kept) {
			t.Errorf("不该删除 %s", kept)
		}
	}
	if exists(filepath.Join(mediaDir, "live", "abcd", "seg-1.ts")) {
		t.Error("媒体切片 seg-1.ts 未被清理")
	}
	if exists(filepath.Join(mediaDir, "live", "abcd", "index.m3u8")) {
		t.Error("媒体索引 index.m3u8 未被清理")
	}
	if result.Freed <= 0 {
		t.Errorf("Freed = %d, 期望 > 0", result.Freed)
	}

	// 幂等：第二次什么都不该删。
	again := CleanLegacyArtifacts(root, mediaDir, nil)
	if !again.Empty() {
		t.Errorf("第二次清理不应再删除任何东西: %v", again.Removed)
	}
}

// TestCleanLegacyArtifactsSourceTree 覆盖源码树：
// 目录级清理必须跳过（node_modules / backend / media 都是开发者的），
// 但 Node 专属可执行文件仍然删——Go 工程里它们没有存在的理由。
func TestCleanLegacyArtifactsSourceTree(t *testing.T) {
	root := t.TempDir()
	mediaDir := filepath.Join(root, "config", "media")
	mustWriteFile(t, filepath.Join(root, ".git", "HEAD"), "ref: refs/heads/main")
	mustWriteFile(t, filepath.Join(root, "frontend", "src", "main.tsx"), "app")
	mustWriteFile(t, filepath.Join(root, "zviewer-frontend.exe"), "node-frontend")
	mustWriteFile(t, filepath.Join(root, "node_modules", "vite", "index.js"), "module")
	mustWriteFile(t, filepath.Join(root, "backend", "src", "index.ts"), "node-source")
	mustWriteFile(t, filepath.Join(mediaDir, "seg.ts"), "ts")

	result := CleanLegacyArtifacts(root, mediaDir, nil)
	if len(result.Removed) != 1 || result.Removed[0] != "zviewer-frontend.exe" {
		t.Errorf("源码树只应删 zviewer-frontend.exe，实际: %v", result.Removed)
	}
	if !exists(filepath.Join(root, "node_modules")) {
		t.Error("源码树的 node_modules 被误删")
	}
	if !exists(filepath.Join(root, "backend")) {
		t.Error("源码树的 backend 被误删")
	}
	if !exists(filepath.Join(mediaDir, "seg.ts")) {
		t.Error("源码树的媒体目录被误删")
	}
}

// TestCleanLegacyArtifactsEmptyRoot 覆盖空 root：不做任何事，也不 panic。
func TestCleanLegacyArtifactsEmptyRoot(t *testing.T) {
	if result := CleanLegacyArtifacts("", "", nil); !result.Empty() {
		t.Errorf("空 root 不应删除任何东西: %v", result.Removed)
	}
}
