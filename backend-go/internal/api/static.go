package api

import (
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strconv"
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
		name := path.Base(r.URL.Path)
		if strings.TrimPrefix(r.URL.Path, "/") != name || name == "." || name == "/" {
			http.NotFound(w, r)
			return
		}
		f, err := os.Open(filepath.Join(s.Cfg.AvatarsDir, name))
		if err != nil {
			http.NotFound(w, r)
			return
		}
		defer f.Close()
		info, err := f.Stat()
		if err != nil || !info.Mode().IsRegular() {
			http.NotFound(w, r)
			return
		}
		head := make([]byte, 512)
		n, _ := io.ReadFull(f, head)
		mime := http.DetectContentType(head[:n])
		if !avatarAllowedTypes[mime] {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", mime)
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
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

		// 目录穿越防护：Join 已 Clean，但仍显式确认落在 dist 内。
		// 注意 `/` 会得到 full == dist（没有尾分隔符），必须单独放行，
		// 否则访问站点根路径会变成 404 —— 这条被前端冒烟抓到过。
		distClean := filepath.Clean(dist)
		if full != distClean && !strings.HasPrefix(full, distClean+string(os.PathSeparator)) {
			httpx.NotFound(w, "资源不存在")
			return
		}

		if info, err := os.Stat(full); err == nil && !info.IsDir() {
			if strings.HasPrefix(clean, "/ffmpeg/") {
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			} else if strings.HasPrefix(clean, "/assets/") {
				// vite 产物文件名带内容哈希（含 ffmpeg-core-<hash>.wasm），可长期强缓存
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			} else if strings.HasPrefix(clean, "/live2d/face/") {
				// 人脸模型与 wasm 体积大（合计 15MB），但升级时文件名不变，
				// 所以给一天缓存而不是 immutable。
				w.Header().Set("Cache-Control", "public, max-age=86400")
				// 有些系统的 mime 表里没有 .wasm，显式补上：
				// instantiateStreaming 对 Content-Type 是严格的。
				if strings.HasSuffix(clean, ".wasm") {
					w.Header().Set("Content-Type", "application/wasm")
				}
			}
			// 构建期预压过的资源优先下发 .br 副本（见 scripts/precompress-assets.mjs）
			if servePrecompressed(w, r, full, clean) {
				return
			}
			files.ServeHTTP(w, r)
			return
		}

		// /live2d/ 下的都是「要么有、要么明确没有」的资源文件，不能回 SPA：
		// 回 index.html 会让 wasm/模型报 magic word 之类的错误，离真相很远。
		if strings.HasPrefix(clean, "/live2d/") {
			httpx.NotFound(w, "资源不存在")
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

// precompressedTypes 列出构建期会生成 .br 副本的扩展名，值为该资源的真实 MIME。
//
// 名单与 frontend/scripts/precompress-assets.mjs 的 TARGET_EXT 必须一致：
// 后端只认这几个后缀，其余资源即使有 .br 也不会被误发。
var precompressedTypes = map[string]string{
	".wasm": "application/wasm",
	".task": "application/octet-stream",
}

// servePrecompressed 在有同名 .br 副本且客户端接受 brotli 时直接下发压缩体。
//
// 为什么值得单独做：EdgeOne 自带的 br 是低质量档，MediaPipe 的 10.6MB wasm
// 经它下发是 3.06MB，而 q11 只要 2.17MB。源站一旦带上 Content-Encoding，
// CDN 会整份透传，等于白捡 29% 的首屏动捕下载量。
//
// 命中返回 true（响应已写完），未命中返回 false 交回 FileServer。
func servePrecompressed(w http.ResponseWriter, r *http.Request, full, clean string) bool {
	contentType, ok := precompressedTypes[strings.ToLower(filepath.Ext(clean))]
	if !ok || !acceptsBrotli(r.Header.Get("Accept-Encoding")) {
		return false
	}
	f, err := os.Open(full + ".br")
	if err != nil {
		// 老版本产物没有 .br（或刚升级还没重新构建），静默回退原始文件
		return false
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return false
	}

	w.Header().Set("Content-Encoding", "br")
	w.Header().Set("Content-Type", contentType)
	// ServeContent 在带 Content-Encoding 时故意不写 Content-Length
	// （它担心压缩后长度对不上），但那会让响应退化成 chunked：
	// CDN 缓存与进度条都更愿意拿到确定长度，这里我们自己填。
	w.Header().Set("Content-Length", strconv.FormatInt(info.Size(), 10))
	// 必须带 Vary，否则 CDN 会把 br 版本缓存下来发给不支持 brotli 的客户端
	w.Header().Add("Vary", "Accept-Encoding")
	// 压缩表示的 Range 对客户端没有意义（它要的是解压流里的字节区间），
	// 而 wasm/模型加载本来也不发 Range；去掉以免 ServeContent 按压缩长度切片。
	r.Header.Del("Range")
	http.ServeContent(w, r, path.Base(clean), info.ModTime(), f)
	return true
}

// acceptsBrotli 判断 Accept-Encoding 是否包含 br。
func acceptsBrotli(header string) bool {
	for _, part := range strings.Split(header, ",") {
		// 忽略 q 值：浏览器不支持时根本不会列 br，列了就说明能解
		token := strings.TrimSpace(strings.SplitN(part, ";", 2)[0])
		if strings.EqualFold(token, "br") {
			return true
		}
	}
	return false
}
