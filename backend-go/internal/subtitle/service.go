// Package subtitle 汇编「字幕搜索 / 目录浏览 / 字幕加载 / Emby 内嵌字幕」的取数。
//
// 迁移自 backend/src/modules/subtitle/subtitle-source.service.ts，路由层
// （internal/api/subtitles.go）只保留参数校验、影片 404 与响应组装。
//
// 与原实现的分工约定一致：
//   - 原「res.json({ success: true, subtitles: [] })」类早退 → 返回空结果；
//   - 原「res.status(4xx).json(...)」类早退 → 返回 *ServiceError，由路由
//     按 Status 回写（其余错误一律 500，与 Node 的 catch 分支一致）。
package subtitle

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"zviewer/backend/internal/emby"
	"zviewer/backend/internal/ftp"
	"zviewer/backend/internal/openlist"
	"zviewer/backend/internal/proxy"
	"zviewer/backend/internal/serverfiles"
	"zviewer/backend/internal/store"
	"zviewer/backend/internal/webdav"
)

// defaultUA 是拉取 OpenList raw_url 时使用的 UA。
//
// 部分网盘的直链会对非浏览器 UA 直接 403，与 Node 侧保持一致。
const defaultUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
	"(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

// ServiceError 是携带 HTTP 状态码的服务层错误。
type ServiceError struct {
	Status  int
	Message string
}

func (e *ServiceError) Error() string { return e.Message }

func newError(status int, message string) *ServiceError {
	return &ServiceError{Status: status, Message: message}
}

// MaxSubtitleBytes 是单个字幕文件的大小上限（2MB）。
//
// 字幕是文本，超过 2MB 基本可以确定不是字幕（或者被当成了视频/压缩包），
// 读进内存再转字符串会直接把进程内存打满。
const MaxSubtitleBytes = 2 * 1024 * 1024

// Exts 是支持的字幕扩展名（小写，带点）。
//
// 顺序即 `/search` 的返回顺序含义：这里只是白名单，返回顺序由目录列举决定。
var Exts = []string{".vtt", ".srt", ".ass", ".ssa", ".smi", ".sami", ".sub"}

func isSubtitleExt(ext string) bool {
	for _, e := range Exts {
		if e == ext {
			return true
		}
	}
	return false
}

// Ext 取文件名的小写扩展名（含点）；没有扩展名时返回空串。
func Ext(filename string) string {
	dot := strings.LastIndex(filename, ".")
	if dot < 0 {
		return ""
	}
	return strings.ToLower(filename[dot:])
}

// BaseName 取路径最后一段。
//
// 与 Node 的 basename 一致：反斜杠也当分隔符（影片路径可能来自 Windows 端），
// 且不做 filepath.Base 那样的平台相关处理。
func BaseName(p string) string {
	parts := strings.Split(strings.ReplaceAll(p, "\\", "/"), "/")
	return parts[len(parts)-1]
}

// Dirname 取所在目录（反斜杠先归一成正斜杠）。
//
// 根目录场景返回 "/"：与 Node 的 `idx >= 0 ? slice(0, idx) : '/'` 一致。
func Dirname(p string) string {
	normalized := strings.ReplaceAll(p, "\\", "/")
	if idx := strings.LastIndex(normalized, "/"); idx >= 0 {
		return normalized[:idx]
	}
	return "/"
}

// StripExt 去掉扩展名（点必须在首位之后才算，隐藏文件 `.srt` 原样返回）。
func StripExt(filename string) string {
	dot := strings.LastIndex(filename, ".")
	if dot > 0 {
		return filename[:dot]
	}
	return filename
}

// joinPath 在目录后拼文件名，避免出现双斜杠。
func joinPath(dir, name string) string {
	if strings.HasSuffix(dir, "/") {
		return dir + name
	}
	return dir + "/" + name
}

// SearchResult 是同名字幕搜索结果。
type SearchResult struct {
	Filename string `json:"filename"`
	Format   string `json:"format"`
	Content  string `json:"content"`
}

// BrowseEntry 是目录浏览条目。
//
// Size 用指针：server-files 源的**目录**没有 size 字段（Node 里是 undefined，
// JSON.stringify 会整键丢弃），FTP / OpenList 则恒有值（可能是 0）。
type BrowseEntry struct {
	Name       string `json:"name"`
	Path       string `json:"path"`
	Type       string `json:"type"`
	IsSubtitle bool   `json:"isSubtitle"`
	Size       *int64 `json:"size,omitempty"`
}

