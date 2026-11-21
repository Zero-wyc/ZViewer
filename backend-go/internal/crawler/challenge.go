package crawler

import (
	"html"
	"regexp"
	"strings"
)

// 人机验证页识别。判定条件完全由规则提供（URL 片段 / 状态码 / 选择器 /
// 标题 / 关键词 / 脚本），引擎不猜——没有 challenge 段的规则保持旧行为。

var (
	htmlTagRe   = regexp.MustCompile(`<[^>]+>`)
	htmlTitleRe = regexp.MustCompile(`(?is)<title[^>]*>(.*?)</title>`)
)

// Page 是一次抓取（或脚本产出）的页面。
type Page struct {
	Text      string
	PageURL   string
	Status    int
	Request   map[string]string
	Logs      []string
	SkipFetch bool
	Items     []any
}

// PageTitle 取 <title> 的纯文本，最多 200 字。
func PageTitle(htmlText string) string {
	match := htmlTitleRe.FindStringSubmatch(htmlText)
	if match == nil {
		return ""
	}
	title := CollapseSpace(htmlTagRe.ReplaceAllString(match[1], " "))
	if len([]rune(title)) > 200 {
		title = string([]rune(title)[:200])
	}
	return title
}

// PageText 去掉所有标签并反转义实体，用于关键词探测。
func PageText(htmlText string) string {
	stripped := htmlTagRe.ReplaceAllString(htmlText, " ")
	return CollapseSpace(html.UnescapeString(stripped))
}

// DetectChallenge 命中验证页时返回细节，否则 nil。
func DetectChallenge(rule *Rule, page *Page, js JSRunner) (map[string]any, error) {
	challenge := rule.Challenge
	if !challenge.Enabled {
		return nil, nil
	}
	if page == nil {
		page = &Page{}
	}
	title := PageTitle(page.Text)
	text := PageText(page.Text)
	loweredURL := strings.ToLower(page.PageURL)

	for _, fragment := range challenge.URLContains {
		if strings.Contains(loweredURL, strings.ToLower(fragment)) {
			return challengeDetails(rule, page, "url_contains:"+fragment, title), nil
		}
	}
	if page.Status > 0 {
		for _, status := range challenge.Statuses {
			if status == page.Status {
				return challengeDetails(rule, page, "status:"+itoa(status), title), nil
			}
		}
	}
	for _, selector := range challenge.Selectors {
		dom, err := ParseHTML(page.Text)
		if err != nil {
			return nil, err
		}
		found, err := dom.SelectAll(selector)
		if err != nil {
			return nil, RuleErrorf("challenge.selectors 选择器无效: %v", err)
		}
		if len(found) > 0 {
			return challengeDetails(rule, page, "selector:"+selector, title), nil
		}
	}
	loweredTitle := strings.ToLower(title)
	for _, fragment := range challenge.TitleContains {
		if strings.Contains(loweredTitle, strings.ToLower(fragment)) {
			return challengeDetails(rule, page, "title:"+fragment, title), nil
		}
	}
	loweredText := strings.ToLower(text)
	for _, keyword := range challenge.Keywords {
		if strings.Contains(loweredText, strings.ToLower(keyword)) {
			return challengeDetails(rule, page, "keyword:"+keyword, title), nil
		}
	}
	if source := strings.TrimSpace(challenge.Script.Source); source != "" {
		if js == nil {
			return nil, RuleError("引擎未配置 JS 运行时，无法执行 challenge.script", nil)
		}
		outcome, err := js.Run(source, map[string]any{
			"html":   page.Text,
			"url":    page.PageURL,
			"status": page.Status,
			"title":  title,
		}, challenge.Script.TimeoutSec)
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
			return nil, RuleErrorf("challenge 脚本执行失败: %s", reason)
		}
		if result, ok := outcome["result"].(map[string]any); ok && boolValue(result["challenge"]) {
			reason, _ := result["reason"].(string)
			if reason == "" {
				reason = "matcher"
			}
			return challengeDetails(rule, page, "script:"+reason, title), nil
		}
	}
	return nil, nil
}

