package main

// 爬虫引擎的桌面桥接（GUI 控制台 → 后端）。
//
// 引擎已并入后端进程（backend-go/internal/crawler）：规则、搜索、Agent 对话、
// 浏览器登录全部在 Go 后端里跑，不再有独立的 Python 服务与 3789 端口。
// 这里只剩三件事：
//   1. 把 GUI 的 /api/crawler/* 请求转发到后端，并带上壳内管理令牌；
//   2. 给界面提供引擎快照（根目录、规则数、配置）；
//   3. 文件级操作（规则文档读取、导出/导入对话框）。
//
// 命令名沿用「独立引擎」时期的叫法（crawler-info / crawler-api …），
// GUI 已按这些名字写死，不要改。

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

const crawlerMaxBody = 8 << 20

// crawlerBridge 把界面的请求转给后端进程内的爬虫引擎。
type crawlerBridge struct {
	root string
	app  *App

	ctx context.Context

	mu      sync.Mutex
	lastErr string
}

// newCrawlerBridge 构造桥接；app 用来取后端地址与壳内令牌（bootstrap 之后可用）。
func newCrawlerBridge(exeDir, runtimeRoot string, app *App) *crawlerBridge {
	return &crawlerBridge{
		root: resolveCrawlerRoot(exeDir, runtimeRoot),
		app:  app,
	}
}

// resolveCrawlerRoot 依次尝试环境变量、运行包内 crawler、exe 附近与工作目录。
//
// 「像不像爬虫根」的判据是 data/ 或 docs/ 子目录**存在**，必须用 dirExists：
// 早期写成 fileExists 时，传目录恒为 false，于是候选全部落空，永远返回第一个
// 候选（运行包内 runtime/crawler）。开发期跑 dist/win 时那个目录并不存在，
// 界面上就出现「未找到 crawler 目录」，而仓库根的 crawler/ 明明就在旁边。
func resolveCrawlerRoot(exeDir, runtimeRoot string) string {
	if override := strings.TrimSpace(os.Getenv("ZVIEWER_CRAWLER_ROOT")); override != "" {
		return absolute(override)
	}
	candidates := []string{
		filepath.Join(runtimeRoot, "crawler"),
		filepath.Join(exeDir, "crawler"),
	}
	// searchRoots 覆盖「exe 上溯三层 + 工作目录」，开发期正好命中仓库根的 crawler/。
	for _, base := range searchRoots(exeDir) {
		candidates = append(candidates, filepath.Join(base, "crawler"))
	}
	if wd, err := os.Getwd(); err == nil {
		candidates = append(candidates, filepath.Join(wd, "crawler"), filepath.Join(wd, "..", "crawler"))
	}
	for _, candidate := range candidates {
		if crawlerDirUsable(candidate) {
			return absolute(candidate)
		}
	}
	return absolute(candidates[0])
}

// crawlerDirUsable 判断一个目录能不能当爬虫根：有 data/ 或 docs/ 就算。
func crawlerDirUsable(dir string) bool {
	return dirExists(filepath.Join(dir, "data")) || dirExists(filepath.Join(dir, "docs"))
}

// ensureRoot 保证数据目录可用。
//
// 引擎（backend-go/internal/crawler）本来就会自建 data/rules，所以「目录不存在」
// 从来不是错误，只是没建过。这里提前建好，既能给出可读的失败原因（目录不可写），
// 也不会把「还没生成任何规则」误报成「运行包缺文件」。
func (b *crawlerBridge) ensureRoot() error {
	if crawlerDirUsable(b.root) {
		return nil
	}
	if err := os.MkdirAll(filepath.Join(b.root, "data", "rules"), 0o755); err != nil {
		return fmt.Errorf("无法创建爬虫数据目录（%s）：%w", b.root, err)
	}
	return nil
}

// backend 返回后端基础地址与壳内管理令牌。
func (b *crawlerBridge) backend() (string, string, error) {
	if b.app == nil || b.app.ctrl == nil {
		return "", "", errors.New("桌面控制台尚未初始化")
	}
	base := strings.TrimRight(b.app.ctrl.WebURL(), "/")
	if base == "" {
		return "", "", errors.New("后端地址不可用")
	}
	return base, b.app.ctrl.DesktopToken(), nil
}

// port 解析后端端口，供界面显示。
func (b *crawlerBridge) port() int {
	base, _, err := b.backend()
	if err != nil {
		return 0
	}
	parsed, err := url.Parse(base)
	if err != nil {
		return 0
	}
	port := 0
	_, _ = fmt.Sscanf(parsed.Port(), "%d", &port)
	return port
}

func (b *crawlerBridge) dialogCtx() context.Context {
	if b.ctx != nil {
		return b.ctx
	}
	return context.Background()
}

