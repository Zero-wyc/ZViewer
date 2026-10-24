package api

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
)

// localVersion 读取本机版本号。
//
// 与 Node 版 getLocalVersion 的口径一致：以项目根 package.json 的 version 为准。
// 读不到时返回 "0.0.0" 而不是报错——版本号只用于前端展示与更新提示，
// 不该因为它阻断启动。
func localVersion(projectRoot string) string {
	candidates := []string{
		filepath.Join(projectRoot, "package.json"),
		filepath.Join(projectRoot, "runtime", "package.json"),
	}
	for _, path := range candidates {
		raw, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var pkg struct {
			Version string `json:"version"`
		}
		if err := json.Unmarshal(raw, &pkg); err == nil && pkg.Version != "" {
			return pkg.Version
		}
	}
	return "0.0.0"
}

// isDesktopManaged 判断是否由桌面 GUI 托管。
//
// 标识由 desktop/controller 注入（ZVIEWER_DESKTOP=1）。
// 为 true 时前端管理端要禁用网页更新入口，改由 GUI 整包更新，
// 否则网页更新只会替换后端产物，与 GUI 版本脱节。
func isDesktopManaged() bool {
	return os.Getenv("ZVIEWER_DESKTOP") == "1"
}

// logAuditError 只记录审计写入失败，不向上传播。
func logAuditError(err error) {
	log.Printf("[audit] %v", err)
}
