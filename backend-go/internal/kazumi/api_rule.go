package kazumi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"sort"
	"strings"
	"time"

	"zviewer/backend/internal/anisubs"
	"zviewer/backend/internal/webfetch"
)

// Kazumi API 规则引擎，对应 services/kazumi/api-rule.ts。
//
// 对齐上游 Predidit/Kazumi apiLevel 9 的 API 规则运行时：
//   - 受限 JSONPath（`$.a.b[*]['key']`，禁过滤表达式/递归下降）
//   - @var 模板渲染（搜索 @keyword；详情页 @source；章节 @source + variables
//     捕获 + episodePage 的 @episodeUrl/@roadIndex/...）
//   - nested（JSONPath 结构化）/ delimited（苹果 CMS $$$/#/$ 分隔）两种章节格式
//
// 两种模式的最终产物都是**播放页 URL**，媒体地址解析仍由 scraper 完成。

// formatError 是规则/报文不合法（对应 Node 的 ApiRuleFormatException）。
//
// 路由层据此回 502 并带上原始文案——规则是社区写的，报错要能看懂是哪段配置错了。
type formatError struct{ message string }

func (e *formatError) Error() string { return e.message }

func formatErrorf(format string, args ...any) error {
	return &formatError{message: fmt.Sprintf(format, args...)}
}

// normalizeRuleMode 把 searchMode / chapterMode 归一化成 xpath/api。
func normalizeRuleMode(value any) string {
	if text, ok := value.(string); ok && text == "api" {
		return "api"
	}
	return "xpath"
}

// usesAPISearch 判断规则是否走 API 搜索。
func usesAPISearch(rule *Rule) bool {
	if normalizeRuleMode(rule.SearchMode) != "api" || rule.SearchAPIConfig == nil {
		return false
	}
	request := rule.SearchAPIConfig.Request
	if request == nil {
		return false
	}
	rawURL, ok := request.URL.(string)
	return ok && strings.TrimSpace(rawURL) != ""
}

// usesAPIChapters 判断规则是否走 API 选集。
func usesAPIChapters(rule *Rule) bool {
	if normalizeRuleMode(rule.ChapterMode) != "api" || rule.ChapterAPIConfig == nil {
		return false
	}
	request := rule.ChapterAPIConfig.Request
	if request == nil {
		return false
	}
	rawURL, ok := request.URL.(string)
	return ok && strings.TrimSpace(rawURL) != ""
}

// ---------------------------------------------------------------------------
// 受限 JSONPath
// ---------------------------------------------------------------------------

type pathTokenKind int

const (
	tokenProp pathTokenKind = iota
	tokenKey
	tokenIndex
	tokenWildcard
)

type pathToken struct {
	kind  pathTokenKind
	name  string
	index int
}

// parseJSONPath 把受限 JSONPath 解析成 token 序列。
//
// 语法白名单与上游 RestrictedJsonPath 一致：只认 `.prop`、`[0]`、`[*]`、
// `['key']`。**不执行任何表达式**——规则来自社区，把它当代码跑等于给了
// 规则作者任意执行权。
func parseJSONPath(expression string) ([]pathToken, error) {
	if !strings.HasPrefix(expression, "$") {
		return nil, formatErrorf("JSONPath 必须以 $ 开头: %s", expression)
	}
	tokens := make([]pathToken, 0, 8)
	for i := 1; i < len(expression); {
		char := expression[i]
		if char == '.' {
			i++
			start := i
			for i < len(expression) && isPropChar(expression[i]) {
				i++
			}
			if i == start {
				return nil, formatErrorf("不支持的 JSONPath: %s", expression)
			}
			tokens = append(tokens, pathToken{kind: tokenProp, name: expression[start:i]})
			continue
		}
		if char == '[' {
			end, err := findBracketEnd(expression, i)
			if err != nil {
				return nil, err
			}
			content := strings.TrimSpace(expression[i+1 : end])
			switch {
			case content == "*":
				tokens = append(tokens, pathToken{kind: tokenWildcard})
			case isDigits(content):
				index := 0
				for _, digit := range content {
					index = index*10 + int(digit-'0')
				}
				tokens = append(tokens, pathToken{kind: tokenIndex, index: index})
			case len(content) >= 2 &&
				((content[0] == '\'' && content[len(content)-1] == '\'') ||
					(content[0] == '"' && content[len(content)-1] == '"')):
				tokens = append(tokens, pathToken{kind: tokenKey, name: content[1 : len(content)-1]})
			default:
				return nil, formatErrorf("不支持的 JSONPath 片段: [%s]", content)
			}
			i = end + 1
			continue
		}
		return nil, formatErrorf("不支持的 JSONPath: %s", expression)
	}
	return tokens, nil
}

