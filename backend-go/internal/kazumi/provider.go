package kazumi

import (
	"context"
	"regexp"
	"strconv"

	"zviewer/backend/internal/anisubs"
	"zviewer/backend/internal/netutil"
)

// Provider 工厂，对应 services/kazumi/provider.ts。
//
// 一个 provider 就是「一份规则 + 一个 id」。规则里的 searchMode / chapterMode
// 决定搜索与选集各自走 XPath 抓页面还是 JSON 接口（两种可混搭）。

// keywordPattern 是规则里搜索词的占位符。
var keywordPattern = regexp.MustCompile(`@keyword`)

// episodeNumberPattern 是 Kazumi 的集号规则：`第 N 话/集`，否则取第一段数字。
//
// **不能复用 anisubs.ExtractEpisodeNumber**：那边的默认规则只有 `第 N 话/集`，
// 命不中直接返回 0；Kazumi 的正则带 `|(\d+)` 兜底，`EP12` 要得 12。
var episodeNumberPattern = regexp.MustCompile(`第\s*(\d+(?:\.\d+)?)\s*[话集]|(\d+(?:\.\d+)?)`)

// extractEpisodeNumber 抠集号；0 表示没抠到。
func extractEpisodeNumber(name string) float64 {
	match := episodeNumberPattern.FindStringSubmatch(name)
	if match == nil {
		return 0
	}
	value := match[1]
	if value == "" {
		value = match[2]
	}
	number, err := strconv.ParseFloat(value, 64)
	if err != nil {
		return 0
	}
	return number
}

// searchResultLimit 与 Node 的 `.slice(0, 20)` 一致。
const searchResultLimit = 20

// ruleProvider 是基于一份 Kazumi 规则的 provider。
type ruleProvider struct {
	id   string
	rule *Rule
}

// newProvider 用规则构造 provider。
func newProvider(sourceID string, rule *Rule) Provider {
	return &ruleProvider{id: sourceID, rule: rule}
}

func (p *ruleProvider) Name() string { return p.rule.Name }

// Search 搜索番剧。
func (p *ruleProvider) Search(ctx context.Context, keyword string) ([]SearchResult, error) {
	if usesAPISearch(p.rule) {
		items, err := APISearch(ctx, p.rule, keyword)
		if err != nil {
			return nil, err
		}
		seen := make(map[string]bool, len(items))
		results := make([]SearchResult, 0, len(items))
		for _, item := range items {
			// 详情地址归一化：裸 id 按 baseURL 补全（对齐上游 normalizeEpisodeUrl）。
			src := normalizeEpisodeURL(p.rule.BaseURL, item.Src)
			if src == "" || seen[src] {
				continue
			}
			seen[src] = true
			results = append(results, SearchResult{
				ID:     src,
				Title:  item.Name,
				Source: p.id,
			})
			if len(results) >= searchResultLimit {
				break
			}
		}
		return results, nil
	}

	searchURL := keywordPattern.ReplaceAllStringFunc(p.rule.SearchURL, func(string) string {
		return netutil.EncodeURIComponent(keyword)
	})
	markup, err := fetchHTML(ctx, searchURL, p.rule.UserAgent, firstNonEmpty(p.rule.Referer, p.rule.BaseURL))
	if err != nil {
		return nil, err
	}
	document, err := parseHTMLDocument(markup)
	if err != nil {
		return nil, err
	}

	// 搜索结果里的封面是懒加载 + 占位的重灾区，这段复用 ani-subs 那套
	// 「从详情链接往上爬、遇到同层别的番就停手」的读取器。
	readPoster := anisubs.NewSearchPosterReader(markup, searchURL)

	results := make([]SearchResult, 0, 20)
	seen := make(map[string]bool, 20)
	for _, node := range document.selectXPath(nil, p.rule.SearchList) {
		nameNodes := document.selectXPath(node.node, p.rule.SearchName)
		resultNodes := document.selectXPath(node.node, p.rule.SearchResult)
		title := ""
		if len(nameNodes) > 0 {
			title = nameNodes[0].text()
		}
		link := ""
		if len(resultNodes) > 0 {
			target := resultNodes[0]
			link = target.text()
			if href, ok := target.attr("href"); ok {
				link = href
			}
			link = absoluteURL(link, searchURL)
		}
		if title == "" || link == "" || seen[link] {
			continue
		}
		seen[link] = true
		results = append(results, SearchResult{
			ID:     link,
			Title:  title,
			Cover:  readPoster(link),
			Source: p.id,
		})
		if len(results) >= searchResultLimit {
			break
		}
	}
	return results, nil
}

