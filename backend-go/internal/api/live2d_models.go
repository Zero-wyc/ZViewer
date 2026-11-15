package api

import (
	"archive/zip"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/encoding/simplifiedchinese"

	"zviewer/backend/internal/auth"
	"zviewer/backend/internal/httpx"
)

// 服务端公共 Live2D 模型库：任何登录用户上传，**所有房间共用同一份**。
//
// 落盘形状（UPLOADS_DIR/live2d/<modelId>/）：
//
//	model.model3.json   入口固定名字，前端与协议只认这一个
//	.meta.json          显示名 / 上传时间 / 解压后字节数 / 上传者
//	…                   纹理、动作、物理、音频，层级按压缩包原样保留
//
// 为什么不再按房间分目录：模型是**素材**，不是房间的运行时状态。房主 A 传的
// 一套皮，房主 B 的房间也想用；按房间隔离的后果是同一套 60MB 的皮在每台
// 机器上被反复上传，而房主换房（旧房被清理）时模型还会一起消失。目录名带
// 6 字节随机后缀，全局唯一，URL 也因此天然不冲突。
//
// 为什么入口要固定名字：live2d-config 只同步 modelId，各客户端要靠
// 同一套规则自己拼出地址（见前端 core/model-url.ts）。让服务端在解压时
// 把入口重命名成固定名，前端就不必先拉一次清单才知道入口叫什么。
//
// 安全边界全在服务端：压缩包是用户输入，必须防目录穿越、防 zip bomb、
// 防可执行文件落地；静态下发时再加 nosniff + CSP sandbox，杜绝把上传的
// 文件当脚本执行。

const (
	// 压缩包上限。
	//
	// 曾经写死 48MB，理由是「4K 贴图的整套也放得下」——被现实否掉了：一个
	// 4096 导出的皮（5 张贴图，其中一张 8192²）压完 47MB，几乎是踩着线过；
	// 多一张贴图就上传失败，而用户看到的是「模型包不能超过 48MB」。
	// 96MB 覆盖到 2 万像素级贴图的成品皮，同时仍然是有限的。
	live2dUploadMaxBytes = 96 << 20
	// 解压后总字节上限（zip bomb 的主要防线，配合条目数与逐文件限读）。
	live2dExtractMaxBytes = 192 << 20
	// 条目数上限：官方模型通常 < 200，3000 已经是宽松值。
	live2dMaxEntries = 3000
	// 单个上传者的配额。库是全局的，配额只能跟着「人」走：原来按房间算
	// 8 个，改成服务端公共后若仍按房间计，一个人开 10 个房间就能塞 80 个。
	live2dMaxModelsPerOwner = 8
	// 整库上限，防止磁盘被无限撑大。
	live2dMaxModelsTotal = 64

	live2dEntryFile = "model.model3.json"
	// 元数据文件故意用点开头：静态下发会拒绝任何以 "." 开头的路径段，
	// 所以上传者的 userId 不会随 /uploads/live2d/… 一起公开。
	live2dMetaFile = ".meta.json"
	// 老布局（房间私有）用的元数据名，只在迁移时被改写成上面那个。
	live2dLegacyMetaFile = "_meta.json"
	live2dUploadKey      = "file"
)

// 允许落地的后缀。白名单决定「哪些文件会被写到磁盘」。
//
// 白名单之外分两种处理（见 planLive2DExtract）：
//   - 明确危险的类型 → 整包拒绝（live2dRejectExts）
//   - 其余未知类型   → 跳过不落地
//
// 为什么未知类型不再整包拒绝：VTube Studio 的导出目录里固定带
// AdvancedARKitSettings.vbridger、.vtube.json、items_pinned_to_model.json，
// 这些宿主配置对 Cubism 载入毫无用处。按老规则整包被拒，用户看到的是
// 「不支持的文件类型：AdvancedARKitSettings.vbridger」——他既不知道该删哪个，
// 删掉之后下次导出又会回来。而模型真正依赖的文件仍会被逐个核对
// （validateLive2DReferences），不会因为放宽而放进一个残缺的模型。
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

