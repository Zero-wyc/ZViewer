package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"mime"
	"net/http"
	"strings"

	"zviewer/backend/internal/httpx"
	"zviewer/backend/internal/updater"
)

// desktopUpdateHint 是桌面端托管时更新入口的统一文案。
//
// 与 Node 的 DESKTOP_UPDATE_HINT 逐字一致：前端会把这句话原样显示在
// 「请去 GUI 更新」的提示卡里。
const desktopUpdateHint = "当前由 ZViewer Desktop 桌面端管理，请去 GUI 的更新功能中更新"

// maxUpdateUpload 对齐 Node 的 express.raw({limit: '500mb'})。
const maxUpdateUpload = 500 << 20

// updateUploadTypes 是允许的上传包类型。
//
// 只认这几个：前端直接拿 File 当 body 发，不带 multipart 边界。
// 多一个通配就等于给任意请求体开了一条 500MB 的写盘入口。
var updateUploadTypes = map[string]bool{
	"application/zip":              true,
	"application/gzip":             true,
	"application/octet-stream":     true,
	"application/x-zip-compressed": true,
}

// registerUpdaterRoutes 挂载 /api/system/update。
//
// 三层门禁的顺序与 Node 一致，不能换：
//  1. 鉴权失败 401（RequireRootExact 内部先验 token）
//  2. 非 root 403
//  3. 桌面托管 409
//
// 之所以 409 放在鉴权之后，是因为前端拿 409 才去渲染「去 GUI 更新」的卡片；
// 匿名请求应该先被 401 拦住，否则等于对外暴露「这台机器是桌面版」。
func (s *Server) registerUpdaterRoutes(mux *http.ServeMux) {
	guard := func(next http.HandlerFunc) http.HandlerFunc {
		return s.Auth.RequireRootExact(func(w http.ResponseWriter, r *http.Request) {
			if isDesktopManaged() {
				log.Printf("[updater] blocked %s %s: desktop managed", r.Method, r.URL.RequestURI())
				httpx.JSON(w, http.StatusConflict, struct {
					Success        bool   `json:"success"`
					DesktopManaged bool   `json:"desktopManaged"`
					Message        string `json:"message"`
				}{Success: false, DesktopManaged: true, Message: desktopUpdateHint})
				return
			}
			next(w, r)
		})
	}

	mux.HandleFunc("GET /api/system/update/check", guard(s.handleUpdateCheck))
	mux.HandleFunc("POST /api/system/update/apply-stream", guard(s.handleUpdateApplyStream))
	mux.HandleFunc("POST /api/system/update/apply", guard(s.handleUpdateApply))
	mux.HandleFunc("POST /api/system/update/upload-stream", guard(s.handleUpdateUploadStream))
	mux.HandleFunc("POST /api/system/update/upload", guard(s.handleUpdateUpload))
}

// updateCheckResponse 用结构体而不是 map：map 的键会被按字母序输出，
// `info` 会跑到 `success` 前面，与 Node 的字节顺序对不上。
type updateCheckResponse struct {
	Success bool                `json:"success"`
	Info    *updater.UpdateInfo `json:"info"`
}

// wantPrerelease 复刻 `req.query.includePrerelease === 'true'`。
//
// 同名参数出现多次时 Express 给的是数组，`数组 === 'true'` 恒 false；
// 这里必须同样返回 false，而不是「取第一个」。
func wantPrerelease(r *http.Request) bool {
	values, ok := r.URL.Query()["includePrerelease"]
	if !ok || len(values) != 1 {
		return false
	}
	return values[0] == "true"
}

