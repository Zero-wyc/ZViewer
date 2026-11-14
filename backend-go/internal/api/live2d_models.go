package api

import (
	"archive/zip"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode"

	"zviewer/backend/internal/auth"
	"zviewer/backend/internal/httpx"
	"zviewer/backend/internal/store"
)

// 房间级 Live2D 模型库：房主把模型 zip 传上来，全房间共用一份。
//
// 落盘形状（UPLOADS_DIR/live2d/<roomId>/<modelId>/）：
//
//	model.model3.json   入口固定名字，前端与协议只认这一个
//	_meta.json          显示名 / 上传时间 / 解压后字节数
//	…                   纹理、动作、物理、音频，层级按压缩包原样保留
//
// 为什么入口要固定名字：live2d-config 只同步 modelId，各客户端要靠
// 同一套规则自己拼出地址（见前端 core/model-url.ts）。让服务端在解压时
// 把入口重命名成固定名，前端就不必先拉一次清单才知道入口叫什么。
//
// 安全边界全在服务端：压缩包是用户输入，必须防目录穿越、防 zip bomb、
// 防可执行文件落地；静态下发时再加 nosniff + CSP sandbox，杜绝把上传的
// 文件当脚本执行。

const (
	// 压缩包上限。Live2D 模型是贴图为主，48MB 足够放下 4K 贴图的整套。
	live2dUploadMaxBytes = 48 << 20
	// 解压后总字节上限（zip bomb 的主要防线，配合条目数与逐文件限读）。
	live2dExtractMaxBytes = 192 << 20
	// 条目数上限：官方模型通常 < 200，3000 已经是宽松值。
	live2dMaxEntries = 3000
	// 每个房间的模型数量上限，防止磁盘被单房间吃掉。
	live2dMaxModelsPerRoom = 8

	live2dEntryFile = "model.model3.json"
	live2dMetaFile  = "_meta.json"
	live2dUploadKey = "file"
)

// 允许落地的后缀。**白名单**而不是黑名单：压缩包里出现 .exe/.dll/.js
// 一律整包拒绝，避免上传目录变成可执行落点。
var live2dAllowedExts = map[string]bool{
	".moc3": true,
	".json": true,
	".png":  true,
	".jpg":  true,
	".jpeg": true,
	".webp": true,
	".wav":  true,
	".mp3":  true,
	".ogg":  true,
	".txt":  true,
	".md":   true,
}

var (
	live2dModelIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
	// 房间号由系统生成，格式与 live2d_handlers.go 里的判定保持一致。
	live2dRoomPathPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
)

// live2dModelMeta 是 _meta.json 的内容，同时也是列表接口的 DTO。
type live2dModelMeta struct {
	ID        string `json:"id"`
	Label     string `json:"label"`
	Entry     string `json:"entry"`
	Bytes     int64  `json:"bytes"`
	CreatedAt string `json:"createdAt"`
}

func (s *Server) registerLive2DModelRoutes(mux *http.ServeMux) {
	// 列表对所有登录用户开放：观众也要加载房主传的模型。
	mux.HandleFunc("GET /api/rooms/{roomId}/live2d/models", s.Auth.Require(s.handleListLive2DModels))
	// 上传/删除只给房主（root 或房间创建者），与 socket 侧的 requireHost 同口径。
	mux.HandleFunc("POST /api/rooms/{roomId}/live2d/models", s.Auth.Require(s.handleUploadLive2DModel))
	mux.HandleFunc("DELETE /api/rooms/{roomId}/live2d/models/{modelId}", s.Auth.Require(s.handleDeleteLive2DModel))
}

// live2dRoot 返回模型库根目录。
//
// 不强制要求配置里有 Live2DDir：单测构造 Server 时只给了 UploadsDir，
// 这里按同样的规则兜底，生产路径由 config.Load 显式赋值。
func (s *Server) live2dRoot() string {
	if s.Cfg.Live2DDir != "" {
		return s.Cfg.Live2DDir
	}
	return filepath.Join(s.Cfg.UploadsDir, "live2d")
}