func isPropChar(char byte) bool {
	switch {
	case char >= 'a' && char <= 'z', char >= 'A' && char <= 'Z', char >= '0' && char <= '9':
		return true
	case char == '_', char == '$', char == '-':
		return true
	}
	return false
}

func isDigits(value string) bool {
	if value == "" {
		return false
	}
	for i := 0; i < len(value); i++ {
		if value[i] < '0' || value[i] > '9' {
			return false
		}
	}
	return true
}

// findBracketEnd 找到配对的 `]`，跳过引号内的内容（引号可转义）。
func findBracketEnd(expression string, start int) (int, error) {
	quote := byte(0)
	escaped := false
	for i := start + 1; i < len(expression); i++ {
		char := expression[i]
		if escaped {
			escaped = false
			continue
		}
		if char == '\\' {
			escaped = true
			continue
		}
		if quote != 0 {
			if char == quote {
				quote = 0
			}
			continue
		}
		if char == '\'' || char == '"' {
			quote = char
			continue
		}
		if char == ']' {
			return i, nil
		}
	}
	return 0, formatErrorf("JSONPath 缺少 ]: %s", expression)
}

// readTokens 按 token 逐层取值。
//
// 三条容易写错的语义（与上游一致）：
//   - `[*]` 之后是「每个元素继续走剩余 token」；
//   - 遇到数组时，prop/key 会**按元素展开**（标准 JSONPath 语义）；
//   - 键不存在时直接丢弃，不产出 null。
func readTokens(value any, tokens []pathToken, out *[]any) {
	if len(tokens) == 0 {
		*out = append(*out, value)
		return
	}
	head := tokens[0]
	rest := tokens[1:]

	if head.kind == tokenWildcard {
		switch typed := value.(type) {
		case []any:
			for _, item := range typed {
				readTokens(item, rest, out)
			}
		case map[string]any:
			// JS 用属性插入序，Go 的 map 无序——按键名排序，至少可复现。
			keys := make([]string, 0, len(typed))
			for key := range typed {
				keys = append(keys, key)
			}
			sort.Strings(keys)
			for _, key := range keys {
				readTokens(typed[key], rest, out)
			}
		}
		return
	}

	if items, ok := value.([]any); ok {
		for _, item := range items {
			readTokens(item, tokens, out)
		}
		return
	}
	object, ok := value.(map[string]any)
	if !ok {
		return
	}
	switch head.kind {
	case tokenProp, tokenKey:
		if next, present := object[head.name]; present {
			readTokens(next, rest, out)
		}
	case tokenIndex:
		// index 对对象无意义，跳过。
	}
}

// jsonPathRead 读取受限 JSONPath，返回全部匹配值。
func jsonPathRead(document any, expression string) ([]any, error) {
	tokens, err := parseJSONPath(expression)
	if err != nil {
		return nil, err
	}
	out := make([]any, 0, 4)
	readTokens(document, tokens, &out)
	return out, nil
}

