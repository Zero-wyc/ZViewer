/**
 * 本机爬虫引擎（Go 实现）。
 *
 * 全网搜片的站点列表与搜索现在直接由后端进程内的 internal/crawler 完成，
 * 不再需要 127.0.0.1:3789 上的 Python 进程。规则仍存在 crawler/data/rules，
 * 与桌面端「爬虫引擎」管理页（Python/后续 Go 版）共用同一批文件。
 *
 * 回退：找不到爬虫根目录时 localCrawler() 返回 nil，调用方沿用原来的 3789 转发，
 * 这样老安装（只有 runtime/crawler/engine、没有 data）也不会突然搜不了。
 */
package api

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"zviewer/backend/internal/crawler"
	"zviewer/backend/internal/httpx"
)

var (
	crawlerMu       sync.Mutex
	crawlerResolved bool
	crawlerBundle   *localCrawlerBundle
)

// localCrawlerBundle 把搜索、播放解析与 LLM agent 放在一起，
// 共享 store / fetcher / goja 运行时 / 离屏浏览器。
type localCrawlerBundle struct {
	root      string
	store     *crawler.RuleStore
	search    *crawler.SearchService
	play      *crawler.PlayResolver
	challenge *crawler.ChallengeStore
	fetcher   *crawler.Fetcher
	js        crawler.JSRunner
	logStore  *crawler.SearchLogStore
	browser   *crawler.Browser
	accounts  *crawler.AccountStore

	// agent 按 config.json 的修改时间惰性构建：GUI 改完 Key/提示词
	// 不需要重启后端，下一次请求自动用新配置。
	agentMu   sync.Mutex
	agent     *crawler.RuleAgent
	agentRuns *crawler.AgentRunManager
	agentMod  time.Time
}