// 明确危险的后缀：即使白名单机制保证它们不会落盘，也整包拒绝。
// 一个模型包里夹着 .exe/.js，本身就说明来源不可信——留着比直接说明更糟。
var live2dRejectExts = map[string]bool{
	".exe": true, ".dll": true, ".so": true, ".dylib": true, ".scr": true,
	".bat": true, ".cmd": true, ".ps1": true, ".vbs": true, ".hta": true,
	".js": true, ".mjs": true, ".jar": true, ".msi": true, ".sh": true,
	".cpl": true, ".lnk": true,
}

var (
	live2dModelIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
)

// live2dModelMeta 是 .meta.json 的内容（只落盘，不外发）。
type live2dModelMeta struct {
	ID        string `json:"id"`
	Label     string `json:"label"`
	Entry     string `json:"entry"`
	Bytes     int64  `json:"bytes"`
	CreatedAt string `json:"createdAt"`
	// Owner 是上传者的 userId，只用于「本人可删」的鉴权，不下发给前端。
	Owner int64 `json:"owner,omitempty"`
}

// live2dModelDTO 是列表接口的一项。
//
// Deletable 由服务端算好：前端不该知道角色/归属规则，只该知道这一条能不能点。
type live2dModelDTO struct {
	ID        string `json:"id"`
	Label     string `json:"label"`
	Bytes     int64  `json:"bytes"`
	CreatedAt string `json:"createdAt"`
	Deletable bool   `json:"deletable"`
	// HasThumb 表示服务端有没有这个模型的缩略图。前端据此决定是画图还是
	// 退回首字方块——不做成「总是请求图片再靠 onError 兜底」，那会在每次
	// 打开面板时给没有缩略图的模型各打一条 404。
	HasThumb bool `json:"hasThumb"`
}

// live2dModelDTO 由 meta 与鉴权信息算出一条对外描述。
//
// 上传/导入的响应也走这里：让三处（列表、上传、导入）返回同一个形状，
// 前端才不需要为「刚上传的那条」单独处理（少一个 hasThumb 就少一张缩略图）。
func (s *Server) live2dModelDTO(meta live2dModelMeta, claims *auth.Claims) live2dModelDTO {
	return live2dModelDTO{
		ID:        meta.ID,
		Label:     meta.Label,
		Bytes:     meta.Bytes,
		CreatedAt: meta.CreatedAt,
		Deletable: live2dCanDelete(claims, meta.Owner),
		HasThumb:  s.live2dHasThumb(meta.ID),
	}
}

