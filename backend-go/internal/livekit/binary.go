package livekit

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// binName 是伴生二进制的文件名（Windows 带 .exe）。
func binName() string {
	if runtime.GOOS == "windows" {
		return "livekit-server.exe"
	}
	return "livekit-server"
}

// candidateBinaries 按优先级返回候选路径。
//
// 顺序与 Node 版一致：**exe 同目录优先**（生产产物把二进制放在 exe 旁边），
// 之后才是 dev-bin（开发）。之所以要列多个 dev-bin 位置：Go 版的 cwd 不固定
// （npm script 在仓库根、`go run` 在 backend-go、测试在包目录），只认
// `<cwd>/dev-bin` 会在某些启动方式下「明明有二进制却找不到」。
func (m *Manager) candidateBinaries() []string {
	name := binName()
	var out []string
	if m.cfg.BinPath != "" {
		out = append(out, m.cfg.BinPath)
	}
	if m.cfg.ExecDir != "" {
		out = append(out, filepath.Join(m.cfg.ExecDir, name))
	}
	for _, dir := range m.devBinDirs() {
		out = append(out, filepath.Join(dir, name))
	}
	return dedupe(out)
}

func (m *Manager) devBinDirs() []string {
	var dirs []string
	if m.cfg.DevBinDir != "" {
		dirs = append(dirs, m.cfg.DevBinDir)
	}
	if cwd, err := os.Getwd(); err == nil {
		// 仓库根启动（npm run dev）时二进制在 backend-go/dev-bin
		dirs = append(dirs, filepath.Join(cwd, "backend-go", "dev-bin"), filepath.Join(cwd, "dev-bin"))
	}
	if m.cfg.ExecDir != "" {
		dirs = append(dirs, filepath.Join(m.cfg.ExecDir, "dev-bin"),
			filepath.Join(m.cfg.ExecDir, "..", "dev-bin"))
	}
	return dedupe(dirs)
}

// findBinary 返回第一个存在的候选路径，找不到返回空串。
func (m *Manager) findBinary() string {
	for _, p := range m.candidateBinaries() {
		if info, err := os.Stat(p); err == nil && !info.IsDir() {
			return p
		}
	}
	return ""
}

// assetName 是 GitHub release 的资产名（Windows 是 zip，其它是 tar.gz）。
func assetName() (string, error) {
	ver := strings.TrimPrefix(BinaryVersion, "v")
	switch runtime.GOOS {
	case "windows":
		return fmt.Sprintf("livekit_%s_windows_%s.zip", ver, runtime.GOARCH), nil
	case "linux":
		return fmt.Sprintf("livekit_%s_linux_%s.tar.gz", ver, runtime.GOARCH), nil
	case "darwin":
		return fmt.Sprintf("livekit_%s_darwin_%s.tar.gz", ver, runtime.GOARCH), nil
	default:
		return "", errUnsupportedPlatform
	}
}

// downloadURL 返回当前平台的下载地址（资产名算不出来时给 releases 首页）。
func downloadURL() string {
	asset, err := assetName()
	if err != nil {
		return "https://github.com/livekit/livekit-server/releases"
	}
	return fmt.Sprintf("https://github.com/livekit/livekit-server/releases/download/%s/%s",
		BinaryVersion, asset)
}

// downloadDevBinary 在开发构建里补齐缺失的二进制。
//
// 只在 devBuild 为真时被调用：生产包静默联网抓 56MB 是不可接受的
// （企业内网必然失败，还会让启动卡到超时）。
func (m *Manager) downloadDevBinary(ctx context.Context) (string, error) {
	asset, err := assetName()
	if err != nil {
		return "", err
	}
	dir := m.cfg.DevBinDir
	if dir == "" {
		return "", fmt.Errorf("无法确定 dev-bin 目录（工作目录不可用）")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("创建 dev-bin 失败: %w", err)
	}

	archive := filepath.Join(dir, asset)
	m.logf("[voice] 开发模式：自动下载 livekit-server %s ...", BinaryVersion)
	if err := downloadFile(ctx, downloadURL(), archive); err != nil {
		return "", err
	}
	defer os.Remove(archive)

	dest := filepath.Join(dir, binName())
	if err := extractBinary(archive, dest); err != nil {
		return "", err
	}
	if runtime.GOOS != "windows" {
		_ = os.Chmod(dest, 0o755)
	}
	m.logf("[voice] livekit-server 下载完成")
	return dest, nil
}

func downloadFile(ctx context.Context, url, dest string) error {
	// 下载 56MB 量级，给足时间但不要无限等（断网时应当快速失败并给出手动指引）
	ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	// GitHub 会 302 到对象存储；默认 Transport 会跟随重定向
	req.Header.Set("User-Agent", "zviewer-dev-setup")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}

	f, err := os.Create(dest)
	if err != nil {
		return err
	}
	defer f.Close()
	if _, err := io.Copy(f, resp.Body); err != nil {
		return err
	}
	return nil
}

// extractBinary 把压缩包里的 livekit-server 解出来写到 dest。
func extractBinary(archive, dest string) error {
	if strings.HasSuffix(archive, ".zip") {
		return extractZip(archive, dest)
	}
	return extractTarGz(archive, dest)
}

func extractZip(archive, dest string) error {
	r, err := zip.OpenReader(archive)
	if err != nil {
		return err
	}
	defer r.Close()
	for _, f := range r.File {
		if filepath.Base(f.Name) != binName() || f.FileInfo().IsDir() {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return err
		}
		defer rc.Close()
		return writeBinary(dest, rc)
	}
	return fmt.Errorf("压缩包里没有 %s", binName())
}

func extractTarGz(archive, dest string) error {
	f, err := os.Open(archive)
	if err != nil {
		return err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		if hdr.Typeflag != tar.TypeReg || filepath.Base(hdr.Name) != binName() {
			continue
		}
		return writeBinary(dest, tr)
	}
	return fmt.Errorf("压缩包里没有 %s", binName())
}

func writeBinary(dest string, src io.Reader) error {
	out, err := os.OpenFile(dest, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, src); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

func dedupe(items []string) []string {
	seen := make(map[string]struct{}, len(items))
	out := make([]string, 0, len(items))
	for _, item := range items {
		if item == "" {
			continue
		}
		if _, ok := seen[item]; ok {
			continue
		}
		seen[item] = struct{}{}
		out = append(out, item)
	}
	return out
}
