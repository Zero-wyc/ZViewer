package api

import (
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"

	"zviewer/backend/internal/httpx"
)

// avatarsHandler 提供头像静态服务。
//
// 头像走 URL 公开访问（不含鉴权），与 Node 版一致：
// <img src> 不会带 Authorization 头，加鉴权等于让头像全挂。
func (s *Server) avatarsHandler() http.Handler {
	files := http.FileServer(http.Dir(s.Cfg.AvatarsDir))
	return http.StripPrefix("/uploads/avatars/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 文件名内容哈希不变，可长期强缓存
		w.Header().Set("Cache-Control", "public, max-age=604800, immutable")
		files.ServeHTTP(w, r)
	}))
}

// spaHandler 托管前端产物，并为前端路由做 index.html 回退。
//
// ffmpeg.wasm 核心（约 32MB）等大体积资源单独强缓存，
// 否则每次初始化 wasm 都要重新下载，播放器启动会明显变慢。
func (s *Server) spaHandler() http.Handler {
	dist := s.Cfg.FrontendDist
	files := http.FileServer(http.Dir(dist))

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			httpx.NotFound(w, "接口不存在")
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
			return
		}

		clean := path.Clean("/" + r.URL.Path)
		full := filepath.Join(dist, filepath.FromSlash(clean))

		// 目录穿越防护：Join 已 Clean，但仍显式确认落在 dist 内
		if !strings.HasPrefix(full, filepath.Clean(dist)+string(os.PathSeparator)) {
			httpx.NotFound(w, "资源不存在")
			return
		}

		if info, err := os.Stat(full); err == nil && !info.IsDir() {
			if strings.HasPrefix(clean, "/ffmpeg/") {
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			}
			files.ServeHTTP(w, r)
			return
		}

		index := filepath.Join(dist, "index.html")
		if _, err := os.Stat(index); err != nil {
			// 与 Node 版一致：产物缺失不阻断启动，但页面无法访问
			http.Error(w, "前端构建产物不存在，请先执行前端构建", http.StatusNotFound)
			return
		}
		http.ServeFile(w, r, index)
	})
}
