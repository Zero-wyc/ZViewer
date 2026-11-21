package crawler

import (
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"
)

// 搜索执行：解析站点规则 → 抓取或跑脚本 → 抽取结果 → 记录统计与日志。
//
// 与 Python 版一致，这一层不认识具体站点，只认规则；账号、JS 运行时、
// 人机验证会话、规则自动修复都是接口，未配置时走降级路径（与 None 判断等价）。

// JSRunner 执行规则里的 JS 片段（脚本规则 / 挑战匹配）。
type JSRunner interface {
	Run(source string, payload map[string]any, timeoutSec float64) (map[string]any, error)
	Available() bool
}

// AccountResolver 按 id 取站点账号（Cookie 与附加请求头）。
type AccountResolver interface {
	Resolve(accountID string) (map[string]any, error)
}

// ChallengeSessions 管理人工验证会话（*ChallengeStore 实现）。
type ChallengeSessions interface {
	Create(rule *Rule, keyword, roomID, role string, page *Page, challenge map[string]any) (*ChallengeSession, error)
	ProxyBase(session *ChallengeSession) string
}

// RuleRepairer 让大模型修复失效的规则。
type RuleRepairer interface {
	Repair(rule *Rule, keyword, errorMessage string) (map[string]any, error)
}

// SearchOptions 是 SearchService 的依赖。
type SearchOptions struct {
	Store      *RuleStore
	Fetcher    *Fetcher
	JS         JSRunner
	Accounts   AccountResolver
	Log        *SearchLogStore
	Challenges ChallengeSessions
}

// SearchService 是搜索入口。
type SearchService struct {
	store      *RuleStore
	fetcher    *Fetcher
	js         JSRunner
	accounts   AccountResolver
	searchLog  *SearchLogStore
	challenges ChallengeSessions

	repairer       RuleRepairer
	repairEnabled  bool
	repairCooldown time.Duration
	repairMu       sync.Mutex
	repairMarks    map[string]time.Time
	repairing      sync.Mutex
	repairActive   bool
}

// NewSearchService 构造搜索服务。
func NewSearchService(opts SearchOptions) *SearchService {
	service := &SearchService{
		store:       opts.Store,
		fetcher:     opts.Fetcher,
		js:          opts.JS,
		accounts:    opts.Accounts,
		searchLog:   opts.Log,
		challenges:  opts.Challenges,
		repairMarks: map[string]time.Time{},
	}
	return service
}

// SetRepairer 开启规则自动修复：同一规则在 cooldown 内只尝试一次。
func (s *SearchService) SetRepairer(repairer RuleRepairer, enabled bool, cooldown time.Duration) {
	s.repairer = repairer
	s.repairEnabled = enabled
	s.repairCooldown = cooldown
}

// Store 暴露底层规则仓库（API 层直接用）。
func (s *SearchService) Store() *RuleStore { return s.store }

// Fetcher 暴露抓取器（播放解析等复用）。
func (s *SearchService) Fetcher() *Fetcher { return s.fetcher }

// JSRuntime 暴露脚本运行时，可能为 nil。
func (s *SearchService) JSRuntime() JSRunner { return s.js }

// SetJSRuntime 在 goja 运行时构造完成后注入。
func (s *SearchService) SetJSRuntime(js JSRunner) { s.js = js }

// SetChallengeSessions 注入人工验证会话表。
func (s *SearchService) SetChallengeSessions(sessions ChallengeSessions) { s.challenges = sessions }

// ListSites 返回当前身份可见的站点列表。
func (s *SearchService) ListSites(roomID, role string) []map[string]any {
	sites := make([]map[string]any, 0, 8)
	for _, rule := range s.store.List(false) {
		if !RuleVisibleTo(rule, roomID, role) {
			continue
		}
		sites = append(sites, PublicView(rule, false))
	}
	return sites
}

