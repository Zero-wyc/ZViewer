//go:build !windows

package updater

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// TestPackagedInstallerScriptRuns 用真 bash 跑一遍发行包里的 install-update.sh。
//
// 单测只能证明「更新器选中了包内脚本」，证明不了「包内脚本自己是对的」。
// 这里在临时目录里搭一套安装根 + 解压目录，按 docker 模式跑完整流程，
// 校验清单拷贝、目录替换、config 保留、重启标记、引导文件清理。
//
// 用假 pgrep 顶掉进程查找：测试机上可能真有别的 zviewer-backend 在跑，
// 让脚本去 kill 它是灾难。
func TestPackagedInstallerScriptRuns(t *testing.T) {
	bash, err := exec.LookPath("bash")
	if err != nil {
		t.Skip("当前环境没有 bash")
	}

	repoScript := filepath.Join("..", "..", "..", "packaging", "install-update.sh")
	if _, err := os.Stat(repoScript); err != nil {
		t.Skipf("找不到发行包脚本: %v", err)
	}

	root := t.TempDir()
	extracted := filepath.Join(root, ".update-temp")
	tempDir := filepath.Join(root, ".update-temp")

	write := func(path, body string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatalf("建目录失败: %v", err)
		}
		if err := os.WriteFile(path, []byte(body), 0o755); err != nil {
			t.Fatalf("写文件失败: %v", err)
		}
	}

	// 安装根：旧版本现场
	write(filepath.Join(root, "config", "config.json"), `{"keep":true}`)
	write(filepath.Join(root, "zviewer-backend"), "OLD-BACKEND")
	write(filepath.Join(root, "zviewer-webgui"), "OLD-WEBGUI")
	write(filepath.Join(root, "livekit-server"), "OLD-LIVEKIT")
	write(filepath.Join(root, "frontend", "dist", "old-only.js"), "stale")
	write(filepath.Join(root, "frontend", "dist", "index.html"), "old-index")

	// 解压目录：新版本产物（故意不带 livekit-server，验证「缺失就保留」）
	write(filepath.Join(extracted, "zviewer-backend"), "NEW-BACKEND")
	write(filepath.Join(extracted, "zviewer-webgui"), "NEW-WEBGUI")
	write(filepath.Join(extracted, "frontend", "dist", "index.html"), "new-index")
	write(filepath.Join(extracted, "start.sh"), "#!/bin/bash\nexit 0\n")

	scriptBody, err := os.ReadFile(repoScript)
	if err != nil {
		t.Fatalf("读发行包脚本失败: %v", err)
	}
	runner := filepath.Join(root, "apply-update.sh")
	if err := os.WriteFile(runner, scriptBody, 0o755); err != nil {
		t.Fatalf("落位脚本失败: %v", err)
	}
	if err := os.Chmod(runner, 0o755); err != nil {
		t.Fatalf("设置执行位失败: %v", err)
	}

	// 假 pgrep：恒定「没找到」，避免误杀测试机上的真实进程
	fakeBin := filepath.Join(root, "fakebin")
	write(filepath.Join(fakeBin, "pgrep"), "#!/bin/bash\nexit 1\n")

	cmd := exec.Command(bash, runner)
	cmd.Dir = root
	cmd.Env = append(os.Environ(),
		"PATH="+fakeBin+string(os.PathListSeparator)+os.Getenv("PATH"),
		"ZVIEWER_UPDATE_ROOT="+root,
		"ZVIEWER_UPDATE_TEMP="+tempDir,
		"ZVIEWER_UPDATE_EXTRACTED="+extracted,
		"ZVIEWER_UPDATE_MODE=docker",
		"ZVIEWER_UPDATE_TAG=[测试]",
		"ZVIEWER_UPDATE_FROM=0.0.1",
	)
	if output, err := cmd.CombinedOutput(); err != nil {
		logRaw, _ := os.ReadFile(filepath.Join(root, "update.log"))
		t.Fatalf("脚本执行失败: %v\nstdout/stderr: %s\nupdate.log:\n%s", err, output, logRaw)
	}

	read := func(path string) string {
		t.Helper()
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("读 %s 失败: %v", path, err)
		}
		return string(raw)
	}

	if got := read(filepath.Join(root, "zviewer-backend")); got != "NEW-BACKEND" {
		t.Fatalf("后端未更新: %q", got)
	}
	if got := read(filepath.Join(root, "zviewer-webgui")); got != "NEW-WEBGUI" {
		t.Fatalf("控制台未更新（这正是旧白名单漏掉的文件）: %q", got)
	}
	// 包里没带 livekit-server：必须保留旧的，不能被删
	if got := read(filepath.Join(root, "livekit-server")); got != "OLD-LIVEKIT" {
		t.Fatalf("缺失的伴生二进制不该被清理: %q", got)
	}
	if got := read(filepath.Join(root, "frontend", "dist", "index.html")); got != "new-index" {
		t.Fatalf("前端静态文件未替换: %q", got)
	}
	if _, err := os.Stat(filepath.Join(root, "frontend", "dist", "old-only.js")); !os.IsNotExist(err) {
		t.Fatal("目录替换后不该残留旧文件")
	}
	// 容器模式不动 config：数据库必须原地保留
	if got := read(filepath.Join(root, "config", "config.json")); got != `{"keep":true}` {
		t.Fatalf("config 被破坏: %q", got)
	}
	if _, err := os.Stat(filepath.Join(root, ".restart-backend")); err != nil {
		t.Fatalf("应留下重启标记: %v", err)
	}
	if _, err := os.Stat(runner); !os.IsNotExist(err) {
		t.Fatal("脚本收尾应删除自身")
	}
	if _, err := os.Stat(extracted); !os.IsNotExist(err) {
		t.Fatal("临时目录应被清理")
	}

	logText := read(filepath.Join(root, "update.log"))
	if !strings.Contains(logText, "更新完成") {
		t.Fatalf("日志缺少完成标记:\n%s", logText)
	}
}

