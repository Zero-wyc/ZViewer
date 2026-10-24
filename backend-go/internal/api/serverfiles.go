package api

import (
	"errors"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"

	"zviewer/backend/internal/auth"
	"zviewer/backend/internal/bilibili"
	"zviewer/backend/internal/httpx"
	"zviewer/backend/internal/proxy"
	"zviewer/backend/internal/serverfiles"
	"zviewer/backend/internal/store"
)

// registerServerFilesRoutes 挂载 /api/server-files/*（复刻 routes/serverFiles.ts）。
//
// 鉴权分两档：管理类端点（根目录维护 / 浏览 / 上传 / 改名 / 删除 / B站下载）
// 仅 root；播放类端点（/resolve、/proxy）任何已登录用户可访问，否则观众
// 加载不了房主推送的服务器本地视频。
func (s *Server) registerServerFilesRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/server-files/roots", s.Auth.RequireRoot(s.handleSFListRoots))
	mux.HandleFunc("POST /api/server-files/roots", s.Auth.RequireRoot(s.handleSFAddRoot))
	mux.HandleFunc("DELETE /api/server-files/roots/{id}", s.Auth.RequireRoot(s.handleSFDeleteRoot))

	mux.HandleFunc("GET /api/server-files/browse", s.Auth.RequireRoot(s.handleSFBrowse))
	mux.HandleFunc("GET /api/server-files/browse-system", s.Auth.RequireRoot(s.handleSFBrowseSystem))

	mux.HandleFunc("POST /api/server-files/upload", s.Auth.RequireRoot(s.handleSFUpload))
	mux.HandleFunc("POST /api/server-files/folder", s.Auth.RequireRoot(s.handleSFCreateFolder))
	mux.HandleFunc("POST /api/server-files/rename", s.Auth.RequireRoot(s.handleSFRename))
	mux.HandleFunc("DELETE /api/server-files/file", s.Auth.RequireRoot(s.handleSFDeleteFile))
	mux.HandleFunc("POST /api/server-files/bilibili-download", s.Auth.RequireRoot(s.handleSFBilibiliDownload))

	mux.HandleFunc("GET /api/server-files/resolve", s.Auth.Require(s.handleSFResolve))
	mux.HandleFunc("GET /api/server-files/proxy", s.Auth.Require(s.handleSFProxy))
}

// illegalNameChars 是文件名里不允许出现的字符（Windows 保留字符 + 路径分隔符）。
var illegalNameChars = regexp.MustCompile(`[\\/:*?"<>|]`)

// sfRootDTO 是根目录的下发结构。
type sfRootDTO struct {
	Key      string `json:"key"`
	Name     string `json:"name"`
	AbsPath  string `json:"absPath"`
	Readonly bool   `json:"readonly"`
	Exists   bool   `json:"exists"`
}

// sfEntryDTO 是一条目录项。Size 用指针：目录不带 size 键
// （Node 里是 `undefined`，JSON.stringify 会整键丢弃）。
type sfEntryDTO struct {
	Name       string `json:"name"`
	Path       string `json:"path"`
	Type       string `json:"type"`
	Size       *int64 `json:"size,omitempty"`
	ModifiedAt string `json:"modifiedAt"`
}

// sfSystemEntryDTO 是系统盘符 / 目录项（browse-system 专用）。
type sfSystemEntryDTO struct {
	Name    string `json:"name"`
	AbsPath string `json:"absPath"`
}

// ==================== 1. 根目录管理 ====================

