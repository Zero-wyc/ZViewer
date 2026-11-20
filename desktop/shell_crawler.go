package main

// 爬虫引擎的桌面桥接：GUI 不能直连 HTTP（CSP connect-src 'none'），
// 所有配置、规则、Agent 对话都经这里转发，本机引擎进程也由这里托管。
//
// 引擎本体是 crawler/engine（Python 标准库，零第三方依赖）：
//   python -X utf8 -m engine --root <crawler 根目录> serve
// 开发期 crawler 位于仓库根；分发版应随运行包放在 runtime/crawler。

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

const crawlerMaxBody = 8 << 20

// 内置 Python（runtime/python）用的是 embeddable 发行版：只要存在 pythonXY._pth，
// 解释器就是 isolated 模式，PYTHONPATH 与当前目录都不会进 sys.path。所以不能直接
// `-m engine`，改用 -c 引导把 crawler 根目录插进去再 runpy 运行 engine 包。
// 系统 Python 仍保持原来的 `-m engine` 调用。
const crawlerEngineBootstrap = "import sys, runpy; sys.path.insert(0, sys.argv[1]); del sys.argv[1]; sys.argv[0] = 'engine'; runpy.run_module('engine', run_name='__main__', alter_sys=True)"

type crawlerBridge struct {
	root        string
	exeDir      string
	runtimeRoot string
	ctx         context.Context

	mu       sync.Mutex
	cmd      *exec.Cmd
	port     int
	starting bool
	lastErr  string
}

func newCrawlerBridge(exeDir, runtimeRoot string) *crawlerBridge {
	return &crawlerBridge{root: resolveCrawlerRoot(exeDir, runtimeRoot), exeDir: exeDir, runtimeRoot: absolute(runtimeRoot)}
}

// resolveCrawlerRoot 依次尝试环境变量、运行包内 crawler、exe 附近的 crawler。
func resolveCrawlerRoot(exeDir, runtimeRoot string) string {
	if override := strings.TrimSpace(os.Getenv("ZVIEWER_CRAWLER_ROOT")); override != "" {
		return absolute(override)
	}
	candidates := []string{filepath.Join(runtimeRoot, "crawler")}
	for _, base := range searchRoots(exeDir) {
		candidates = append(candidates, filepath.Join(base, "crawler"))
	}
	for _, dir := range candidates {
		if fileExists(filepath.Join(dir, "engine", "__main__.py")) {
			return absolute(dir)
		}
	}
	return absolute(candidates[0])
}

func (b *crawlerBridge) resolvePython() string {
	for _, key := range []string{"ZVIEWER_CRAWLER_PYTHON", "CRAWLER_PYTHON"} {
		if value := strings.TrimSpace(os.Getenv(key)); value != "" {
			if fileExists(value) {
				return value
			}
			if found, err := exec.LookPath(value); err == nil {
				return found
			}
		}
	}
	if bundled := b.bundledPython(); bundled != "" {
		return bundled
	}
	for _, name := range []string{"python.exe", "python3.exe", "python", "python3", "py.exe", "py"} {
		if found, err := exec.LookPath(name); err == nil {
			return found
		}
	}
	return ""
}

// bundledPython 返回运行包里自带的 Python（runtime/python/python.exe）。
// 桌面分享包内置 Python 3.13 embeddable，用户机器无需另装 Python。
func (b *crawlerBridge) bundledPython() string {
	for _, base := range []string{b.runtimeRoot, filepath.Join(b.exeDir, "runtime")} {
		if base == "" {
			continue
		}
		for _, name := range []string{"python.exe", "python3.exe"} {
			candidate := filepath.Join(base, "python", name)
			if fileExists(candidate) {
				return candidate
			}
		}
	}
	return ""
}

// bundledNode 返回运行包里自带的 Node.js（runtime/node/node.exe），
// 供脚本规则使用；通过 CRAWLER_NODE_BIN 传给引擎。
func (b *crawlerBridge) bundledNode() string {
	for _, base := range []string{b.runtimeRoot, filepath.Join(b.exeDir, "runtime")} {
		if base == "" {
			continue
		}
		for _, name := range []string{"node.exe", "node"} {
			candidate := filepath.Join(base, "node", name)
			if fileExists(candidate) {
				return candidate
			}
		}
	}
	return ""
}

func (b *crawlerBridge) available() (bool, string) {
	if !fileExists(filepath.Join(b.root, "engine", "__main__.py")) {
		return false, "未找到 crawler/engine 目录"
	}
	if b.resolvePython() == "" {
		return false, "未找到 Python，脚本规则与引擎都需要本机安装 Python 3"
	}
	return true, ""
}

