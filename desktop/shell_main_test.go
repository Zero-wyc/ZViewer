package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// packagedInstall 曾经写成 fileExists(exeDir/runtime)，而 fileExists 内部要求
// `!info.IsDir()`——传目录永远 false。后果是分发版里 packaged 恒为 false：
// 「登录 Windows 后自动启动控制台」开关点了直接报句提示，注册表也从不写。
func TestPackagedInstallDetectsDistribution(t *testing.T) {
	newExeDir := func(t *testing.T, runtime bool, backend bool, web bool) string {
		t.Helper()
		dir := t.TempDir()
		if !runtime {
			return dir
		}
		rt := filepath.Join(dir, "runtime")
		if err := os.MkdirAll(rt, 0o755); err != nil {
			t.Fatalf("建 runtime 失败: %v", err)
		}
		if backend {
			writeFile(t, filepath.Join(rt, "zviewer-backend.exe"))
		}
		if web {
			writeFile(t, filepath.Join(rt, "frontend", "dist", "index.html"))
		}
		return dir
	}

	cases := []struct {
		name    string
		runtime bool
		backend bool
		web     bool
		want    bool
	}{
		// 分发版：exe 同级 runtime 里带着后端与网页产物。
		{"完整分发目录", true, true, true, true},
		// 只建了空目录不算——这正是旧实现会判错的那种"目录存在"。
		{"空 runtime 目录", true, false, false, false},
		{"缺前端产物", true, true, false, false},
		{"缺后端", true, false, true, false},
		{"没有 runtime", false, false, false, false},
	}
	for _, item := range cases {
		dir := newExeDir(t, item.runtime, item.backend, item.web)
		if got := packagedInstall(dir); got != item.want {
			t.Fatalf("%s: packagedInstall=%v, want %v", item.name, got, item.want)
		}
	}
}

// 用真实分发包目录校验一次：把 ZVIEWER_REAL_DIST 指向
// zviewer-windows-x64-GUI 即可。默认跳过，避免依赖本地构建产物。
func TestPackagedInstallRealDistribution(t *testing.T) {
	dir := os.Getenv("ZVIEWER_REAL_DIST")
	if dir == "" {
		t.Skip("未设置 ZVIEWER_REAL_DIST，跳过真实分发包校验")
	}
	if !packagedInstall(dir) {
		t.Fatalf("真实分发包未被识别为 packaged: %s", dir)
	}
}

func writeFile(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("建目录失败: %v", err)
	}
	if err := os.WriteFile(path, []byte("stub"), 0o644); err != nil {
		t.Fatalf("写文件失败: %v", err)
	}
}

// 防回归：packaged 字段必须由 packagedInstall 赋值。
//
// 这条断言看着"多余"，但原来那个 bug 正出在赋值处——把目录传给只认文件的
// fileExists，函数本身没错，错在调用点。函数级单测覆盖不到这一层。
func TestPackagedFieldUsesHelper(t *testing.T) {
	src, err := os.ReadFile("shell_main.go")
	if err != nil {
		t.Fatalf("读 shell_main.go 失败: %v", err)
	}
	found := false
	for _, line := range strings.Split(string(src), "\n") {
		code := strings.TrimSpace(line)
		if strings.HasPrefix(code, "//") || !strings.Contains(code, "packaged:") {
			continue
		}
		found = true
		if !strings.Contains(code, "packagedInstall(") {
			t.Fatalf("packaged 必须由 packagedInstall 赋值，当前为: %s", code)
		}
	}
	if !found {
		t.Fatal("没找到 packaged 的赋值语句，检查 shell_main.go 是否已改名")
	}
}