func (b *crawlerBridge) configFile() string { return filepath.Join(b.root, "config.json") }

func (b *crawlerBridge) readConfig() map[string]any {
	raw, err := os.ReadFile(b.configFile())
	if err != nil {
		return map[string]any{}
	}
	cfg := map[string]any{}
	if json.Unmarshal(raw, &cfg) != nil {
		return map[string]any{}
	}
	return cfg
}

func crawlerSection(cfg map[string]any, key string) map[string]any {
	if section, ok := cfg[key].(map[string]any); ok {
		return section
	}
	section := map[string]any{}
	cfg[key] = section
	return section
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

func (b *crawlerBridge) llmConfig() map[string]any {
	cfg := b.readConfig()
	llm := crawlerSection(cfg, "llm")
	key := crawlerString(llm, "api_key", "")
	agent := crawlerSection(cfg, "agent")
	return map[string]any{
		"baseUrl":          crawlerString(llm, "base_url", "https://api.deepseek.com/v1"),
		"model":            crawlerString(llm, "model", "deepseek-chat"),
		"reasoningEffort":  crawlerString(llm, "reasoning_effort", ""),
		"customPrompt":     crawlerString(agent, "custom_prompt", ""),
		"apiKeyConfigured": key != "",
		"apiKeyMasked":     maskCrawlerSecret(key),
	}
}

// healthy 探一次后端（只关心连通性，401/403 也说明服务在跑）。
func (b *crawlerBridge) healthy() bool {
	base, _, err := b.backend()
	if err != nil {
		return false
	}
	client := &http.Client{Timeout: 1500 * time.Millisecond}
	resp, err := client.Get(base + "/api/crawler/status")
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode > 0
}

// available 判断引擎可用：数据目录可写、后端已在运行。
func (b *crawlerBridge) available() (bool, string) {
	if err := b.ensureRoot(); err != nil {
		return false, err.Error()
	}
	if !b.healthy() {
		return false, "后端服务未运行"
	}
	return true, ""
}

func (b *crawlerBridge) ruleCount() int {
	matches, _ := filepath.Glob(filepath.Join(b.root, "data", "rules", "*.json"))
	return len(matches)
}

// crawlerRoot 给控制器用：把壳解析出的目录下发给后端（可能为空，未初始化时）。
func (a *App) crawlerRoot() string {
	if a == nil || a.crawler == nil {
		return ""
	}
	return a.crawler.root
}

// mcpInfo 给 GUI 的「MCP 工具」弹窗：客户端要填的命令、参数、目录与工具清单。
//
// 客户端其实只需要两样：可执行文件路径与 --mcp。目录与清单一并给出，
// 省得用户去翻安装目录；工具清单从后端注册表取，和客户端 tools/list 同一份。
func (a *App) mcpInfo() (any, error) {
	if a.crawler == nil {
		return map[string]any{"available": false, "reason": "桌面桥接未初始化"}, nil
	}
	// MCP 客户端拉起的是运行包里的后端本体：它在 runtime/ 下，自动能探测到 runtime/crawler。
	command := filepath.Join(a.root, "zviewer-backend.exe")
	ready, reason := a.crawler.available()
	tools := []any{}
	toolsError := ""
	if ready {
		result, err := a.crawler.do("GET", "/api/crawler/tools", nil)
		if err != nil {
			toolsError = err.Error()
		} else if status, _ := result["status"].(int); status != http.StatusOK {
			toolsError = "读取工具清单失败（HTTP " + strconv.Itoa(status) + "）"
		} else if body, ok := result["body"].(map[string]any); ok {
			if list, ok := body["tools"].([]any); ok {
				tools = list
			}
		}
	} else {
		toolsError = reason
	}
	return map[string]any{
		"available":     true,
		"engineReady":   ready,
		"reason":        reason,
		"command":       command,
		"commandExists": fileExists(command),
		"args":          []string{"--mcp"},
		"root":          a.crawler.root,
		"count":         len(tools),
		"tools":         tools,
		"toolsError":    toolsError,
	}, nil
}

// info 给界面用的快照。
func (b *crawlerBridge) info() map[string]any {
	available, reason := b.available()
	b.mu.Lock()
	lastErr := b.lastErr
	b.mu.Unlock()
	return map[string]any{
		"available": available,
		"reason":    reason,
		"root":      b.root,
		"engine":    "内置引擎（Go）",
		"running":   available,
		"starting":  false,
		"port":      b.port(),
		"ruleCount": b.ruleCount(),
		"lastError": lastErr,
		"config":    b.llmConfig(),
	}
}

// start 在引擎并入后端之后没有「单独启动」这一步：后端就是引擎。
// 保留命令是为了兼容 GUI 的启动按钮与自动拉起逻辑——按钮不能是死路，
// 后端没在跑时顺手把它拉起来，再回状态。
func (b *crawlerBridge) start() (map[string]any, error) {
	if !b.healthy() && b.app != nil && b.app.ctrl != nil {
		if _, err := b.app.ctrl.Start(); err != nil {
			return nil, err
		}
		// 进程起来到接口可响应有一小段窗口：等一会儿再判可用性，
		// 否则界面会刚点完按钮就弹「后端服务未运行」。
		for attempt := 0; attempt < 40; attempt++ {
			if b.healthy() {
				break
			}
			time.Sleep(250 * time.Millisecond)
		}
	}
	available, reason := b.available()
	if !available {
		b.mu.Lock()
		b.lastErr = reason
		b.mu.Unlock()
		return nil, errors.New(reason)
	}
	return b.info(), nil
}

// stop 同理：不能停后端（网页端还在用），只回状态。
func (b *crawlerBridge) stop() (map[string]any, error) {
	return b.info(), nil
}

// stopQuietly 是退出路径的钩子；引擎随后端退出，无需额外回收。
func (b *crawlerBridge) stopQuietly() {}

// crawlerInfo 给界面用的快照；引擎在跑时顺带带上 /api/crawler/status。
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

// do 代理一次请求到后端；返回 {"status": int, "body": map}。
//
// 只允许 /api/crawler/ 前缀，避免界面借这个通道访问其它管理接口。
func (b *crawlerBridge) do(method, path string, body any) (map[string]any, error) {
	path = strings.TrimSpace(path)
	if !strings.HasPrefix(path, "/") || strings.Contains(path, "..") {
		return nil, errors.New("无效的引擎接口路径")
	}
	if !strings.HasPrefix(path, "/api/crawler/") {
		return nil, errors.New("只允许访问爬虫引擎接口")
	}
	base, token, err := b.backend()
	if err != nil {
		return nil, err
	}
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		if len(raw) > crawlerMaxBody {
			return nil, errors.New("请求内容过大")
		}
		reader = bytes.NewReader(raw)
	}
	request, err := http.NewRequest(method, base+path, reader)
	if err != nil {
		return nil, err
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		request.Header.Set("X-Desktop-Token", token)
	}
	// Agent 对话可能跑几分钟（多步工具调用），超时给足。
	client := &http.Client{Timeout: 10 * time.Minute}
	resp, err := client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("后端服务未响应：%w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, crawlerMaxBody))
	result := map[string]any{"status": resp.StatusCode}
	if len(raw) > 0 {
		var decoded map[string]any
		if err := json.Unmarshal(raw, &decoded); err == nil {
			result["body"] = decoded
		} else {
			result["body"] = map[string]any{"raw": string(raw)}
		}
	} else {
		result["body"] = map[string]any{}
	}
	return result, nil
}

// running 供轮询使用：后端在跑就算运行中。
func (b *crawlerBridge) running() bool {
	available, _ := b.available()
	return available
}

// localRules 直接读磁盘（引擎不可用时的兜底展示）。
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
		if err == nil {
			if status, _ := result["status"].(int); status == 200 {
				if body, ok := result["body"].(map[string]any); ok {
					return body, nil
				}
			}
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

// exportRulesPath 拼导出接口路径。ids 为空走全量导出。
func exportRulesPath(ids []string) string {
	path := "/api/crawler/rules/export"
	if len(ids) > 0 {
		path += "?ids=" + url.QueryEscape(strings.Join(ids, ","))
	}
	return path
}

// exportRules 导出规则包。ids 为空表示导出全部（含停用规则）。
func (b *crawlerBridge) exportRules(ids []string) (any, error) {
	path := exportRulesPath(ids)
	result, err := b.do("GET", path, nil)
	if err != nil {
		return nil, err
	}
	status, _ := result["status"].(int)
	body, _ := result["body"].(map[string]any)
	if status != 200 {
		return nil, engineError(body)
	}
	bundle := body["bundle"]
	if bundle == nil {
		// 后端直接返回规则包本体（format/kind/rules）。
		bundle = body
	}
	raw, err := json.MarshalIndent(bundle, "", "  ")
	if err != nil {
		return nil, err
	}
	raw = append(raw, '\n')
	path, dialogErr := runtime.SaveFileDialog(b.dialogCtx(), runtime.SaveDialogOptions{
		Title:            "导出爬虫规则",
		DefaultFilename:  "crawler-rules.json",
		DefaultDirectory: downloadsDir(),
		Filters:          []runtime.FileFilter{{DisplayName: "爬虫规则（JSON）", Pattern: "*.json"}},
	})
	if dialogErr != nil || path == "" {
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

// watchChallenges 轮询人机验证会话，新会话弹托盘气泡提醒房主。
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