func (b *crawlerBridge) dialogCtx() context.Context {
	if b.ctx != nil {
		return b.ctx
	}
	return context.Background()
}

func (b *crawlerBridge) configFile() string { return filepath.Join(b.root, "config.json") }

func (b *crawlerBridge) readConfig() map[string]any {
	cfg := map[string]any{}
	raw, err := os.ReadFile(b.configFile())
	if err == nil {
		_ = json.Unmarshal(raw, &cfg)
	}
	return cfg
}

func crawlerSection(cfg map[string]any, key string) map[string]any {
	if value, ok := cfg[key].(map[string]any); ok {
		return value
	}
	section := map[string]any{}
	cfg[key] = section
	return section
}

func crawlerInt(section map[string]any, key string, fallback int) int {
	if value, ok := section[key].(float64); ok && value > 0 {
		return int(value)
	}
	return fallback
}

func crawlerString(section map[string]any, key, fallback string) string {
	if value, ok := section[key].(string); ok && strings.TrimSpace(value) != "" {
		return value
	}
	return fallback
}

func maskCrawlerSecret(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	if len(value) <= 8 {
		return "已设置"
	}
	return value[:4] + "..." + value[len(value)-4:]
}

func (b *crawlerBridge) portValue() int {
	return crawlerInt(crawlerSection(b.readConfig(), "engine"), "port", 3789)
}

func (b *crawlerBridge) adminToken() string {
	return crawlerString(crawlerSection(b.readConfig(), "engine"), "admin_token", "")
}

func (b *crawlerBridge) llmConfig() map[string]any {
	llm := crawlerSection(b.readConfig(), "llm")
	key := crawlerString(llm, "api_key", "")
	submissions := crawlerSection(b.readConfig(), "submissions")
	agent := crawlerSection(b.readConfig(), "agent")
	return map[string]any{
		"baseUrl":                   crawlerString(llm, "base_url", "https://api.deepseek.com/v1"),
		"model":                     crawlerString(llm, "model", "deepseek-chat"),
		"reasoningEffort":           crawlerString(llm, "reasoning_effort", ""),
		"submissionReasoningEffort": crawlerString(submissions, "reasoning_effort", ""),
		"customPrompt":              crawlerString(agent, "custom_prompt", ""),
		"apiKeyConfigured":          key != "",
		"apiKeyMasked":              maskCrawlerSecret(key),
	}
}

func (b *crawlerBridge) baseURL() string {
	b.mu.Lock()
	port := b.port
	running := b.cmd != nil
	b.mu.Unlock()
	if !running || port == 0 {
		port = b.portValue()
	}
	return fmt.Sprintf("http://127.0.0.1:%d", port)
}

func (b *crawlerBridge) health() bool {
	client := &http.Client{Timeout: 1500 * time.Millisecond}
	resp, err := client.Get(b.baseURL() + "/health")
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<10))
	if resp.StatusCode != 200 {
		return false
	}
	// 端口上可能残留其它程序的 200，必须确认是同一个 crawler 根目录的引擎。
	var payload struct {
		Root string `json:"root"`
	}
	if json.Unmarshal(raw, &payload) == nil && payload.Root != "" {
		return strings.EqualFold(filepath.Clean(payload.Root), filepath.Clean(b.root))
	}
	return true
}

func (b *crawlerBridge) running() bool {
	b.mu.Lock()
	active := b.cmd != nil
	b.mu.Unlock()
	return active && b.health()
}

func (b *crawlerBridge) ruleCount() int {
	matches, _ := filepath.Glob(filepath.Join(b.root, "data", "rules", "*.json"))
	return len(matches)
}

// crawlerInfo 给界面用的快照；引擎在跑时顺带带上 /status，省一次往返。
func (a *App) crawlerInfo() (any, error) {
	if a.crawler == nil {
		return map[string]any{"available": false, "reason": "桌面桥接未初始化"}, nil
	}
	info := a.crawler.info()
	if running, _ := info["running"].(bool); running {
		if result, err := a.crawler.do("GET", "/api/crawler/status", nil); err == nil {
			if status, _ := result["status"].(int); status == 200 {
				if body, ok := result["body"].(map[string]any); ok {
					info["engine"] = body
				}
			}
		}
	}
	return info, nil
}

