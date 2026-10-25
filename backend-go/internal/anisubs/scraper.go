package anisubs

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/PuerkitoBio/goquery"
	"github.com/dlclark/regexp2"
)

// HTML 抓取与选择器解析，对应 services/anisubs/scraper.ts。
//
// 订阅里的选择器由社区维护，功能上等价于 CSS3 子集 + JS 正则。
// CSS 交给 goquery（cascadia），**正则交给 regexp2**：ani-subs 的
// matchVideoUrl 大量使用 `(?!...)` 负向先行断言，而 Go 的 RE2 不支持断言，
// 换成 RE2 会让一半数据源「匹配不到播放地址」。
//
// regexp2 是回溯引擎，必须设 MatchTimeout：规则是外来的，碰上灾难性回溯
// 不能把整个进程拖住。

// regexTimeout 是单条规则的正则匹配上限。
const regexTimeout = 5 * time.Second

// defaultEpisodePattern 是没配 matchEpisodeSortFromName 时的默认集号规则。
var defaultEpisodePattern = regexp.MustCompile(`第\s*(\d+(?:\.\d+)?)\s*[话集]`)

// anyNumberPattern 是规则匹配失败后的兜底（取第一段数字）。
var anyNumberPattern = regexp.MustCompile(`(\d+(?:\.\d+)?)`)

// urlSchemePattern 判断是否已是绝对地址。
var urlSchemePattern = regexp.MustCompile(`(?i)^[a-z][a-z0-9+.-]*:`)

// ToAbsoluteURL 把相对地址补成绝对地址；已是绝对地址时原样返回。
func ToAbsoluteURL(rawURL, baseURL string) string {
	if rawURL == "" {
		return rawURL
	}
	if urlSchemePattern.MatchString(rawURL) {
		return rawURL
	}
	base, err := url.Parse(baseURL)
	if err != nil {
		return rawURL
	}
	ref, err := url.Parse(rawURL)
	if err != nil {
		return rawURL
	}
	return base.ResolveReference(ref).String()
}

// ResolveBaseURL 取 origin（protocol + host）。
func ResolveBaseURL(rawURL string) string {
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return rawURL
	}
	return parsed.Scheme + "://" + parsed.Host
}

// ExtractEpisodeNumber 从标题里抠集号；0 表示没抠到（调用方按 1 兜底）。
func ExtractEpisodeNumber(name, pattern string) float64 {
	if pattern == "" {
		if m := defaultEpisodePattern.FindStringSubmatch(name); m != nil {
			return parseFloatOrZero(m[1])
		}
		return 0
	}
	if re, err := compileRule(pattern); err == nil {
		if m, err := re.FindStringMatch(name); err == nil && m != nil {
			if group := m.GroupByName("ep"); group != nil && len(group.Captures) > 0 {
				return parseFloatOrZero(group.String())
			}
		}
	}
	if m := anyNumberPattern.FindStringSubmatch(name); m != nil {
		return parseFloatOrZero(m[1])
	}
	return 0
}

// MatchChannelName 匹配频道名，支持 `(?!...)` 负向断言的写法。
//
// 这段手写解析是照抄 Node 的：`(?!` 开头的模式拆成「排除 inner」+「必须匹配
// rest」。别换成「整条交给正则」——那会因为结尾的 `)` 位置不同而语义变化。
func MatchChannelName(name, pattern string) bool {
	if pattern == "" {
		return true
	}
	if strings.HasPrefix(pattern, "(?!") {
		end := strings.Index(pattern, ")")
		if end < 0 {
			return true
		}
		inner := pattern[3:end]
		rest := pattern[end+1:]
		if re, err := compileRule(inner); err == nil {
			if matched, err := re.MatchString(name); err == nil && matched {
				return false
			}
		}
		if rest == "" {
			return true
		}
		if re, err := compileRule(rest); err == nil {
			if matched, err := re.MatchString(name); err == nil {
				return matched
			}
		}
		return true
	}
	if re, err := compileRule(pattern); err == nil {
		if matched, err := re.MatchString(name); err == nil {
			return matched
		}
	}
	return true
}

// DetectMediaFormat 从 URL 推断容器格式。
func DetectMediaFormat(rawURL string) MediaFormat {
	lower := strings.ToLower(strings.SplitN(rawURL, "?", 2)[0])
	switch {
	case strings.HasSuffix(lower, ".m3u8"):
		return FormatHLS
	case strings.HasSuffix(lower, ".flv"):
		return FormatFLV
	case strings.HasSuffix(lower, ".mp4"):
		return FormatMP4
	case strings.Contains(lower, ".m3u8"):
		return FormatHLS
	case strings.Contains(lower, ".flv"):
		return FormatFLV
	case strings.Contains(lower, ".mp4"):
		return FormatMP4
	}
	return FormatUnknown
}

