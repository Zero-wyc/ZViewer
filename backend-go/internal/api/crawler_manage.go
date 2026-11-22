/**
 * 爬虫引擎管理接口：状态、规则 CRUD、账号、验证会话、配置与模型列表。
 *
 * 对应 Python 引擎 api.py 的管理段（agent 段在 crawler_agent.go）。桌面 GUI
 * 的「爬虫引擎」页直接调这些路径；全部优先走进程内的 localBundle，没有
 * 本地引擎时回退转发 3789。
 */
package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"zviewer/backend/internal/crawler"
	"zviewer/backend/internal/httpx"
)

// registerCrawlerManageRoutes 挂载管理路由（admin only）。
func (s *Server) registerCrawlerManageRoutes(mux *http.ServeMux) {
	admin := s.Auth.RequireDesktopOrAdmin
	mux.HandleFunc("GET /api/crawler/status", admin(s.handleCrawlerStatus))
	mux.HandleFunc("GET /api/crawler/tools", admin(s.handleCrawlerToolsGet))
	mux.HandleFunc("GET /api/crawler/rules", admin(s.handleCrawlerRulesList))
	mux.HandleFunc("POST /api/crawler/rules", admin(s.handleCrawlerRuleSave))
	mux.HandleFunc("GET /api/crawler/rules/{id}", admin(s.handleCrawlerRuleGet))
	mux.HandleFunc("PUT /api/crawler/rules/{id}", admin(s.handleCrawlerRuleUpdate))
	mux.HandleFunc("DELETE /api/crawler/rules/{id}", admin(s.handleCrawlerRuleDelete))
	mux.HandleFunc("GET /api/crawler/rules/export", admin(s.handleCrawlerRulesExport))
	mux.HandleFunc("POST /api/crawler/rules/import", admin(s.handleCrawlerRulesImport))
	mux.HandleFunc("GET /api/crawler/browser/status", admin(s.handleCrawlerBrowserStatus))
	mux.HandleFunc("POST /api/crawler/browser/open-login", admin(s.handleCrawlerBrowserOpenLogin))
	mux.HandleFunc("POST /api/crawler/browser/save-login", admin(s.handleCrawlerBrowserSaveLogin))
	mux.HandleFunc("POST /api/crawler/browser/close", admin(s.handleCrawlerBrowserClose))
	mux.HandleFunc("POST /api/crawler/browser/clear-profile", admin(s.handleCrawlerBrowserClearProfile))
	mux.HandleFunc("GET /api/crawler/submissions", admin(s.handleCrawlerSubmissions))
	mux.HandleFunc("GET /api/crawler/accounts", admin(s.handleCrawlerAccountsList))
	mux.HandleFunc("POST /api/crawler/accounts", admin(s.handleCrawlerAccountSave))
	mux.HandleFunc("GET /api/crawler/accounts/{id}", admin(s.handleCrawlerAccountGet))
	mux.HandleFunc("DELETE /api/crawler/accounts/{id}", admin(s.handleCrawlerAccountDelete))
	mux.HandleFunc("GET /api/crawler/challenges", admin(s.handleCrawlerChallenges))
	mux.HandleFunc("POST /api/crawler/challenges/clear", admin(s.handleCrawlerChallengeClear))
	mux.HandleFunc("GET /api/crawler/config", admin(s.handleCrawlerConfigGet))
	mux.HandleFunc("PUT /api/crawler/config", admin(s.handleCrawlerConfigPut))
	mux.HandleFunc("GET /api/crawler/models", admin(s.handleCrawlerModelsGet))
	mux.HandleFunc("POST /api/crawler/models", admin(s.handleCrawlerModelsPost))
}

// ---------------------------------------------------------------- 状态