// ResolveRule 先按 id、再按域名、最后按名称找规则。
func (s *SearchService) ResolveRule(site string) (*Rule, error) {
	trimmed := strings.TrimSpace(site)
	if trimmed == "" {
		return nil, SearchError("site_required", "缺少站点参数", nil)
	}
	var found *Rule
	if !strings.ContainsAny(trimmed, "/ ") {
		if rule, err := s.store.Get(trimmed); err == nil {
			found = rule
		}
	}
	if found == nil {
		found = s.store.FindBySite(trimmed)
	}
	if found == nil {
		for _, rule := range s.store.List(true) {
			if rule.Name == trimmed {
				found = rule
				break
			}
		}
	}
	if found == nil {
		ids := make([]string, 0, 8)
		for _, rule := range s.ListSites("", "guest") {
			if id, ok := rule["id"].(string); ok {
				ids = append(ids, id)
			}
		}
		return nil, SearchError("site_not_found", "未找到站点规则: "+trimmed, map[string]any{"sites": ids})
	}
	return found, nil
}

// account 取规则绑定的账号；未配置账号存储时按 Python 的语义报错。
func (s *SearchService) account(rule *Rule) (map[string]any, error) {
	accountID := strings.TrimSpace(rule.Search.AccountID)
	if accountID == "" {
		return map[string]any{}, nil
	}
	if s.accounts == nil {
		return nil, RuleError("引擎未配置账号存储，无法使用账号: "+accountID, nil)
	}
	return s.accounts.Resolve(accountID)
}

// withAccount 把账号的请求头与 Cookie 合进去（调用方已有的键优先）。
func withAccount(headers map[string]string, account map[string]any) map[string]string {
	merged := make(map[string]string, len(headers)+2)
	for key, value := range headers {
		merged[key] = value
	}
	if len(account) == 0 {
		return merged
	}
	if rawHeaders, ok := account["headers"].(map[string]string); ok {
		for key, value := range rawHeaders {
			if _, exists := merged[key]; !exists {
				merged[key] = value
			}
		}
	} else if rawMap, ok := account["headers"].(map[string]any); ok {
		for key, value := range rawMap {
			if _, exists := merged[key]; !exists {
				merged[key] = fmt.Sprint(value)
			}
		}
	}
	if cookies, _ := account["cookies"].(string); cookies != "" && !hasHeader(merged, "cookie") {
		merged["Cookie"] = cookies
	}
	return merged
}

// runScript 执行一段规则脚本，要求脚本返回对象。
func (s *SearchService) runScript(script Script, payload map[string]any, label string) (map[string]any, error) {
	if s.js == nil {
		return nil, RuleError("引擎未配置 JS 运行时，无法执行脚本规则", nil)
	}
	// Python 版写的是 "node"；内置 goja 用 "script" 标识，两者都接受（空=默认）。
	if runtime := strings.TrimSpace(script.Runtime); runtime != "" && runtime != "node" && runtime != "script" {
		return nil, RuleError(label+" 脚本不支持该运行时: "+runtime, nil)
	}
	outcome, err := s.js.Run(script.Source, payload, script.TimeoutSec)
	if err != nil {
		return nil, err
	}
	if outcome == nil || !boolValue(outcome["ok"]) {
		reason := "未知错误"
		if outcome != nil {
			if text, ok := outcome["error"].(string); ok && text != "" {
				reason = text
			}
		}
		return nil, RuleError(label+" 脚本执行失败: "+reason, nil)
	}
	result, ok := outcome["result"].(map[string]any)
	if !ok {
		return nil, RuleError(label+" 脚本必须返回对象", nil)
	}
	if logs, ok := outcome["logs"]; ok && logs != nil {
		if _, exists := result["logs"]; !exists {
			result["logs"] = logs
		}
	}
	return result, nil
}

// rulePayload 把规则转成脚本可见的普通对象（goja 侧按 map 取值）。
func rulePayload(rule *Rule) map[string]any {
	encoded, err := json.Marshal(rule)
	if err != nil {
		return map[string]any{}
	}
	var payload map[string]any
	if err := json.Unmarshal(encoded, &payload); err != nil {
		return map[string]any{}
	}
	return payload
}

func logsOf(result map[string]any) []string {
	raw, ok := result["logs"].([]any)
	if !ok {
		if direct, ok := result["logs"].([]string); ok {
			return direct
		}
		return nil
	}
	out := make([]string, 0, len(raw))
	for _, item := range raw {
		out = append(out, fmt.Sprint(item))
	}
	return out
}

