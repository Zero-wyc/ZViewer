package updater

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// packaged = 更新包自带 install-update.sh，安装策略跟着包走。

const sampleInstaller = `#!/bin/bash
# zviewer-installer: 1
# 样例：只用来验证「被选中」而不是真的装东西
echo "installed from package"
`

// TestApplyUpdateUsesPackagedInstaller 包内脚本优先于内嵌模板。
func TestApplyUpdateUsesPackagedInstaller(t *testing.T) {
	svc, spawned := newApplyService(t, "linux")
	archive := makeTarGz(t, map[string]string{
		"zviewer-backend":   "ELF",
		"install-update.sh": sampleInstaller,
	})

	if _, err := svc.ApplyUpdateFromFile(context.Background(), archive, "update.tar.gz", nil); err != nil {
		t.Fatalf("应用更新失败: %v", err)
	}

	want := filepath.Join(svc.Root, "apply-update.sh")
	if spawned.script != want {
		t.Fatalf("应拉起 %q，实际 %q", want, spawned.script)
	}

	raw, err := os.ReadFile(spawned.script)
	if err != nil {
		t.Fatalf("读脚本失败: %v", err)
	}
	// 关键：落地的必须是包里的原样字节，更新器不能改写策略。
	if string(raw) != sampleInstaller {
		t.Fatalf("落地脚本被改写:\n%s", raw)
	}
	info, err := os.Stat(spawned.script)
	if err != nil {
		t.Fatalf("stat 失败: %v", err)
	}
	if info.Mode().Perm()&0o100 == 0 {
		t.Fatalf("脚本缺少执行位: %v", info.Mode())
	}

	// 运行环境通过环境变量下发，脚本自己不去猜路径。
	if got := spawned.envValue("ZVIEWER_UPDATE_ROOT"); got != svc.Root {
		t.Fatalf("ROOT 不对: %q", got)
	}
	if got, wantTemp := spawned.envValue("ZVIEWER_UPDATE_TEMP"), filepath.Join(svc.Root, ".update-temp"); got != wantTemp {
		t.Fatalf("TEMP 不对: %q", got)
	}
	if got, wantDir := spawned.envValue("ZVIEWER_UPDATE_EXTRACTED"), filepath.Join(svc.Root, ".update-temp"); got != wantDir {
		t.Fatalf("EXTRACTED 不对: %q", got)
	}
	if got := spawned.envValue("ZVIEWER_UPDATE_MODE"); got != "native" {
		t.Fatalf("MODE 不对: %q", got)
	}
}

// TestApplyUpdatePackagedInstallerDockerMode 容器里下发的 MODE 必须是 docker。
func TestApplyUpdatePackagedInstallerDockerMode(t *testing.T) {
	svc, spawned := newApplyService(t, "linux")
	svc.dockerFn = func() bool { return true }
	archive := makeTarGz(t, map[string]string{
		"zviewer-backend":   "ELF",
		"install-update.sh": sampleInstaller,
	})

	if _, err := svc.ApplyUpdateFromFile(context.Background(), archive, "update.tar.gz", nil); err != nil {
		t.Fatalf("应用更新失败: %v", err)
	}
	if got := spawned.envValue("ZVIEWER_UPDATE_MODE"); got != "docker" {
		t.Fatalf("MODE 应为 docker，实际 %q", got)
	}
	if got := spawned.envValue("ZVIEWER_UPDATE_TAG"); got != "[Docker 更新脚本]" {
		t.Fatalf("TAG 不对: %q", got)
	}
}

// TestApplyUpdateWindowsPackagedInstaller 包内 bat 用 LF 也要转成 CRLF。
func TestApplyUpdateWindowsPackagedInstaller(t *testing.T) {
	svc, spawned := newApplyService(t, "windows")
	archive := makeZip(t, map[string]string{
		"zviewer-backend.exe": "MZ",
		"install-update.bat":  "REM zviewer-installer: 1\n@echo off\n",
	})

	if _, err := svc.ApplyUpdateFromFile(context.Background(), archive, "update.zip", nil); err != nil {
		t.Fatalf("应用更新失败: %v", err)
	}
	if want := filepath.Join(svc.Root, "apply-update.bat"); spawned.script != want {
		t.Fatalf("应拉起 %q，实际 %q", want, spawned.script)
	}
	raw, err := os.ReadFile(spawned.script)
	if err != nil {
		t.Fatalf("读脚本失败: %v", err)
	}
	if trimmed := strings.ReplaceAll(string(raw), "\r\n", ""); strings.Contains(trimmed, "\n") {
		t.Fatalf("bat 里存在裸 LF: %q", raw)
	}
}

