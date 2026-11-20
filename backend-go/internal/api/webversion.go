package api

import (
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"zviewer/backend/internal/httpx"
)

// webEntryPattern 从 index.html 里提取入口脚本路径（vite 产物带内容哈希）。
var webEntryPattern = regexp.MustCompile("(?i)(?:src|href)=\"([^\"]*assets/[^\"?#]+\\.m?js)\"")

// frontendEntry 返回当前磁盘上前端产物的入口脚本路径（形如 /assets/index-XXXX.js）。
// 页面加载的是旧入口时，前端据此提示刷新。
func (s *Server) frontendEntry() string {
	if s.Cfg == nil || strings.TrimSpace(s.Cfg.FrontendDist) == "" {
		return ""
	}
	data, err := os.ReadFile(filepath.Join(s.Cfg.FrontendDist, "index.html"))
	if err != nil {
		return ""
	}
	match := webEntryPattern.FindSubmatch(data)
	if len(match) < 2 {
		return ""
	}
	entry := string(match[1])
	if !strings.HasPrefix(entry, "/") {
		entry = "/" + entry
	}
	return entry
}

// handleWebVersion 返回当前前端入口脚本名，供页面做「版本不一致」提示。
// 免鉴权：内容只是产物文件名，不含任何用户数据。
func (s *Server) handleWebVersion(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	httpx.OK(w, map[string]any{
		"success": true,
		"entry":   s.frontendEntry(),
	})
}

func (s *Server) registerWebVersionRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/web-version", s.handleWebVersion)
}