// jsonPathReadFirst 读取第一个匹配值；没有匹配时返回 false。
func jsonPathReadFirst(document any, expression string) (any, bool, error) {
	values, err := jsonPathRead(document, expression)
	if err != nil {
		return nil, false, err
	}
	if len(values) == 0 {
		return nil, false, nil
	}
	return values[0], true, nil
}

// ---------------------------------------------------------------------------
// 模板渲染
// ---------------------------------------------------------------------------

func isIdentStart(char byte) bool {
	return char == '_' || (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z')
}

func isIdentChar(char byte) bool {
	return isIdentStart(char) || (char >= '0' && char <= '9')
}

// renderTemplate 把 `@name` 换掉；encode=true 时按 encodeURIComponent 编码。
//
// 变量名前面不能紧贴标识符字符（JS 侧是 `(?<![A-Za-z0-9_])@`），
// 所以 `mail@host` 里的 @host 不算变量。
func renderTemplate(template string, variables map[string]any, encode bool) (string, error) {
	var builder strings.Builder
	builder.Grow(len(template))
	for i := 0; i < len(template); {
		if template[i] == '@' && (i == 0 || !isIdentChar(template[i-1])) {
			start := i + 1
			if start < len(template) && isIdentStart(template[start]) {
				end := start
				for end < len(template) && isIdentChar(template[end]) {
					end++
				}
				name := template[start:end]
				value, present := variables[name]
				if !present {
					return "", formatErrorf("缺少模板变量 @%s", name)
				}
				text := jsStringOrEmpty(value)
				if encode {
					text = anisubs.EncodeURIComponent(text)
				}
				builder.WriteString(text)
				i = end
				continue
			}
		}
		builder.WriteByte(template[i])
		i++
	}
	return builder.String(), nil
}

// exactVarName 判断整个字符串是否恰好是 `@name`。
func exactVarName(value string) (string, bool) {
	if len(value) < 2 || value[0] != '@' || !isIdentStart(value[1]) {
		return "", false
	}
	for i := 1; i < len(value); i++ {
		if !isIdentChar(value[i]) {
			return "", false
		}
	}
	return value[1:], true
}

// renderValue 渲染请求体里的值：整串恰为 @var 时**原样返回**（不编码），
// 对象/数组递归，其余原样。
func renderValue(value any, variables map[string]any) (any, error) {
	switch typed := value.(type) {
	case string:
		if name, ok := exactVarName(typed); ok {
			raw, present := variables[name]
			if !present {
				return nil, formatErrorf("缺少模板变量 @%s", name)
			}
			return raw, nil
		}
		return renderTemplate(typed, variables, false)
	case []any:
		out := make([]any, 0, len(typed))
		for _, item := range typed {
			rendered, err := renderValue(item, variables)
			if err != nil {
				return nil, err
			}
			out = append(out, rendered)
		}
		return out, nil
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, item := range typed {
			renderedKey, err := renderTemplate(key, variables, false)
			if err != nil {
				return nil, err
			}
			rendered, err := renderValue(item, variables)
			if err != nil {
				return nil, err
			}
			out[renderedKey] = rendered
		}
		return out, nil
	}
	return value, nil
}

// renderMap 渲染 headers / query 这类「键和值都要过一遍模板」的表。
func renderMap(input map[string]any, variables map[string]any) (map[string]string, error) {
	out := make(map[string]string, len(input))
	for key, value := range input {
		renderedKey, err := renderTemplate(key, variables, false)
		if err != nil {
			return nil, err
		}
		rendered, err := renderValue(value, variables)
		if err != nil {
			return nil, err
		}
		out[renderedKey] = jsStringValue(rendered)
	}
	return out, nil
}

// jsStringValue 复刻 JS 的 String(x)。
//
//   - null → "null"（注意与 renderTemplate 的「null → 空串」不同）；
//   - 数组 → 元素用逗号连（String([1,2]) === "1,2"）；
//   - 对象 → "[object Object]"。
func jsStringValue(value any) string {
	switch typed := value.(type) {
	case nil:
		return "null"
	case string:
		return typed
	case bool:
		if typed {
			return "true"
		}
		return "false"
	case float64:
		return formatNumber(typed)
	case []any:
		parts := make([]string, 0, len(typed))
		for _, item := range typed {
			parts = append(parts, jsStringValue(item))
		}
		return strings.Join(parts, ",")
	case map[string]any:
		return "[object Object]"
	}
	return fmt.Sprint(value)
}

// jsStringOrEmpty 复刻 `value == null ? ” : String(value)`。
func jsStringOrEmpty(value any) string {
	if value == nil {
		return ""
	}
	return jsStringValue(value)
}

// stringValue 取配置里的字符串字段（缺省给空串）。
func stringValue(value any) string {
	if value == nil {
		return ""
	}
	if text, ok := value.(string); ok {
		return strings.TrimSpace(text)
	}
	return strings.TrimSpace(jsStringValue(value))
}

// ---------------------------------------------------------------------------
// 请求执行
// ---------------------------------------------------------------------------

// apiRequestTimeout 是单次 API 规则请求的上限（与 Node 的 20s 一致）。
const apiRequestTimeout = 20 * time.Second

// preparedRequest 是渲染完的一次请求。
type preparedRequest struct {
	Method      string
	URL         string
	Headers     map[string]string
	Body        string
	ContentType string
}

// prepareRequest 渲染并校验请求模板。
func prepareRequest(
	config *APIRequest,
	variables map[string]any,
	defaults struct{ UserAgent, Referer string },
) (*preparedRequest, error) {
	rawMethod := "GET"
	if config.Method != nil {
		rawMethod = jsStringValue(config.Method)
	}
	method := strings.ToUpper(rawMethod)
	if method != "GET" && method != "POST" {
		return nil, formatErrorf("仅支持 GET/POST，当前为 %s", method)
	}

	rawURL := stringValue(config.URL)
	if rawURL == "" {
		return nil, &formatError{message: "API 请求 URL 不能为空"}
	}
	renderedURL, err := renderTemplate(rawURL, variables, true)
	if err != nil {
		return nil, err
	}
	parsed, err := url.Parse(renderedURL)
	if err != nil {
		return nil, formatErrorf("API 请求 URL 无效: %s", renderedURL)
	}
	scheme := strings.ToLower(parsed.Scheme)
	if (scheme != "http" && scheme != "https") || parsed.Host == "" {
		return nil, formatErrorf("API 请求 URL 无效: %s", renderedURL)
	}
	parsed.Scheme = scheme

	headers := map[string]string{
		"User-Agent": firstNonEmpty(defaults.UserAgent, defaultUserAgent),
		"Accept":     "application/json, text/plain, */*",
	}
	if defaults.Referer != "" {
		headers["Referer"] = defaults.Referer
	}
	extraHeaders, err := renderMap(config.Headers, variables)
	if err != nil {
		return nil, err
	}
	for key, value := range extraHeaders {
		headers[key] = value
	}
	extraQuery, err := renderMap(config.Query, variables)
	if err != nil {
		return nil, err
	}
	if len(extraQuery) > 0 {
		query := parsed.Query()
		for key, value := range extraQuery {
			query.Set(key, value)
		}
		parsed.RawQuery = query.Encode()
	}

	prepared := &preparedRequest{
		Method:  method,
		URL:     serializeURL(parsed),
		Headers: headers,
	}

	bodyType := "none"
	if config.BodyType != nil {
		bodyType = jsStringValue(config.BodyType)
	}
	if method == "POST" && bodyType != "none" {
		rendered, err := renderValue(config.Body, variables)
		if err != nil {
			return nil, err
		}
		if bodyType == "json" {
			encoded, err := json.Marshal(rendered)
			if err != nil {
				return nil, &formatError{message: "请求体无法序列化为 JSON"}
			}
			prepared.Body = string(encoded)
			prepared.ContentType = "application/json"
		} else {
			form := url.Values{}
			if object, ok := rendered.(map[string]any); ok {
				for key, value := range object {
					form.Set(key, jsStringOrEmpty(value))
				}
			}
			prepared.Body = form.Encode()
			prepared.ContentType = "application/x-www-form-urlencoded"
		}
	}
	return prepared, nil
}

// executeRequest 发请求并解析 JSON 响应。
func executeRequest(ctx context.Context, prepared *preparedRequest) (any, error) {
	result := webfetch.Fetch(ctx, prepared.URL, webfetch.Options{
		Headers:     prepared.Headers,
		Method:      prepared.Method,
		Body:        prepared.Body,
		ContentType: prepared.ContentType,
		Timeout:     apiRequestTimeout,
	})
	if !result.OK {
		return nil, formatErrorf("API 请求失败 [%d]: %s%s", result.Status, prepared.URL, requestErrorSuffix(result))
	}
	var document any
	if err := json.Unmarshal([]byte(result.Body), &document); err != nil {
		return nil, &formatError{message: "API 响应不是有效 JSON"}
	}
	return document, nil
}

// ---------------------------------------------------------------------------
// 搜索
// ---------------------------------------------------------------------------

// APISearch 执行 API 搜索。
func APISearch(ctx context.Context, rule *Rule, keyword string) ([]SearchItem, error) {
	config := rule.SearchAPIConfig
	if config == nil {
		config = &APISearchConfig{}
	}
	request := config.Request
	if request == nil {
		request = &APIRequest{}
	}
	prepared, err := prepareRequest(request, map[string]any{"keyword": keyword}, struct{ UserAgent, Referer string }{
		UserAgent: rule.UserAgent,
		Referer:   firstNonEmpty(rule.Referer, rule.BaseURL),
	})
	if err != nil {
		return nil, err
	}
	document, err := executeRequest(ctx, prepared)
	if err != nil {
		return nil, err
	}

	listPath := firstNonEmpty(stringValue(config.ListPath), "$.data[*]")
	namePath := firstNonEmpty(stringValue(config.NamePath), "$.name")
	sourcePath := firstNonEmpty(stringValue(config.SourcePath), "$.url")
	template := stringValue(config.SourceTemplate)

	nodes, err := jsonPathRead(document, listPath)
	if err != nil {
		return nil, err
	}
	results := make([]SearchItem, 0, len(nodes))
	for _, node := range nodes {
		name, err := firstStringValue(node, namePath)
		if err != nil {
			return nil, err
		}
		source, err := firstStringValue(node, sourcePath)
		if err != nil {
			return nil, err
		}
		if name == "" || source == "" {
			continue
		}
		// 对齐上游：模板是**普通替换**（@source 可以紧跟字母），来源值 URL 编码。
		src := source
		if template != "" {
			src = strings.ReplaceAll(template, "@source", anisubs.EncodeURIComponent(source))
		}
		results = append(results, SearchItem{Name: name, Src: src})
	}
	return results, nil
}

// firstStringValue 读一个 JSONPath 首值并转成字符串（没匹配到给空串）。
func firstStringValue(document any, expression string) (string, error) {
	value, found, err := jsonPathReadFirst(document, expression)
	if err != nil {
		return "", err
	}
	if !found {
		return "", nil
	}
	return stringValue(value), nil
}

// ---------------------------------------------------------------------------
// 选集
// ---------------------------------------------------------------------------

// APIChapters 执行 API 选集，返回线路列表。
func APIChapters(ctx context.Context, rule *Rule, source string) ([]Road, error) {
	config := rule.ChapterAPIConfig
	if config == nil {
		config = &APIChapterConfig{}
	}
	request := config.Request
	if request == nil {
		request = &APIRequest{}
	}
	rootVariables := map[string]any{"source": source}

	prepared, err := prepareRequest(request, rootVariables, struct{ UserAgent, Referer string }{
		UserAgent: rule.UserAgent,
		Referer:   firstNonEmpty(rule.Referer, rule.BaseURL),
	})
	if err != nil {
		return nil, err
	}
	document, err := executeRequest(ctx, prepared)
	if err != nil {
		return nil, err
	}

	for name, path := range config.Variables {
		value, found, err := jsonPathReadFirst(document, stringValue(path))
		if err != nil {
			return nil, err
		}
		// JS 里只有 undefined（没匹配到）才算失败；匹配到 null 是合法的。
		if !found {
			return nil, formatErrorf("章节响应变量 %s 未匹配到值: %s", name, stringValue(path))
		}
		rootVariables[name] = value
	}

	format := firstNonEmpty(stringValue(config.Format), "nested")
	if format == "delimited" {
		return parseDelimited(document, config, rootVariables, rule.BaseURL)
	}
	return parseNested(document, config, rootVariables, rule.BaseURL)
}

// resolveEpisodeURL 按 episodePage 模板拼播放页地址。
func resolveEpisodeURL(
	config *APIChapterConfig,
	rootVariables map[string]any,
	rawURL string,
	roadIndex, episodeIndex int,
	baseURL string,
) (string, error) {
	page := config.EpisodePage
	if page == nil {
		return normalizeEpisodeURL(baseURL, rawURL), nil
	}
	pageURL := stringValue(page.URL)
	if pageURL == "" {
		return "", &formatError{message: "播放页地址模板不能为空"}
	}
	// 上游语义：0/1 基索引都提供；@episodeUrl 是 episodeUrlPath 提取的原值。
	variables := make(map[string]any, len(rootVariables)+5)
	for key, value := range rootVariables {
		variables[key] = value
	}
	variables["episodeUrl"] = rawURL
	variables["roadIndex"] = float64(roadIndex)
	variables["roadNumber"] = float64(roadIndex + 1)
	variables["episodeIndex"] = float64(episodeIndex)
	variables["episodeNumber"] = float64(episodeIndex + 1)

	path, err := renderTemplate(pageURL, variables, true)
	if err != nil {
		return "", err
	}
	parsed, err := url.Parse(path)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", formatErrorf("剧集页面 URL 无效: %s", path)
	}
	if len(page.Query) > 0 {
		query := parsed.Query()
		rendered, err := renderMap(page.Query, variables)
		if err != nil {
			return "", err
		}
		for key, value := range rendered {
			query.Set(key, value)
		}
		parsed.RawQuery = query.Encode()
	}
	return normalizeEpisodeURL(baseURL, serializeURL(parsed)), nil
}