// fetchOrChallengePage 4xx/5xx 的验证页不当网络错误，先交给 challenge 判定。
func (s *SearchService) fetchOrChallengePage(rule *Rule, keyword string, account map[string]any, extraHeaders map[string]string) (*Page, error) {
	page, err := s.fetch(rule, keyword, account, extraHeaders)
	if err == nil {
		return page, nil
	}
	engineErr, ok := err.(*EngineError)
	if !ok || engineErr.Code != "fetch_error" {
		return nil, err
	}
	status, _ := engineErr.Details["status"].(int)
	snippet, _ := engineErr.Details["snippet"].(string)
	if rule.Challenge.Enabled && status > 0 && containsInt(rule.Challenge.Statuses, status) && snippet != "" {
		pageURL, _ := engineErr.Details["url"].(string)
		return &Page{
			Text:    snippet,
			PageURL: pageURL,
			Status:  status,
			Request: map[string]string{},
		}, nil
	}
	return nil, err
}

func containsInt(values []int, target int) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

// fetch 按 search.mode 抓页面：script 模式先跑脚本拿 request 或直接给 items。
func (s *SearchService) fetch(rule *Rule, keyword string, account map[string]any, extraHeaders map[string]string) (*Page, error) {
	if rule.Search.Mode == "script" {
		result, err := s.runScript(rule.Search.Script, map[string]any{
			"keyword": keyword,
			"site":    rule.Site,
			"rule":    rulePayload(rule),
			"account": account,
		}, "搜索")
		if err != nil {
			return nil, err
		}
		if items, ok := result["items"].([]any); ok {
			pageURL, _ := result["pageUrl"].(string)
			status, _ := result["status"].(int)
			request, _ := result["request"].(map[string]any)
			return &Page{
				Items:     items,
				PageURL:   pageURL,
				Status:    status,
				Request:   toStringMap(request),
				SkipFetch: true,
				Logs:      logsOf(result),
			}, nil
		}
		request, ok := result["request"].(map[string]any)
		if !ok || fmt.Sprint(request["url"]) == "" {
			return nil, RuleError("搜索脚本必须返回 items 或 {request:{url,...}}", nil)
		}
		url := fmt.Sprint(request["url"])
		method := strings.ToUpper(firstNonEmpty(fmt.Sprint(request["method"]), "GET"))
		headers := withAccount(toStringMapAny(request["headers"]), account)
		for key, value := range extraHeaders {
			headers[key] = value
		}
		body := scriptBody(request["body"])
		response, fetchErr := s.fetcher.Fetch(nil, Request{URL: url, Method: method, Headers: headers, Body: body})
		if fetchErr != nil {
			return nil, fetchErr
		}
		return &Page{
			Text:    response.Text,
			PageURL: response.URL,
			Status:  response.Status,
			Request: map[string]string{"method": method, "url": url},
			Logs:    logsOf(result),
		}, nil
	}

	built, err := BuildRequest(rule, keyword)
	if err != nil {
		return nil, err
	}
	headers := withAccount(built.Headers, account)
	for key, value := range extraHeaders {
		headers[key] = value
	}
	response, err := s.fetcher.Fetch(nil, Request{URL: built.URL, Method: built.Method, Headers: headers, Body: built.Body})
	if err != nil {
		return nil, err
	}
	return &Page{
		Text:    response.Text,
		PageURL: response.URL,
		Status:  response.Status,
		Request: map[string]string{"method": built.Method, "url": built.URL},
	}, nil
}

func toStringMapAny(value any) map[string]string {
	out := map[string]string{}
	switch typed := value.(type) {
	case map[string]string:
		for key, item := range typed {
			out[key] = item
		}
	case map[string]any:
		for key, item := range typed {
			out[key] = fmt.Sprint(item)
		}
	}
	return out
}

func toStringMap(value map[string]any) map[string]string {
	out := make(map[string]string, len(value))
	for key, item := range value {
		out[key] = fmt.Sprint(item)
	}
	return out
}

// scriptBody 把脚本给的 body 转成字节：对象/数组序列化成 JSON。
func scriptBody(value any) []byte {
	switch typed := value.(type) {
	case nil:
		return nil
	case string:
		return []byte(typed)
	case []byte:
		return typed
	case map[string]any, []any:
		encoded, err := json.Marshal(typed)
		if err != nil {
			return nil
		}
		return encoded
	default:
		return []byte(fmt.Sprint(typed))
	}
}