// compileRule 编译订阅规则（忽略大小写，带匹配超时）。
func compileRule(pattern string) (*regexp2.Regexp, error) {
	re, err := regexp2.Compile(pattern, regexp2.IgnoreCase)
	if err != nil {
		return nil, err
	}
	re.MatchTimeout = regexTimeout
	return re, nil
}

// firstGroupOrWhole 复刻 `match.groups?.v || match[0]`。
func firstGroupOrWhole(match *regexp2.Match, groupName string) string {
	if group := match.GroupByName(groupName); group != nil && len(group.Captures) > 0 {
		if value := group.String(); value != "" {
			return value
		}
	}
	return match.String()
}

// parseFloatOrZero 对应 `Number(x)` 后再判 NaN。
func parseFloatOrZero(value string) float64 {
	number, err := strconv.ParseFloat(strings.TrimSpace(value), 64)
	if err != nil {
		return 0
	}
	return number
}

// formatNumber 复刻 JS 的数字转字符串（1 → "1"，1.5 → "1.5"）。
func formatNumber(value float64) string {
	return strconv.FormatFloat(value, 'f', -1, 64)
}

// ---------------------------------------------------------------------------
// 搜索结果
// ---------------------------------------------------------------------------

// selectSubjectLinksA 解析 `subjectFormatId: 'a'`：列表项本身就是链接。
func selectSubjectLinksA(doc *goquery.Document, selector, baseURL string) []subjectLink {
	results := make([]subjectLink, 0, 16)
	doc.Find(selector).Each(func(_ int, item *goquery.Selection) {
		title := strings.TrimSpace(item.Text())
		if title == "" {
			title, _ = item.Attr("title")
		}
		if title == "" {
			title, _ = item.Attr("alt")
		}
		link, _ := item.Attr("href")
		if link == "" && item.Is("img") {
			link, _ = item.Closest("a").Attr("href")
		}
		if title == "" || link == "" {
			return
		}
		results = append(results, subjectLink{Title: title, URL: ToAbsoluteURL(link, baseURL)})
	})
	return results
}

// selectSubjectLinksIndexed 解析 `subjectFormatId: 'indexed'`：名称与链接分列两地，按下标对齐。
func selectSubjectLinksIndexed(doc *goquery.Document, namesSelector, linksSelector, baseURL string) []subjectLink {
	names := make([]string, 0, 16)
	doc.Find(namesSelector).Each(func(_ int, item *goquery.Selection) {
		names = append(names, strings.TrimSpace(item.Text()))
	})
	links := make([]string, 0, 16)
	doc.Find(linksSelector).Each(func(_ int, item *goquery.Selection) {
		href, _ := item.Attr("href")
		links = append(links, href)
	})

	results := make([]subjectLink, 0, len(names))
	for idx, title := range names {
		if title == "" || idx >= len(links) || links[idx] == "" {
			continue
		}
		results = append(results, subjectLink{Title: title, URL: ToAbsoluteURL(links[idx], baseURL)})
	}
	return results
}