// crawlerRoot 找爬虫根目录（其下有 data/rules）。
//
// 优先级：CRAWLER_ROOT → ZVIEWER_CRAWLER_ROOT（桌面壳注入）→ exe 同级
// crawler/ 或 runtime/crawler/ → 工作目录 crawler/。都没有则返回空。
func crawlerRoot() string {
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

// localBundle 返回进程内的引擎；没有可用规则目录时返回 nil。
//
// 单例是刻意的：规则目录、搜索日志、脚本运行时都是进程级资源，
// 每个请求重建会丢日志并反复初始化 goja。
func localBundle() *localCrawlerBundle {
	crawlerMu.Lock()
	defer crawlerMu.Unlock()
	if crawlerResolved {
		return crawlerBundle
	}
	crawlerResolved = true

	root := crawlerRoot()
	if root == "" {
		return nil
	}
	store, err := crawler.NewRuleStore(filepath.Join(root, "data", "rules"))
	if err != nil {
		return nil
	}
	fetcher := crawler.NewFetcher(crawler.FetcherOptions{
		Timeout: 25 * time.Second,
		Retries: 1,
	})
	js := crawler.NewJSRunner(fetcher)
	logStore, _ := crawler.NewSearchLogStore(
		filepath.Join(root, "data", "search-log.json"),
		crawler.DefaultSearchLogLimit,
	)
	// 账号库：规则的 search.account_id / play.account_id 在这里解析成 Cookie。
	accounts, err := crawler.NewAccountStore(filepath.Join(root, "data", "accounts.json"))
	if err != nil {
		accounts = nil
	}
	search := crawler.NewSearchService(crawler.SearchOptions{
		Store:    store,
		Fetcher:  fetcher,
		Log:      logStore,
		Accounts: accounts,
	})
	search.SetJSRuntime(js)
	play := crawler.NewPlayResolver(crawler.PlayOptions{
		Store:    store,
		Fetcher:  fetcher,
		JS:       js,
		Accounts: accounts,
	})
	// 离屏浏览器：反爬/JS 渲染站点的最终兜底。二进制找不到时 Available() 为 false，
	// PlayResolver 会自动跳过这一步。
	browser := crawler.NewBrowser(crawler.BrowserOptions{
		ProfileDir: filepath.Join(root, "data", "browser-profile"),
		Headless:   true,
	})
	play.SetBrowser(browser)
	challenges := crawler.NewChallengeStore(0, 0)
	search.SetChallengeSessions(challenges)
	crawlerBundle = &localCrawlerBundle{
		root:      root,
		store:     store,
		search:    search,
		play:      play,
		challenge: challenges,
		fetcher:   fetcher,
		js:        js,
		logStore:  logStore,
		browser:   browser,
		accounts:  accounts,
	}
	return crawlerBundle
}

// localCrawler 返回进程内的搜索服务；没有可用规则目录时返回 nil。
func localCrawler() *crawler.SearchService {
	if bundle := localBundle(); bundle != nil {
		return bundle.search
	}
	return nil
}

// localPlayResolver 返回进程内的播放解析器；没有可用规则目录时返回 nil。
func localPlayResolver() *crawler.PlayResolver {
	if bundle := localBundle(); bundle != nil {
		return bundle.play
	}
	return nil
}

// localChallengeStore 返回进程内的验证会话表；没有可用规则目录时返回 nil。
func localChallengeStore() *crawler.ChallengeStore {
	if bundle := localBundle(); bundle != nil {
		return bundle.challenge
	}
	return nil
}

// localAgent 返回进程内的 LLM agent 与 run 管理器。
//
// config.json 比上次构建新（或还没构建过）就重建 agent——LLMClient 与
// RuleAgent 都是无状态轻对象，重建成本可以忽略；run 管理器保留原对象，
// 已在执行的对话不受影响。
func (b *localCrawlerBundle) localAgent() (*crawler.RuleAgent, *crawler.AgentRunManager, error) {
	b.agentMu.Lock()
	defer b.agentMu.Unlock()
	configPath := filepath.Join(b.root, "config.json")
	mod := time.Time{}
	if info, err := os.Stat(configPath); err == nil {
		mod = info.ModTime()
	}
	if b.agent != nil && mod.Equal(b.agentMod) {
		return b.agent, b.agentRuns, nil
	}
	config, err := crawler.LoadEngineConfig(b.root)
	if err != nil {
		return nil, nil, err
	}
	registry := crawler.BuildRegistry(crawler.ToolOptions{
		Store:     b.store,
		Search:    b.search,
		Fetcher:   b.fetcher,
		Play:      b.play,
		SearchLog: b.logStore,
		Accounts:  b.accounts,
		Browser:   b.browser,
	})
	agent, err := crawler.NewRuleAgent(
		crawler.NewLLMClient(config.LLM), registry, b.store, b.search,
		config.Agent, filepath.Join(b.root, "data"),
	)
	if err != nil {
		return nil, nil, err
	}
	// generate_rule 依赖 agent 本体，注册表先建、工具后补（与 Python 装配一致）。
	registry.Register(&crawler.Tool{
		Name:        "generate_rule",
		Description: "让大模型访问站点、自动生成搜索与解析规则；生成后会试搜并在成功时保存。",
		Schema: crawler.SchemaObject(map[string]any{
			"url":     crawler.StrProp("站点首页或搜索页 URL"),
			"keyword": crawler.StrProp("试搜关键词"),
			"notes":   crawler.StrProp("额外要求"),
		}, "url"),
		Handler: func(ctx context.Context, args map[string]any) (map[string]any, error) {
			return agent.Generate(ctx, crawler.ArgString(args, "url"),
				crawler.ArgString(args, "keyword"), crawler.ArgString(args, "notes"), "")
		},
	})
	if b.agentRuns == nil {
		b.agentRuns = crawler.NewAgentRunManager()
	}
	b.agent = agent
	b.agentMod = mod
	return agent, b.agentRuns, nil
}

// resetLocalCrawler 仅供测试：丢掉单例，下次调用重新探测目录。
func resetLocalCrawler() {
	crawlerMu.Lock()
	defer crawlerMu.Unlock()
	crawlerResolved = false
	crawlerBundle = nil
}

// crawlerErrorStatus 把引擎错误码映射成 HTTP 状态。
//
// challenge_required 用 409（与 Python 引擎一致），前端据此弹验证窗；
// 参数/规则类错误是 400，上游抓取失败是 502，其余 500。
func crawlerErrorStatus(code string) int {
	switch code {
	case "challenge_required":
		return 409
	case "site_required", "keyword_required", "site_not_found", "site_forbidden", "rule_error":
		return 400
	case "fetch_error":
		return 502
	case "llm_error", "config_error":
		return 500
	default:
		return 500
	}
}

// writeCrawlerError 把引擎错误写成前端认识的形状。
//
// challenge_required 必须原样带 details（challengeId / proxyUrl 在 details 里），
// 前端靠它渲染验证 iframe；其它错误走 message 兜底即可。
func writeCrawlerError(w http.ResponseWriter, err error) {
	engineErr, ok := err.(*crawler.EngineError)
	if !ok {
		httpx.InternalError(w, "crawler", err)
		return
	}
	if engineErr.Code == "challenge_required" {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusConflict)
		_ = json.NewEncoder(w).Encode(engineErr.ToMap())
		return
	}
	httpx.Fail(w, crawlerErrorStatus(engineErr.Code), engineErr.Message)
}
