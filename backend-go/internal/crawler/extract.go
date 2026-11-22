package crawler

import (
	"bytes"
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/PuerkitoBio/goquery"
	"github.com/antchfx/htmlquery"
)

// 结果抽取。对齐 Python 的 rules.py#_extract_html / _extract_json：
// 先按 container / list_path 拿到条目，再按 fields 逐字段取，title 与 url
// 任一为空的条目计入 skipped，最后按 dedupe_by 去重并截到 limit。

// Item 是一条搜索结果。字段名固定，extra 也可以出现在这里。
type Item map[string]string

// ExtractItems 解析页面。parse.type=script 不能走这里（需要 JS 运行时）。
func ExtractItems(rule *Rule, text, pageURL string) ([]Item, int, error) {
	parse := rule.Parse
	switch parse.Type {
	case "json":
		return extractJSON(rule, text, pageURL)
	case "script":
		return nil, 0, RuleError("parse.type=script 需要由 JS 运行时执行，不能走 ExtractItems", nil)
	default:
		return extractHTML(rule, text, pageURL)
	}
}

func extractHTML(rule *Rule, text, pageURL string) ([]Item, int, error) {
	parse := rule.Parse
	if strings.TrimSpace(parse.ContainerXPath) != "" {
		return extractHTMLXPath(rule, text, pageURL)
	}
	baseURL := parse.BaseURL
	if baseURL == "" {
		baseURL = pageURL
	}
	dom, err := ParseHTML(text)
	if err != nil {
		return nil, 0, err
	}
	containers, err := dom.SelectAll(parse.Container)
	if err != nil {
		return nil, 0, RuleErrorf("parse.container 选择器无效: %v", err)
	}
	items := make([]Item, 0, len(containers))
	skipped := 0
	for _, container := range containers {
		item := Item{}
		for name, spec := range parse.Fields {
			trimmedSelector := strings.TrimSpace(spec.Selector)
			var target *goquery.Selection
			if trimmedSelector == "" {
				target = container
			} else {
				found, findErr := SelectOne(container, trimmedSelector)
				if findErr != nil {
					return nil, 0, RuleErrorf("parse.fields.%s 选择器无效: %v", name, findErr)
				}
				target = found
			}
			item[name] = htmlFieldValue(target, spec, baseURL, name)
		}
		if item["title"] == "" || item["url"] == "" {
			skipped++
			continue
		}
		items = append(items, item)
	}
	return dedupeItems(items, parse.DedupeBy, parse.Limit), skipped, nil
}

// htmlFieldValue 取单字段：attr=html 是 outer，innerHTML 是 inner，
// text/innerText 是折叠空白后的文本，其余按属性名取；最后套 regex/prefix 并补绝对地址。
func htmlFieldValue(node *goquery.Selection, spec Field, baseURL, fieldName string) string {
	if node == nil {
		return ""
	}
	attr := strings.TrimSpace(spec.Attr)
	if attr == "" {
		attr = "text"
	}
	value := NodeAttr(node, attr)
	value = applyField(value, spec)
	if shouldAbsolute(spec, fieldName) && value != "" {
		value = joinURL(baseURL, value)
	}
	return value
}

// applyField 套 regex（单行模式、取 group）与前缀，并把空白折叠成单空格。
func applyField(value string, spec Field) string {
	out := value
	if pattern := strings.TrimSpace(spec.Regex); pattern != "" {
		// Python 用 re.S 让 . 跨行；Go 里用 (?s) 前缀等价。
		if compiled, err := regexp.Compile("(?s)" + pattern); err == nil {
			match := compiled.FindStringSubmatch(out)
			if match == nil {
				out = ""
			} else if spec.Group >= 0 && spec.Group < len(match) {
				out = match[spec.Group]
			} else {
				out = match[0]
			}
		} else {
			out = ""
		}
	}
	if spec.Prefix != "" {
		out = spec.Prefix + out
	}
	return CollapseSpace(out)
}

func shouldAbsolute(spec Field, fieldName string) bool {
	if spec.Absolute != nil {
		return *spec.Absolute
	}
	return fieldName == "url" || fieldName == "cover"
}

