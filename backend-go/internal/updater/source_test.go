package updater

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestSourcePreferenceDefaultsToGitCode 覆盖三个状态：文件缺失、显式关闭、文件损坏。
func TestSourcePreferenceDefaultsToGitCode(t *testing.T) {
	root := t.TempDir()
	if !ReadSourcePreference(root) {
		t.Fatal("文件缺失时应默认走 GitCode")
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
		t.Fatal("文件损坏时应回落到默认 GitCode")
	}
}

// TestUpdateSourcePrecedence 覆盖优先级：显式字段 > 环境变量 > 文件。
func TestUpdateSourcePrecedence(t *testing.T) {
	root := t.TempDir()
	svc := New(root, nil)
	if got := svc.updateSource(); got != SourceGitCode {
		t.Fatalf("默认应为 gitcode，实际 %q", got)
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

	svc.Source = SourceGitHub
	if got := svc.updateSource(); got != SourceGitHub {
		t.Fatalf("显式字段应覆盖环境变量，实际 %q", got)
	}
}

// TestNormalizeGitCodeReleases 校验 GitCode 与 GitHub 的字段差异被抹平。
func TestNormalizeGitCodeReleases(t *testing.T) {
	raw := `[
	  {
	    "tag_name": "v5.0.1",
	    "name": "v5.0.1",
	    "body": "## 更新内容",
	    "prerelease": false,
	    "release_status": "latest",
	    "created_at": "2026-10-25T18:00:00+08:00",
	    "assets": [
	      {"name": "v5.0.1.zip", "type": "source", "browser_download_url": "https://raw.gitcode.com/x.zip"},
	      {"name": "zviewer-windows-x64.zip", "type": "attach", "size": 123, "browser_download_url": "https://gitcode.com/o/r/releases/download/v5.0.1/zviewer-windows-x64.zip"}
	    ]
	  },
	  {
	    "tag_name": "latest",
	    "name": "Latest Build (main)",
	    "prerelease": false,
	    "release_status": "pre",
	    "assets": []
	  }
	]`
	var releases []githubRelease
	if err := json.Unmarshal([]byte(raw), &releases); err != nil {
		t.Fatalf("解析夹具失败: %v", err)
	}
	got := normalizeGitCodeReleases(releases)

	if len(got) != 2 {
		t.Fatalf("应有 2 条，实际 %d", len(got))
	}
	if got[0].HTMLURL != "https://gitcode.com/Zero-wyc/ZViewer/releases/tag/v5.0.1" {
		t.Fatalf("发布页地址未补齐: %q", got[0].HTMLURL)
	}
	if got[0].PublishedAt == nil || *got[0].PublishedAt != "2026-10-25T18:00:00+08:00" {
		t.Fatalf("published_at 应用 created_at 回填: %+v", got[0].PublishedAt)
	}
	if len(got[0].Assets) != 1 || got[0].Assets[0].Name != "zviewer-windows-x64.zip" {
		t.Fatalf("源码包应被过滤，实际 %+v", got[0].Assets)
	}
	if !got[1].Prerelease {
		t.Fatal("release_status=pre 应映射成 prerelease")
	}
}

// TestGetUpdateInfoFromGitCode 走 GitCode 源：来源标记、发布页与附件地址都要对。
func TestGetUpdateInfoFromGitCode(t *testing.T) {
	root := t.TempDir()
	writePackageJSON(t, root, "5.0.0")

	path := ""
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.RequestURI()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[
		  {
		    "tag_name": "v5.0.1",
		    "name": "v5.0.1",
		    "body": "修复若干问题",
		    "prerelease": false,
		    "release_status": "latest",
		    "created_at": "2026-10-25T18:00:00+08:00",
		    "assets": [
		      {"name": "zviewer-windows-x64.zip", "type": "attach", "size": 2048,
		       "browser_download_url": "https://gitcode.com/Zero-wyc/ZViewer/releases/download/v5.0.1/zviewer-windows-x64.zip"}
		    ]
		  }
		]`))
	}))
	defer server.Close()

	svc := New(root, nil)
	svc.Source = SourceGitCode
	svc.GitCodeAPIBase = server.URL
	svc.GOOS = "windows"
	svc.SetSettingsReader(func(context.Context) (bool, string, error) { return false, "", nil })

	info, err := svc.GetUpdateInfo(context.Background(), false)
	if err != nil {
		t.Fatalf("不应报错: %v", err)
	}
	if path != "/repos/Zero-wyc/ZViewer/releases?per_page=10" {
		t.Fatalf("请求路径异常: %q", path)
	}
	if info.Source != SourceGitCode {
		t.Fatalf("来源应为 gitcode，实际 %q", info.Source)
	}
	if info.RemoteVersion != "v5.0.1" || !info.HasUpdate || info.AssetSize != 2048 {
		t.Fatalf("结果异常: %+v", info)
	}
	if info.ReleaseURL != "https://gitcode.com/Zero-wyc/ZViewer/releases/tag/v5.0.1" {
		t.Fatalf("发布页地址异常: %q", info.ReleaseURL)
	}
}

// TestGetUpdateInfoFallsBackToGitHub：GitCode 挂了（镜像还没跑 CI）不能让检查更新失败。
func TestGetUpdateInfoFallsBackToGitHub(t *testing.T) {
	root := t.TempDir()
	writePackageJSON(t, root, "5.0.0")

	gitcode := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	defer gitcode.Close()

	github := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[
		  {
		    "tag_name": "v5.0.1",
		    "html_url": "https://github.com/Zero-wyc/ZViewer/releases/tag/v5.0.1",
		    "prerelease": false,
		    "published_at": "2026-10-25T10:38:53Z",
		    "assets": [
		      {"name": "zviewer-windows-x64.zip", "size": 4096,
		       "browser_download_url": "https://github.com/Zero-wyc/ZViewer/releases/download/v5.0.1/zviewer-windows-x64.zip"}
		    ]
		  }
		]`))
	}))
	defer github.Close()

	svc := New(root, nil)
	svc.Source = SourceGitCode
	svc.GitCodeAPIBase = gitcode.URL
	svc.APIBase = github.URL
	svc.GOOS = "windows"
	svc.SetSettingsReader(func(context.Context) (bool, string, error) { return false, "", nil })

	info, err := svc.GetUpdateInfo(context.Background(), false)
	if err != nil {
		t.Fatalf("GitCode 失败应回退 GitHub 而不是报错: %v", err)
	}
	if info.Source != SourceGitHub {
		t.Fatalf("回退后来源应为 github，实际 %q", info.Source)
	}
	if info.AssetSize != 4096 {
		t.Fatalf("应取到 GitHub 的附件信息: %+v", info)
	}
}

