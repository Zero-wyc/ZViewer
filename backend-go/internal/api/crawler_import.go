package api

// 外源导入：把 anisubs / Kazumi / CMS 的源编译成本地爬虫规则。
//
// 这是 P5 的落点：三个内置库不再只是「并列的另一个搜索入口」，而是能把
// 自己**能用规则表达**的那部分倒进本地规则库。导入后同一个站点在「本地规则」
// 里可搜、可测、可由 Agent 修改，与手写/生成的规则完全同权。
//
// 编译能力与边界在 internal/crawler/imports.go；这里只负责取数据、落库与回报。

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"zviewer/backend/internal/anisubs"
	"zviewer/backend/internal/cms"
	"zviewer/backend/internal/crawler"
	"zviewer/backend/internal/httpx"
)

// crawlerImportBody 是导入请求体。
type crawlerImportBody struct {
	Kind string `json:"kind"`
	// URLs 为空时用该库当前配置的地址列表（anisubs / kazumi 走注册表，忽略它）。
	URLs []string `json:"urls"`
	// Source 非空时只导入这一条（界面上的「导入这一条」）。
	Source string `json:"source"`
	DryRun bool   `json:"dryRun"`
}

const (
	crawlerImportMaxURLs = 30
	crawlerImportTimeout = 25 * time.Second
)

// crawlerImportItem 是一条源的编译结果。
type crawlerImportItem struct {
	Name     string         `json:"name"`
	RuleID   string         `json:"ruleId,omitempty"`
	Warnings []string       `json:"warnings,omitempty"`
	Skipped  string         `json:"skipped,omitempty"`
	Rule     map[string]any `json:"rule,omitempty"`
}

// handleCrawlerLibrariesImport 把某个库的源编译成规则。
//
// dryRun=true 只回报「会生成什么」，不落库——界面上先看清结果再决定导入。
func (s *Server) handleCrawlerLibrariesImport(w http.ResponseWriter, r *http.Request) {
	bundle := localBundle()
	if bundle == nil {
		httpx.Fail(w, http.StatusServiceUnavailable, "爬虫引擎未初始化")
		return
	}
	var body crawlerImportBody
	if err := httpx.DecodeJSON(r, &body); err != nil {
		httpx.BadRequest(w, "请求体不是有效 JSON")
		return
	}
	kind := strings.TrimSpace(body.Kind)
	if kind == crawlerLibraryLocal {
		httpx.BadRequest(w, "本地规则不需要导入")
		return
	}
	if _, ok := crawlerLibraryConfigKeys[kind]; !ok {
		httpx.BadRequest(w, "未知的来源库")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), crawlerImportTimeout)
	defer cancel()

	imported, listErr := s.compileLibrarySources(ctx, bundle, kind, body.URLs)
	if listErr != nil {
		httpx.Fail(w, http.StatusBadGateway, listErr.Error())
		return
	}
	if len(imported) == 0 {
		httpx.BadRequest(w, "该库里没有可编译的源，请先配置地址")
		return
	}
	if wanted := strings.TrimSpace(body.Source); wanted != "" {
		imported = filterImported(imported, wanted)
		if len(imported) == 0 {
			httpx.BadRequest(w, "没有找到名为「"+wanted+"」的源")
			return
		}
	}
	items := make([]crawlerImportItem, 0, len(imported))
	for _, candidate := range imported {
		item := crawlerImportItem{Name: candidate.Name, Warnings: candidate.Warnings}
		if candidate.Rule == nil {
			item.Skipped = candidate.Reason
			items = append(items, item)
			continue
		}
		if body.DryRun {
			item.Rule = crawler.PublicView(candidate.Rule, true)
			items = append(items, item)
			continue
		}
		saved, err := saveImportedRule(bundle, candidate.Rule)
		if err != nil {
			item.Skipped = err.Error()
			items = append(items, item)
			continue
		}
		item.RuleID = saved.ID
		items = append(items, item)
	}

	saved := 0
	for _, item := range items {
		if item.RuleID != "" {
			saved++
		}
	}
	httpx.OK(w, map[string]any{
		"success": true, "kind": kind, "dryRun": body.DryRun,
		"count": len(items), "saved": saved, "items": items,
	})
}

// compileLibrarySources 按库取源并编译。
//
// 三个库的「源从哪来」并不一样：
//   - cms：TVBox 配置地址（显式 url 或库配置），一个配置可能出多条；
//   - anisubs：注册表里的 SearchConfig（内置订阅只有注册表里有）；
//   - kazumi：注册表展开后的规则地址（索引要按 Kazumi 的 URL 规则展开）。
//
// 所以 anisubs / kazumi 不信调用方给的 url，一律走注册表；cms 保留 url 覆盖，
// 方便「导入一个还没存进配置的地址」。
func (s *Server) compileLibrarySources(ctx context.Context, bundle *crawler.Runtime, kind string, rawURLs []string) ([]crawler.ImportedRule, error) {
	switch kind {
	case crawlerLibraryAniSubs:
		configs := s.AniSubs.ImportConfigs(ctx)
		out := make([]crawler.ImportedRule, 0, len(configs))
		for _, item := range configs {
			out = append(out, crawler.AniSubsRuleFromConfig(item.Name, "web-selector", item.Config))
		}
		return out, nil
	case crawlerLibraryKazumi:
		urls, err := s.Kazumi.RuleURLs(ctx)
		if err != nil {
			return nil, err
		}
		out := make([]crawler.ImportedRule, 0, len(urls))
		for _, url := range urls {
			page, fetchErr := fetchImportJSON(ctx, bundle, url)
			if fetchErr != nil {
				out = append(out, crawler.ImportedRule{Name: url, Reason: "读取失败：" + fetchErr.Error()})
				continue
			}
			out = append(out, crawler.KazumiRule(page))
		}
		return out, nil
	default:
		urls := normalizeImportURLs(rawURLs)
		if len(urls) == 0 {
			urls = normalizeImportURLs(s.crawlerLibraryConfigURLs(ctx)[kind])
		}
		if len(urls) > crawlerImportMaxURLs {
			urls = urls[:crawlerImportMaxURLs]
		}
		out := make([]crawler.ImportedRule, 0, len(urls))
		for _, url := range urls {
			out = append(out, s.compileImportURL(ctx, bundle, kind, url)...)
		}
		return out, nil
	}
}