// crawlerAPI 把界面的任意引擎请求转发过去，只放行爬虫接口。
func (a *App) crawlerAPI(payload map[string]any) (any, error) {
	if a.crawler == nil {
		return nil, errors.New("桌面桥接未初始化")
	}
	method := strings.ToUpper(strings.TrimSpace(payloadString(payload, "method")))
	switch method {
	case "GET", "POST", "PUT", "DELETE":
	default:
		return nil, errors.New("不支持的请求方法")
	}
	path := payloadString(payload, "path")
	var body any
	if raw, ok := payload["body"]; ok {
		body = raw
	}
	return a.crawler.do(method, path, body)
}

func (b *crawlerBridge) info() map[string]any {
	available, reason := b.available()
	b.mu.Lock()
	starting := b.starting
	lastErr := b.lastErr
	port := b.port
	b.mu.Unlock()
	if port == 0 {
		port = b.portValue()
	}
	running := available && b.running()
	out := map[string]any{
		"available": available,
		"reason":    reason,
		"root":      b.root,
		"python":    b.resolvePython(),
		"running":   running,
		"starting":  starting,
		"port":      port,
		"ruleCount": b.ruleCount(),
		"logPath":   filepath.Join(b.root, "log", "engine.log"),
		"lastError": lastErr,
		"config":    b.llmConfig(),
	}
	return out
}

func (b *crawlerBridge) start() (map[string]any, error) {
	available, reason := b.available()
	if !available {
		return nil, errors.New(reason)
	}
	b.mu.Lock()
	if b.starting {
		b.mu.Unlock()
		return b.info(), nil
	}
	if b.cmd != nil && b.health() {
		b.mu.Unlock()
		return b.info(), nil
	}
	b.starting = true
	b.lastErr = ""
	b.mu.Unlock()
	defer func() {
		b.mu.Lock()
		b.starting = false
		b.mu.Unlock()
	}()

	// 上次 GUI 被强制结束时引擎可能还活着：先回收同一端口的旧进程，避免同时跑两个引擎。
	debugCrawler(b.root, fmt.Sprintf("start: root=%q cmdNil=%v health=%v", b.root, b.cmd == nil, b.health()))
	if b.cmd == nil && b.health() {
		port := b.portValue()
		ok := b.terminatePort(port)
		debugCrawler(b.root, fmt.Sprintf("start: terminatePort(%d)=%v healthAfter=%v", port, ok, b.health()))
		if !ok {
			return nil, fmt.Errorf("端口 %d 已被另一个爬虫引擎占用，请先结束该进程再启动", port)
		}
	}

	python := b.resolvePython()
	port := b.portValue()
	logDir := filepath.Join(b.root, "log")
	if err := os.MkdirAll(logDir, 0o755); err != nil {
		return nil, fmt.Errorf("无法创建日志目录：%w", err)
	}
	logFile, err := os.OpenFile(filepath.Join(logDir, "engine.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return nil, fmt.Errorf("无法写入引擎日志：%w", err)
	}

	var cmd *exec.Cmd
	if bundled := b.bundledPython(); bundled != "" && python == bundled {
		cmd = exec.Command(python, "-X", "utf8", "-c", crawlerEngineBootstrap, b.root, "--root", b.root, "serve")
	} else {
		cmd = exec.Command(python, "-X", "utf8", "-m", "engine", "--root", b.root, "serve")
	}
	cmd.Dir = b.root
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	if node := b.bundledNode(); node != "" && strings.TrimSpace(os.Getenv("CRAWLER_NODE_BIN")) == "" {
		cmd.Env = append(os.Environ(), "CRAWLER_NODE_BIN="+node)
	}
	hideWindow(cmd)
	if err := cmd.Start(); err != nil {
		logFile.Close()
		b.setLastErr(err.Error())
		return nil, fmt.Errorf("启动爬虫引擎失败：%w", err)
	}
	go func() {
		err := cmd.Wait()
		logFile.Close()
		b.mu.Lock()
		if b.cmd == cmd {
			b.cmd = nil
			b.port = 0
			if err != nil && !strings.Contains(err.Error(), "killed") {
				b.lastErr = "引擎已退出：" + err.Error()
			}
		}
		b.mu.Unlock()
	}()

	b.mu.Lock()
	b.cmd = cmd
	b.port = port
	b.mu.Unlock()

	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		if b.health() {
			return b.info(), nil
		}
		time.Sleep(250 * time.Millisecond)
	}
	b.stop()
	message := "引擎启动超时，请查看日志 " + filepath.Join(logDir, "engine.log")
	if tail := tailText(filepath.Join(logDir, "engine.log"), 1200); tail != "" {
		message += "\n" + tail
	}
	b.setLastErr(message)
	return nil, errors.New(message)
}

