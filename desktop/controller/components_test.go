package controller

// 可选组件（public/ 组件库 + GitCode 仓库直链）的固定约束：
// 版本、大小、摘要必须与仓库里的真实文件一致，否则线上会出现「下下来校验不过」。

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// repoPublicDir 是仓库根的 public/；组件二进制随仓库一起同步到 GitCode。
func repoPublicDir() string { return filepath.Join("..", "..", "public") }

func TestComponentCatalogMatchesLibraryFiles(t *testing.T) {
	for _, spec := range componentCatalog {
		path := filepath.Join(repoPublicDir(), spec.File)
		info, err := os.Stat(path)
		if err != nil {
			t.Fatalf("%s 缺少组件文件 public/%s：%v", spec.Name, spec.File, err)
		}
		if info.Size() != spec.Size {
			t.Fatalf("%s 大小与 public/%s 不一致：go=%d file=%d", spec.Name, spec.File, spec.Size, info.Size())
		}
		file, err := os.Open(path)
		if err != nil {
			t.Fatal(err)
		}
		hasher := sha256.New()
		_, copyErr := io.Copy(hasher, file)
		closeErr := file.Close()
		if copyErr != nil || closeErr != nil {
			t.Fatalf("读取 public/%s 失败：%v %v", spec.File, copyErr, closeErr)
		}
		if digest := hex.EncodeToString(hasher.Sum(nil)); digest != spec.SHA256 {
			t.Fatalf("%s 摘要不一致：go=%s file=%s", spec.Name, spec.SHA256, digest)
		}
	}
}

func TestComponentMirrorURLUsesAPIRaw(t *testing.T) {
	want := "https://api.gitcode.com/api/v5/repos/Zero-wyc/ZViewer/raw/public/cloudflared-windows-amd64.exe?ref=main"
	if got := cloudflaredSpec.mirrorURL(); got != want {
		t.Fatalf("mirror url=%q, want=%q", got, want)
	}
	// 站点预览通道对 exe/zip 一律 403，任何组件地址都不能落到它上面。
	if strings.Contains(cloudflaredSpec.mirrorURL(), "raw.gitcode.com") {
		t.Fatal("component url must not use the preview-only raw host")
	}
	if !strings.Contains(meshSpec.mirrorURL(), "/public/"+meshSpec.File+"?ref=main") {
		t.Fatalf("mesh mirror url=%q", meshSpec.mirrorURL())
	}
}

func TestComponentSourcesPreferMirror(t *testing.T) {
	sources := componentSources(cloudflaredSpec)
	if len(sources) != 2 || sources[0] != cloudflaredSpec.mirrorURL() || sources[1] != cloudflaredSpec.GitHub {
		t.Fatalf("unexpected sources: %v", sources)
	}
	if !strings.HasPrefix(meshSpec.GitHub, "https://github.com/EasyTier/EasyTier/releases/download/v"+meshSpec.Version+"/") {
		t.Fatalf("mesh fallback must point at the pinned upstream release: %s", meshSpec.GitHub)
	}
}

func TestComponentHostPolicy(t *testing.T) {
	for _, host := range []string{"api.gitcode.com", "gitcode.com", "github.com", "release-assets.githubusercontent.com"} {
		if !allowedComponentHost(host) {
			t.Errorf("rejected known host %s", host)
		}
	}
	for _, host := range []string{"raw.githubusercontent.com.evil.example", "example.com", "localhost", "127.0.0.1"} {
		if allowedComponentHost(host) {
			t.Errorf("accepted unexpected host %s", host)
		}
	}
}

func TestExtractComponentZipOnlyInstallsRequiredFiles(t *testing.T) {
	dir := t.TempDir()
	archive := filepath.Join(dir, "easytier.zip")
	file, err := os.Create(archive)
	if err != nil {
		t.Fatal(err)
	}
	writer := zip.NewWriter(file)
	entries := map[string]string{
		"easytier-windows-x86_64/easytier-core.exe":  "core",
		"easytier-windows-x86_64/easytier-cli.exe":   "cli",
		"easytier-windows-x86_64/Packet.dll":         "packet",
		"easytier-windows-x86_64/WinDivert64.sys":    "windivert",
		"easytier-windows-x86_64/wintun.dll":         "wintun",
		"easytier-windows-x86_64/easytier-web.exe":   "web-console",
		"easytier-windows-x86_64/easytier-web-embed": "web-embed",
	}
	for name, body := range entries {
		entry, err := writer.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := entry.Write([]byte(body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}

	target := filepath.Join(dir, "mesh")
	if err := extractComponentZip(archive, target, meshSpec.Files); err != nil {
		t.Fatalf("extract failed: %v", err)
	}
	for _, name := range meshSpec.Files {
		if _, err := os.Stat(filepath.Join(target, name)); err != nil {
			t.Fatalf("missing installed file %s: %v", name, err)
		}
	}
	// 官方包里的网页控制台不该被解出来：组件库只装运行必需的文件。
	if _, err := os.Stat(filepath.Join(target, "easytier-web.exe")); !os.IsNotExist(err) {
		t.Fatal("web console must not be installed")
	}
	if body, err := os.ReadFile(filepath.Join(target, "easytier-core.exe")); err != nil || string(body) != "core" {
		t.Fatalf("installed content mismatch: %q, %v", body, err)
	}
}

func TestExtractComponentZipRejectsIncompleteArchive(t *testing.T) {
	dir := t.TempDir()
	archive := filepath.Join(dir, "broken.zip")
	file, err := os.Create(archive)
	if err != nil {
		t.Fatal(err)
	}
	writer := zip.NewWriter(file)
	entry, err := writer.Create("easytier-windows-x86_64/easytier-core.exe")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := entry.Write([]byte("core")); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	err = extractComponentZip(archive, filepath.Join(dir, "mesh"), meshSpec.Files)
	if err == nil || !strings.Contains(err.Error(), "不完整") {
		t.Fatalf("expected incomplete archive error, got %v", err)
	}
}

func TestComponentStatusReflectsDisk(t *testing.T) {
	root := t.TempDir()
	c := &Controller{root: root, dir: root}
	c.mesh = NewMeshManager(root, filepath.Join(root, "state"), "", func(*Proc, string) error { return nil }, func(string, string, string) {}, func() {})

	if status := c.componentStatus(cloudflaredSpec); status.Available || status.State != "idle" {
		t.Fatalf("fresh install must be idle: %+v", status)
	}
	if err := os.WriteFile(filepath.Join(root, cloudflaredSpec.File), []byte("MZ"), 0o600); err != nil {
		t.Fatal(err)
	}
	if status := c.componentStatus(cloudflaredSpec); !status.Available || status.State != "ready" {
		t.Fatalf("installed component must be ready: %+v", status)
	}

	report := c.componentReport()
	if !report.Cloudflared.Available || report.Mesh.Available {
		t.Fatalf("report mismatch: %+v", report)
	}
}

func TestInstallComponentRejectsUnknownName(t *testing.T) {
	root := t.TempDir()
	c := &Controller{root: root, dir: root}
	c.mesh = NewMeshManager(root, filepath.Join(root, "state"), "", func(*Proc, string) error { return nil }, func(string, string, string) {}, func() {})
	if _, err := c.InstallComponent("nope"); err == nil {
		t.Fatal("unknown component must be rejected")
	}
}