func (s *Server) live2dRoomDir(roomID string) string {
	return filepath.Join(s.live2dRoot(), roomID)
}

// ==================== 列表 ====================

func (s *Server) handleListLive2DModels(w http.ResponseWriter, r *http.Request) {
	roomID := r.PathValue("roomId")
	if !live2dRoomPathPattern.MatchString(roomID) {
		httpx.BadRequest(w, "房间号不正确")
		return
	}
	room, err := s.Rooms.FindByRoomID(r.Context(), roomID)
	if err != nil {
		if errors.Is(err, store.ErrRoomNotFound) {
			httpx.NotFound(w, "房间不存在")
			return
		}
		httpx.InternalError(w, "live2d-models/list", err)
		return
	}
	httpx.OK(w, map[string]any{
		"success": true,
		"models":  s.readLive2DModels(roomID),
		// 房主才能在界面上传/删除，前端据此决定是否显示入口。
		"canManage": canControlRoom(auth.ClaimsFrom(r.Context()), room),
	})
}

// readLive2DModels 扫描房间目录。坏掉/手改的目录一律跳过而不是报错：
// 一个坏模型不该让整个面板打不开。
func (s *Server) readLive2DModels(roomID string) []live2dModelMeta {
	out := make([]live2dModelMeta, 0, 4)
	entries, err := os.ReadDir(s.live2dRoomDir(roomID))
	if err != nil {
		return out
	}
	for _, entry := range entries {
		if !entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		id := entry.Name()
		if !live2dModelIDPattern.MatchString(id) {
			continue
		}
		meta := live2dModelMeta{ID: id, Label: id, Entry: live2dEntryFile}
		if raw, err := os.ReadFile(filepath.Join(s.live2dRoomDir(roomID), id, live2dMetaFile)); err == nil {
			var stored live2dModelMeta
			if json.Unmarshal(raw, &stored) == nil {
				if strings.TrimSpace(stored.Label) != "" {
					meta.Label = stored.Label
				}
				meta.Bytes = stored.Bytes
				meta.CreatedAt = stored.CreatedAt
			}
		}
		// 入口缺失说明目录不完整（删到一半 / 手工拷贝），列表里剔除。
		if _, err := os.Stat(filepath.Join(s.live2dRoomDir(roomID), id, live2dEntryFile)); err != nil {
			continue
		}
		out = append(out, meta)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].CreatedAt == out[j].CreatedAt {
			return out[i].ID < out[j].ID
		}
		return out[i].CreatedAt < out[j].CreatedAt
	})
	return out
}

// ==================== 上传 ====================

