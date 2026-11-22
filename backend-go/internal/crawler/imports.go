package crawler

import (
	"encoding/json"
	"regexp"
	"strings"

	"zviewer/backend/internal/anisubs"
	"zviewer/backend/internal/cms"
)

// 三个内置库 → 本地规则的编译器。
//
// 目标不是「把所有外源都变成规则」，而是把**能用规则表达**的那部分变成规则：
//
//   - CMS/TVBox：苹果 CMS 是标准协议，搜索与 vod_play_url 分组都能用
//     json 规则 + parse.groups 描述，编译后与采集库的搜索结果等价；
//   - AniSubs：订阅里的 web-selector 本来就是一串 CSS 选择器，
//     编译成 html 规则几乎是一一对应；
//   - Kazumi：XPath 规则可以编译（爬虫规则已支持 container_xpath），
//     但 API 模式（JSONPath + @var 章节模板）超出规则表达能力，明确跳过。
//
// 编译失败一律返回「跳过 + 原因」，不产出一条跑不通的规则：导入一堆红色规则
// 比不导入更糟。

// ImportedRule 是编译结果的一条。
type ImportedRule struct {
	Name     string   `json:"name"`
	Rule     *Rule    `json:"rule,omitempty"`
	Warnings []string `json:"warnings,omitempty"`
	// Reason 非空表示跳过（这条源不适合编译成规则）。
	Reason string `json:"reason,omitempty"`
}

func skipped(name, reason string) ImportedRule {
	return ImportedRule{Name: name, Reason: reason}
}

// cmsTemplateListPath 是苹果 CMS provide/vod 的固定返回结构。
const cmsTemplateListPath = "$.list"

// CMSRuleFromAPI 把一条苹果 CMS 采集接口编译成规则。
//
// 用 ac=detail&wd= 而不是 ac=videolist&wd=：只有 detail 才带 vod_play_url，
// 而分组剧集正是我们要的东西。多数 CMS 两个动作都支持 wd 参数。
func CMSRuleFromAPI(name, api string) ImportedRule {
	base := strings.TrimSpace(api)
	if at := strings.Index(base, "?"); at >= 0 {
		base = base[:at]
	}
	// 保留结尾斜杠：采集接口的路径对斜杠敏感（/provide/vod/ 与 /provide/vod 是两条路由）。
	display := strings.TrimSpace(name)
	if display == "" {
		display = HostOf(base)
	}
	if !httpAbsoluteRe.MatchString(base) {
		return skipped(display, "采集接口不是 http(s) 地址")
	}
	rule := &Rule{
		Name:        display,
		Site:        HostOf(base),
		Enabled:     true,
		Visibility:  "public",
		Description: "由 CMS 采集接口 " + base + " 导入（搜索 + 线路/选集）",
		Search: Search{
			Mode:    "http",
			Request: SearchRequest{Method: "GET", URL: base + "?ac=detail&wd={keyword}"},
		},
		Parse: Parse{
			Type:     "json",
			ListPath: cmsTemplateListPath,
			DedupeBy: "url",
			Fields: map[string]Field{
				"title":       {Path: "vod_name"},
				"url":         {Path: "vod_id", Prefix: base + "?ac=detail&ids="},
				"cover":       {Path: "vod_pic"},
				"description": {Path: "vod_remarks"},
				"play_url":    {Path: "vod_play_url"},
				"play_from":   {Path: "vod_play_from"},
			},
			Groups: &GroupSpec{Field: "play_url", NamesField: "play_from"},
		},
	}
	return ImportedRule{Name: display, Rule: rule}
}

// TVBoxSites 解析 TVBox/OK影视 配置里的 CMS 站点（只取苹果 CMS 采集站）。
func TVBoxSites(data []byte) ([]cms.Site, error) {
	var config struct {
		Sites []map[string]any `json:"sites"`
	}
	if err := json.Unmarshal(data, &config); err != nil {
		return nil, err
	}
	sites := make([]cms.Site, 0, len(config.Sites))
	seen := map[string]struct{}{}
	for _, entry := range config.Sites {
		site, ok := cms.ExtractSite(entry)
		if !ok {
			continue
		}
		if _, dup := seen[site.API]; dup {
			continue
		}
		seen[site.API] = struct{}{}
		sites = append(sites, site)
	}
	return sites, nil
}