func (s *Server) handleCrawlerStatus(w http.ResponseWriter, r *http.Request) {
	bundle := localBundle()
	if bundle == nil {
		s.proxyCrawlerRequest(w, r, 15*time.Second)
		return
	}
	rules := bundle.Store.List(true)
	scriptRules := 0
	for _, rule := range rules {
		if rule.Search.Mode == "script" || rule.Parse.Type == "script" {
			scriptRules++
		}
	}
	config, _ := crawler.LoadEngineConfig(bundle.Root)
	model := ""
	llmConfigured := false
	repairEnabled := true
	if config != nil {
		model = config.LLM.Model
		llmConfigured = strings.TrimSpace(config.LLM.APIKey) != ""
		if repair, ok := config.Raw["repair"].(map[string]any); ok {
			if enabled, ok := repair["enabled"].(bool); ok {
				repairEnabled = enabled
			}
		}
	}
	accounts := 0
	if bundle.Accounts != nil {
		accounts = len(bundle.Accounts.List(true))
	}
	httpx.OK(w, map[string]any{
		"success":        true,
		"engine":         "go",
		"version":        crawler.Version,
		"root":           bundle.Root,
		"rules":          len(rules),
		"scriptRules":    scriptRules,
		"accounts":       accounts,
		"llmConfigured":  llmConfigured,
		"model":          model,
		"searchLogCount": bundle.SearchLog.Count(),
		"repairEnabled":  repairEnabled,
		"browser":        bundle.Browser.Status(),
	})
}

// handleCrawlerToolsGet 列出工具集（名称/说明/入参 Schema）。
//
// 数据源就是 Agent 与 MCP 共用的那份注册表：桌面端的「MCP 工具」弹窗拿它
// 显示清单，客户端 tools/list 拿到的也是同一批——两边不会说两套话。
func (s *Server) handleCrawlerToolsGet(w http.ResponseWriter, r *http.Request) {
	bundle := localBundle()
	if bundle == nil {
		s.proxyCrawlerRequest(w, r, 15*time.Second)
		return
	}
	registry, err := bundle.Registry()
	if err != nil {
		httpx.Fail(w, http.StatusInternalServerError, "工具集不可用："+err.Error())
		return
	}
	tools := registry.MCPTools()
	httpx.OK(w, map[string]any{
		"success": true,
		"version": crawler.Version,
		"count":   len(tools),
		"tools":   tools,
	})
}

// ---------------------------------------------------------------- 规则
func (s *Server) handleCrawlerRulesList(w http.ResponseWriter, r *http.Request) {
	bundle := localBundle()
	if bundle == nil {
		s.proxyCrawlerRequest(w, r, 15*time.Second)
		return
	}
	rules := bundle.Store.List(true)
	views := make([]map[string]any, 0, len(rules))
	for _, rule := range rules {
		views = append(views, crawler.PublicView(rule, true))
	}
	httpx.OK(w, map[string]any{"success": true, "rules": views, "count": len(views)})
}

func (s *Server) handleCrawlerRuleGet(w http.ResponseWriter, r *http.Request) {
	bundle := localBundle()
	if bundle == nil {
		s.proxyCrawlerRequest(w, r, 15*time.Second)
		return
	}
	rule, err := bundle.Store.Get(r.PathValue("id"))
	if err != nil {
		writeCrawlerError(w, err)
		return
	}
	httpx.OK(w, map[string]any{"success": true, "rule": crawler.PublicView(rule, true)})
}

func (s *Server) handleCrawlerRuleSave(w http.ResponseWriter, r *http.Request) {
	bundle := localBundle()
	if bundle == nil {
		s.proxyCrawlerRequest(w, r, 30*time.Second)
		return
	}
	var body struct {
		Rule map[string]any `json:"rule"`
	}
	if err := httpx.DecodeJSON(r, &body); err != nil {
		httpx.BadRequest(w, "请求体不是有效 JSON")
		return
	}
	raw := body.Rule
	if raw == nil {
		// 也允许直接把规则对象当请求体（与 Python 的兼容分支一致）。
		var direct map[string]any
		if decodeErr := httpx.DecodeJSON(r, &direct); decodeErr == nil {
			raw = direct
		}
	}
	if raw == nil {
		httpx.BadRequest(w, "缺少规则对象")
		return
	}
	encoded, _ := json.Marshal(raw)
	var rule crawler.Rule
	if err := json.Unmarshal(encoded, &rule); err != nil {
		httpx.BadRequest(w, "规则不是合法 JSON")
		return
	}
	saved, err := bundle.Store.Save(&rule, rule.ID)
	if err != nil {
		writeCrawlerError(w, err)
		return
	}
	httpx.OK(w, map[string]any{"success": true, "rule": crawler.PublicView(saved, true)})
}