func (b *crawlerBridge) setLastErr(message string) {
	b.mu.Lock()
	b.lastErr = message
	b.mu.Unlock()
}

func tailText(path string, limit int) string {
	raw, err := os.ReadFile(path)
	if err != nil || len(raw) == 0 {
		return ""
	}
	if len(raw) > limit {
		raw = raw[len(raw)-limit:]
	}
	return strings.TrimSpace(string(raw))
}

func (b *crawlerBridge) stop() (map[string]any, error) {
	b.mu.Lock()
	cmd := b.cmd
	b.cmd = nil
	b.port = 0
	b.mu.Unlock()
	if cmd == nil || cmd.Process == nil {
		return b.info(), nil
	}
	_ = cmd.Process.Kill()
	return b.info(), nil
}

// stopQuietly 供 GUI 退出时回收引擎子进程，避免留下占用端口的孤儿进程。
func (b *crawlerBridge) stopQuietly() {
	if b == nil {
		return
	}
	_, _ = b.stop()
}

// debugCrawler 把托管诊断写进 crawler/log/bridge.log（GUI 无控制台，便于排查）。
func debugCrawler(root, message string) {
	dir := filepath.Join(root, "log")
	_ = os.MkdirAll(dir, 0o755)
	f, err := os.OpenFile(filepath.Join(dir, "bridge.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprintf(f, "%s %s\n", time.Now().Format("2006-01-02 15:04:05.000"), message)
}

// terminatePID 直接调用 Windows API 结束进程；taskkill 对残留的子进程有时会失败。
func terminatePID(text string) bool {
	pid, err := strconv.Atoi(text)
	if err != nil || pid <= 0 {
		return false
	}
	handle, err := syscall.OpenProcess(0x0001, false, uint32(pid)) // PROCESS_TERMINATE
	if err != nil {
		return false
	}
	defer syscall.CloseHandle(handle)
	return syscall.TerminateProcess(handle, 1) == nil
}

// terminatePort 结束监听指定端口的旧引擎（例如强制结束 GUI 后残留的进程）。
func (b *crawlerBridge) terminatePort(port int) bool {
	out, err := exec.Command("netstat", "-ano").Output()
	if err == nil {
		suffix := fmt.Sprintf(":%d", port)
		for _, line := range strings.Split(string(out), "\n") {
			fields := strings.Fields(line)
			if len(fields) < 5 || !strings.HasSuffix(fields[1], suffix) || fields[3] != "LISTENING" {
				continue
			}
			killed := terminatePID(fields[4])
			debugCrawler(b.root, fmt.Sprintf("terminatePort: pid=%s killed=%v", fields[4], killed))
		}
	}
	deadline := time.Now().Add(4 * time.Second)
	for time.Now().Before(deadline) {
		if !b.health() {
			return true
		}
		time.Sleep(150 * time.Millisecond)
	}
	return !b.health()
}

// watchChallenges 轮询待处理的人工验证：弹 Windows 通知并通知界面刷新。
// 引擎是本地 HTTP 服务，这里不依赖爬虫页是否打开。
func (a *App) watchChallenges() {
	if a.crawler == nil {
		return
	}
	seen := map[string]bool{}
	first := true
	for {
		time.Sleep(8 * time.Second)
		if !a.crawler.running() {
			continue
		}
		result, err := a.crawler.do("GET", "/api/crawler/challenges", nil)
		if err != nil {
			a.ctrl.Log("轮询人机验证失败："+err.Error(), "crawler", "WARN")
			continue
		}
		body, _ := result["body"].(map[string]any)
		items, _ := body["challenges"].([]any)
		for _, raw := range items {
			item, _ := raw.(map[string]any)
			id, _ := item["id"].(string)
			if id == "" || seen[id] {
				continue
			}
			seen[id] = true
			if first {
				continue
			}
			a.notifyChallenge(item)
		}
		first = false
	}
}

var crawlerToastOnce sync.Once

func (a *App) notifyChallenge(item map[string]any) {
	if a.ctx != nil {
		runtime.EventsEmit(a.ctx, "crawler-challenge", item)
	}
	name, _ := item["name"].(string)
	if name == "" {
		name, _ = item["site"].(string)
	}
	reason, _ := item["reason"].(string)
	if reason == "" {
		reason = "网站要求完成人机验证"
	}
	note, _ := item["note"].(string)
	body := name + "：" + reason
	if note != "" && len([]rune(note)) < 80 {
		body = name + "：" + note
	}
	a.ctrl.Log("站点需要人工验证："+name+"（"+reason+"）", "crawler", "WARN")
	if a.tray != nil {
		a.tray.balloon("一起看站点需要人工验证", body+"（打开控制台 → 爬虫引擎 → 人机验证）")
	}
}

// do 代理一次引擎 HTTP 请求；返回 status + 解析后的 JSON。
func (b *crawlerBridge) do(method, path string, body any) (map[string]any, error) {
	path = strings.TrimSpace(path)
	if !strings.HasPrefix(path, "/") || strings.Contains(path, "..") {
		return nil, errors.New("无效的引擎接口路径")
	}
	if !strings.HasPrefix(path, "/api/crawler/") && path != "/health" {
		return nil, errors.New("只允许访问爬虫引擎接口")
	}
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reader = bytes.NewReader(raw)
	}
	request, err := http.NewRequest(method, b.baseURL()+path, reader)
	if err != nil {
		return nil, err
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if token := b.adminToken(); token != "" {
		request.Header.Set("X-Admin-Token", token)
	}
	client := &http.Client{Timeout: 180 * time.Second}
	resp, err := client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("引擎未响应：%w", err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, crawlerMaxBody))
	if err != nil {
		return nil, err
	}
	parsed := map[string]any{}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &parsed); err != nil {
			parsed = map[string]any{"success": false, "error": strings.TrimSpace(string(raw))}
		}
	}
	return map[string]any{"status": resp.StatusCode, "body": parsed}, nil
}