func (s *Server) handleUploadLive2DModel(w http.ResponseWriter, r *http.Request) {
	roomID := r.PathValue("roomId")
	if !live2dRoomPathPattern.MatchString(roomID) {
		httpx.BadRequest(w, "房间号不正确")
		return
	}
	claims := auth.ClaimsFrom(r.Context())
	room, err := s.Rooms.FindByRoomID(r.Context(), roomID)
	if err != nil {
		if errors.Is(err, store.ErrRoomNotFound) {
			httpx.NotFound(w, "房间不存在")
			return
		}
		httpx.InternalError(w, "live2d-models/upload", err)
		return
	}
	if !canControlRoom(claims, room) {
		httpx.Forbidden(w, "无权限：只有房主可以上传模型")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, live2dUploadMaxBytes+1<<20)
	// 8MB 放内存，其余落临时文件：48MB 全塞内存对多人同时上传不友好。
	if err := r.ParseMultipartForm(8 << 20); err != nil {
		httpx.BadRequest(w, "模型包上传失败："+multipartErrorText(err))
		return
	}
	defer r.MultipartForm.RemoveAll()

	file, header, err := r.FormFile(live2dUploadKey)
	if err != nil {
		httpx.BadRequest(w, "未接收到模型压缩包")
		return
	}
	defer file.Close()

	if header.Size > live2dUploadMaxBytes {
		httpx.BadRequest(w, fmt.Sprintf("模型包不能超过 %dMB", live2dUploadMaxBytes>>20))
		return
	}
	readerAt, ok := file.(io.ReaderAt)
	if !ok {
		httpx.InternalError(w, "live2d-models/upload", errors.New("multipart 文件不支持随机读"))
		return
	}
	zr, err := zip.NewReader(readerAt, header.Size)
	if err != nil {
		httpx.BadRequest(w, "不是有效的 zip 压缩包")
		return
	}

	if len(s.readLive2DModels(roomID)) >= live2dMaxModelsPerRoom {
		httpx.BadRequest(w, fmt.Sprintf("每个房间最多 %d 个模型，请先删掉不用的", live2dMaxModelsPerRoom))
		return
	}

	plan, problem := planLive2DExtract(zr.File)
	if problem != "" {
		httpx.BadRequest(w, problem)
		return
	}

	roomDir := s.live2dRoomDir(roomID)
	if err := os.MkdirAll(roomDir, 0o755); err != nil {
		httpx.InternalError(w, "live2d-models/mkdir", err)
		return
	}
	// 先解到 .upload-* 临时目录，全部校验通过才改名。中途失败不会留下
	// 半个模型让列表出现"能选但加载不了"的条目。
	tmpDir, err := os.MkdirTemp(roomDir, ".upload-*")
	if err != nil {
		httpx.InternalError(w, "live2d-models/tmpdir", err)
		return
	}
	cleanup := func() { _ = os.RemoveAll(tmpDir) }

	written, problem := extractLive2DZip(zr.File, plan, tmpDir)
	if problem != "" {
		cleanup()
		httpx.BadRequest(w, problem)
		return
	}
	if problem := validateLive2DReferences(filepath.Join(tmpDir, live2dEntryFile), tmpDir); problem != "" {
		cleanup()
		httpx.BadRequest(w, problem)
		return
	}

	label := modelLabelFromFilename(header.Filename)
	meta := live2dModelMeta{
		ID:        newLive2DModelID(label),
		Label:     label,
		Entry:     live2dEntryFile,
		Bytes:     written,
		CreatedAt: time.Now().UTC().Format(time.RFC3339),
	}
	raw, _ := json.Marshal(meta)
	if err := os.WriteFile(filepath.Join(tmpDir, live2dMetaFile), raw, 0o644); err != nil {
		cleanup()
		httpx.InternalError(w, "live2d-models/meta", err)
		return
	}

	finalDir := filepath.Join(roomDir, meta.ID)
	if err := os.Rename(tmpDir, finalDir); err != nil {
		cleanup()
		httpx.InternalError(w, "live2d-models/commit", err)
		return
	}

	httpx.OK(w, map[string]any{
		"success": true,
		"message": "模型已上传",
		"model":   meta,
	})
}

// live2dPlan 是「压缩包里哪些条目要落地、落到哪个相对路径」的结论。
type live2dPlan struct {
	// entryRel 是入口 model3.json 在目标目录里的相对路径（未重命名前）。
	entryRel string
	items    []live2dPlanItem
	total    int64
}

type live2dPlanItem struct {
	file *zip.File
	rel  string
}

