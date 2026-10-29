package updater

// 更新源：GitHub（原链路）与「镜像产物仓库」（大陆镜像）。
//
// 镜像侧不再读 GitCode / Gitee 的 Release 接口，而是读一个专门存放正式版产物的
// 独立仓库 Zero-wyc/ZviewerRelease：CI 每次正式发版把三个平台的包 + latest.json
// 清单整体替换到该仓库 main 分支根目录，再镜像到 GitCode 与 Gitee。好处是：
//
//   - 版本信息、文件名、大小、sha256 都在清单里，一次请求搞定，不依赖各平台
//     Release 接口的字段差异（GitCode 的 created_at 升序、无 html_url 等坑全没了）；
//   - 文件是普通直链，境内直连即可，不需要代理也不需要附件 API。
//
// 下载走 GitCode 的仓库文件接口 api.gitcode.com/.../raw/<文件>?ref=main。
// 不用 raw.gitcode.com（CloudWAF 对非浏览器指纹回 418），也不用 Gitee raw
// （大文件 403「large file require login」），细节见 mirrorRawBase 的注释。
//
// 为什么偏好落在文件而不是数据库：`system_settings` 是 TypeORM 生成的整行表，
// Go 侧「绝不自动改表结构」——加一列会让存量库的 SELECT 直接失败（启动即炸），
// 而 `--init-db` 只服务空库。这里是一个纯运行期偏好，写
// `config/update-source.json` 即可：config/ 在自动更新时会被备份还原，不会丢。

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

const (
	// SourceGitHub 是原链路：api.github.com + 可选 CDN 前缀。
	SourceGitHub = "github"
	// SourceGitCode 是大陆镜像源，读的是 ZviewerRelease 产物仓库。
	//
	// 常量值故意保留 "gitcode"：config/update-source.json 与
	// ZVIEWER_UPDATE_SOURCE 环境变量里已经写死了这个值，改值会让存量安装的
	// 用户偏好失效（默认值恰好也是镜像，影响有限，但没必要制造这种意外）。
	SourceGitCode = "gitcode"

	// mirrorOwnerRepo 是存放正式版产物的独立仓库（与主仓库分开，避免主仓库
	// 每次发版都被 120MB 的二进制撑大）。它同时镜像到 GitCode 与 Gitee。
	mirrorOwnerRepo = "Zero-wyc/ZviewerRelease"
	// mirrorRawBase 是 GitCode 的仓库文件直连接口前缀。
	//
	// 为什么不用看起来更自然的 raw.gitcode.com：那个域名前面挂了 CloudWAF，
	// 对非浏览器的 TLS 指纹一律回 418「您的请求疑似攻击行为」，伪装 UA/Referer
	// 都没用，Go 的 http.Client 直接被挡在外面。而 api.gitcode.com 的 /raw/
	// 端点返回 application/octet-stream、支持 Range、不经过 WAF，
	// 实测 52MB 安装包 8.8MB/s，与浏览器访问 raw 域名拿到的内容完全一致。
	//
	// 也不能用 Gitee 的 raw 域名：它对大文件返回
	// 「large file require login for access」（403），小清单能取、安装包取不到。
	mirrorRawBase = "https://api.gitcode.com/api/v5/repos/Zero-wyc/ZviewerRelease/raw"
	// mirrorRef 是产物仓库的分支。GitCode 的 raw 端点强制要求显式 ?ref=。
	mirrorRef = "main"
	// mirrorManifestName 是 CI 生成的版本清单文件名。
	mirrorManifestName = "latest.json"

	// sourceFileName 是更新源偏好的文件名，落在 <root>/config/ 下。
	sourceFileName = "update-source.json"
)

// sourcePreference 是配置文件形状。用指针接住「字段缺失」，缺失按默认处理。
type sourcePreference struct {
	UseGitCode *bool `json:"useGitCode"`
}

// mirrorManifest 是 ZviewerRelease 仓库里 latest.json 的形状（由 CI 生成）。
//
// 字段全部可选地容错：清单是 CI 写出来的，任何一项缺失都只应报一条清楚的错，
// 而不是让反序列化整体失败。
type mirrorManifest struct {
	// Tag 形如 v5.1.0；缺失时用 Version 拼。
	Tag string `json:"tag"`
	// Version 是不带 v 的版本号（5.1.0），仅用于 Tag 缺失时兜底。
	Version     string        `json:"version"`
	Commit      string        `json:"commit"`
	PublishedAt string        `json:"publishedAt"`
	ReleaseURL  string        `json:"releaseUrl"`
	Notes       string        `json:"notes"`
	Assets      []mirrorAsset `json:"assets"`
}

