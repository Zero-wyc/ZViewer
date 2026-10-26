package controller

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	tunnelMaxRefreshes  = 5
	tunnelProbeTimeout  = 2 * time.Second
	tunnelProbeInterval = 300 * time.Millisecond
	tunnelReadyTimeout  = 18 * time.Second
)

var errTunnelOrigin = errors.New("本机源站不可用")
var errTunnelCannotRetry = errors.New("无法安全继续刷新")

type tunnelHealthPayload struct {
	Status    string `json:"status"`
	StartedAt int64  `json:"startedAt"`
}

type tunnelEvent struct {
	url        string
	registered bool
	err        string
	origin     bool
}

type tunnelCandidate struct {
	proc      *Proc
	cancel    context.CancelFunc
	events    chan tunnelEvent
	url       string
	latencyMs int64
}

func (c *Controller) tunnelReport() TunnelReport {
	c.mu.RLock()
	report := TunnelReport{State: c.tunnelState, URL: c.tunnelURL, Health: c.tunnelHealth, LatencyMs: c.tunnelLatencyMs, Message: c.tunnelMessage, RefreshCount: c.tunnelRefreshCount, MaxRefreshes: tunnelMaxRefreshes, Protocol: "http2"}
	c.mu.RUnlock()
	report.Available = c.cloudflared() != ""
	return report
}

// All startup work shares one context. Stop cancels downloads, probes and the
// exact child process; an old worker cannot publish into a newer session.
func (c *Controller) updateTunnel(generation uint64, state, message string, update func()) bool {
	c.mu.Lock()
	if generation != c.tunnelGeneration {
		c.mu.Unlock()
		return false
	}
	c.tunnelState, c.tunnelMessage = state, message
	if update != nil {
		update()
	}
	c.mu.Unlock()
	c.emit()
	return true
}

func (c *Controller) StartTunnel() (any, error) { return c.exclusive(c.startTunnel) }

func (c *Controller) RefreshTunnel() (any, error) {
	return c.exclusive(func() (any, error) {
		if err := c.stopTunnel(); err != nil {
			return nil, err
		}
		return c.startTunnel()
	})
}