// extractHTMLXPath 用 XPath 选条目与字段。
//
// 与 CSS 分支的结果形状完全一致（Item + skipped + 去重），因此上层无感知。
func extractHTMLXPath(rule *Rule, text, pageURL string) ([]Item, int, error) {
	parse := rule.Parse
	baseURL := parse.BaseURL
	if baseURL == "" {
		baseURL = pageURL
	}
	doc, err := htmlquery.Parse(strings.NewReader(text))
	if err != nil {
		return nil, 0, RuleErrorf("HTML 解析失败: %v", err)
	}
	containers := xpathSelect(doc, doc, parse.ContainerXPath)
	items := make([]Item, 0, len(containers))
	skipped := 0
	for _, container := range containers {
		node := container.node
		if node == nil {
			continue
		}
		item := Item{}
		for name, spec := range parse.Fields {
			value := ""
			switch {
			case strings.TrimSpace(spec.XPath) != "":
				if nodes := xpathSelect(doc, node, spec.XPath); len(nodes) > 0 {
					value = xpathFieldValue(nodes[0], spec)
				}
			case strings.TrimSpace(spec.Selector) == "":
				// 没写选择器/XPath 的字段取容器自身文本，与 CSS 分支同义。
				value = CollapseSpace(collapseXPathText(node))
			default:
				return nil, 0, RuleErrorf("parse.fields.%s 在 XPath 规则里必须用 xpath 字段", name)
			}
			value = applyField(value, spec)
			if shouldAbsolute(spec, name) && value != "" {
				value = joinURL(baseURL, value)
			}
			item[name] = value
		}
		if item["title"] == "" || item["url"] == "" {
			skipped++
			continue
		}
		items = append(items, item)
	}
	return dedupeItems(items, parse.DedupeBy, parse.Limit), skipped, nil
}

// xpathFieldValue 取文本或属性（attr 为 text/innerText 时取文本）。
func xpathFieldValue(value xpathValue, spec Field) string {
	attr := strings.TrimSpace(spec.Attr)
	if attr == "" || attr == "text" || attr == "innerText" {
		return value.text()
	}
	return value.attrValue(attr)
}

func extractJSON(rule *Rule, text, pageURL string) ([]Item, int, error) {
	var data any
	decoder := json.NewDecoder(strings.NewReader(text))
	// UseNumber 保留原始数字写法（1.0 不会被折成 1），与 Python 的 json 语义一致。
	decoder.UseNumber()
	if err := decoder.Decode(&data); err != nil {
		return nil, 0, RuleErrorf("站点返回的不是有效 JSON: %v", err)
	}
	parse := rule.Parse
	rawItems, err := jsonPath(data, parse.ListPath)
	if err != nil {
		return nil, 0, err
	}
	if len(rawItems) == 1 {
		if list, ok := rawItems[0].([]any); ok {
			rawItems = list
		}
	}
	baseURL := parse.BaseURL
	if baseURL == "" {
		baseURL = pageURL
	}
	items := make([]Item, 0, len(rawItems))
	skipped := 0
	for _, rawItem := range rawItems {
		item := Item{}
		for name, spec := range parse.Fields {
			values, pathErr := jsonPath(rawItem, spec.Path)
			if pathErr != nil {
				return nil, 0, pathErr
			}
			value := ""
			if len(values) > 0 {
				value = jsonScalarText(values[0])
			}
			value = applyField(value, spec)
			if shouldAbsolute(spec, name) && value != "" {
				value = joinURL(baseURL, value)
			}
			item[name] = value
		}
		if item["title"] == "" || item["url"] == "" {
			skipped++
			continue
		}
		items = append(items, item)
	}
	return dedupeItems(items, parse.DedupeBy, parse.Limit), skipped, nil
}

// jsonScalarText 把 JSON 值转成字符串；对象/数组用紧凑 JSON（不转义 HTML 字符）。
func jsonScalarText(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return strings.TrimSpace(typed)
	case json.Number:
		return typed.String()
	case bool:
		if typed {
			return "true"
		}
		return "false"
	case map[string]any, []any:
		var buffer bytes.Buffer
		encoder := json.NewEncoder(&buffer)
		encoder.SetEscapeHTML(false)
		if err := encoder.Encode(typed); err != nil {
			return ""
		}
		return strings.TrimSpace(buffer.String())
	default:
		return CollapseSpace(fmt.Sprint(typed))
	}
}

