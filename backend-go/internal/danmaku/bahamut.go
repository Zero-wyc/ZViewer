package danmaku

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"zviewer/backend/internal/netutil"
	"zviewer/backend/internal/webfetch"
)

// 巴哈姆特动画疯弹幕源，对应 providers/bahamut.ts。
//
// 全程抓 HTML（站点没有公开 API）：搜索页 → 作品页 → 弹幕接口。
// 正则一律用 `['"]` 字符类兼容单双引号——站点的引号风格会随版本变。

const (
	bahamutUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
	// 巴哈姆特在台湾，大陆访问延迟高，10s 经常不够。
	bahamutTimeout = 25 * time.Second
	// 只对超时/网络层错误重试一次；HTTP 4xx/5xx 直接报错。
	bahamutMaxRetries = 1
)

var (
	// themeListPattern 是搜索结果的条目分界。
	themeListPattern = regexp.MustCompile(`(?i)class=['"]theme-list-main['"]`)
	// animeRefPattern 从条目里取作品 sn。
	animeRefPattern = regexp.MustCompile(`animeRef\.php\?sn=(\d+)`)
	// altPattern 取标题（img 的 alt）。
	altPattern = regexp.MustCompile(`alt=['"]([^'"]+)['"]`)
	// themeNamePattern 取标题（theme-name 文本）。
	themeNamePattern = regexp.MustCompile(`class=['"]theme-name['"]>([^<]+)<`)
	// coverPattern 取封面：懒加载属性优先。
	coverPattern = regexp.MustCompile(`data-src=['"]([^'"]+)['"]`)
	// imgSrcPattern 是封面的兜底。
	imgSrcPattern = regexp.MustCompile(`<img[^>]*src=['"]([^'"]+)['"]`)
	// episodePattern 取作品页里的分集链接。
	episodePattern = regexp.MustCompile(`<a[^>]*data-ani-video-sn=['"](\d+)['"][^>]*>([^<]+)</a>`)
	// animeVideoPattern 取作品页里的首个视频 sn。
	animeVideoPattern = regexp.MustCompile(`animeVideo\.php\?sn=(\d+)`)
	// numericEntityPattern 匹配 `&#123;`。
	numericEntityPattern = regexp.MustCompile(`&#(\d+);`)
)

// htmlEntityReplacer 处理命名实体（顺序无关，Replacer 一次扫描）。
var htmlEntityReplacer = strings.NewReplacer(
	"&amp;", "&",
	"&lt;", "<",
	"&gt;", ">",
	"&quot;", `"`,
	"&#39;", "'",
)

// decodeHTMLEntities 解码标题里的常见实体。
func decodeHTMLEntities(input string) string {
	decoded := htmlEntityReplacer.Replace(input)
	return numericEntityPattern.ReplaceAllStringFunc(decoded, func(entity string) string {
		code, err := strconv.Atoi(entity[2 : len(entity)-1])
		if err != nil {
			return entity
		}
		return string(rune(code))
	})
}

// normalizeBahamutCover 补全封面地址；空值返回 nil。
func normalizeBahamutCover(raw string) *string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil
	}
	if strings.HasPrefix(trimmed, "//") {
		return strPtr("https:" + trimmed)
	}
	if strings.HasPrefix(trimmed, "/") {
		return strPtr("https://ani.gamer.com.tw" + trimmed)
	}
	return strPtr(trimmed)
}

// bahamutFetchError 把网络层失败翻译成带阶段语义的文案。
func bahamutNetworkError(stage, url, message string) error {
	if strings.HasPrefix(message, "请求超时") {
		return fmt.Errorf("巴哈姆特%s超时（%ds）：%s", stage, int(bahamutTimeout/time.Second), url)
	}
	return fmt.Errorf("巴哈姆特%s网络错误：%s", stage, message)
}

