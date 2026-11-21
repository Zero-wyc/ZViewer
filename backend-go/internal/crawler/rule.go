package crawler

import (
	"encoding/json"
	"net/url"
	"regexp"
	"strings"
	"time"
)

var placeholderRe = regexp.MustCompile(`(?i)\{(keyword|query)\}`)

var httpAbsoluteRe = regexp.MustCompile(`(?i)^https?://`)

// NowISO 与 Python 的 strftime("%Y-%m-%dT%H:%M:%S%z") 同形：2026-11-22T01:35:00+0800。
func NowISO() string { return time.Now().Format("2006-01-02T15:04:05-0700") }

// HostOf 从站点或 URL 里取出域名，去掉端口、路径与首尾点。
func HostOf(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return ""
	}
	if strings.Contains(trimmed, "://") {
		if parsed, err := url.Parse(trimmed); err == nil {
			trimmed = parsed.Hostname()
		}
	} else {
		trimmed = strings.Split(trimmed, "/")[0]
		trimmed = strings.Split(trimmed, ":")[0]
	}
	return strings.Trim(strings.ToLower(strings.TrimSpace(trimmed)), ".")
}

// RuleMatchesHost 判断规则是否属于某个域名（含子域与父域）。
func RuleMatchesHost(rule *Rule, host string) bool {
	normalized := HostOf(host)
	if normalized == "" || rule == nil {
		return false
	}
	candidates := append([]string{rule.Site}, rule.Aliases...)
	for _, candidate := range candidates {
		normalizedCandidate := HostOf(candidate)
		if normalizedCandidate == "" {
			continue
		}
		if normalized == normalizedCandidate ||
			strings.HasSuffix(normalized, "."+normalizedCandidate) ||
			strings.HasSuffix(normalizedCandidate, "."+normalized) {
			return true
		}
	}
	return false
}