// planLive2DExtract 先做全套静态校验，再决定落地路径。任何一项不过就整包拒绝。
func planLive2DExtract(files []*zip.File) (live2dPlan, string) {
	var plan live2dPlan

	// 1. 归一化名字并找出入口。
	type named struct {
		file *zip.File
		name string
	}
	kept := make([]named, 0, len(files))
	entryName := ""
	entryDepth := 0
	entryCount := 0

	for _, f := range files {
		if f.FileInfo().IsDir() {
			continue
		}
		name := strings.ReplaceAll(f.Name, "\\", "/")
		if strings.ContainsRune(name, 0) {
			return plan, "压缩包里有非法路径"
		}
		clean := path.Clean(name)
		if clean == "." || clean == ".." || strings.HasPrefix(clean, "../") || path.IsAbs(clean) {
			return plan, "压缩包里有非法路径：" + f.Name
		}
		// 打包工具留下的系统垃圾，直接忽略：macOS 的 __MACOSX/.DS_Store、
		// Windows 的 Thumbs.db。它们的后缀不在白名单里，不跳过会导致整包被拒。
		if isJunkEntry(clean) {
			continue
		}
		if len(kept) >= live2dMaxEntries {
			return plan, fmt.Sprintf("压缩包内文件过多（上限 %d 个）", live2dMaxEntries)
		}
		if isLive2DEntryName(clean) {
			depth := strings.Count(clean, "/")
			if entryName == "" || depth < entryDepth {
				entryName, entryDepth = clean, depth
				entryCount = 1
			} else if depth == entryDepth {
				entryCount++
			}
		}
		kept = append(kept, named{file: f, name: clean})
	}

	if entryName == "" {
		return plan, "压缩包里没有 model3.json，请把模型目录打成 zip 再上传"
	}
	if entryCount > 1 {
		return plan, "压缩包里有多个 model3.json，请只保留一个模型"
	}

	// 2. 以入口所在目录为根：嵌套一层目录的压缩包（很常见）会被摊平，
	//    这样入口才可能落在根上，前端地址规则才能固定。
	base := path.Dir(entryName)
	if base == "." {
		base = ""
	}

	// 3. 逐条决定落地路径。
	for _, item := range kept {
		var rel string
		switch {
		case base == "":
			rel = item.name
		case strings.HasPrefix(item.name, base+"/"):
			rel = strings.TrimPrefix(item.name, base+"/")
		default:
			// 入口目录之外还带别的文件：只放过纯文档（README/许可证），
			// 其余一律拒绝，避免把「模型引用了上一级目录」的包放进来。
			if !strings.Contains(item.name, "/") && isDocFile(item.name) {
				continue
			}
			return plan, fmt.Sprintf("压缩包里 %q 不在模型入口所在目录，请只打包模型目录", item.name)
		}
		if rel == "" {
			continue
		}
		if !live2dAllowedExts[strings.ToLower(path.Ext(rel))] {
			return plan, fmt.Sprintf("压缩包里含不支持的文件类型：%s", path.Base(rel))
		}
		if item.name == entryName {
			plan.entryRel = rel
		}
		plan.total += int64(item.file.UncompressedSize64)
		if plan.total > live2dExtractMaxBytes {
			return plan, fmt.Sprintf("解压后超过 %dMB，请精简贴图后再上传", live2dExtractMaxBytes>>20)
		}
		plan.items = append(plan.items, live2dPlanItem{file: item.file, rel: rel})
	}
	if plan.entryRel == "" {
		return plan, "压缩包里没有可用的 model3.json"
	}
	return plan, ""
}