// fetchBahamutHTML 抓页面，超时/网络错误重试一次。
func fetchBahamutHTML(ctx context.Context, url string) (string, error) {
	var lastErr string
	for attempt := 0; attempt <= bahamutMaxRetries; attempt++ {
		result := webfetch.Fetch(ctx, url, webfetch.Options{
			Timeout: bahamutTimeout,
			Headers: map[string]string{
				"User-Agent":      bahamutUserAgent,
				"Referer":         "https://ani.gamer.com.tw",
				"Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
				"Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
			},
		})
		// 网络层失败（Status 0）：重试一次，仍失败再抛。
		if result.Status == 0 {
			lastErr = result.Error
			if attempt < bahamutMaxRetries {
				select {
				case <-time.After(500 * time.Millisecond):
				case <-ctx.Done():
					return "", ctx.Err()
				}
				continue
			}
			return "", bahamutNetworkError("请求页面", url, lastErr)
		}
		if !result.OK {
			// HTTP 状态码错误不重试。
			return "", fmt.Errorf("巴哈姆特请求失败 [HTTP %d]：%s", result.Status, url)
		}
		if result.Error != "" {
			return "", fmt.Errorf("巴哈姆特读取页面内容失败：%s", result.Error)
		}
		return result.Body, nil
	}
	return "", bahamutNetworkError("请求页面", url, lastErr)
}

// bahamutSearchItem 是搜索结果条目。
type bahamutSearchItem struct {
	SN    string
	Title string
	Cover *string
}

// parseBahamutSearchBlock 解析单个 theme-list-main 区块。
func parseBahamutSearchBlock(block string) (bahamutSearchItem, bool) {
	snMatch := animeRefPattern.FindStringSubmatch(block)
	if len(snMatch) != 2 {
		return bahamutSearchItem{}, false
	}
	title := ""
	if match := altPattern.FindStringSubmatch(block); len(match) == 2 {
		title = match[1]
	} else if match := themeNamePattern.FindStringSubmatch(block); len(match) == 2 {
		title = match[1]
	}
	if strings.TrimSpace(title) == "" {
		title = "番剧 SN" + snMatch[1]
	}
	cover := ""
	if match := coverPattern.FindStringSubmatch(block); len(match) == 2 {
		cover = match[1]
	} else if match := imgSrcPattern.FindStringSubmatch(block); len(match) == 2 {
		cover = match[1]
	}
	return bahamutSearchItem{
		SN:    snMatch[1],
		Title: decodeHTMLEntities(strings.TrimSpace(title)),
		Cover: normalizeBahamutCover(cover),
	}, true
}

// searchBahamutByKeyword 抓搜索页并解析。
func searchBahamutByKeyword(ctx context.Context, keyword string) ([]bahamutSearchItem, error) {
	markup, err := fetchBahamutHTML(ctx,
		"https://ani.gamer.com.tw/search.php?keyword="+netutil.EncodeURIComponent(keyword))
	if err != nil {
		return nil, err
	}

	blocks := themeListPattern.Split(markup, -1)
	if len(blocks) <= 1 {
		return searchBahamutFallback(markup), nil
	}

	results := make([]bahamutSearchItem, 0, len(blocks))
	seen := make(map[string]bool, len(blocks))
	for _, block := range blocks[1:] {
		item, ok := parseBahamutSearchBlock(block)
		if !ok || seen[item.SN] {
			continue
		}
		seen[item.SN] = true
		results = append(results, item)
	}
	if len(results) == 0 {
		return searchBahamutFallback(markup), nil
	}
	if len(results) > 20 {
		results = results[:20]
	}
	return results, nil
}

// searchBahamutFallback 是页面结构变更时的兜底：
// 直接扫所有 animeRef 链接，取它前后各 500 字节当上下文再解析标题/封面。
func searchBahamutFallback(markup string) []bahamutSearchItem {
	results := make([]bahamutSearchItem, 0, 20)
	seen := make(map[string]bool, 20)

	for _, loc := range animeRefPattern.FindAllStringSubmatchIndex(markup, -1) {
		// loc = [start, end, groupStart, groupEnd]
		start, end := loc[0], loc[1]
		sn := markup[loc[2]:loc[3]]
		if seen[sn] {
			continue
		}
		seen[sn] = true

		contextStart := start - 500
		if contextStart < 0 {
			contextStart = 0
		}
		contextEnd := end + 500
		if contextEnd > len(markup) {
			contextEnd = len(markup)
		}
		item, ok := parseBahamutSearchBlock(markup[contextStart:contextEnd])
		if !ok {
			continue
		}
		// 上下文里可能先出现别的 sn，以当前这条为准。
		item.SN = sn
		results = append(results, item)
		if len(results) >= 20 {
			break
		}
	}
	return results
}

