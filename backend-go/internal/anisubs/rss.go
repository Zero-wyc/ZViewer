package anisubs

import (
	"context"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"zviewer/backend/internal/netutil"
	"zviewer/backend/internal/webfetch"
)

// RSS provider（ani-subs 变体），对应 provider.ts#createRssProvider。
//
// 与 services/anime 的 RSS 源是两份实现，且**语义不同**：这里只读
// `<description>`（不回落 summary/content），搜索结果也不带 cover/extra。
// 别把两边「统一」掉——前端两个模块分别依赖各自的字段集合。

// rssFeedItem 是订阅里的一条。
type rssFeedItem struct {
	title        string
	link         string
	description  string
	enclosureURL string
}

var (
	xmlItemPattern   = regexp.MustCompile(`(?is)<item[\s\S]*?</item>`)
	xmlEntryPattern  = regexp.MustCompile(`(?is)<entry[\s\S]*?</entry>`)
	xmlCDATAPattern  = regexp.MustCompile(`(?s)<!\[CDATA\[(.*?)\]\]>`)
	xmlNumericEntity = regexp.MustCompile(`&#(\d+);`)
	xmlHexEntity     = regexp.MustCompile(`&#x([0-9a-fA-F]+);`)
	xmlTagPattern    = regexp.MustCompile(`<[^>]+>`)
)

// decodeXMLEntities 解码常见实体，顺序与 Node 一致。
func decodeXMLEntities(input string) string {
	replaced := strings.NewReplacer(
		"&amp;", "&",
		"&lt;", "<",
		"&gt;", ">",
		"&quot;", `"`,
		"&#39;", "'",
	).Replace(input)
	replaced = xmlNumericEntity.ReplaceAllStringFunc(replaced, func(entity string) string {
		code, err := strconv.Atoi(entity[2 : len(entity)-1])
		if err != nil {
			return entity
		}
		return string(rune(code))
	})
	replaced = xmlHexEntity.ReplaceAllStringFunc(replaced, func(entity string) string {
		code, err := strconv.ParseInt(entity[3:len(entity)-1], 16, 32)
		if err != nil {
			return entity
		}
		return string(rune(code))
	})
	return replaced
}

// stripCDATA 去掉 CDATA 包装并去首尾空白。
func stripCDATA(input string) string {
	return strings.TrimSpace(xmlCDATAPattern.ReplaceAllString(input, "$1"))
}

// extractTextContent 取标签文本（首个匹配），去 CDATA 后解实体。
func extractTextContent(tagName, xml string) string {
	pattern := regexp.MustCompile(`(?is)<` + regexp.QuoteMeta(tagName) + `[^>]*>(.*?)</` + regexp.QuoteMeta(tagName) + `>`)
	match := pattern.FindStringSubmatch(xml)
	if len(match) != 2 {
		return ""
	}
	return decodeXMLEntities(stripCDATA(strings.TrimSpace(match[1])))
}

// extractAttribute 取标签属性值（首个匹配），只解实体。
func extractAttribute(tagName, attr, xml string) string {
	pattern := regexp.MustCompile(`(?is)<` + regexp.QuoteMeta(tagName) + `[^>]*\s` + regexp.QuoteMeta(attr) + `="([^"]*)"[^>]*>`)
	match := pattern.FindStringSubmatch(xml)
	if len(match) != 2 {
		return ""
	}
	return decodeXMLEntities(match[1])
}

// parseRSSItems 解析 RSS 2.0 的 <item>。
func parseRSSItems(xml string) []rssFeedItem {
	items := make([]rssFeedItem, 0, 16)
	for _, itemXML := range xmlItemPattern.FindAllString(xml, -1) {
		title := extractTextContent("title", itemXML)
		link := extractTextContent("link", itemXML)
		description := extractTextContent("description", itemXML)
		enclosureURL := extractAttribute("enclosure", "url", itemXML)
		if title == "" || (link == "" && enclosureURL == "") {
			continue
		}
		resolvedLink := link
		if resolvedLink == "" {
			resolvedLink = enclosureURL
		}
		items = append(items, rssFeedItem{
			title:        xmlTagPattern.ReplaceAllString(title, ""),
			link:         resolvedLink,
			description:  strings.TrimSpace(xmlTagPattern.ReplaceAllString(description, " ")),
			enclosureURL: enclosureURL,
		})
	}
	return items
}

