package anisubs

import (
	"errors"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/PuerkitoBio/goquery"
)

// 搜索结果页的通用元信息读取，对应 services/anime/searchMetadata.ts。
//
// 这段是 ani-subs 抓取里最容易出错的一块：结果列表页里封面常常是**懒加载**
// 属性 + 占位图，而且容器里挤着好几部番。所以既要按属性优先级找图，又要
// 从详情链接往上爬、遇到「同层还有别的番」就停手，避免拿错封面。

// backgroundImagePattern 从 style 里抠 background-image 的地址。
var backgroundImagePattern = regexp.MustCompile(`(?i)background(?:-image)?\s*:[^;]*url\(\s*['"]?([^'"\s)]+)['"]?\s*\)`)

// posterSelector 是可能带封面的元素集合。
const posterSelector = "img, [data-original], [data-src], [data-bg], [data-background], [style]"

// posterAttributes 是封面属性优先级：懒加载属性在前，src 兜底。
var posterAttributes = []string{
	"data-original", "data-src", "data-bg", "data-background",
	"data-lazy-src", "data-url", "src",
}

// ImageURL 把相对地址解析成绝对地址，只接受 http/https。
//
// 返回 nil 表示「这块不是可用图片」——调用方据此继续找下一个候选。
func ImageURL(value, baseURL string) *string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil
	}
	base, err := url.Parse(baseURL)
	if err != nil {
		return nil
	}
	ref, err := url.Parse(trimmed)
	if err != nil {
		return nil
	}
	resolved := base.ResolveReference(ref)
	if resolved.Scheme != "http" && resolved.Scheme != "https" {
		return nil
	}
	return strPtr(resolved.String())
}

// posterIn 在 scope 子树里找封面（scope 自己是候选时不额外向下找）。
func posterIn(scope *goquery.Selection, baseURL string) *string {
	var candidates *goquery.Selection
	if scope.Is(posterSelector) {
		candidates = scope.AddSelection(scope.Find(posterSelector))
	} else {
		candidates = scope.Find(posterSelector)
	}

	var poster *string
	candidates.EachWithBreak(func(_ int, item *goquery.Selection) bool {
		for _, attribute := range posterAttributes {
			value, ok := item.Attr(attribute)
			if !ok {
				continue
			}
			if found := ImageURL(value, baseURL); found != nil {
				poster = found
				return false
			}
		}
		if style, ok := item.Attr("style"); ok {
			if m := backgroundImagePattern.FindStringSubmatch(style); len(m) == 2 {
				if found := ImageURL(m[1], baseURL); found != nil {
					poster = found
					return false
				}
			}
		}
		return true
	})
	return poster
}

// NewSearchPosterReader 返回一个「按详情链接找封面」的闭包。
//
// 从匹配的 <a> 开始向父节点爬（最多 4 层）：
//   - 遇到 body/html 停；
//   - 一旦这一层还挂着**别的**详情链接，说明是共享列表容器，立刻停（否则会
//     把隔壁番的封面借过来）；
//   - 否则在这一层找封面，找到就返回。
func NewSearchPosterReader(html, baseURL string) func(detailURL string) *string {
	doc, err := goquery.NewDocumentFromReader(strings.NewReader(html))
	if err != nil {
		return func(string) *string { return nil }
	}
	links := make([]*goquery.Selection, 0, 64)
	doc.Find("a[href]").Each(func(_ int, item *goquery.Selection) {
		links = append(links, item)
	})

	return func(detailURL string) *string {
		for _, link := range links {
			scope := link
			href, _ := scope.Attr("href")
			resolved := ImageURL(href, baseURL)
			if resolved == nil || *resolved != detailURL {
				continue
			}
			for depth := 0; depth < 4 && scope.Length() > 0; depth++ {
				if scope.Is("body, html") {
					break
				}
				sharesContainer := false
				scope.Find("a[href]").EachWithBreak(func(_ int, item *goquery.Selection) bool {
					other, _ := item.Attr("href")
					resolved := ImageURL(other, baseURL)
					if resolved != nil && *resolved != detailURL {
						sharesContainer = true
						return false
					}
					return true
				})
				if sharesContainer {
					break
				}
				if poster := posterIn(scope, baseURL); poster != nil {
					return poster
				}
				scope = scope.Parent()
			}
		}
		return nil
	}
}

// jsonPathSegment 匹配 JSONPath 的一步：`.key` 或 `[*]` / `[0]` / `['a','b']`。
var jsonPathSegment = regexp.MustCompile(`^(?:\.([\w-]+)|\[(\*|\d+|'[^']+'(?:\s*,\s*'[^']+')*)\])`)

// jsonPathQuotedKey 从 `'a','b'` 里抠出各段 key。
var jsonPathQuotedKey = regexp.MustCompile(`'([^']+)'`)

// SelectJSONPath 执行 ani-subs 订阅里用到的那一小撮 JSONPath。
//
// 支持：`.key`、`[*]`、`[0]`、`['a','b']`。**不执行任何表达式**——订阅文件
// 来自社区，把它当代码跑等于给了订阅作者任意执行权。
//
// 与 JS 的唯一可见差异：`[*]` 作用在**对象**上时，JS 用属性插入序，
// Go 的 map 无序，这里改成按键名排序，至少保证稳定可复现。
func SelectJSONPath(document any, expression string) ([]any, error) {
	if !strings.HasPrefix(expression, "$") {
		return nil, errors.New("不支持的 JSONPath: " + expression)
	}
	values := []any{document}
	remaining := expression[1:]
	for remaining != "" {
		match := jsonPathSegment.FindStringSubmatch(remaining)
		if match == nil {
			return nil, errors.New("不支持的 JSONPath: " + expression)
		}
		var keys []string
		star := false
		switch {
		case match[1] != "":
			keys = []string{match[1]}
		case match[2] == "*":
			star = true
		default:
			quoted := jsonPathQuotedKey.FindAllStringSubmatch(match[2], -1)
			if len(quoted) == 0 {
				keys = []string{match[2]}
			} else {
				keys = make([]string, 0, len(quoted))
				for _, item := range quoted {
					keys = append(keys, item[1])
				}
			}
		}

		next := make([]any, 0, len(values))
		for _, value := range values {
			if star {
				next = append(next, jsonValues(value)...)
				continue
			}
			for _, key := range keys {
				next = append(next, jsonLookup(value, key))
			}
		}
		values = next
		remaining = remaining[len(match[0]):]
	}
	return values, nil
}

// jsonValues 复刻 `Object.values(x)`：对象取全部值，其他类型给 undefined。
func jsonValues(value any) []any {
	switch v := value.(type) {
	case map[string]any:
		keys := make([]string, 0, len(v))
		for key := range v {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		values := make([]any, 0, len(keys))
		for _, key := range keys {
			values = append(values, v[key])
		}
		return values
	case []any:
		return v
	}
	return []any{nil}
}

// jsonLookup 复刻 `hasOwnProperty(key) ? value[key] : undefined`。
func jsonLookup(value any, key string) any {
	switch v := value.(type) {
	case map[string]any:
		if item, ok := v[key]; ok {
			return item
		}
		return nil
	case []any:
		index, err := strconv.Atoi(key)
		if err != nil || index < 0 || index >= len(v) {
			return nil
		}
		return v[index]
	}
	return nil
}