// BrowseResult 是目录浏览结果。
type BrowseResult struct {
	Entries     []BrowseEntry `json:"entries"`
	CurrentPath string        `json:"currentPath"`
	ParentPath  any           `json:"parentPath"` // string 或 null
}

// LoadResult 是字幕文件内容。
type LoadResult struct {
	Filename string `json:"filename"`
	Format   string `json:"format"`
	Content  string `json:"content"`
}

// Service 持有字幕取数所需的三类边界依赖。
type Service struct {
	Stream   *proxy.StreamResolver
	Files    *serverfiles.Registry
	OpenList *openlist.Client
}

// NewService 构造字幕服务。
func NewService(stream *proxy.StreamResolver, files *serverfiles.Registry) *Service {
	return &Service{Stream: stream, Files: files, OpenList: openlist.NewClient()}
}

// creds 是从影片 + 挂载回填出来的连接凭证。
type creds struct {
	Username string
	Password string
	Port     int
}

// fillCredentials 按影片反查挂载补全凭证。
//
// 旧版本前端创建影片时不传 username/password，直接拿 movie 上的空凭证去连
// 必然 401；这里按 movieId 走与播放完全相同的解析链（sourceMountId 优先，
// 再按 serverUrl + 房主兜底），保证「能播的影片一定能读字幕」。
//
// 影片没有 serverUrl 时返回空凭证（Node 侧同样是早退，不抛错）。
func (s *Service) fillCredentials(ctx context.Context, movie *store.Movie) (creds, error) {
	if movie.ServerURL == nil || *movie.ServerURL == "" {
		return creds{}, nil
	}
	source := strings.ToLower(deref(movie.Source))
	opts := (*proxy.ResolveOptions)(nil)
	if source == "openlist" {
		// OpenList 的 movie.serverUrl 存用户原值，挂载表存补了 /dav 的规范地址。
		opts = &proxy.ResolveOptions{NormalizeServerURL: openlist.NormalizeServerURL}
	}
	resolved, err := s.Stream.Resolve(ctx, movie.ID, source, opts)
	if err != nil {
		return creds{}, err
	}
	out := creds{Username: resolved.Username, Password: resolved.Password}
	if resolved.Mount != nil && resolved.Mount.Port != nil {
		out.Port = int(*resolved.Mount.Port)
	}
	return out, nil
}

func deref(v *string) string {
	if v == nil {
		return ""
	}
	return *v
}

// readLimited 把流整份读进内存并转为字符串（上限 MaxSubtitleBytes）。
func readLimited(rc io.ReadCloser, max int64) (string, error) {
	defer rc.Close()
	buf, err := io.ReadAll(io.LimitReader(rc, max+1))
	if err != nil {
		return "", err
	}
	if int64(len(buf)) > max {
		return "", errors.New("字幕文件过大（超过 2MB）")
	}
	return string(buf), nil
}

// readOpenListFileContent 通过 AList HTTP API 读文件内容。
//
// 流程与 Node 一致：先 fs/get 拿带签名的 raw_url，再直接 GET 该地址。
// 不用 WebDAV 协议走的原因：AList 的 /dav 端点对私有目录要求另一套鉴权，
// 而 fs/get 给出的 raw_url 已经带签名，直接取最省事也最稳。
func (s *Service) readOpenListFileContent(
	ctx context.Context, serverURL string, c creds, filePath string,
) (string, error) {
	info, err := s.OpenList.FetchFileInfo(ctx, serverURL, c.Username, c.Password, filePath)
	if err != nil {
		return "", err
	}
	if info.RawURL == "" {
		return "", errors.New("OpenList 未返回文件直链")
	}

	reqCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, info.RawURL, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", defaultUA)
	resp, err := (&http.Client{}).Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return "", fmt.Errorf("OpenList 读取字幕失败: HTTP %d", resp.StatusCode)
	}
	buf, err := io.ReadAll(io.LimitReader(resp.Body, MaxSubtitleBytes+1))
	if err != nil {
		return "", err
	}
	if len(buf) > MaxSubtitleBytes {
		return "", errors.New("字幕文件过大（超过 2MB）")
	}
	return string(buf), nil
}

