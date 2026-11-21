package crawler

import (
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// 把站点详情页解析成播放器可直接使用的媒体地址。
//
// 优先级与 Python 版一致：
//  0. 规则 play.script（反爬站点在脚本里算签名）
//  1. 规则 play.api（按 episode 页里的 playFrom 等变量逐条线路尝试）
//  2. 页面 HTML/JS 里直接写着 m3u8/mp4/flv
//  3. 前几个播放页里再找一次直链
//  4. 离屏浏览器兜底（BrowserSniffer，未实现前跳过）
//  5. 只有 iframe 时返回 format=iframe，由前端决定降级
//
// 输出结构与 Python 版逐字段对齐：{success, site, ruleId, ruleName, title,
// format, url, headers, pageUrl, episodes, source, note, qualities?}。

var (
	mediaRe = regexp.MustCompile(`(?i)https?://[^\s"'\\<>]+?\.(?:m3u8|mp4|flv)(?:\?[^\s"'\\<>]*)?`)
	// 带时效签名的地址在观众端很快失效，解析时优先选不带这些参数的线路。
	authQueryRe = regexp.MustCompile(`(?i)(?:^|[?&])(?:auth_|auth|token|expires?|sign|signature|ts|key|auth_key)=`)
	playLinkRe  = regexp.MustCompile(`(?is)<a[^>]+href=["']([^"']*(?:vodplay/|/player\?|/play/)[^"']*)["'][^>]*>(.*?)</a>`)
	jsonURLRe   = regexp.MustCompile(`(?i)["']url["']\s*:\s*["']([^"']+\.(?:m3u8|mp4|flv)[^"']*)["']`)
	h1TitleRe   = regexp.MustCompile(`(?is)<h1[^>]*>(.*?)</h1>`)
	ogTitleRe   = regexp.MustCompile(`(?i)<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']`)
)

const (
	maxEpisodes   = 200
	maxQualities  = 12
	playProbeTime = 12 * time.Second
)

// mediaFormats 是播放器认的三种格式。
var mediaFormats = map[string]struct{}{"hls": {}, "flv": {}, "mp4": {}}

// Episode 是一条选集（playPage 是播放页，url 是脚本直接给的媒体地址）。
type Episode struct {
	Name     string `json:"name"`
	URL      string `json:"url,omitempty"`
	PlayPage string `json:"playPage,omitempty"`
}

// Quality 是一档清晰度。
type Quality struct {
	Name    string            `json:"name"`
	URL     string            `json:"url"`
	Format  string            `json:"format"`
	Headers map[string]string `json:"headers"`
}

// BrowserSniffer 是离屏浏览器的兜底能力（browser.go 批次实现，未实现时为 nil）。
type BrowserSniffer interface {
	Available() bool
	// Sniff 打开页面并嗅探媒体地址，返回最优结果与页面标题；失败返回 nil。
	Sniff(target string, headers map[string]string, episodes []Episode) (map[string]any, bool)
}

// PlayOptions 是 PlayResolver 的依赖。
type PlayOptions struct {
	Store    *RuleStore
	Fetcher  *Fetcher
	JS       JSRunner
	Accounts AccountResolver
	Browser  BrowserSniffer
}

// PlayResolver 解析播放地址。
type PlayResolver struct {
	store    *RuleStore
	fetcher  *Fetcher
	js       JSRunner
	accounts AccountResolver
	browser  BrowserSniffer
}

// NewPlayResolver 构造解析器。
func NewPlayResolver(opts PlayOptions) *PlayResolver {
	fetcher := opts.Fetcher
	if fetcher == nil {
		fetcher = NewFetcher(FetcherOptions{Timeout: 25 * time.Second, Retries: 1})
	}
	return &PlayResolver{
		store:    opts.Store,
		fetcher:  fetcher,
		js:       opts.JS,
		accounts: opts.Accounts,
		browser:  opts.Browser,
	}
}

// SetJSRuntime 注入脚本运行时（goja 构造完成后调用）。
func (r *PlayResolver) SetJSRuntime(js JSRunner) { r.js = js }

// SetBrowser 注入离屏浏览器。
func (r *PlayResolver) SetBrowser(browser BrowserSniffer) { r.browser = browser }

// DetectFormat 按扩展名判断格式，认不出返回空串。
func DetectFormat(target string) string {
	lowered := strings.ToLower(target)
	switch {
	case strings.Contains(lowered, ".m3u8"):
		return "hls"
	case strings.Contains(lowered, ".flv"):
		return "flv"
	case strings.Contains(lowered, ".mp4"):
		return "mp4"
	}
	return ""
}

// NormalizeQualities 规范化脚本给的 qualities：校验格式、去重、合并请求头。
//
// 站点有多档清晰度时脚本每档给一条 {name,url}，具体播哪档由播放器决定。
func NormalizeQualities(raw any, baseHeaders map[string]string) []Quality {
	items, ok := raw.([]any)
	if !ok {
		return nil
	}
	result := make([]Quality, 0, len(items))
	names := map[string]struct{}{}
	urls := map[string]struct{}{}
	for _, item := range items {
		entry := map[string]any{}
		switch typed := item.(type) {
		case string:
			entry["url"] = typed
		case map[string]any:
			entry = typed
		default:
			continue
		}
		target := strings.TrimSpace(firstNonEmpty(stringOr(entry["url"]), stringOr(entry["playUrl"])))
		if target == "" || !httpAbsoluteRe.MatchString(target) {
			continue
		}
		if _, dup := urls[target]; dup {
			continue
		}
		format := strings.ToLower(strings.TrimSpace(stringOr(entry["format"])))
		if format == "" {
			format = DetectFormat(target)
		}
		if _, ok := mediaFormats[format]; !ok {
			continue
		}
		headers := make(map[string]string, len(baseHeaders)+2)
		for key, value := range baseHeaders {
			headers[key] = value
		}
		if extra, ok := entry["headers"].(map[string]any); ok {
			for key, value := range extra {
				if value != nil && fmt.Sprint(value) != "" {
					headers[key] = fmt.Sprint(value)
				}
			}
		}
		name := strings.TrimSpace(firstNonEmpty(stringOr(entry["name"]), stringOr(entry["label"])))
		if name == "" {
			name = strings.ToUpper(format)
		}
		unique := name
		for index := 2; ; index++ {
			if _, taken := names[unique]; !taken {
				break
			}
			unique = name + " " + itoa(index)
		}
		names[unique] = struct{}{}
		urls[target] = struct{}{}
		result = append(result, Quality{Name: unique, URL: target, Format: format, Headers: headers})
		if len(result) >= maxQualities {
			break
		}
	}
	return result
}

// findRule 找第一个匹配域名且当前身份可见的启用规则。
func (r *PlayResolver) findRule(target, roomID, role string) *Rule {
	host := HostOf(target)
	if host == "" || r.store == nil {
		return nil
	}
	for _, rule := range r.store.List(false) {
		if !rule.Enabled || !RuleMatchesHost(rule, host) {
			continue
		}
		if !RuleVisibleTo(rule, roomID, role) {
			continue
		}
		return rule
	}
	return nil
}

// account 取规则绑定的账号：play.account_id 优先，兼容只在 search 段绑定的旧规则。
func (r *PlayResolver) account(rule *Rule) map[string]any {
	if rule == nil || r.accounts == nil {
		return map[string]any{}
	}
	accountID := rule.Search.AccountID
	if rule.Play != nil && rule.Play.AccountID != "" {
		accountID = rule.Play.AccountID
	}
	if accountID == "" {
		return map[string]any{}
	}
	account, err := r.accounts.Resolve(accountID)
	if err != nil {
		return map[string]any{}
	}
	return account
}

// playHeaders 合成请求头：搜索段 + 播放段，缺 Referer 时按页面补。
func playHeaders(rule *Rule, pageURL string) map[string]string {
	headers := map[string]string{}
	if rule != nil {
		for key, value := range rule.Search.Request.Headers {
			if value != "" {
				headers[key] = value
			}
		}
		if rule.Play != nil {
			for key, value := range rule.Play.Headers {
				if value != "" {
					headers[key] = value
				}
			}
		}
	}
	if !hasHeader(headers, "referer") {
		if parsed, err := url.Parse(pageURL); err == nil && parsed.Scheme != "" && parsed.Host != "" {
			headers["Referer"] = parsed.Scheme + "://" + parsed.Host + "/"
		}
	}
	return headers
}

func pageTitleOf(htmlText string) string {
	// og:title 最准，其次 h1，最后退回 <title>（浏览器兜底时页面常常只有 title）。
	for _, pattern := range []*regexp.Regexp{ogTitleRe, h1TitleRe, htmlTitleRe} {
		match := pattern.FindStringSubmatch(htmlText)
		if match == nil {
			continue
		}
		if title := CollapseSpace(htmlTagRe.ReplaceAllString(match[1], " ")); title != "" {
			return title
		}
	}
	return ""
}

// parseEpisodes 从页面里抽选集链接（可用 play.episode_regex 覆盖默认正则）。
func parseEpisodes(htmlText, pageURL string, playCfg *Play) []Episode {
	pattern := playLinkRe
	if playCfg != nil && playCfg.EpisodeRegex != "" {
		compiled, err := regexp.Compile("(?is)" + playCfg.EpisodeRegex)
		if err == nil {
			pattern = compiled
		}
	}
	seen := map[string]struct{}{}
	episodes := make([]Episode, 0, 12)
	for _, match := range pattern.FindAllStringSubmatch(htmlText, -1) {
		if len(match) < 2 {
			continue
		}
		href := strings.TrimSpace(match[1])
		if href == "" || strings.HasPrefix(href, "javascript:") || strings.HasPrefix(href, "#") {
			continue
		}
		absolute := joinURL(pageURL, href)
		if _, dup := seen[absolute]; dup {
			continue
		}
		seen[absolute] = struct{}{}
		name := ""
		if len(match) >= 3 {
			name = CollapseSpace(htmlTagRe.ReplaceAllString(match[2], " "))
		}
		if name == "" {
			name = "第 " + itoa(len(episodes)+1) + " 集"
		}
		episodes = append(episodes, Episode{Name: name, PlayPage: absolute})
		if len(episodes) >= maxEpisodes {
			break
		}
	}
	return episodes
}

// matchPlayVars 用 play_url_regex 从播放页地址里取命名分组（如 playFrom）。
func matchPlayVars(target string, playCfg *Play) map[string]string {
	if playCfg == nil || playCfg.PlayURLRegex == "" {
		return nil
	}
	compiled, err := regexp.Compile(playCfg.PlayURLRegex)
	if err != nil {
		return nil
	}
	match := compiled.FindStringSubmatch(target)
	if match == nil {
		return nil
	}
	out := map[string]string{}
	for index, name := range compiled.SubexpNames() {
		if name == "" || index >= len(match) {
			continue
		}
		// 命名捕获组必须用 (?P<name>) 或 (?<name>)，Go 的 SubexpNames 已经归一。
		out[name] = match[index]
	}
	return out
}

// mediaFromText 从 HTML/JS 文本里找媒体直链。
func mediaFromText(text string) string {
	if match := mediaRe.FindString(text); match != "" {
		return match
	}
	if match := jsonURLRe.FindStringSubmatch(text); match != nil {
		return strings.ReplaceAll(match[1], `\/`, "/")
	}
	return ""
}

// stabilityScore 越高越稳定：无 query > 无签名 query > 带签名。
func stabilityScore(target string) int {
	parsed, err := url.Parse(target)
	if err != nil || parsed.RawQuery == "" {
		return 3
	}
	if authQueryRe.MatchString("?" + parsed.RawQuery) {
		return 1
	}
	return 2
}

// playable 探一下地址是否真能拉（Range 1 字节），跳过 4xx 的会员/过期线路。
func (r *PlayResolver) playable(target string, headers map[string]string) bool {
	probeHeaders := make(map[string]string, len(headers)+2)
	for key, value := range headers {
		probeHeaders[key] = value
	}
	probeHeaders["Range"] = "bytes=0-1"
	probeHeaders["Accept"] = "*/*"
	result, err := r.fetcher.Fetch(nil, Request{URL: target, Headers: probeHeaders, Timeout: playProbeTime})
	if err != nil {
		if engineErr, ok := err.(*EngineError); ok {
			if status, ok := engineErr.Details["status"].(int); ok && status >= 200 && status < 400 {
				return true
			}
		}
		return false
	}
	return result.Status >= 200 && result.Status < 400
}

func (r *PlayResolver) runScript(script Script, payload map[string]any) (map[string]any, error) {
	if r.js == nil {
		return nil, RuleError("引擎未配置 JS 运行时，无法执行播放脚本", nil)
	}
	if runtime := strings.TrimSpace(script.Runtime); runtime != "" && runtime != "node" && runtime != "script" {
		return nil, RuleError("播放脚本不支持该运行时: "+runtime, nil)
	}
	outcome, err := r.js.Run(script.Source, payload, script.TimeoutSec)
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
		return nil, RuleError("播放脚本执行失败: "+reason, nil)
	}
	result, ok := outcome["result"].(map[string]any)
	if !ok {
		return nil, RuleError("播放脚本必须返回对象", nil)
	}
	return result, nil
}

