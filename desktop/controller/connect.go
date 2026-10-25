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
	Available bool   `json:"available"`
	State     string `json:"state"`
	URL       string `json:"url"`
	Message   string `json:"message"`
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
	report.Reason = "没有探测到公网 IPv6：外部接口无法通过 IPv6 访问本机。"
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

func latestCloudflaredRelease() (cloudflaredRelease, string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, cloudflaredReleaseAPI, nil)
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

func installedCloudflaredVersion(exe string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
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
func (c *Controller) downloadCloudflared(downloadURL, expectedSHA256 string, replaceExisting bool) (string, error) {
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
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, downloadURL, nil)
	if err != nil {
		return "", err
	}
	client := &http.Client{Timeout: 2 * time.Minute, CheckRedirect: func(request *http.Request, via []*http.Request) error {
		if request.URL.Scheme != "https" {
			return errors.New("Cloudflare 下载发生了非 HTTPS 跳转")
		}
		host := strings.ToLower(request.URL.Hostname())
		if host != "github.com" && !strings.HasSuffix(host, ".githubusercontent.com") {
			return fmt.Errorf("Cloudflare 下载跳转到非 GitHub 主机：%s", host)
		}
		if len(via) >= 10 {
			return errors.New("Cloudflare 下载跳转次数过多")
		}
		return nil
	}}
	response, err := client.Do(request)
	if err != nil {
		return "", fmt.Errorf("下载 cloudflared 失败：%w", err)
	}
	defer response.Body.Close()
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
	defer os.Remove(tmpPath)
	limited := &io.LimitedReader{R: response.Body, N: (100 << 20) + 1}
	hasher := sha256.New()
	size, copyErr := io.Copy(io.MultiWriter(tmp, hasher), limited)
	closeErr := tmp.Close()
	if copyErr != nil {
		return "", fmt.Errorf("保存 cloudflared 失败：%w", copyErr)
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
	file, err := os.Open(tmpPath)
	if err != nil {
		return "", err
	}
	var signature [2]byte
	_, readErr := io.ReadFull(file, signature[:])
	file.Close()
	if readErr != nil || signature != [2]byte{'M', 'Z'} {
		return "", errors.New("下载内容不是有效的 Windows 程序文件")
	}
	backup := ""
	if fileExists(target) {
		old, err := os.CreateTemp(c.root, ".cloudflared-previous-*.exe")
		if err != nil {
			return "", fmt.Errorf("无法准备 cloudflared 更新回滚文件：%w", err)
		}
		backup = old.Name()
		old.Close()
		os.Remove(backup)
		if err := os.Rename(target, backup); err != nil {
			return "", fmt.Errorf("无法暂存旧版 cloudflared：%w", err)
		}
	}
	if err := os.Rename(tmpPath, target); err != nil {
		if backup != "" {
			_ = os.Rename(backup, target)
		}
		return "", fmt.Errorf("无法安装 cloudflared 到运行包目录：%w", err)
	}
	if backup != "" {
		_ = os.Remove(backup)
	}
	c.mu.Lock()
	c.tunnelExe = target
	c.mu.Unlock()
	c.log("已从 Cloudflare 官方 GitHub 下载 cloudflared.exe", "tunnel", "INFO")
	return target, nil
}

func (c *Controller) tunnelReport() TunnelReport {
	c.mu.RLock()
	state, url, message := c.tunnelState, c.tunnelURL, c.tunnelMessage
	c.mu.RUnlock()
	return TunnelReport{Available: c.cloudflared() != "", State: state, URL: url, Message: message}
}

func (c *Controller) setTunnelState(state, message string) {
	c.mu.Lock()
	c.tunnelState, c.tunnelMessage = state, message
	c.mu.Unlock()
}

func (c *Controller) handleTunnelLine(line string) {
	if match := tunnelPattern.FindString(line); match != "" {
		c.mu.Lock()
		changed := c.tunnelURL != match
		c.tunnelURL = match
		if c.tunnelState != "stopping" {
			c.tunnelState = "running"
		}
		c.mu.Unlock()
		if changed {
			c.log("Cloudflare Tunnel 已就绪："+match, "tunnel", "INFO")
			c.emit()
		}
	}
}

// StartTunnel 用 cloudflared 的快速隧道把本机网页端口映射到临时地址。
func (c *Controller) StartTunnel() (any, error) {
	return c.exclusive(c.startTunnel)
}

// RefreshTunnel 先停止当前快速隧道，再检查组件更新并重新启动以获取新地址。
func (c *Controller) RefreshTunnel() (any, error) {
	return c.exclusive(func() (any, error) {
		if err := c.stopTunnel(); err != nil {
			return nil, err
		}
		c.emit()
		return c.startTunnel()
	})
}

func (c *Controller) startTunnel() (any, error) {
	c.mu.RLock()
	proc, state := c.tunnel, c.tunnelState
	active := c.active
	c.mu.RUnlock()
	if proc != nil && state != "error" {
		return c.Snapshot(), nil
	}
	if proc != nil {
		_ = c.stopTunnel()
	}
	exe := c.cloudflared()
	if exe == "" {
		c.setTunnelState("downloading", "正在从 Cloudflare 官方 GitHub 下载 cloudflared…")
		c.emit()
		release, latest, releaseErr := latestCloudflaredRelease()
		downloadURL, checksum := cloudflaredDownloadURL, ""
		if releaseErr == nil {
			downloadURL = "https://github.com/cloudflare/cloudflared/releases/download/" + release.TagName + "/cloudflared-windows-amd64.exe"
			checksum = checksumForRelease(release.Body)
		}
		if releaseErr != nil {
			c.log("获取 cloudflared Release 版本失败，将尝试下载官方 latest："+releaseErr.Error(), "tunnel", "WARN")
		}
		var err error
		exe, err = c.downloadCloudflared(downloadURL, checksum, false)
		if err != nil {
			c.setTunnelState("error", err.Error())
			c.emit()
			return nil, err
		}
		if releaseErr == nil {
			c.log("已安装 cloudflared "+latest, "tunnel", "INFO")
		}
	} else {
		c.setTunnelState("checking", "正在检查 cloudflared 组件更新…")
		c.emit()
		release, latest, err := latestCloudflaredRelease()
		if err != nil {
			c.log("检查 cloudflared 更新失败，继续使用当前版本："+err.Error(), "tunnel", "WARN")
		} else {
			installed := installedCloudflaredVersion(exe)
			if cloudflaredVersionIsOlder(installed, latest) {
				c.setTunnelState("downloading", "发现 cloudflared 新版本 "+latest+"，正在更新…")
				c.emit()
				downloadURL := "https://github.com/cloudflare/cloudflared/releases/download/" + release.TagName + "/cloudflared-windows-amd64.exe"
				updated, updateErr := c.downloadCloudflared(downloadURL, checksumForRelease(release.Body), true)
				if updateErr != nil {
					c.log("更新 cloudflared 失败，继续使用当前版本："+updateErr.Error(), "tunnel", "WARN")
				} else {
					exe = updated
					c.log("cloudflared 已更新至 "+latest, "tunnel", "INFO")
				}
			} else {
				c.log("cloudflared 已是最新版本（"+installed+"）", "tunnel", "INFO")
			}
		}
	}
	config := c.store.Value
	if active != nil {
		config = *active
	}
	if config.Port <= 0 {
		return nil, errors.New("请先在应用设置中确认网页端口")
	}
	scheme := "http"
	if config.Https {
		scheme = "https"
	}
	args := []string{"tunnel", "--url", fmt.Sprintf("%s://127.0.0.1:%d", scheme, config.Port), "--no-autoupdate"}
	if config.Https {
		args = append(args, "--no-tls-verify")
	}
	c.setTunnelState("connecting", "")
	c.mu.Lock()
	c.tunnelURL = ""
	c.mu.Unlock()
	started, err := startProcess("", exe, args, nil, filepath.Dir(exe), func(line string) {
		c.log(line, "tunnel", classifyLevel(line))
		c.handleTunnelLine(line)
	})
	if err != nil {
		c.setTunnelState("error", "无法启动 cloudflared："+err.Error())
		return nil, err
	}
	c.mu.Lock()
	c.tunnel = started
	c.mu.Unlock()
	go func() {
		code := started.Wait()
		c.mu.Lock()
		if c.tunnel != started {
			c.mu.Unlock()
			return
		}
		c.tunnel = nil
		c.tunnelURL = ""
		if c.tunnelState == "stopping" {
			c.tunnelState = "stopped"
		} else {
			c.tunnelState = "error"
		}
		failed := c.tunnelState == "error"
		c.mu.Unlock()
		level := "INFO"
		if failed {
			level = "ERROR"
		}
		c.log(fmt.Sprintf("Cloudflare Tunnel 已退出（%d）", code), "tunnel", level)
		c.emit()
	}()
	c.log("正在建立 Cloudflare 快速隧道，地址稍后显示", "tunnel", "INFO")
	return c.Snapshot(), nil
}

func (c *Controller) stopTunnel() error {
	c.mu.RLock()
	proc := c.tunnel
	c.mu.RUnlock()
	if proc == nil {
		c.mu.Lock()
		c.tunnelURL = ""
		c.mu.Unlock()
		c.setTunnelState("stopped", "")
		return nil
	}
	c.setTunnelState("stopping", "")
	if err := c.kill(proc, c.cloudflared()); err != nil {
		c.setTunnelState("error", "停止 cloudflared 失败")
		return err
	}
	c.mu.Lock()
	if c.tunnel == proc {
		c.tunnel = nil
	}
	c.tunnelURL = ""
	c.mu.Unlock()
	c.setTunnelState("stopped", "")
	return nil
}

// StopTunnel 停止隧道并广播状态。
func (c *Controller) StopTunnel() error {
	err := c.stopTunnel()
	c.emit()
	return err
}

// TunnelReport 供宿主层读取当前隧道状态。
func (c *Controller) TunnelReport() TunnelReport { return c.tunnelReport() }
