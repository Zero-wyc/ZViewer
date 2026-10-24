package anime

import (
	"context"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// RSS / Atom 订阅源，对应 services/anime/providers/rss.ts。
//
// 用正则而不是 XML 解析器：订阅源格式千奇百怪（未转义的裸 &、缺闭合标签），
// 严格解析器会整份拒收，正则只挑需要的几个标签，坏一条不影响其余条目。

// defaultUserAgent 与 Node 侧一致。
const defaultUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

// rssAcceptHeader 是订阅请求的 Accept（与 Node 逐字一致）。
const rssAcceptHeader = "application/rss+xml,application/atom+xml,application/xml;q=0.9,*/*;q=0.8"

// feedItem 是订阅里的一条。
type feedItem struct {
	title        string
	link         string
	description  string
	pubDate      string
	enclosureURL string
}

var (
	htmlTagPattern = regexp.MustCompile(`<[^>]+>`)
	cdataPattern   = regexp.MustCompile(`(?s)<!\[CDATA\[(.*?)\]\]>`)
	itemPattern    = regexp.MustCompile(`(?is)<item[\s\S]*?</item>`)
	entryPattern   = regexp.MustCompile(`(?is)<entry[\s\S]*?</entry>`)
	numericEntity  = regexp.MustCompile(`&#(\d+);`)
	hexEntity      = regexp.MustCompile(`&#x([0-9a-fA-F]+);`)
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
	replaced = numericEntity.ReplaceAllStringFunc(replaced, func(entity string) string {
		code, err := strconv.Atoi(entity[2 : len(entity)-1])
		if err != nil {
			return entity
		}
		return string(rune(code))
	})
	replaced = hexEntity.ReplaceAllStringFunc(replaced, func(entity string) string {
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
	return strings.TrimSpace(cdataPattern.ReplaceAllString(input, "$1"))
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

// extractAttribute 取标签属性值（首个匹配），只解实体不去 CDATA。
func extractAttribute(tagName, attr, xml string) string {
	pattern := regexp.MustCompile(`(?is)<` + regexp.QuoteMeta(tagName) + `[^>]*\s` + regexp.QuoteMeta(attr) + `="([^"]*)"[^>]*>`)
	match := pattern.FindStringSubmatch(xml)
	if len(match) != 2 {
		return ""
	}
	return decodeXMLEntities(match[1])
}

// firstNonEmpty 复刻 `a || b || c`。
func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

// parseRSSItems 解析 RSS 2.0 的 <item>。
func parseRSSItems(xml string) []feedItem {
	items := make([]feedItem, 0, 16)
	for _, itemXML := range itemPattern.FindAllString(xml, -1) {
		title := extractTextContent("title", itemXML)
		link := extractTextContent("link", itemXML)
		description := firstNonEmpty(
			extractTextContent("description", itemXML),
			extractTextContent("summary", itemXML),
			extractTextContent("content", itemXML),
		)
		pubDate := firstNonEmpty(
			extractTextContent("pubDate", itemXML),
			extractTextContent("published", itemXML),
			extractTextContent("updated", itemXML),
		)
		enclosureURL := extractAttribute("enclosure", "url", itemXML)

		if title == "" || (link == "" && enclosureURL == "") {
			continue
		}
		items = append(items, feedItem{
			title:        htmlTagPattern.ReplaceAllString(title, ""),
			link:         firstNonEmpty(link, enclosureURL),
			description:  strings.TrimSpace(htmlTagPattern.ReplaceAllString(description, " ")),
			pubDate:      pubDate,
			enclosureURL: enclosureURL,
		})
	}
	return items
}

// parseAtomItems 解析 Atom 的 <entry>。
func parseAtomItems(xml string) []feedItem {
	items := make([]feedItem, 0, 16)
	for _, entryXML := range entryPattern.FindAllString(xml, -1) {
		title := extractTextContent("title", entryXML)
		link := extractAttribute("link", "href", entryXML)
		description := firstNonEmpty(
			extractTextContent("summary", entryXML),
			extractTextContent("content", entryXML),
		)
		pubDate := firstNonEmpty(
			extractTextContent("published", entryXML),
			extractTextContent("updated", entryXML),
		)

		if title == "" || link == "" {
			continue
		}
		items = append(items, feedItem{
			title:       htmlTagPattern.ReplaceAllString(title, ""),
			link:        link,
			description: strings.TrimSpace(htmlTagPattern.ReplaceAllString(description, " ")),
			pubDate:     pubDate,
		})
	}
	return items
}

// fetchFeedItems 拉取并解析订阅。
func fetchFeedItems(ctx context.Context, url string) ([]feedItem, error) {
	resp, err := httpGet(ctx, url, map[string]string{
		"User-Agent": defaultUserAgent,
		"Accept":     rssAcceptHeader,
	})
	if err != nil {
		return nil, err
	}
	if resp.Status < 200 || resp.Status >= 300 {
		return nil, fmt.Errorf("RSS 订阅请求失败 [%d]: %s", resp.Status, url)
	}
	xml := string(resp.Body)
	if strings.TrimSpace(xml) == "" {
		return nil, fmt.Errorf("RSS 订阅返回为空")
	}
	if strings.Contains(xml, "<feed") {
		return parseAtomItems(xml), nil
	}
	return parseRSSItems(xml), nil
}

// rssProvider 是配置出来的 RSS 源。
type rssProvider struct {
	sourceID string
	name     string
	url      string
}

func newRSSProvider(sourceID, displayName, feedURL string) *rssProvider {
	return &rssProvider{sourceID: sourceID, name: displayName, url: feedURL}
}

// Name 返回展示名。
func (p *rssProvider) Name() string { return p.name }

// Search 在订阅条目里按关键词过滤（标题或描述命中），最多 20 条。
func (p *rssProvider) Search(ctx context.Context, keyword string) ([]SearchResult, error) {
	items, err := fetchFeedItems(ctx, p.url)
	if err != nil {
		return nil, err
	}
	lower := strings.ToLower(keyword)
	results := make([]SearchResult, 0, 20)
	for _, item := range items {
		if len(results) >= 20 {
			break
		}
		if !strings.Contains(strings.ToLower(item.title), lower) &&
			!strings.Contains(strings.ToLower(item.description), lower) {
			continue
		}
		results = append(results, SearchResult{
			ID:          item.link,
			Title:       item.title,
			Description: strPtr(item.description),
			Source:      p.sourceID,
			Extra:       map[string]any{"feedUrl": item.link},
		})
	}
	return results, nil
}

// Episodes 每个订阅条目就是一集。
func (p *rssProvider) Episodes(ctx context.Context, identifier string) ([]Episode, error) {
	items, err := fetchFeedItems(ctx, p.url)
	if err != nil {
		return nil, err
	}
	var target *feedItem
	for i := range items {
		if items[i].link == identifier {
			target = &items[i]
			break
		}
	}
	if target == nil {
		return nil, fmt.Errorf("未找到对应 RSS 条目")
	}
	return []Episode{{
		ID:            target.link,
		Title:         target.title,
		EpisodeNumber: 1,
		PlaybackParams: map[string]any{
			"url":   firstNonEmpty(target.enclosureURL, target.link),
			"title": target.title,
		},
	}}, nil
}

// PlaybackURL 直接返回订阅条目里的媒体地址。
func (p *rssProvider) PlaybackURL(_ context.Context, episode Episode) (*PlaybackURL, error) {
	url, _ := episode.PlaybackParams["url"].(string)
	if url == "" {
		return nil, fmt.Errorf("缺少 RSS 条目播放地址")
	}
	return &PlaybackURL{URL: url}, nil
}