// parseAtomItems 解析 Atom 的 <entry>。
func parseAtomItems(xml string) []rssFeedItem {
	items := make([]rssFeedItem, 0, 16)
	for _, entryXML := range xmlEntryPattern.FindAllString(xml, -1) {
		title := extractTextContent("title", entryXML)
		link := extractAttribute("link", "href", entryXML)
		description := extractTextContent("summary", entryXML)
		if description == "" {
			description = extractTextContent("content", entryXML)
		}
		if title == "" || link == "" {
			continue
		}
		items = append(items, rssFeedItem{
			title:       xmlTagPattern.ReplaceAllString(title, ""),
			link:        link,
			description: strings.TrimSpace(xmlTagPattern.ReplaceAllString(description, " ")),
		})
	}
	return items
}

// fetchFeedItems 拉取并解析订阅（带浏览器头）。
func fetchFeedItems(ctx context.Context, rawURL string) ([]rssFeedItem, error) {
	result := webfetch.Fetch(ctx, rawURL, webfetch.Options{
		Headers: BuildBrowserHeaders(rawURL, nil),
		Timeout: fetchTimeout,
	})
	if IsCloudflareBlocked(result) {
		return nil, cloudflareError(result.Status)
	}
	if !result.OK {
		return nil, fmt.Errorf("RSS 订阅请求失败 [%d]: %s%s", result.Status, rawURL, requestErrorSuffix(result))
	}
	xml := result.Body
	if strings.TrimSpace(xml) == "" {
		return nil, fmt.Errorf("RSS 订阅返回为空")
	}
	if strings.Contains(xml, "<feed") {
		return parseAtomItems(xml), nil
	}
	return parseRSSItems(xml), nil
}

// rssProvider 是订阅里 factoryId=rss 的数据源。
type rssProvider struct {
	sourceID string
	name     string
	feedURL  string
}

// NewRSSProvider 构造 RSS 数据源。
func NewRSSProvider(sourceID, displayName, feedURL string) Provider {
	return &rssProvider{sourceID: sourceID, name: displayName, feedURL: feedURL}
}

// Name 返回展示名。
func (p *rssProvider) Name() string { return p.name }

// Search 在订阅条目里按关键词过滤（标题或描述命中），最多 20 条。
func (p *rssProvider) Search(ctx context.Context, keyword string) ([]SearchResult, error) {
	// 支持 `{keyword}` 占位（如 nyaa.land）。
	feedURL := p.feedURL
	if strings.Contains(feedURL, "{keyword}") {
		feedURL = strings.ReplaceAll(feedURL, "{keyword}", netutil.EncodeURIComponent(keyword))
	}
	items, err := fetchFeedItems(ctx, feedURL)
	if err != nil {
		return nil, err
	}
	lower := strings.ToLower(keyword)
	results := make([]SearchResult, 0, 20)
	for _, item := range items {
		if !strings.Contains(strings.ToLower(item.title), lower) &&
			!strings.Contains(strings.ToLower(item.description), lower) {
			continue
		}
		results = append(results, SearchResult{
			ID:          item.link,
			Title:       item.title,
			Description: strPtr(item.description),
			Source:      p.sourceID,
		})
		if len(results) >= 20 {
			break
		}
	}
	return results, nil
}

// Episodes 每个订阅条目就是一集。
func (p *rssProvider) Episodes(ctx context.Context, identifier string) ([]Episode, error) {
	items, err := fetchFeedItems(ctx, p.feedURL)
	if err != nil {
		return nil, err
	}
	for _, item := range items {
		if item.link != identifier {
			continue
		}
		url := item.enclosureURL
		if url == "" {
			url = item.link
		}
		return []Episode{{
			ID:             item.link,
			Title:          item.title,
			EpisodeNumber:  1,
			PlaybackParams: map[string]any{"url": url},
		}}, nil
	}
	return nil, fmt.Errorf("未找到对应 RSS 条目")
}

// PlaybackURL 直接返回订阅条目里的媒体地址。
func (p *rssProvider) PlaybackURL(_ context.Context, episode Episode) (*PlaybackURL, error) {
	url, _ := episode.PlaybackParams["url"].(string)
	if url == "" {
		return nil, fmt.Errorf("缺少 RSS 条目播放地址")
	}
	return &PlaybackURL{URL: url}, nil
}
