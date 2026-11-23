package crawler

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// 离屏 Chromium 兜底（CDP）。
//
// Python 版自己实现了 RFC 6455 客户端（browser.py 前 240 行），Go 侧直接用
// coder/websocket，剩下的只是 CDP 会话管理。这一版只做「打开页面 → 等渲染 →
// 收集媒体地址」，可见登录窗口与 Cookie 导出留到后续（浏览器批次二）。
//
// 复用策略：先探测 remote-debugging 端口，已经有人开着就直接连（Python 版启动的
// 实例也能复用），否则自己拉起一个。profile 目录共享，登录态才能跨次复用。

const (
	defaultCDPPort = 9333
	cdpStartWaits  = 40
	// cdpProbeTimeout 是一次健康探测的上限：让页面回一句 1+1 就算活着。
	cdpProbeTimeout = 6 * time.Second
	// cdpCallTimeout 是单条 CDP 命令的上限。原来 30s，一次 browser_open 要
	// 串 4~6 条命令，卡住时整个 Agent 会静默两分钟，界面只能干等。
	cdpCallTimeout = 12 * time.Second
	// browserLaunchWaits 是等调试端口就绪的次数（每次 250ms）。
	browserLaunchWaits = 24
	// cdpPortTries 是「端口被死实例占着」时向后试探的端口数。
	cdpPortTries = 6
)

// BrowserOptions 控制浏览器进程。
type BrowserOptions struct {
	Bin        string
	ProfileDir string
	Port       int
	Headless   bool
}

// Browser 是一个受控的 Chromium 会话。
type Browser struct {
	opts BrowserOptions

	mu     sync.Mutex
	cmd    *exec.Cmd
	client *cdpClient
	port   int
}

// NewBrowser 构造控制器（不启动进程）。
func NewBrowser(opts BrowserOptions) *Browser {
	if opts.Port <= 0 {
		opts.Port = defaultCDPPort
	}
	if opts.ProfileDir != "" {
		_ = os.MkdirAll(opts.ProfileDir, 0o755)
	}
	return &Browser{opts: opts, port: opts.Port}
}

// FindBrowserBinary 按 CRAWLER_BROWSER_BIN → PATH → 常见安装路径找 Chromium 内核浏览器。
func FindBrowserBinary(configured string) (string, error) {
	if trimmed := strings.TrimSpace(configured); trimmed != "" {
		if info, err := os.Stat(trimmed); err == nil && !info.IsDir() {
			return trimmed, nil
		}
		if found, err := exec.LookPath(trimmed); err == nil {
			return found, nil
		}
		return "", ConfigError("找不到浏览器可执行文件: " + trimmed)
	}
	candidates := make([]string, 0, 6)
	if env := strings.TrimSpace(os.Getenv("CRAWLER_BROWSER_BIN")); env != "" {
		candidates = append(candidates, env)
	}
	for _, name := range []string{"msedge", "chrome", "chromium", "chromium-browser"} {
		if found, err := exec.LookPath(name); err == nil {
			candidates = append(candidates, found)
		}
	}
	if runtime.GOOS == "windows" {
		roots := []string{
			os.Getenv("PROGRAMFILES(X86)"),
			os.Getenv("PROGRAMFILES"),
			os.Getenv("LOCALAPPDATA"),
		}
		rels := []string{
			`Microsoft\Edge\Application\msedge.exe`,
			`Google\Chrome\Application\chrome.exe`,
			`Chromium\Application\chrome.exe`,
		}
		for _, root := range roots {
			if root == "" {
				continue
			}
			for _, rel := range rels {
				candidates = append(candidates, filepath.Join(root, rel))
			}
		}
	} else {
		candidates = append(candidates, "/usr/bin/microsoft-edge", "/usr/bin/google-chrome",
			"/usr/bin/chromium", "/usr/bin/chromium-browser")
	}
	for _, candidate := range candidates {
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return candidate, nil
		}
	}
	return "", ConfigError("找不到 Chromium 内核浏览器（Edge/Chrome），可安装或设置 engine.browser.bin")
}

// Available 判断能否用浏览器兜底：二进制存在且能开起来（这里只探二进制）。
func (b *Browser) Available() bool {
	if _, err := FindBrowserBinary(b.opts.Bin); err != nil {
		return false
	}
	return true
}