// extractLive2DZip 按 plan 落地文件，返回实际写入字节数。
//
// 逐文件用 LimitReader 兜住 2 倍剩余预算：zip 头部声明的 UncompressedSize
// 是可以造假的，只在读取时限制才真正防住 zip bomb。
func extractLive2DZip(files []*zip.File, plan live2dPlan, dir string) (int64, string) {
	var written int64
	budget := int64(live2dExtractMaxBytes)
	for _, item := range plan.items {
		dstPath := filepath.Join(dir, filepath.FromSlash(item.rel))
		// 双保险：Join 后必须仍在 dir 之内（rel 已在规划阶段清过，这里是兜底）。
		if !strings.HasPrefix(dstPath, dir+string(os.PathSeparator)) {
			return written, "压缩包里有非法路径"
		}
		if err := os.MkdirAll(filepath.Dir(dstPath), 0o755); err != nil {
			return written, "解压失败：无法创建目录"
		}
		rc, err := item.file.Open()
		if err != nil {
			return written, fmt.Sprintf("解压失败：%s 无法读取", path.Base(item.rel))
		}
		out, err := os.OpenFile(dstPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
		if err != nil {
			rc.Close()
			return written, "解压失败：无法写入文件"
		}
		n, copyErr := io.Copy(out, io.LimitReader(rc, budget+1))
		rc.Close()
		closeErr := out.Close()
		if copyErr != nil || closeErr != nil {
			return written, fmt.Sprintf("解压失败：%s 写入不完整", path.Base(item.rel))
		}
		written += n
		budget -= n
		if budget < 0 {
			return written, fmt.Sprintf("解压后超过 %dMB，请精简贴图后再上传", live2dExtractMaxBytes>>20)
		}
	}
	// 入口统一改名，前端的地址规则才能写死。
	if plan.entryRel != live2dEntryFile {
		src := filepath.Join(dir, filepath.FromSlash(plan.entryRel))
		if err := os.Rename(src, filepath.Join(dir, live2dEntryFile)); err != nil {
			return written, "解压失败：模型入口重命名失败"
		}
	}
	return written, ""
}

// validateLive2DReferences 检查 model3.json 里引用的文件都真的存在。
//
// 只做「路径存在性 + 不越界」检查，不校验语义：Live2D 的模型格式版本、
// 参数名之类交给引擎，服务端越俎代庖只会拒绝掉本来能用的模型。
func validateLive2DReferences(entryPath, root string) string {
	raw, err := os.ReadFile(entryPath)
	if err != nil {
		return "模型入口读取失败"
	}
	var doc any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return "model3.json 不是合法的 JSON"
	}
	missing := ""
	outside := ""
	walkJSONStrings(doc, func(value string) {
		if missing != "" || outside != "" {
			return
		}
		if !looksLikeLive2DAsset(value) {
			return
		}
		clean := path.Clean(strings.TrimPrefix(strings.ReplaceAll(value, "\\", "/"), "./"))
		if clean == ".." || strings.HasPrefix(clean, "../") || path.IsAbs(clean) {
			outside = value
			return
		}
		full := filepath.Join(root, filepath.FromSlash(clean))
		if !strings.HasPrefix(full, root+string(os.PathSeparator)) {
			outside = value
			return
		}
		if info, err := os.Stat(full); err != nil || info.IsDir() {
			missing = value
		}
	})
	if outside != "" {
		return fmt.Sprintf("model3.json 引用了模型目录之外的文件：%s", outside)
	}
	if missing != "" {
		return fmt.Sprintf("model3.json 引用的文件不存在：%s", missing)
	}
	return ""
}

func walkJSONStrings(node any, visit func(string)) {
	switch value := node.(type) {
	case string:
		visit(value)
	case []any:
		for _, item := range value {
			walkJSONStrings(item, visit)
		}
	case map[string]any:
		for _, item := range value {
			walkJSONStrings(item, visit)
		}
	}
}

func looksLikeLive2DAsset(value string) bool {
	if value == "" || len(value) > 256 || strings.Contains(value, "://") {
		return false
	}
	return live2dAllowedExts[strings.ToLower(path.Ext(value))]
}

// isJunkEntry 判断压缩包里的系统垃圾条目。
func isJunkEntry(name string) bool {
	if strings.HasPrefix(name, "__MACOSX/") {
		return true
	}
	base := path.Base(name)
	if strings.HasPrefix(base, "._") {
		return true
	}
	switch strings.ToLower(base) {
	case ".ds_store", "thumbs.db", "desktop.ini":
		return true
	}
	return false
}

func isLive2DEntryName(name string) bool {
	return strings.HasSuffix(strings.ToLower(name), ".model3.json")
}

func isDocFile(name string) bool {
	switch strings.ToLower(path.Ext(name)) {
	case ".txt", ".md":
		return true
	}
	return false
}

// modelLabelFromFilename 取压缩包名当显示名，去掉 .zip 与首尾空白。
func modelLabelFromFilename(filename string) string {
	base := filepath.Base(strings.ReplaceAll(filename, "\\", "/"))
	base = strings.TrimSuffix(base, filepath.Ext(base))
	base = strings.TrimSpace(base)
	if base == "" {
		base = "模型"
	}
	if r := []rune(base); len(r) > 40 {
		base = string(r[:40])
	}
	return base
}

