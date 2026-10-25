package controller

import (
	"strings"
	"testing"
)

func TestCompareVersions(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"0.4.2", "0.4.1", 1},
		{"v0.4.1", "0.4.1", 0},
		{"0.4.1", "0.4.10", -1},
		{"0.10.0", "0.9.9", 1},
		{"1.0", "1.0.0", 0},
		{"0.4.1-beta", "0.4.1", 0},
		{"", "0.1.0", -1},
	}
	for _, item := range cases {
		if got := compareVersions(item.a, item.b); got != item.want {
			t.Fatalf("compareVersions(%q,%q)=%d, want %d", item.a, item.b, got, item.want)
		}
	}
}

func TestPickUpdateAsset(t *testing.T) {
	assets := []releaseAsset{
		{Name: "zviewer-windows-x64.zip", Size: 1},
		{Name: "release-notes.txt", Size: 1},
		{Name: "zviewer-windows-x64-GUI.zip", Size: 2048},
	}
	asset, ok := pickUpdateAsset(assets)
	if !ok || asset.Name != "zviewer-windows-x64-GUI.zip" || asset.Size != 2048 {
		t.Fatalf("unexpected asset: %+v ok=%v", asset, ok)
	}
	if _, ok := pickUpdateAsset(assets[:2]); ok {
		t.Fatal("should not pick a non-GUI package")
	}
}

func TestApplyScriptWaitsForExit(t *testing.T) {
	script := applyScript(`C:\Users\Zero\AppData\Roaming\ZViewer\updates\0.4.2\zviewer-windows-x64-GUI.zip`,
		`C:\Apps\ZViewer`, `C:\Apps\ZViewer\ZViewerDesktop.exe`, 4321)
	for _, want := range []string{
		"$procId = 4321",
		"Get-Process -Id $procId",
		"Expand-Archive",
		"Copy-Item",
		"$installed = Get-ChildItem",
		"remove stale entry",
		"Start-Process -FilePath $next",
	} {
		if !strings.Contains(script, want) {
			t.Fatalf("script missing %q", want)
		}
	}
	if !strings.Contains(script, `'C:\Users\Zero\AppData\Roaming\ZViewer\updates\0.4.2\zviewer-windows-x64-GUI.zip'`) {
		t.Fatal("path should be single quoted")
	}
}

func TestIsShellEntry(t *testing.T) {
	cases := []struct {
		name string
		want bool
	}{
		{"zviewer-windows-x64-GUI/ZViewerDesktop.exe", true},
		{"zviewer-windows-x64-GUI/ZViewerShell.exe", true},
		{"zviewer-windows-x64-GUI/runtime/zviewer-backend.exe", false},
		{"zviewer-windows-x64-GUI/README.md", false},
	}
	for _, item := range cases {
		if got := isShellEntry(item.name); got != item.want {
			t.Fatalf("isShellEntry(%q)=%v, want %v", item.name, got, item.want)
		}
	}
}

func TestVersionParts(t *testing.T) {
	if parts := versionParts("v0.4.1"); len(parts) != 3 || parts[0] != 0 || parts[2] != 1 {
		t.Fatalf("unexpected parts: %v", parts)
	}
	if parts := versionParts("2.1.0+build7"); len(parts) != 3 || parts[1] != 1 {
		t.Fatalf("unexpected parts: %v", parts)
	}
}

func TestNormalizeUpdateProxy(t *testing.T) {
	cases := []struct {
		in    string
		want  string
		fails bool
	}{
		{"", "", false},
		{DefaultUpdateProxy, DefaultUpdateProxy, false},
		{"  https://gh-proxy.com/  ", "https://gh-proxy.com", false},
		{"https://ghproxy.net/gh", "https://ghproxy.net/gh", false},
		{"http://gh-proxy.com", "", true},
		{"gh-proxy.com", "", true},
		{"https://gh-proxy.com/?a=1", "", true},
	}
	for _, item := range cases {
		got, err := NormalizeUpdateProxy(item.in)
		if (err != nil) != item.fails || got != item.want {
			t.Fatalf("NormalizeUpdateProxy(%q)=(%q,%v), want (%q, fails=%v)", item.in, got, err, item.want, item.fails)
		}
	}
}

func TestDownloadCandidates(t *testing.T) {
	asset := releaseAsset{ID: 659024627, Name: "zviewer-windows-x64-GUI.zip", URL: "https://github.com/o/r/releases/download/v1/zviewer-windows-x64-GUI.zip"}
	first, fallback := downloadCandidates(asset, DefaultUpdateProxy, updateSourceGitHub)
	if first != DefaultUpdateProxy+"/"+asset.URL {
		t.Fatalf("proxy url = %q", first)
	}
	if fallback != "https://api.github.com/repos/Zero-wyc/ZViewer/releases/assets/659024627" {
		t.Fatalf("fallback = %q", fallback)
	}
	first, fallback = downloadCandidates(asset, "", updateSourceGitHub)
	if first != "https://api.github.com/repos/Zero-wyc/ZViewer/releases/assets/659024627" || fallback != "" {
		t.Fatalf("direct candidates = %q / %q", first, fallback)
	}
}