// buildPlayResult 组装统一输出；qualities 非空时补齐 url/format/headers。
func buildPlayResult(rule *Rule, pageURL, title, mediaURL string, headers map[string]string, episodes []Episode, source, note string, qualities []Quality, mediaFormat string) map[string]any {
	if len(qualities) > 0 && mediaURL == "" {
		mediaURL = qualities[0].URL
		headers = qualities[0].Headers
		if mediaFormat == "" {
			mediaFormat = qualities[0].Format
		}
	}
	site := ""
	ruleID := ""
	ruleName := ""
	if rule != nil {
		site = rule.Site
		ruleID = rule.ID
		ruleName = rule.Name
	}
	if site == "" {
		site = HostOf(pageURL)
	}
	if mediaFormat == "" {
		mediaFormat = DetectFormat(mediaURL)
	}
	if episodes == nil {
		episodes = []Episode{}
	}
	result := map[string]any{
		"success":  true,
		"site":     site,
		"ruleId":   ruleID,
		"ruleName": ruleName,
		"title":    title,
		"format":   mediaFormat,
		"url":      mediaURL,
		"headers":  headers,
		"pageUrl":  pageURL,
		"episodes": episodes,
		"source":   source,
		"note":     note,
	}
	if len(qualities) > 0 {
		result["qualities"] = qualities
	}
	return result
}

