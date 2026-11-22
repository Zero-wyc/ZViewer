package crawler

// 引擎装配：把规则库、抓取器、脚本运行时、搜索、解析、账号、浏览器与 Agent
// 组装成一个可复用的 Runtime。
//
// 为什么要单独抽这一层：这套装配原来只写在 internal/api 里（进程内的网页搜索），
// 现在 MCP stdio 入口（cmd/zviewer-server --mcp）也要同一套东西。让 MCP 去 import
// internal/api 既违反分层（服务层不得依赖 api），也会把整个 HTTP 栈拖进一个只讲
// JSON-RPC 的进程。

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Version 是引擎版本号：/api/crawler/status 与 MCP 的 serverInfo 共用一份，
// 免得两边各写一个字符串，发版时只改一处。
const Version = "0.2.0"

// Runtime 是一套装配好的引擎。字段全部导出，调用方按需取用。
type Runtime struct {
	Root       string
	Store      *RuleStore
	Fetcher    *Fetcher
	JS         JSRunner
	SearchLog  *SearchLogStore
	Accounts   *AccountStore
	Search     *SearchService
	Play       *PlayResolver
	Challenges *ChallengeStore
	Browser    *Browser

	// agent 与 registry 都是惰性构建：config.json 的 mtime 变了就重建，
	// 这样 GUI 改完 Key/提示词不必重启进程。会话管理器保留原对象，
	// 已在执行的对话不受影响。
	agentMu  sync.Mutex
	agent    *RuleAgent
	registry *ToolRegistry
	runs     *AgentRunManager
	agentMod time.Time
}

// Boot 按根目录装配引擎。root 下通常有 config.json 与 data/。
func Boot(root string) (*Runtime, error) {
	store, err := NewRuleStore(filepath.Join(root, "data", "rules"))
	if err != nil {
		return nil, err
	}
	fetcher := NewFetcher(FetcherOptions{
		Timeout: 25 * time.Second,
		Retries: 1,
	})
	js := NewJSRunner(fetcher)
	logStore, _ := NewSearchLogStore(
		filepath.Join(root, "data", "search-log.json"),
		DefaultSearchLogLimit,
	)
	// 账号库：规则的 search.account_id / play.account_id 在这里解析成 Cookie。
	accounts, err := NewAccountStore(filepath.Join(root, "data", "accounts.json"))
	if err != nil {
		accounts = nil
	}
	search := NewSearchService(SearchOptions{
		Store:    store,
		Fetcher:  fetcher,
		Log:      logStore,
		Accounts: accounts,
	})
	search.SetJSRuntime(js)
	play := NewPlayResolver(PlayOptions{
		Store:    store,
		Fetcher:  fetcher,
		JS:       js,
		Accounts: accounts,
	})
	// 离屏浏览器：反爬/JS 渲染站点的最终兜底。二进制找不到时 Available() 为 false，
	// PlayResolver 会自动跳过这一步。
	browser := NewBrowser(BrowserOptions{
		ProfileDir: filepath.Join(root, "data", "browser-profile"),
		Headless:   true,
	})
	play.SetBrowser(browser)
	challenges := NewChallengeStore(0, 0)
	search.SetChallengeSessions(challenges)

	return &Runtime{
		Root:       root,
		Store:      store,
		Fetcher:    fetcher,
		JS:         js,
		SearchLog:  logStore,
		Accounts:   accounts,
		Search:     search,
		Play:       play,
		Challenges: challenges,
		Browser:    browser,
	}, nil
}

// Agent 返回（惰性构建的）规则 Agent 与会话管理器。
func (r *Runtime) Agent() (*RuleAgent, *AgentRunManager, error) {
	agent, runs, _, err := r.agentBundle()
	return agent, runs, err
}

// Registry 返回 Agent 用的工具集（含 generate_rule）。
func (r *Runtime) Registry() (*ToolRegistry, error) {
	_, _, registry, err := r.agentBundle()
	return registry, err
}

// agentBundle 是惰性构建的唯一实现：三者要么一起建好，要么一起返回错误。
//
// 工具集里一定带 generate_rule：没有 LLM Key 时它也会注册，调用时才报
// 「未配置模型」——这样 MCP 客户端能列出完整工具表，而不是缺一项。
func (r *Runtime) agentBundle() (*RuleAgent, *AgentRunManager, *ToolRegistry, error) {
	r.agentMu.Lock()
	defer r.agentMu.Unlock()

	configPath := filepath.Join(r.Root, "config.json")
	mod := time.Time{}
	if info, err := os.Stat(configPath); err == nil {
		mod = info.ModTime()
	}
	if r.agent != nil && mod.Equal(r.agentMod) {
		return r.agent, r.runs, r.registry, nil
	}
	config, err := LoadEngineConfig(r.Root)
	if err != nil {
		return nil, nil, nil, err
	}
	registry := BuildRegistry(ToolOptions{
		Store:     r.Store,
		Search:    r.Search,
		Fetcher:   r.Fetcher,
		Play:      r.Play,
		SearchLog: r.SearchLog,
		Accounts:  r.Accounts,
		Browser:   r.Browser,
	})
	agent, err := NewRuleAgent(
		NewLLMClient(config.LLM), registry, r.Store, r.Search,
		config.Agent, filepath.Join(r.Root, "data"),
	)
	if err != nil {
		return nil, nil, nil, err
	}
	// generate_rule 依赖 agent 本体，注册表先建、工具后补（与 Python 装配一致）。
	registry.Register(&Tool{
		Name:        "generate_rule",
		Description: "让大模型访问站点、自动生成搜索与解析规则；生成后会试搜并在成功时保存。",
		Schema: SchemaObject(map[string]any{
			"url":     StrProp("站点首页或搜索页 URL"),
			"keyword": StrProp("试搜关键词"),
			"notes":   StrProp("额外要求"),
		}, "url"),
		Handler: func(ctx context.Context, args map[string]any) (map[string]any, error) {
			return agent.Generate(ctx, ArgString(args, "url"),
				ArgString(args, "keyword"), ArgString(args, "notes"), "")
		},
	})
	if r.runs == nil {
		r.runs = NewAgentRunManager()
	}
	r.agent = agent
	r.registry = registry
	r.agentMod = mod
	return r.agent, r.runs, r.registry, nil
}