// Normalize 填默认值、统一大小写与类型，不做语义校验。
//
// 注意 Enabled 的默认值在反序列化阶段就已确定（缺省为 true），这里不再兜底：
// 从 JSON 读进来的规则不可能把「没写」带到这一步。
func Normalize(rule *Rule) *Rule {
	rule.Format = RuleFormat
	rule.Name = strings.TrimSpace(rule.Name)
	rule.Site = HostOf(rule.Site)
	rule.Aliases = normalizeHosts(rule.Aliases)
	if rule.Visibility == "" {
		rule.Visibility = "public"
	}
	rule.Visibility = strings.ToLower(strings.TrimSpace(rule.Visibility))
	if !containsString(ruleVisibilities, rule.Visibility) {
		rule.Visibility = "public"
	}
	rule.AllowedRooms = normalizeStrings(rule.AllowedRooms)
	if rule.CreatedBy == "" {
		rule.CreatedBy = "root"
	}
	if rule.CreatedAt == "" {
		rule.CreatedAt = NowISO()
	}
	if rule.UpdatedAt == "" {
		rule.UpdatedAt = NowISO()
	}
	if rule.Version <= 0 {
		rule.Version = 1
	}
	rule.Description = strings.TrimSpace(rule.Description)

	search := &rule.Search
	if search.Mode == "" {
		search.Mode = "http"
	}
	search.Mode = strings.ToLower(strings.TrimSpace(search.Mode))
	search.Request.Method = strings.ToUpper(strings.TrimSpace(search.Request.Method))
	if search.Request.Method == "" {
		search.Request.Method = "GET"
	}
	search.Request.URL = strings.TrimSpace(search.Request.URL)
	if search.Request.Headers == nil {
		search.Request.Headers = map[string]string{}
	}
	if search.Request.BodyType == "" {
		search.Request.BodyType = "raw"
	}
	search.Request.BodyType = strings.ToLower(strings.TrimSpace(search.Request.BodyType))
	if search.Encoding == "" {
		search.Encoding = "utf-8"
	}
	search.Encoding = strings.TrimSpace(search.Encoding)
	search.Script = normalizeScript(search.Script)
	search.AccountID = strings.TrimSpace(search.AccountID)

	parse := &rule.Parse
	if parse.Type == "" {
		parse.Type = "html"
	}
	parse.Type = strings.ToLower(strings.TrimSpace(parse.Type))
	parse.Script = normalizeScript(parse.Script)
	if parse.Fields == nil {
		parse.Fields = map[string]Field{}
	}
	parse.Container = strings.TrimSpace(parse.Container)
	parse.ListPath = strings.TrimSpace(parse.ListPath)
	parse.BaseURL = strings.TrimSpace(parse.BaseURL)
	if parse.DedupeBy == "" {
		parse.DedupeBy = "url"
	}
	parse.DedupeBy = strings.TrimSpace(parse.DedupeBy)
	if parse.Limit <= 0 {
		parse.Limit = 30
	}
	if parse.Limit > 100 {
		parse.Limit = 100
	}

	challenge := &rule.Challenge
	if challenge.URLContains == nil {
		challenge.URLContains = []string{}
	}
	if challenge.TitleContains == nil {
		challenge.TitleContains = []string{}
	}
	if challenge.Keywords == nil {
		challenge.Keywords = []string{}
	}
	if challenge.Selectors == nil {
		challenge.Selectors = []string{}
	}
	if challenge.Statuses == nil {
		challenge.Statuses = []int{}
	}
	challenge.Script = normalizeScript(challenge.Script)
	challenge.WaitSelector = strings.TrimSpace(challenge.WaitSelector)
	if challenge.WaitSeconds < 0 {
		challenge.WaitSeconds = 0
	}
	if challenge.WaitSeconds > 600 {
		challenge.WaitSeconds = 600
	}
	challenge.Note = strings.TrimSpace(challenge.Note)

	if rule.Play != nil {
		if rule.Play.Headers == nil {
			rule.Play.Headers = map[string]string{}
		}
		rule.Play.Script = normalizeScript(rule.Play.Script)
		rule.Play.PlayURLRegex = strings.TrimSpace(rule.Play.PlayURLRegex)
		rule.Play.EpisodeRegex = strings.TrimSpace(rule.Play.EpisodeRegex)
		rule.Play.AccountID = strings.TrimSpace(rule.Play.AccountID)
		if rule.Play.API.Headers == nil {
			rule.Play.API.Headers = map[string]string{}
		}
		rule.Play.API.URL = strings.TrimSpace(rule.Play.API.URL)
		rule.Play.API.SkipFrom = normalizeStrings(rule.Play.API.SkipFrom)
	}
	return rule
}

func normalizeScript(script Script) Script {
	if strings.TrimSpace(script.Runtime) == "" {
		script.Runtime = "node"
	}
	script.Runtime = strings.ToLower(strings.TrimSpace(script.Runtime))
	if script.TimeoutSec <= 0 {
		script.TimeoutSec = 20
	}
	return script
}

func normalizeHosts(values []string) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		host := HostOf(value)
		if host != "" {
			out = append(out, host)
		}
	}
	return out
}

func normalizeStrings(values []string) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