func (s *Server) handleCrawlerRuleUpdate(w http.ResponseWriter, r *http.Request) {
	bundle := localBundle()
	if bundle == nil {
		s.proxyCrawlerRequest(w, r, 30*time.Second)
		return
	}
	var body struct {
		Patch map[string]json.RawMessage `json:"patch"`
	}
	if err := httpx.DecodeJSON(r, &body); err != nil {
		httpx.BadRequest(w, "请求体不是有效 JSON")
		return
	}
	patch := body.Patch
	if len(patch) == 0 {
		var direct map[string]json.RawMessage
		if decodeErr := httpx.DecodeJSON(r, &direct); decodeErr == nil {
			patch = direct
		}
	}
	rule, err := bundle.Store.Update(r.PathValue("id"), patch)
	if err != nil {
		writeCrawlerError(w, err)
		return
	}
	httpx.OK(w, map[string]any{"success": true, "rule": crawler.PublicView(rule, true)})
}

func (s *Server) handleCrawlerRuleDelete(w http.ResponseWriter, r *http.Request) {
	bundle := localBundle()
	if bundle == nil {
		s.proxyCrawlerRequest(w, r, 15*time.Second)
		return
	}
	ruleID := r.PathValue("id")
	deleted, err := bundle.Store.Delete(ruleID)
	if err != nil {
		writeCrawlerError(w, err)
		return
	}
	if !deleted {
		httpx.Fail(w, http.StatusNotFound, "规则不存在: "+ruleID)
		return
	}
	httpx.OK(w, map[string]any{"success": true, "deleted": true, "ruleId": ruleID})
}

// ---------------------------------------------------------------- 账号

func (s *Server) handleCrawlerAccountsList(w http.ResponseWriter, r *http.Request) {
	bundle := localBundle()
	if bundle == nil || bundle.Accounts == nil {
		s.proxyCrawlerRequest(w, r, 15*time.Second)
		return
	}
	items := bundle.Accounts.List(true)
	httpx.OK(w, map[string]any{"success": true, "accounts": items, "count": len(items)})
}

func (s *Server) handleCrawlerAccountGet(w http.ResponseWriter, r *http.Request) {
	bundle := localBundle()
	if bundle == nil || bundle.Accounts == nil {
		s.proxyCrawlerRequest(w, r, 15*time.Second)
		return
	}
	account, err := bundle.Accounts.Require(r.PathValue("id"))
	if err != nil {
		writeCrawlerError(w, err)
		return
	}
	httpx.OK(w, map[string]any{"success": true, "account": crawler.PublicAccountView(account, true)})
}

func (s *Server) handleCrawlerAccountSave(w http.ResponseWriter, r *http.Request) {
	bundle := localBundle()
	if bundle == nil || bundle.Accounts == nil {
		s.proxyCrawlerRequest(w, r, 15*time.Second)
		return
	}
	var body struct {
		Account map[string]any `json:"account"`
	}
	if err := httpx.DecodeJSON(r, &body); err != nil {
		httpx.BadRequest(w, "请求体不是有效 JSON")
		return
	}
	raw := body.Account
	if raw == nil {
		var direct map[string]any
		if decodeErr := httpx.DecodeJSON(r, &direct); decodeErr == nil {
			raw = direct
		}
	}
	if raw == nil {
		httpx.BadRequest(w, "缺少账号对象")
		return
	}
	saved, err := bundle.Accounts.Save(raw)
	if err != nil {
		writeCrawlerError(w, err)
		return
	}
	httpx.OK(w, map[string]any{"success": true, "account": crawler.PublicAccountView(saved, true)})
}

