package updater

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestSourcePreferenceDefaultsToMirror 覆盖三个状态：文件缺失、显式关闭、文件损坏。
func TestSourcePreferenceDefaultsToMirror(t *testing.T) {
	root := t.TempDir()
	if !ReadSourcePreference(root) {
		t.Fatal("文件缺失时应默认走镜像源")
	}
	if got := SourcePreferencePath(root); !strings.HasSuffix(got, filepath.Join("config", "update-source.json")) {
		t.Fatalf("偏好文件应落在 config/ 下，实际 %q", got)
	}
	if err := WriteSourcePreference(root, false); err != nil {
		t.Fatalf("写入偏好失败: %v", err)
	}
	if ReadSourcePreference(root) {
		t.Fatal("写入 false 后应读回 false")
	}
	if err := WriteSourcePreference(root, true); err != nil {
		t.Fatalf("再次写入失败: %v", err)
	}
	if !ReadSourcePreference(root) {
		t.Fatal("写入 true 后应读回 true")
	}
	if err := os.WriteFile(SourcePreferencePath(root), []byte("not json"), 0o644); err != nil {
		t.Fatalf("写坏文件失败: %v", err)
	}
	if !ReadSourcePreference(root) {
		t.Fatal("文件损坏时应回落到默认镜像源")
	}
}

// TestUpdateSourcePrecedence 覆盖优先级：显式字段 > 环境变量 > 文件。
func TestUpdateSourcePrecedence(t *testing.T) {
	root := t.TempDir()
	svc := New(root, nil)
	if got := svc.updateSource(); got != SourceGitCode {
		t.Fatalf("默认应为镜像源，实际 %q", got)
	}

	if err := WriteSourcePreference(root, false); err != nil {
		t.Fatalf("写入偏好失败: %v", err)
	}
	if got := svc.updateSource(); got != SourceGitHub {
		t.Fatalf("偏好关闭后应为 github，实际 %q", got)
	}

	t.Setenv("ZVIEWER_UPDATE_SOURCE", "gitcode")
	if got := svc.updateSource(); got != SourceGitCode {
		t.Fatalf("环境变量应覆盖文件，实际 %q", got)
	}

	// mirror 是镜像源的别名，必须归一到同一个源标识。
	t.Setenv("ZVIEWER_UPDATE_SOURCE", "mirror")
	if got := svc.updateSource(); got != SourceGitCode {
		t.Fatalf("别名 mirror 应归一到镜像源，实际 %q", got)
	}

	svc.Source = SourceGitHub
	if got := svc.updateSource(); got != SourceGitHub {
		t.Fatalf("显式字段应覆盖环境变量，实际 %q", got)
	}
}

// TestFetchMirrorManifest 校验清单解析：tag 缺失时用 version 拼，
// 产物地址由 raw 前缀拼出来（清单里只存文件名）。
func TestFetchMirrorManifest(t *testing.T) {
	root := t.TempDir()

	var gotPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
		  "version": "5.1.0",
		  "commit": "abc1234",
		  "publishedAt": "2026-10-29T10:00:00Z",
		  "releaseUrl": "https://github.com/Zero-wyc/ZViewer/releases/tag/v5.1.0",
		  "notes": "修复若干问题",
		  "assets": [
		    {"name": "zviewer-windows-x64.zip", "size": 2048, "sha256": "aa"},
		    {"name": "zviewer-linux-x64.tar.gz", "size": 1024, "sha256": "bb"}
		  ]
		}`))
	}))
	defer server.Close()

	svc := New(root, nil)
	svc.MirrorBase = server.URL

	releases, err := svc.fetchMirrorReleases(context.Background())
	if err != nil {
		t.Fatalf("不应报错: %v", err)
	}
	if gotPath != "/latest.json" {
		t.Fatalf("应请求版本清单，实际 %q", gotPath)
	}
	if len(releases) != 1 {
		t.Fatalf("应只有一条版本，实际 %d", len(releases))
	}
	release := releases[0]
	if release.TagName != "v5.1.0" {
		t.Fatalf("tag 应由 version 拼出: %q", release.TagName)
	}
	if release.Prerelease {
		t.Fatal("产物仓库只放正式版，不应标预发布")
	}
	if release.PublishedAt == nil || *release.PublishedAt != "2026-10-29T10:00:00Z" {
		t.Fatalf("发布时间解析异常: %+v", release.PublishedAt)
	}
	if release.Body == nil || *release.Body != "修复若干问题" {
		t.Fatalf("更新说明解析异常: %+v", release.Body)
	}
	if len(release.Assets) != 2 {
		t.Fatalf("产物数量异常: %+v", release.Assets)
	}
	// GitCode 的 raw 端点强制要求 ?ref=，拼地址时必须带上，否则会 404。
	if got := release.Assets[0].BrowserDownloadURL; got != server.URL+"/zviewer-windows-x64.zip?ref="+mirrorRef {
		t.Fatalf("下载地址应由 raw 前缀拼出: %q", got)
	}
	if release.Assets[0].Size != 2048 {
		t.Fatalf("产物大小异常: %d", release.Assets[0].Size)
	}
}

// TestGetUpdateInfoFromMirror 走镜像源：来源标记、版本、附件地址都要对。
func TestGetUpdateInfoFromMirror(t *testing.T) {
	root := t.TempDir()
	writePackageJSON(t, root, "5.0.0")

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
		  "tag": "v5.1.0",
		  "version": "5.1.0",
		  "publishedAt": "2026-10-29T10:00:00Z",
		  "releaseUrl": "https://github.com/Zero-wyc/ZViewer/releases/tag/v5.1.0",
		  "assets": [
		    {"name": "zviewer-windows-x64.zip", "size": 2048},
		    {"name": "zviewer-windows-x64-GUI.zip", "size": 4096}
		  ]
		}`))
	}))
	defer server.Close()

	svc := New(root, nil)
	svc.Source = SourceGitCode
	svc.MirrorBase = server.URL
	svc.GOOS = "windows"
	svc.SetSettingsReader(func(context.Context) (bool, string, error) { return false, "", nil })

	info, err := svc.GetUpdateInfo(context.Background(), false)
	if err != nil {
		t.Fatalf("不应报错: %v", err)
	}
	if info.Source != SourceGitCode {
		t.Fatalf("来源应为镜像源，实际 %q", info.Source)
	}
	if info.RemoteVersion != "v5.1.0" || !info.HasUpdate || info.AssetSize != 2048 {
		t.Fatalf("结果异常: %+v", info)
	}
	if info.DownloadURL != server.URL+"/zviewer-windows-x64.zip?ref="+mirrorRef {
		t.Fatalf("下载地址异常: %q", info.DownloadURL)
	}
	if info.ReleaseURL != "https://github.com/Zero-wyc/ZViewer/releases/tag/v5.1.0" {
		t.Fatalf("发布页地址异常: %q", info.ReleaseURL)
	}
}

