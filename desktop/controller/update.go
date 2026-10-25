package controller

// 软件更新：从 GitHub Release 取最新正式版，下载 GUI 运行包，再交给外部脚本在进程退出后替换文件。
// 关键约束：
//   1. 下载阶段不退出程序，界面可以继续使用；
//   2. 只有在包完整落盘并校验通过后，才允许执行安装；
//   3. 安装必须由独立进程完成，否则无法覆盖正在运行的 EXE。

import (
	"archive/zip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// updateRepo 是发布来源，与 CI 中的仓库保持一致。
const updateRepo = "Zero-wyc/ZViewer"

// DefaultUpdateProxy 是默认的前缀式反代；GitHub 附件直连较慢时用它取同一份文件。
const DefaultUpdateProxy = "https://gh-proxy.com"

// 更新源标识：与网页端 updater.SourceGitHub / SourceGitCode 保持同名。
const (
	updateSourceGitHub  = "github"
	updateSourceGitCode = "gitcode"
)

// gitCodeAPIBase 是 GitCode OpenAPI 基址；gitCodeSite 用来拼发布页地址
// （GitCode 的 release 列表不带 html_url）。附件直链与官方镜像同源，无需反代。
const (
	gitCodeAPIBase = "https://api.gitcode.com/api/v5"
	gitCodeSite    = "https://gitcode.com"
)

var (
	errNoRelease = errors.New("没有可用的正式版本")
	// 发布页里同时有命令行的 zviewer-windows-x64.zip，只认带 -GUI 后缀的运行包。
	updateAssetExp = regexp.MustCompile(`(?i)^zviewer-windows-[^/]*-gui\.zip$`)
	updateHostExp  = regexp.MustCompile(`(?i)^(github\.com|api\.github\.com|objects\.githubusercontent\.com|release-assets\.githubusercontent\.com|gitcode\.com|raw\.gitcode\.com)$`)
	updateTagExp   = regexp.MustCompile(`^v?\d+`)
)

// NormalizeUpdateProxy 校验前缀式反代：只接受 https 地址，去掉末尾斜杠；空串表示不走反代。
func NormalizeUpdateProxy(raw string) (string, error) {
	text := strings.TrimSpace(raw)
	if text == "" {
		return "", nil
	}
	parsed, err := url.Parse(text)
	if err != nil || !strings.EqualFold(parsed.Scheme, "https") || parsed.Host == "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", errors.New("更新反代需为 https:// 开头的前缀地址，例如 https://gh-proxy.com")
	}
	return strings.TrimRight(text, "/"), nil
}

// proxyURL 把目标地址直接接在前缀之后，这是 gh-proxy 一类服务约定的用法。
func proxyURL(prefix, target string) string {
	if prefix == "" || target == "" {
		return target
	}
	return strings.TrimRight(prefix, "/") + "/" + target
}

// UpdateReport 是更新状态，直接进 Snapshot 供界面渲染。
type UpdateReport struct {
	Current   string `json:"current"`
	Latest    string `json:"latest"`
	State     string `json:"state"` // idle | checking | latest | available | downloading | ready | error
	Available bool   `json:"available"`
	Progress  int    `json:"progress"`
	Size      int64  `json:"size"`
	Asset     string `json:"asset"`
	PageURL   string `json:"pageUrl"`
	Notes     string `json:"notes"`
	CheckedAt string `json:"checkedAt"`
	Error     string `json:"error"`
	AutoCheck bool   `json:"autoCheck"`
	Proxy     bool   `json:"proxy"`
	ProxyURL  string `json:"proxyUrl"`
	// Source 是本次结果的实际来源：gitcode（默认，大陆镜像）或 github。
	// GitCode 不可用时会自动回退 GitHub，界面据此显示从哪个站取的版本。
	Source string `json:"source"`
	Path   string `json:"-"`
}

type releaseAsset struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
	Size int64  `json:"size"`
	URL  string `json:"browser_download_url"`
	// Type 是 GitCode 独有字段：attach（上传附件）/ source（源码包）。
	Type string `json:"type"`
}

