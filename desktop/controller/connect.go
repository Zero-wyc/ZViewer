package controller

// 连接方式：公网 IPv6 探测与 Cloudflare Tunnel 快速隧道。
// IPv6 一律经外部接口取得（不读本机网卡），接口只解析 AAAA，
// 请求成功即说明本机确实具备 IPv6 出口；返回值再做公网地址校验。

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptrace"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// IPv6Report 是一次公网 IPv6 探测的结果。
type IPv6Report struct {
	OK        bool   `json:"ok"`
	Address   string `json:"address"`
	Source    string `json:"source"`
	CheckedAt string `json:"checkedAt"`
	Reason    string `json:"reason"`
}

// TunnelReport 是 cloudflared 快速隧道的状态。
type TunnelReport struct {
	Available    bool   `json:"available"`
	State        string `json:"state"`
	URL          string `json:"url"`
	Health       string `json:"health"`
	LatencyMs    int64  `json:"latencyMs"`
	RefreshCount int    `json:"refreshCount"`
	MaxRefreshes int    `json:"maxRefreshes"`
	Protocol     string `json:"protocol"`
	Message      string `json:"message"`
	ErrorCode    string `json:"errorCode,omitempty"`
}

// ipv6Sources 均只有 AAAA 记录；按国内可达性排序。
var ipv6Sources = []struct {
	Name string
	URL  string
}{
	{Name: "v6.ident.me", URL: "https://v6.ident.me/"},
	{Name: "ipv6.icanhazip.com", URL: "https://ipv6.icanhazip.com/"},
	{Name: "api6.ipify.org", URL: "https://api6.ipify.org?format=json"},
}

// ipv6Client 强制以 tcp6 拨号：域名无 A 记录，拨不通就代表没有 IPv6 出口。
func ipv6Client() *http.Client {
	dialer := &net.Dialer{Timeout: 3 * time.Second}
	return &http.Client{
		Timeout: 4 * time.Second,
		Transport: &http.Transport{
			DisableKeepAlives: true,
			DialContext: func(ctx context.Context, _, address string) (net.Conn, error) {
				return dialer.DialContext(ctx, "tcp6", address)
			},
		},
	}
}

func readIPv6Body(body []byte) string {
	var payload struct {
		IP string `json:"ip"`
	}
	if json.Unmarshal(body, &payload) == nil && payload.IP != "" {
		return payload.IP
	}
	return strings.TrimSpace(string(body))
}

// publicIPv6 只接受可在公网路由的单播地址。
func publicIPv6(text string) (string, bool) {
	ip := net.ParseIP(strings.TrimSpace(text))
	if ip == nil || ip.To4() != nil {
		return "", false
	}
	if !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsMulticast() {
		return "", false
	}
	lower := strings.ToLower(ip.String())
	// 2001:db8::/32 是文档地址，fec0::/10 是已废弃的站点本地地址。
	if strings.HasPrefix(lower, "2001:db8:") || strings.HasPrefix(lower, "fec0:") {
		return "", false
	}
	return ip.String(), true
}

// ProbeIPv6 查询本机公网 IPv6；一分钟内复用上次结果，force 时重新探测。
// 整体限时 6 秒，避免一处接口无响应拖住界面。
func (c *Controller) ProbeIPv6(force bool) IPv6Report {
	c.ipv6Mu.Lock()
	defer c.ipv6Mu.Unlock()
	if !force && c.ipv6 != nil && time.Since(c.ipv6At) < time.Minute {
		return *c.ipv6
	}
	report := IPv6Report{CheckedAt: time.Now().Format("15:04:05")}
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()
	client := ipv6Client()
	for _, source := range ipv6Sources {
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, source.URL, nil)
		if err != nil {
			continue
		}
		response, err := client.Do(request)
		if err != nil {
			if ctx.Err() != nil {
				break
			}
			continue
		}
		body, readErr := io.ReadAll(io.LimitReader(response.Body, 1024))
		response.Body.Close()
		if readErr != nil || response.StatusCode != http.StatusOK {
			continue
		}
		if address, ok := publicIPv6(readIPv6Body(body)); ok {
			report.OK, report.Address, report.Source = true, address, source.Name
			c.ipv6, c.ipv6At = &report, time.Now()
			return report
		}
	}
	report.Reason = "没有探测到公网 IPv6 出口：本机未能通过 IPv6 访问外部检测接口。"
	c.ipv6, c.ipv6At = &report, time.Now()
	return report
}

var tunnelPattern = regexp.MustCompile(`https://[a-z0-9][a-z0-9-]*\.trycloudflare\.com`)