// mirrorAsset 是清单里的一个产物：名字、大小、摘要，外加可选直链。
//
// URL 是给「换下载通道只改 CI、不用重发客户端」留的口子：CI 写了就直接用，
// 没写就按镜像前缀 + 文件名拼，两种都能工作。
type mirrorAsset struct {
	Name   string `json:"name"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
	URL    string `json:"url"`
}

// mirrorFileURL 拼产物仓库里某个文件的直链。
//
// 清单和安装包走同一个端点，只是文件名不同；文件名带 ?ref= 是接口硬要求，
// 少了会被当成仓库路径的一部分返回 404。
func mirrorFileURL(base, name string) string {
	return base + "/" + url.PathEscape(name) + "?ref=" + mirrorRef
}

// SourcePreferencePath 返回偏好文件路径。
func SourcePreferencePath(root string) string {
	return filepath.Join(root, "config", sourceFileName)
}

// ReadSourcePreference 读取偏好；文件缺失或格式不对时按默认（镜像源）处理。
//
// 读失败一律当默认值而不是报错：这个开关只影响「从哪个站取更新」，
// 不该因为它把整个检查更新拦死。
func ReadSourcePreference(root string) bool {
	raw, err := os.ReadFile(SourcePreferencePath(root))
	if err != nil {
		return true
	}
	var pref sourcePreference
	if err := json.Unmarshal(raw, &pref); err != nil || pref.UseGitCode == nil {
		return true
	}
	return *pref.UseGitCode
}

// WriteSourcePreference 原子写入偏好（先写 .tmp 再 rename，避免半截文件）。
func WriteSourcePreference(root string, useMirror bool) error {
	path := SourcePreferencePath(root)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(sourcePreference{UseGitCode: &useMirror}, "", "  ")
	if err != nil {
		return err
	}
	temp := path + ".tmp"
	if err := os.WriteFile(temp, append(raw, '\n'), 0o644); err != nil {
		return err
	}
	return os.Rename(temp, path)
}

// updateSource 决议本次使用的更新源。
//
// 优先级：Service.Source（测试/调用方显式指定）> 环境变量 > 配置文件 > 默认镜像。
// 环境变量留给运维：`ZVIEWER_UPDATE_SOURCE=github` 可在不碰界面的情况下改回原链路。
func (s *Service) updateSource() string {
	if s.Source != "" {
		return s.Source
	}
	switch strings.ToLower(strings.TrimSpace(os.Getenv("ZVIEWER_UPDATE_SOURCE"))) {
	case SourceGitHub:
		return SourceGitHub
	case SourceGitCode, "gitee", "mirror":
		// gitee / mirror 是这次改造前后的别名，统一归一化到镜像源。
		return SourceGitCode
	}
	if ReadSourcePreference(s.Root) {
		return SourceGitCode
	}
	return SourceGitHub
}

// mirrorBase 返回镜像仓库的 raw 前缀。
//
// Service.MirrorBase 只在测试里被改写（httptest 假站），生产恒为 Gitee 前缀。
func (s *Service) mirrorBase() string {
	base := strings.TrimSpace(s.MirrorBase)
	if base == "" {
		base = mirrorRawBase
	}
	return strings.TrimRight(base, "/")
}

// fetchGitHubReleases 走原 GitHub 链路。
func (s *Service) fetchGitHubReleases(ctx context.Context) ([]githubRelease, error) {
	apiURL := fmt.Sprintf("%s/repos/%s/%s/releases?per_page=10", s.APIBase, repoOwner, repoName)
	var releases []githubRelease
	if err := s.httpGetJSON(ctx, apiURL, &releases); err != nil {
		return nil, err
	}
	return releases, nil
}

// fetchMirrorReleases 读产物仓库的 latest.json，拼成一条「已发布版本」。
//
// 清单里只有最新一个正式版，天然满足 selectRelease 依赖的「列表首条最新」，
// 也省掉了各平台 Release 接口的排序/字段差异处理。
func (s *Service) fetchMirrorReleases(ctx context.Context) ([]githubRelease, error) {
	base := s.mirrorBase()
	var manifest mirrorManifest
	if err := s.httpGetJSON(ctx, mirrorFileURL(base, mirrorManifestName), &manifest); err != nil {
		return nil, err
	}

	tag := strings.TrimSpace(manifest.Tag)
	if tag == "" {
		version := strings.TrimPrefix(strings.TrimSpace(manifest.Version), "v")
		if version == "" {
			return nil, errors.New("版本清单缺少 tag / version 字段")
		}
		tag = "v" + version
	}

	assets := make([]githubAsset, 0, len(manifest.Assets))
	for _, asset := range manifest.Assets {
		name := strings.TrimSpace(asset.Name)
		if name == "" {
			continue
		}
		downloadURL := strings.TrimSpace(asset.URL)
		if downloadURL == "" {
			downloadURL = mirrorFileURL(base, name)
		}
		assets = append(assets, githubAsset{
			Name:               name,
			Size:               asset.Size,
			BrowserDownloadURL: downloadURL,
		})
	}
	if len(assets) == 0 {
		return nil, errors.New("版本清单里没有任何平台产物")
	}

	name := tag
	release := githubRelease{
		TagName:   tag,
		Name:      &name,
		HTMLURL:   manifest.ReleaseURL,
		CreatedAt: manifest.PublishedAt,
		Assets:    assets,
	}
	if manifest.PublishedAt != "" {
		published := manifest.PublishedAt
		release.PublishedAt = &published
	}
	if manifest.Notes != "" {
		notes := manifest.Notes
		release.Body = &notes
	}
	return []githubRelease{release}, nil
}

// fetchReleases 取发布列表，返回「实际生效的来源」。
//
// 镜像源失败或清单为空时**直接报错，不回退 GitHub**：用户选了哪个源
// 就从哪个源取，静默换源会让人以为镜像可用、实际流量却悄悄走了境外。
// 错误文案里给出改回 GitHub 的入口，用户想换是自己换。
func (s *Service) fetchReleases(ctx context.Context, source string) ([]githubRelease, string, error) {
	if source == SourceGitCode {
		releases, err := s.fetchMirrorReleases(ctx)
		if err != nil {
			return nil, SourceGitCode, fmt.Errorf(
				"镜像更新源不可用：%v（可在更新设置中关闭「使用镜像更新源」改用 GitHub）", err)
		}
		if len(releases) == 0 {
			return nil, SourceGitCode, errors.New(
				"镜像仓库暂无发布版本（可在更新设置中关闭「使用镜像更新源」改用 GitHub）")
		}
		return releases, SourceGitCode, nil
	}
	releases, err := s.fetchGitHubReleases(ctx)
	return releases, SourceGitHub, err
}