// Start 复用已有调试端口或拉起新进程，并连上可用的 page target。
//
// 复用之前必须探活：渲染进程崩掉后调试端口照样在听，页面级命令却一条都不回，
// Agent 的 browser_open 会静默卡到超时（界面上就是「对话一直转圈，最后报错」）。
// 所以这里改成：探活通过才复用，否则换端口自己拉起；第一次用常规参数，失败再补
// --no-sandbox 重来（受限环境里渲染进程起不来）。
func (b *Browser) Start(ctx context.Context) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.client != nil {
		return nil
	}

	if wsURL := fetchWebSocketURL(ctx, b.versionURL()); wsURL != "" {
		if err := b.attachPage(ctx, wsURL); err == nil && b.probeLocked(ctx) {
			return nil
		}
		// 端口被死实例占着：断开连接，换端口自己起一个干净的。
		b.resetClientLocked()
		b.port = nextFreePort(b.port)
	}

	firstErr := b.launchLocked(ctx, nil)
	if firstErr == nil {
		return nil
	}
	b.killLocked()
	b.port = nextFreePort(b.port)
	if secondErr := b.launchLocked(ctx, []string{"--no-sandbox", "--disable-dev-shm-usage"}); secondErr == nil {
		return nil
	}
	b.killLocked()
	return newError("browser_error", "启动离屏浏览器失败: "+firstErr.Error(), nil)
}

func (b *Browser) versionURL() string {
	return fmt.Sprintf("http://127.0.0.1:%d/json/version", b.port)
}

// launchLocked 拉起浏览器进程，等调试端口就绪后连上第一个 page target。
//
// extra 非空表示这是「常规参数起不来」的重试：此时换一份 profile，避免新进程
// 注入到那个已经卡死的实例里（同 profile 的第二次启动只会开个标签页就退出）。
func (b *Browser) launchLocked(ctx context.Context, extra []string) error {
	binary, err := FindBrowserBinary(b.opts.Bin)
	if err != nil {
		return err
	}
	args := []string{
		fmt.Sprintf("--remote-debugging-port=%d", b.port),
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-extensions",
		"--disable-background-networking",
		"--mute-audio",
	}
	if b.opts.Headless {
		args = append(args, "--headless=new", "--disable-gpu")
	}
	profile := b.opts.ProfileDir
	if profile != "" {
		if len(extra) > 0 {
			profile += "-recovery"
			_ = os.MkdirAll(profile, 0o755)
		}
		args = append(args, "--user-data-dir="+profile)
	}
	args = append(args, extra...)
	args = append(args, "about:blank")

	command := exec.Command(binary, args...)
	command.SysProcAttr = sysProcAttr()
	if err := command.Start(); err != nil {
		return newError("browser_error", "启动浏览器失败: "+err.Error(), nil)
	}
	b.cmd = command

	deadline := time.Now().Add(time.Duration(browserLaunchWaits) * 250 * time.Millisecond)
	for time.Now().Before(deadline) {
		if wsURL := fetchWebSocketURL(ctx, b.versionURL()); wsURL != "" {
			if err := b.attachPage(ctx, wsURL); err != nil {
				return err
			}
			if b.probeLocked(ctx) {
				return nil
			}
			return newError("browser_error", "浏览器已启动但页面不响应（渲染进程未就绪）", nil)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(250 * time.Millisecond):
		}
	}
	return newError("browser_error", "浏览器调试端口没有就绪", nil)
}

// probeLocked 用一条最短的 Runtime.evaluate 探页面是否还能执行脚本。
func (b *Browser) probeLocked(ctx context.Context) bool {
	if b.client == nil {
		return false
	}
	probeCtx, cancel := context.WithTimeout(ctx, cdpProbeTimeout)
	defer cancel()
	var result struct {
		Result struct {
			Value any `json:"value"`
		} `json:"result"`
	}
	if err := b.client.Call(probeCtx, "Runtime.evaluate", map[string]any{
		"expression":    "1+1",
		"returnByValue": true,
	}, &result); err != nil {
		return false
	}
	return result.Result.Value != nil
}

// dropClient 断开当前 CDP 连接；下一次工具调用会重新探活或拉起浏览器。
func (b *Browser) dropClient() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.resetClientLocked()
}

func (b *Browser) resetClientLocked() {
	if b.client != nil {
		b.client.Close()
		b.client = nil
	}
}