// localRules 在引擎未运行时直接读规则文件，至少让界面能查看已保存站点。
func (b *crawlerBridge) localRules() ([]any, error) {
	matches, err := filepath.Glob(filepath.Join(b.root, "data", "rules", "*.json"))
	if err != nil {
		return nil, err
	}
	rules := make([]any, 0, len(matches))
	for _, file := range matches {
		raw, err := os.ReadFile(file)
		if err != nil {
			continue
		}
		rule := map[string]any{}
		if err := json.Unmarshal(raw, &rule); err != nil {
			continue
		}
		rules = append(rules, rule)
	}
	sort.SliceStable(rules, func(i, j int) bool {
		left, _ := rules[i].(map[string]any)
		right, _ := rules[j].(map[string]any)
		return fmt.Sprint(left["updated_at"]) > fmt.Sprint(right["updated_at"])
	})
	return rules, nil
}

func (b *crawlerBridge) rules() (map[string]any, error) {
	if b.running() {
		result, err := b.do("GET", "/api/crawler/rules", nil)
		if err != nil {
			return nil, err
		}
		if status, _ := result["status"].(int); status == 200 {
			return result["body"].(map[string]any), nil
		}
	}
	rules, err := b.localRules()
	if err != nil {
		return nil, err
	}
	return map[string]any{"success": true, "rules": rules, "count": len(rules), "source": "local"}, nil
}

// docs 读取规则文档（crawler/docs/engine.md），供 GUI 的「规则文档」弹窗展示。
// 分享包不一定带 docs 目录：读不到文件时回退到编译进 EXE 的内置文档，保证弹窗始终能打开。
func (b *crawlerBridge) docs() (map[string]any, error) {
	path := filepath.Join(b.root, "docs", "engine.md")
	if data, err := os.ReadFile(path); err == nil {
		return map[string]any{"content": string(data), "path": "crawler/docs/engine.md"}, nil
	}
	if strings.TrimSpace(embeddedCrawlerDocs) != "" {
		return map[string]any{"content": embeddedCrawlerDocs, "path": "内置文档（crawler/docs/engine.md）"}, nil
	}
	return nil, fmt.Errorf("规则文档不存在：%s", path)
}

