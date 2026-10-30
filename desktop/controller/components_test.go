package controller

// 可选组件（ZviewerRelease 的 components 分支 + GitCode 仓库直链）的固定约束：
// 组件二进制已不随源码仓库分发（2026-10-30 从 public/ 迁走），所以这里不校验本地文件，
// 只锁住「下载地址怎么拼」「来源顺序」「域名白名单」这些改错就会 404 的规则。
// 组件是否真的在分支上，由发布流程的组件库自检（scripts/publish-release-repo.sh）兜底。

import (
	"archive/zip"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestComponentCatalogFilesArePlainNames(t *testing.T) {
	seen := map[string]bool{}
	for _, spec := range componentCatalog {
		if spec.File == "" {
			t.Fatalf("%s 的文件名为空", spec.Name)
		}
		// 文件名直接拼进 URL；带路径分隔符或查询符号会让地址错位。
		if strings.ContainsAny(spec.File, "/\\?#&") {
			t.Fatalf("%s 的文件名 %q 不能含路径或查询字符", spec.Name, spec.File)
		}
		if seen[spec.File] {
			t.Fatalf("组件库文件名重复：%s", spec.File)
		}
		seen[spec.File] = true
		if spec.Name == "" || spec.Version == "" {
			t.Fatalf("组件缺少名字或版本：%+v", spec)
		}
	}
}

func TestComponentMirrorURLUsesAPIRaw(t *testing.T) {
	want := "https://api.gitcode.com/api/v5/repos/Zero-wyc/ZviewerRelease/raw/cloudflared-windows-amd64.exe?ref=components"
	if got := cloudflaredSpec.mirrorURL(); got != want {
		t.Fatalf("mirror url=%q, want=%q", got, want)
	}
	// 站点预览通道对 exe/zip 一律 403，任何组件地址都不能落到它上面。
	if strings.Contains(cloudflaredSpec.mirrorURL(), "raw.gitcode.com") {
		t.Fatal("component url must not use the preview-only raw host")
	}
	// 组件库在 components 分支：落回 main 会被下一次发版的孤儿提交清掉。
	if !strings.Contains(meshSpec.mirrorURL(), "/"+meshSpec.File+"?ref=components") {
		t.Fatalf("mesh mirror url=%q", meshSpec.mirrorURL())
	}
	for _, spec := range componentCatalog {
		if strings.Contains(spec.mirrorURL(), "/Zero-wyc/ZViewer/") {
			t.Fatalf("%s 仍指向源码仓库：%s", spec.Name, spec.mirrorURL())
		}
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
	if err := os.WriteFile(filepath.Join(root, cloudflaredSpec.installName()), []byte("MZ"), 0o600); err != nil {
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

// frpc 不随包：装到运行包根目录（壳从 runtime/frpc.exe 拉起），
// 且下载完成后当次会话就能用——不需要重启 GUI。
func TestFrpComponentLivesInRuntimeRoot(t *testing.T) {
	root := t.TempDir()
	c := &Controller{root: root, dir: root, frpc: filepath.Join(root, "frpc.exe")}
	c.mesh = NewMeshManager(root, filepath.Join(root, "state"), "", func(*Proc, string) error { return nil }, func(string, string, string) {}, func() {})

	report := c.componentReport()
	if report.Frp.Available || report.Frp.Version != FrpVersion {
		t.Fatalf("fresh install must expose the pinned version as unavailable: %+v", report.Frp)
	}
	if report.Frp.State != "idle" {
		t.Fatalf("fresh install must be idle: %+v", report.Frp)
	}
	if got := c.frpcPath(); got != filepath.Join(root, frpSpec.installName()) {
		t.Fatalf("frpc path=%q", got)
	}

	if err := os.WriteFile(filepath.Join(root, "frpc.exe"), []byte("MZ"), 0o600); err != nil {
		t.Fatal(err)
	}
	if !c.componentInstalled(frpSpec) {
		t.Fatal("installed frpc must count as available")
	}
	if status := c.componentStatus(frpSpec); !status.Available || status.State != "ready" {
		t.Fatalf("installed frpc must be ready: %+v", status)
	}
	// 只解 frpc.exe：服务端 frps 与两个 toml 不进运行包。
	if len(frpSpec.Files) != 1 || frpSpec.Files[0] != "frpc.exe" {
		t.Fatalf("unexpected install set: %v", frpSpec.Files)
	}
	// 落盘目录：frpc 直接放运行包根目录（壳按 runtime/frpc.exe 拉起），组网仍在自己子目录。
	if got := c.componentDir(frpSpec); got != root {
		t.Fatalf("frpc install dir=%q, want=%q", got, root)
	}
	if got := c.componentDir(meshSpec); got != filepath.Join(root, "mesh") {
		t.Fatalf("mesh install dir=%q", got)
	}
}
