package updater

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// checkFixture 是 gen-updater-fixtures.js 的产物。
type checkFixture struct {
	CurrentVersion    string                      `json:"currentVersion"`
	PlatformAssetHint map[string]string           `json:"platformAssetHint"`
	Cases             map[string]checkFixtureCase `json:"cases"`
}

type checkFixtureCase struct {
	IncludePrerelease bool            `json:"includePrerelease"`
	Releases          []githubRelease `json:"releases"`
	OK                *UpdateInfo     `json:"ok"`
	Error             string          `json:"error"`
}

func loadCheckFixture(t *testing.T) checkFixture {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", "check-expected.json"))
	if err != nil {
		t.Fatalf("读取夹具失败: %v", err)
	}
	var fx checkFixture
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatalf("解析夹具失败: %v", err)
	}
	return fx
}

// TestGetUpdateInfoMatchesNode 用 Node 真实实现产出的期望值校验版本判定。
//
// 夹具里的 asset 名是 Windows 版，所以 GOOS 固定成 windows —— 否则在
// Linux 上跑测试会去找 tar.gz，与夹具对不上。
func TestGetUpdateInfoMatchesNode(t *testing.T) {
	fx := loadCheckFixture(t)

	root := t.TempDir()
	writePackageJSON(t, root, fx.CurrentVersion)

	var releases []githubRelease
	lastPath := ""
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		lastPath = r.URL.RequestURI()
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(releases); err != nil {
			t.Errorf("写出假 releases 失败: %v", err)
		}
	}))
	defer server.Close()

	svc := New(root, nil)
	svc.APIBase = server.URL
	svc.GOOS = "windows"
	svc.SetSettingsReader(func(context.Context) (bool, string, error) { return false, "", nil })

	// 每个用例都走同一个路径，逐条确认请求形状没变。
	wantPath := "/repos/Zero-wyc/ZViewer/releases?per_page=10"

	for name, testCase := range fx.Cases {
		t.Run(name, func(t *testing.T) {
			releases = testCase.Releases
			lastPath = ""

			info, err := svc.GetUpdateInfo(context.Background(), testCase.IncludePrerelease)
			if lastPath != wantPath {
				t.Fatalf("请求路径应为 %q，实际 %q", wantPath, lastPath)
			}

			if testCase.Error != "" {
				if err == nil {
					t.Fatalf("期望错误 %q，实际成功: %+v", testCase.Error, info)
				}
				if err.Error() != testCase.Error {
					t.Fatalf("错误文案不一致:\n  期望 %q\n  实际 %q", testCase.Error, err.Error())
				}
				return
			}
			if err != nil {
				t.Fatalf("不应报错: %v", err)
			}
			if !reflect.DeepEqual(info, testCase.OK) {
				t.Fatalf("UpdateInfo 不一致:\n  期望 %+v\n  实际 %+v", testCase.OK, info)
			}
		})
	}
}

// TestCheckUpdateIgnoresCDN：检查更新直连 API，CDN 前缀只用于下载。
//
// 网关把 api.github.com 也套上代理时，代理方共用出口 IP 很容易被
// GitHub 判成滥用（403 rate limit）。这条断言把「不许加前缀」钉死。
func TestCheckUpdateIgnoresCDN(t *testing.T) {
	fx := loadCheckFixture(t)
	root := t.TempDir()
	writePackageJSON(t, root, fx.CurrentVersion)

	path := ""
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.Path
		_, _ = w.Write([]byte("[]"))
	}))
	defer server.Close()

	svc := New(root, nil)
	svc.APIBase = server.URL
	svc.GOOS = "windows"
	svc.SetSettingsReader(func(context.Context) (bool, string, error) {
		return true, "https://gh-proxy.example", nil
	})

	// releases 为空 → 报「未找到任何发布版本」，但请求已经发出去了。
	if _, err := svc.GetUpdateInfo(context.Background(), false); err == nil {
		t.Fatal("空 releases 应报错")
	}
	if path != "/repos/Zero-wyc/ZViewer/releases" {
		t.Fatalf("API 请求路径不应被 CDN 改写，实际 %q", path)
	}
}

// TestSelectReleaseLocalVersionBranches 覆盖本地版本为 0.0.0 / dev 的两组分支。
//
// Node 的本地版本取自 package.json，进程内改不了，所以这两组只能在 Go 侧直接测。
func TestSelectReleaseLocalVersionBranches(t *testing.T) {
	releases := []githubRelease{
		{TagName: "latest", Prerelease: true},
		{TagName: "v1.2.0"},
	}

	cases := []struct {
		name      string
		current   string
		pre       bool
		wantTag   string
		wantFresh bool
	}{
		{"未知版本走正式版", "0.0.0", false, "v1.2.0", true},
		{"未知版本走预发布", "0.0.0", true, "latest", true},
		{"dev 版本视为落后于正式版", "0.0.0-dev.abc1234", false, "v1.2.0", true},
		{"dev 版本跟随最新构建", "0.0.0-dev.abc1234", true, "latest", true},
		{"同版本不算更新", "1.2.0", false, "v1.2.0", false},
		{"更高版本不算更新", "1.3.0", false, "v1.2.0", false},
		{"更低版本算更新", "1.1.9", false, "v1.2.0", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			release, hasUpdate := selectRelease(releases, tc.current, tc.pre)
			if release.TagName != tc.wantTag || hasUpdate != tc.wantFresh {
				t.Fatalf("得到 %s/%v，期望 %s/%v",
					release.TagName, hasUpdate, tc.wantTag, tc.wantFresh)
			}
		})
	}

	// 一个正式版都没有：拿到第一条当信息源，但不提示更新。
	preOnly := []githubRelease{{TagName: "latest", Prerelease: true}}
	release, hasUpdate := selectRelease(preOnly, "1.0.0", false)
	if release.TagName != "latest" || hasUpdate {
		t.Fatalf("只有预发布时应 hasUpdate=false，得到 %s/%v", release.TagName, hasUpdate)
	}
}