func (s *Server) registerLive2DModelRoutes(mux *http.ServeMux) {
	// 列表对所有登录用户开放（含游客）：观众要加载别人选的模型。
	mux.HandleFunc("GET /api/live2d/models", s.Auth.Require(s.handleListLive2DModels))
	// 上传/删除：任何非游客用户都能上传（库是全服务端共用的素材），
	// 但只能删自己传的；root / admin 可以删任何一条。
	mux.HandleFunc("POST /api/live2d/models", s.Auth.Require(s.handleUploadLive2DModel))
	// 从链接导入：与上传同一份落库规则，只是字节的来源不同（见 live2d_import.go）。
	s.registerLive2DImportRoute(mux)
	mux.HandleFunc("DELETE /api/live2d/models/{modelId}", s.Auth.Require(s.handleDeleteLive2DModel))
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

func (s *Server) live2dModelDir(modelID string) string {
	return filepath.Join(s.live2dRoot(), modelID)
}

// live2dCanUpload 谁能往库里加模型：任何确实登录过的用户（游客没有 userId）。
func live2dCanUpload(claims *auth.Claims) bool {
	return claims != nil && claims.UserID > 0 && claims.Role != auth.RoleGuest
}

// live2dCanDelete 谁能删某一条：本人，或服务端管理员。
//
// 允许本人删是必要的——传错了、传坏了要能自己收拾，否则只能找管理员；
// 而「删别人的」是破坏性操作，普通用户不该有。
func live2dCanDelete(claims *auth.Claims, owner int64) bool {
	if claims == nil {
		return false
	}
	if claims.Role == auth.RoleRoot || claims.Role == auth.RoleAdmin {
		return true
	}
	return owner > 0 && claims.UserID == owner
}

// ==================== 列表 ====================

func (s *Server) handleListLive2DModels(w http.ResponseWriter, r *http.Request) {
	claims := auth.ClaimsFrom(r.Context())
	models := s.readLive2DModels()
	out := make([]live2dModelDTO, 0, len(models))
	for _, meta := range models {
		out = append(out, s.live2dModelDTO(meta, claims))
	}
	httpx.OK(w, map[string]any{
		"success": true,
		"models":  out,
		// 能不能往库里加模型，前端据此决定是否显示上传入口。
		"canManage": live2dCanUpload(claims),
	})
}

// readLive2DModels 扫描库根目录。坏掉/手改的目录一律跳过而不是报错：
// 一个坏模型不该让整个面板打不开。
func (s *Server) readLive2DModels() []live2dModelMeta {
	out := make([]live2dModelMeta, 0, 4)
	entries, err := os.ReadDir(s.live2dRoot())
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
		if stored, ok := s.readLive2DMeta(id); ok {
			if strings.TrimSpace(stored.Label) != "" {
				meta.Label = stored.Label
			}
			meta.Bytes = stored.Bytes
			meta.CreatedAt = stored.CreatedAt
			meta.Owner = stored.Owner
		}
		// 入口缺失说明目录不完整（删到一半 / 手工拷贝），列表里剔除。
		if _, err := os.Stat(filepath.Join(s.live2dModelDir(id), live2dEntryFile)); err != nil {
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

// readLive2DMeta 读一条模型的元数据。两个文件名都认：`.meta.json` 是现役，
// `_meta.json` 是房间私有时期的遗留（迁移不改名也能读出显示名）。
func (s *Server) readLive2DMeta(modelID string) (live2dModelMeta, bool) {
	for _, name := range []string{live2dMetaFile, live2dLegacyMetaFile} {
		raw, err := os.ReadFile(filepath.Join(s.live2dModelDir(modelID), name))
		if err != nil {
			continue
		}
		var meta live2dModelMeta
		if json.Unmarshal(raw, &meta) == nil {
			return meta, true
		}
	}
	return live2dModelMeta{}, false
}

// ==================== 上传 ====================

func (s *Server) handleUploadLive2DModel(w http.ResponseWriter, r *http.Request) {
	claims := auth.ClaimsFrom(r.Context())
	if !live2dCanUpload(claims) {
		httpx.Forbidden(w, "无权限：请登录后再上传模型")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, live2dUploadMaxBytes+1<<20)
	// 8MB 放内存，其余落临时文件：96MB 全塞内存对多人同时上传不友好。
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

	meta, message, problem, err := s.installLive2DZip(claims, zr.File, header.Filename)
	if err != nil {
		httpx.InternalError(w, "live2d-models/install", err)
		return
	}
	if problem != "" {
		httpx.BadRequest(w, problem)
		return
	}

	httpx.OK(w, map[string]any{
		"success": true,
		"message": message,
		"model":   s.live2dModelDTO(meta, claims),
	})
}

// installLive2DZip 是「上传」与「URL 导入」共用的落库流程：
// 配额 → 解包计划 → 解压 → 引用校验 → 补登记 → 写元数据 → 原子改名。
//
// 两个入口只差「压缩包从哪来」，落库规则必须完全一致，否则同一个包换个
// 导入方式就可能绕过配额或跳过引用校验。problem 表示用户输入有问题（400），
// err 表示服务端自身故障（500）。
func (s *Server) installLive2DZip(claims *auth.Claims, files []*zip.File, filename string) (live2dModelMeta, string, string, error) {
	models := s.readLive2DModels()
	if len(models) >= live2dMaxModelsTotal {
		return live2dModelMeta{}, "", fmt.Sprintf("模型库最多 %d 个模型，请先删掉不用的", live2dMaxModelsTotal), nil
	}
	mine := 0
	for _, meta := range models {
		if meta.Owner == claims.UserID {
			mine++
		}
	}
	if mine >= live2dMaxModelsPerOwner {
		return live2dModelMeta{}, "", fmt.Sprintf("每人最多 %d 个模型，请先删掉不用的", live2dMaxModelsPerOwner), nil
	}

	plan, problem := planLive2DExtract(files)
	if problem != "" {
		return live2dModelMeta{}, "", problem, nil
	}

	root := s.live2dRoot()
	if err := os.MkdirAll(root, 0o755); err != nil {
		return live2dModelMeta{}, "", "", err
	}
	// 先解到 .upload-* 临时目录，全部校验通过才改名。中途失败不会留下
	// 半个模型让列表出现"能选但加载不了"的条目。
	// 临时目录以 "." 开头：列表扫描与静态下发都会跳过它。
	tmpDir, err := os.MkdirTemp(root, ".upload-*")
	if err != nil {
		return live2dModelMeta{}, "", "", err
	}
	cleanup := func() { _ = os.RemoveAll(tmpDir) }

	written, problem := extractLive2DZip(files, plan, tmpDir)
	if problem != "" {
		cleanup()
		return live2dModelMeta{}, "", problem, nil
	}
	if problem := validateLive2DReferences(filepath.Join(tmpDir, live2dEntryFile), tmpDir); problem != "" {
		cleanup()
		return live2dModelMeta{}, "", problem, nil
	}

	// 补登记表情/待机动作：必须在引用校验之后（先确认原包自洽，再谈补充）。
	rels := make([]string, 0, len(plan.items))
	for _, item := range plan.items {
		rels = append(rels, item.rel)
	}
	enriched, problem := enrichLive2DEntry(filepath.Join(tmpDir, live2dEntryFile), rels)
	if problem != "" {
		cleanup()
		return live2dModelMeta{}, "", problem, nil
	}

	// 缩略图：取第一张贴图缩到 160px，写进模型目录。失败不阻断入库——
	// 解不出图的原因很多（加密贴图、非标准格式），而模型本身照样能用。
	_ = writeLive2DThumb(tmpDir)

	label := modelLabelFromFilename(filename)
	meta := live2dModelMeta{
		ID:        newLive2DModelID(label),
		Label:     label,
		Entry:     live2dEntryFile,
		Bytes:     written,
		CreatedAt: time.Now().UTC().Format(time.RFC3339),
		Owner:     claims.UserID,
	}
	raw, _ := json.Marshal(meta)
	if err := os.WriteFile(filepath.Join(tmpDir, live2dMetaFile), raw, 0o644); err != nil {
		cleanup()
		return live2dModelMeta{}, "", "", err
	}

	finalDir := s.live2dModelDir(meta.ID)
	if err := os.Rename(tmpDir, finalDir); err != nil {
		cleanup()
		return live2dModelMeta{}, "", "", err
	}

	return meta, live2dUploadMessage(enriched, plan.skipped), "", nil
}

// live2dUploadMessage 把「补登记了什么、忽略了什么」说清楚。
//
// 这两件事都改变了用户看到的结果（多出表情按钮、不再有待机动作），
// 静默处理会让人怀疑是模型有问题。
func live2dUploadMessage(enriched live2dEnrich, skipped int) string {
	var parts []string
	if enriched.Expressions > 0 {
		parts = append(parts, fmt.Sprintf("自动登记 %d 个表情", enriched.Expressions))
	}
	if enriched.Motions > 0 {
		parts = append(parts, fmt.Sprintf("%d 个待机动作", enriched.Motions))
	}
	if skipped > 0 {
		parts = append(parts, fmt.Sprintf("忽略 %d 个非模型文件", skipped))
	}
	if len(parts) == 0 {
		return "模型已上传"
	}
	return "模型已上传，" + strings.Join(parts, "、")
}

// live2dPlan 是「压缩包里哪些条目要落地、落到哪个相对路径」的结论。
type live2dPlan struct {
	// entryRel 是入口 model3.json 在目标目录里的相对路径（未重命名前）。
	entryRel string
	items    []live2dPlanItem
	total    int64
	// skipped 是不在白名单里、被跳过的条目数（只用于回报，不落盘）。
	skipped int
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
		name := normalizeLive2DZipName(f.Name)
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
		ext := strings.ToLower(path.Ext(rel))
		if live2dRejectExts[ext] {
			return plan, fmt.Sprintf("压缩包里含不支持的文件类型：%s", path.Base(rel))
		}
		if !live2dAllowedExts[ext] {
			plan.skipped++
			continue
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
	raw = decodeLive2DJSON(raw)
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

// ==================== 补登记表情 / 待机动作 ====================

// live2dEnrich 记录补登记了什么，用于回报给用户。
type live2dEnrich struct {
	Expressions int
	Motions     int
}

const (
	live2dExpressionSuffix = ".exp3.json"
	live2dMotionSuffix     = ".motion3.json"
)

// enrichLive2DEntry 在入口 JSON 缺 Expressions / Motions 时，按包里实际存在的
// *.exp3.json 与 idle*.motion3.json 补上登记。
//
// 为什么需要：VTube Studio 的导出习惯是把表情与动画放在 Exp3/、Animation/
// 子目录，model3.json 只写 Moc/Textures/Physics。这种包在任何 Cubism 载入器里
// 都是「模型能显示，但一个表情都没有、也不会待机」——用户看到的就是「显示不对」。
// 而 Cubism 的表情/动作只能由 model3.json 寻址，光有文件等于没有。
//
// 只在字段为空时补：已经有登记的模型一个字节都不改（尊重作者的显式选择，
// 比如他故意不放 Idle 组）。
func enrichLive2DEntry(entryPath string, rels []string) (live2dEnrich, string) {
	var result live2dEnrich
	raw, err := os.ReadFile(entryPath)
	if err != nil {
		return result, "模型入口读取失败"
	}
	raw = decodeLive2DJSON(raw)
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return result, "model3.json 不是合法的 JSON"
	}
	refs, ok := doc["FileReferences"].(map[string]any)
	if !ok {
		return result, ""
	}

	sorted := append([]string(nil), rels...)
	sort.Strings(sorted)

	if existing, _ := refs["Expressions"].([]any); len(existing) == 0 {
		items := make([]any, 0, 8)
		used := make(map[string]int, 8)
		for _, rel := range sorted {
			name, ok := live2dExpressionName(rel)
			if !ok {
				continue
			}
			// 同名表情（不同子目录各放一份）加序号，否则引擎只认第一个
			if n := used[name]; n > 0 {
				used[name] = n + 1
				name = fmt.Sprintf("%s %d", name, n+1)
			} else {
				used[name] = 1
			}
			items = append(items, map[string]any{"Name": name, "File": rel})
		}
		if len(items) > 0 {
			refs["Expressions"] = items
			result.Expressions = len(items)
		}
	}

	if existing, _ := refs["Motions"].(map[string]any); len(existing) == 0 {
		idle := make([]any, 0, 4)
		for _, rel := range sorted {
			if isLive2DIdleMotion(rel) {
				idle = append(idle, map[string]any{"File": rel})
			}
		}
		if len(idle) > 0 {
			refs["Motions"] = map[string]any{"Idle": idle}
			result.Motions = len(idle)
		}
	}

	if result.Expressions == 0 && result.Motions == 0 {
		return result, ""
	}
	out, err := json.MarshalIndent(doc, "", "\t")
	if err != nil {
		return result, "model3.json 重写失败"
	}
	if err := os.WriteFile(entryPath, append(out, '\n'), 0o644); err != nil {
		return result, "model3.json 重写失败"
	}
	return result, ""
}

// live2dExpressionName 从 Exp3/兔牙.exp3.json 取出「兔牙」。
func live2dExpressionName(rel string) (string, bool) {
	base := path.Base(rel)
	lower := strings.ToLower(base)
	if !strings.HasSuffix(lower, live2dExpressionSuffix) {
		return "", false
	}
	name := strings.TrimSpace(base[:len(base)-len(live2dExpressionSuffix)])
	if name == "" {
		return "", false
	}
	return name, true
}

// isLive2DIdleMotion 判断是不是待机动作：文件名以 idle 开头（忽略大小写）。
//
// 只收 idle 前缀而不是把整目录都塞进 Idle 组：手势类的动作（举手、脱捕…）
// 被当成待机随机播放会非常怪。
func isLive2DIdleMotion(rel string) bool {
	base := path.Base(rel)
	lower := strings.ToLower(base)
	if !strings.HasSuffix(lower, live2dMotionSuffix) {
		return false
	}
	stem := strings.TrimSpace(base[:len(base)-len(live2dMotionSuffix)])
	return len(stem) >= 4 && strings.EqualFold(stem[:4], "idle")
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

// normalizeLive2DZipName 把压缩包条目名统一成「斜杠分隔 + UTF-8」。
//
// 为什么必须有这一步：zip 规范要求文件名是 UTF-8（通用标志位 bit 11），但
// Windows 上的中文压缩工具（好压/快压/部分 WinRAR 设置）会把名字按 GBK 写进去
// **且不置标志位**。Go 的 archive/zip 于是原样返回那串 GBK 字节，`NonUTF8=true`。
//
// 后果非常隐蔽：落地时 Windows 会把非法 UTF-8 字节换成 U+FFFD，磁盘上就出现
// 一个 `������.moc3`；而 model3.json 里的引用是正常的 UTF-8「大肥鱼.moc3」，
// 引用校验 stat 不到，用户看到的是「model3.json 引用的文件不存在：大肥鱼.moc3」
// ——模型包里明明有这个文件，却怎么传都传不上去。
//
// 只在字节**不是**合法 UTF-8 时才转码：有些工具名字是 UTF-8 却没置标志位，
// 那种情况原样保留，绝不做二次解码。
func normalizeLive2DZipName(name string) string {
	name = strings.ReplaceAll(name, "\\", "/")
	if utf8.ValidString(name) {
		return name
	}
	// GB18030 是 GBK 的超集：GBK 能表示的它都能表示，还多认几个生僻字。
	if decoded, err := simplifiedchinese.GB18030.NewDecoder().Bytes([]byte(name)); err == nil {
		return strings.ReplaceAll(string(decoded), "\\", "/")
	}
	return name
}

// decodeLive2DJSON 在 JSON 内容不是合法 UTF-8 时按 GB18030 转一次。
//
// JSON 规范只认 UTF-8，但中文作者手改 model3.json 时用记事本存成 ANSI
// （即 GBK）并不少见。这种情况 json.Unmarshal 会在字符串里撞上非法字节，
// 报到用户面前是「model3.json 不是合法的 JSON」——而它其实是合法 JSON，
// 只是编码不对。转码后再解析一次，把「文件坏了」和「编码不合规」分开。
func decodeLive2DJSON(raw []byte) []byte {
	if utf8.Valid(raw) {
		return raw
	}
	if decoded, err := simplifiedchinese.GB18030.NewDecoder().Bytes(raw); err == nil {
		return decoded
	}
	return raw
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
	modelID := r.PathValue("modelId")
	if !live2dModelIDPattern.MatchString(modelID) {
		httpx.BadRequest(w, "模型标识不正确")
		return
	}
	// 归属从元数据读：列表与删除必须用同一份事实，否则会出现
	// 「列表显示能删、点了却 403」。
	meta, _ := s.readLive2DMeta(modelID)
	if !live2dCanDelete(auth.ClaimsFrom(r.Context()), meta.Owner) {
		httpx.Forbidden(w, "无权限：只能删除自己上传的模型")
		return
	}
	if err := os.RemoveAll(s.live2dModelDir(modelID)); err != nil {
		httpx.InternalError(w, "live2d-models/delete", err)
		return
	}
	// 模型库是全局的：删掉之后可能还有其他房间的人正站着它。清理必须由服务端
	// 扫全量房间完成（他们的 socket 不在这次请求里），否则那些人只会看到自己的
	// 角色凭空消失，或者一直挂着一个加载失败的占位卡。
	if s.RoomSvc != nil {
		s.RoomSvc.Live2DModelRemoved(modelID)
	}
	httpx.OK(w, map[string]any{"success": true, "message": "模型已删除"})
}

// migrateLegacyLive2DModels 把「房间级」老目录搬成全局布局。
//
// v0 的形状是 live2d/<roomId>/<modelId>/（模型跟着房间走）。模型库改成服务端
// 公共以后，根下这些 <roomId> 目录认不出入口，列表会整批跳过——等于用户刚传
// 的模型凭空消失。启动时搬平一次即可：只搬「子目录里有入口」的，搬完删掉空壳
// 房间目录，重复执行无副作用。
func (s *Server) migrateLegacyLive2DModels() {
	root := s.live2dRoot()
	entries, err := os.ReadDir(root)
	if err != nil {
		return
	}
	moved := 0
	for _, entry := range entries {
		if !entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		dir := filepath.Join(root, entry.Name())
		// 有入口就是新布局，别再往下钻。
		if _, err := os.Stat(filepath.Join(dir, live2dEntryFile)); err == nil {
			continue
		}
		subs, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, sub := range subs {
			if !sub.IsDir() || !live2dModelIDPattern.MatchString(sub.Name()) {
				continue
			}
			src := filepath.Join(dir, sub.Name())
			if _, err := os.Stat(filepath.Join(src, live2dEntryFile)); err != nil {
				continue
			}
			dst := s.live2dModelDir(sub.Name())
			// 目标已存在（同名 id 极小概率）就留着不动，人工处理。
			if _, err := os.Stat(dst); err == nil {
				continue
			}
			if err := os.Rename(src, dst); err == nil {
				moved++
				// 顺手把老元数据名改成现役的：不改也能读（readLive2DMeta 两个
				// 名字都认），但改名之后静态下发同样打不开它。
				if _, err := os.Stat(filepath.Join(dst, live2dMetaFile)); err != nil {
					_ = os.Rename(filepath.Join(dst, live2dLegacyMetaFile), filepath.Join(dst, live2dMetaFile))
				}
			}
		}
		// 只在真的空了才删：还有非模型残留就留着，别吞用户文件。
		if rest, err := os.ReadDir(dir); err == nil && len(rest) == 0 {
			_ = os.Remove(dir)
		}
	}
	if moved > 0 {
		log.Printf("[live2d] 已将 %d 个房间级模型搬到全局模型库", moved)
	}
}

// live2DModelExists 供房间层校验 room 类型模型是否存在（socket 侧选择时调用）。
//
// 只查入口文件在不在：解压是「全部校验通过才改名落地」，所以入口存在
// 就等于这个模型是完整的。
func (s *Server) live2DModelExists(modelID string) bool {
	if !live2dModelIDPattern.MatchString(modelID) {
		return false
	}
	info, err := os.Stat(filepath.Join(s.live2dModelDir(modelID), live2dEntryFile))
	return err == nil && info.Mode().IsRegular()
}

// ==================== 静态下发 ====================

// live2dModelsHandler 提供 /uploads/live2d/<modelId>/… 的只读访问。
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
