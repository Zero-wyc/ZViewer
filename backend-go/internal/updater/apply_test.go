package updater

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// makeZip 构造一个内存 zip。
func makeZip(t *testing.T, entries map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	writer := zip.NewWriter(&buf)
	for name, body := range entries {
		entry, err := writer.Create(name)
		if err != nil {
			t.Fatalf("写 zip 条目失败: %v", err)
		}
		if _, err := entry.Write([]byte(body)); err != nil {
			t.Fatalf("写 zip 内容失败: %v", err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("关闭 zip 失败: %v", err)
	}
	return buf.Bytes()
}

// makeTarGz 构造一个内存 tar.gz。
func makeTarGz(t *testing.T, entries map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	writer := tar.NewWriter(gz)
	for name, body := range entries {
		header := &tar.Header{Name: name, Mode: 0o755, Size: int64(len(body)), Typeflag: tar.TypeReg}
		if err := writer.WriteHeader(header); err != nil {
			t.Fatalf("写 tar 头失败: %v", err)
		}
		if _, err := writer.Write([]byte(body)); err != nil {
			t.Fatalf("写 tar 内容失败: %v", err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("关闭 tar 失败: %v", err)
	}
	if err := gz.Close(); err != nil {
		t.Fatalf("关闭 gzip 失败: %v", err)
	}
	return buf.Bytes()
}

// newApplyService 造一个不会真的拉起脚本的更新器。
func newApplyService(t *testing.T, goos string) (*Service, *string) {
	t.Helper()
	svc := New(t.TempDir(), nil)
	svc.GOOS = goos
	spawned := ""
	svc.spawnFn = func(isWindows bool, scriptPath, root string) error {
		spawned = scriptPath
		return nil
	}
	svc.dockerFn = func() bool { return false }
	return svc, &spawned
}

func stageNames(events []StageEvent) []string {
	names := make([]string, 0, len(events))
	for _, event := range events {
		names = append(names, event.Stage)
	}
	return names
}

// TestApplyUpdateFromFileWindows 覆盖 Windows 分支：生成 bat、CRLF、路径注入。
func TestApplyUpdateFromFileWindows(t *testing.T) {
	svc, spawned := newApplyService(t, "windows")
	root := svc.Root

	archive := makeZip(t, map[string]string{
		"zviewer-backend.exe": "MZ",
		"start.bat":           "@echo off\r\n",
	})

	var events []StageEvent
	result, err := svc.ApplyUpdateFromFile(
		context.Background(), archive, "update.zip",
		func(event StageEvent) { events = append(events, event) },
	)
	if err != nil {
		t.Fatalf("应用更新失败: %v", err)
	}
	if !result.Success || result.Message != "更新已触发，后台将自动替换文件并重启服务" {
		t.Fatalf("返回体不对: %+v", result)
	}

	wantScript := filepath.Join(root, "apply-update.bat")
	if *spawned != wantScript {
		t.Fatalf("应拉起 %q，实际 %q", wantScript, *spawned)
	}
	if got := stageNames(events); strings.Join(got, ",") != "extracting,starting,done" {
		t.Fatalf("阶段序列不对: %v", got)
	}

	raw, err := os.ReadFile(wantScript)
	if err != nil {
		t.Fatalf("读脚本失败: %v", err)
	}
	content := string(raw)
	if strings.Contains(content, "{{") {
		t.Fatalf("脚本里还有未替换的占位符")
	}
	if !strings.Contains(content, `set "ROOT=`+root) {
		t.Fatalf("脚本未注入 ROOT，片段: %s", content[:200])
	}
	if !strings.Contains(content, `set "TEMP_DIR=`+filepath.Join(root, ".update-temp")) {
		t.Fatalf("脚本未注入 TEMP_DIR")
	}
	// bat 必须全 CRLF：LF 换行会让 cmd.exe 报语法错误。
	if trimmed := strings.ReplaceAll(content, "\r\n", ""); strings.Contains(trimmed, "\n") {
		t.Fatalf("bat 里存在裸 LF 换行")
	}
	if !strings.HasPrefix(content, "@echo off\r\n") {
		t.Fatalf("bat 首行不对: %q", content[:20])
	}
}

// TestApplyUpdateFromFileNestedDir 解压出单层目录时，EXTRACTED_DIR 要指向它。
func TestApplyUpdateFromFileNestedDir(t *testing.T) {
	svc, spawned := newApplyService(t, "windows")
	archive := makeZip(t, map[string]string{
		"zviewer-windows-x64/zviewer-backend.exe": "MZ",
		"zviewer-windows-x64/start.bat":           "@echo off",
	})

	if _, err := svc.ApplyUpdateFromFile(context.Background(), archive, "x.zip", nil); err != nil {
		t.Fatalf("应用更新失败: %v", err)
	}
	raw, err := os.ReadFile(*spawned)
	if err != nil {
		t.Fatalf("读脚本失败: %v", err)
	}
	want := filepath.Join(svc.Root, ".update-temp", "zviewer-windows-x64")
	if !strings.Contains(string(raw), `set "EXTRACTED_DIR=`+want) {
		t.Fatalf("EXTRACTED_DIR 应指向子目录 %q", want)
	}
}

// TestApplyUpdateFromFileLinux 覆盖裸机 Linux 分支。
func TestApplyUpdateFromFileLinux(t *testing.T) {
	svc, spawned := newApplyService(t, "linux")
	archive := makeTarGz(t, map[string]string{
		"zviewer-backend": "ELF",
		"start.sh":        "#!/bin/bash\n",
	})

	if _, err := svc.ApplyUpdateFromFile(context.Background(), archive, "update.tar.gz", nil); err != nil {
		t.Fatalf("应用更新失败: %v", err)
	}
	if want := filepath.Join(svc.Root, "apply-update.sh"); *spawned != want {
		t.Fatalf("应拉起 %q，实际 %q", want, *spawned)
	}

	raw, err := os.ReadFile(*spawned)
	if err != nil {
		t.Fatalf("读脚本失败: %v", err)
	}
	content := string(raw)
	if !strings.HasPrefix(content, "#!/bin/bash\n") {
		t.Fatalf("sh 首行不对: %q", content[:16])
	}
	if strings.Contains(content, "\r") {
		t.Fatalf("sh 里不能有 CR")
	}
	if !strings.Contains(content, "SELF_PID=$$") {
		t.Fatalf("裸机版应带 SELF_PID")
	}
	if !strings.Contains(content, `rm -rf "$CONFIG_DIR"`) {
		t.Fatalf("裸机版备份后要删原 config")
	}
}

// TestApplyUpdateFromFileDocker 覆盖容器分支：先建重启标记再 kill。
func TestApplyUpdateFromFileDocker(t *testing.T) {
	svc, spawned := newApplyService(t, "linux")
	svc.dockerFn = func() bool { return true }

	archive := makeTarGz(t, map[string]string{"zviewer-backend": "ELF"})
	result, err := svc.ApplyUpdateFromFile(context.Background(), archive, "update.tar.gz", nil)
	if err != nil {
		t.Fatalf("应用更新失败: %v", err)
	}
	if result.Message != "更新已触发，后台将自动替换文件并在容器内重启后端进程" {
		t.Fatalf("容器版文案不对: %q", result.Message)
	}

	raw, err := os.ReadFile(*spawned)
	if err != nil {
		t.Fatalf("读脚本失败: %v", err)
	}
	content := string(raw)
	if !strings.Contains(content, `RESTART_MARKER="$ROOT/.restart-backend"`) {
		t.Fatalf("容器版应带重启标记变量")
	}
	if strings.Contains(content, "SELF_PID=$$") {
		t.Fatalf("容器版不该带 SELF_PID")
	}
	if !strings.Contains(content, "kill -TERM") {
		t.Fatalf("容器版应先发 SIGTERM")
	}
}

// TestApplyUpdateFromFileCleansTempOnFailure 解压失败要清掉 .update-temp。
func TestApplyUpdateFromFileCleansTempOnFailure(t *testing.T) {
	svc, _ := newApplyService(t, "windows")
	var events []StageEvent

	_, err := svc.ApplyUpdateFromFile(
		context.Background(), []byte("这不是压缩包"), "broken.zip",
		func(event StageEvent) { events = append(events, event) },
	)
	if err == nil {
		t.Fatal("坏包应报错")
	}
	if _, statErr := os.Stat(filepath.Join(svc.Root, ".update-temp")); !os.IsNotExist(statErr) {
		t.Fatalf("失败后应清理 .update-temp，stat=%v", statErr)
	}
	names := stageNames(events)
	if len(names) == 0 || names[len(names)-1] != StageError {
		t.Fatalf("最后一个事件应为 error，实际 %v", names)
	}
}

// TestApplyUpdateFromFileRejectsExtension 只收 .zip / .tar.gz。
func TestApplyUpdateFromFileRejectsExtension(t *testing.T) {
	svc, spawned := newApplyService(t, "windows")
	_, err := svc.ApplyUpdateFromFile(context.Background(), []byte("x"), "update.tar", nil)
	if err == nil || err.Error() != "仅支持 .zip 或 .tar.gz 格式的压缩包" {
		t.Fatalf("扩展名校验不对: %v", err)
	}
	if *spawned != "" {
		t.Fatalf("校验失败时不该拉起脚本")
	}
}

// TestExtractZipSlip 拒绝写到目标目录之外。
func TestExtractZipSlip(t *testing.T) {
	dir := t.TempDir()
	archivePath := filepath.Join(dir, "evil.zip")
	if err := os.WriteFile(archivePath, makeZip(t, map[string]string{
		"../escaped.txt": "pwned",
	}), 0o644); err != nil {
		t.Fatalf("写坏包失败: %v", err)
	}
	dest := filepath.Join(dir, "out")
	if err := os.MkdirAll(dest, 0o755); err != nil {
		t.Fatalf("建目录失败: %v", err)
	}

	err := extractArchive(archivePath, dest)
	if err == nil {
		t.Fatal("越界路径应报错")
	}
	if _, statErr := os.Stat(filepath.Join(dir, "escaped.txt")); !os.IsNotExist(statErr) {
		t.Fatal("文件被写到了 dest 之外")
	}
}

// TestExtractTarGzKeepsMode tar.gz 解压后要保留可执行位。
func TestExtractTarGzKeepsMode(t *testing.T) {
	dir := t.TempDir()
	archivePath := filepath.Join(dir, "update.tar.gz")
	if err := os.WriteFile(archivePath, makeTarGz(t, map[string]string{
		"bin/zviewer-backend": "ELF",
	}), 0o644); err != nil {
		t.Fatalf("写包失败: %v", err)
	}
	dest := filepath.Join(dir, "out")
	if err := extractArchive(archivePath, dest); err != nil {
		t.Fatalf("解压失败: %v", err)
	}
	info, err := os.Stat(filepath.Join(dest, "bin", "zviewer-backend"))
	if err != nil {
		t.Fatalf("文件不存在: %v", err)
	}
	body, err := os.ReadFile(filepath.Join(dest, "bin", "zviewer-backend"))
	if err != nil || string(body) != "ELF" {
		t.Fatalf("内容不对: %q err=%v", body, err)
	}
	// Windows 的 os.Stat 不反映 chmod 的可执行位（恒 0666），只在类 Unix 上断言。
	if runtime.GOOS != "windows" && info.Mode().Perm()&0o100 == 0 {
		t.Fatalf("可执行位丢了: %v", info.Mode())
	}
}