// ListRoots 加载服务器文件根目录注册表。
func (s *Service) ListRoots(ctx context.Context) ([]serverfiles.RootInfo, error) {
	if s.Files == nil {
		return nil, errors.New("服务器文件模块未初始化")
	}
	return s.Files.Load(ctx)
}

// SearchSubtitlesInMovieDir 搜索影片同目录下与视频同名的字幕文件。
//
// 「同名」判定是**前缀**匹配（`videoBasename` 是小写前缀），这样
// `EP01.mkv` 能匹配到 `EP01.chs.srt` / `EP01.ass` 这类多语言字幕命名。
// 非文件源 / 无路径场景一律返回空列表（不是错误）。
func (s *Service) SearchSubtitlesInMovieDir(ctx context.Context, movie *store.Movie) ([]SearchResult, error) {
	source := strings.ToLower(deref(movie.Source))
	if !IsFileSource(source) {
		return nil, nil
	}
	if movie.Path == nil || *movie.Path == "" {
		return nil, nil
	}

	moviePath := *movie.Path
	videoBasename := StripExt(BaseName(moviePath))
	if videoBasename == "" {
		return nil, nil
	}
	dirPath := Dirname(moviePath)
	lowerBase := strings.ToLower(videoBasename)

	results := make([]SearchResult, 0, 4)

	if source == "server-files" {
		roots, err := s.ListRoots(ctx)
		if err != nil {
			return nil, err
		}
		dirAbs, _, err := serverfiles.ResolveSafePath(dirPath, roots)
		if err != nil {
			return nil, err
		}
		st, err := os.Stat(dirAbs)
		if err != nil || !st.IsDir() {
			return nil, nil
		}
		items, err := os.ReadDir(dirAbs)
		if err != nil {
			return nil, err
		}
		for _, item := range items {
			name := item.Name()
			ext := Ext(name)
			if !isSubtitleExt(ext) {
				continue
			}
			if !strings.HasPrefix(strings.ToLower(name), lowerBase) {
				continue
			}
			filePath := joinPath(dirPath, name)
			fileAbs, _, err := serverfiles.ResolveSafePath(filePath, roots)
			if err != nil {
				continue
			}
			content, err := os.ReadFile(fileAbs)
			if err != nil {
				// 单条字幕读失败不影响其余字幕（Node 侧同样是 warn + 跳过）。
				continue
			}
			results = append(results, SearchResult{
				Filename: name,
				Format:   strings.TrimPrefix(ext, "."),
				Content:  string(content),
			})
		}
		return results, nil
	}

	c, err := s.fillCredentials(ctx, movie)
	if err != nil {
		return nil, err
	}
	serverURL := deref(movie.ServerURL)
	if serverURL == "" {
		return nil, nil
	}

	switch source {
	case "ftp":
		entries, err := ftp.ListDir(ctx, ftp.Params{
			ServerURL: serverURL, Path: dirPath,
			Username: c.Username, Password: c.Password, Port: c.Port,
		}, dirPath)
		if err != nil {
			return nil, err
		}
		for _, entry := range entries {
			if entry.Type != "file" {
				continue
			}
			ext := Ext(entry.Name)
			if !isSubtitleExt(ext) || !strings.HasPrefix(strings.ToLower(entry.Name), lowerBase) {
				continue
			}
			rc, err := ftp.OpenStream(ctx, ftp.Params{
				ServerURL: serverURL, Path: joinPath(dirPath, entry.Name),
				Username: c.Username, Password: c.Password, Port: c.Port,
			}, 0)
			if err != nil {
				continue
			}
			content, err := readLimited(rc, MaxSubtitleBytes)
			if err != nil {
				continue
			}
			results = append(results, SearchResult{
				Filename: entry.Name, Format: strings.TrimPrefix(ext, "."), Content: content,
			})
		}
	case "openlist":
		listing, err := s.OpenList.ListDir(ctx, serverURL, c.Username, c.Password, dirPath)
		if err != nil {
			return nil, err
		}
		for _, entry := range listing.Entries {
			if entry.IsDir {
				continue
			}
			ext := Ext(entry.Name)
			if !isSubtitleExt(ext) || !strings.HasPrefix(strings.ToLower(entry.Name), lowerBase) {
				continue
			}
			content, err := s.readOpenListFileContent(ctx, serverURL, c, joinPath(dirPath, entry.Name))
			if err != nil {
				continue
			}
			results = append(results, SearchResult{
				Filename: entry.Name, Format: strings.TrimPrefix(ext, "."), Content: content,
			})
		}
	default: // webdav
		entries, err := webdav.ListDir(ctx, webdav.Params{
			ServerURL: serverURL, Path: dirPath,
			Username: c.Username, Password: c.Password,
		}, dirPath)
		if err != nil {
			return nil, err
		}
		for _, entry := range entries {
			if entry.Type != "file" {
				continue
			}
			ext := Ext(entry.Name)
			if !isSubtitleExt(ext) || !strings.HasPrefix(strings.ToLower(entry.Name), lowerBase) {
				continue
			}
			rc, _, err := webdav.OpenReadStream(ctx, webdav.Params{
				ServerURL: serverURL, Path: joinPath(dirPath, entry.Name),
				Username: c.Username, Password: c.Password,
			})
			if err != nil {
				continue
			}
			content, err := readLimited(rc, MaxSubtitleBytes)
			if err != nil {
				continue
			}
			results = append(results, SearchResult{
				Filename: entry.Name, Format: strings.TrimPrefix(ext, "."), Content: content,
			})
		}
	}
	return results, nil
}