func TestAllowedUpdateHost(t *testing.T) {
	allow := []string{"gh-proxy.com"}
	for _, host := range []string{"github.com", "api.github.com", "gh-proxy.com", "GH-PROXY.COM"} {
		if !allowedUpdateHost(host, allow) {
			t.Fatalf("%s should be allowed", host)
		}
	}
	for _, host := range []string{"evil.example", "", "ghproxy.net"} {
		if allowedUpdateHost(host, allow) {
			t.Fatalf("%s should be rejected", host)
		}
	}
	if publicHost("127.0.0.1") || publicHost("localhost") || publicHost("192.168.1.2") || publicHost("::1") {
		t.Fatal("internal hosts must not pass publicHost")
	}
	if !publicHost("gh-proxy.com") || !publicHost("8.8.8.8") {
		t.Fatal("public hosts should pass")
	}
}

// TestPickGitCodeRelease 覆盖 GitCode 列表挑选：预发布、源码包与 tag 形状。
func TestPickGitCodeRelease(t *testing.T) {
	list := []releaseInfo{
		{Tag: "latest", ReleaseStatus: "pre", Name: "Latest Build (main)"},
		{Tag: "nightly", Prerelease: false},
		{
			Tag:  "v5.0.1",
			Name: "v5.0.1",
			Assets: []releaseAsset{
				{Name: "v5.0.1.zip", Type: "source", URL: "https://raw.gitcode.com/o/r/archive/v5.0.1.zip"},
				{Name: "zviewer-windows-x64-GUI.zip", Type: "attach", Size: 2048, URL: "https://gitcode.com/Zero-wyc/ZViewer/releases/download/v5.0.1/zviewer-windows-x64-GUI.zip"},
			},
		},
	}
	info, err := pickGitCodeRelease(list)
	if err != nil {
		t.Fatalf("不应报错: %v", err)
	}
	if info.Tag != "v5.0.1" {
		t.Fatalf("应跳过预发布与非法 tag，实际 %q", info.Tag)
	}
	if info.URL != "https://gitcode.com/Zero-wyc/ZViewer/releases/tag/v5.0.1" {
		t.Fatalf("发布页地址未补齐: %q", info.URL)
	}
	if len(info.Assets) != 1 || info.Assets[0].Name != "zviewer-windows-x64-GUI.zip" {
		t.Fatalf("源码包应被过滤: %+v", info.Assets)
	}
	asset, ok := pickUpdateAsset(info.Assets)
	if !ok || asset.Size != 2048 {
		t.Fatalf("应挑到 GUI 运行包: %+v ok=%v", asset, ok)
	}

	if _, err := pickGitCodeRelease(list[:2]); err != errNoRelease {
		t.Fatalf("只有预发布时应返回 errNoRelease，实际 %v", err)
	}
}

// TestGitCodeAssetDownloadCandidates 确认 GitCode 源不会套反代前缀。
func TestGitCodeAssetDownloadCandidates(t *testing.T) {
	asset := releaseAsset{
		ID:   9831,
		Name: "zviewer-windows-x64-GUI.zip",
		URL:  "https://gitcode.com/Zero-wyc/ZViewer/releases/download/v5.0.1/zviewer-windows-x64-GUI.zip",
	}
	first, fallback := downloadCandidates(asset, "", updateSourceGitCode)
	if first != asset.URL || fallback != "" {
		t.Fatalf("GitCode 源应直连: %q / %q", first, fallback)
	}
	if !allowedUpdateHost("gitcode.com", nil) || !allowedUpdateHost("raw.gitcode.com", nil) {
		t.Fatal("GitCode 域名应在下载白名单内")
	}
}

// TestDefaultConfigUsesGitCodeSource：默认必须是大陆镜像。
func TestDefaultConfigUsesGitCodeSource(t *testing.T) {
	if !DefaultConfig().UpdateGitCode {
		t.Fatal("默认更新源应为 GitCode")
	}
}

// TestValidateUpdateSourceDefault：老配置缺键时保持 GitCode，显式 false 才回 GitHub。
func TestValidateUpdateSourceDefault(t *testing.T) {
	base := map[string]any{
		"port": "3333", "rtmpPort": "3334", "flvPort": "3335",
		"livekitPort": "3336", "livekitTcpPort": "3337",
		"bindHost": "::", "https": false, "updateProxyUrl": "",
	}
	cfg, err := Validate(base)
	if err != nil {
		t.Fatalf("Validate 失败: %v", err)
	}
	if !cfg.UpdateGitCode {
		t.Fatal("缺省应保持 GitCode 源")
	}
	base["updateGitCode"] = false
	cfg, err = Validate(base)
	if err != nil {
		t.Fatalf("Validate 失败: %v", err)
	}
	if cfg.UpdateGitCode {
		t.Fatal("显式 false 应切回 GitHub")
	}
}