// jsonPathToken 是 JSON 路径的一段。
type jsonPathToken struct {
	kind string // all | index | key
	key  string
	idx  int
}

var jsonPathSegmentRe = regexp.MustCompile(`^([^\[\]]*)((?:\[[^\]]*\])*)$`)
var jsonPathBracketRe = regexp.MustCompile(`\[([^\]]*)\]`)

// jsonPath 支持 data.list / data.items[*].title / list[0][1] 这类路径，
// 与 Python 的 _json_path 同语义。
func jsonPath(data any, path string) ([]any, error) {
	trimmed := strings.TrimSpace(path)
	trimmed = strings.TrimPrefix(trimmed, "$")
	tokens := make([]jsonPathToken, 0, 4)
	for _, rawPart := range splitJSONPath(trimmed) {
		part := strings.TrimSpace(rawPart)
		if part == "" {
			continue
		}
		match := jsonPathSegmentRe.FindStringSubmatch(part)
		if match == nil {
			return nil, RuleErrorf("JSON 路径无效: %s", path)
		}
		name, brackets := match[1], match[2]
		if name != "" {
			tokens = append(tokens, jsonPathToken{kind: "key", key: name})
		}
		for _, bracket := range jsonPathBracketRe.FindAllStringSubmatch(brackets, -1) {
			body := strings.TrimSpace(bracket[1])
			if body == "" || body == "*" {
				tokens = append(tokens, jsonPathToken{kind: "all"})
				continue
			}
			if index, err := strconv.Atoi(body); err == nil {
				tokens = append(tokens, jsonPathToken{kind: "index", idx: index})
				continue
			}
			tokens = append(tokens, jsonPathToken{kind: "key", key: strings.Trim(body, `"'`)})
		}
	}
	values := []any{data}
	for _, token := range tokens {
		next := make([]any, 0, len(values))
		for _, value := range values {
			switch token.kind {
			case "all":
				switch typed := value.(type) {
				case []any:
					next = append(next, typed...)
				case map[string]any:
					for _, item := range typed {
						next = append(next, item)
					}
				}
			case "index":
				if typed, ok := value.([]any); ok {
					index := token.idx
					if index < 0 {
						index += len(typed)
					}
					if index >= 0 && index < len(typed) {
						next = append(next, typed[index])
					}
				}
			default:
				if typed, ok := value.(map[string]any); ok {
					if item, ok := typed[token.key]; ok {
						next = append(next, item)
					}
				}
			}
		}
		values = next
	}
	return values, nil
}

// splitJSONPath 按不在方括号内的点切分路径。
func splitJSONPath(path string) []string {
	parts := make([]string, 0, 4)
	var buffer strings.Builder
	depth := 0
	runes := []rune(path)
	for index := 0; index < len(runes); index++ {
		char := runes[index]
		switch char {
		case '[':
			depth++
			buffer.WriteRune(char)
		case ']':
			if depth > 0 {
				depth--
			}
			buffer.WriteRune(char)
		case '.':
			if depth == 0 {
				parts = append(parts, buffer.String())
				buffer.Reset()
				continue
			}
			buffer.WriteRune(char)
		default:
			buffer.WriteRune(char)
		}
	}
	parts = append(parts, buffer.String())
	return parts
}

// dedupeItems 按 dedupe_by 去重并截断到 limit（空键不参与去重，与 Python 一致）。
func dedupeItems(items []Item, dedupeBy string, limit int) []Item {
	seen := make(map[string]struct{}, len(items))
	out := make([]Item, 0, len(items))
	for _, item := range items {
		key := item[dedupeBy]
		if key != "" {
			if _, ok := seen[key]; ok {
				continue
			}
			seen[key] = struct{}{}
		}
		out = append(out, item)
		if limit > 0 && len(out) >= limit {
			break
		}
	}
	return out
}