// cloudflared 优先取运行包目录（用户新放入的文件立即生效），其次取 PATH。
func (c *Controller) cloudflared() string {
	candidate := filepath.Join(c.root, "cloudflared.exe")
	if c.root != "" && fileExists(candidate) {
		c.mu.Lock()
		c.tunnelExe = candidate
		c.mu.Unlock()
		return candidate
	}
	c.mu.RLock()
	cached := c.tunnelExe
	c.mu.RUnlock()
	if cached != "" && cached != candidate && fileExists(cached) {
		return cached
	}
	found, err := exec.LookPath("cloudflared")
	if err != nil {
		return ""
	}
	c.mu.Lock()
	c.tunnelExe = found
	c.mu.Unlock()
	return found
}

const cloudflaredReleaseAPI = "https://api.github.com/repos/cloudflare/cloudflared/releases/latest"
const cloudflaredDownloadURL = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"

const (
	cloudflaredSourceProxy  = "proxy"
	cloudflaredSourceGitHub = "github"
)

func cloudflaredSourceName(source string) string {
	if source == cloudflaredSourceGitHub {
		return "GitHub 官方"
	}
	return "GitHub 前置反代"
}

func cloudflaredSourceURL(source, target string) string {
	if source == cloudflaredSourceGitHub {
		return target
	}
	return proxyURL(DefaultUpdateProxy, target)
}

// 组件下载只接受固定来源与其 HTTPS 附件主机，不允许被反代重定向到任意站点。
func validCloudflaredDownloadURL(raw string) bool {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" || parsed.User != nil || (parsed.Port() != "" && parsed.Port() != "443") {
		return false
	}
	host := strings.ToLower(parsed.Hostname())
	proxy, _ := url.Parse(DefaultUpdateProxy)
	return host == proxy.Hostname() || host == "github.com" || strings.HasSuffix(host, ".githubusercontent.com")
}

var cloudflaredVersionPattern = regexp.MustCompile(`(?i)(\d{4})\.(\d+)\.(\d+)`)
var cloudflaredChecksumPattern = regexp.MustCompile(`(?m)^\s*\x60?cloudflared-windows-amd64\.exe:\s*([0-9a-fA-F]{64})\x60?\s*$`)

func checksumForRelease(body string) string {
	if match := cloudflaredChecksumPattern.FindStringSubmatch(body); len(match) == 2 {
		return strings.ToLower(match[1])
	}
	return ""
}

type cloudflaredRelease struct {
	TagName string `json:"tag_name"`
	Body    string `json:"body"`
}

func latestCloudflaredRelease(parent context.Context, source string) (cloudflaredRelease, string, error) {
	ctx, cancel := context.WithTimeout(parent, 6*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, cloudflaredSourceURL(source, cloudflaredReleaseAPI), nil)
	if err != nil {
		return cloudflaredRelease{}, "", err
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	request.Header.Set("User-Agent", "ZViewerDesktop")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return cloudflaredRelease{}, "", err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return cloudflaredRelease{}, "", fmt.Errorf("GitHub Release API 返回 HTTP %d", response.StatusCode)
	}
	var release cloudflaredRelease
	if err := json.NewDecoder(io.LimitReader(response.Body, 2<<20)).Decode(&release); err != nil {
		return cloudflaredRelease{}, "", fmt.Errorf("读取 GitHub Release 信息失败：%w", err)
	}
	match := cloudflaredVersionPattern.FindStringSubmatch(release.TagName)
	if len(match) != 4 || match[0] != strings.TrimPrefix(release.TagName, "v") {
		return cloudflaredRelease{}, "", fmt.Errorf("Cloudflare Release 版本号无效：%q", release.TagName)
	}
	return release, match[0], nil
}

func installedCloudflaredVersion(parent context.Context, exe string) string {
	ctx, cancel := context.WithTimeout(parent, 3*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, exe, "--version")
	hideWindow(cmd)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return ""
	}
	match := cloudflaredVersionPattern.FindStringSubmatch(string(output))
	if len(match) != 4 {
		return ""
	}
	return match[0]
}

func cloudflaredVersionIsOlder(installed, latest string) bool {
	installedParts := cloudflaredVersionPattern.FindStringSubmatch(installed)
	latestParts := cloudflaredVersionPattern.FindStringSubmatch(latest)
	if len(installedParts) != 4 || len(latestParts) != 4 {
		return true
	}
	for index := 1; index <= 3; index++ {
		current, _ := strconv.Atoi(installedParts[index])
		newest, _ := strconv.Atoi(latestParts[index])
		if current != newest {
			return current < newest
		}
	}
	return false
}