// CMSRulesFromSites 把站点列表编译成规则（同名去重）。
func CMSRulesFromSites(sites []cms.Site) []ImportedRule {
	out := make([]ImportedRule, 0, len(sites))
	names := map[string]int{}
	for _, site := range sites {
		name := strings.TrimSpace(site.Name)
		if name == "" {
			name = HostOf(site.API)
		}
		// 不同配置里常有同名站点，加序号区分，否则规则列表里两行一模一样。
		if count := names[name]; count > 0 {
			names[name] = count + 1
			name = name + " " + itoa(count+1)
		} else {
			names[name] = 1
		}
		out = append(out, CMSRuleFromAPI(name, site.API))
	}
	return out
}

// unquotedAttrValueRe 匹配 `[attr=value]` 里没加引号的值。
var unquotedAttrValueRe = regexp.MustCompile(`\[([A-Za-z_][-\w:]*)([~^$*|]?=)([^"'\]][^\]]*)\]`)

// normalizeCSSSelector 给未加引号的属性值补引号。
//
// ani-subs 订阅里存在 `.nav a[href^=#playlist]` 这种写法：浏览器能跑，
// cascadia 直接判为非法选择器并返回空集。规则里保留原样会「一条都抓不到」。
func normalizeCSSSelector(selector string) string {
	trimmed := strings.TrimSpace(selector)
	if trimmed == "" || !strings.Contains(trimmed, "[") {
		return trimmed
	}
	return unquotedAttrValueRe.ReplaceAllStringFunc(trimmed, func(match string) string {
		parts := unquotedAttrValueRe.FindStringSubmatch(match)
		if len(parts) < 4 {
			return match
		}
		value := strings.TrimSpace(parts[3])
		if value == "" || strings.HasPrefix(value, `"`) || strings.HasPrefix(value, `'`) {
			return match
		}
		return "[" + parts[1] + parts[2] + `"` + value + `"]`
	})
}