func (s *Server) handleSFListRoots(w http.ResponseWriter, r *http.Request) {
	roots, err := s.Files.Load(r.Context())
	if err != nil {
		log.Printf("[server-files] 加载根目录失败: %v", err)
		httpx.Fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	list := make([]sfRootDTO, 0, len(roots))
	for _, root := range roots {
		list = append(list, sfRootDTO{
			Key:      root.Key,
			Name:     root.Name,
			AbsPath:  root.AbsPath,
			Readonly: root.Readonly,
			Exists:   dirExists(root.AbsPath),
		})
	}
	httpx.OK(w, map[string]any{"success": true, "roots": list})
}

func (s *Server) handleSFAddRoot(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name     string `json:"name"`
		AbsPath  string `json:"absPath"`
		Readonly bool   `json:"readonly"`
	}
	if err := httpx.DecodeJSON(r, &body); err != nil {
		httpx.BadRequest(w, "请求体格式错误")
		return
	}
	name := strings.TrimSpace(body.Name)
	absPath := strings.TrimSpace(body.AbsPath)
	if name == "" {
		httpx.BadRequest(w, "名称不能为空")
		return
	}
	if absPath == "" {
		httpx.BadRequest(w, "目录路径不能为空")
		return
	}
	resolved, err := filepath.Abs(absPath)
	if err != nil {
		httpx.BadRequest(w, "目录不存在或无访问权限")
		return
	}
	resolved = filepath.Clean(resolved)
	if samePath(resolved, s.Files.UploadsRoot().AbsPath) {
		httpx.BadRequest(w, "该目录已是默认空间")
		return
	}
	info, statErr := os.Stat(resolved)
	if statErr != nil {
		httpx.BadRequest(w, "目录不存在或无访问权限")
		return
	}
	if !info.IsDir() {
		httpx.BadRequest(w, "路径不是目录")
		return
	}
	if s.ServerFolders != nil {
		if _, findErr := s.ServerFolders.FindByAbsPath(r.Context(), resolved); findErr == nil {
			httpx.BadRequest(w, "该目录已添加")
			return
		} else if !errors.Is(findErr, store.ErrServerFolderNotFound) {
			httpx.Fail(w, http.StatusInternalServerError, findErr.Error())
			return
		}
	}

	saved, err := s.ServerFolders.Create(r.Context(), name, resolved, body.Readonly)
	if err != nil {
		httpx.Fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.Files.Invalidate()
	httpx.OK(w, map[string]any{
		"success": true,
		"root": sfRootDTO{
			Key:      "custom:" + itoa64(saved.ID),
			Name:     saved.Name,
			AbsPath:  saved.AbsPath,
			Readonly: saved.Readonly,
			Exists:   true,
		},
	})
}

func (s *Server) handleSFDeleteRoot(w http.ResponseWriter, r *http.Request) {
	id, ok := parsePositiveID(w, r.PathValue("id"), "无效的 ID")
	if !ok {
		return
	}
	if err := s.ServerFolders.Delete(r.Context(), id); err != nil {
		if errors.Is(err, store.ErrServerFolderNotFound) {
			httpx.NotFound(w, "根目录不存在")
			return
		}
		httpx.Fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.Files.Invalidate()
	httpx.OK(w, map[string]any{"success": true})
}

// ==================== 2. 浏览目录 ====================

func (s *Server) handleSFBrowse(w http.ResponseWriter, r *http.Request) {
	roots, err := s.Files.Load(r.Context())
	if err != nil {
		httpx.BadRequest(w, err.Error())
		return
	}
	abs, root, err := serverfiles.ResolveSafePath(r.URL.Query().Get("path"), roots)
	if err != nil {
		httpx.BadRequest(w, err.Error())
		return
	}
	entries, listErr := listEntries(root, abs)
	if listErr != nil {
		httpx.BadRequest(w, listErr.Error())
		return
	}
	httpx.OK(w, map[string]any{
		"success":     true,
		"entries":     entries,
		"currentPath": serverfiles.ToPrefixedPath(root, abs),
		"readonly":    root.Readonly,
	})
}

// listEntries 列目录项：隐藏文件（点开头）剔除，目录在前，其余按中文排序。
//
// stat 失败的子项直接跳过（断链的符号链接、权限不足的文件），
// 与 Node 里 `catch { return null }` 后 filter 掉 null 等价。
func listEntries(root serverfiles.RootInfo, abs string) ([]sfEntryDTO, error) {
	info, err := os.Stat(abs)
	if err != nil || !info.IsDir() {
		// 目录不存在 / 不是目录：Node 回 200 + 空列表，前端据此显示空态。
		return []sfEntryDTO{}, nil
	}
	items, err := os.ReadDir(abs)
	if err != nil {
		return nil, err
	}
	entries := make([]sfEntryDTO, 0, len(items))
	for _, item := range items {
		if strings.HasPrefix(item.Name(), ".") {
			continue
		}
		childAbs := filepath.Join(abs, item.Name())
		childInfo, statErr := os.Stat(childAbs)
		if statErr != nil {
			continue
		}
		entry := sfEntryDTO{
			Name:       item.Name(),
			Path:       serverfiles.ToPrefixedPath(root, childAbs),
			Type:       "file",
			ModifiedAt: childInfo.ModTime().UTC().Format("2006-01-02T15:04:05.000Z"),
		}
		if item.IsDir() {
			entry.Type = "directory"
		} else {
			size := childInfo.Size()
			entry.Size = &size
		}
		entries = append(entries, entry)
	}
	sort.SliceStable(entries, func(i, j int) bool {
		if entries[i].Type != entries[j].Type {
			return entries[i].Type == "directory"
		}
		return serverfiles.CompareNames(entries[i].Name, entries[j].Name) < 0
	})
	return entries, nil
}

// ==================== 2.5 系统级目录浏览 ====================

// handleSFBrowseSystem 浏览服务器任意目录（仅目录），供「添加根目录」时选路径。
//
// 不受注册根限制是有意为之：用户添加根目录之前不可能有它的根条目。
// 端点仅 root 可访问，且只回目录名，不回文件内容。
func (s *Server) handleSFBrowseSystem(w http.ResponseWriter, r *http.Request) {
	rawPath := strings.TrimSpace(r.URL.Query().Get("absPath"))
	isWindows := runtime.GOOS == "windows"

	if rawPath == "" {
		if isWindows {
			httpx.OK(w, map[string]any{
				"success":     true,
				"entries":     windowsDrives(),
				"currentPath": "",
				"isRoot":      true,
			})
			return
		}
		httpx.OK(w, map[string]any{
			"success":     true,
			"entries":     childDirectories("/"),
			"currentPath": "/",
			"isRoot":      true,
		})
		return
	}

	resolved, err := filepath.Abs(rawPath)
	if err != nil {
		httpx.BadRequest(w, "路径不存在或无访问权限")
		return
	}
	resolved = filepath.Clean(resolved)
	info, statErr := os.Stat(resolved)
	if statErr != nil {
		httpx.BadRequest(w, "路径不存在或无访问权限")
		return
	}
	if !info.IsDir() {
		httpx.BadRequest(w, "路径不是目录")
		return
	}

	parentPath := ""
	if isWindows {
		// D:\folder 的父级是 D:\，而 D:\ 自身没有「上一级」。
		if vol := filepath.VolumeName(resolved); vol != "" && resolved != vol+string(filepath.Separator) {
			parentPath = filepath.Dir(resolved)
		}
	} else if resolved != "/" {
		parentPath = filepath.Dir(resolved)
	}

	httpx.OK(w, map[string]any{
		"success":     true,
		"entries":     childDirectories(resolved),
		"currentPath": resolved,
		"parentPath":  parentPath,
		"isRoot":      false,
	})
}

// windowsDrives 枚举存在的盘符（A:..Z:）。
func windowsDrives() []sfSystemEntryDTO {
	drives := make([]sfSystemEntryDTO, 0, 4)
	for code := 'A'; code <= 'Z'; code++ {
		letter := string(code)
		drivePath := letter + ":\\"
		if info, err := os.Stat(drivePath); err == nil && info.IsDir() {
			drives = append(drives, sfSystemEntryDTO{Name: letter + ":", AbsPath: drivePath})
		}
	}
	return drives
}

// childDirectories 列出某目录下的子目录（隐藏目录剔除，按中文排序）。
func childDirectories(dir string) []sfSystemEntryDTO {
	items, err := os.ReadDir(dir)
	if err != nil {
		return []sfSystemEntryDTO{}
	}
	entries := make([]sfSystemEntryDTO, 0, len(items))
	for _, item := range items {
		if !item.IsDir() || strings.HasPrefix(item.Name(), ".") {
			continue
		}
		entries = append(entries, sfSystemEntryDTO{
			Name:    item.Name(),
			AbsPath: filepath.Join(dir, item.Name()),
		})
	}
	sort.SliceStable(entries, func(i, j int) bool {
		return serverfiles.CompareNames(entries[i].Name, entries[j].Name) < 0
	})
	return entries
}

// ==================== 3. 上传 ====================

func (s *Server) handleSFUpload(w http.ResponseWriter, r *http.Request) {
	reader, err := r.MultipartReader()
	if err != nil {
		// 非 multipart 请求：multer 侧同样是「req.files 为空」→ 同一句文案。
		httpx.BadRequest(w, "未接收到文件")
		return
	}
	files, uploadErr := s.Files.ReceiveUploads(r.Context(), reader)
	if uploadErr != nil {
		httpx.BadRequest(w, uploadErr.Error())
		return
	}
	if len(files) == 0 {
		httpx.BadRequest(w, "未接收到文件")
		return
	}
	httpx.OK(w, map[string]any{"success": true, "files": files})
}

// ==================== 4. 新建文件夹 ====================

func (s *Server) handleSFCreateFolder(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Parent string `json:"parent"`
		Name   string `json:"name"`
	}
	if err := httpx.DecodeJSON(r, &body); err != nil {
		httpx.BadRequest(w, "请求体格式错误")
		return
	}
	parent := body.Parent
	if parent == "" {
		parent = "/"
	}
	name := strings.TrimSpace(body.Name)
	if name == "" {
		httpx.BadRequest(w, "文件夹名称不能为空")
		return
	}
	if illegalNameChars.MatchString(name) {
		httpx.BadRequest(w, "文件夹名称包含非法字符")
		return
	}
	parentAbs, root, ok := s.resolveWritable(w, r, parent)
	if !ok {
		return
	}
	targetAbs := filepath.Join(parentAbs, name)
	if !withinRoot(root, targetAbs) {
		httpx.BadRequest(w, "路径越权")
		return
	}
	if _, err := os.Stat(targetAbs); err == nil {
		httpx.BadRequest(w, "同名项目已存在")
		return
	}
	if err := os.MkdirAll(targetAbs, 0o755); err != nil {
		httpx.BadRequest(w, err.Error())
		return
	}
	httpx.OK(w, map[string]any{"success": true, "path": serverfiles.ToPrefixedPath(root, targetAbs)})
}

// ==================== 5. 重命名 ====================

func (s *Server) handleSFRename(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Path    string `json:"path"`
		NewName string `json:"newName"`
	}
	if err := httpx.DecodeJSON(r, &body); err != nil {
		httpx.BadRequest(w, "请求体格式错误")
		return
	}
	if body.Path == "" || strings.TrimSpace(body.NewName) == "" {
		httpx.BadRequest(w, "缺少 path 或 newName 参数")
		return
	}
	newName := strings.TrimSpace(body.NewName)
	if illegalNameChars.MatchString(newName) {
		httpx.BadRequest(w, "名称包含非法字符")
		return
	}
	oldAbs, root, ok := s.resolveWritable(w, r, body.Path)
	if !ok {
		return
	}
	if _, err := os.Stat(oldAbs); err != nil {
		httpx.NotFound(w, "原文件不存在")
		return
	}
	newAbs := filepath.Join(filepath.Dir(oldAbs), newName)
	if !withinRoot(root, newAbs) {
		httpx.BadRequest(w, "路径越权")
		return
	}
	if oldAbs != newAbs {
		if _, err := os.Stat(newAbs); err == nil {
			httpx.BadRequest(w, "同名项目已存在")
			return
		}
	}
	if err := os.Rename(oldAbs, newAbs); err != nil {
		httpx.BadRequest(w, err.Error())
		return
	}
	httpx.OK(w, map[string]any{"success": true, "path": serverfiles.ToPrefixedPath(root, newAbs)})
}