type releaseInfo struct {
	Tag        string         `json:"tag_name"`
	Name       string         `json:"name"`
	URL        string         `json:"html_url"`
	Prerelease bool           `json:"prerelease"`
	Draft      bool           `json:"draft"`
	Assets     []releaseAsset `json:"assets"`
	// ReleaseStatus 是 GitCode 独有字段：pre / latest。
	ReleaseStatus string `json:"release_status"`
}

// updateUseGitCode 读取更新源开关；未初始化配置时按默认（GitCode）处理。
func (c *Controller) updateUseGitCode() bool {
	if c.store == nil {
		return true
	}
	return c.store.Value.UpdateGitCode
}

// autoCheckEnabled 读取自动检查开关；未初始化配置时按开启处理。
func (c *Controller) autoCheckEnabled() bool {
	if c.store == nil {
		return true
	}
	return c.store.Value.AutoCheckUpdate
}

// updateProxyPrefix 返回当前生效的前缀反代；关闭或配置非法时返回空串（直连）。
func (c *Controller) updateProxyPrefix() string {
	if c.store == nil || !c.store.Value.UpdateProxy {
		return ""
	}
	prefix, err := NormalizeUpdateProxy(c.store.Value.UpdateProxyURL)
	if err != nil {
		return ""
	}
	return prefix
}

// UpdateReport 返回当前更新状态。
func (c *Controller) UpdateReport() UpdateReport {
	c.updateMu.Lock()
	defer c.updateMu.Unlock()
	if c.autoCheckEnabled() != c.update.AutoCheck {
		c.update.AutoCheck = c.autoCheckEnabled()
	}
	return c.update
}

// CheckUpdate 查询 GitHub 最新正式版；force 为 false 时复用 30 分钟内的结果。
func (c *Controller) CheckUpdate(force bool) UpdateReport {
	c.updateMu.Lock()
	if c.updateBusy || c.update.State == "downloading" {
		report := c.update
		c.updateMu.Unlock()
		return report
	}
	if !force && !c.updateAt.IsZero() && time.Since(c.updateAt) < 30*time.Minute && c.update.State != "idle" {
		report := c.update
		c.updateMu.Unlock()
		return report
	}
	c.updateBusy = true
	c.update.Current = c.version
	c.update.State = "checking"
	c.update.Error = ""
	c.updateMu.Unlock()
	c.emit()

	prefix := c.updateProxyPrefix()
	info, source, err := c.fetchRelease(prefix)
	usedProxy := prefix
	if err != nil && prefix != "" && source == updateSourceGitHub {
		// 反代不可用时回退直连，避免一个失效的前缀把检查更新整体卡死。
		usedProxy = ""
		info, err = fetchLatestReleaseFromGitHub(c.version, "")
	}
	c.updateMu.Lock()
	c.updateBusy = false
	c.updateAt = time.Now()
	c.update.CheckedAt = time.Now().Format("2006-01-02 15:04")
	c.update.AutoCheck = c.autoCheckEnabled()
	switch {
	case errors.Is(err, errNoRelease):
		c.update.State, c.update.Available, c.update.Latest = "latest", false, ""
		c.update.Error = ""
		c.update.Source = source
	case err != nil:
		c.update.State, c.update.Available = "error", false
		c.update.Error = err.Error()
		c.update.Proxy, c.update.ProxyURL = false, ""
		c.update.Source = ""
	default:
		c.update.Source = source
		c.update.Proxy, c.update.ProxyURL = source == updateSourceGitHub && usedProxy != "", usedProxy
		c.update.Latest = strings.TrimPrefix(strings.TrimSpace(info.Tag), "v")
		c.update.PageURL = info.URL
		c.update.Notes = strings.TrimSpace(info.Name)
		c.update.Available = compareVersions(c.update.Latest, c.version) > 0
		if !c.update.Available {
			c.update.State, c.update.Error = "latest", ""
			break
		}
		asset, ok := pickUpdateAsset(info.Assets)
		if !ok {
			c.update.State, c.update.Available = "error", false
			c.update.Error = "最新版本没有附带 Windows 运行包"
			break
		}
		c.update.State = "available"
		c.update.Asset = asset.Name
		c.update.Size = asset.Size
		candidateProxy := usedProxy
		if source != updateSourceGitHub {
			// GitCode 直连对象存储，套反代前缀没有意义
			candidateProxy = ""
		}
		c.updateURL, c.updateFallbackURL = downloadCandidates(asset, candidateProxy, source)
		c.update.Progress = 0
	}
	report := c.update
	c.updateMu.Unlock()
	c.emit()
	return report
}

