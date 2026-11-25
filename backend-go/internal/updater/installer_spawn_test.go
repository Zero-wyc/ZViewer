//go:build !windows

package updater

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestApplyUpdateSpawnsPackagedInstaller 端到端：不注入假 spawn，
// 让更新器真的 detached 起 bash 跑包内脚本，验证文件最终被换掉。
//
// 与 TestPackagedInstallerScriptRuns 的区别：那个只证明脚本本身对，
// 这个证明「更新器 → spawn → 脚本 → 落盘」整条链路对，包括环境变量注入
// 和 detached 后脚本仍能写完日志。
func TestApplyUpdateSpawnsPackagedInstaller(t *testing.T) {
	if testing.Short() {
		t.Skip("端到端用例耗时约 5 秒")
	}

	root := t.TempDir()
	// 假 pgrep：脚本会按名字找后端进程去 kill，测试机上可能真有人跑着。
	fakeBin := filepath.Join(root, "fakebin")
	if err := os.MkdirAll(fakeBin, 0o755); err != nil {
		t.Fatalf("建 fakebin 失败: %v", err)
	}
	if err := os.WriteFile(filepath.Join(fakeBin, "pgrep"), []byte("#!/bin/bash\nexit 1\n"), 0o755); err != nil {
		t.Fatalf("写假 pgrep 失败: %v", err)
	}
	// os.Environ() 会带上这里设置的 PATH，spawnScript 注入 env 时原样透传。
	t.Setenv("PATH", fakeBin+string(os.PathListSeparator)+os.Getenv("PATH"))

	if err := os.WriteFile(filepath.Join(root, "zviewer-backend"), []byte("OLD"), 0o755); err != nil {
		t.Fatalf("写旧后端失败: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(root, "config"), 0o755); err != nil {
		t.Fatalf("建 config 失败: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "config", "config.json"), []byte("keep"), 0o644); err != nil {
		t.Fatalf("写 config 失败: %v", err)
	}

	scriptBody, err := os.ReadFile(filepath.Join("..", "..", "..", "packaging", "install-update.sh"))
	if err != nil {
		t.Skipf("找不到发行包脚本: %v", err)
	}

	svc := New(root, nil)
	svc.GOOS = "linux"
	svc.dockerFn = func() bool { return true } // 容器模式：不自行拉起后端
	archive := makeTarGz(t, map[string]string{
		"zviewer-backend":   "NEW",
		"install-update.sh": string(scriptBody),
	})

	if _, err := svc.ApplyUpdateFromFile(context.Background(), archive, "update.tar.gz", nil); err != nil {
		t.Fatalf("应用更新失败: %v", err)
	}

	deadline := time.Now().Add(30 * time.Second)
	for {
		raw, err := os.ReadFile(filepath.Join(root, "zviewer-backend"))
		if err == nil && string(raw) == "NEW" {
			break
		}
		if time.Now().After(deadline) {
			logRaw, _ := os.ReadFile(filepath.Join(root, "update.log"))
			t.Fatalf("等待后端被替换超时，update.log:\n%s", logRaw)
		}
		time.Sleep(200 * time.Millisecond)
	}

	// 脚本的 docker 分支必须留标记，否则 entrypoint 会把这次退出当成崩溃
	if _, err := os.Stat(filepath.Join(root, ".restart-backend")); err != nil {
		t.Fatalf("缺少重启标记: %v", err)
	}
	if raw, err := os.ReadFile(filepath.Join(root, "config", "config.json")); err != nil || string(raw) != "keep" {
		t.Fatalf("config 被动过: %q err=%v", raw, err)
	}
	if _, err := os.Stat(filepath.Join(root, "apply-update.sh")); !os.IsNotExist(err) {
		t.Fatal("运行脚本应在收尾时自行删除")
	}
}
