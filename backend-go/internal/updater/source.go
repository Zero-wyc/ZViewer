package updater

// 更新源：GitHub（原链路）与 GitCode（大陆镜像）。
//
// 为什么偏好落在文件而不是数据库：`system_settings` 是 TypeORM 生成的整行表，
// Go 侧「绝不自动改表结构」——加一列会让存量库的 SELECT 直接失败（启动即炸），
// 而 `--init-db` 只服务空库。这里是一个纯运行期偏好，写
// `config/update-source.json` 即可：config/ 在自动更新时会被备份还原，不会丢。
//
// 默认值刻意是 GitCode：GitHub 在大陆经常连不上，而 GitCode 是同一份 Release
// 的镜像；GitCode 不可用时自动回退 GitHub，不会比原来更难用。

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const (
	// SourceGitHub 是原链路：api.github.com + 可选 CDN 前缀。
	SourceGitHub = "github"
	// SourceGitCode 是大陆镜像：api.gitcode.com，直连对象存储，不需要代理。
	SourceGitCode = "gitcode"

	// gitCodeAPIBase 是 GitCode OpenAPI 基址。
	gitCodeAPIBase = "https://api.gitcode.com/api/v5"
	// gitCodeReleasesPerPage 一次取满 GitCode 的 Release 列表。
	//
	// GitCode 的 /releases 按 created_at **升序**返回（GitHub 是降序）：只取前 10 条
	// 拿到的是最旧的 10 个，仓库一旦超过 10 个 Release，最新版本就再也查不到了。
	gitCodeReleasesPerPage = 100
	// gitCodeSiteBase 用来拼发布页地址：GitCode 的 release 列表不带 html_url。
	gitCodeSiteBase = "https://gitcode.com"

	// sourceFileName 是更新源偏好的文件名，落在 <root>/config/ 下。
	sourceFileName = "update-source.json"
)

// sourcePreference 是配置文件形状。用指针接住「字段缺失」，缺失按默认处理。
type sourcePreference struct {
	UseGitCode *bool `json:"useGitCode"`
}

// SourcePreferencePath 返回偏好文件路径。
func SourcePreferencePath(root string) string {
	return filepath.Join(root, "config", sourceFileName)
}

