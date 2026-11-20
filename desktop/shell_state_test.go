package main

import (
	"os"
	"path/filepath"
	"testing"
)

// TestResolveStateDirPackaged 分发版（exe 同级带 runtime/）必须用包内相对目录，
// 不能回落 %APPDATA%，否则解压分享包会读到本机其它版本留下的 settings.json。
func TestResolveStateDirPackaged(t *testing.T) {
	t.Setenv("ZVIEWER_STATE_DIR", "")
	exeDir := t.TempDir()
	runtimeDir := filepath.Join(exeDir, "runtime")
	if err := os.MkdirAll(filepath.Join(runtimeDir, "frontend", "dist"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(runtimeDir, "zviewer-backend.exe"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(runtimeDir, "frontend", "dist", "index.html"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	got := resolveStateDir(exeDir)
	want := filepath.Join(exeDir, "profile")
	if got != want {
		t.Fatalf("packaged state dir = %q, want %q", got, want)
	}
}

// TestResolveStateDirDevFallback 非分发版（源码树里的 desktop.exe）仍走 %APPDATA%。
func TestResolveStateDirDevFallback(t *testing.T) {
	t.Setenv("ZVIEWER_STATE_DIR", "")
	exeDir := t.TempDir()
	t.Setenv("APPDATA", filepath.Join(exeDir, "roaming"))
	got := resolveStateDir(exeDir)
	want := filepath.Join(exeDir, "roaming", "ZViewerDesktop")
	if got != want {
		t.Fatalf("dev state dir = %q, want %q", got, want)
	}
}