// bahamutEpisode 是作品页里的一集。
type bahamutEpisode struct {
	SN    string
	Label string
}

// getBahamutEpisodes 抓作品页解析分集。
func getBahamutEpisodes(ctx context.Context, sn string) ([]bahamutEpisode, error) {
	markup, err := fetchBahamutHTML(ctx, "https://ani.gamer.com.tw/animeRef.php?sn="+sn)
	if err != nil {
		return nil, err
	}

	episodes := make([]bahamutEpisode, 0, 24)
	seen := make(map[string]bool, 24)
	for _, match := range episodePattern.FindAllStringSubmatch(markup, -1) {
		if seen[match[1]] {
			continue
		}
		seen[match[1]] = true
		episodes = append(episodes, bahamutEpisode{SN: match[1], Label: strings.TrimSpace(match[2])})
	}

	if len(episodes) == 0 {
		videoSN := sn
		if match := animeVideoPattern.FindStringSubmatch(markup); len(match) == 2 {
			videoSN = match[1]
		}
		episodes = append(episodes, bahamutEpisode{SN: videoSN, Label: "1"})
	}
	return episodes, nil
}

// parseIntPrefix 复刻 JS 的 parseInt：只吃开头的合法数字，后面有什么都不管。
func parseIntPrefix(raw string, base int) (int64, bool) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return 0, false
	}
	end := 0
	for end < len(trimmed) {
		char := trimmed[end]
		valid := char >= '0' && char <= '9'
		if base == 16 {
			valid = valid || (char >= 'a' && char <= 'f') || (char >= 'A' && char <= 'F')
		}
		if !valid {
			break
		}
		end++
	}
	if end == 0 {
		return 0, false
	}
	value, err := strconv.ParseInt(trimmed[:end], base, 64)
	if err != nil {
		return 0, false
	}
	return value, true
}

// parseBahamutColor 把颜色归一化成 0xRRGGBB。
func parseBahamutColor(value any) int {
	switch typed := value.(type) {
	case float64:
		return int(typed)
	case json.Number:
		number, err := typed.Int64()
		if err != nil {
			return 0xffffff
		}
		return int(number)
	case string:
		trimmed := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(typed), "#"))
		if trimmed == "" {
			return 0xffffff
		}
		expanded := trimmed
		if len(trimmed) == 3 {
			expanded = string([]byte{trimmed[0], trimmed[0], trimmed[1], trimmed[1], trimmed[2], trimmed[2]})
		}
		if parsed, ok := parseIntPrefix(expanded, 16); ok {
			return int(parsed)
		}
		if parsed, ok := parseIntPrefix(trimmed, 10); ok {
			return int(parsed)
		}
	}
	return 0xffffff
}

// mapBahamutSize 把 1/2/3 档位映射成像素字号。
func mapBahamutSize(value any) int {
	number, ok := value.(float64)
	if !ok {
		return 25
	}
	switch number {
	case 1:
		return 20
	case 2:
		return 28
	case 3:
		return 36
	}
	return 25
}

