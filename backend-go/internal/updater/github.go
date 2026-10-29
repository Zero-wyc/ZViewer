package updater

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"runtime"
	"strconv"
	"strings"
	"time"

	"zviewer/backend/internal/store"
)

const (
	repoOwner = "Zero-wyc"
	repoName  = "ZViewer"

	// defaultCDNProxy 是设置页留空时回落的加速节点。
	defaultCDNProxy = "https://gh-proxy.com"

	// defaultAPIBase 是 GitHub API 的正式地址。
	defaultAPIBase = "https://api.github.com"

	// apiTimeout 与 Node 的 https.get({timeout: 30_000}) 对齐。
	apiTimeout = 30 * time.Second

	// downloadIdleTimeout 对齐 Node 的 300_000：Node 的 timeout 是 socket
	// 空闲超时而非总时长，大文件下载中途有数据就不会被打断。Go 里用
	// 「距离上次收到字节超过该时长」判定，语义一致。
	downloadIdleTimeout = 300 * time.Second
)

// Service 是更新器。
//
// 所有外部依赖（项目根、settings、HTTP 客户端、平台标识）都从字段注入，
// 这样单测能在不碰真实 GitHub / 不覆盖任何文件的前提下跑完整逻辑。
type Service struct {
	// Root 是项目根：更新包落在这里，config/ 也从这里备份。
	Root string
	// Settings 用来读 CDN 加速开关；为 nil 时按「未开启」处理。
	Settings *store.Settings
	// APIBase 默认 https://api.github.com。对拍时可指向本地假站。
	APIBase string
	// MirrorBase 是镜像产物仓库的文件直链前缀，默认 GitCode 的 ZviewerRelease；
	// 测试用它指向 httptest 假站。
	MirrorBase string
	// Source 显式指定更新源（gitcode=镜像仓库 / github）；空串时按「偏好文件 > 环境变量」
	// 决议，见 source.go 的 updateSource。测试用它绕开真实网络。
	Source string
	// GOOS 默认 runtime.GOOS，测试可覆盖以覆盖两个产物名。
	GOOS string

	// settingsOverride 仅供测试替换 settings 读取。
	settingsOverride func(ctx context.Context) (enabled bool, proxyURL string, err error)
	// spawnFn 仅供测试替换「拉起更新脚本」。真实实现会 detached 启动
	// bat/sh，测试里必须拦住——那个脚本第一件事是杀掉本进程。
	spawnFn func(isWindows bool, scriptPath, root string) error
	// dockerFn 仅供测试替换容器探测：CI 本身就跑在容器里，
	// 不注入的话 Linux 分支会随运行环境漂移。
	dockerFn func() bool

	apiClient      *http.Client
	downloadClient *http.Client
}

// New 构造更新器。
func New(root string, settings *store.Settings) *Service {
	apiBase := strings.TrimSpace(os.Getenv("ZVIEWER_UPDATE_API_BASE"))
	if apiBase == "" {
		apiBase = defaultAPIBase
	}
	// 两个客户端都自己处理重定向：跳到 CDN 的 302 必须先加代理前缀再请求，
	// 交给 http.Client 自动跟随会绕过 CDN（直连 github.com 往往就是失败原因）。
	redirect := func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &Service{
		Root:     root,
		Settings: settings,
		APIBase:  strings.TrimRight(apiBase, "/"),
		GOOS:     runtime.GOOS,
		apiClient: &http.Client{
			Timeout:       apiTimeout,
			CheckRedirect: redirect,
		},
		downloadClient: &http.Client{
			CheckRedirect: redirect,
			Transport: &http.Transport{
				Proxy:                 http.ProxyFromEnvironment,
				ResponseHeaderTimeout: downloadIdleTimeout,
			},
		},
	}
}

// SetSettingsReader 替换 settings 读取（测试专用）。
func (s *Service) SetSettingsReader(fn func(ctx context.Context) (bool, string, error)) {
	s.settingsOverride = fn
}

func (s *Service) goos() string {
	if s.GOOS == "" {
		return runtime.GOOS
	}
	return s.GOOS
}

// cdn 读取 CDN 加速配置。未开启返回 nil。
func (s *Service) cdn(ctx context.Context) (*cdnConfig, error) {
	var enabled bool
	var proxyURL string
	var err error
	switch {
	case s.settingsOverride != nil:
		enabled, proxyURL, err = s.settingsOverride(ctx)
	case s.Settings != nil:
		var cfg *store.SystemSettings
		cfg, err = s.Settings.Get(ctx)
		if cfg != nil {
			enabled, proxyURL = cfg.CdnAccelerate, cfg.CdnProxyURL
		}
	}
	if err != nil {
		return nil, err
	}
	if !enabled {
		return nil, nil
	}
	if proxyURL == "" {
		proxyURL = defaultCDNProxy
	}
	return &cdnConfig{proxyURL: proxyURL}, nil
}