// AniSubsRule 把一条 ani-subs 媒体源（web-selector）编译成规则。
func AniSubsRule(source anisubs.MediaSource) ImportedRule {
	name := strings.TrimSpace(source.Arguments.Name)
	if name == "" {
		name = source.FactoryID
	}
	config := source.Arguments.SearchConfig
	if config == nil {
		return skipped(name, "该源没有 web-selector 抓取配置（可能是 RSS 源）")
	}
	if !httpAbsoluteRe.MatchString(strings.TrimSpace(config.SearchURL)) {
		return skipped(name, "searchUrl 不是 http(s) 地址")
	}
	if !placeholderRe.MatchString(config.SearchURL) {
		return skipped(name, "searchUrl 里没有 {keyword} 占位符")
	}

	parse := Parse{Type: "html", DedupeBy: "url"}
	warnings := make([]string, 0, 2)
	switch strings.TrimSpace(config.SubjectFormatID) {
	case "a":
		selector := config.SelectorSubjectFormatA
		if selector == nil || strings.TrimSpace(selector.SelectLists) == "" {
			return skipped(name, "缺少 selectorSubjectFormatA.selectLists")
		}
		parse.Container = normalizeCSSSelector(selector.SelectLists)
		parse.Fields = map[string]Field{
			"title": {},
			"url":   {Attr: "href"},
		}
	case "indexed":
		selector := config.SelectorSubjectFormatIndexed
		if selector == nil || strings.TrimSpace(selector.SelectLinks) == "" {
			return skipped(name, "缺少 selectorSubjectFormatIndexed.selectLinks")
		}
		parse.Container = normalizeCSSSelector(selector.SelectLinks)
		parse.Fields = map[string]Field{
			// 名称与链接分列时，容器是链接本身，标题只能取链接文本。
			"title": {},
			"url":   {Attr: "href"},
		}
		warnings = append(warnings, "标题取链接文本，可能与源站名称不同")
	case "json-path-indexed":
		selector := config.SelectorSubjectFormatJSONPathIndexed
		if selector == nil {
			return skipped(name, "缺少 selectorSubjectFormatJsonPathIndexed")
		}
		listPath := deriveListPath(selector.SelectNames)
		if listPath == "" {
			return skipped(name, "selectNames 不是可用的 JSON 路径")
		}
		parse.Type = "json"
		parse.ListPath = listPath
		parse.Fields = map[string]Field{
			"title": {Path: selector.SelectNames},
			"url":   {Path: selector.SelectLinks},
			"cover": {Path: selector.SelectCovers},
		}
	default:
		return skipped(name, "不支持的搜索结果格式 "+strings.TrimSpace(config.SubjectFormatID))
	}

	play := &Play{}
	if channel := config.SelectorChannelFormatNoChannel; channel != nil {
		if selector := strings.TrimSpace(channel.SelectEpisodes); selector != "" {
			link := strings.TrimSpace(channel.SelectEpisodeLinks)
			field := Field{Attr: "href"}
			if link != "" {
				field.Selector = normalizeCSSSelector(link)
			}
			play.Episodes = &Parse{
				Type:      "html",
				Container: normalizeCSSSelector(selector),
				Fields: map[string]Field{
					"title": {},
					"url":   field,
				},
			}
		}
	} else if channel := config.SelectorChannelFormatFlattened; channel != nil {
		container := strings.TrimSpace(channel.SelectEpisodesFromList)
		if container == "" {
			container = strings.TrimSpace(channel.SelectEpisodeLists)
		}
		if container != "" {
			link := strings.TrimSpace(channel.SelectEpisodeLinksFromList)
			field := Field{Attr: "href"}
			if link != "" {
				field.Selector = normalizeCSSSelector(link)
			}
			play.Episodes = &Parse{
				Type:      "html",
				Container: normalizeCSSSelector(container),
				Fields: map[string]Field{
					"title": {},
					"url":   field,
				},
			}
			warnings = append(warnings, "多线路会按页面顺序合并成一列选集")
		}
	}
	if play.Episodes == nil {
		warnings = append(warnings, "源里没有可编译的选集配置，播放仍需走 AniSubs 库")
		play = nil
	}

	rule := &Rule{
		Name:        name,
		Site:        HostOf(config.SearchURL),
		Enabled:     true,
		Visibility:  "public",
		Description: "由 AniSubs 订阅源 " + source.FactoryID + " 导入",
		Search: Search{
			Mode:    "http",
			Request: SearchRequest{Method: "GET", URL: strings.TrimSpace(config.SearchURL)},
		},
		Parse: parse,
		Play:  play,
	}
	return ImportedRule{Name: name, Rule: rule, Warnings: warnings}
}

// deriveListPath 从 `$.data[*].name` 这类字段路径反推数组所在路径。
//
// 支持到最后一个属性之前：$.list[*].name → $.list[*]；$.data.items[*].n → $.data.items[*]。
func deriveListPath(path string) string {
	trimmed := strings.TrimSpace(path)
	if trimmed == "" {
		return ""
	}
	if at := strings.LastIndex(trimmed, "."); at > 0 {
		return strings.TrimSuffix(trimmed[:at], "$")
	}
	return ""
}

// kazumiRuleJSON 是 Kazumi 规则里编译要用的字段（其余字段编译无关）。
type kazumiRuleJSON struct {
	API           string `json:"api"`
	Type          string `json:"type"`
	Name          string `json:"name"`
	BaseURL       string `json:"baseURL"`
	SearchURL     string `json:"searchURL"`
	SearchList    string `json:"searchList"`
	SearchName    string `json:"searchName"`
	SearchResult  string `json:"searchResult"`
	ChapterRoads  string `json:"chapterRoads"`
	ChapterResult string `json:"chapterResult"`
	SearchMode    string `json:"searchMode"`
	ChapterMode   string `json:"chapterMode"`
	Referer       string `json:"referer"`
	UserAgent     string `json:"userAgent"`
}