// TestPackagedInstallerNativeSkipsArchive 平铺包（解压目录 == 临时目录）时，
// 下载的压缩包不能被整包铺进安装目录。
func TestPackagedInstallerNativeSkipsArchive(t *testing.T) {
	bash, err := exec.LookPath("bash")
	if err != nil {
		t.Skip("当前环境没有 bash")
	}
	repoScript := filepath.Join("..", "..", "..", "packaging", "install-update.sh")
	scriptBody, err := os.ReadFile(repoScript)
	if err != nil {
		t.Skipf("找不到发行包脚本: %v", err)
	}

	root := t.TempDir()
	tempDir := filepath.Join(root, ".update-temp")
	writeFile := func(path, body string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatalf("建目录失败: %v", err)
		}
		if err := os.WriteFile(path, []byte(body), 0o755); err != nil {
			t.Fatalf("写文件失败: %v", err)
		}
	}
	writeFile(filepath.Join(root, "zviewer-backend"), "OLD")
	writeFile(filepath.Join(root, "start.sh"), "#!/bin/bash\nexit 0\n")
	// 平铺包：产物与压缩包同在临时目录
	writeFile(filepath.Join(tempDir, "zviewer-backend"), "NEW")
	writeFile(filepath.Join(tempDir, "update.tar.gz"), "not-really-an-archive")
	writeFile(filepath.Join(tempDir, "start.sh"), "#!/bin/bash\nexit 0\n")

	runner := filepath.Join(root, "apply-update.sh")
	if err := os.WriteFile(runner, scriptBody, 0o755); err != nil {
		t.Fatalf("写脚本失败: %v", err)
	}
	fakeBin := filepath.Join(root, "fakebin")
	writeFile(filepath.Join(fakeBin, "pgrep"), "#!/bin/bash\nexit 1\n")

	cmd := exec.Command(bash, runner)
	cmd.Dir = root
	cmd.Env = append(os.Environ(),
		"PATH="+fakeBin+string(os.PathListSeparator)+os.Getenv("PATH"),
		"ZVIEWER_UPDATE_ROOT="+root,
		"ZVIEWER_UPDATE_TEMP="+tempDir,
		"ZVIEWER_UPDATE_EXTRACTED="+tempDir,
		"ZVIEWER_UPDATE_MODE=native",
		"ZVIEWER_UPDATE_FROM=0.0.1",
	)
	if output, err := cmd.CombinedOutput(); err != nil {
		logRaw, _ := os.ReadFile(filepath.Join(root, "update.log"))
		t.Fatalf("脚本执行失败: %v\n%s\n%s", err, output, logRaw)
	}

	if got, err := os.ReadFile(filepath.Join(root, "zviewer-backend")); err != nil || string(got) != "NEW" {
		t.Fatalf("后端未更新: %q err=%v", got, err)
	}
	if _, err := os.Stat(filepath.Join(root, "update.tar.gz")); !os.IsNotExist(err) {
		t.Fatal("压缩包不该被铺进安装目录")
	}
}

// TestPackagedInstallerScriptRejectsMissingEnv 环境变量缺失时必须以 2 退出，
// 不能默默按默认值去动一个不存在的目录。
func TestPackagedInstallerScriptRejectsMissingEnv(t *testing.T) {
	bash, err := exec.LookPath("bash")
	if err != nil {
		t.Skip("当前环境没有 bash")
	}
	repoScript := filepath.Join("..", "..", "..", "packaging", "install-update.sh")
	raw, err := os.ReadFile(repoScript)
	if err != nil {
		t.Skipf("找不到发行包脚本: %v", err)
	}
	dir := t.TempDir()
	runner := filepath.Join(dir, "apply-update.sh")
	if err := os.WriteFile(runner, raw, 0o755); err != nil {
		t.Fatalf("写脚本失败: %v", err)
	}

	cmd := exec.Command(bash, runner)
	cmd.Dir = dir
	cmd.Env = []string{"PATH=" + os.Getenv("PATH")}
	err = cmd.Run()
	if err == nil {
		t.Fatal("缺少 ROOT 应以非 0 退出")
	}
	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) {
		t.Fatalf("应拿到退出码: %v", err)
	}
	if code := exitErr.ExitCode(); code != 2 {
		t.Fatalf("退出码应为 2，实际 %d", code)
	}
}