// parseNested 解析 `format: nested`（JSONPath 结构化）。
func parseNested(
	document any,
	config *APIChapterConfig,
	rootVariables map[string]any,
	baseURL string,
) ([]Road, error) {
	roadsPath := stringValue(config.RoadsPath)
	roadNamePath := stringValue(config.RoadNamePath)
	episodesPath := firstNonEmpty(stringValue(config.EpisodesPath), "$.episodes[*]")
	episodeNamePath := firstNonEmpty(stringValue(config.EpisodeNamePath), "$.name")
	episodeURLPath := stringValue(config.EpisodeURLPath)

	roadNodes := []any{document}
	if roadsPath != "" {
		nodes, err := jsonPathRead(document, roadsPath)
		if err != nil {
			return nil, err
		}
		roadNodes = nodes
	}

	roads := make([]Road, 0, len(roadNodes))
	for roadIndex, roadNode := range roadNodes {
		roadName := ""
		if roadNamePath != "" {
			value, err := firstStringValue(roadNode, roadNamePath)
			if err != nil {
				return nil, err
			}
			roadName = value
		}
		episodeNodes, err := jsonPathRead(roadNode, episodesPath)
		if err != nil {
			return nil, err
		}
		urls := make([]string, 0, len(episodeNodes))
		titles := make([]string, 0, len(episodeNodes))
		for episodeIndex, episodeNode := range episodeNodes {
			episodeName, err := firstStringValue(episodeNode, episodeNamePath)
			if err != nil {
				return nil, err
			}
			rawURL := ""
			if episodeURLPath != "" {
				value, err := firstStringValue(episodeNode, episodeURLPath)
				if err != nil {
					return nil, err
				}
				rawURL = value
			}
			pageURL, err := resolveEpisodeURL(config, rootVariables, rawURL, roadIndex, episodeIndex, baseURL)
			if err != nil {
				return nil, err
			}
			if pageURL == "" {
				continue
			}
			urls = append(urls, pageURL)
			if episodeName == "" {
				episodeName = fmt.Sprintf("第%d集", episodeIndex+1)
			}
			titles = append(titles, episodeName)
		}
		if len(urls) == 0 {
			continue
		}
		if roadName == "" {
			roadName = fmt.Sprintf("播放线路%d", len(roads)+1)
		}
		roads = append(roads, Road{Name: roadName, URLs: urls, Titles: titles})
	}
	return roads, nil
}