// ResolveRoot 探测爬虫根目录（其下有 data/rules 或 docs）。
//
// 优先级：CRAWLER_ROOT → ZVIEWER_CRAWLER_ROOT（桌面壳注入）→
// exe 同级 crawler/ 或 runtime/crawler/ → 工作目录 crawler/ 及上一级。
// 都没有则返回空字符串，调用方自行决定是回退还是报错。
func ResolveRoot() string {
	for _, name := range []string{"CRAWLER_ROOT", "ZVIEWER_CRAWLER_ROOT"} {
		if value := strings.TrimSpace(os.Getenv(name)); value != "" {
			return value
		}
	}
	candidates := make([]string, 0, 4)
	if exe, err := os.Executable(); err == nil {
		dir := filepath.Dir(exe)
		candidates = append(candidates,
			filepath.Join(dir, "crawler"),
			filepath.Join(dir, "runtime", "crawler"),
		)
	}
	if wd, err := os.Getwd(); err == nil {
		candidates = append(candidates,
			filepath.Join(wd, "crawler"),
			filepath.Join(wd, "..", "crawler"),
		)
	}
	for _, candidate := range candidates {
		if info, err := os.Stat(candidate); err == nil && info.IsDir() {
			return candidate
		}
	}
	return ""
}

// UseDefaultRoot 在没有可用爬虫目录时，把 <configDir>/crawler 立为默认根。
//
// 单文件包与 Docker 镜像只带二进制和前端静态文件，没有 crawler/ 目录，于是
// ResolveRoot 一无所获、localBundle 返回 nil，全网搜片表现为「引擎未运行」。
// 缺的其实不是引擎（引擎就在后端进程里），而是「放规则的地方」——规则只是
// 一堆 JSON。这里按 CONFIG_DIR 兜底，让三种部署都能「导入规则即可搜」：
// Docker 的 /app/config 是数据卷，规则随容器升级保留；单文件包则是 exe 旁
// 的 config/crawler。
//
// 显式配置（CRAWLER_ROOT / ZVIEWER_CRAWLER_ROOT）与已存在的 crawler/ 一律
// 尊重，不会把老安装的规则搬走；只有「哪儿都找不到」时才建默认目录。
// 返回最终使用的根目录；目录建不出来时返回错误，调用方降级为引擎不可用。
func UseDefaultRoot(configDir string) (string, error) {
	if root := ResolveRoot(); root != "" {
		return root, nil
	}
	if strings.TrimSpace(configDir) == "" {
		return "", fmt.Errorf("未指定配置目录，无法确定爬虫规则目录")
	}
	root := filepath.Join(configDir, "crawler")
	// CONFIG_DIR 可能是相对路径（Docker 里就是 "config"）：规则根会往下发到
	// MCP 子进程与日志里，绝对路径才不会被后续 cwd 变化带偏。
	if abs, absErr := filepath.Abs(root); absErr == nil {
		root = abs
	}
	if err := os.MkdirAll(filepath.Join(root, "data", "rules"), 0o755); err != nil {
		return "", fmt.Errorf("创建爬虫规则目录失败（%s）：%w", root, err)
	}
	// 写回环境变量而不是只返回：ResolveRoot 是进程内唯一取根入口，
	// 首次请求（localBundle）、/api/crawler/status、MCP 子进程都按它取值。
	if err := os.Setenv("CRAWLER_ROOT", root); err != nil {
		return "", err
	}
	return root, nil
}

// EnsureRoot 解析根目录并准备好它（不存在就建）。
//
// MCP 是独立进程，缺目录不是「运行包不完整」，而是配置错了：
// 报错要能直接告诉用户该指定什么，而不是让他去猜。
func EnsureRoot() (string, error) {
	root := ResolveRoot()
	if root == "" {
		return "", fmt.Errorf("未找到爬虫目录：请用 --root 指定，或设置 ZVIEWER_CRAWLER_ROOT 指向含 data/rules 的目录")
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		return "", fmt.Errorf("爬虫目录不可用（%s）：%w", root, err)
	}
	return root, nil
}