// KazumiRule 把一条 Kazumi 规则编译成规则。
//
// 只支持 xpath 模式：Kazumi 的 api 模式是「JSONPath + @var 模板 + 章节页模板」，
// 规则语言里没有对应物，硬编译只会得到一条搜得到、播不了的规则。
func KazumiRule(data []byte) ImportedRule {
	var source kazumiRuleJSON
	if err := json.Unmarshal(data, &source); err != nil {
		return skipped("Kazumi 规则", "规则不是合法 JSON")
	}
	name := strings.TrimSpace(source.Name)
	if name == "" {
		name = strings.TrimSpace(source.API)
	}
	if mode := strings.TrimSpace(source.SearchMode); mode == "api" {
		return skipped(name, "API 模式规则（JSONPath + @var）无法用爬虫规则表达，请继续使用 Kazumi 库")
	}
	if strings.TrimSpace(source.SearchList) == "" ||
		strings.TrimSpace(source.SearchName) == "" ||
		strings.TrimSpace(source.SearchResult) == "" {
		return skipped(name, "缺少 searchList / searchName / searchResult，无法编译搜索")
	}
	searchURL := strings.TrimSpace(source.SearchURL)
	if !httpAbsoluteRe.MatchString(searchURL) {
		base := strings.TrimRight(strings.TrimSpace(source.BaseURL), "/")
		if base == "" {
			return skipped(name, "缺少 searchURL 与 baseURL")
		}
		if !strings.HasPrefix(searchURL, "/") {
			searchURL = "/" + searchURL
		}
		searchURL = base + searchURL
	}
	// Kazumi 用 @keyword，爬虫规则用 {keyword}。
	searchURL = strings.ReplaceAll(searchURL, "@keyword", "{keyword}")
	if !placeholderRe.MatchString(searchURL) {
		return skipped(name, "searchURL 里没有 @keyword 占位符")
	}
	warnings := make([]string, 0, 2)
	headers := map[string]string{}
	if referer := strings.TrimSpace(source.Referer); referer != "" {
		headers["Referer"] = referer
	}
	if agent := strings.TrimSpace(source.UserAgent); agent != "" {
		headers["User-Agent"] = agent
	}

	rule := &Rule{
		Name:        name,
		Site:        HostOf(searchURL),
		Enabled:     true,
		Visibility:  "public",
		Description: "由 Kazumi 规则 " + firstNonEmpty(strings.TrimSpace(source.API), name) + " 导入",
		Search: Search{
			Mode:    "http",
			Request: SearchRequest{Method: "GET", URL: searchURL, Headers: headers},
		},
		Parse: Parse{
			Type:           "html",
			ContainerXPath: strings.TrimSpace(source.SearchList),
			DedupeBy:       "url",
			Fields: map[string]Field{
				"title": xpathFieldSpec(source.SearchName, ""),
				"url":   xpathFieldSpec(source.SearchResult, "href"),
			},
		},
	}
	if roads := strings.TrimSpace(source.ChapterRoads); roads != "" && strings.TrimSpace(source.ChapterResult) != "" {
		rule.Play = &Play{
			Episodes: &Parse{
				Type:           "html",
				ContainerXPath: roads,
				Fields: map[string]Field{
					"title": xpathFieldSpec(source.ChapterResult, ""),
					"url":   xpathFieldSpec(source.ChapterResult, "href"),
				},
			},
		}
		warnings = append(warnings, "选集按页面顺序展开，多线路会合并")
	} else {
		warnings = append(warnings, "规则里没有章节配置，播放仍需走 Kazumi 库")
	}
	return ImportedRule{Name: name, Rule: rule, Warnings: warnings}
}

// xpathFieldSpec 生成字段规格：表达式已带 /@attr 时直接用，否则按 attr 取属性。
func xpathFieldSpec(expression, attr string) Field {
	trimmed := strings.TrimSpace(expression)
	spec := Field{XPath: trimmed}
	if strings.Contains(trimmed, "/@") {
		return spec
	}
	spec.Attr = attr
	return spec
}
