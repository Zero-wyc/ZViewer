package updater

import (
	"embed"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// 脚本模板由 scripts/dump-updater-templates.js 从 Node 源码原样导出。
//
// 直接抄一份到 Go 里是行不通的：TS 模板字面量里的反斜杠续行会被语言层吃掉，
// 抄出来的字节必然不一致；而这两个脚本要原样落盘并交给 cmd/bash 执行。
// 改了 Node 侧模板就重跑一次导出脚本。
//
//go:embed templates/*.tmpl
var templateFS embed.FS

const (
	templateApplySh  = "templates/apply-update.sh.tmpl"
	templateApplyBat = "templates/apply-update.bat.tmpl"
	templateStop     = "templates/sh-stop-docker.tmpl"
	templateApply    = "templates/sh-apply-docker.tmpl"
	templateFinish   = "templates/sh-finish-docker.tmpl"
	templateStopX    = "templates/sh-stop-linux.tmpl"
	templateApplyX   = "templates/sh-apply-linux.tmpl"
	templateFinishX  = "templates/sh-finish-linux.tmpl"
)

// placeholderPattern 对齐 Node 的 /\{\{(\w+)\}\}/g。
var placeholderPattern = regexp.MustCompile(`\{\{(\w+)\}\}`)

func readTemplate(name string) string {
	raw, err := templateFS.ReadFile(name)
	if err != nil {
		// embed 保证文件存在；读不到属于构建期错误，不该在运行时静默降级。
		panic(fmt.Sprintf("[updater] 读取脚本模板失败: %s: %v", name, err))
	}
	return string(raw)
}

// renderTemplate 按占位符注入变量。
//
// 与 Node 的 renderTemplate 一致：**最多四轮**替换，因为差异段自身带占位符
// （STOP_SECTION 里还有 {{TAG}}）。变量缺失立即报错 —— 生成半成品脚本比
// 直接失败更糟：那份脚本会在用户机器上以 root 权限跑一遍半截流程。
func renderTemplate(template string, vars map[string]string) (string, error) {
	out := template
	for round := 0; round < 4; round++ {
		if !placeholderPattern.MatchString(out) {
			break
		}
		missing := ""
		out = placeholderPattern.ReplaceAllStringFunc(out, func(match string) string {
			key := match[2 : len(match)-2]
			value, ok := vars[key]
			if !ok {
				if missing == "" {
					missing = key
				}
				return match
			}
			return value
		})
		if missing != "" {
			return "", fmt.Errorf("[updater] 脚本模板占位符未提供: %s", missing)
		}
	}
	return out, nil
}

// writeApplyUpdateBat 生成 Windows 更新批处理。
//
// bat 必须 CRLF：cmd.exe 解析 LF 换行的 bat 会报
// `'"' is not recognized as an internal or external command`，脚本直接跑不动。
func writeApplyUpdateBat(root, tempDir, extractedDir string) (string, error) {
	content, err := renderTemplate(readTemplate(templateApplyBat), map[string]string{
		"ROOT":          root,
		"TEMP_DIR":      tempDir,
		"EXTRACTED_DIR": extractedDir,
	})
	if err != nil {
		return "", err
	}
	batPath := filepath.Join(root, "apply-update.bat")
	content = strings.ReplaceAll(content, "\r\n", "\n")
	content = strings.ReplaceAll(content, "\n", "\r\n")
	if err := os.WriteFile(batPath, []byte(content), 0o644); err != nil {
		return "", err
	}
	return batPath, nil
}

// writeDockerUpdateSh 生成容器内更新脚本。
//
// 与裸机版的区别全在差异段：先 touch `.restart-backend` 让 entrypoint 知道
// 这次退出是更新（而不是崩溃），再按 PID 发 SIGTERM 做 graceful shutdown，
// 最后 kill 掉自己让 entrypoint 重启后端。
func writeDockerUpdateSh(root, tempDir, extractedDir string) (string, error) {
	content, err := renderTemplate(readTemplate(templateApplySh), map[string]string{
		"ROOT":           root,
		"TEMP_DIR":       tempDir,
		"EXTRACTED_DIR":  extractedDir,
		"TAG":            "[Docker 更新脚本]",
		"EXTRA_VARS":     `RESTART_MARKER="$ROOT/.restart-backend"`,
		"AFTER_BACKUP":   "",
		"STOP_SECTION":   readTemplate(templateStop),
		"APPLY_SECTION":  readTemplate(templateApply),
		"FINISH_SECTION": readTemplate(templateFinish),
	})
	if err != nil {
		return "", err
	}
	shPath := filepath.Join(root, "apply-update.sh")
	if err := os.WriteFile(shPath, []byte(content), 0o755); err != nil {
		return "", err
	}
	return shPath, nil
}

// writeApplyUpdateSh 生成裸机 Linux 更新脚本。
func writeApplyUpdateSh(root, tempDir, extractedDir string) (string, error) {
	content, err := renderTemplate(readTemplate(templateApplySh), map[string]string{
		"ROOT":           root,
		"TEMP_DIR":       tempDir,
		"EXTRACTED_DIR":  extractedDir,
		"TAG":            "[更新脚本]",
		"EXTRA_VARS":     "SELF_PID=$$",
		"AFTER_BACKUP":   `  rm -rf "$CONFIG_DIR"`,
		"STOP_SECTION":   readTemplate(templateStopX),
		"APPLY_SECTION":  readTemplate(templateApplyX),
		"FINISH_SECTION": readTemplate(templateFinishX),
	})
	if err != nil {
		return "", err
	}
	shPath := filepath.Join(root, "apply-update.sh")
	if err := os.WriteFile(shPath, []byte(content), 0o755); err != nil {
		return "", err
	}
	return shPath, nil
}
