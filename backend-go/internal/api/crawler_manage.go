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
	admin := s.Auth.RequireAdmin
	mux.HandleFunc("GET /api/crawler/status", admin(s.handleCrawlerStatus))
	mux.HandleFunc("GET /api/crawler/rules", admin(s.handleCrawlerRulesList))
	mux.HandleFunc("POST /api/crawler/rules", admin(s.handleCrawlerRuleSave))
	mux.HandleFunc("GET /api/crawler/rules/{id}", admin(s.handleCrawlerRuleGet))
	mux.HandleFunc("PUT /api/crawler/rules/{id}", admin(s.handleCrawlerRuleUpdate))
	mux.HandleFunc("DELETE /api/crawler/rules/{id}", admin(s.handleCrawlerRuleDelete))
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
	rules := bundle.store.List(true)
	scriptRules := 0
	for _, rule := range rules {
		if rule.Search.Mode == "script" || rule.Parse.Type == "script" {
			scriptRules++
		}
	}
	config, _ := crawler.LoadEngineConfig(bundle.root)
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
	if bundle.accounts != nil {
		accounts = len(bundle.accounts.List(true))
	}
	httpx.OK(w, map[string]any{
		"success":        true,
		"engine":         "go",
		"version":        "0.2.0",
		"root":           bundle.root,
		"rules":          len(rules),
		"scriptRules":    scriptRules,
		"accounts":       accounts,
		"llmConfigured":  llmConfigured,
		"model":          model,
		"searchLogCount": 0,
		"repairEnabled":  repairEnabled,
		"browser":        bundle.browser.Status(),
	})
}

// ---------------------------------------------------------------- 规则

func (s *Server) handleCrawlerRulesList(w http.ResponseWriter, r *http.Request) {
	bundle := localBundle()
	if bundle == nil {
		s.proxyCrawlerRequest(w, r, 15*time.Second)
		return
	}
	rules := bundle.store.List(true)
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
	rule, err := bundle.store.Get(r.PathValue("id"))
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
	saved, err := bundle.store.Save(&rule, rule.ID)
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
	rule, err := bundle.store.Update(r.PathValue("id"), patch)
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
	deleted, err := bundle.store.Delete(ruleID)
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
	if bundle == nil || bundle.accounts == nil {
		s.proxyCrawlerRequest(w, r, 15*time.Second)
		return
	}
	items := bundle.accounts.List(true)
	httpx.OK(w, map[string]any{"success": true, "accounts": items, "count": len(items)})
}

func (s *Server) handleCrawlerAccountGet(w http.ResponseWriter, r *http.Request) {
	bundle := localBundle()
	if bundle == nil || bundle.accounts == nil {
		s.proxyCrawlerRequest(w, r, 15*time.Second)
		return
	}
	account, err := bundle.accounts.Require(r.PathValue("id"))
	if err != nil {
		writeCrawlerError(w, err)
		return
	}
	httpx.OK(w, map[string]any{"success": true, "account": crawler.PublicAccountView(account, true)})
}

func (s *Server) handleCrawlerAccountSave(w http.ResponseWriter, r *http.Request) {
	bundle := localBundle()
	if bundle == nil || bundle.accounts == nil {
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
	saved, err := bundle.accounts.Save(raw)
	if err != nil {
		writeCrawlerError(w, err)
		return
	}
	httpx.OK(w, map[string]any{"success": true, "account": crawler.PublicAccountView(saved, true)})
}

func (s *Server) handleCrawlerAccountDelete(w http.ResponseWriter, r *http.Request) {
	bundle := localBundle()
	if bundle == nil || bundle.accounts == nil {
		s.proxyCrawlerRequest(w, r, 15*time.Second)
		return
	}
	accountID := r.PathValue("id")
	if !bundle.accounts.Delete(accountID) {
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
	items := bundle.challenge.List(includeCompleted == "1" || includeCompleted == "true" || includeCompleted == "yes")
	httpx.OK(w, map[string]any{"success": true, "challenges": items, "count": len(items)})
}

func (s *Server) handleCrawlerChallengeClear(w http.ResponseWriter, r *http.Request) {
	bundle := localBundle()
	if bundle == nil {
		s.proxyCrawlerRequest(w, r, 15*time.Second)
		return
	}
	cleared := bundle.challenge.Clear()
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
	config, err := crawler.LoadEngineConfig(bundle.root)
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
	config, err := crawler.LoadEngineConfig(bundle.root)
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
	if err := config.Save(bundle.root); err != nil {
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
	config, err := crawler.LoadEngineConfig(bundle.root)
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