// Validate 归一后做语义校验，返回可直接落库的副本。
func Validate(raw *Rule) (*Rule, error) {
	if raw == nil {
		return nil, RuleError("规则必须是 JSON 对象", nil)
	}
	rule := Normalize(raw)
	errors := make([]string, 0, 4)

	if rule.Name == "" {
		errors = append(errors, "缺少规则名称 name")
	}
	if rule.Site == "" {
		errors = append(errors, "缺少站点域名 site（例如 example.com）")
	}

	search := rule.Search
	if search.Mode != "http" && search.Mode != "script" {
		errors = append(errors, "search.mode 只支持 http 或 script")
	}
	if search.Mode == "http" {
		request := search.Request
		if request.Method != "GET" && request.Method != "POST" {
			errors = append(errors, "search.request.method 只支持 GET/POST")
		}
		if !httpAbsoluteRe.MatchString(request.URL) {
			errors = append(errors, "search.request.url 必须是 http(s) 绝对地址")
		}
		if !placeholderRe.MatchString(request.URL) && !placeholderRe.MatchString(request.Body) {
			errors = append(errors, "search.request.url 或 body 必须包含 {keyword} 占位符")
		}
		for key, value := range request.Headers {
			if strings.ContainsAny(key, "\r\n") || strings.ContainsAny(value, "\r\n") {
				errors = append(errors, "search.request.headers 不能包含换行")
				break
			}
		}
	} else {
		if strings.TrimSpace(search.Script.Source) == "" {
			errors = append(errors, "search.mode=script 时 search.script.source 不能为空")
		}
		if search.Script.Runtime != "node" {
			errors = append(errors, "search.script.runtime 目前只支持 node")
		}
	}

	parse := rule.Parse
	switch parse.Type {
	case "script":
		if strings.TrimSpace(parse.Script.Source) == "" {
			errors = append(errors, "parse.type=script 时 parse.script.source 不能为空")
		}
		if parse.Script.Runtime != "node" {
			errors = append(errors, "parse.script.runtime 目前只支持 node")
		}
	case "html":
		if parse.Container == "" {
			errors = append(errors, "parse.container 不能为空（搜索结果条目的选择器）")
		} else if err := ValidateSelector(parse.Container); err != nil {
			errors = append(errors, "parse.container 选择器无效: "+parse.Container)
		}
		for name, field := range parse.Fields {
			if name != "extra" && !containsString(ruleFieldNames, name) {
				errors = append(errors, "parse.fields 不支持字段 "+name)
			}
			if field.Selector == "" {
				errors = append(errors, "parse.fields."+name+" 缺少 selector")
			}
		}
		for _, name := range []string{"title", "url"} {
			if parse.Fields[name].Selector == "" && !hasErrorFor(errors, "parse.fields."+name) {
				errors = append(errors, "parse.fields."+name+" 缺少 selector")
			}
		}
	case "json":
		if parse.ListPath == "" {
			errors = append(errors, "parse.list_path 不能为空（例如 data.list）")
		}
		for _, name := range []string{"title", "url"} {
			if parse.Fields[name].Path == "" {
				errors = append(errors, "parse.fields."+name+" 缺少 path")
			}
		}
	default:
		errors = append(errors, "parse.type 只支持 html/json/script")
	}

	challenge := rule.Challenge
	if challenge.Enabled {
		hasDetector := len(challenge.URLContains) > 0 ||
			len(challenge.TitleContains) > 0 ||
			len(challenge.Keywords) > 0 ||
			len(challenge.Selectors) > 0 ||
			len(challenge.Statuses) > 0 ||
			strings.TrimSpace(challenge.Script.Source) != ""
		if !hasDetector {
			errors = append(errors, "challenge.enabled=true 时至少需要一个检测条件（url_contains/title_contains/keywords/selectors/statuses/script）")
		}
		if strings.TrimSpace(challenge.Script.Source) != "" && challenge.Script.Runtime != "node" {
			errors = append(errors, "challenge.script.runtime 目前只支持 node")
		}
		for _, selector := range challenge.Selectors {
			if err := ValidateSelector(selector); err != nil {
				errors = append(errors, "challenge.selectors 选择器无效 "+selector)
				break
			}
		}
	}

	if rule.Play != nil {
		if strings.TrimSpace(rule.Play.Script.Source) != "" && rule.Play.Script.Runtime != "node" {
			errors = append(errors, "play.script.runtime 目前只支持 node")
		}
		if rule.Play.API.URL != "" && !httpAbsoluteRe.MatchString(rule.Play.API.URL) {
			errors = append(errors, "play.api.url 必须是 http(s) 绝对地址")
		}
		if rule.Play.PlayURLRegex != "" {
			if _, err := regexp.Compile(rule.Play.PlayURLRegex); err != nil {
				errors = append(errors, "play.play_url_regex 不是合法正则: "+err.Error())
			}
		}
	}

	if len(errors) > 0 {
		return nil, RuleError("规则校验失败: "+strings.Join(errors, "；"), map[string]any{"errors": errors})
	}
	return rule, nil
}