// Episodes 取分集列表。
func (p *ruleProvider) Episodes(ctx context.Context, identifier string) ([]Episode, error) {
	// 归一化详情地址：旧规则是绝对 URL（幂等），新 API 规则可能是裸 id。
	subjectURL := normalizeEpisodeURL(p.rule.BaseURL, identifier)

	if usesAPIChapters(p.rule) {
		roads, err := APIChapters(ctx, p.rule, subjectURL)
		if err != nil {
			return nil, err
		}
		episodes := make([]Episode, 0, 16)
		for _, road := range roads {
			for index, episodeURL := range road.URLs {
				title := ""
				if index < len(road.Titles) {
					title = road.Titles[index]
				}
				episodeNumber := extractEpisodeNumber(title)
				episodes = append(episodes, Episode{
					ID:             title + "-" + formatNumber(episodeNumber) + "-" + episodeURL,
					Title:          title,
					EpisodeNumber:  episodeNumberOrOne(episodeNumber),
					PlaybackParams: map[string]any{"episodeUrl": episodeURL},
				})
			}
		}
		return episodes, nil
	}

	markup, err := fetchHTML(ctx, subjectURL, p.rule.UserAgent, firstNonEmpty(p.rule.Referer, p.rule.BaseURL))
	if err != nil {
		return nil, err
	}
	document, err := parseHTMLDocument(markup)
	if err != nil {
		return nil, err
	}
	// 分集页的基址是 **origin**（不是详情页地址）：规则里的 href 常写成
	// `/play/123-1-1.html` 这种根相对路径。
	baseURL := originOf(subjectURL)

	episodes := make([]Episode, 0, 24)
	for _, road := range document.selectXPath(nil, p.rule.ChapterRoads) {
		for _, node := range document.selectXPath(road.node, p.rule.ChapterResult) {
			title := node.text()
			link := title
			if href, ok := node.attr("href"); ok {
				link = href
			}
			link = absoluteURL(link, baseURL)
			if title == "" || link == "" {
				continue
			}
			episodeNumber := extractEpisodeNumber(title)
			episodes = append(episodes, Episode{
				ID:             title + "-" + formatNumber(episodeNumber) + "-" + link,
				Title:          title,
				EpisodeNumber:  episodeNumberOrOne(episodeNumber),
				PlaybackParams: map[string]any{"episodeUrl": link},
			})
		}
	}
	return episodes, nil
}

// PlaybackURL 解析播放地址。
func (p *ruleProvider) PlaybackURL(ctx context.Context, episode Episode) (*PlaybackURL, error) {
	episodeURL, _ := episode.PlaybackParams["episodeUrl"].(string)
	if episodeURL == "" {
		return nil, errEmptyEpisodeURL
	}

	headers := map[string]string{
		"Referer": firstNonEmpty(p.rule.Referer, p.rule.BaseURL),
	}
	if p.rule.UserAgent != "" {
		headers["User-Agent"] = p.rule.UserAgent
	}

	// API 章节规则的 episodeUrlPath 可以直接产出媒体地址（.m3u8/.mp4/.flv），
	// 不必再当播放页抓一遍。
	if format := anisubs.DetectMediaFormat(episodeURL); format != anisubs.FormatUnknown {
		return &PlaybackURL{URL: episodeURL, Headers: headers, Format: string(format)}, nil
	}

	resolved, err := resolveVideoURL(ctx, episodeURL, p.rule)
	if err != nil {
		return nil, err
	}
	if resolved == nil {
		return nil, nil
	}
	return &PlaybackURL{URL: resolved.URL, Headers: headers, Format: resolved.Format}, nil
}

// episodeNumberOrOne 复刻 `episodeNumber || 1`。
func episodeNumberOrOne(value float64) float64 {
	if value == 0 {
		return 1
	}
	return value
}
