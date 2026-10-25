package updater

import (
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// nodeLegacyExecutables 是 v4（Node）发布包曾经携带、v5 起完全不再使用的可执行文件。
//
// 这些文件在任何布局下都可以安全删除：Go 版后端只跑 `zviewer-backend`，
// 前端静态文件由后端直接托管（不再有 zviewer-frontend.exe），
// 证书也由 `zviewer-server --gen-cert` 内置。
var nodeLegacyExecutables = []string{
	"zviewer-frontend.exe",
	"zviewer-frontend",
	"zviewer-cert.exe",
	"zviewer-cert",
}

// nodeLegacyDirs 只在「发布包布局」下删除。
//
// `node_modules/` 与 `backend/` 是 Node 时代的运行/源码目录；但源码树里它们仍可能有用，
// 所以用 isReleaseLayout 做闸门：只有「有 frontend/dist、没有 frontend/src、没有 .git」
// 才认定是解压即用的发布目录。
var nodeLegacyDirs = []string{
	"node_modules",
	"backend",
}

// legacyMediaExts 是 Node 版媒体服务（node-media-server）写在 MEDIA_DIR 里的产物后缀。
//
// Go 版推流是内存转封装，不落盘；这些切片留着只会白占磁盘。
var legacyMediaExts = []string{".ts", ".m3u8", ".flv", ".m4s"}

// CleanupResult 是一次遗留文件清理的结果。
type CleanupResult struct {
	// Removed 是被删掉的条目（相对 root 的路径，目录带尾斜杠）。
	Removed []string
	// Freed 是释放的字节数。
	Freed int64
}

// Empty 表示什么都没删。
func (r CleanupResult) Empty() bool { return len(r.Removed) == 0 }

// CleanLegacyArtifacts 清理 v4（Node）升级到 v5（Go）后不再需要的文件。
//
// 触发时机是**每次 Go 后端启动**（幂等、只做 Stat + 少量删除），
// 所以无论是谁执行了那次更新（v4 的更新脚本、手动覆盖还是解压重装），
// 升级到 v5 后第一次启动就会自动收尾。
//
// 只删「确定不属于 Go 布局」的东西，且对源码树设闸门：
//   - 可执行文件：v4 独有的 zviewer-frontend / zviewer-cert（任何布局都删）；
//   - 目录：node_modules / backend（仅发布包布局）；
//   - 媒体缓存：MEDIA_DIR 下的 .ts/.m3u8/.flv/.m4s（仅发布包布局）。
//
// 任何一步失败都只记日志、不返回错误——清理失败不该妨碍服务启动。
func CleanLegacyArtifacts(root, mediaDir string, logf func(string, ...any)) CleanupResult {
	var result CleanupResult
	if strings.TrimSpace(root) == "" {
		return result
	}
	if logf == nil {
		logf = func(string, ...any) {}
	}

	release := isReleaseLayout(root)

	for _, name := range nodeLegacyExecutables {
		target := filepath.Join(root, name)
		info, err := os.Lstat(target)
		if err != nil || info.IsDir() {
			continue
		}
		result.Freed += info.Size()
		if err := os.Remove(target); err != nil {
			logf("[cleanup] 删除 %s 失败: %v", name, err)
			continue
		}
		result.Removed = append(result.Removed, name)
	}

	if release {
		for _, name := range nodeLegacyDirs {
			target := filepath.Join(root, name)
			info, err := os.Lstat(target)
			if err != nil || !info.IsDir() {
				continue
			}
			size := dirSize(target)
			if err := os.RemoveAll(target); err != nil {
				logf("[cleanup] 删除 %s 失败: %v", name, err)
				continue
			}
			result.Freed += size
			result.Removed = append(result.Removed, name+"/")
		}
	}

	if release && strings.TrimSpace(mediaDir) != "" {
		files, bytes := cleanLegacyMedia(mediaDir, logf)
		if files > 0 {
			result.Freed += bytes
			result.Removed = append(result.Removed, "媒体缓存 "+itoa(files)+" 个文件")
		}
	}

	sort.Strings(result.Removed)
	return result
}

// isReleaseLayout 判断 root 是不是解压即用的发布目录。
//
// 三个条件同时满足才算：有前端产物、没有前端源码、没有 git 元数据。
// 源码树（frontend/src 或 .git 存在）一律跳过目录级清理——
// 那里的 node_modules / backend 是开发者的东西，不能动。
func isReleaseLayout(root string) bool {
	if _, err := os.Stat(filepath.Join(root, ".git")); err == nil {
		return false
	}
	if _, err := os.Stat(filepath.Join(root, "frontend", "src")); err == nil {
		return false
	}
	if _, err := os.Stat(filepath.Join(root, "frontend", "dist", "index.html")); err != nil {
		return false
	}
	return true
}

// cleanLegacyMedia 删除 MEDIA_DIR 里 Node 版媒体服务留下的切片文件，返回文件数与字节数。
func cleanLegacyMedia(mediaDir string, logf func(string, ...any)) (int, int64) {
	var count int
	var bytes int64

	_ = filepath.WalkDir(mediaDir, func(path string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return nil
		}
		ext := strings.ToLower(filepath.Ext(entry.Name()))
		matched := false
		for _, want := range legacyMediaExts {
			if ext == want {
				matched = true
				break
			}
		}
		if !matched {
			return nil
		}
		info, statErr := entry.Info()
		if statErr == nil {
			bytes += info.Size()
		}
		if removeErr := os.Remove(path); removeErr != nil {
			logf("[cleanup] 删除媒体缓存 %s 失败: %v", path, removeErr)
			return nil
		}
		count++
		return nil
	})
	return count, bytes
}

// dirSize 计算目录总大小（删除前统计，只为日志里有个人类可读的数量）。
func dirSize(root string) int64 {
	var total int64
	_ = filepath.WalkDir(root, func(_ string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return nil
		}
		if info, statErr := entry.Info(); statErr == nil {
			total += info.Size()
		}
		return nil
	})
	return total
}

// itoa 避免为一个数字引入 strconv。
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}
