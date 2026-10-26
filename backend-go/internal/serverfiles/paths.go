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
	"unicode"

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
	// Validate existing ancestors as well as a not-yet-created target. Actual I/O
	// below still uses os.Root to close the check/use race.
	if scope, e := os.OpenRoot(root.AbsPath); e == nil {
		defer scope.Close()
		check := rel
		for {
			_, e = scope.Stat(check)
			if e == nil {
				break
			}
			if !os.IsNotExist(e) {
				return "", RootInfo{}, ErrPathEscape
			}
			if check == "." {
				break
			}
			check = filepath.Dir(check)
		}
	} else if !os.IsNotExist(e) {
		return "", RootInfo{}, e
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
//
// 除了 Collator 本身，还要补一条 CLDR 中文（`zh-Hans-CN`）的**汉字重排**规则：
// ICU 的 zh 排序把汉字整体排在拉丁字母**之前**，而 x/text 用的是 CLDR 根规则
// （拉丁在前）。实测 Node 侧
//
//	'_x' < '#tag' < '1.txt' < '123' < '阿凡达' < '波西米亚' < 'a.mkv' < 'Z.mkv'
//
// 而 `collate.New(language.SimplifiedChinese)` 给出的是拉丁在前、汉字在后。
// 不补这条，中英混合的目录在 Go 侧会排成「EP01.ass … 阿凡达.srt」，与 Node
// 的「阿凡达.srt … EP01.ass」完全颠倒——用户看到的就是「文件顺序乱了」。
//
// 分级只看**首个非空字符**：
//
//	1 = 标点 / 数字 / 符号（ICU 里排在所有字母之前）
//	2 = 汉字
//	3 = 其他字母（拉丁等）
//
// 同一级内仍交给 Collator，所以纯 ASCII 目录的相对顺序与改动前完全一致。
func CompareNames(a, b string) int {
	if ra, rb := scriptRank(a), scriptRank(b); ra != rb {
		return ra - rb
	}
	collatorMu.Lock()
	defer collatorMu.Unlock()
	return collator.CompareString(a, b)
}

// scriptRank 返回上面那套分级（首个非空字符决定整串）。
func scriptRank(s string) int {
	for _, r := range s {
		switch {
		case unicode.Is(unicode.Han, r):
			return 2
		case unicode.IsLetter(r):
			return 3
		default:
			return 1
		}
	}
	// 空串按标点级处理（Node 里空名字会排在最前）。
	return 1
}

// Rooted I/O prevents symlink/junction replacement from escaping the registered
// root between validation and use. The configured root itself may be a link.
func rooted(root RootInfo, absolute string) (*os.Root, string, error) {
	rel, err := filepath.Rel(root.AbsPath, absolute)
	if err != nil || !filepath.IsLocal(rel) {
		return nil, "", ErrPathEscape
	}
	scope, err := os.OpenRoot(root.AbsPath)
	return scope, rel, err
}
func OpenFile(root RootInfo, absolute string, flags int, mode os.FileMode) (*os.File, error) {
	if root.Readonly && flags&(os.O_WRONLY|os.O_RDWR|os.O_CREATE|os.O_TRUNC|os.O_APPEND) != 0 {
		return nil, ErrRootReadonly
	}
	scope, rel, err := rooted(root, absolute)
	if err != nil {
		return nil, err
	}
	defer scope.Close()
	return scope.OpenFile(rel, flags, mode)
}
func Open(root RootInfo, absolute string) (*os.File, error) {
	return OpenFile(root, absolute, os.O_RDONLY, 0)
}
func Stat(root RootInfo, absolute string) (os.FileInfo, error) {
	scope, rel, err := rooted(root, absolute)
	if err != nil {
		return nil, err
	}
	defer scope.Close()
	return scope.Stat(rel)
}
func ReadDir(root RootInfo, absolute string) ([]os.DirEntry, error) {
	f, err := Open(root, absolute)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return f.ReadDir(-1)
}
func MkdirAll(root RootInfo, absolute string, mode os.FileMode) error {
	if root.Readonly {
		return ErrRootReadonly
	}
	scope, rel, err := rooted(root, absolute)
	if err != nil {
		return err
	}
	defer scope.Close()
	return scope.MkdirAll(rel, mode)
}
func Rename(root RootInfo, old, next string) error {
	if root.Readonly {
		return ErrRootReadonly
	}
	scope, rel, err := rooted(root, old)
	if err != nil {
		return err
	}
	defer scope.Close()
	nextRel, err := filepath.Rel(root.AbsPath, next)
	if err != nil || !filepath.IsLocal(nextRel) {
		return ErrPathEscape
	}
	return scope.Rename(rel, nextRel)
}
func RemoveAll(root RootInfo, absolute string) error {
	if root.Readonly {
		return ErrRootReadonly
	}
	scope, rel, err := rooted(root, absolute)
	if err != nil {
		return err
	}
	defer scope.Close()
	if rel == "." {
		return ErrPathEscape
	}
	return scope.RemoveAll(rel)
}
