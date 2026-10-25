package updater

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// extractArchive 把发布包解到 destDir。
//
// Node 侧分三种实现（Windows 用 PowerShell Expand-Archive、Linux 的 zip 用
// adm-zip、tar.gz 用系统 tar）。Go 用标准库统一处理 zip 与 tar.gz，
// 好处是容器里不需要 unzip/tar 这些外部命令，坏处是解压失败的错误文案
// 与 Node 不同——所以对拍里这类分支只比状态码与阶段序列。
func extractArchive(archivePath, destDir string) error {
	var err error
	if strings.HasSuffix(strings.ToLower(archivePath), ".zip") {
		err = extractZip(archivePath, destDir)
	} else {
		err = extractTarGz(archivePath, destDir)
	}
	if err != nil {
		return fmt.Errorf("解压失败: %w", err)
	}
	return nil
}

func extractZip(archivePath, destDir string) error {
	reader, err := zip.OpenReader(archivePath)
	if err != nil {
		return err
	}
	defer reader.Close()

	for _, entry := range reader.File {
		target, err := safeJoin(destDir, entry.Name)
		if err != nil {
			return err
		}
		if entry.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		mode := entry.Mode().Perm()
		if mode == 0 {
			// zip 里没写权限位时给个常规值，否则文件会建成 0000 不可读。
			mode = 0o644
		}
		src, err := entry.Open()
		if err != nil {
			return err
		}
		if err := writeFile(target, src, mode); err != nil {
			src.Close()
			return err
		}
		src.Close()
	}
	return nil
}

func extractTarGz(archivePath, destDir string) error {
	file, err := os.Open(archivePath)
	if err != nil {
		return err
	}
	defer file.Close()

	gz, err := gzip.NewReader(file)
	if err != nil {
		return err
	}
	defer gz.Close()

	reader := tar.NewReader(gz)
	for {
		header, err := reader.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		target, err := safeJoin(destDir, header.Name)
		if err != nil {
			return err
		}
		switch header.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			mode := os.FileMode(header.Mode).Perm()
			if mode == 0 {
				mode = 0o644
			}
			if err := writeFile(target, reader, mode); err != nil {
				return err
			}
		default:
			// 符号链接 / 硬链接 / 设备节点一律跳过：更新包只需要普通文件，
			// 还原链接等于给压缩包一个写到 destDir 之外的入口。
			continue
		}
	}
}

func writeFile(target string, src io.Reader, mode os.FileMode) error {
	out, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, src); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// safeJoin 把压缩包内的相对路径拼到 baseDir 下，并挡住 zip slip。
//
// 压缩包里的条目名可能带 `../` 或绝对路径；两种都会让解压写到目标目录外。
func safeJoin(baseDir, name string) (string, error) {
	cleaned := filepath.Clean(strings.TrimPrefix(strings.ReplaceAll(name, "\\", "/"), "/"))
	if cleaned == "." {
		return baseDir, nil
	}
	if cleaned == ".." || strings.HasPrefix(cleaned, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("压缩包内路径非法: %s", name)
	}
	return filepath.Join(baseDir, cleaned), nil
}