// parseDelimited 解析 `format: delimited`（苹果 CMS `$$$` / `#` / `$` 分隔串）。
func parseDelimited(
	document any,
	config *APIChapterConfig,
	rootVariables map[string]any,
	baseURL string,
) ([]Road, error) {
	roadNamesPath := stringValue(config.RoadNamesPath)
	roadEpisodesPath := stringValue(config.RoadEpisodesPath)
	roadSeparator := firstNonEmpty(stringValue(config.RoadSeparator), "$$$")
	episodeSeparator := firstNonEmpty(stringValue(config.EpisodeSeparator), "#")
	fieldSeparator := firstNonEmpty(stringValue(config.FieldSeparator), "$")

	namesValue := ""
	if roadNamesPath != "" {
		value, err := firstStringValue(document, roadNamesPath)
		if err != nil {
			return nil, err
		}
		namesValue = value
	}
	episodesValue := ""
	if roadEpisodesPath != "" {
		value, err := firstStringValue(document, roadEpisodesPath)
		if err != nil {
			return nil, err
		}
		episodesValue = value
	}
	if episodesValue == "" {
		return []Road{}, nil
	}

	roadNames := strings.Split(namesValue, roadSeparator)
	roadGroups := strings.Split(episodesValue, roadSeparator)
	roads := make([]Road, 0, len(roadGroups))

	for roadIndex, group := range roadGroups {
		urls := make([]string, 0, 8)
		titles := make([]string, 0, 8)
		for episodeIndex, entry := range strings.Split(group, episodeSeparator) {
			entry = strings.TrimSpace(entry)
			if entry == "" {
				continue
			}
			separatorIndex := strings.Index(entry, fieldSeparator)
			if separatorIndex < 0 {
				continue
			}
			name := strings.TrimSpace(entry[:separatorIndex])
			rawURL := strings.TrimSpace(entry[separatorIndex+len(fieldSeparator):])
			pageURL, err := resolveEpisodeURL(config, rootVariables, rawURL, roadIndex, episodeIndex, baseURL)
			if err != nil {
				return nil, err
			}
			if pageURL == "" {
				continue
			}
			urls = append(urls, pageURL)
			if name == "" {
				name = fmt.Sprintf("第%d集", episodeIndex+1)
			}
			titles = append(titles, name)
		}
		if len(urls) == 0 {
			continue
		}
		roadName := ""
		if roadIndex < len(roadNames) {
			roadName = strings.TrimSpace(roadNames[roadIndex])
		}
		if roadName == "" {
			roadName = fmt.Sprintf("播放线路%d", len(roads)+1)
		}
		roads = append(roads, Road{Name: roadName, URLs: urls, Titles: titles})
	}
	return roads, nil
}