func (s *Server) handleCrawlerAccountDelete(w http.ResponseWriter, r *http.Request) {
	bundle := localBundle()
	if bundle == nil || bundle.Accounts == nil {
		s.proxyCrawlerRequest(w, r, 15*time.Second)
		return
	}
	accountID := r.PathValue("id")
	if !bundle.Accounts.Delete(accountID) {
		httpx.Fail(w, http.StatusNotFound, "账号不存在: "+accountID)
		return
	}
	httpx.OK(w, map[string]any{"success": true, "deleted": true, "accountId": accountID})
}

// ---------------------------------------------------------------- 验证会话

func (s *Server) handleCrawlerChallenges(w http.ResponseWriter, r *http.Request) {
	bundle := localBundle()
	if bundle == nil {
		s.proxyCrawlerRequest(w, r, 15*time.Second)
		return
	}
	includeCompleted := r.URL.Query().Get("all")
	items := bundle.Challenges.List(includeCompleted == "1" || includeCompleted == "true" || includeCompleted == "yes")
	httpx.OK(w, map[string]any{"success": true, "challenges": items, "count": len(items)})
}

func (s *Server) handleCrawlerChallengeClear(w http.ResponseWriter, r *http.Request) {
	bundle := localBundle()
	if bundle == nil {
		s.proxyCrawlerRequest(w, r, 15*time.Second)
		return
	}
	cleared := bundle.Challenges.Clear()
	httpx.OK(w, map[string]any{"success": true, "cleared": cleared})
}

// ---------------------------------------------------------------- 配置

// crawlerConfigView 返回可以给界面看的配置（API Key 掩码 + llmConfigured）。
func crawlerConfigView(config *crawler.EngineConfig) map[string]any {
	view := map[string]any{}
	for key, value := range config.Raw {
		view[key] = value
	}
	llm, _ := view["llm"].(map[string]any)
	if llm == nil {
		llm = map[string]any{}
	}
	copied := map[string]any{}
	for key, value := range llm {
		copied[key] = value
	}
	copied["api_key"] = crawler.MaskSecret(config.LLM.APIKey)
	view["llm"] = copied
	view["llmConfigured"] = strings.TrimSpace(config.LLM.APIKey) != ""
	return view
}

func (s *Server) handleCrawlerConfigGet(w http.ResponseWriter, r *http.Request) {
	bundle := localBundle()
	if bundle == nil {
		s.proxyCrawlerRequest(w, r, 15*time.Second)
		return
	}
	config, err := crawler.LoadEngineConfig(bundle.Root)
	if err != nil {
		writeCrawlerError(w, err)
		return
	}
	httpx.OK(w, map[string]any{"success": true, "config": crawlerConfigView(config)})
}

func (s *Server) handleCrawlerConfigPut(w http.ResponseWriter, r *http.Request) {
	bundle := localBundle()
	if bundle == nil {
		s.proxyCrawlerRequest(w, r, 30*time.Second)
		return
	}
	var body map[string]any
	if err := httpx.DecodeJSON(r, &body); err != nil {
		httpx.BadRequest(w, "请求体不是有效 JSON")
		return
	}
	patch := body
	if nested, ok := body["config"].(map[string]any); ok {
		patch = nested
	}
	config, err := crawler.LoadEngineConfig(bundle.Root)
	if err != nil {
		writeCrawlerError(w, err)
		return
	}
	// 界面回传的掩码值表示「沿用已保存的 Key」，不能写回成掩码串。
	if llm, ok := patch["llm"].(map[string]any); ok {
		if value, exists := llm["api_key"]; exists {
			if text, _ := value.(string); text == "" || text == crawler.MaskSecret(config.LLM.APIKey) {
				delete(llm, "api_key")
			}
		}
	}
	merged := crawler.DeepMerge(config.Raw, patch)
	config.Raw = merged
	config.ApplyRaw(merged)
	// agent 段由 AgentConfig 决定，写回时统一从结构体生成。
	if err := config.Save(bundle.Root); err != nil {
		writeCrawlerError(w, err)
		return
	}
	httpx.OK(w, map[string]any{"success": true, "config": crawlerConfigView(config)})
}

