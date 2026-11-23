package console

// 路径与载荷小工具：这些函数原先散落在 desktop 的 shell_*.go 里，
// 抽到 console 后桌面壳与网页端共用。

import (
	"os"
	"path/filepath"
	"strings"
)

func absolute(path string) string {
	if resolved, err := filepath.Abs(path); err == nil {
		return resolved
	}
	return path
}

func fileExists(path string) bool {
	if path == "" {
		return false
	}
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

func dirExists(path string) bool {
	if path == "" {
		return false
	}
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

// searchRoots 给出「可执行文件附近」的若干目录，打包后是安装目录，
// 开发期是 desktop/build/bin 上溯到 desktop/ 与仓库根。
func searchRoots(exeDir string) []string {
	roots := []string{exeDir}
	current := exeDir
	for index := 0; index < 3; index++ {
		current = filepath.Dir(current)
		roots = append(roots, current)
	}
	if cwd, err := os.Getwd(); err == nil {
		roots = append(roots, cwd, filepath.Dir(cwd))
	}
	return roots
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func payloadConfig(payload map[string]any) map[string]any {
	if raw, ok := payload["config"].(map[string]any); ok {
		return raw
	}
	return map[string]any{}
}

func payloadString(payload map[string]any, key string) string {
	if raw, ok := payload[key].(string); ok {
		return raw
	}
	return ""
}

// payloadStrings 取字符串数组，兼容前端直接传 []string 或 JSON 解出来的 []any。
func payloadStrings(payload map[string]any, key string) []string {
	switch raw := payload[key].(type) {
	case []string:
		return raw
	case []any:
		out := make([]string, 0, len(raw))
		for _, item := range raw {
			if text, ok := item.(string); ok && text != "" {
				out = append(out, text)
			}
		}
		return out
	}
	return nil
}