// ==================== 6. 删除 ====================

func (s *Server) handleSFDeleteFile(w http.ResponseWriter, r *http.Request) {
	target := r.URL.Query().Get("path")
	if target == "" || target == "/" || strings.HasSuffix(target, ":/") || strings.HasSuffix(target, ":") {
		httpx.BadRequest(w, "不能删除根目录")
		return
	}
	targetAbs, root, ok := s.resolveWritable(w, r, target)
	if !ok {
		return
	}
	if targetAbs == root.AbsPath {
		httpx.BadRequest(w, "不能删除根目录")
		return
	}
	if _, err := os.Stat(targetAbs); err != nil {
		httpx.NotFound(w, "文件不存在")
		return
	}
	if err := os.RemoveAll(targetAbs); err != nil {
		httpx.BadRequest(w, err.Error())
		return
	}
	httpx.OK(w, map[string]any{"success": true})
}

// ==================== 7. 解析为播放地址 ====================

func (s *Server) handleSFResolve(w http.ResponseWriter, r *http.Request) {
	target := r.URL.Query().Get("path")
	if strings.TrimSpace(target) == "" {
		httpx.BadRequest(w, "缺少 path 参数")
		return
	}
	roots, err := s.Files.Load(r.Context())
	if err != nil {
		httpx.BadRequest(w, err.Error())
		return
	}
	targetAbs, _, resolveErr := serverfiles.ResolveSafePath(target, roots)
	if resolveErr != nil {
		httpx.BadRequest(w, resolveErr.Error())
		return
	}
	info, statErr := os.Stat(targetAbs)
	if statErr != nil || info.IsDir() {
		httpx.NotFound(w, "文件不存在")
		return
	}
	name := serverfiles.BaseName(targetAbs)
	format := proxy.DetectMediaFormat(name)
	httpx.OK(w, map[string]any{
		"success": true,
		"title":   name,
		// 相对路径：前端按当前 origin 解析，反向代理后 http/https 才不会错。
		"videoUrl": "/api/server-files/proxy?path=" + urlQueryEscape(target),
		"format":   format,
		// 音轨探测已前端化（浏览器内 MKV demux），服务端不再返回。
		"audioCodec": nil,
		"duration":   nil,
		"size":       info.Size(),
	})
}