// handleUpdateCheck 检查更新。
func (s *Server) handleUpdateCheck(w http.ResponseWriter, r *http.Request) {
	info, err := s.Updater.GetUpdateInfo(r.Context(), wantPrerelease(r))
	if err != nil {
		log.Printf("update check error: %v", err)
		httpx.Fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	httpx.OK(w, updateCheckResponse{Success: true, Info: info})
}

// handleUpdateApply 下载并应用更新（无进度，兼容旧接口）。
func (s *Server) handleUpdateApply(w http.ResponseWriter, r *http.Request) {
	// 用 WithoutCancel：Node 侧客户端断开后下载/解压照旧跑完，只是 SSE 写失败。
	// 用请求 context 会在浏览器关页面时把更新打断在半路。
	ctx := context.WithoutCancel(r.Context())
	result, err := s.Updater.ApplyUpdate(ctx, wantPrerelease(r), nil)
	if err != nil {
		log.Printf("update apply error: %v", err)
		httpx.Fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	httpx.OK(w, result)
}

// handleUpdateApplyStream 下载并应用更新（SSE 流式进度）。
func (s *Server) handleUpdateApplyStream(w http.ResponseWriter, r *http.Request) {
	flusher := beginSSE(w)
	emit := func(event updater.StageEvent) { writeSSE(w, flusher, event) }

	ctx := context.WithoutCancel(r.Context())
	if _, err := s.Updater.ApplyUpdate(ctx, wantPrerelease(r), emit); err != nil {
		log.Printf("update apply-stream error: %v", err)
		// 内层出错时已经推过一条 error；这里再推一条是 Node 的既有行为
		// （applyUpdateFromArchive 的 catch 与外层 catch 各推一次），
		// 前端只认最后一条，保持双份让两端日志对得上。
		emit(updater.StageEvent{Stage: updater.StageError, Message: err.Error()})
	}
}

// handleUpdateUploadStream 上传压缩包并应用更新（SSE 流式进度）。
func (s *Server) handleUpdateUploadStream(w http.ResponseWriter, r *http.Request) {
	// 文件校验必须在切 SSE 之前完成：这时还能返回普通 JSON 错误，
	// 前端能按 content-type 走错误分支；切了流就只能从 error 事件里读。
	data, ok := readUpdateUpload(w, r)
	if !ok {
		return
	}
	filename := updateUploadFilename(r)

	flusher := beginSSE(w)
	emit := func(event updater.StageEvent) { writeSSE(w, flusher, event) }

	ctx := context.WithoutCancel(r.Context())
	if _, err := s.Updater.ApplyUpdateFromFile(ctx, data, filename, emit); err != nil {
		log.Printf("update upload-stream error: %v", err)
		emit(updater.StageEvent{Stage: updater.StageError, Message: err.Error()})
	}
}

// handleUpdateUpload 上传压缩包并应用更新（无进度，兼容旧接口）。
func (s *Server) handleUpdateUpload(w http.ResponseWriter, r *http.Request) {
	data, ok := readUpdateUpload(w, r)
	if !ok {
		return
	}
	filename := updateUploadFilename(r)

	ctx := context.WithoutCancel(r.Context())
	result, err := s.Updater.ApplyUpdateFromFile(ctx, data, filename, nil)
	if err != nil {
		log.Printf("update upload error: %v", err)
		httpx.Fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	httpx.OK(w, result)
}

// beginSSE 写 SSE 响应头并立即 flush。
//
// 不设 Connection 之类的 hop-by-hop 头：经过反向代理时这类头会与代理自身的
// 连接管理打架。X-Accel-Buffering: no 是给 nginx 的，关掉它的响应缓冲，
// 否则进度事件会被攒到结束才一起吐出来。
func beginSSE(w http.ResponseWriter) http.Flusher {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher, _ := w.(http.Flusher)
	if flusher != nil {
		flusher.Flush()
	}
	return flusher
}

// writeSSE 写一条 `data: <json>\n\n`。
//
// 用关闭 HTML 转义的编码器：Node 的 JSON.stringify 不会把 `<` 写成 \u003c，
// 解压失败信息里常含 `<path>` 这类片段，转义后两端 SSE 原文就对不上了。
func writeSSE(w http.ResponseWriter, flusher http.Flusher, event updater.StageEvent) {
	var buf bytes.Buffer
	encoder := json.NewEncoder(&buf)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(event); err != nil {
		return
	}
	payload := strings.TrimSuffix(buf.String(), "\n")
	if _, err := fmt.Fprintf(w, "data: %s\n\n", payload); err != nil {
		return
	}
	if flusher != nil {
		flusher.Flush()
	}
}

// readUpdateUpload 按 express.raw 的口径读取上传包。
//
// Content-Type 不在白名单时 Express 根本不会解析 body，`req.body` 是
// undefined，handler 判成「未收到有效的文件数据」——这里同样直接返回 400，
// 而不是先读一遍再说。
func readUpdateUpload(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	contentType := r.Header.Get("Content-Type")
	mediaType, _, err := mime.ParseMediaType(contentType)
	if err != nil || !updateUploadTypes[mediaType] {
		httpx.BadRequest(w, "未收到有效的文件数据")
		return nil, false
	}

	data, err := io.ReadAll(io.LimitReader(r.Body, maxUpdateUpload+1))
	if err != nil || len(data) == 0 {
		httpx.BadRequest(w, "未收到有效的文件数据")
		return nil, false
	}
	if int64(len(data)) > maxUpdateUpload {
		httpx.Fail(w, http.StatusRequestEntityTooLarge, "更新包超过 500MB 上限")
		return nil, false
	}
	return data, true
}

// updateUploadFilename 推断落盘文件名（查询参数优先）。
func updateUploadFilename(r *http.Request) string {
	contentType := r.Header.Get("Content-Type")
	name := "uploaded-update.zip"
	if strings.Contains(contentType, "gzip") || strings.Contains(contentType, "tar") {
		name = "uploaded-update.tar.gz"
	}
	if queryName := r.URL.Query().Get("filename"); queryName != "" {
		name = queryName
	}
	return name
}