// IsFileSource 判断是否是可浏览目录的文件源。
func IsFileSource(source string) bool {
	switch source {
	case "webdav", "openlist", "ftp", "server-files":
		return true
	}
	return false
}

// BrowseMovieDirectory 浏览影片所在目录（或指定子目录）。
//
// 排序规则必须是「目录在前 → 同组按简体中文拼音」：前端目录选择器靠它
// 保持稳定顺序，码点序会把「阿」排到「波」后面。
func (s *Service) BrowseMovieDirectory(
	ctx context.Context, movie *store.Movie, targetPath string,
) (*BrowseResult, error) {
	source := strings.ToLower(deref(movie.Source))
	entries := make([]BrowseEntry, 0, 16)

	if source == "server-files" {
		roots, err := s.ListRoots(ctx)
		if err != nil {
			return nil, err
		}
		dirAbs, _, err := serverfiles.ResolveSafePath(targetPath, roots)
		if err != nil {
			return nil, err
		}
		st, err := os.Stat(dirAbs)
		if err != nil || !st.IsDir() {
			return &BrowseResult{Entries: entries, CurrentPath: targetPath, ParentPath: nil}, nil
		}
		items, err := os.ReadDir(dirAbs)
		if err != nil {
			return nil, err
		}
		for _, item := range items {
			name := item.Name()
			if strings.HasPrefix(name, ".") {
				continue
			}
			entry := BrowseEntry{Name: name, Path: joinPath(targetPath, name)}
			if item.IsDir() {
				entry.Type = "directory"
			} else {
				entry.Type = "file"
				entry.IsSubtitle = isSubtitleExt(Ext(name))
				// 目录没有 size：Node 里是 undefined，JSON 里整键消失。
				if info, err := os.Stat(filepath.Join(dirAbs, name)); err == nil {
					size := info.Size()
					entry.Size = &size
				}
			}
			entries = append(entries, entry)
		}
	} else {
		c, err := s.fillCredentials(ctx, movie)
		if err != nil {
			return nil, err
		}
		serverURL := deref(movie.ServerURL)

		switch source {
		case "ftp":
			if serverURL == "" {
				return nil, newError(400, "FTP 服务器地址缺失")
			}
			list, err := ftp.ListDir(ctx, ftp.Params{
				ServerURL: serverURL, Path: targetPath,
				Username: c.Username, Password: c.Password, Port: c.Port,
			}, targetPath)
			if err != nil {
				return nil, err
			}
			for _, e := range list {
				size := e.Size
				entries = append(entries, BrowseEntry{
					Name: e.Name, Path: joinPath(targetPath, e.Name), Type: e.Type,
					IsSubtitle: e.Type == "file" && isSubtitleExt(Ext(e.Name)),
					Size:       &size,
				})
			}
		case "openlist":
			if serverURL == "" {
				return nil, newError(400, "OpenList 服务器地址缺失")
			}
			listing, err := s.OpenList.ListDir(ctx, serverURL, c.Username, c.Password, targetPath)
			if err != nil {
				return nil, err
			}
			for _, e := range listing.Entries {
				size := e.Size
				entryType := "file"
				if e.IsDir {
					entryType = "directory"
				}
				entries = append(entries, BrowseEntry{
					Name: e.Name, Path: joinPath(targetPath, e.Name), Type: entryType,
					IsSubtitle: entryType == "file" && isSubtitleExt(Ext(e.Name)),
					Size:       &size,
				})
			}
		default: // webdav
			if serverURL == "" {
				return nil, newError(400, "WebDAV 服务器地址缺失")
			}
			list, err := webdav.ListDir(ctx, webdav.Params{
				ServerURL: serverURL, Path: targetPath,
				Username: c.Username, Password: c.Password,
			}, targetPath)
			if err != nil {
				return nil, err
			}
			for _, e := range list {
				entries = append(entries, BrowseEntry{
					Name: e.Name, Path: joinPath(targetPath, e.Name), Type: e.Type,
					IsSubtitle: e.Type == "file" && isSubtitleExt(Ext(e.Name)),
					Size:       e.Size,
				})
			}
		}
	}

	sort.SliceStable(entries, func(i, j int) bool {
		if entries[i].Type != entries[j].Type {
			return entries[i].Type == "directory"
		}
		return serverfiles.CompareNames(entries[i].Name, entries[j].Name) < 0
	})

	normalized := strings.ReplaceAll(targetPath, "\\", "/")
	var parentPath any
	if idx := strings.LastIndex(normalized, "/"); idx > 0 {
		parentPath = normalized[:idx]
	} else {
		parentPath = nil
	}

	return &BrowseResult{Entries: entries, CurrentPath: targetPath, ParentPath: parentPath}, nil
}