// StartUpdateDownload 在后台下载安装包；下载期间界面保持可用。
func (c *Controller) StartUpdateDownload() (UpdateReport, error) {
	report := c.UpdateReport()
	if report.State != "available" && report.State != "ready" {
		report = c.CheckUpdate(true)
	}
	if !report.Available {
		return report, errors.New("当前没有可下载的新版本")
	}
	if report.State == "ready" {
		return report, nil
	}
	c.updateMu.Lock()
	if c.updateBusy || c.update.State == "downloading" {
		report = c.update
		c.updateMu.Unlock()
		return report, nil
	}
	if c.updateURL == "" {
		c.updateMu.Unlock()
		return report, errors.New("缺少下载地址，请重新检查更新")
	}
	target := c.packagePath(c.update.Latest, c.update.Asset)
	c.updateBusy = true
	c.update.State = "downloading"
	c.update.Progress = 0
	c.update.Error = ""
	c.update.Path = target
	link, fallback, size := c.updateURL, c.updateFallbackURL, c.update.Size
	report = c.update
	c.updateMu.Unlock()
	c.emit()

	go c.downloadUpdate(link, fallback, target, size)
	return report, nil
}

// downloadUpdate 流式下载并校验，成功后才把状态推进到 ready。
// 首选地址失败（例如反代不可用）时用回退地址再试一次，两次都失败才算失败。
func (c *Controller) downloadUpdate(link, fallback, target string, size int64) {
	progress := func(done, total int64) {
		value := 0
		if total > 0 {
			value = int(done * 100 / total)
			if value > 99 && done < total {
				value = 99
			}
		}
		c.updateMu.Lock()
		c.update.Progress = value
		c.updateMu.Unlock()
		c.emit()
	}
	allow := []string{proxyHost(link), proxyHost(fallback)}
	err := downloadFile(link, target, size, allow, progress)
	if err != nil && fallback != "" && fallback != link {
		c.Log("首选下载地址失败，改用回退地址："+err.Error(), "update", "WARN")
		err = downloadFile(fallback, target, size, allow, progress)
	}
	if err == nil {
		err = verifyUpdatePackage(target)
	}
	c.updateMu.Lock()
	c.updateBusy = false
	if err == nil {
		c.update.State, c.update.Progress = "ready", 100
	} else {
		c.update.State = "error"
		c.update.Error = "下载失败：" + err.Error()
		_ = os.Remove(target)
	}
	c.updateMu.Unlock()
	if err == nil {
		c.Log("更新包已下载完成，等待重启安装", "update", "INFO")
	} else {
		c.Log(c.UpdateReport().Error, "update", "ERROR")
	}
	c.emit()
}

// PrepareUpdate 写好安装脚本：等待本进程退出，解压覆盖运行目录，再启动新版本。
// 脚本放在更新目录，避免安装过程中被自身覆盖。
func (c *Controller) PrepareUpdate(targetDir, exePath string, pid int) (string, error) {
	c.updateMu.Lock()
	ready := c.update.State == "ready"
	pkg := c.update.Path
	c.updateMu.Unlock()
	if !ready || pkg == "" || !fileExists(pkg) {
		return "", errors.New("更新包尚未下载完成")
	}
	if !fileExists(exePath) {
		return "", errors.New("找不到当前程序入口，无法自动更新")
	}
	dir := filepath.Dir(pkg)
	script := filepath.Join(dir, "apply-update.ps1")
	body := applyScript(pkg, targetDir, exePath, pid)
	if err := os.WriteFile(script, []byte(body), 0o600); err != nil {
		return "", fmt.Errorf("无法写入更新脚本：%w", err)
	}
	return script, nil
}