// ApplyCDNToURL 给 GitHub 域名加 CDN 前缀。
//
// 与 Node 的 applyCdnToUrl 逐条对齐：
//   - proxyURL 为空原样返回；
//   - 已带该前缀不重复加；
//   - 只处理四个 GitHub 域名，其它域名（含 CDN 自己的回源域名）不动；
//   - URL 解析失败原样返回。
func ApplyCDNToURL(rawURL, proxyURL string) string {
	if proxyURL == "" {
		return rawURL
	}
	prefix := strings.TrimRight(proxyURL, "/")
	if strings.HasPrefix(rawURL, prefix+"/") {
		return rawURL
	}
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return rawURL
	}
	switch parsed.Hostname() {
	case "api.github.com", "github.com", "objects.githubusercontent.com", "raw.githubusercontent.com":
		return prefix + "/" + rawURL
	}
	return rawURL
}

// GetUpdateInfo 查最新版本并给出是否有更新。
func (s *Service) GetUpdateInfo(ctx context.Context, includePrerelease bool) (*UpdateInfo, error) {
	currentVersion := LocalVersion(s.Root)
	assetName := PlatformAssetName(s.goos())

	// 检查更新不走 CDN（理由见下），但 settings 读失败时 Node 会整体失败——
	// 保留这个副作用，否则「设置表坏了」会被静默吞掉。
	if _, err := s.cdn(ctx); err != nil {
		return nil, err
	}

	// 更新源：默认 GitCode（大陆镜像），失败自动回退 GitHub。
	// 检查更新直连官方 API：gh-proxy 这类代理转发 api.github.com 时用
	// 代理方的 IP 出网，多用户共用极易触发 403 rate limit。CDN 只用于下载。
	releases, source, err := s.fetchReleases(ctx, s.updateSource())
	if err != nil {
		return nil, err
	}
	if len(releases) == 0 {
		return nil, errors.New("未找到任何发布版本")
	}

	release, hasUpdate := selectRelease(releases, currentVersion, includePrerelease)

	asset, ok := findAsset(release.Assets, assetName)
	if !ok {
		return nil, fmt.Errorf(
			"Release %s 中未找到平台对应的构建产物 %s", release.TagName, assetName)
	}

	info := &UpdateInfo{
		CurrentVersion: currentVersion,
		RemoteVersion:  release.TagName,
		HasUpdate:      hasUpdate,
		ReleaseURL:     release.HTMLURL,
		DownloadURL:    asset.BrowserDownloadURL,
		IsPrerelease:   release.Prerelease,
		AssetName:      asset.Name,
		AssetSize:      asset.Size,
		Source:         source,
	}
	if release.Body != nil {
		info.ReleaseNotes = *release.Body
	}
	if release.PublishedAt != nil {
		info.PublishedAt = *release.PublishedAt
	}
	return info, nil
}

// selectRelease 是版本判定本身（纯函数，便于逐个分支做单测）。
//
// 规则来自 Node 的 getUpdateInfo，注释里保留当初的取舍理由：
//
//   - includePrerelease：一律取列表第一条。GitHub 按 created_at 降序返回，
//     第一条就是最新一次构建（含 main 分支 CI 推的 latest 预发布）。
//     旧逻辑「优先正式版」会让 dev 构建永远更新到上一个正式版。
//   - 正式版模式：只在正式版之间更新；一个正式版都没有时拿第一条当信息源
//     但 hasUpdate=false（用户没开预发布，不该被引导装预发布）。
func selectRelease(releases []githubRelease, currentVersion string, includePrerelease bool) (*githubRelease, bool) {
	if includePrerelease {
		release := &releases[0]
		switch {
		case currentVersion == "0.0.0" || IsDevVersion(currentVersion):
			// 本地版本无法语义化比较，保守提示有更新。
			return release, true
		case release.Prerelease:
			// 本地是正式版、远端是 latest 预发布：用户开了预发布就是跟随最新构建。
			return release, true
		default:
			return release, CompareVersions(release.TagName, currentVersion) > 0
		}
	}

	var stable *githubRelease
	for i := range releases {
		if !releases[i].Prerelease {
			stable = &releases[i]
			break
		}
	}

	if currentVersion == "0.0.0" {
		if stable != nil {
			return stable, true
		}
		return &releases[0], true
	}
	if stable != nil {
		if IsDevVersion(currentVersion) {
			return stable, true
		}
		return stable, CompareVersions(stable.TagName, currentVersion) > 0
	}
	return &releases[0], false
}

func findAsset(assets []githubAsset, name string) (githubAsset, bool) {
	for _, asset := range assets {
		if asset.Name == name {
			return asset, true
		}
	}
	return githubAsset{}, false
}

// httpGetJSON 发 GET 并反序列化；3xx 手动逐跳跟随。
func (s *Service) httpGetJSON(ctx context.Context, target string, dst any) error {
	return s.httpGetJSONDepth(ctx, target, dst, 0)
}