// ParseSearchResults 解析搜索结果页。
func ParseSearchResults(html string, config *SearchConfig, searchURL string) ([]subjectLink, error) {
	baseURL := config.RawBaseURL
	if baseURL == "" {
		baseURL = searchURL
	}
	formatID := config.SubjectFormatID
	if formatID == "" {
		formatID = "a"
	}

	if formatID == "json-path-indexed" && config.SelectorSubjectFormatJSONPathIndexed != nil {
		var document any
		if err := json.Unmarshal([]byte(html), &document); err != nil {
			return nil, err
		}
		selector := config.SelectorSubjectFormatJSONPathIndexed
		names, err := SelectJSONPath(document, selector.SelectNames)
		if err != nil {
			return nil, err
		}
		links, err := SelectJSONPath(document, selector.SelectLinks)
		if err != nil {
			return nil, err
		}
		var covers []any
		if selector.SelectCovers != "" {
			covers, err = SelectJSONPath(document, selector.SelectCovers)
			if err != nil {
				return nil, err
			}
		}
		results := make([]subjectLink, 0, len(names))
		for index, rawTitle := range names {
			title, ok := rawTitle.(string)
			if !ok || strings.TrimSpace(title) == "" {
				continue
			}
			var rawLink string
			if index < len(links) {
				rawLink, _ = links[index].(string)
			}
			link := ImageURL(rawLink, baseURL)
			if link == nil {
				continue
			}
			var cover *string
			if index < len(covers) {
				if rawCover, ok := covers[index].(string); ok {
					cover = ImageURL(rawCover, baseURL)
				}
			}
			results = append(results, subjectLink{Title: strings.TrimSpace(title), URL: *link, Cover: cover})
		}
		return results, nil
	}

	doc, err := goquery.NewDocumentFromReader(strings.NewReader(html))
	if err != nil {
		return nil, err
	}
	readPoster := NewSearchPosterReader(html, baseURL)
	withPoster := func(links []subjectLink) []subjectLink {
		for i := range links {
			links[i].Cover = readPoster(links[i].URL)
		}
		return links
	}

	if formatID == "a" && config.SelectorSubjectFormatA != nil {
		return withPoster(selectSubjectLinksA(doc, config.SelectorSubjectFormatA.SelectLists, baseURL)), nil
	}
	if formatID == "indexed" && config.SelectorSubjectFormatIndexed != nil {
		return withPoster(selectSubjectLinksIndexed(
			doc,
			config.SelectorSubjectFormatIndexed.SelectNames,
			config.SelectorSubjectFormatIndexed.SelectLinks,
			baseURL,
		)), nil
	}
	if formatID != "a" && formatID != "indexed" {
		return nil, fmt.Errorf("不支持的搜索结果格式: %s", formatID)
	}
	return []subjectLink{}, nil
}

// ---------------------------------------------------------------------------
// 分集
// ---------------------------------------------------------------------------

// extractEpisodesIndexGrouped 解析「按线路分组」的详情页。
//
// 频道名与剧集列表是两个平行的选择器，靠**下标**对齐（第 N 个频道名对应
// 第 N 个列表容器），这是 ani-subs 规则里约定俗成的写法。
func extractEpisodesIndexGrouped(doc *goquery.Document, config *ChannelFormatFlattened, baseURL string) []episodeInfo {
	channelNames := make([]string, 0, 8)
	doc.Find(config.SelectChannelNames).Each(func(_ int, item *goquery.Selection) {
		channelNames = append(channelNames, strings.TrimSpace(item.Text()))
	})

	episodes := make([]episodeInfo, 0, 32)
	doc.Find(config.SelectEpisodeLists).Each(func(listIndex int, list *goquery.Selection) {
		channelName := ""
		if listIndex < len(channelNames) {
			channelName = channelNames[listIndex]
		}
		if !MatchChannelName(channelName, config.MatchChannelName) {
			return
		}
		list.Find(config.SelectEpisodesFromList).Each(func(_ int, item *goquery.Selection) {
			title := strings.TrimSpace(item.Text())
			link, _ := item.Attr("href")
			if link == "" && config.SelectEpisodeLinksFromList != "" {
				if found, ok := item.Find(config.SelectEpisodeLinksFromList).Attr("href"); ok {
					link = found
				} else if found, ok := item.Closest(config.SelectEpisodeLinksFromList).Attr("href"); ok {
					link = found
				} else {
					link = ""
				}
			}
			if title == "" || link == "" {
				return
			}
			episodeNumber := ExtractEpisodeNumber(title, config.MatchEpisodeSortFromName)
			displayTitle := title
			if channelName != "" {
				displayTitle = "[" + channelName + "] " + title
			}
			episodes = append(episodes, episodeInfo{
				ID:            channelName + "-" + title + "-" + formatNumber(episodeNumber),
				Title:         displayTitle,
				EpisodeNumber: episodeNumber,
				URL:           ToAbsoluteURL(link, baseURL),
			})
		})
	})
	return episodes
}

// extractEpisodesNoChannel 解析「不分线路」的详情页。
func extractEpisodesNoChannel(doc *goquery.Document, config *ChannelFormatNoChannel, baseURL string) []episodeInfo {
	episodes := make([]episodeInfo, 0, 32)
	doc.Find(config.SelectEpisodes).Each(func(_ int, item *goquery.Selection) {
		title := strings.TrimSpace(item.Text())
		link, _ := item.Attr("href")
		if link == "" && config.SelectEpisodeLinks != "" {
			if found, ok := item.Find(config.SelectEpisodeLinks).Attr("href"); ok {
				link = found
			} else if found, ok := item.Closest(config.SelectEpisodeLinks).Attr("href"); ok {
				link = found
			} else {
				link = ""
			}
		}
		if title == "" || link == "" {
			return
		}
		episodeNumber := ExtractEpisodeNumber(title, config.MatchEpisodeSortFromName)
		episodes = append(episodes, episodeInfo{
			ID:            title + "-" + formatNumber(episodeNumber),
			Title:         title,
			EpisodeNumber: episodeNumber,
			URL:           ToAbsoluteURL(link, baseURL),
		})
	})
	return episodes
}