// filterImported 只保留指定名称的那一条（界面上的「导入这一条」）。
func filterImported(items []crawler.ImportedRule, name string) []crawler.ImportedRule {
	out := make([]crawler.ImportedRule, 0, 1)
	for _, item := range items {
		if item.Name == name {
			out = append(out, item)
		}
	}
	return out
}

// compileImportURL 取一个地址并按库编译；一个地址可能编译出多条规则（TVBox 配置）。
func (s *Server) compileImportURL(ctx context.Context, bundle *crawler.Runtime, kind, url string) []crawler.ImportedRule {
	page, err := fetchImportJSON(ctx, bundle, url)
	if err != nil {
		return []crawler.ImportedRule{{Name: url, Reason: "读取失败：" + err.Error()}}
	}
	switch kind {
	case crawlerLibraryCMS:
		return compileCMS(url, page)
	case crawlerLibraryAniSubs:
		return compileAniSubs(page)
	case crawlerLibraryKazumi:
		return compileKazumi(ctx, bundle, page, url)
	default:
		return []crawler.ImportedRule{{Name: url, Reason: "未知的来源库"}}
	}
}

func fetchImportJSON(ctx context.Context, bundle *crawler.Runtime, url string) ([]byte, error) {
	page, err := bundle.Fetcher.Fetch(ctx, crawler.Request{URL: url, Headers: map[string]string{
		"Accept": "application/json, text/plain, */*",
	}})
	if err != nil {
		return nil, err
	}
	return []byte(page.Text), nil
}

// compileCMS 先按 TVBox 配置解析，不像配置就当单条采集接口。
func compileCMS(url string, data []byte) []crawler.ImportedRule {
	sites, err := crawler.TVBoxSites(data)
	if err == nil && len(sites) > 0 {
		return crawler.CMSRulesFromSites(sites)
	}
	if cms.IsCMSAPI(url) {
		return []crawler.ImportedRule{crawler.CMSRuleFromAPI("", url)}
	}
	// 配置里没有 CMS 站点，或者地址本身不是采集接口。
	if err == nil {
		return []crawler.ImportedRule{{Name: url, Reason: "配置里没有苹果 CMS 采集站"}}
	}
	return []crawler.ImportedRule{{Name: url, Reason: "不是 TVBox 配置，也不像采集接口"}}
}

func compileAniSubs(data []byte) []crawler.ImportedRule {
	var subscription anisubs.Subscription
	if err := json.Unmarshal(data, &subscription); err != nil {
		return []crawler.ImportedRule{{Name: "订阅", Reason: "订阅不是合法 JSON"}}
	}
	sources := subscription.Sources()
	if len(sources) == 0 {
		return []crawler.ImportedRule{{Name: "订阅", Reason: "订阅里没有媒体源"}}
	}
	out := make([]crawler.ImportedRule, 0, len(sources))
	for _, source := range sources {
		out = append(out, crawler.AniSubsRule(source))
	}
	return out
}

// compileKazumi 支持单条规则与「规则地址数组」两种文件。
func compileKazumi(ctx context.Context, bundle *crawler.Runtime, data []byte, url string) []crawler.ImportedRule {
	var list []string
	if err := json.Unmarshal(data, &list); err == nil && len(list) > 0 {
		out := make([]crawler.ImportedRule, 0, len(list))
		for _, item := range list {
			target := strings.TrimSpace(item)
			if !strings.HasPrefix(target, "http") {
				continue
			}
			page, err := fetchImportJSON(ctx, bundle, target)
			if err != nil {
				out = append(out, crawler.ImportedRule{Name: target, Reason: "读取失败：" + err.Error()})
				continue
			}
			out = append(out, crawler.KazumiRule(page))
		}
		if len(out) == 0 {
			return []crawler.ImportedRule{{Name: url, Reason: "索引里没有可用的规则地址"}}
		}
		return out
	}
	return []crawler.ImportedRule{crawler.KazumiRule(data)}
}

// saveImportedRule 落库；同站点同名规则视为「再导入一次」，覆盖而不是复制。
func saveImportedRule(bundle *crawler.Runtime, rule *crawler.Rule) (*crawler.Rule, error) {
	existingID := ""
	for _, existing := range bundle.Store.List(true) {
		if existing.Site == rule.Site && existing.Name == rule.Name {
			existingID = existing.ID
			break
		}
	}
	return bundle.Store.Save(rule, existingID)
}

func normalizeImportURLs(values []string) []string {
	out := make([]string, 0, len(values))
	seen := map[string]struct{}{}
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" || !strings.HasPrefix(strings.ToLower(trimmed), "http") {
			continue
		}
		if _, dup := seen[trimmed]; dup {
			continue
		}
		seen[trimmed] = struct{}{}
		out = append(out, trimmed)
	}
	return out
}