// ReadSourcePreference 读取偏好；文件缺失或格式不对时按默认（GitCode）处理。
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
func WriteSourcePreference(root string, useGitCode bool) error {
	path := SourcePreferencePath(root)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(sourcePreference{UseGitCode: &useGitCode}, "", "  ")
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
// 优先级：Service.Source（测试/调用方显式指定）> 环境变量 > 配置文件 > 默认 GitCode。
// 环境变量留给运维：`ZVIEWER_UPDATE_SOURCE=github` 可在不碰界面的情况下改回原链路。
func (s *Service) updateSource() string {
	if s.Source != "" {
		return s.Source
	}
	switch strings.ToLower(strings.TrimSpace(os.Getenv("ZVIEWER_UPDATE_SOURCE"))) {
	case SourceGitHub:
		return SourceGitHub
	case SourceGitCode:
		return SourceGitCode
	}
	if ReadSourcePreference(s.Root) {
		return SourceGitCode
	}
	return SourceGitHub
}

func (s *Service) gitCodeAPI() string {
	base := strings.TrimSpace(s.GitCodeAPIBase)
	if base == "" {
		base = gitCodeAPIBase
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

// fetchGitCodeReleases 走 GitCode 镜像。
//
// 响应形状与 GitHub 高度相似（tag_name / body / prerelease / assets），差异都在
// normalizeGitCodeReleases 里抹平；这里只负责取一次列表。
func (s *Service) fetchGitCodeReleases(ctx context.Context) ([]githubRelease, error) {
	apiURL := fmt.Sprintf("%s/repos/%s/%s/releases?per_page=%d",
		s.gitCodeAPI(), repoOwner, repoName, gitCodeReleasesPerPage)
	var releases []githubRelease
	if err := s.httpGetJSON(ctx, apiURL, &releases); err != nil {
		return nil, err
	}
	return sortReleasesByCreatedDesc(normalizeGitCodeReleases(releases)), nil
}

// sortReleasesByCreatedDesc 把 GitCode 的列表排成 created_at 降序。
//
// selectRelease 依赖「releases[0] 是最新一次构建」，GitHub 天然满足（降序返回），
// GitCode 却是升序——不排序就会拿最旧的 Release 去做版本判定。线上表现就是：
// 明明已经是 v5.0.7，检查更新却报「Release v5.0.2 中未找到构建产物」。
func sortReleasesByCreatedDesc(releases []githubRelease) []githubRelease {
	parsed := 0
	for _, release := range releases {
		if _, err := time.Parse(time.RFC3339, release.CreatedAt); err == nil {
			parsed++
		}
	}
	// 时间戳一个都解析不了时，按 GitCode 的原始顺序（升序）直接反转，
	// 不让顺序退回「最旧优先」。
	if parsed == 0 {
		for i, j := 0, len(releases)-1; i < j; i, j = i+1, j-1 {
			releases[i], releases[j] = releases[j], releases[i]
		}
		return releases
	}
	sort.SliceStable(releases, func(i, j int) bool {
		ti, erri := time.Parse(time.RFC3339, releases[i].CreatedAt)
		tj, errj := time.Parse(time.RFC3339, releases[j].CreatedAt)
		if erri == nil && errj == nil {
			return ti.After(tj)
		}
		// 个别时间戳坏掉时退回字符串比较，仍按新的在前。
		return releases[i].CreatedAt > releases[j].CreatedAt
	})
	return releases
}

// normalizeGitCodeReleases 把 GitCode 的字段差异补齐成 GitHub 的形状：
//
//   - 没有 html_url：按站内路由拼 /releases/tag/<tag>；
//   - 没有 published_at：用 created_at 顶替（只用于界面展示）；
//   - 预发布用 release_status="pre" 表达，同时补写 prerelease；
//   - assets 里混着源码包（type="source"），只保留 type="attach" 的上传附件，
//     否则同名规则在别的仓库上可能撞车。
func normalizeGitCodeReleases(releases []githubRelease) []githubRelease {
	for i := range releases {
		release := &releases[i]
		if release.HTMLURL == "" && release.TagName != "" {
			release.HTMLURL = fmt.Sprintf("%s/%s/%s/releases/tag/%s",
				gitCodeSiteBase, repoOwner, repoName, url.PathEscape(release.TagName))
		}
		if release.PublishedAt == nil && release.CreatedAt != "" {
			created := release.CreatedAt
			release.PublishedAt = &created
		}
		if release.ReleaseStatus == "pre" {
			release.Prerelease = true
		}
		if len(release.Assets) == 0 {
			continue
		}
		assets := make([]githubAsset, 0, len(release.Assets))
		for _, asset := range release.Assets {
			if asset.Type == "source" {
				continue
			}
			assets = append(assets, asset)
		}
		release.Assets = assets
	}
	return releases
}

// fetchReleases 取发布列表，返回「实际生效的来源」。
//
// GitCode 失败或还没有 Release 时**直接报错，不回退 GitHub**：用户选了哪个源
// 就从哪个源取，静默换源会让人以为镜像可用、实际流量却悄悄走了境外。
// 错误文案里给出改回 GitHub 的入口，用户想换是自己换。
func (s *Service) fetchReleases(ctx context.Context, source string) ([]githubRelease, string, error) {
	if source == SourceGitCode {
		releases, err := s.fetchGitCodeReleases(ctx)
		if err != nil {
			return nil, SourceGitCode, fmt.Errorf(
				"GitCode 更新源不可用：%v（可在更新设置中关闭「使用 GitCode 更新源」改用 GitHub）", err)
		}
		if len(releases) == 0 {
			return nil, SourceGitCode, errors.New(
				"GitCode 镜像暂无发布版本（可在更新设置中关闭「使用 GitCode 更新源」改用 GitHub）")
		}
		return releases, SourceGitCode, nil
	}
	releases, err := s.fetchGitHubReleases(ctx)
	return releases, SourceGitHub, err
}