// extract 解析页面：脚本直接给 items 时只做清洗，否则按 parse.type 分流。
func (s *SearchService) extract(rule *Rule, page *Page, keyword string, account map[string]any) ([]map[string]any, int, error) {
	if page.SkipFetch {
		return cleanItems(page.Items, rule)
	}
	if rule.Parse.Type == "script" {
		result, err := s.runScript(rule.Parse.Script, map[string]any{
			"html":    page.Text,
			"url":     page.PageURL,
			"keyword": keyword,
			"rule":    rulePayload(rule),
			"account": account,
		}, "解析")
		if err != nil {
			return nil, 0, err
		}
		rawItems, ok := result["items"].([]any)
		if !ok {
			return nil, 0, RuleError("解析脚本必须返回 {items:[...]}", nil)
		}
		cleaned, skipped, err := cleanItems(rawItems, rule)
		if err != nil {
			return nil, 0, err
		}
		scriptSkipped := 0
		if value, ok := result["skipped"]; ok {
			scriptSkipped = int(toFloat(value))
		}
		if scriptSkipped > skipped {
			skipped = scriptSkipped
		}
		return cleaned, skipped, nil
	}
	items, skipped, err := ExtractItems(rule, page.Text, page.PageURL)
	if err != nil {
		return nil, 0, err
	}
	return itemsToAny(items), skipped, nil
}

func itemsToAny(items []Item) []map[string]any {
	out := make([]map[string]any, 0, len(items))
	for _, item := range items {
		copied := make(map[string]any, len(item))
		for key, value := range item {
			copied[key] = value
		}
		out = append(out, copied)
	}
	return out
}

// cleanItems 清洗脚本产出的条目：只留固定字段、丢掉缺标题或链接的、按 url 去重。
func cleanItems(rawItems []any, rule *Rule) ([]map[string]any, int, error) {
	limit := rule.Parse.Limit
	if limit <= 0 {
		limit = 30
	}
	dedupeBy := rule.Parse.DedupeBy
	if dedupeBy == "" {
		dedupeBy = "url"
	}
	cleaned := make([]map[string]any, 0, len(rawItems))
	skipped := 0
	seen := map[string]struct{}{}
	for _, raw := range rawItems {
		object, ok := raw.(map[string]any)
		if !ok {
			skipped++
			continue
		}
		item := make(map[string]any, len(ruleFieldNames)+1)
		for _, name := range ruleFieldNames {
			value := object[name]
			if value == nil {
				item[name] = ""
				continue
			}
			item[name] = fmt.Sprint(value)
		}
		if extra, ok := object["extra"].(map[string]any); ok {
			item["extra"] = extra
		}
		if item["title"] == "" || item["url"] == "" {
			skipped++
			continue
		}
		key, _ := item[dedupeBy].(string)
		if key != "" {
			if _, dup := seen[key]; dup {
				continue
			}
			seen[key] = struct{}{}
		}
		cleaned = append(cleaned, item)
		if len(cleaned) >= limit {
			break
		}
	}
	return cleaned, skipped, nil
}

func toFloat(value any) float64 {
	switch typed := value.(type) {
	case float64:
		return typed
	case int:
		return float64(typed)
	case int64:
		return float64(typed)
	case json.Number:
		parsed, _ := typed.Float64()
		return parsed
	}
	return 0
}

// record 写搜索日志（失败不影响主流程）。
func (s *SearchService) record(rule *Rule, keyword, roomID, role string, started time.Time, page *Page, count, skipped int, errMsg string, repair map[string]any, source string) {
	if s.searchLog == nil {
		return
	}
	record := BuildSearchRecord(rule, keyword, roomID, role, page, count, skipped, errMsg,
		int(time.Since(started).Milliseconds()), source, repair)
	s.searchLog.Append(record)
}

func (s *SearchService) mayRepair(ruleID string) bool {
	s.repairMu.Lock()
	defer s.repairMu.Unlock()
	if s.repairCooldown > 0 {
		if last, ok := s.repairMarks[ruleID]; ok && time.Since(last) < s.repairCooldown {
			return false
		}
	}
	s.repairMarks[ruleID] = time.Now()
	return true
}

func (s *SearchService) runRepair(rule *Rule, keyword, errMsg string) map[string]any {
	s.repairing.Lock()
	if s.repairActive {
		s.repairing.Unlock()
		return nil
	}
	s.repairActive = true
	s.repairing.Unlock()
	defer func() {
		s.repairing.Lock()
		s.repairActive = false
		s.repairing.Unlock()
	}()
	if s.repairer == nil {
		return nil
	}
	outcome, err := s.repairer.Repair(rule, keyword, errMsg)
	if err != nil {
		return map[string]any{"success": false, "error": err.Error()}
	}
	return outcome
}

