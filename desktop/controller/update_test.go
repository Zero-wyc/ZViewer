package controller

import (
	"net/http"
	"net/http/httptest"
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

// TestFetchLatestReleaseFromMirror 覆盖镜像清单解析：版本号优先级、raw 直链拼接、
// 以及仓库还没有清单时按「暂无正式版」处理。
func TestFetchLatestReleaseFromMirror(t *testing.T) {
	old := updateMirrorBase
	defer func() { updateMirrorBase = old }()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/latest.json" {
			t.Errorf("应请求版本清单，实际 %q", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
		  "version": "5.1.0",
		  "publishedAt": "2026-10-29T10:00:00Z",
		  "releaseUrl": "https://github.com/Zero-wyc/ZViewer/releases/tag/v5.1.0",
		  "assets": [
		    {"name": "zviewer-windows-x64.zip", "size": 1024},
		    {"name": "zviewer-windows-x64-GUI.zip", "size": 2048}
		  ]
		}`))
	}))
	defer server.Close()
	updateMirrorBase = server.URL

	info, err := fetchLatestReleaseFromMirror("5.0.0")
	if err != nil {
		t.Fatalf("不应报错: %v", err)
	}
	if info.Tag != "v5.1.0" {
		t.Fatalf("tag 应由 version 拼出，实际 %q", info.Tag)
	}
	if info.URL != "https://github.com/Zero-wyc/ZViewer/releases/tag/v5.1.0" {
		t.Fatalf("发布页地址异常: %q", info.URL)
	}
	if len(info.Assets) != 2 {
		t.Fatalf("产物数量异常: %+v", info.Assets)
	}
	if info.Assets[1].URL != server.URL+"/zviewer-windows-x64-GUI.zip" {
		t.Fatalf("下载地址应由 raw 前缀拼出: %q", info.Assets[1].URL)
	}
	asset, ok := pickUpdateAsset(info.Assets)
	if !ok || asset.Size != 2048 {
		t.Fatalf("应挑到 GUI 运行包: %+v ok=%v", asset, ok)
	}

	// 清单不存在 = 还没跑过正式发版，按「暂无正式版」处理，不该弹错误。
	missing := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	}))
	defer missing.Close()
	updateMirrorBase = missing.URL
	if _, err := fetchLatestReleaseFromMirror("5.0.0"); err != errNoRelease {
		t.Fatalf("404 应返回 errNoRelease，实际 %v", err)
	}
}

// TestMirrorAssetDownloadCandidates 确认镜像源拿到的 Gitee raw 直链不会被套上反代。
func TestMirrorAssetDownloadCandidates(t *testing.T) {
	asset := releaseAsset{
		Name: "zviewer-windows-x64-GUI.zip",
		URL:  "https://gitee.com/Zero-wyc/ZviewerRelease/raw/main/zviewer-windows-x64-GUI.zip",
	}
	first, fallback := downloadCandidates(asset, "https://gh-proxy.com", updateSourceGitCode)
	if first != asset.URL || fallback != "" {
		t.Fatalf("镜像源应直连: %q / %q", first, fallback)
	}
	if !allowedUpdateHost("gitee.com", nil) {
		t.Fatal("Gitee 域名应在下载白名单内")
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