// applyScript 生成 PowerShell 安装脚本。路径统一用单引号包裹并转义，避免空格与中文目录出问题。
func applyScript(pkg, target, exe string, pid int) string {
	quote := func(text string) string { return "'" + strings.ReplaceAll(text, "'", "''") + "'" }
	stage := quote(filepath.Join(filepath.Dir(pkg), "staging"))
	return strings.Join([]string{
		"$ErrorActionPreference = 'Stop'",
		"$zip = " + quote(pkg),
		"$target = " + quote(target),
		"$exe = " + quote(exe),
		"$stage = " + stage,
		"$log = " + quote(filepath.Join(filepath.Dir(pkg), "apply.log")),
		fmt.Sprintf("$procId = %d", pid),
		"function Write-Log($text) { \"{0} {1}\" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $text | Out-File -FilePath $log -Append -Encoding utf8 }",
		"try {",
		"  Write-Log \"waiting for process $procId\"",
		"  $deadline = (Get-Date).AddSeconds(120)",
		"  while ((Get-Date) -lt $deadline) {",
		"    if (-not (Get-Process -Id $procId -ErrorAction SilentlyContinue)) { break }",
		"    Start-Sleep -Milliseconds 400",
		"  }",
		"  Start-Sleep -Milliseconds 1200",
		"  if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }",
		"  Expand-Archive -Path $zip -DestinationPath $stage -Force",
		"  $src = Get-ChildItem -Path $stage -Directory | Select-Object -First 1",
		"  if (-not $src) { throw 'install package has no top directory' }",
		"  Copy-Item -Path (Join-Path $src.FullName '*') -Destination $target -Recurse -Force",
		"  Write-Log 'files replaced'",
		// 入口名以解压出来的包为准（新包可能是改名后的 EXE），取不到时回到当前程序。
		// 注意 -Path 必须传 $src.FullName：直接传 DirectoryInfo 会被当成相对名字解析。
		"  $installed = Get-ChildItem -Path $src.FullName -Filter '*.exe' -File | Select-Object -First 1",
		"  $next = if ($installed) { Join-Path $target $installed.Name } else { $exe }",
		"  Write-Log ('entry: ' + $next)",
		// 改名后旧入口会留在根目录，两个 EXE 并存会导致更新后仍启动旧版本。
		"  Get-ChildItem -Path $target -Filter '*.exe' -File | Where-Object { $_.FullName -ne $next } | ForEach-Object { Write-Log ('remove stale entry: ' + $_.Name); Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue }",
		"  Start-Process -FilePath $next -WorkingDirectory $target",
		"  Write-Log 'restarted'",
		"  Start-Sleep -Seconds 3",
		"  Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue",
		"  Remove-Item $zip -Force -ErrorAction SilentlyContinue",
		"} catch {",
		"  Write-Log ('failed: ' + $_.Exception.Message)",
		"} finally {",
		"  Remove-Item $PSCommandPath -Force -ErrorAction SilentlyContinue",
		"}",
	}, "\r\n")
}

func (c *Controller) packagePath(tag, asset string) string {
	name := asset
	if name == "" {
		name = "zviewer-windows-x64-GUI.zip"
	}
	return filepath.Join(c.dir, "updates", tag, filepath.Base(name))
}