func (b *crawlerBridge) saveLLM(payload map[string]any) (map[string]any, error) {
	llm := map[string]any{}
	if value := payloadString(payload, "baseUrl"); value != "" {
		llm["base_url"] = value
	}
	if value := payloadString(payload, "model"); value != "" {
		llm["model"] = value
	}
	if value := payloadString(payload, "apiKey"); value != "" {
		llm["api_key"] = value
	}
	if raw, ok := payload["reasoningEffort"]; ok {
		llm["reasoning_effort"] = strings.TrimSpace(fmt.Sprint(raw))
	}
	patch := map[string]any{}
	if len(llm) > 0 {
		patch["llm"] = llm
	}
	if raw, ok := payload["submissionReasoningEffort"]; ok {
		patch["submissions"] = map[string]any{"reasoning_effort": strings.TrimSpace(fmt.Sprint(raw))}
	}
	if raw, ok := payload["customPrompt"]; ok {
		text := strings.TrimSpace(fmt.Sprint(raw))
		if runes := []rune(text); len(runes) > 4000 {
			text = string(runes[:4000])
		}
		patch["agent"] = map[string]any{"custom_prompt": text}
	}
	if len(patch) == 0 {
		return b.llmConfig(), nil
	}
	if b.running() {
		result, err := b.do("PUT", "/api/crawler/config", map[string]any{"config": patch})
		if err != nil {
			return nil, err
		}
		status, _ := result["status"].(int)
		body, _ := result["body"].(map[string]any)
		if status != 200 {
			return nil, engineError(body)
		}
		return b.llmConfig(), nil
	}
	cfg := b.readConfig()
	for sectionName, rawSection := range patch {
		section, _ := rawSection.(map[string]any)
		target := crawlerSection(cfg, sectionName)
		for key, value := range section {
			target[key] = value
		}
	}
	if err := b.writeConfig(cfg); err != nil {
		return nil, err
	}
	return b.llmConfig(), nil
}

func (b *crawlerBridge) writeConfig(cfg map[string]any) error {
	if err := os.MkdirAll(b.root, 0o755); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	raw = append(raw, '\n')
	tmp := b.configFile() + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, b.configFile())
}

func engineError(body map[string]any) error {
	if body == nil {
		return errors.New("引擎请求失败")
	}
	if message, _ := body["error"].(string); message != "" {
		return errors.New(message)
	}
	return errors.New("引擎请求失败")
}

func (b *crawlerBridge) exportRules() (any, error) {
	result, err := b.do("GET", "/api/crawler/rules/export", nil)
	if err != nil {
		return nil, err
	}
	status, _ := result["status"].(int)
	body, _ := result["body"].(map[string]any)
	if status != 200 {
		return nil, engineError(body)
	}
	bundle := body["bundle"]
	raw, err := json.MarshalIndent(bundle, "", "  ")
	if err != nil {
		return nil, err
	}
	raw = append(raw, '\n')
	path, err := runtime.SaveFileDialog(b.dialogCtx(), runtime.SaveDialogOptions{
		Title:            "导出爬虫规则",
		DefaultFilename:  "crawler-rules.json",
		DefaultDirectory: downloadsDir(),
		Filters:          []runtime.FileFilter{{DisplayName: "爬虫规则（JSON）", Pattern: "*.json"}},
	})
	if err != nil || path == "" {
		return map[string]any{"canceled": true}, nil
	}
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		return nil, fmt.Errorf("无法写入文件：%w", err)
	}
	count := 0
	if value, ok := body["count"].(float64); ok {
		count = int(value)
	}
	return map[string]any{"canceled": false, "path": path, "count": count}, nil
}

func (b *crawlerBridge) importRules(mode string, dryRun bool) (any, error) {
	path, err := runtime.OpenFileDialog(b.dialogCtx(), runtime.OpenDialogOptions{
		Title:            "导入爬虫规则",
		DefaultDirectory: downloadsDir(),
		Filters:          []runtime.FileFilter{{DisplayName: "爬虫规则（JSON）", Pattern: "*.json"}},
	})
	if err != nil {
		return nil, err
	}
	if path == "" {
		return map[string]any{"canceled": true}, nil
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, fmt.Errorf("无法读取文件：%w", err)
	}
	if info.Size() > crawlerMaxBody {
		return nil, errors.New("规则文件不能超过 8 MB")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("无法读取文件：%w", err)
	}
	var bundle any
	if err := json.Unmarshal(raw, &bundle); err != nil {
		return nil, fmt.Errorf("规则文件不是有效 JSON：%w", err)
	}
	if mode == "" {
		mode = "merge"
	}
	result, err := b.do("POST", "/api/crawler/rules/import", map[string]any{
		"bundle": bundle, "mode": mode, "dryRun": dryRun,
	})
	if err != nil {
		return nil, err
	}
	status, _ := result["status"].(int)
	body, _ := result["body"].(map[string]any)
	if status != 200 {
		return nil, engineError(body)
	}
	body["name"] = filepath.Base(path)
	return body, nil
}
