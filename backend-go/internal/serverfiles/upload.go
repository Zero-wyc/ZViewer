package serverfiles

import (
	"context"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"
)

// MaxUploadSize 是单个上传文件的大小上限（10GB，与 Node 的
// multer `limits.fileSize` 一致）。
const MaxUploadSize int64 = 10 * 1024 * 1024 * 1024

// maxFieldBytes 限制非文件字段（targetDir 等）的长度，防止恶意超长字段。
const maxFieldBytes int64 = 1 << 20

// ErrRootReadonly 表示目标根被标记为只读。
var ErrRootReadonly = errors.New("该根目录为只读")

// ErrUploadTooLarge 表示单文件超过 MaxUploadSize。
var ErrUploadTooLarge = errors.New("文件超过大小上限")

// UploadedFile 是一个已落盘的上传结果。
type UploadedFile struct {
	Name string `json:"name"`
	Path string `json:"path"`
	Size int64  `json:"size"`
}

// ReceiveUploads 流式接收 multipart 上传并落到目标目录。
//
// 与 multer 的 diskStorage 行为对齐：
//   - `targetDir` 字段决定落盘目录（缺省 `/` 即 uploads 根），只读根直接拒绝；
//   - 目录不存在则递归创建；
//   - 同名文件追加 ` (1)`、` (2)`… 序号，绝不覆盖已有文件；
//   - 任一步失败清理已写入的文件。
//
// 之所以用流式 multipart.Reader 而不是 ParseMultipartForm：后者会把整个
// 请求体先落到临时文件（10GB 上传等于写两遍盘）。
func (r *Registry) ReceiveUploads(ctx context.Context, reader *multipart.Reader) ([]UploadedFile, error) {
	fields := make(map[string]string)

	var (
		written []string
		files   []UploadedFile
		root    RootInfo
		dirAbs  string
		dirDone bool
	)

	cleanup := func() {
		for _, p := range written {
			_ = RemoveAll(root, p)
		}
	}

	for {
		part, err := reader.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			cleanup()
			return nil, err
		}

		name := part.FileName()
		if name == "" {
			// 普通字段：只保留前若干字节，targetDir 一定很短。
			formName := part.FormName()
			value, readErr := io.ReadAll(io.LimitReader(part, maxFieldBytes))
			_ = part.Close()
			if readErr != nil {
				cleanup()
				return nil, readErr
			}
			fields[formName] = string(value)
			continue
		}

		if !dirDone {
			targetDir := fields["targetDir"]
			if targetDir == "" {
				targetDir = "/"
			}
			roots, loadErr := r.Load(ctx)
			if loadErr != nil {
				_ = part.Close()
				cleanup()
				return nil, loadErr
			}
			abs, resRoot, resolveErr := ResolveSafePath(targetDir, roots)
			if resolveErr != nil {
				_ = part.Close()
				cleanup()
				return nil, resolveErr
			}
			if resRoot.Readonly {
				_ = part.Close()
				cleanup()
				return nil, ErrRootReadonly
			}
			if mkErr := MkdirAll(resRoot, abs, 0o755); mkErr != nil {
				_ = part.Close()
				cleanup()
				return nil, mkErr
			}
			root, dirAbs, dirDone = resRoot, abs, true
		}

		finalName := UniqueFilename(dirAbs, RepairFilename(name))
		targetPath := filepath.Join(dirAbs, finalName)
		size, writeErr := writePart(part, targetPath, root)
		_ = part.Close()
		if writeErr != nil {
			cleanup()
			return nil, writeErr
		}
		written = append(written, targetPath)
		files = append(files, UploadedFile{
			Name: finalName,
			Path: ToPrefixedPath(root, targetPath),
			Size: size,
		})
	}

	if !dirDone {
		return nil, errors.New("未接收到文件")
	}
	return files, nil
}

// writePart 把单个 part 写入磁盘，超过 MaxUploadSize 时中断。
func writePart(part io.Reader, targetPath string, root RootInfo) (int64, error) {
	dst, err := OpenFile(root, targetPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		return 0, err
	}
	// 多读 1 字节：正好等于上限时不算超限，多出来才判超限。
	written, copyErr := io.Copy(dst, io.LimitReader(part, MaxUploadSize+1))
	closeErr := dst.Close()
	if copyErr != nil {
		_ = RemoveAll(root, targetPath)
		return 0, copyErr
	}
	if closeErr != nil {
		_ = RemoveAll(root, targetPath)
		return 0, closeErr
	}
	if written > MaxUploadSize {
		_ = RemoveAll(root, targetPath)
		return 0, ErrUploadTooLarge
	}
	return written, nil
}

// RepairFilename 修掉「按 latin1 解出来的 UTF-8 文件名」。
//
// multer 交给上层的是 latin1 解码的 originalname，Node 侧显式做了
// `Buffer.from(name,'latin1').toString('utf8')` 还原。Go 的 multipart
// 解析一般直接得到 UTF-8，只有上游用错了编码才会出现非法序列——这种
// 情况下按同样的思路还原一次。
func RepairFilename(name string) string {
	// 只保留基名：客户端可能带路径（IE 风格 `C:\a\b.mp4`）。
	if idx := strings.LastIndexAny(name, "/\\"); idx >= 0 {
		name = name[idx+1:]
	}
	if name == "" {
		return "unnamed"
	}
	if utf8.ValidString(name) {
		return name
	}
	runes := make([]rune, 0, len(name))
	for i := 0; i < len(name); i++ {
		runes = append(runes, rune(name[i]))
	}
	repaired := string(runes)
	if !utf8.ValidString(repaired) {
		return name
	}
	return repaired
}

// UniqueFilename 在目录内生成不冲突的文件名（`a.mp4` → `a (1).mp4`）。
func UniqueFilename(dirAbs, filename string) string {
	if !exists(filepath.Join(dirAbs, filename)) {
		return filename
	}
	ext := filepath.Ext(filename)
	stem := strings.TrimSuffix(filename, ext)
	for i := 1; i < 10000; i++ {
		candidate := fmt.Sprintf("%s (%d)%s", stem, i, ext)
		if !exists(filepath.Join(dirAbs, candidate)) {
			return candidate
		}
	}
	return fmt.Sprintf("%s-%d%s", stem, nowMillis(), ext)
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// nowMillis 收口「取当前毫秒」（唯一用途是兜底文件名的唯一后缀）。
func nowMillis() int64 { return time.Now().UnixMilli() }