// fetchRelease 按设置取最新正式版：选了 GitCode 就只走 GitCode。
//
// **不做静默回退**：用户选大陆镜像就是为了不碰 GitHub，悄悄换源会让人以为
// 镜像可用、实际却在境外取包。失败就把错误显式抛到界面上，换不换由用户决定。
func (c *Controller) fetchRelease(prefix string) (releaseInfo, string, error) {
	if c.updateUseGitCode() {
		info, err := fetchLatestReleaseFromGitCode(c.version)
		if err != nil {
			c.Log("GitCode 更新源不可用："+err.Error(), "update", "ERROR")
			return releaseInfo{}, updateSourceGitCode,
				fmt.Errorf("GitCode 更新源不可用：%s（可在更新设置中关闭「使用 GitCode 更新源」）", err.Error())
		}
		return info, updateSourceGitCode, nil
	}
	info, err := fetchLatestReleaseFromGitHub(c.version, prefix)
	return info, updateSourceGitHub, err
}

// fetchLatestReleaseFromGitCode 从 GitCode 镜像取最新正式版。
//
// GitCode 没有 GitHub 那种 /releases/latest（只有列表接口），所以取列表后
// 自己挑第一条「非预发布且 tag 像版本号」的记录；源码包资产在 normalize 里剔掉。
func fetchLatestReleaseFromGitCode(current string) (releaseInfo, error) {
	client := &http.Client{Timeout: 15 * time.Second}
	endpoint := gitCodeAPIBase + "/repos/" + updateRepo + "/releases?per_page=10"
	request, err := http.NewRequestWithContext(context.Background(), http.MethodGet, endpoint, nil)
	if err != nil {
		return releaseInfo{}, err
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("User-Agent", "ZViewerDesktop/"+current)
	response, err := client.Do(request)
	if err != nil {
		return releaseInfo{}, errors.New("无法连接 GitCode：" + err.Error())
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound {
		return releaseInfo{}, errNoRelease
	}
	if response.StatusCode != http.StatusOK {
		return releaseInfo{}, fmt.Errorf("GitCode 返回 %d", response.StatusCode)
	}
	var list []releaseInfo
	if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&list); err != nil {
		return releaseInfo{}, errors.New("发布信息解析失败")
	}
	if len(list) == 0 {
		// 与「只有预发布」区分：一条记录都没有说明镜像还没同步过 Release，
		// 不是「已是最新」，必须让用户看到错误。
		return releaseInfo{}, errors.New("镜像暂无发布版本")
	}
	return pickGitCodeRelease(list)
}

// pickGitCodeRelease 从列表里挑最新正式版：跳过预发布与不像版本号的 tag。
func pickGitCodeRelease(list []releaseInfo) (releaseInfo, error) {
	for _, info := range list {
		if info.Draft || info.Prerelease || strings.EqualFold(info.ReleaseStatus, "pre") {
			continue
		}
		if !updateTagExp.MatchString(info.Tag) {
			continue
		}
		return normalizeGitCodeRelease(info), nil
	}
	return releaseInfo{}, errNoRelease
}

// normalizeGitCodeRelease 补齐 GitCode 与 GitHub 的字段差异：
// 没有 html_url 时按站内路由拼发布页地址；assets 里混着的源码包（type=source）剔掉。
func normalizeGitCodeRelease(info releaseInfo) releaseInfo {
	if info.URL == "" && info.Tag != "" {
		info.URL = gitCodeSite + "/" + updateRepo + "/releases/tag/" + url.PathEscape(info.Tag)
	}
	if len(info.Assets) == 0 {
		return info
	}
	assets := make([]releaseAsset, 0, len(info.Assets))
	for _, asset := range info.Assets {
		if asset.Type == "source" {
			continue
		}
		assets = append(assets, asset)
	}
	info.Assets = assets
	return info
}

// fetchLatestReleaseFromGitHub 取 GitHub 最新正式版；仓库只有预发布时会返回 errNoRelease。
// prefix 非空时把请求经前缀反代转发，例如 https://gh-proxy.com/https://api.github.com/...。
func fetchLatestReleaseFromGitHub(current, prefix string) (releaseInfo, error) {
	client := &http.Client{Timeout: 15 * time.Second}
	endpoint := proxyURL(prefix, "https://api.github.com/repos/"+updateRepo+"/releases/latest")
	request, err := http.NewRequestWithContext(context.Background(), http.MethodGet, endpoint, nil)
	if err != nil {
		return releaseInfo{}, err
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("User-Agent", "ZViewerDesktop/"+current)
	response, err := client.Do(request)
	if err != nil {
		return releaseInfo{}, errors.New("无法连接 GitHub：" + err.Error())
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound {
		return releaseInfo{}, errNoRelease
	}
	if response.StatusCode != http.StatusOK {
		return releaseInfo{}, fmt.Errorf("GitHub 返回 %d", response.StatusCode)
	}
	var info releaseInfo
	if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&info); err != nil {
		return releaseInfo{}, errors.New("发布信息解析失败")
	}
	if info.Draft || info.Prerelease {
		return releaseInfo{}, errNoRelease
	}
	if !updateTagExp.MatchString(info.Tag) {
		return releaseInfo{}, errors.New("发布版本号无法识别")
	}
	return info, nil
}

// pickUpdateAsset 只认 GUI 运行包，避免误取后端压缩包。
func pickUpdateAsset(assets []releaseAsset) (releaseAsset, bool) {
	for _, asset := range assets {
		if updateAssetExp.MatchString(asset.Name) {
			return asset, true
		}
	}
	return releaseAsset{}, false
}

// assetDownloadURL 走 API 资产端点：它不经过发布页的跳转，能直接拿到字节流。
func assetDownloadURL(asset releaseAsset) string {
	if asset.ID > 0 {
		return fmt.Sprintf("https://api.github.com/repos/%s/releases/assets/%d", updateRepo, asset.ID)
	}
	return asset.URL
}

// downloadCandidates 返回首选与回退地址。
// 走反代时首选是 github.com 直链套前缀（反代只代理 github.com 一类地址），回退是 API 端点；
// 不走反代时首选 API 端点，没有回退。
// GitCode 源的附件 id 是 GitCode 自己的编号，不能套 GitHub 的资产端点，只能直连。
func downloadCandidates(asset releaseAsset, prefix, source string) (string, string) {
	if source == updateSourceGitCode {
		return asset.URL, ""
	}
	direct := assetDownloadURL(asset)
	if prefix == "" {
		return direct, ""
	}
	return proxyURL(prefix, asset.URL), direct
}

// proxyHost 取出地址的 host，用于下载白名单；解析失败时返回空串。
func proxyHost(link string) string {
	parsed, err := url.Parse(link)
	if err != nil {
		return ""
	}
	return parsed.Hostname()
}

// allowedUpdateHost 允许 GitHub 官方域与当前配置的反代域。
func allowedUpdateHost(host string, extra []string) bool {
	if updateHostExp.MatchString(host) {
		return true
	}
	for _, item := range extra {
		if item != "" && strings.EqualFold(item, host) {
			return true
		}
	}
	return false
}

// publicHost 判断是否公网域名或公网 IP，用于放行反代自身的 CDN 跳转，同时挡住内网地址。
func publicHost(host string) bool {
	if host == "" || strings.EqualFold(host, "localhost") {
		return false
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return true
	}
	return !(ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsUnspecified() || ip.IsMulticast())
}

// downloadFile 写入临时文件，完成后原子改名；回调用于进度。
// allow 是额外放行的域名（当前反代），实际来源仍必须是 GitHub 官方域或该反代域。
func downloadFile(link, target string, size int64, allow []string, onProgress func(done, total int64)) error {
	parsed, err := url.Parse(link)
	if err != nil || !strings.EqualFold(parsed.Scheme, "https") || !allowedUpdateHost(parsed.Hostname(), allow) {
		return errors.New("下载地址不在允许的来源内")
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return err
	}
	client := &http.Client{Timeout: 30 * time.Minute}
	request, err := http.NewRequestWithContext(context.Background(), http.MethodGet, link, nil)
	if err != nil {
		return err
	}
	request.Header.Set("Accept", "application/octet-stream")
	request.Header.Set("User-Agent", "ZViewerDesktop")
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("下载地址返回 %d", response.StatusCode)
	}
	// 跟随重定向后仍要确认最终来源：GitHub 会转到对象存储，反代可能转到自己的 CDN。
	if final := response.Request.URL; final == nil || !strings.EqualFold(final.Scheme, "https") ||
		(!allowedUpdateHost(final.Hostname(), allow) && !publicHost(final.Hostname())) {
		return errors.New("下载被重定向到未知来源")
	}
	total := response.ContentLength
	if total <= 0 {
		total = size
	}
	if total > 650<<20 {
		return errors.New("安装包超出预期大小")
	}
	part := target + ".part"
	file, err := os.OpenFile(part, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	writer := &progressWriter{dst: file, total: total, report: onProgress}
	written, copyErr := io.Copy(writer, io.LimitReader(response.Body, 650<<20))
	closeErr := file.Close()
	if copyErr != nil {
		_ = os.Remove(part)
		return copyErr
	}
	if closeErr != nil {
		_ = os.Remove(part)
		return closeErr
	}
	if size > 0 && written != size {
		_ = os.Remove(part)
		return fmt.Errorf("安装包大小不符（%d/%d 字节）", written, size)
	}
	if err := os.Rename(part, target); err != nil {
		_ = os.Remove(part)
		return err
	}
	return nil
}

// shellEntryNames 是安装包里认可的入口文件名（小写比较）：
// 第一个是现名，第二个兼容改名前的历史包。
var shellEntryNames = []string{"zviewerdesktop.exe", "zviewershell.exe"}

func isShellEntry(name string) bool {
	lower := strings.ToLower(name)
	for _, allowed := range shellEntryNames {
		if strings.HasSuffix(lower, allowed) {
			return true
		}
	}
	return false
}

// verifyUpdatePackage 只做结构校验：能打开、有内容、包含入口文件。
func verifyUpdatePackage(path string) error {
	reader, err := zip.OpenReader(path)
	if err != nil {
		return errors.New("安装包不是有效的 ZIP")
	}
	defer reader.Close()
	found := false
	for _, entry := range reader.File {
		if isShellEntry(entry.Name) {
			found = true
			break
		}
	}
	if !found || len(reader.File) == 0 {
		return errors.New("安装包里没有 ZViewerDesktop.exe")
	}
	return nil
}

type progressWriter struct {
	dst     io.Writer
	total   int64
	done    int64
	last    time.Time
	report  func(done, total int64)
	emitted bool
}

func (w *progressWriter) Write(p []byte) (int, error) {
	n, err := w.dst.Write(p)
	w.done += int64(n)
	if w.report != nil && (time.Since(w.last) > 300*time.Millisecond || !w.emitted) {
		w.last, w.emitted = time.Now(), true
		w.report(w.done, w.total)
	}
	return n, err
}

// compareVersions 比较语义化版本：a 大于 b 返回 1，相等 0，小于 -1。
func compareVersions(a, b string) int {
	left, right := versionParts(a), versionParts(b)
	for index := 0; index < len(left) || index < len(right); index++ {
		var x, y int
		if index < len(left) {
			x = left[index]
		}
		if index < len(right) {
			y = right[index]
		}
		if x != y {
			if x > y {
				return 1
			}
			return -1
		}
	}
	return 0
}

// versionParts 拆出数字段；"0.4.1-beta" 与 "0.4.1" 等同，预发布由 Release 的 prerelease 标记排除。
func versionParts(text string) []int {
	text = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(text), "v"))
	if index := strings.IndexAny(text, "-+"); index >= 0 {
		text = text[:index]
	}
	if text == "" {
		return nil
	}
	segments := strings.Split(text, ".")
	parts := make([]int, 0, len(segments))
	for _, segment := range segments {
		digits := segment
		if index := strings.IndexFunc(segment, func(r rune) bool { return r < '0' || r > '9' }); index >= 0 {
			digits = segment[:index]
		}
		value, err := strconv.Atoi(digits)
		if err != nil {
			value = 0
		}
		parts = append(parts, value)
	}
	return parts
}