// killLocked 结束自己拉起的浏览器进程；复用别人的实例时只断开连接。
func (b *Browser) killLocked() {
	b.resetClientLocked()
	if b.cmd != nil && b.cmd.Process != nil {
		_ = b.cmd.Process.Kill()
		b.cmd = nil
	}
}

// nextFreePort 从当前端口往后找一个没人听的端口。
func nextFreePort(from int) int {
	for offset := 1; offset <= cdpPortTries; offset++ {
		candidate := from + offset
		if !portListening(candidate) {
			return candidate
		}
	}
	return from + cdpPortTries + 1
}

// attachPage 连到 page target。
//
// /json/version 给的是 browser-level 地址，在那上面 Page.navigate 不生效——
// 必须换成 /json/list 里 type=page 的 webSocketDebuggerUrl（没有就新建标签页）。
func (b *Browser) attachPage(ctx context.Context, browserWS string) error {
	target := pageWebSocketURL(ctx, b.port)
	if target != "" {
		if client, err := newCDPClient(ctx, target); err == nil {
			b.client = client
			_ = client.Call(ctx, "Page.enable", map[string]any{}, nil)
			_ = client.Call(ctx, "Runtime.enable", map[string]any{}, nil)
			return nil
		}
	}
	// 退化：直连 browser target，至少 Evaluate 还能跑（Navigate 会失败）。
	return b.attach(ctx, browserWS)
}

// pageWebSocketURL 取第一个 page 标签页的调试地址；没有就尝试新建。
func pageWebSocketURL(ctx context.Context, port int) string {
	if ws := listPageTarget(ctx, port); ws != "" {
		return ws
	}
	createURL := fmt.Sprintf("http://127.0.0.1:%d/json/new?about:blank", port)
	reqCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(reqCtx, http.MethodPut, createURL, nil)
	if err != nil {
		return ""
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return ""
	}
	defer response.Body.Close()
	payload, _ := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	var decoded struct {
		WebSocketDebuggerURL string `json:"webSocketDebuggerUrl"`
	}
	if err := json.Unmarshal(payload, &decoded); err != nil {
		return ""
	}
	return decoded.WebSocketDebuggerURL
}

func listPageTarget(ctx context.Context, port int) string {
	listURL := fmt.Sprintf("http://127.0.0.1:%d/json/list", port)
	reqCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(reqCtx, http.MethodGet, listURL, nil)
	if err != nil {
		return ""
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return ""
	}
	defer response.Body.Close()
	payload, _ := io.ReadAll(io.LimitReader(response.Body, 4<<20))
	var targets []struct {
		Type                 string `json:"type"`
		WebSocketDebuggerURL string `json:"webSocketDebuggerUrl"`
	}
	if err := json.Unmarshal(payload, &targets); err != nil {
		return ""
	}
	for _, item := range targets {
		if item.Type == "page" && item.WebSocketDebuggerURL != "" {
			return item.WebSocketDebuggerURL
		}
	}
	return ""
}

func (b *Browser) attach(ctx context.Context, wsURL string) error {
	client, err := newCDPClient(ctx, wsURL)
	if err != nil {
		return err
	}
	b.client = client
	// 打开空白页就把 Page/Runtime 打开，后续 Navigate 才有事件。
	_ = client.Call(ctx, "Page.enable", map[string]any{}, nil)
	_ = client.Call(ctx, "Runtime.enable", map[string]any{}, nil)
	return nil
}

// Close 断开 CDP（不杀浏览器进程，profile 还要复用）。
func (b *Browser) Close() {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.client != nil {
		b.client.Close()
		b.client = nil
	}
}

// fetchWebSocketURL 取浏览器的调试地址；端口没人听时返回空串。
func fetchWebSocketURL(ctx context.Context, versionURL string) string {
	reqCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(reqCtx, http.MethodGet, versionURL, nil)
	if err != nil {
		return ""
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return ""
	}
	defer response.Body.Close()
	payload, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return ""
	}
	var decoded struct {
		WebSocketDebuggerURL string `json:"webSocketDebuggerUrl"`
	}
	if err := json.Unmarshal(payload, &decoded); err != nil {
		return ""
	}
	return decoded.WebSocketDebuggerURL
}