func (c *Controller) startTunnel() (any, error) {
	c.tunnelLifecycleMu.Lock()
	defer c.tunnelLifecycleMu.Unlock()
	c.mu.Lock()
	if c.tunnelDone != nil {
		select {
		case <-c.tunnelDone:
		default:
			c.mu.Unlock()
			return c.Snapshot(), nil
		}
	}
	config := c.store.Value.Clone()
	if c.active != nil {
		config = c.active.Clone()
	}
	// 源站使用正在运行的服务配置；获取源使用用户刚保存的选择，无需重启主服务。
	config.CloudflaredSource = c.store.Value.CloudflaredSource
	if config.Port <= 0 {
		c.mu.Unlock()
		return nil, errors.New("请先确认网页服务端口")
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	c.tunnelGeneration++
	generation := c.tunnelGeneration
	c.tunnelCancel, c.tunnelDone = cancel, done
	c.tunnelRefreshCount = 0
	c.tunnelURL, c.tunnelMessage = "", "正在检查本机源站…"
	c.tunnelState, c.tunnelHealth = "health-checking", "checking"
	c.tunnelLatencyMs = 0
	c.mu.Unlock()
	c.emit()
	go c.runTunnelSession(ctx, cancel, done, generation, config)
	return c.Snapshot(), nil
}

func waitTunnel(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// Five refreshes means at most six candidates including the initial one.
func runTunnelRefreshes(ctx context.Context, attempt func(context.Context, int) error, refresh func(int, error)) error {
	var last error
	for index := 0; index <= tunnelMaxRefreshes; index++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		if index > 0 {
			refresh(index, last)
			if err := waitTunnel(ctx, 250*time.Millisecond); err != nil {
				return err
			}
		}
		last = attempt(ctx, index)
		if last == nil || errors.Is(last, errTunnelOrigin) || errors.Is(last, errTunnelCannotRetry) {
			return last
		}
	}
	return fmt.Errorf("已自动刷新 %d 次，仍无法连通：%w", tunnelMaxRefreshes, last)
}

// Each failed request is bounded to two seconds. Two failures refresh the
// candidate; two consecutive successes publish it. Cancellation never retries.
func checkTunnelCandidate(ctx context.Context, probe func(context.Context) (time.Duration, error), failure func(error)) (int64, error) {
	failures, successes := 0, 0
	var elapsed time.Duration
	for {
		if err := ctx.Err(); err != nil {
			return 0, err
		}
		probeCtx, cancel := context.WithTimeout(ctx, tunnelProbeTimeout)
		latency, err := probe(probeCtx)
		cancel()
		if ctx.Err() != nil {
			return 0, ctx.Err()
		}
		if err != nil {
			failures++
			successes = 0
			elapsed = 0
			failure(err)
			if failures >= 2 {
				return 0, fmt.Errorf("短时检测已失败两次：%w", err)
			}
		} else {
			successes++
			elapsed += latency
			if successes >= 2 {
				return elapsed.Milliseconds() / int64(successes), nil
			}
		}
		if err := waitTunnel(ctx, tunnelProbeInterval); err != nil {
			return 0, err
		}
	}
}

func tunnelOriginURL(config Config) string {
	scheme := "http"
	if config.Https {
		scheme = "https"
	}
	return fmt.Sprintf("%s://127.0.0.1:%d", scheme, config.Port)
}

func (c *Controller) probeTunnelOrigin(ctx context.Context, config Config) (tunnelHealthPayload, error) {
	transport := &http.Transport{DisableKeepAlives: true}
	defer transport.CloseIdleConnections()
	if config.Https {
		raw, err := os.ReadFile(c.certs.Paths().CA)
		if err != nil {
			return tunnelHealthPayload{}, fmt.Errorf("读取本机证书失败：%w", err)
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(raw) {
			return tunnelHealthPayload{}, errors.New("本机 CA 证书无效")
		}
		transport.TLSClientConfig = &tls.Config{RootCAs: pool, ServerName: "localhost"}
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, tunnelOriginURL(config)+"/health", nil)
	if err != nil {
		return tunnelHealthPayload{}, err
	}
	response, err := (&http.Client{Transport: transport, Timeout: 1500 * time.Millisecond}).Do(request)
	if err != nil {
		return tunnelHealthPayload{}, err
	}
	defer response.Body.Close()
	var health tunnelHealthPayload
	err = json.NewDecoder(io.LimitReader(response.Body, 4096)).Decode(&health)
	if err != nil || response.StatusCode != http.StatusOK || health.Status != "ok" {
		return health, fmt.Errorf("本机 /health 返回异常（HTTP %d）", response.StatusCode)
	}
	return health, nil
}

func probePublicTunnel(ctx context.Context, candidate string, startedAt int64, client *http.Client) (time.Duration, error) {
	started := time.Now()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(candidate, "/")+"/health", nil)
	if err != nil {
		return 0, err
	}
	request.Header.Set("Cache-Control", "no-cache, no-store")
	request.Header.Set("User-Agent", "ZViewerDesktop-TunnelHealth")
	response, err := client.Do(request)
	if err != nil {
		var dns *net.DNSError
		if errors.As(err, &dns) {
			return 0, fmt.Errorf("公网域名解析失败：%w", err)
		}
		return 0, err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 4096))
	if err != nil {
		return 0, err
	}
	if response.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("公网 /health 返回 HTTP %d", response.StatusCode)
	}
	var health tunnelHealthPayload
	if json.Unmarshal(body, &health) != nil || health.Status != "ok" {
		return 0, errors.New("公网响应不是 ZViewer 健康接口")
	}
	if startedAt > 0 && health.StartedAt != startedAt {
		return 0, errors.New("公网隧道未指向本次启动的 ZViewer 服务")
	}
	return time.Since(started), nil
}