// ParseEpisodes 解析详情页的分集列表。
func ParseEpisodes(html string, config *SearchConfig, subjectURL string) ([]episodeInfo, error) {
	doc, err := goquery.NewDocumentFromReader(strings.NewReader(html))
	if err != nil {
		return nil, err
	}
	baseURL := ResolveBaseURL(subjectURL)
	channelFormatID := config.ChannelFormatID
	if channelFormatID == "" {
		channelFormatID = "no-channel"
	}

	if channelFormatID == "index-grouped" && config.SelectorChannelFormatFlattened != nil {
		return extractEpisodesIndexGrouped(doc, config.SelectorChannelFormatFlattened, baseURL), nil
	}
	if channelFormatID == "no-channel" && config.SelectorChannelFormatNoChannel != nil {
		return extractEpisodesNoChannel(doc, config.SelectorChannelFormatNoChannel, baseURL), nil
	}
	return []episodeInfo{}, nil
}

// ---------------------------------------------------------------------------
// 播放地址
// ---------------------------------------------------------------------------

// findVideoURL 在页面里找播放地址。
func findVideoURL(html string, config *MatchVideo, pageURL string) *videoMatch {
	re, err := compileRule(config.MatchVideoURL)
	if err != nil {
		return nil
	}
	match, err := re.FindStringMatch(html)
	if err != nil || match == nil {
		return nil
	}

	rawURL := firstGroupOrWhole(match, "v")
	if rawURL == "" {
		return nil
	}
	if strings.HasPrefix(rawURL, "url=") {
		rawURL = rawURL[4:]
	}
	// 规则也会匹配「被拦截的请求 URL」；作用在 HTML 上时，贪婪匹配可能把
	// 周围的引号或标签一起吞进来，这里按定界符截断。
	if idx := strings.IndexAny(rawURL, "\"'<> \t\r\n"); idx >= 0 {
		rawURL = rawURL[:idx]
	}
	rawURL = strings.ReplaceAll(rawURL, "&amp;", "&")
	if rawURL == "" {
		return nil
	}
	absolute := ToAbsoluteURL(rawURL, pageURL)

	headers := map[string]string{}
	if config.AddHeadersToVideo != nil && config.AddHeadersToVideo.Referer != nil {
		// 规则显式写了 referer：空串表示「不带 Referer」，别回落。
		if *config.AddHeadersToVideo.Referer != "" {
			headers["Referer"] = *config.AddHeadersToVideo.Referer
		}
	} else {
		headers["Referer"] = pageURL
	}
	if config.AddHeadersToVideo != nil {
		if config.AddHeadersToVideo.UserAgent != "" {
			headers["User-Agent"] = config.AddHeadersToVideo.UserAgent
		}
		if config.AddHeadersToVideo.Origin != "" {
			headers["Origin"] = config.AddHeadersToVideo.Origin
		}
	}

	return &videoMatch{URL: absolute, Headers: headers, Format: DetectMediaFormat(absolute)}
}

// ResolveVideoURL 抓剧集页并解析播放地址；配了嵌套规则时会再抓一层。
func ResolveVideoURL(ctx context.Context, episodeURL string, config *MatchVideo) (*videoMatch, error) {
	html, err := fetchHTML(ctx, episodeURL, config.Cookies)
	if err != nil {
		return nil, err
	}
	if match := findVideoURL(html, config, episodeURL); match != nil {
		return match, nil
	}

	if !config.EnableNestedURL || config.MatchNestedURL == "" {
		return nil, nil
	}
	nestedRe, err := compileRule(config.MatchNestedURL)
	if err != nil {
		return nil, nil
	}
	nestedMatch, err := nestedRe.FindStringMatch(html)
	if err != nil || nestedMatch == nil || nestedMatch.String() == "" {
		return nil, nil
	}
	nestedURL := ToAbsoluteURL(nestedMatch.String(), episodeURL)
	nestedHTML, err := fetchHTML(ctx, nestedURL, config.Cookies)
	if err != nil {
		// 嵌套层失败不该把整个解析判死：外层没匹配到地址就是「解析不到」。
		return nil, nil
	}
	return findVideoURL(nestedHTML, config, nestedURL), nil
}