// Resolve 解析一条站点地址。rule 为 nil 时按域名自动找规则。
func (r *PlayResolver) Resolve(target, roomID, role string, rule *Rule) (map[string]any, error) {
	trimmed := strings.TrimSpace(target)
	if trimmed == "" {
		return nil, RuleError("缺少要解析的站点地址", nil)
	}
	if !httpAbsoluteRe.MatchString(trimmed) {
		return nil, RuleError("仅支持 http/https 地址", nil)
	}
	host := HostOf(trimmed)
	if rule == nil {
		rule = r.findRule(trimmed, roomID, role)
	}
	var playCfg *Play
	if rule != nil {
		playCfg = rule.Play
	}
	account := r.account(rule)
	headers := withAccount(playHeaders(rule, trimmed), account)

	// 目标本身就是媒体直链。
	if mediaFromText(trimmed) != "" && DetectFormat(trimmed) != "" {
		return buildPlayResult(rule, trimmed, "", trimmed, headers, nil, "direct", "", nil, ""), nil
	}

	// 0) 规则声明的播放脚本。
	if playCfg != nil && strings.TrimSpace(playCfg.Script.Source) != "" {
		if data, err := r.runScript(playCfg.Script, map[string]any{
			"pageUrl": trimmed,
			"site":    host,
			"rule":    rulePayload(rule),
			"headers": headers,
			"account": account,
		}); err == nil {
			if result := r.resolveFromScript(rule, trimmed, host, headers, data); result != nil {
				return result, nil
			}
		}
	}

	pageURL := trimmed
	html := ""
	title := ""
	var episodes []Episode
	var fetchErr error
	page, err := r.fetcher.Fetch(nil, Request{URL: trimmed, Headers: headers})
	if err != nil {
		// 403/验证码/JS 渲染站点：HTTP 直连拿不到，交给后面的浏览器兜底。
		fetchErr = err
	} else {
		pageURL = firstNonEmpty(page.URL, trimmed)
		html = page.Text
		title = pageTitleOf(html)
		episodes = parseEpisodes(html, pageURL, playCfg)
	}
	_ = fetchErr

	// 1) 规则声明的播放接口：逐条线路尝试，跳过会员线路。
	iframeFallback := ""
	if playCfg != nil && strings.TrimSpace(playCfg.API.URL) != "" {
		apiHeaders := make(map[string]string, len(headers)+2)
		for key, value := range headers {
			apiHeaders[key] = value
		}
		for key, value := range playCfg.API.Headers {
			if value != "" {
				apiHeaders[key] = value
			}
		}
		skipFrom := map[string]struct{}{}
		for _, item := range playCfg.API.SkipFrom {
			if trimmedItem := strings.ToLower(strings.TrimSpace(item)); trimmedItem != "" {
				skipFrom[trimmedItem] = struct{}{}
			}
		}
		candidates := make([]map[string]string, 0, 10)
		considered := []string{pageURL}
		for _, episode := range episodes {
			considered = append(considered, episode.PlayPage)
		}
		for _, candidate := range considered {
			variables := matchPlayVars(candidate, playCfg)
			if len(variables) == 0 {
				continue
			}
			if playFrom := strings.ToLower(strings.TrimSpace(variables["playFrom"])); playFrom != "" {
				if _, skip := skipFrom[playFrom]; skip {
					continue
				}
			}
			candidates = append(candidates, variables)
			if len(candidates) >= 10 {
				break
			}
		}

		bestScore := -1
		bestMedia := ""
		for _, variables := range candidates {
			apiURL, buildErr := fillTemplate(playCfg.API.URL, variables)
			if buildErr != nil {
				return nil, buildErr
			}
			response, apiErr := r.fetcher.Fetch(nil, Request{URL: apiURL, Headers: apiHeaders})
			if apiErr != nil {
				continue
			}
			var decoded map[string]any
			decoder := json.NewDecoder(strings.NewReader(response.Text))
			decoder.UseNumber()
			if err := decoder.Decode(&decoded); err != nil {
				continue
			}
			inner := decoded
			if nested, ok := decoded["data"].(map[string]any); ok {
				inner = nested
			}
			mode := strings.ToLower(firstNonEmpty(stringOr(inner["mode"]), "native"))
			media := strings.ReplaceAll(firstNonEmpty(
				stringOr(inner["url"]), stringOr(inner["playUrl"]), stringOr(inner["m3u8"]),
			), `\/`, "/")
			if mode == "iframe" && media != "" {
				if iframeFallback == "" {
					iframeFallback = media
				}
				continue
			}
			if media == "" || DetectFormat(media) == "" {
				continue
			}
			if !r.playable(media, headers) {
				continue
			}
			if score := stabilityScore(media); score > bestScore {
				bestScore = score
				bestMedia = media
			}
		}
		if bestMedia != "" {
			return buildPlayResult(rule, pageURL, title, bestMedia, headers, episodes, "rule-api", "", nil, ""), nil
		}
	}

	// 2) 页面里直接带媒体地址。
	if direct := mediaFromText(html); direct != "" {
		return buildPlayResult(rule, pageURL, title, direct, headers, episodes, "page", "", nil, ""), nil
	}

	// 3) 播放页里再找一次直链。
	for index, episode := range episodes {
		if index >= 3 {
			break
		}
		detail, detailErr := r.fetcher.Fetch(nil, Request{URL: episode.PlayPage, Headers: headers})
		if detailErr != nil {
			continue
		}
		if media := mediaFromText(detail.Text); media != "" {
			return buildPlayResult(rule, pageURL, firstNonEmpty(title, episode.Name), media, headers, episodes, "play-page", "", nil, ""), nil
		}
	}

	// 4) 离屏浏览器兜底。
	if r.browser != nil && r.browser.Available() {
		if sniffed, ok := r.browser.Sniff(trimmed, headers, episodes); ok {
			return sniffed, nil
		}
	}

	// 5) 只有 iframe 时明确返回，由前端决定是否降级打开原站。
	if iframeFallback != "" {
		return buildPlayResult(rule, pageURL, title, iframeFallback, headers, episodes, "rule-api",
			"该站点正片需要会员或本站不允许直接播放", nil, "iframe"), nil
	}

	return nil, RuleError("没有解析到可播放地址（该站点可能需要登录/验证，或暂不支持）", nil)
}