// ---------------------------------------------------------------- 模型

func (s *Server) handleCrawlerModelsGet(w http.ResponseWriter, r *http.Request) {
	if localBundle() == nil {
		s.proxyCrawlerRequest(w, r, 30*time.Second)
		return
	}
	s.crawlerModels(w, r.Context(), r.URL.Query().Get("key"), r.URL.Query().Get("base"))
}

func (s *Server) handleCrawlerModelsPost(w http.ResponseWriter, r *http.Request) {
	if localBundle() == nil {
		s.proxyCrawlerRequest(w, r, 30*time.Second)
		return
	}
	var body struct {
		APIKey   string `json:"apiKey"`
		APIKey2  string `json:"api_key"`
		BaseURL  string `json:"baseUrl"`
		BaseURL2 string `json:"base_url"`
	}
	_ = httpx.DecodeJSON(r, &body)
	s.crawlerModels(w, r.Context(), firstString(body.APIKey, body.APIKey2), firstString(body.BaseURL, body.BaseURL2))
}

// crawlerModels 用（可临时覆盖的）Key 拉模型列表；覆盖参数用于界面「获取模型」。
func (s *Server) crawlerModels(w http.ResponseWriter, ctx context.Context, apiKey, baseURL string) {
	bundle := localBundle()
	if bundle == nil {
		httpx.Fail(w, http.StatusServiceUnavailable, "爬虫引擎未运行")
		return
	}
	config, err := crawler.LoadEngineConfig(bundle.Root)
	if err != nil {
		writeCrawlerError(w, err)
		return
	}
	llm := config.LLM
	if strings.TrimSpace(apiKey) != "" {
		llm.APIKey = strings.TrimSpace(apiKey)
	}
	if strings.TrimSpace(baseURL) != "" {
		llm.BaseURL = strings.TrimSpace(baseURL)
	}
	if strings.TrimSpace(llm.APIKey) == "" {
		httpx.Fail(w, http.StatusBadRequest, "尚未配置大模型 API Key")
		return
	}
	models, listErr := crawler.NewLLMClient(llm).ListModels(ctx)
	if listErr != nil {
		httpx.Fail(w, http.StatusBadGateway, listErr.Error())
		return
	}
	httpx.OK(w, map[string]any{"success": true, "models": models, "count": len(models)})
}

// ---------------------------------------------------------------- 规则包

func (s *Server) handleCrawlerRulesExport(w http.ResponseWriter, r *http.Request) {
	bundle := localBundle()
	if bundle == nil {
		s.proxyCrawlerRequest(w, r, 30*time.Second)
		return
	}
	ids := []string{}
	if raw := r.URL.Query().Get("ids"); raw != "" {
		ids = strings.Split(raw, ",")
	}
	payload := bundle.Store.ExportBundle(ids)
	httpx.OK(w, payload)
}