// TestMirrorAssetURLOverride 确认清单里显式给了 url 时优先用它。
//
// 这个口子是给「换下载通道只改 CI」留的：以后如果 GitCode 那边不行了，
// 脚本改一下 latest.json 里的 url 就能切走，不用等客户端发版。
func TestMirrorAssetURLOverride(t *testing.T) {
	root := t.TempDir()
	writePackageJSON(t, root, "5.0.0")

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
		  "tag": "v5.1.0",
		  "assets": [
		    {"name": "zviewer-windows-x64.zip", "size": 2048,
		     "url": "https://cdn.example.com/pkgs/zviewer-windows-x64.zip"}
		  ]
		}`))
	}))
	defer server.Close()

	svc := New(root, nil)
	svc.MirrorBase = server.URL
	releases, err := svc.fetchMirrorReleases(context.Background())
	if err != nil {
		t.Fatalf("不应报错: %v", err)
	}
	if got := releases[0].Assets[0].BrowserDownloadURL; got != "https://cdn.example.com/pkgs/zviewer-windows-x64.zip" {
		t.Fatalf("应优先用清单里的 url，实际 %q", got)
	}
}

// TestGetUpdateInfoMirrorFailureErrors：镜像拉取失败必须直接报错，不能偷偷回退 GitHub。
func TestGetUpdateInfoMirrorFailureErrors(t *testing.T) {
	root := t.TempDir()
	writePackageJSON(t, root, "5.0.0")

	mirror := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	defer mirror.Close()

	githubHits := 0
	github := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		githubHits++
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[]`))
	}))
	defer github.Close()

	svc := New(root, nil)
	svc.Source = SourceGitCode
	svc.MirrorBase = mirror.URL
	svc.APIBase = github.URL
	svc.GOOS = "windows"
	svc.SetSettingsReader(func(context.Context) (bool, string, error) { return false, "", nil })

	if _, err := svc.GetUpdateInfo(context.Background(), false); err == nil {
		t.Fatal("镜像失败时应报错")
	} else if !strings.Contains(err.Error(), "镜像更新源不可用") {
		t.Fatalf("错误文案应指明更新源: %v", err)
	}
	if githubHits != 0 {
		t.Fatalf("不应回退 GitHub，实际请求了 %d 次", githubHits)
	}
}

// TestMirrorEmptyAssetsErrors：清单还没有产物（CI 没跑过正式发版）同样直接报错。
func TestMirrorEmptyAssetsErrors(t *testing.T) {
	root := t.TempDir()
	writePackageJSON(t, root, "5.0.0")

	githubHits := 0
	mirror := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"tag": "v5.1.0", "assets": []}`))
	}))
	defer mirror.Close()

	github := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		githubHits++
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[]`))
	}))
	defer github.Close()

	svc := New(root, nil)
	svc.Source = SourceGitCode
	svc.MirrorBase = mirror.URL
	svc.APIBase = github.URL
	svc.GOOS = "windows"
	svc.SetSettingsReader(func(context.Context) (bool, string, error) { return false, "", nil })

	if _, err := svc.GetUpdateInfo(context.Background(), false); err == nil {
		t.Fatal("清单无产物时应报错")
	} else if !strings.Contains(err.Error(), "没有任何平台产物") {
		t.Fatalf("错误文案应说明清单里没有产物: %v", err)
	}
	if githubHits != 0 {
		t.Fatalf("不应回退 GitHub，实际请求了 %d 次", githubHits)
	}
}