func (c *Controller) prepareCloudflared(ctx context.Context, generation uint64, source string) (string, error) {
	exe := c.cloudflared()
	sources := []string{source}
	if source != cloudflaredSourceGitHub {
		sources = append(sources, cloudflaredSourceGitHub)
	}
	fallback := ""
	for _, selected := range sources {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		name := cloudflaredSourceName(selected)
		c.updateTunnel(generation, "checking", fallback+"正在通过 "+name+" 检查 cloudflared 更新…", nil)
		release, latest, releaseErr := latestCloudflaredRelease(ctx, selected)
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		if releaseErr != nil {
			if selected != cloudflaredSourceGitHub {
				fallback = "前置反代不可用，已回退 GitHub 官方。"
				c.log(fallback+releaseErr.Error(), "tunnel", "WARN")
				continue
			}
			if exe != "" {
				c.log("组件更新检查失败，使用现有组件："+releaseErr.Error(), "tunnel", "WARN")
				return exe, nil
			}
		}
		if exe != "" && !cloudflaredVersionIsOlder(installedCloudflaredVersion(ctx, exe), latest) {
			return exe, ctx.Err()
		}
		downloadURL, checksum := cloudflaredDownloadURL, ""
		if releaseErr == nil {
			downloadURL = "https://github.com/cloudflare/cloudflared/releases/download/" + release.TagName + "/cloudflared-windows-amd64.exe"
			checksum = checksumForRelease(release.Body)
		}
		c.updateTunnel(generation, "downloading", fallback+"正在通过 "+name+" 下载 cloudflared，完成后启动…", nil)
		updated, err := c.downloadCloudflared(ctx, cloudflaredSourceURL(selected, downloadURL), checksum, exe != "")
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		if err == nil {
			c.log("已通过 "+name+" 下载 cloudflared.exe", "tunnel", "INFO")
			return updated, nil
		}
		var installErr *cloudflaredInstallError
		if errors.As(err, &installErr) {
			if exe != "" && fileExists(exe) {
				c.log("组件文件安装失败，使用现有组件："+err.Error(), "tunnel", "WARN")
				return exe, nil
			}
			return "", err
		}
		if selected != cloudflaredSourceGitHub {
			fallback = "前置反代下载失败，已回退 GitHub 官方。"
			c.log(fallback+err.Error(), "tunnel", "WARN")
			continue
		}
		if exe != "" {
			c.log("组件更新失败，使用现有组件："+err.Error(), "tunnel", "WARN")
			return exe, nil
		}
		return "", err
	}
	return "", errors.New("没有可用的 cloudflared 获取源")
}

func stopTunnelCandidate(candidate *tunnelCandidate) error {
	if candidate == nil {
		return nil
	}
	candidate.cancel()
	if candidate.proc.Exited() {
		return nil
	}
	if candidate.proc.cmd.Process != nil {
		_ = candidate.proc.cmd.Process.Kill()
	}
	select {
	case <-candidate.proc.done:
		return nil
	case <-time.After(2 * time.Second):
		return errors.New("旧隧道进程尚未退出，已取消后续刷新")
	}
}