// Navigate 打开地址并等 load 事件（最多 15s，超时不算失败）。
func (b *Browser) Navigate(ctx context.Context, target string) error {
	client := b.clientLocked()
	if client == nil {
		return newError("browser_error", "浏览器未启动", nil)
	}
	params := map[string]any{"url": target}
	var result struct {
		FrameID string `json:"frameId"`
	}
	if err := client.Call(ctx, "Page.navigate", params, &result); err != nil {
		// 连接层面的失败基本都意味着这一轮会话已经废了：断开，下一次调用重新拉起。
		b.dropClient()
		return err
	}
	// 等渲染完成：轮询 readyState，避免依赖事件订阅的时序。
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		state, err := b.Evaluate(ctx, "document.readyState")
		if err == nil {
			if text, ok := state.(string); ok && (text == "complete" || text == "interactive") {
				return nil
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(300 * time.Millisecond):
		}
	}
	return nil
}

func (b *Browser) clientLocked() *cdpClient {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.client
}

// Evaluate 执行 JS 并返回其 JSON 值。
func (b *Browser) Evaluate(ctx context.Context, expression string) (any, error) {
	client := b.clientLocked()
	if client == nil {
		return nil, newError("browser_error", "浏览器未启动", nil)
	}
	var result struct {
		Result struct {
			Value any `json:"value"`
		} `json:"result"`
		ExceptionDetails json.RawMessage `json:"exceptionDetails"`
	}
	if err := client.Call(ctx, "Runtime.evaluate", map[string]any{
		"expression":    expression,
		"returnByValue": true,
		"awaitPromise":  true,
	}, &result); err != nil {
		b.dropClient()
		return nil, err
	}
	if len(result.ExceptionDetails) > 0 && string(result.ExceptionDetails) != "null" {
		return nil, newError("browser_error", "页面脚本执行出错: "+string(result.ExceptionDetails), nil)
	}
	return result.Result.Value, nil
}

// HTML 取当前页面 HTML。
func (b *Browser) HTML(ctx context.Context) (string, error) {
	value, err := b.Evaluate(ctx, "document.documentElement.outerHTML")
	if err != nil {
		return "", err
	}
	text, _ := value.(string)
	return text, nil
}

// CollectMedia 收集页面里的媒体地址：performance 资源 + video/source 的 src。
func (b *Browser) CollectMedia(ctx context.Context) ([]string, error) {
	const script = `(() => {
		const urls = new Set();
		for (const entry of performance.getEntriesByType('resource')) {
			if (/\.(m3u8|mp4|flv)(\?|$)/i.test(entry.name)) urls.add(entry.name);
		}
		for (const el of document.querySelectorAll('video, source')) {
			const src = el.currentSrc || el.src;
			if (src) urls.add(src);
		}
		return Array.from(urls).slice(0, 20);
	})()`
	value, err := b.Evaluate(ctx, script)
	if err != nil {
		return nil, err
	}
	items, ok := value.([]any)
	if !ok {
		return nil, nil
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		if text, ok := item.(string); ok && text != "" {
			out = append(out, text)
		}
	}
	return out, nil
}

// nudgePlayback 尝试触发播放（静音播放/点播放按钮），让站点开始请求媒体。
func (b *Browser) nudgePlayback(ctx context.Context) {
	const script = `(() => {
		const video = document.querySelector('video');
		if (video) { video.muted = true; video.play().catch(() => {}); }
		const button = document.querySelector('[class*=play], [id*=play], .play-button');
		if (button && typeof button.click === 'function') button.click();
		return true;
	})()`
	_, _ = b.Evaluate(ctx, script)
}

