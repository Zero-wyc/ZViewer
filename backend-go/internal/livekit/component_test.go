package livekit

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// 组件库的取用顺序是「境内镜像 → GitHub 产物仓库 → 官方 Release」：
// 前两个是本项目自己的产物仓，最后一个才是上游。顺序变了就等于国内用户
// 又开始走境外链路，锁一下。
func TestComponentSourcesOrder(t *testing.T) {
	sources, err := componentSources()
	if err != nil {
		t.Fatalf("componentSources: %v", err)
	}
	if len(sources) != 3 {
		t.Fatalf("期望 3 个下载源，得到 %d", len(sources))
	}
	if !strings.HasPrefix(sources[0], "https://api.gitcode.com/api/v5/repos/Zero-wyc/ZviewerRelease/raw/") {
		t.Errorf("首个源应为 GitCode 直链，得到 %q", sources[0])
	}
	if !strings.Contains(sources[0], "ref=components") {
		t.Errorf("GitCode 直链必须带 ?ref=components，得到 %q", sources[0])
	}
	if !strings.Contains(sources[1], "raw.githubusercontent.com/Zero-wyc/ZviewerRelease/components/") {
		t.Errorf("第二个源应为产物仓库的 GitHub raw，得到 %q", sources[1])
	}
	if !strings.Contains(sources[2], "livekit-server/releases/download/"+BinaryVersion+"/") {
		t.Errorf("第三个源应为官方 Release，得到 %q", sources[2])
	}
}

// 文件名必须与 build-all.js / 组件库里的名字一致，否则直链 404。
func TestComponentFileName(t *testing.T) {
	name, err := componentFileName()
	if err != nil {
		t.Fatalf("componentFileName: %v", err)
	}
	want := "livekit_" + strings.TrimPrefix(BinaryVersion, "v") + "_" + runtime.GOOS + "_" + runtime.GOARCH
	if runtime.GOOS == "windows" {
		want += ".zip"
	} else {
		want += ".tar.gz"
	}
	if name != want {
		t.Errorf("componentFileName = %q, want %q", name, want)
	}
}

func TestStatusMissingComponent(t *testing.T) {
	dir := t.TempDir()
	m := New(Config{ExecDir: filepath.Join(dir, "exec"), DevBinDir: filepath.Join(dir, "dev"), Logf: func(string, ...any) {}})
	st := m.Status()
	if st.Available {
		t.Fatal("二进制缺失时不应报告可用")
	}
	if st.State != StateIdle {
		t.Errorf("缺失时状态应为 idle，得到 %q", st.State)
	}
	if st.Version != BinaryVersion {
		t.Errorf("版本应为 %q，得到 %q", BinaryVersion, st.Version)
	}
}

func TestStatusReadyWhenBinaryPresent(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, binName()), []byte("fake"), 0o755); err != nil {
		t.Fatal(err)
	}
	m := New(Config{ExecDir: dir, Logf: func(string, ...any) {}})
	st := m.Status()
	if !st.Available || st.State != StateReady {
		t.Fatalf("有二进制时应 ready，得到 available=%v state=%q", st.Available, st.State)
	}
}

// 外置 LiveKit（非桌面托管）：前端不该显示「下载组件」，后端也不该去装。
func TestStatusExternal(t *testing.T) {
	m := New(Config{External: true, Logf: func(string, ...any) {}})
	st := m.Status()
	if !st.Available || !st.External || st.State != StateExternal {
		t.Fatalf("外置模式状态不对: %+v", st)
	}
	if err := m.Install(context.Background()); !errors.Is(err, ErrExternalLiveKit) {
		t.Errorf("外置模式 Install 应返回 ErrExternalLiveKit，得到 %v", err)
	}
}

// 桌面壳托管（External + AllowDownload）：二进制由壳启动，但缺文件时仍要
// 让网页端看到「未下载」，这样房间里才能出现下载入口。
func TestStatusDesktopManagedMissing(t *testing.T) {
	dir := t.TempDir()
	m := New(Config{
		External:      true,
		AllowDownload: true,
		ExecDir:       filepath.Join(dir, "runtime"),
		Logf:          func(string, ...any) {},
	})
	st := m.Status()
	if st.Available {
		t.Fatal("桌面托管且文件缺失时应报告不可用（网页端据此显示下载按钮）")
	}
	if st.State != StateIdle {
		t.Errorf("状态应为 idle，得到 %q", st.State)
	}
}

// New 会把「非 External」的配置补成允许下载：自托管场景组件一定由后端管理。
func TestNewEnablesDownloadForSelfHosted(t *testing.T) {
	m := New(Config{ExecDir: t.TempDir(), Logf: func(string, ...any) {}})
	if !m.cfg.AllowDownload {
		t.Error("自托管（非 External）应默认允许下载组件")
	}
	m = New(Config{External: true, Logf: func(string, ...any) {}})
	if m.cfg.AllowDownload {
		t.Error("External 且未显式开启时不应允许下载")
	}
}

// 已经装好时重复点下载：返回 ErrAlreadyInstalled，不重新下载。
func TestInstallRejectsWhenAlreadyInstalled(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, binName()), []byte("fake"), 0o755); err != nil {
		t.Fatal(err)
	}
	m := New(Config{ExecDir: dir, Logf: func(string, ...any) {}})
	if err := m.Install(context.Background()); !errors.Is(err, ErrAlreadyInstalled) {
		t.Errorf("已安装时 Install 应返回 ErrAlreadyInstalled，得到 %v", err)
	}
}

// 安装落点优先可执行文件同目录（生产 runtime/），这也是 findBinary 的第一优先级。
func TestInstallDirPrefersExecDir(t *testing.T) {
	dir := t.TempDir()
	m := New(Config{ExecDir: filepath.Join(dir, "exec"), DevBinDir: filepath.Join(dir, "dev"), Logf: func(string, ...any) {}})
	if got := m.installDir(); got != filepath.Join(dir, "exec") {
		t.Errorf("installDir = %q，应优先 ExecDir", got)
	}
}