func (c *Controller) startTunnelCandidate(ctx context.Context, generation uint64, config Config, exe string, startedAt int64) (winner *tunnelCandidate, resultErr error) {
	attemptCtx, cancel := context.WithCancel(ctx)
	events := make(chan tunnelEvent, 64)
	args := []string{"tunnel", "--url", tunnelOriginURL(config), "--no-autoupdate", "--protocol", "http2", "--proxy-connect-timeout", "3s", "--proxy-tls-timeout", "3s"}
	if config.Https {
		args = append(args, "--no-tls-verify", "--origin-server-name", "localhost")
	}
	proc, err := startProcessContext(attemptCtx, "", exe, args, nil, filepath.Dir(exe), func(line string) {
		if attemptCtx.Err() != nil {
			return
		}
		c.log(tunnelPattern.ReplaceAllString(line, "[等待健康检查]"), "tunnel", classifyLevel(line))
		event := tunnelEvent{url: tunnelPattern.FindString(line), registered: strings.Contains(line, "Registered tunnel connection")}
		if strings.Contains(line, " ERR ") || strings.Contains(line, "Unable to reach the origin") {
			event.err = c.sanitize(tunnelPattern.ReplaceAllString(line, "[候选地址]"))
			lower := strings.ToLower(line)
			event.origin = strings.Contains(lower, "originservice=") || strings.Contains(lower, "unable to reach the origin") || strings.Contains(lower, "connection refused")
		}
		if event.url != "" || event.registered || event.err != "" {
			select {
			case events <- event:
			default:
			}
		}
	})
	if err != nil {
		cancel()
		return nil, err
	}
	candidate := &tunnelCandidate{proc: proc, cancel: cancel, events: events}
	defer func() {
		if resultErr != nil {
			if err := stopTunnelCandidate(candidate); err != nil {
				resultErr = fmt.Errorf("%w: %v", errTunnelCannotRetry, err)
			}
			c.mu.Lock()
			if c.tunnel == proc {
				c.tunnel = nil
			}
			c.mu.Unlock()
		}
	}()
	c.mu.Lock()
	if generation != c.tunnelGeneration || ctx.Err() != nil {
		c.mu.Unlock()
		return nil, context.Canceled
	}
	c.tunnel = proc
	c.mu.Unlock()
	ready := false
	lastError := "Cloudflare 尚未完成连接注册"
	timer := time.NewTimer(tunnelReadyTimeout)
	defer timer.Stop()
	for candidate.url == "" || !ready {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-proc.done:
			return nil, fmt.Errorf("cloudflared 提前退出（%d）：%s", proc.Wait(), lastError)
		case <-timer.C:
			return nil, fmt.Errorf("连接建立超时：%s", lastError)
		case event := <-events:
			if event.url != "" {
				candidate.url = event.url
			}
			if event.registered {
				ready = true
			}
			if event.err != "" {
				lastError = event.err
			}
		}
	}
	// Avoid probing DNS before the connector has registered its route.
	if err := waitTunnel(ctx, time.Second); err != nil {
		return nil, err
	}
	c.updateTunnel(generation, "health-checking", "已注册 Cloudflare 连接，正在快速检测公网访问…", nil)
	candidate.latencyMs, err = checkTunnelCandidate(ctx, func(probeCtx context.Context) (time.Duration, error) {
		return probePublicTunnel(probeCtx, candidate.url, startedAt, http.DefaultClient)
	}, func(err error) { c.log("候选隧道检测失败："+err.Error(), "tunnel", "WARN") })
	if err != nil {
		return nil, err
	}
	// Earlier connector warnings are superseded by the successful public probes.
	for {
		select {
		case <-events:
		default:
			return candidate, nil
		}
	}
}

func (c *Controller) runTunnelSession(ctx context.Context, cancel context.CancelFunc, done chan struct{}, generation uint64, config Config) {
	var candidate *tunnelCandidate
	defer func() {
		cancel()
		_ = stopTunnelCandidate(candidate)
		c.mu.Lock()
		if generation == c.tunnelGeneration {
			c.tunnel = nil
			c.tunnelCancel = nil
			if c.tunnelState != "error" {
				c.tunnelState, c.tunnelHealth = "stopped", "stopped"
				c.tunnelURL = ""
				c.tunnelMessage = "已停止隧道和自动刷新"
			}
		}
		close(done)
		c.mu.Unlock()
		c.emit()
	}()
	fail := func(err error) {
		if ctx.Err() == nil {
			c.updateTunnel(generation, "error", err.Error(), func() { c.tunnelURL = ""; c.tunnelHealth = "unhealthy" })
			c.log(err.Error(), "tunnel", "ERROR")
		}
	}
	var origin tunnelHealthPayload
	var err error
	for index := 0; index < 2; index++ {
		origin, err = c.probeTunnelOrigin(ctx, config)
		if err == nil {
			break
		}
		if ctx.Err() != nil {
			return
		}
		if index == 0 {
			_ = waitTunnel(ctx, 250*time.Millisecond)
		}
	}
	if err != nil {
		fail(fmt.Errorf("本机源站 %s 未通过健康检查：%w", tunnelOriginURL(config), err))
		return
	}
	exe, err := c.prepareCloudflared(ctx, generation, config.CloudflaredSource)
	if err != nil {
		fail(err)
		return
	}
	err = runTunnelRefreshes(ctx, func(ctx context.Context, index int) error {
		c.updateTunnel(generation, "connecting", fmt.Sprintf("正在建立 HTTP/2 隧道（自动刷新 %d/%d）…", index, tunnelMaxRefreshes), func() {
			c.tunnelRefreshCount = index
			c.tunnelURL = ""
			c.tunnelHealth = "checking"
			c.tunnelLatencyMs = 0
		})
		if _, err := c.probeTunnelOrigin(ctx, config); err != nil {
			return fmt.Errorf("%w：%v", errTunnelOrigin, err)
		}
		var attemptErr error
		candidate, attemptErr = c.startTunnelCandidate(ctx, generation, config, exe, origin.StartedAt)
		return attemptErr
	}, func(index int, err error) {
		c.updateTunnel(generation, "refreshing", fmt.Sprintf("检测未通过，正在自动刷新 %d/%d，可随时中断", index, tunnelMaxRefreshes), func() { c.tunnelRefreshCount = index })
		c.log(fmt.Sprintf("自动刷新隧道 %d/%d：%v", index, tunnelMaxRefreshes, err), "tunnel", "WARN")
	})
	if err != nil {
		fail(err)
		return
	}
	if ctx.Err() != nil {
		return
	}
	c.updateTunnel(generation, "running", "启动健康检查通过；此后保持当前地址，连接中断时仅在原地址重连。", func() {
		c.tunnelURL = candidate.url
		c.tunnelHealth = "healthy"
		c.tunnelLatencyMs = candidate.latencyMs
	})
	c.log(fmt.Sprintf("HTTP/2 隧道健康检查通过：%s，平均耗时 %d ms，自动刷新 %d 次", candidate.url, candidate.latencyMs, c.tunnelReport().RefreshCount), "tunnel", "INFO")
	originFailed := false
	for {
		select {
		case <-ctx.Done():
			return
		case <-candidate.proc.done:
			fail(fmt.Errorf("cloudflared 已退出（%d），当前地址已失效；未自动更换地址", candidate.proc.Wait()))
			return
		case event := <-candidate.events:
			originFailed = c.observeTunnelEvent(generation, event, originFailed)
		}
	}
}