// TestGitCodeEmptyFallsBackToGitHub：镜像仓库还没跑过 CI（releases 为空）时也要能更新。
func TestGitCodeEmptyFallsBackToGitHub(t *testing.T) {
	root := t.TempDir()
	writePackageJSON(t, root, "5.0.0")

	gitcode := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte("[]"))
	}))
	defer gitcode.Close()

	github := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[
		  {"tag_name": "v5.0.2", "html_url": "https://github.com/Zero-wyc/ZViewer/releases/tag/v5.0.2",
		   "prerelease": false, "published_at": "2026-10-25T10:38:53Z",
		   "assets": [{"name": "zviewer-windows-x64.zip", "size": 1, "browser_download_url": "https://github.com/x.zip"}]}
		]`))
	}))
	defer github.Close()

	svc := New(root, nil)
	svc.Source = SourceGitCode
	svc.GitCodeAPIBase = gitcode.URL
	svc.APIBase = github.URL
	svc.GOOS = "windows"
	svc.SetSettingsReader(func(context.Context) (bool, string, error) { return false, "", nil })

	info, err := svc.GetUpdateInfo(context.Background(), false)
	if err != nil {
		t.Fatalf("GitCode 无 Release 时应回退 GitHub: %v", err)
	}
	if info.Source != SourceGitHub || info.RemoteVersion != "v5.0.2" {
		t.Fatalf("回退结果异常: %+v", info)
	}
}