func (s *Server) handleCrawlerRulesImport(w http.ResponseWriter, r *http.Request) {
	bundle := localBundle()
	if bundle == nil {
		s.proxyCrawlerRequest(w, r, 60*time.Second)
		return
	}
	var body map[string]any
	if err := httpx.DecodeJSON(r, &body); err != nil {
		httpx.BadRequest(w, "请求体不是有效 JSON")
		return
	}
	payload := body["bundle"]
	if payload == nil {
		payload = body["rules"]
	}
	if payload == nil {
		httpx.BadRequest(w, "缺少要导入的规则")
		return
	}
	dryRun, _ := body["dryRun"].(bool)
	if !dryRun {
		dryRun, _ = body["dry_run"].(bool)
	}
	clearAccounts, _ := body["clearAccounts"].(bool)
	if !clearAccounts {
		clearAccounts, _ = body["clear_accounts"].(bool)
	}
	clearRooms, _ := body["clearRooms"].(bool)
	if !clearRooms {
		clearRooms, _ = body["clear_rooms"].(bool)
	}
	mode, _ := body["mode"].(string)
	opts := crawler.ImportOptions{
		Mode:          mode,
		DryRun:        dryRun,
		ClearAccounts: clearAccounts,
		ClearRooms:    clearRooms,
	}
	// 账号库初始化失败时 bundle.Accounts 为 nil：此时不给 HasAccount，
	// 报告就不去猜「缺账号」，避免整包规则都被打上无根据的警告。
	if bundle.Accounts != nil {
		opts.HasAccount = func(accountID string) bool {
			return bundle.Accounts.Get(accountID) != nil
		}
	}
	report, err := bundle.Store.ImportBundleWithOptions(payload, opts)
	if err != nil {
		writeCrawlerError(w, err)
		return
	}
	httpx.OK(w, report)
}

// ---------------------------------------------------------------- 浏览器

func (s *Server) handleCrawlerBrowserStatus(w http.ResponseWriter, r *http.Request) {
	bundle := localBundle()
	if bundle == nil {
		s.proxyCrawlerRequest(w, r, 15*time.Second)
		return
	}
	httpx.OK(w, map[string]any{"success": true, "browser": bundle.Browser.Status()})
}

func (s *Server) handleCrawlerBrowserOpenLogin(w http.ResponseWriter, r *http.Request) {
	bundle := localBundle()
	if bundle == nil {
		s.proxyCrawlerRequest(w, r, 120*time.Second)
		return
	}
	var body struct {
		URL string `json:"url"`
	}
	_ = httpx.DecodeJSON(r, &body)
	result, err := bundle.Browser.OpenLogin(r.Context(), body.URL)
	if err != nil {
		writeCrawlerError(w, err)
		return
	}
	httpx.OK(w, result)
}

func (s *Server) handleCrawlerBrowserSaveLogin(w http.ResponseWriter, r *http.Request) {
	bundle := localBundle()
	if bundle == nil {
		s.proxyCrawlerRequest(w, r, 60*time.Second)
		return
	}
	var body struct {
		Site string `json:"site"`
		Name string `json:"name"`
	}
	_ = httpx.DecodeJSON(r, &body)
	result, err := bundle.Browser.SaveLogin(r.Context(), body.Site, body.Name, bundle.Accounts)
	if err != nil {
		writeCrawlerError(w, err)
		return
	}
	httpx.OK(w, result)
}

func (s *Server) handleCrawlerBrowserClose(w http.ResponseWriter, r *http.Request) {
	bundle := localBundle()
	if bundle == nil {
		s.proxyCrawlerRequest(w, r, 30*time.Second)
		return
	}
	result, err := bundle.Browser.CloseBrowser(r.Context())
	if err != nil {
		writeCrawlerError(w, err)
		return
	}
	httpx.OK(w, result)
}

func (s *Server) handleCrawlerBrowserClearProfile(w http.ResponseWriter, r *http.Request) {
	bundle := localBundle()
	if bundle == nil {
		s.proxyCrawlerRequest(w, r, 30*time.Second)
		return
	}
	result, err := bundle.Browser.ClearProfile()
	if err != nil {
		writeCrawlerError(w, err)
		return
	}
	httpx.OK(w, map[string]any{"success": true, "browser": bundle.Browser.Status(), "cleared": result["cleared"]})
}

// handleCrawlerSubmissions 返回空列表。
//
// 「成员提交站点」功能已从网页端移除（只保留 agent 直接建规则），
// 但 GUI 的提交页仍会拉这个列表；返回空数组让它渲染成「暂无提交」。
func (s *Server) handleCrawlerSubmissions(w http.ResponseWriter, r *http.Request) {
	httpx.OK(w, map[string]any{"success": true, "submissions": []map[string]any{}, "count": 0})
}