// Search 执行一次搜索。roomID/role 决定可见性，limit 会二次截断。
func (s *SearchService) Search(site, keyword, roomID, role string, limit int, extraHeaders map[string]string, createChallenge bool) (map[string]any, error) {
	trimmedKeyword := strings.TrimSpace(keyword)
	if trimmedKeyword == "" {
		return nil, SearchError("keyword_required", "搜索关键词不能为空", nil)
	}
	rule, err := s.ResolveRule(site)
	if err != nil {
		return nil, err
	}
	if !RuleVisibleTo(rule, roomID, role) {
		return nil, SearchError("site_forbidden", "当前房间没有使用该站点规则的权限: "+rule.Name,
			map[string]any{"ruleId": rule.ID})
	}

	started := time.Now()
	var repairInfo map[string]any
	var items []map[string]any
	var skipped int
	var page = &Page{}
	var lastErr error
	failure := ""

	for attempt := 1; ; attempt++ {
		items, skipped = nil, 0
		account, accountErr := s.account(rule)
		if accountErr != nil {
			lastErr = accountErr
			failure = accountErr.Error()
		} else {
			page, lastErr = s.fetchOrChallengePage(rule, trimmedKeyword, account, extraHeaders)
			if lastErr == nil {
				challenge, challengeErr := DetectChallenge(rule, page, s.js)
				if challengeErr != nil {
					lastErr = challengeErr
					failure = challengeErr.Error()
				} else if challenge != nil {
					if s.challenges != nil && createChallenge {
						session, sessionErr := s.challenges.Create(rule, trimmedKeyword, roomID, role, page, challenge)
						if sessionErr != nil {
							lastErr = sessionErr
							failure = sessionErr.Error()
						} else {
							challenge["challengeId"] = session.ID
							challenge["proxyUrl"] = s.challenges.ProxyBase(session)
							challenge["expiresAt"] = session.ExpiresAt
						}
					}
					if lastErr == nil {
						lastErr = NewChallengeError(challenge)
						failure = lastErr.Error()
					}
				} else {
					items, skipped, lastErr = s.extract(rule, page, trimmedKeyword, account)
					if lastErr != nil {
						failure = lastErr.Error()
					} else if len(items) == 0 {
						failure = "empty result"
					} else {
						failure = ""
					}
				}
			} else {
				failure = lastErr.Error()
			}
		}

		// 首次失败且未命中验证页时，让大模型修规则并重试一次。
		if attempt == 1 && failure != "" && s.repairEnabled && s.repairer != nil && s.mayRepair(rule.ID) {
			if code := ErrorCode(lastErr); code != "challenge_required" {
				outcome := s.runRepair(rule, trimmedKeyword, failure)
				if outcome != nil {
					repairInfo = map[string]any{
						"attempted": true,
						"success":   boolValue(outcome["success"]),
						"ruleId":    stringOr(outcome["ruleId"]),
						"error":     stringOr(outcome["error"]),
					}
					if steps, ok := outcome["steps"]; ok {
						repairInfo["steps"] = steps
					}
					if took, ok := outcome["tookMs"]; ok {
						repairInfo["tookMs"] = took
					}
					if boolValue(outcome["success"]) {
						s.repairMu.Lock()
						delete(s.repairMarks, rule.ID)
						s.repairMu.Unlock()
						if refreshed, getErr := s.store.Get(rule.ID); getErr == nil {
							rule = refreshed
							continue
						} else {
							lastErr = getErr
						}
					}
				}
			}
		}
		break
	}

	if lastErr != nil {
		s.store.RecordSearch(rule.ID, false, lastErr.Error())
		s.record(rule, trimmedKeyword, roomID, role, started, page, len(items), skipped, lastErr.Error(), repairInfo, "search")
		return nil, lastErr
	}

	if limit > 0 && len(items) > limit {
		items = items[:limit]
	}
	warnings := make([]string, 0, 3)
	if skipped > 0 {
		warnings = append(warnings, itoa(skipped)+" 条结果缺少标题或链接，已跳过")
	}
	if repairInfo != nil {
		if boolValue(repairInfo["success"]) {
			warnings = append(warnings, "原规则解析失败，已自动让大模型修复")
		} else {
			warnings = append(warnings, "原规则解析失败，自动修复未成功")
		}
	}
	if len(items) == 0 {
		warnings = append(warnings, "规则执行成功，但未解析到结果，可能需要更新规则")
	}

	emptyMsg := ""
	if len(items) == 0 {
		emptyMsg = "empty result"
	}
	s.store.RecordSearch(rule.ID, len(items) > 0, emptyMsg)
	s.record(rule, trimmedKeyword, roomID, role, started, page, len(items), skipped, emptyMsg, repairInfo, "search")

	result := map[string]any{
		"success": true,
		"site": map[string]any{
			"id":   rule.ID,
			"name": rule.Name,
			"site": rule.Site,
		},
		"ruleId":   rule.ID,
		"mode":     firstNonEmpty(rule.Search.Mode, "http"),
		"keyword":  trimmedKeyword,
		"count":    len(items),
		"items":    items,
		"warnings": warnings,
		"pageUrl":  page.PageURL,
		"tookMs":   int(time.Since(started).Milliseconds()),
	}
	if repairInfo != nil {
		result["repair"] = repairInfo
		result["repaired"] = boolValue(repairInfo["success"])
	}
	return result, nil
}