// TestApplyUpdateRejectsNewerInstallerAPI 包比更新器新时拒绝执行。
//
// 硬跑会做出半截安装：脚本可能依赖这一版更新器还不会注入的变量。
func TestApplyUpdateRejectsNewerInstallerAPI(t *testing.T) {
	svc, spawned := newApplyService(t, "linux")
	archive := makeTarGz(t, map[string]string{
		"zviewer-backend":   "ELF",
		"install-update.sh": "#!/bin/bash\n# zviewer-installer: 2\necho hi\n",
	})

	_, err := svc.ApplyUpdateFromFile(context.Background(), archive, "update.tar.gz", nil)
	if err == nil {
		t.Fatal("契约版本更高时应报错")
	}
	if !strings.Contains(err.Error(), "v2") {
		t.Fatalf("错误信息应点明版本: %v", err)
	}
	if spawned.script != "" {
		t.Fatalf("拒绝时不该拉起脚本，实际 %q", spawned.script)
	}
	// 失败必须清临时目录，不能让半截包留在安装目录里
	if _, statErr := os.Stat(filepath.Join(svc.Root, ".update-temp")); !os.IsNotExist(statErr) {
		t.Fatalf("失败后应清理 .update-temp，stat=%v", statErr)
	}
}

// TestFindPackagedInstallerRejectsNonRegular 符号链接 / 目录都不接受。
func TestFindPackagedInstallerRejectsNonRegular(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "real.sh")
	if err := os.WriteFile(target, []byte(sampleInstaller), 0o755); err != nil {
		t.Fatalf("写目标失败: %v", err)
	}
	link := filepath.Join(dir, "install-update.sh")
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("当前环境不支持符号链接: %v", err)
	}

	if _, err := findPackagedInstaller(dir, false); err == nil {
		t.Fatal("符号链接应被拒绝")
	}
}

// TestFindPackagedInstallerRejectsOversized 超过上限的脚本拒绝。
func TestFindPackagedInstallerRejectsOversized(t *testing.T) {
	dir := t.TempDir()
	body := "# zviewer-installer: 1\n" + strings.Repeat("# padding\n", maxInstallerSize/10)
	if err := os.WriteFile(filepath.Join(dir, "install-update.sh"), []byte(body), 0o755); err != nil {
		t.Fatalf("写脚本失败: %v", err)
	}
	if _, err := findPackagedInstaller(dir, false); err == nil {
		t.Fatal("超大脚本应被拒绝")
	}
}

// TestFindPackagedInstallerRequiresContract 没有契约声明就无法判断适配性。
func TestFindPackagedInstallerRequiresContract(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "install-update.sh"), []byte("#!/bin/bash\necho hi\n"), 0o755); err != nil {
		t.Fatalf("写脚本失败: %v", err)
	}
	if _, err := findPackagedInstaller(dir, false); err == nil {
		t.Fatal("缺契约声明应被拒绝")
	}
}

// TestFindPackagedInstallerAbsentIsNotError 旧包没有脚本是正常情况。
func TestFindPackagedInstallerAbsentIsNotError(t *testing.T) {
	dir := t.TempDir()
	installer, err := findPackagedInstaller(dir, false)
	if err != nil {
		t.Fatalf("不该报错: %v", err)
	}
	if installer != nil {
		t.Fatalf("不该找到脚本: %+v", installer)
	}
}

// TestParseInstallerAPI 契约声明的位置与写法。
func TestParseInstallerAPI(t *testing.T) {
	cases := []struct {
		name    string
		content string
		want    int
		wantErr bool
	}{
		{"sh 注释", "#!/bin/bash\n# zviewer-installer: 1\n", 1, false},
		{"bat REM", "@echo off\r\nREM zviewer-installer: 1\r\n", 1, false},
		{"大小写不敏感", "REM ZViewer-Installer: 3\n", 3, false},
		{"无声明", "#!/bin/bash\necho hi\n", 0, true},
		{"声明在第 17 行", strings.Repeat("# x\n", 16) + "# zviewer-installer: 1\n", 0, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseInstallerAPI([]byte(tc.content))
			if tc.wantErr {
				if err == nil {
					t.Fatalf("应报错，实际 %d", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("不该报错: %v", err)
			}
			if got != tc.want {
				t.Fatalf("契约版本应为 %d，实际 %d", tc.want, got)
			}
		})
	}
}