// downloadCloudflared 获取 Cloudflare 官方 Windows x64 单文件，先落到同目录临时文件，
// 确认是合理大小的 PE 文件后再原子改名，避免断线留下损坏的 cloudflared.exe。
func (c *Controller) downloadCloudflared(parent context.Context, downloadURL, expectedSHA256 string, replaceExisting bool) (string, error) {
	if c.root == "" {
		return "", errors.New("无法确定运行包目录，不能保存 cloudflared.exe")
	}
	if err := os.MkdirAll(c.root, 0o755); err != nil {
		return "", fmt.Errorf("无法创建运行包目录：%w", err)
	}
	target := filepath.Join(c.root, "cloudflared.exe")
	if fileExists(target) && !replaceExisting {
		return target, nil
	}
	ctx, watchdog := newCloudflaredDownloadWatchdog(parent)
	defer watchdog.cancel(nil)
	defer watchdog.stop()
	ctx = httptrace.WithClientTrace(ctx, &httptrace.ClientTrace{GotFirstResponseByte: watchdog.activity})
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, downloadURL, nil)
	if err != nil {
		return "", err
	}
	if !validCloudflaredDownloadURL(downloadURL) {
		return "", errors.New("cloudflared 下载地址不在允许的 HTTPS 来源中")
	}
	transport := http.DefaultTransport
	if base, ok := transport.(*http.Transport); ok {
		// The watchdog covers dialing, TLS, headers and the body. Shorter
		// transport timeouts must not abort a download before its idle limit.
		clone := base.Clone()
		clone.DialContext = (&net.Dialer{KeepAlive: 30 * time.Second}).DialContext
		clone.TLSHandshakeTimeout = 0
		clone.ResponseHeaderTimeout = 0
		transport = clone
		defer clone.CloseIdleConnections()
	}
	client := &http.Client{Transport: transport, CheckRedirect: func(request *http.Request, via []*http.Request) error {
		watchdog.activity()
		if !validCloudflaredDownloadURL(request.URL.String()) {
			return fmt.Errorf("cloudflared 下载跳转到不允许的来源：%s", request.URL.Hostname())
		}
		if len(via) >= 10 {
			return errors.New("Cloudflare 下载跳转次数过多")
		}
		return nil
	}}
	response, err := client.Do(request)
	if err != nil {
		if errors.Is(context.Cause(ctx), errCloudflaredDownloadIdle) {
			return "", errCloudflaredDownloadIdle
		}
		return "", fmt.Errorf("下载 cloudflared 失败：%w", err)
	}
	defer response.Body.Close()
	watchdog.activity()
	if response.StatusCode != http.StatusOK {
		return "", fmt.Errorf("下载 cloudflared 失败：HTTP %d", response.StatusCode)
	}
	if response.ContentLength > 100<<20 {
		return "", errors.New("cloudflared 文件超过 100 MB，已取消下载")
	}
	tmp, err := os.CreateTemp(c.root, ".cloudflared-*.download")
	if err != nil {
		return "", fmt.Errorf("无法在运行包目录创建下载文件：%w", err)
	}
	tmpPath := tmp.Name()
	defer removeCloudflaredTemporaryFile(tmpPath)
	limited := &io.LimitedReader{R: cloudflaredProgressReader{Reader: response.Body, watchdog: watchdog}, N: (100 << 20) + 1}
	hasher := sha256.New()
	size, copyErr := io.Copy(io.MultiWriter(tmp, hasher), limited)
	// File validation and installation have their own cancellation/retry rules.
	watchdog.stop()
	closeErr := tmp.Close()
	if errors.Is(context.Cause(ctx), errCloudflaredDownloadIdle) {
		return "", errCloudflaredDownloadIdle
	}
	if copyErr != nil {
		return "", fmt.Errorf("接收或保存 cloudflared 失败：%w", copyErr)
	}
	if closeErr != nil {
		return "", fmt.Errorf("写入 cloudflared 失败：%w", closeErr)
	}
	if size <= 1<<20 || size > 100<<20 {
		return "", fmt.Errorf("cloudflared 下载文件大小异常（%d 字节）", size)
	}
	if expectedSHA256 != "" && hex.EncodeToString(hasher.Sum(nil)) != expectedSHA256 {
		return "", errors.New("cloudflared SHA-256 与 Cloudflare Release 校验值不一致")
	}
	var signature [2]byte
	readErr := retryCloudflaredFileOperation(ctx, func() error {
		file, err := os.Open(tmpPath)
		if err != nil {
			return err
		}
		defer file.Close()
		_, err = io.ReadFull(file, signature[:])
		return err
	})
	if readErr != nil {
		return "", &cloudflaredInstallError{fmt.Errorf("无法读取下载的 cloudflared 文件：%w", readErr)}
	}
	if signature != [2]byte{'M', 'Z'} {
		return "", errors.New("下载内容不是有效的 Windows 程序文件")
	}
	if err := installCloudflared(ctx, tmpPath, target); err != nil {
		return "", err
	}
	c.mu.Lock()
	c.tunnelExe = target
	c.mu.Unlock()
	return target, nil
}