// ==================== 8. 流式代理播放 ====================

// AVPlayer 预读限速参数：原生播放器拿到 AVPlayerItem 后会持续预读整个文件，
// 不限速会把带宽吃满。数值与 serverFiles.ts 保持一致。
const (
	avplayerMaxBytesPerSecond int64 = 8 * 1024 * 1024
	avplayerInitialBurstBytes int64 = 16 * 1024 * 1024
)

func (s *Server) handleSFProxy(w http.ResponseWriter, r *http.Request) {
	target := r.URL.Query().Get("path")
	if strings.TrimSpace(target) == "" {
		if r.Method == http.MethodHead {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		httpx.BadRequest(w, "缺少 path 参数")
		return
	}
	roots, err := s.Files.Load(r.Context())
	if err != nil {
		if r.Method == http.MethodHead {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		httpx.BadRequest(w, err.Error())
		return
	}
	targetAbs, _, resolveErr := serverfiles.ResolveSafePath(target, roots)
	if resolveErr != nil {
		if r.Method == http.MethodHead {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		httpx.BadRequest(w, resolveErr.Error())
		return
	}
	info, statErr := os.Stat(targetAbs)
	if statErr != nil || info.IsDir() {
		if r.Method == http.MethodHead {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		httpx.NotFound(w, "文件不存在")
		return
	}

	fileSize := info.Size()
	format := proxy.DetectMediaFormat(target)
	contentType := proxy.ContentTypeForFormat(format)

	if r.Method == http.MethodHead {
		// 前端 direct-engine attach 时的元信息探测：只回头，不读一个字节。
		proxy.SetWildcardCORS(w)
		w.Header().Set("Content-Type", contentType)
		w.Header().Set("Accept-Ranges", "bytes")
		w.Header().Set("Content-Length", itoa64(fileSize))
		w.WriteHeader(http.StatusOK)
		return
	}

	avPlayer := r.URL.Query().Get("rangeMode") == "avplayer"
	rangeHeader := r.Header.Get("Range")
	if rangeHeader != "" {
		// avplayer 模式要完整范围（原生播放器会校验 Content-Range），
		// 其余模式按 8MiB 分片上限截断，避免客户端中途取消时浪费流量。
		maxChunk := proxy.MaxRangeChunkBytes
		if avPlayer {
			maxChunk = 0
		}
		parsed, err := proxy.ParseRangeHeader(rangeHeader, fileSize, maxChunk)
		if err != nil {
			proxy.SendRangeNotSatisfiable(w, fileSize)
			return
		}
		start, end := int64(0), fileSize-1
		if parsed != nil {
			start, end = parsed.Start, parsed.End
		}
		f, openErr := os.Open(targetAbs)
		if openErr != nil {
			httpx.Fail(w, http.StatusBadRequest, "文件读取失败")
			return
		}
		if _, seekErr := f.Seek(start, 0); seekErr != nil {
			_ = f.Close()
			httpx.Fail(w, http.StatusBadRequest, "文件读取失败")
			return
		}
		opts := proxy.PipeRangeStreamOptions{
			Stream:       &limitedReadCloser{reader: io.LimitReader(f, end-start+1), closer: f},
			ContentType:  contentType,
			FileSize:     &fileSize,
			Start:        &start,
			End:          &end,
			Ranged:       true,
			LogTag:       "server-files",
			ErrorMessage: "文件读取失败",
		}
		if avPlayer {
			opts.MaxBytesPerSecond = avplayerMaxBytesPerSecond
			opts.InitialBurstBytes = avplayerInitialBurstBytes
		}
		proxy.PipeRangeStream(w, r, opts)
		return
	}

	f, openErr := os.Open(targetAbs)
	if openErr != nil {
		httpx.Fail(w, http.StatusBadRequest, "文件读取失败")
		return
	}
	opts := proxy.PipeRangeStreamOptions{
		Stream:       f,
		ContentType:  contentType,
		FileSize:     &fileSize,
		Ranged:       false,
		LogTag:       "server-files",
		ErrorMessage: "文件读取失败",
	}
	if avPlayer {
		opts.MaxBytesPerSecond = avplayerMaxBytesPerSecond
		opts.InitialBurstBytes = avplayerInitialBurstBytes
	}
	proxy.PipeRangeStream(w, r, opts)
}

// ==================== 9. B站 视频下载 ====================

// handleSFBilibiliDownload 解析 B站 视频并下载到服务器目录（NDJSON 进度）。
//
// 只走 MP4 单文件直链（最高 720P）：DASH 分离流要服务端 FFmpeg 合并，
// 而服务端 FFmpeg 已随「浏览器内转码」方案移除。高画质请用 CLI 模式下载。
func (s *Server) handleSFBilibiliDownload(w http.ResponseWriter, r *http.Request) {
	var body struct {
		URL       string   `json:"url"`
		TargetDir string   `json:"targetDir"`
		Filename  string   `json:"filename"`
		Qn        *float64 `json:"qn"`
		Page      *float64 `json:"page"`
	}
	if err := httpx.DecodeJSON(r, &body); err != nil {
		httpx.BadRequest(w, "请求体格式错误")
		return
	}

	rawURL := strings.TrimSpace(body.URL)
	expanded := bilibiliExpand(r, rawURL)
	if strings.TrimSpace(rawURL) == "" {
		httpx.BadRequest(w, "缺少视频链接或 BV 号")
		return
	}
	if bilibiliExtractBvid(expanded) == "" {
		httpx.BadRequest(w, "无法解析 B站 BV 号")
		return
	}
	targetDir := strings.TrimSpace(body.TargetDir)
	if targetDir == "" {
		httpx.BadRequest(w, "缺少目标目录")
		return
	}

	writer := newNDJSONWriter(w)
	fail := func(message string, code string) {
		writer.send(map[string]any{
			"success": false, "status": "error", "message": message, "code": code,
		})
	}

	roots, err := s.Files.Load(r.Context())
	if err != nil {
		fail(err.Error(), "")
		return
	}
	dirAbs, root, resolveErr := serverfiles.ResolveSafePath(targetDir, roots)
	if resolveErr != nil {
		fail(resolveErr.Error(), "")
		return
	}
	if root.Readonly {
		fail("该根目录为只读", "")
		return
	}
	if mkErr := os.MkdirAll(dirAbs, 0o755); mkErr != nil {
		fail(mkErr.Error(), "")
		return
	}

	claims := claimsOf(r)
	cookie := ""
	if s.Bilibili != nil && claims != nil && claims.UserID > 0 {
		cookie = s.Bilibili.Creds.GetCookie(r.Context(), itoa64(claims.UserID))
	}

	writer.send(map[string]any{"status": "parsing", "step": "resolve", "message": "正在解析视频地址..."})
	qn := 0
	if body.Qn != nil {
		qn = int(*body.Qn)
	}
	page := 0
	if body.Page != nil {
		page = int(*body.Page)
	}
	result, resolveErr := s.Bilibili.Resolve(r.Context(), bilibili.ResolveOptions{
		URL:       expanded,
		Cookie:    cookie,
		Qn:        qn,
		Page:      page,
		PreferMp4: true,
		// 下载本身就是连通性验证，跳过 CDN HEAD 探测（省 3.5s）。
		SkipCdnCheck: true,
		OnProgress: func(msg bilibili.ResolveProgress) {
			writer.send(map[string]any{"status": "parsing", "step": msg.Step, "message": msg.Message})
		},
	})
	if resolveErr != nil {
		code, message := bilibili.NormalizeResolveError(resolveErr)
		fail(message, code)
		return
	}
	if result.VideoURL == "" {
		fail("解析失败：未获取到视频直链", "")
		return
	}
	// VIP 强校验：后端已按会员过滤清晰度，这里再兜一层防前端绕过。
	if qn > 0 && bilibili.IsVipOnlyQn(qn) && result.VipStatus != 1 {
		fail("该清晰度需要大会员账号，请先在个人中心绑定大会员账号后重试，或选择 1080P 及以下清晰度", "VIP_REQUIRED")
		return
	}

	title := body.Filename
	if title == "" {
		title = result.Title
	}
	if title == "" {
		title = "bilibili_" + itoa64(serverfiles.NowMillis())
	}
	title = illegalNameChars.ReplaceAllString(title, "_")
	finalName := serverfiles.UniqueFilename(dirAbs, title+".mp4")
	targetPath := filepath.Join(dirAbs, finalName)

	writer.send(map[string]any{
		"status": "downloading", "phase": "video", "message": "开始下载...",
		"received": 0, "total": 0, "percent": 0,
	})
	headers := map[string]string{
		"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
		"Referer":    "https://www.bilibili.com",
		"Origin":     "https://www.bilibili.com",
	}
	if cookie != "" {
		headers["Cookie"] = cookie
	}
	if _, dlErr := serverfiles.DownloadToFile(r.Context(), result.VideoURL, targetPath, headers,
		func(p serverfiles.DownloadProgress) {
			writer.send(map[string]any{
				"status": "downloading", "phase": "video",
				"received": p.Received, "total": p.Total, "percent": p.Percent,
			})
		}); dlErr != nil {
		_ = os.Remove(targetPath)
		fail("下载失败："+dlErr.Error(), "")
		return
	}

	writer.send(map[string]any{
		"success": true,
		"status":  "done",
		"file": map[string]any{
			"name": finalName,
			"path": serverfiles.ToPrefixedPath(root, targetPath),
			"size": serverfiles.StatSize(targetPath),
		},
	})
}

// ==================== 内部辅助 ====================

// resolveWritable 解析路径并校验根可写；失败时已写好响应。
func (s *Server) resolveWritable(w http.ResponseWriter, r *http.Request, input string) (string, serverfiles.RootInfo, bool) {
	roots, err := s.Files.Load(r.Context())
	if err != nil {
		httpx.BadRequest(w, err.Error())
		return "", serverfiles.RootInfo{}, false
	}
	abs, root, resolveErr := serverfiles.ResolveSafePath(input, roots)
	if resolveErr != nil {
		httpx.BadRequest(w, resolveErr.Error())
		return "", serverfiles.RootInfo{}, false
	}
	if root.Readonly {
		httpx.BadRequest(w, "该根目录为只读")
		return "", serverfiles.RootInfo{}, false
	}
	return abs, root, true
}

// withinRoot 判断绝对路径是否仍在根目录内（含根本身）。
func withinRoot(root serverfiles.RootInfo, abs string) bool {
	rel, err := filepath.Rel(root.AbsPath, abs)
	if err != nil {
		return false
	}
	return rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel))
}

func dirExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

// samePath 按平台语义比较两个绝对路径（Windows 大小写不敏感）。
func samePath(a, b string) bool {
	if runtime.GOOS == "windows" {
		return strings.EqualFold(filepath.Clean(a), filepath.Clean(b))
	}
	return filepath.Clean(a) == filepath.Clean(b)
}

// parsePositiveID 解析正整数路径参数；失败时已写好 400 响应。
func parsePositiveID(w http.ResponseWriter, raw, message string) (int64, bool) {
	id, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || id <= 0 {
		httpx.BadRequest(w, message)
		return 0, false
	}
	return id, true
}

// itoa64 是 strconv.FormatInt 的短封装（本文件用得极多）。
func itoa64(v int64) string { return strconv.FormatInt(v, 10) }

// claimsOf 取当前请求的登录态（未登录返回 nil）。
func claimsOf(r *http.Request) *auth.Claims { return auth.ClaimsFrom(r.Context()) }

// bilibiliExpand 展开 b23.tv 短链（失败时原样返回）。
func bilibiliExpand(r *http.Request, raw string) string {
	if raw == "" {
		return ""
	}
	return bilibili.ExpandShortLink(r.Context(), raw)
}

// bilibiliExtractBvid 提取 BV/av 号（空串表示无法识别）。
func bilibiliExtractBvid(input string) string { return bilibili.ExtractBvid(input) }