// LoadSubtitleFile 读取指定路径的字幕文件内容。
//
// 返回的是**文件内容**而不是 URL：前端解析后转成 data URL 走 socket 同步，
// 观众端不需要再拿一次凭证去源站取。
func (s *Service) LoadSubtitleFile(
	ctx context.Context, movie *store.Movie, filePath string,
) (*LoadResult, error) {
	source := strings.ToLower(deref(movie.Source))
	filename := BaseName(filePath)
	ext := Ext(filename)

	var content string
	if source == "server-files" {
		roots, err := s.ListRoots(ctx)
		if err != nil {
			return nil, err
		}
		fileAbs, _, err := serverfiles.ResolveSafePath(filePath, roots)
		if err != nil {
			return nil, err
		}
		st, err := os.Stat(fileAbs)
		if err != nil || st.IsDir() {
			return nil, newError(404, "字幕文件不存在")
		}
		buf, err := os.ReadFile(fileAbs)
		if err != nil {
			return nil, err
		}
		content = string(buf)
	} else {
		c, err := s.fillCredentials(ctx, movie)
		if err != nil {
			return nil, err
		}
		serverURL := deref(movie.ServerURL)

		switch source {
		case "ftp":
			if serverURL == "" {
				return nil, newError(400, "FTP 服务器地址缺失")
			}
			rc, err := ftp.OpenStream(ctx, ftp.Params{
				ServerURL: serverURL, Path: filePath,
				Username: c.Username, Password: c.Password, Port: c.Port,
			}, 0)
			if err != nil {
				return nil, err
			}
			content, err = readLimited(rc, MaxSubtitleBytes)
			if err != nil {
				return nil, err
			}
		case "openlist":
			if serverURL == "" {
				return nil, newError(400, "OpenList 服务器地址缺失")
			}
			content, err = s.readOpenListFileContent(ctx, serverURL, c, filePath)
			if err != nil {
				return nil, err
			}
		default: // webdav
			if serverURL == "" {
				return nil, newError(400, "WebDAV 服务器地址缺失")
			}
			rc, _, err := webdav.OpenReadStream(ctx, webdav.Params{
				ServerURL: serverURL, Path: filePath,
				Username: c.Username, Password: c.Password,
			})
			if err != nil {
				return nil, err
			}
			content, err = readLimited(rc, MaxSubtitleBytes)
			if err != nil {
				return nil, err
			}
		}
	}

	return &LoadResult{Filename: filename, Format: strings.TrimPrefix(ext, "."), Content: content}, nil
}