// newLive2DModelID 生成「可读前缀 + 随机后缀」的目录名。
//
// 可读前缀便于运维时在磁盘上认出是谁的模型；随机后缀保证同名多次上传
// 不会互相覆盖（模型的 URL 因此天然唯一，可以做长期强缓存）。
func newLive2DModelID(label string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(label) {
		if r < unicode.MaxASCII && (unicode.IsLetter(r) || unicode.IsDigit(r)) {
			b.WriteRune(r)
		} else if r == '-' || r == '_' || r == ' ' {
			b.WriteByte('-')
		}
		if b.Len() >= 20 {
			break
		}
	}
	slug := strings.Trim(b.String(), "-")
	if slug == "" {
		slug = "model"
	}
	buf := make([]byte, 3)
	_, _ = rand.Read(buf)
	return slug + "-" + hex.EncodeToString(buf)
}

// ==================== 删除 ====================

func (s *Server) handleDeleteLive2DModel(w http.ResponseWriter, r *http.Request) {
	roomID := r.PathValue("roomId")
	modelID := r.PathValue("modelId")
	if !live2dRoomPathPattern.MatchString(roomID) {
		httpx.BadRequest(w, "房间号不正确")
		return
	}
	if !live2dModelIDPattern.MatchString(modelID) {
		httpx.BadRequest(w, "模型标识不正确")
		return
	}
	room, err := s.Rooms.FindByRoomID(r.Context(), roomID)
	if err != nil {
		if errors.Is(err, store.ErrRoomNotFound) {
			httpx.NotFound(w, "房间不存在")
			return
		}
		httpx.InternalError(w, "live2d-models/delete", err)
		return
	}
	if !canControlRoom(auth.ClaimsFrom(r.Context()), room) {
		httpx.Forbidden(w, "无权限：只有房主可以删除模型")
		return
	}
	target := filepath.Join(s.live2dRoomDir(roomID), modelID)
	if err := os.RemoveAll(target); err != nil {
		httpx.InternalError(w, "live2d-models/delete", err)
		return
	}
	httpx.OK(w, map[string]any{"success": true, "message": "模型已删除"})
}

// removeLive2DRoomModels 在房间被真正删除时清掉该房间的模型目录。
//
// 注意**不能**挂在 room.Service.Delete（那是"运行时状态"过期清理）上：
// 房间还在库里、只是暂时没人，模型要保留给下一次进房的人用。
func (s *Server) removeLive2DRoomModels(roomID string) {
	if !live2dRoomPathPattern.MatchString(roomID) {
		return
	}
	_ = os.RemoveAll(s.live2dRoomDir(roomID))
}

// ==================== 静态下发 ====================

// live2dModelsHandler 提供 /uploads/live2d/<roomId>/<modelId>/… 的只读访问。
//
// 与头像一样走公开 URL：模型是各个客户端（含游客）都要加载的资源，
// 加鉴权就等于全部加载失败。目录名带 6 字节随机后缀，不可枚举。
// 下发时强制 nosniff + CSP sandbox：上传目录里的文件即使被当成 HTML
// 打开，也不能执行脚本。
func (s *Server) live2dModelsHandler() http.Handler {
	files := http.FileServer(http.Dir(s.live2dRoot()))
	return http.StripPrefix("/uploads/live2d/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 目录列表没有用途（模型加载总是取具体文件），且会暴露整包内容。
		if strings.HasSuffix(r.URL.Path, "/") {
			http.NotFound(w, r)
			return
		}
		rel := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
		if rel == "" || rel == "." {
			http.NotFound(w, r)
			return
		}
		for _, seg := range strings.Split(rel, "/") {
			if seg == "" || seg == "." || seg == ".." || strings.HasPrefix(seg, ".") {
				http.NotFound(w, r)
				return
			}
		}
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
		// 模型目录名不可枚举且内容不会变，可以长期缓存。
		w.Header().Set("Cache-Control", "public, max-age=604800, immutable")
		files.ServeHTTP(w, r)
	}))
}