func (c *Controller) observeTunnelEvent(generation uint64, event tunnelEvent, originFailed bool) bool {
	if event.err != "" {
		originFailed = originFailed || event.origin
		message := "Cloudflare 链路中断，组件正在原地址重连；可手动刷新。"
		if event.origin {
			message = "Cloudflare 无法访问本机源站：" + event.err
		}
		c.updateTunnel(generation, "reconnecting", message, func() { c.tunnelHealth = "degraded" })
	} else if event.registered && !originFailed {
		c.updateTunnel(generation, "running", "Cloudflare 连接已恢复，继续使用原地址。", func() { c.tunnelHealth = "healthy" })
	}
	return originFailed
}

func (c *Controller) stopTunnel() error {
	c.tunnelLifecycleMu.Lock()
	defer c.tunnelLifecycleMu.Unlock()
	c.mu.Lock()
	cancel, done, proc := c.tunnelCancel, c.tunnelDone, c.tunnel
	if cancel == nil {
		c.tunnelState, c.tunnelHealth = "stopped", "stopped"
		c.tunnelURL, c.tunnelMessage = "", ""
		c.mu.Unlock()
		return nil
	}
	c.tunnelState, c.tunnelMessage = "stopping", "正在中断检测、自动刷新和隧道进程…"
	c.mu.Unlock()
	c.emit()
	cancel()
	if proc != nil && !proc.Exited() && proc.cmd.Process != nil {
		_ = proc.cmd.Process.Kill()
	}
	select {
	case <-done:
		return nil
	case <-time.After(3 * time.Second):
		return errors.New("已取消自动刷新，正在等待隧道进程退出")
	}
}

func (c *Controller) stopTunnelForOriginFailure() {
	c.mu.RLock()
	active := c.tunnelCancel != nil
	generation := c.tunnelGeneration
	c.mu.RUnlock()
	if !active {
		return
	}
	err := c.stopTunnel()
	message := "本机 ZViewer 主服务意外退出，隧道已停止；请先重新启动主服务。"
	if err != nil {
		message += " " + err.Error()
	}
	c.updateTunnel(generation, "error", message, func() { c.tunnelHealth = "unhealthy"; c.tunnelURL = "" })
}

func (c *Controller) StopTunnel() error          { err := c.stopTunnel(); c.emit(); return err }
func (c *Controller) TunnelReport() TunnelReport { return c.tunnelReport() }