// TestCompareVersions 锁定 JS 的逐段比较语义。
//
// 最后两条是 JS 的真实行为（prerelease 按字典序，`beta.2` > `beta.10`），
// 看着反直觉但 Node 一直这么跑，Go 必须一致——否则同一个 release 在
// Node 版和 Go 版会给出相反的「有没有更新」。
func TestCompareVersions(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"v1.0.0", "1.0.0", 0},
		{"1.2.0", "1.10.0", -1},
		{"1.10.0", "1.2.0", 1},
		{"1.2.0-beta.1", "1.2.0", -1},
		{"1.2.0", "1.2.0-beta.1", 1},
		{"1.2.0-beta.2", "1.2.0-beta.10", 1},
		{"1.2.0-beta.10", "1.2.0-beta.2", -1},
		{"1.2", "1.2.0", 0},
		{"1.2.0", "1.2.1", -1},
		{"", "1.0.0", -1},
	}
	for _, tc := range cases {
		if got := CompareVersions(tc.a, tc.b); got != tc.want {
			t.Errorf("CompareVersions(%q,%q)=%d，期望 %d", tc.a, tc.b, got, tc.want)
		}
	}
}

// TestPlatformAssetName 钉住两个平台的产物名。
func TestPlatformAssetName(t *testing.T) {
	if got := PlatformAssetName("windows"); got != "zviewer-windows-x64.zip" {
		t.Fatalf("windows 产物名错: %s", got)
	}
	for _, goos := range []string{"linux", "darwin"} {
		if got := PlatformAssetName(goos); got != "zviewer-linux-x64.tar.gz" {
			t.Fatalf("%s 产物名错: %s", goos, got)
		}
	}
}

// TestLocalVersionFallback 读不到 package.json 时返回 0.0.0 而不是报错。
func TestLocalVersionFallback(t *testing.T) {
	if got := LocalVersion(t.TempDir()); got != "0.0.0" {
		t.Fatalf("缺 package.json 应返回 0.0.0，得到 %q", got)
	}
	root := t.TempDir()
	writePackageJSON(t, root, "2.3.4")
	if got := LocalVersion(root); got != "2.3.4" {
		t.Fatalf("应读到 2.3.4，得到 %q", got)
	}
}

func writePackageJSON(t *testing.T, root, version string) {
	t.Helper()
	content := `{"version":"` + version + `"}`
	if err := os.WriteFile(filepath.Join(root, "package.json"), []byte(content), 0o644); err != nil {
		t.Fatalf("写 package.json 失败: %v", err)
	}
}

// TestApplyCDNToURL 逐条对齐 Node 的 applyCdnToUrl。
func TestApplyCDNToURL(t *testing.T) {
	const proxy = "https://gh-proxy.example/"
	cases := []struct{ in, want string }{
		{"https://github.com/a/b.zip", "https://gh-proxy.example/https://github.com/a/b.zip"},
		{"https://api.github.com/repos/a", "https://gh-proxy.example/https://api.github.com/repos/a"},
		{"https://objects.githubusercontent.com/x", "https://gh-proxy.example/https://objects.githubusercontent.com/x"},
		{"https://example.com/a.zip", "https://example.com/a.zip"},
		{"https://gh-proxy.example/https://github.com/a", "https://gh-proxy.example/https://github.com/a"},
		{"://broken", "://broken"},
	}
	for _, tc := range cases {
		if got := ApplyCDNToURL(tc.in, proxy); got != tc.want {
			t.Errorf("ApplyCDNToURL(%q)=%q，期望 %q", tc.in, got, tc.want)
		}
	}
	if got := ApplyCDNToURL("https://github.com/a", ""); got != "https://github.com/a" {
		t.Errorf("proxyURL 为空应原样返回，得到 %q", got)
	}
}

// TestIsDockerOnNonContainer 只断言「没有 /.dockerenv 且读不到 cgroup 时为 false」。
// 开发机与容器内都跑这套测试，所以只验证不会 panic、不误判成本机是容器。
func TestIsDockerStable(t *testing.T) {
	first := IsDocker()
	second := IsDocker()
	if first != second {
		t.Fatalf("IsDocker 结果不稳定: %v vs %v", first, second)
	}
	if _, err := os.Stat("/.dockerenv"); err != nil && first {
		if raw, readErr := os.ReadFile("/proc/1/cgroup"); readErr == nil {
			content := string(raw)
			if !strings.Contains(content, "docker") && !strings.Contains(content, "containerd") &&
				!strings.Contains(content, "kubepods") {
				t.Fatalf("非容器环境被误判为容器")
			}
		}
	}
}