func challengeDetails(rule *Rule, page *Page, reason, title string) map[string]any {
	return map[string]any{
		"reason":  reason,
		"ruleId":  rule.ID,
		"site":    rule.Site,
		"name":    rule.Name,
		"pageUrl": page.PageURL,
		"status":  page.Status,
		"title":   title,
		"note":    rule.Challenge.Note,
	}
}

// genericHints 是给 agent 用的通用验证页线索。
var genericHints = []string{
	"验证码", "人机验证", "安全验证", "滑动验证", "请完成验证", "访问验证",
	"captcha", "verify you are human", "are you a robot", "cloudflare",
	"challenge-platform", "cf-chl", "geetest", "turnstile", "recaptcha",
}

// GenericSignals 对抓到的页面给出「像验证页」的判断与建议规则片段。
func GenericSignals(htmlText, url string, status int) map[string]any {
	title := PageTitle(htmlText)
	text := PageText(htmlText)
	lowered := strings.ToLower(title + "\n" + text)
	matched := make([]string, 0, 6)
	for _, hint := range genericHints {
		if strings.Contains(lowered, strings.ToLower(hint)) {
			matched = append(matched, hint)
		}
	}
	loweredURL := strings.ToLower(url)
	urlHits := make([]string, 0, 4)
	for _, part := range []string{"captcha", "verify", "challenge", "challenge-platform"} {
		if strings.Contains(loweredURL, part) {
			urlHits = append(urlHits, part)
		}
	}
	selectors := make([]string, 0, 4)
	for _, selector := range []string{
		"#captcha", ".captcha", "#challenge", ".challenge",
		"iframe[src*='captcha']", "iframe[src*='challenge']",
		"[class*='verify']", "[id*='verify']",
	} {
		dom, err := ParseHTML(htmlText)
		if err != nil {
			continue
		}
		if found, err := dom.SelectAll(selector); err == nil && len(found) > 0 {
			selectors = append(selectors, selector)
		}
	}

	page := map[string]any{
		"title":             title,
		"url":               url,
		"textPreview":       truncateRunes(text, 1200),
		"matchedHints":      firstN(matched, 10),
		"urlHits":           urlHits,
		"detectedSelectors": selectors,
	}
	if status != 0 {
		page["status"] = status
	}

	suggestion := map[string]any{"enabled": true}
	if len(urlHits) > 0 {
		suggestion["url_contains"] = urlHits
	}
	if len(matched) > 0 {
		suggestion["keywords"] = firstN(matched, 6)
	}
	if len(selectors) > 0 {
		suggestion["selectors"] = firstN(selectors, 4)
	}
	if title != "" {
		loweredTitle := strings.ToLower(title)
		if strings.Contains(loweredTitle, "验证") ||
			strings.Contains(loweredTitle, "captcha") ||
			strings.Contains(loweredTitle, "verify") {
			suggestion["title_contains"] = []string{truncateRunes(title, 20)}
		} else {
			suggestion["title_contains"] = []string{}
		}
	}
	if status == 403 || status == 429 || status == 503 {
		suggestion["statuses"] = []int{status}
	}
	hasCondition := len(urlHits) > 0 || len(matched) > 0 || len(selectors) > 0 ||
		len(toStringSlice(suggestion["title_contains"])) > 0 || suggestion["statuses"] != nil
	if !hasCondition {
		suggestion = map[string]any{}
	}

	return map[string]any{
		"success":            true,
		"url":                url,
		"page":               page,
		"likelyChallenge":    len(matched) > 0 || len(urlHits) > 0 || len(selectors) > 0 || status == 403 || status == 429 || status == 503,
		"suggestedChallenge": suggestion,
	}
}

func truncateRunes(text string, size int) string {
	runes := []rune(text)
	if len(runes) <= size {
		return text
	}
	return string(runes[:size])
}

func firstN(values []string, count int) []string {
	if len(values) <= count {
		return values
	}
	return values[:count]
}

func toStringSlice(value any) []string {
	list, _ := value.([]string)
	return list
}

func boolValue(value any) bool {
	flag, _ := value.(bool)
	return flag
}