func (s *Service) httpGetJSONDepth(ctx context.Context, target string, dst any, depth int) error {
	if depth > 5 {
		return fmt.Errorf("重定向次数过多: %s", target)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "ZViewer-Updater")
	req.Header.Set("Accept", "application/vnd.github+json")

	resp, err := s.apiClient.Do(req)
	if err != nil {
		if isTimeout(err) {
			return errors.New("请求超时")
		}
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 300 && resp.StatusCode < 400 {
		if loc := resp.Header.Get("Location"); loc != "" {
			return s.httpGetJSONDepth(ctx, loc, dst, depth+1)
		}
	}
	if resp.StatusCode >= 400 {
		return fmt.Errorf("HTTP %d: %s", resp.StatusCode, target)
	}

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(raw, dst); err != nil {
		return fmt.Errorf("解析响应失败: %v", err)
	}
	return nil
}

// DownloadFile 流式下载并逐块回调进度。
//
// CDN 模式失败**不回落直连**：用户开了加速就是在表达「直连不通」，
// 静默切直连会让人卡在没有反馈的等待里。失败信息里带上关闭 CDN 的引导。
func (s *Service) DownloadFile(
	ctx context.Context,
	target, dest string,
	onProgress func(received, total int64),
	cdn *cdnConfig,
) error {
	hint := ""
	if cdn != nil && cdn.proxyURL != "" {
		hint = "（CDN 加速节点不可用，可在更新设置中关闭 CDN 加速后重试）"
	}
	return s.downloadOnce(ctx, target, dest, onProgress, cdn, hint, 0)
}

func (s *Service) downloadOnce(
	ctx context.Context,
	target, dest string,
	onProgress func(received, total int64),
	cdn *cdnConfig,
	hint string,
	depth int,
) error {
	if depth > 5 {
		return fmt.Errorf("下载重定向次数过多%s", hint)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return err
	}
	resp, err := s.downloadClient.Do(req)
	if err != nil {
		if isTimeout(err) {
			return fmt.Errorf("下载超时%s", hint)
		}
		return fmt.Errorf("下载网络错误: %s%s", err.Error(), hint)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 300 && resp.StatusCode < 400 {
		loc := resp.Header.Get("Location")
		if loc == "" {
			return fmt.Errorf("下载失败 HTTP %d: %s%s", resp.StatusCode, target, hint)
		}
		if cdn != nil && cdn.proxyURL != "" {
			loc = ApplyCDNToURL(loc, cdn.proxyURL)
		}
		return s.downloadOnce(ctx, loc, dest, onProgress, cdn, hint, depth+1)
	}
	if resp.StatusCode >= 400 {
		return fmt.Errorf("下载失败 HTTP %d: %s%s", resp.StatusCode, target, hint)
	}

	total := int64(0)
	if raw := resp.Header.Get("Content-Length"); raw != "" {
		if n, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64); err == nil {
			total = n
		}
	}

	file, err := os.Create(dest)
	if err != nil {
		return err
	}

	// 空闲超时：每收到字节就重置计时器，语义等同 Node 的 socket timeout。
	idle := time.AfterFunc(downloadIdleTimeout, func() { _ = req.Cancel })
	defer idle.Stop()

	buf := make([]byte, 32*1024)
	var received int64
	for {
		n, readErr := resp.Body.Read(buf)
		if n > 0 {
			idle.Reset(downloadIdleTimeout)
			if _, err := file.Write(buf[:n]); err != nil {
				file.Close()
				return err
			}
			received += int64(n)
			if onProgress != nil {
				onProgress(received, total)
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			file.Close()
			if isTimeout(readErr) || ctx.Err() != nil {
				return fmt.Errorf("下载超时%s", hint)
			}
			return fmt.Errorf("下载网络错误: %s%s", readErr.Error(), hint)
		}
	}
	return file.Close()
}

// isTimeout 判断是否超时类错误。
func isTimeout(err error) bool {
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		return true
	}
	var netErr interface{ Timeout() bool }
	if errors.As(err, &netErr) {
		return netErr.Timeout()
	}
	return false
}

// inDocker 是容器探测的可注入入口。
func (s *Service) inDocker() bool {
	if s.dockerFn != nil {
		return s.dockerFn()
	}
	return IsDocker()
}

// IsDocker 检测是否跑在容器里。
//
// 容器内的「就地替换 + 退出」与裸机不同：容器文件系统随容器销毁，
// 必须靠 entrypoint 的监控循环在进程退出后重启后端。判定沿用 Node 的两条：
// /.dockerenv 存在，或 /proc/1/cgroup 里出现 docker/containerd/kubepods。
func IsDocker() bool {
	if _, err := os.Stat("/.dockerenv"); err == nil {
		return true
	}
	raw, err := os.ReadFile("/proc/1/cgroup")
	if err != nil {
		return false
	}
	content := string(raw)
	for _, marker := range []string{"docker", "containerd", "kubepods"} {
		if strings.Contains(content, marker) {
			return true
		}
	}
	return false
}

// logf 统一前缀，便于在 update.log 之外的服务日志里定位。
func logf(format string, args ...any) {
	log.Printf("[updater] "+format, args...)
}