// ==================== Emby 内嵌字幕 ====================

// embedContext 是调 Emby 字幕接口所需的客户端与定位信息。
type embedContext struct {
	Client *emby.Client
	ItemID string
	UserID string
}

// resolveEmbyContext 解析 Emby / Jellyfin 播放所需的客户端与用户。
//
// Emby 字幕不走「服务器中转」，后端始终持有 serverUrl + API Key/凭证，
// 所以无论视频走直链还是中转都能调 PlaybackInfo / Subtitles Stream。
func (s *Service) resolveEmbyContext(ctx context.Context, movie *store.Movie) (*embedContext, error) {
	source := strings.ToLower(deref(movie.Source))
	if source != "emby" && source != "jellyfin" {
		return nil, errors.New("该源暂不支持内嵌字幕")
	}
	if deref(movie.ServerURL) == "" || deref(movie.Path) == "" {
		return nil, errors.New("该影片未挂载服务器信息")
	}
	resolved, err := s.Stream.Resolve(ctx, movie.ID, source, nil)
	if err != nil {
		return nil, err
	}
	mount := resolved.Mount

	// 合成一份挂载：serverUrl 用影片的，凭证「影片优先、挂载兜底」。
	synthetic := &store.Mount{ServerURL: movie.ServerURL}
	if mount != nil {
		synthetic.APIKey = mount.APIKey
		synthetic.EmbyUserID = mount.EmbyUserID
		synthetic.Username = firstNonEmptyPtr(movie.Username, mount.Username)
		synthetic.Password = firstNonEmptyPtr(movie.Password, mount.Password)
	} else {
		synthetic.Username = firstNonEmptyPtr(movie.Username, nil)
		synthetic.Password = firstNonEmptyPtr(movie.Password, nil)
	}

	client, err := emby.NewFromMount(synthetic)
	if err != nil {
		return nil, err
	}
	// 注意这里刻意不用 emby.ResolveSession：那个版本的 userId 判定要求
	// 「有 apiKey 且 embyUserId 非空」才用缓存值，而字幕这条路径在 Node 里
	// 是无条件优先用 mount.embyUserId。两者在「账号密码登录 + 已存 userId」
	// 的挂载上会分叉（多一次 /Users/Me 请求），必须逐字对齐。
	userID := deref(derefPtr(mount))
	if userID == "" {
		me, err := client.Me(ctx)
		if err != nil {
			return nil, err
		}
		userID = me.ID
	}
	return &embedContext{Client: client, ItemID: deref(movie.Path), UserID: userID}, nil
}

// derefPtr 取 mount.EmbyUserID（mount 可能为 nil）。
func derefPtr(mount *store.Mount) *string {
	if mount == nil {
		return nil
	}
	return mount.EmbyUserID
}

// firstNonEmptyPtr 返回第一个非空指针（Node 的 `a || b || undefined`）。
func firstNonEmptyPtr(a, b *string) *string {
	if a != nil && *a != "" {
		return a
	}
	if b != nil && *b != "" {
		return b
	}
	return nil
}

// embeddedMediaSources 取 PlaybackInfo 的媒体源列表。
//
// 空列表不算错误：Node 侧 `playback.MediaSources[0]` 为 undefined 时会退化成
// 「没有字幕轨道」，而不是报错。这里把 emby 的 NO_MEDIA_SOURCE 收敛成空列表，
// 保持同一语义（否则「Emby 库里一个媒体源都没探测到」会从 [] 变成 400）。
func (s *Service) embeddedMediaSources(
	ctx context.Context, ectx *embedContext,
) ([]emby.EmbyMediaSrc, error) {
	sources, err := ectx.Client.PlaybackInfo(ctx, ectx.ItemID, ectx.UserID)
	if err != nil {
		var e *emby.Error
		if errors.As(err, &e) && e.Code == emby.CodeNoMediaSource {
			return nil, nil
		}
		return nil, err
	}
	return sources, nil
}