func hasErrorFor(errors []string, prefix string) bool {
	for _, item := range errors {
		if strings.HasPrefix(item, prefix) {
			return true
		}
	}
	return false
}

// BuiltRequest 是替换好关键词的搜索请求。
type BuiltRequest struct {
	Method  string
	URL     string
	Headers map[string]string
	Body    []byte
}

// BuildRequest 替换 {keyword}/{query} 并按 search.encoding 做百分号编码。
func BuildRequest(rule *Rule, keyword string) (*BuiltRequest, error) {
	trimmed := strings.TrimSpace(keyword)
	if trimmed == "" {
		return nil, RuleError("搜索关键词不能为空", nil)
	}
	if len([]rune(trimmed)) > 100 {
		return nil, RuleError("搜索关键词过长", nil)
	}
	encoded, err := QuoteKeyword(trimmed, rule.Search.Encoding)
	if err != nil {
		return nil, err
	}
	request := rule.Search.Request
	headers := make(map[string]string, len(request.Headers)+1)
	for key, value := range request.Headers {
		headers[key] = value
	}
	var body []byte
	bodyText := placeholderRe.ReplaceAllString(request.Body, encoded)
	if request.Method == "POST" && bodyText != "" {
		body = []byte(bodyText)
		if !hasHeader(headers, "content-type") {
			if request.BodyType == "json" {
				headers["Content-Type"] = "application/json; charset=utf-8"
			} else {
				headers["Content-Type"] = "application/x-www-form-urlencoded; charset=utf-8"
			}
		}
	}
	return &BuiltRequest{
		Method:  request.Method,
		URL:     placeholderRe.ReplaceAllString(request.URL, encoded),
		Headers: headers,
		Body:    body,
	}, nil
}

func hasHeader(headers map[string]string, name string) bool {
	for key := range headers {
		if strings.EqualFold(key, name) {
			return true
		}
	}
	return false
}

// PublicView 生成给前端的视图：外层驼峰，include_parse 时附带内部结构（snake_case）。
func PublicView(rule *Rule, includeParse bool) map[string]any {
	stats := rule.Stats
	view := map[string]any{
		"id":          rule.ID,
		"name":        rule.Name,
		"site":        rule.Site,
		"aliases":     emptyIfNil(rule.Aliases),
		"enabled":     rule.Enabled,
		"visibility":  rule.Visibility,
		"allowedRooms": emptyIfNil(rule.AllowedRooms),
		"description": rule.Description,
		"createdBy":   rule.CreatedBy,
		"createdAt":   rule.CreatedAt,
		"updatedAt":   rule.UpdatedAt,
		"version":     rule.Version,
		"stats": map[string]any{
			"searches":     stats.Searches,
			"successes":    stats.Successes,
			"failures":     stats.Failures,
			"last_used_at": stats.LastUsedAt,
			"last_error":   stats.LastError,
		},
	}
	if includeParse {
		view["search"] = rule.Search
		view["parse"] = rule.Parse
		view["challenge"] = rule.Challenge
		if rule.Play != nil {
			view["play"] = rule.Play
		}
	}
	return view
}

func emptyIfNil(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}

// DecodeRule 从 JSON 字节解出一条规则并完成归一与校验。
func DecodeRule(data []byte) (*Rule, error) {
	var rule Rule
	if err := json.Unmarshal(data, &rule); err != nil {
		return nil, RuleErrorf("规则不是合法 JSON: %v", err)
	}
	return Validate(&rule)
}