// Sniff 实现 BrowserSniffer：打开页面、触发播放、收集媒体地址。
//
// 只做「能拿到就返回」：拿不到返回 false，由 PlayResolver 走 iframe 或报错。
func (b *Browser) Sniff(target string, headers map[string]string, episodes []Episode) (map[string]any, bool) {
	if !b.Available() {
		return nil, false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	if err := b.Start(ctx); err != nil {
		return nil, false
	}

	candidates := []string{target}
	for index, episode := range episodes {
		if index >= 3 {
			break
		}
		if episode.PlayPage != "" {
			candidates = append(candidates, episode.PlayPage)
		}
	}

	bestURL := ""
	bestScore := -1
	bestPage := target
	title := ""
	for _, candidate := range candidates {
		if err := b.Navigate(ctx, candidate); err != nil {
			continue
		}
		time.Sleep(1500 * time.Millisecond)
		b.nudgePlayback(ctx)
		time.Sleep(1200 * time.Millisecond)

		media, err := b.CollectMedia(ctx)
		if err != nil || len(media) == 0 {
			time.Sleep(1200 * time.Millisecond)
			media, _ = b.CollectMedia(ctx)
		}
		if title == "" {
			if html, err := b.HTML(ctx); err == nil {
				title = pageTitleOf(html)
			}
		}
		for _, item := range media {
			if DetectFormat(item) == "" {
				continue
			}
			if !playableURL(item, headers) {
				continue
			}
			if score := stabilityScore(item); score > bestScore {
				bestScore = score
				bestURL = item
				bestPage = candidate
			}
		}
		if bestURL != "" {
			break
		}
	}
	if bestURL == "" {
		return nil, false
	}
	result := buildPlayResult(nil, bestPage, firstNonEmpty(title, HostOf(target)), bestURL,
		headers, episodes, "browser", "通过受控浏览器解析（可能依赖站点登录态）", nil, "")
	return result, true
}

// playableURL 是包级探测：Sniff 没有 PlayResolver 的 fetcher，用默认抓取器。
func playableURL(target string, headers map[string]string) bool {
	probe := make(map[string]string, len(headers)+2)
	for key, value := range headers {
		probe[key] = value
	}
	probe["Range"] = "bytes=0-1"
	probe["Accept"] = "*/*"
	response, err := http.DefaultClient.Do(mustRequest(target, probe))
	if err != nil {
		return false
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 2048))
	return response.StatusCode >= 200 && response.StatusCode < 400
}

func mustRequest(target string, headers map[string]string) *http.Request {
	request, err := http.NewRequest(http.MethodGet, target, nil)
	if err != nil {
		return &http.Request{}
	}
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	return request
}

// cdpClient 是最小 CDP 客户端：一个 socket、串行调用、按 id 匹配响应。
type cdpClient struct {
	conn *websocket.Conn
	mu   sync.Mutex
	next int64
}

func newCDPClient(ctx context.Context, wsURL string) (*cdpClient, error) {
	conn, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{
		HTTPClient: &http.Client{Transport: &http.Transport{Proxy: nil}},
	})
	if err != nil {
		return nil, newError("browser_error", "连接浏览器调试端口失败: "+err.Error(), nil)
	}
	conn.SetReadLimit(32 << 20)
	return &cdpClient{conn: conn}, nil
}

// Call 发送一条 CDP 命令并等对应 id 的结果（期间的事件帧直接丢弃）。
func (c *cdpClient) Call(ctx context.Context, method string, params any, out any) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.next++
	id := c.next
	payload, err := json.Marshal(map[string]any{"id": id, "method": method, "params": params})
	if err != nil {
		return err
	}
	writeCtx, cancel := context.WithTimeout(ctx, cdpCallTimeout)
	defer cancel()
	if err := c.conn.Write(writeCtx, websocket.MessageText, payload); err != nil {
		return newError("browser_error", "CDP 发送失败: "+err.Error(), nil)
	}
	for {
		readCtx, readCancel := context.WithTimeout(ctx, cdpCallTimeout)
		_, raw, err := c.conn.Read(readCtx)
		readCancel()
		if err != nil {
			return newError("browser_error", "CDP 读取失败: "+err.Error(), nil)
		}
		var frame struct {
			ID     int64           `json:"id"`
			Result json.RawMessage `json:"result"`
			Error  *struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal(raw, &frame); err != nil {
			continue
		}
		if frame.ID != id {
			continue // 事件帧或别的命令的响应
		}
		if frame.Error != nil {
			return newError("browser_error", "CDP "+method+" 失败: "+frame.Error.Message, nil)
		}
		if out != nil && len(frame.Result) > 0 {
			if err := json.Unmarshal(frame.Result, out); err != nil {
				return newError("browser_error", "CDP 响应解析失败: "+err.Error(), nil)
			}
		}
		return nil
	}
}

// Close 关掉连接。
func (c *cdpClient) Close() {
	if c.conn != nil {
		_ = c.conn.Close(websocket.StatusNormalClosure, "")
	}
}

// portListening 判断调试端口是否已被占用（用于「复用已有实例」与诊断）。
func portListening(port int) bool {
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 500*time.Millisecond)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}