// getBahamutDanmaku 调弹幕接口。
func getBahamutDanmaku(ctx context.Context, sn string) ([]Item, error) {
	const target = "https://ani.gamer.com.tw/ajax/danmuGet.php"
	form := "sn=" + netutil.EncodeURIComponent(sn)

	result := webfetch.Fetch(ctx, target, webfetch.Options{
		Method:      http.MethodPost,
		Body:        form,
		ContentType: "application/x-www-form-urlencoded; charset=UTF-8",
		Timeout:     bahamutTimeout,
		Headers: map[string]string{
			"User-Agent":       bahamutUserAgent,
			"Referer":          "https://ani.gamer.com.tw/animeVideo.php?sn=" + sn,
			"X-Requested-With": "XMLHttpRequest",
		},
	})
	if result.Status == 0 {
		return nil, bahamutNetworkError("获取弹幕", target, result.Error)
	}
	if !result.OK {
		return nil, fmt.Errorf("巴哈姆特弹幕接口返回失败 [HTTP %d]", result.Status)
	}

	// 接口直接返回数组；也兼容 { data: [] } 的老格式。
	var raw any
	if err := json.Unmarshal([]byte(result.Body), &raw); err != nil {
		return nil, fmt.Errorf("巴哈姆特弹幕接口响应解析失败：%v", err)
	}
	list := make([]any, 0, 64)
	switch typed := raw.(type) {
	case []any:
		list = typed
	case map[string]any:
		if items, ok := typed["data"].([]any); ok {
			list = items
		}
	}

	items := make([]Item, 0, len(list))
	for _, entry := range list {
		object, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		text, ok := object["text"].(string)
		if !ok || strings.TrimSpace(text) == "" {
			continue
		}

		// 巴哈姆特的时间是毫秒。
		timeMs := float64(0)
		switch typed := object["time"].(type) {
		case float64:
			timeMs = typed
		case string:
			if parsed, err := strconv.ParseFloat(strings.TrimSpace(typed), 64); err == nil {
				timeMs = parsed
			}
		}

		mode := 0
		if position, ok := object["position"].(float64); ok && (position == 1 || position == 2) {
			mode = int(position)
		}

		items = append(items, Item{
			ID:      bahamutItemID(object["sn"]),
			Content: text,
			Time:    timeMs / 1000,
			Mode:    mode,
			Color:   parseBahamutColor(object["color"]),
			Size:    mapBahamutSize(object["size"]),
		})
	}
	return items, nil
}

// bahamutItemID 取弹幕 id；缺失时与 Node 一样现造一个（这段只影响无 id 的弹幕）。
func bahamutItemID(raw any) string {
	switch typed := raw.(type) {
	case float64:
		return strconv.FormatFloat(typed, 'f', -1, 64)
	case string:
		if typed != "" {
			return typed
		}
	}
	return fmt.Sprintf("%d-%s", time.Now().UnixMilli(), randomSuffix())
}

// randomSuffix 复刻 Math.random().toString(36).slice(2, 8)。
func randomSuffix() string {
	const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"
	buffer := make([]byte, 6)
	for i := range buffer {
		buffer[i] = alphabet[rand.Intn(len(alphabet))]
	}
	return string(buffer)
}

// bahamutProvider 是巴哈姆特弹幕源。
type bahamutProvider struct{}

func (p *bahamutProvider) Name() string { return "巴哈姆特动画疯" }

func (p *bahamutProvider) Search(ctx context.Context, keyword string, _ Context) ([]SearchResult, error) {
	items, err := searchBahamutByKeyword(ctx, keyword)
	if err != nil {
		return nil, err
	}
	results := make([]SearchResult, 0, len(items))
	for _, item := range items {
		results = append(results, SearchResult{
			ID:     item.SN,
			Title:  item.Title,
			Cover:  item.Cover,
			Source: "bahamut",
			Extra:  map[string]any{"sn": item.SN},
		})
	}
	return results, nil
}

func (p *bahamutProvider) Episodes(ctx context.Context, identifier string, _ Context) ([]Episode, error) {
	sn := onlyDigits(identifier)
	if sn == "" {
		return nil, fmt.Errorf("无法解析巴哈姆特 SN")
	}
	episodes, err := getBahamutEpisodes(ctx, sn)
	if err != nil {
		return nil, err
	}
	results := make([]Episode, 0, len(episodes))
	for index, ep := range episodes {
		results = append(results, Episode{
			ID:             ep.SN,
			Title:          "第 " + ep.Label + " 集",
			EpisodeNumber:  float64(index + 1),
			PlaybackParams: map[string]any{"sn": ep.SN},
		})
	}
	return results, nil
}

func (p *bahamutProvider) Danmaku(ctx context.Context, episode Episode, _ Context) ([]Item, error) {
	sn, _ := episode.PlaybackParams["sn"].(string)
	if sn == "" {
		return nil, fmt.Errorf("缺少巴哈姆特 sn 参数")
	}
	return getBahamutDanmaku(ctx, sn)
}

// onlyDigits 复刻 `identifier.replace(/\D/g, ”)`。
func onlyDigits(input string) string {
	var builder strings.Builder
	for _, char := range input {
		if char >= '0' && char <= '9' {
			builder.WriteRune(char)
		}
	}
	return builder.String()
}