func stringOr(value any) string {
	if text, ok := value.(string); ok {
		return text
	}
	if value == nil {
		return ""
	}
	return fmt.Sprint(value)
}

// TestRule 校验并试跑一条未保存的规则（agent / MCP 用）。
func (s *SearchService) TestRule(raw *Rule, keyword string, limit int) map[string]any {
	started := time.Now()
	var page *Page
	rule, err := Validate(raw)
	if err != nil {
		return testRuleFailure(err, started)
	}
	account, err := s.account(rule)
	if err != nil {
		return testRuleFailure(err, started)
	}
	page, err = s.fetchOrChallengePage(rule, keyword, account, nil)
	if err != nil {
		s.record(rule, keyword, "", "root", started, page, 0, 0, err.Error(), nil, "test")
		return testRuleFailure(err, started)
	}
	challenge, challengeErr := DetectChallenge(rule, page, s.js)
	if challengeErr != nil {
		return testRuleFailure(challengeErr, started)
	}
	if challenge != nil {
		if s.challenges != nil {
			session, sessionErr := s.challenges.Create(rule, keyword, "", "root", page, challenge)
			if sessionErr == nil {
				challenge["challengeId"] = session.ID
				challenge["proxyUrl"] = s.challenges.ProxyBase(session)
			}
		}
		err := NewChallengeError(challenge)
		s.record(rule, keyword, "", "root", started, page, 0, 0, err.Error(), nil, "test")
		return testRuleFailure(err, started)
	}
	items, skipped, err := s.extract(rule, page, keyword, account)
	if err != nil {
		s.record(rule, keyword, "", "root", started, page, 0, 0, err.Error(), nil, "test")
		return testRuleFailure(err, started)
	}
	if limit > 0 && len(items) > limit {
		items = items[:limit]
	}
	s.record(rule, keyword, "", "root", started, page, len(items), skipped, "", nil, "test")
	preview := items
	if len(preview) > 10 {
		preview = preview[:10]
	}
	logs := page.Logs
	if len(logs) > 50 {
		logs = logs[:50]
	}
	request := map[string]any{}
	for key, value := range page.Request {
		request[key] = value
	}
	return map[string]any{
		"ok":      len(items) > 0,
		"count":   len(items),
		"items":   preview,
		"skipped": skipped,
		"mode":    firstNonEmpty(rule.Search.Mode, "http"),
		"pageUrl": page.PageURL,
		"status":  page.Status,
		"request": request,
		"logs":    logs,
		"tookMs":  int(time.Since(started).Milliseconds()),
		"rule":    rule,
	}
}

func testRuleFailure(err error, started time.Time) map[string]any {
	result := map[string]any{
		"ok":     false,
		"count":  0,
		"items":  []any{},
		"error":  err.Error(),
		"code":   ErrorCode(err),
		"tookMs": int(time.Since(started).Milliseconds()),
	}
	if engineErr, ok := err.(*EngineError); ok && len(engineErr.Details) > 0 {
		result["details"] = engineErr.Details
	}
	return result
}