// resolveFromScript 处理 play.script 的返回：挑一个能拉的默认档，其余进 qualities。
func (r *PlayResolver) resolveFromScript(rule *Rule, target, host string, headers map[string]string, data map[string]any) map[string]any {
	merged := make(map[string]string, len(headers)+2)
	for key, value := range headers {
		merged[key] = value
	}
	if extra, ok := data["headers"].(map[string]any); ok {
		for key, value := range extra {
			if value != nil && fmt.Sprint(value) != "" {
				merged[key] = fmt.Sprint(value)
			}
		}
	}
	qualities := NormalizeQualities(data["qualities"], merged)
	type candidate struct{ url, format string }
	candidates := make([]candidate, 0, 4)
	media := strings.TrimSpace(stringOr(data["url"]))
	if media != "" {
		format := strings.ToLower(strings.TrimSpace(stringOr(data["format"])))
		if format == "" {
			format = DetectFormat(media)
		}
		candidates = append(candidates, candidate{url: media, format: format})
	}
	for _, quality := range qualities {
		duplicate := false
		for _, existing := range candidates {
			if existing.url == quality.URL {
				duplicate = true
				break
			}
		}
		if !duplicate {
			candidates = append(candidates, candidate{url: quality.URL, format: quality.Format})
		}
	}
	if len(candidates) > 4 {
		candidates = candidates[:4]
	}
	chosen := ""
	chosenFormat := ""
	for _, item := range candidates {
		if _, ok := mediaFormats[item.format]; !ok {
			continue
		}
		if r.playable(item.url, merged) {
			chosen = item.url
			chosenFormat = item.format
			break
		}
	}
	if chosen == "" {
		return nil
	}
	found := false
	for _, quality := range qualities {
		if quality.URL == chosen {
			found = true
			break
		}
	}
	if !found {
		defaultName := firstNonEmpty(stringOr(data["quality"]), "默认")
		qualities = append([]Quality{{Name: defaultName, URL: chosen, Format: chosenFormat, Headers: merged}}, qualities...)
	}
	scriptEpisodes := make([]Episode, 0, 8)
	if rawEpisodes, ok := data["episodes"].([]any); ok {
		for index, item := range rawEpisodes {
			object, ok := item.(map[string]any)
			if ok && stringOr(object["url"]) != "" {
				scriptEpisodes = append(scriptEpisodes, Episode{
					Name:     firstNonEmpty(stringOr(object["name"]), "第 "+itoa(index+1)+" 集"),
					URL:      stringOr(object["url"]),
					PlayPage: stringOr(object["playPage"]),
				})
				continue
			}
			if text, ok := item.(string); ok && text != "" {
				scriptEpisodes = append(scriptEpisodes, Episode{Name: "第 " + itoa(index+1) + " 集", URL: text})
			}
		}
	}
	if len(scriptEpisodes) > maxEpisodes {
		scriptEpisodes = scriptEpisodes[:maxEpisodes]
	}
	result := buildPlayResult(rule, target, firstNonEmpty(stringOr(data["title"]), host),
		chosen, merged, scriptEpisodes, "rule-script", "", qualities, chosenFormat)
	if note := stringOr(data["note"]); note != "" {
		result["note"] = note
	}
	return result
}

// fillTemplate 用 {name} 占位符替换变量；缺变量时报规则错误（与 Python 一致）。
func fillTemplate(template string, variables map[string]string) (string, error) {
	out := template
	for key, value := range variables {
		out = strings.ReplaceAll(out, "{"+key+"}", value)
	}
	if start := strings.Index(out, "{"); start >= 0 {
		if end := strings.Index(out[start:], "}"); end > 0 {
			return "", RuleErrorf("play.api.url 占位符不完整: %s", out[start:start+end+1])
		}
	}
	return out, nil
}
