// Package serverfiles 提供服务器文件管理的路径解析与落盘能力。
//
// 路径约定（前缀式，与 services/server-files/pathResolver.ts 逐字对齐）：
//   - `uploads:/movies/a.mp4`   uploads 默认根目录
//   - `custom:3:/videos/b.mp4`  id=3 的自定义目录
//   - `/movies/a.mp4`           旧格式（无前缀），默认归属 uploads 根
//   - `/` 或空字符串             表示 uploads 根目录
//
// 安全边界：解析后的绝对路径必须落在所选根目录之内（含根本身），
// 否则返回 ErrPathEscape。所有破坏性操作（上传/新建/改名/删除）都先过这一步。
package serverfiles

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/text/collate"
	"golang.org/x/text/language"

	"zviewer/backend/internal/store"
)

// UploadsRootKey 是 uploads 根的固定 key。
const UploadsRootKey = "uploads"

// 解析失败原因。
var (
	// ErrUnknownRoot 表示路径前缀指向了未注册的根。
	ErrUnknownRoot = errors.New("未知的根目录")
	// ErrPathEscape 表示解析结果逃出了根目录。
	ErrPathEscape = errors.New("路径越权")
)

// RootInfo 描述一个根目录。
type RootInfo struct {
	// Key 唯一标识：`uploads` 或 `custom:<id>`。
	Key string
	// Name 展示名。
	Name string
	// AbsPath 真实绝对路径。
	AbsPath string
	// Readonly 只读根（禁止写入类操作）。
	Readonly bool
}

// prefixedPattern 匹配 `uploads:` 或 `custom:<数字>:` 前缀。
var prefixedPattern = regexp.MustCompile(`^(uploads|custom:\d+):(.*)$`)

// 注册表缓存时长。
//
// 流式代理（GET /proxy）在 seek/预取时高频到达，每次都查 server_folder 全表
// 是纯浪费；目录配置极少变化，30 秒 TTL + 增删时主动失效即可兼顾性能与
// 「改完立刻生效」。与 pathResolver.ts#REGISTRY_TTL_MS 同值。
const registryTTL = 30 * time.Second

// Registry 是根目录注册表（uploads 根 + 数据库里的自定义根）。
type Registry struct {
	folders    *store.ServerFolders
	uploadsDir string

	mu    sync.Mutex
	cache []RootInfo
	at    time.Time
	valid bool
}

// NewRegistry 构造注册表。folders 为 nil 时只有 uploads 根（测试用）。
func NewRegistry(folders *store.ServerFolders, uploadsDir string) *Registry {
	return &Registry{folders: folders, uploadsDir: uploadsDir}
}

// UploadsRoot 返回 uploads 根的描述。
func (r *Registry) UploadsRoot() RootInfo {
	return RootInfo{Key: UploadsRootKey, Name: "默认空间", AbsPath: r.uploadsDir, Readonly: false}
}

// Invalidate 让缓存立刻失效（新增 / 删除自定义根之后调用）。
func (r *Registry) Invalidate() {
	r.mu.Lock()
	r.valid = false
	r.cache = nil
	r.mu.Unlock()
}

// Load 返回有序的根目录列表：uploads 在前，其后按 id 升序。
//
// 返回切片而不是 map，是因为 /roots 的展示顺序就是注册顺序
// （Node 侧用 Map 的插入序，插入顺序 = uploads 先、随后 folders 按 id）。
func (r *Registry) Load(ctx context.Context) ([]RootInfo, error) {
	r.mu.Lock()
	if r.valid && time.Since(r.at) < registryTTL {
		cached := r.cache
		r.mu.Unlock()
		return cached, nil
	}
	r.mu.Unlock()

	list := make([]RootInfo, 0, 4)
	list = append(list, r.UploadsRoot())
	if r.folders != nil {
		folders, err := r.folders.List(ctx)
		if err != nil {
			return nil, err
		}
		for _, f := range folders {
			list = append(list, RootInfo{
				Key:      "custom:" + strconv.FormatInt(f.ID, 10),
				Name:     f.Name,
				AbsPath:  filepath.Clean(f.AbsPath),
				Readonly: f.Readonly,
			})
		}
	}

	r.mu.Lock()
	r.cache = list
	r.at = time.Now()
	r.valid = true
	r.mu.Unlock()
	return list, nil
}

// ParsePrefixedPath 把用户输入拆成根 key 与相对路径。
// 无前缀时默认 uploads 根，相对路径保留原样（交给 ResolveSafePath 规范化）。
func ParsePrefixedPath(input string) (rootKey, relPath string) {
	raw := strings.TrimSpace(input)
	if m := prefixedPattern.FindStringSubmatch(raw); m != nil {
		rel := m[2]
		if rel == "" {
			rel = "/"
		}
		return m[1], rel
	}
	return UploadsRootKey, raw
}

// ResolveSafePath 把用户路径解析成根目录内的绝对路径。
//
// 越权判断用 filepath.Rel 而不是字符串前缀：Windows 盘符根（如 `D:\`）
// 自带分隔符，字符串拼接会拼出 `D:\\` 而误判。
func ResolveSafePath(input string, roots []RootInfo) (abs string, root RootInfo, err error) {
	rootKey, relPath := ParsePrefixedPath(input)
	root, ok := findRoot(roots, rootKey)
	if !ok {
		return "", RootInfo{}, ErrUnknownRoot
	}
	normalized := strings.TrimLeft(relPath, "/")
	// 反斜杠也当分隔符处理：Windows 客户端可能传 `uploads:\\a\\b`。
	normalized = strings.ReplaceAll(normalized, "\\", "/")
	absolute := filepath.Join(root.AbsPath, filepath.FromSlash(normalized))
	rel, relErr := filepath.Rel(root.AbsPath, absolute)
	if relErr != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return "", RootInfo{}, ErrPathEscape
	}
	return absolute, root, nil
}

// ToPrefixedPath 把绝对路径转成相对某个根的前缀式路径（分隔符统一为 /）。
func ToPrefixedPath(root RootInfo, absolute string) string {
	if absolute == root.AbsPath {
		return root.Key + ":/"
	}
	rel, err := filepath.Rel(root.AbsPath, absolute)
	if err != nil || rel == "." {
		// rel == "." 说明两者指向同一目录，但字符串可能不等（Clean 会把
		// 正斜杠换成正平台分隔符），此时仍应给根路径形式。
		return root.Key + ":/"
	}
	return root.Key + ":/" + filepath.ToSlash(rel)
}

// BaseName 返回路径的文件名部分。
func BaseName(p string) string { return filepath.Base(p) }

// EnsureUploadsRoot 确保 uploads 根目录存在（启动时调用一次）。
func (r *Registry) EnsureUploadsRoot() error {
	return os.MkdirAll(r.uploadsDir, 0o755)
}

func findRoot(roots []RootInfo, key string) (RootInfo, bool) {
	for _, root := range roots {
		if root.Key == key {
			return root, true
		}
	}
	return RootInfo{}, false
}

// collator 复刻 JS `localeCompare(name, 'zh-Hans-CN')`：目录列表按拼音排序。
//
// x/text 的 Collator 不是并发安全的，这里用互斥锁包住；目录项通常几十到
// 几百个，锁竞争可以忽略。
var (
	collatorMu sync.Mutex
	collator   = collate.New(language.SimplifiedChinese)
)

// CompareNames 按简体中文排序规则比较两个文件名。
func CompareNames(a, b string) int {
	collatorMu.Lock()
	defer collatorMu.Unlock()
	return collator.CompareString(a, b)
}