// Track 是一条内嵌字幕轨道的描述。
type Track struct {
	Index     int    `json:"index"`
	CodecName string `json:"codecName"`
	Language  any    `json:"language"`
	Title     any    `json:"title"`
	Label     string `json:"label"`
}

// ExtractResult 是内嵌字幕提取结果。
type ExtractResult struct {
	Content  string `json:"content"`
	Format   string `json:"format"`
	Label    string `json:"label"`
	Language any    `json:"language"`
}

// MapEmbySubtitleFormat 把 Emby 的 codec 映射成提取后缀与前端解析格式。
//
// Emby 的 Subtitles Stream 端点按扩展名路由转封装输出，裸 `/Stream`
// （无扩展名）会 404——srt 也必须显式带 `.srt` 后缀。
func MapEmbySubtitleFormat(codec string) (ext string, format string) {
	switch codec {
	case "ass", "ssa":
		return "ass", "ass"
	case "webvtt":
		return "vtt", "vtt"
	default: // srt / subrip / 未知
		return "srt", "srt"
	}
}

// ListEmbyEmbeddedTracks 列出视频的内嵌字幕轨道。
func (s *Service) ListEmbyEmbeddedTracks(ctx context.Context, movie *store.Movie) ([]Track, error) {
	ectx, err := s.resolveEmbyContext(ctx, movie)
	if err != nil {
		return nil, err
	}
	sources, err := s.embeddedMediaSources(ctx, ectx)
	if err != nil {
		return nil, err
	}
	if len(sources) == 0 {
		return nil, nil
	}
	tracks := make([]Track, 0, 4)
	for _, stream := range sources[0].MediaStreams {
		if stream.Type != "Subtitle" {
			continue
		}
		codec := deref(stream.Codec)
		if codec == "" {
			codec = "unknown"
		}
		label := stream.DisplayTitle
		if label == "" {
			label = stream.Language
		}
		if label == "" {
			label = fmt.Sprintf("轨道 %d", stream.Index)
		}
		tracks = append(tracks, Track{
			Index:     stream.Index,
			CodecName: codec,
			Language:  nullIfEmpty(stream.Language),
			Title:     nullIfEmpty(stream.DisplayTitle),
			Label:     label,
		})
	}
	return tracks, nil
}

// ExtractEmbyEmbeddedTrack 提取指定内嵌字幕轨道内容。
//
// streamIndex 是 float64 而不是 int：Node 侧是 `Number(req.query.index)`
// 后直接 `s.Index === streamIndex` 比较，`index=1.5` 会「查不到轨道」而不是
// 被截断成 1 命中。用 float64 才能保住这条语义。
func (s *Service) ExtractEmbyEmbeddedTrack(
	ctx context.Context, movie *store.Movie, streamIndex float64,
) (*ExtractResult, error) {
	ectx, err := s.resolveEmbyContext(ctx, movie)
	if err != nil {
		return nil, err
	}
	sources, err := s.embeddedMediaSources(ctx, ectx)
	if err != nil {
		return nil, err
	}
	var mediaSource *emby.EmbyMediaSrc
	if len(sources) > 0 {
		mediaSource = &sources[0]
	}

	var target *emby.EmbyMediaStream
	if mediaSource != nil {
		for i := range mediaSource.MediaStreams {
			stream := &mediaSource.MediaStreams[i]
			if stream.Type == "Subtitle" && float64(stream.Index) == streamIndex {
				target = stream
				break
			}
		}
	}
	if target == nil || mediaSource == nil {
		return nil, newError(400, "未找到指定的字幕轨道")
	}

	index := int(streamIndex)
	ext, format := MapEmbySubtitleFormat(deref(target.Codec))
	content, err := ectx.Client.SubtitleContent(ctx, ectx.ItemID, mediaSource.ID, index, ext)
	if err != nil {
		return nil, err
	}
	label := target.DisplayTitle
	if label == "" {
		label = target.Language
	}
	if label == "" {
		label = fmt.Sprintf("轨道 %d", index)
	}
	return &ExtractResult{
		Content:  content,
		Format:   format,
		Label:    label,
		Language: nullIfEmpty(target.Language),
	}, nil
}

// nullIfEmpty 把空串换成 nil，JSON 里输出 null（对齐 Node 的 `|| null`）。
func nullIfEmpty(v string) any {
	if v == "" {
		return nil
	}
	return v
}
