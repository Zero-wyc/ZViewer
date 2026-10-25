package kazumi

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/antchfx/htmlquery"
	"github.com/antchfx/xpath"
	"golang.org/x/net/html"

	"zviewer/backend/internal/anisubs"
	"zviewer/backend/internal/webfetch"
)

// Kazumi 的 HTML 抓取与 XPath 解析层，对应 services/kazumi/scraper.ts。
//
// Node 侧的链路是 htmlparser2（容错解析）→ 序列化成 XML → xmldom → xpath 查询。
// Go 侧直接用 x/net/html 建树 + antchfx/xpath 查询，省掉两次序列化；
// 两者都是「容错解析 + XPath 1.0」，对规则里实际用到的语法等价。

const defaultUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

// htmlAccept 是抓页面用的 Accept 头（与 Node 逐字一致）。
const htmlAccept = "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"

// requestErrorSuffix 拼出 Node 文案里的 ` (错误)` 尾巴。
func requestErrorSuffix(result *webfetch.Result) string {
	if result == nil || result.Error == "" {
		return ""
	}
	return " (" + result.Error + ")"
}

// fetchHTML 抓取页面文本。
func fetchHTML(ctx context.Context, rawURL, userAgent, referer string) (string, error) {
	headers := map[string]string{
		"User-Agent": firstNonEmpty(userAgent, defaultUserAgent),
		"Accept":     htmlAccept,
	}
	if referer != "" {
		headers["Referer"] = referer
	}
	result := webfetch.Fetch(ctx, rawURL, webfetch.Options{Headers: headers})
	if !result.OK {
		return "", fmt.Errorf("请求失败 [%d]: %s%s", result.Status, rawURL, requestErrorSuffix(result))
	}
	return result.Body, nil
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

// ---------------------------------------------------------------------------
// XPath
// ---------------------------------------------------------------------------

// xpathDoc 是一份已解析的 HTML 文档。
type xpathDoc struct {
	root *html.Node
}

// parseHTMLDocument 用 x/net/html 容错解析页面。
func parseHTMLDocument(markup string) (*xpathDoc, error) {
	node, err := htmlquery.Parse(strings.NewReader(markup))
	if err != nil {
		return nil, err
	}
	return &xpathDoc{root: node}, nil
}

// xpathCache 复用已编译的表达式。
//
// 规则会对**每一行**结果重复求值同一条表达式（20 条结果 × 3 条表达式），
// 每次重编译是纯浪费。表达式来自规则文件，数量有界。
var xpathCache sync.Map // map[string]*xpath.Expr

// compileXPath 编译表达式；失败返回 nil（调用方按「没有匹配」处理）。
func compileXPath(expression string) *xpath.Expr {
	if cached, ok := xpathCache.Load(expression); ok {
		compiled, _ := cached.(*xpath.Expr)
		return compiled
	}
	compiled, err := xpath.Compile(expression)
	if err != nil {
		// 规则里的表达式可能来自社区，非法表达式只影响这一条规则。
		xpathCache.Store(expression, (*xpath.Expr)(nil))
		return nil
	}
	xpathCache.Store(expression, compiled)
	return compiled
}

// xvalue 是一次 XPath 求值结果：要么是节点，要么是标量（字符串/数字/布尔）。
type xvalue struct {
	node   *html.Node
	scalar string
}

// text 对应 Node 的 extractText：节点取 textContent，标量取字符串形式。
func (v xvalue) text() string {
	if v.node != nil {
		return strings.TrimSpace(textContent(v.node))
	}
	return strings.TrimSpace(v.scalar)
}

// attr 取属性值；没有该属性或值为空串时返回 false（对齐 `getAttribute(x) || undefined`）。
func (v xvalue) attr(name string) (string, bool) {
	if v.node == nil || v.node.Type != html.ElementNode {
		return "", false
	}
	for _, attribute := range v.node.Attr {
		if attribute.Key == name {
			return attribute.Val, attribute.Val != ""
		}
	}
	return "", false
}

// textContent 复刻 DOM 的 textContent：只拼文本节点，**注释不算**。
//
// textContent 不是「所有后代节点的 Data」——注释与处理指令都不计入，
// 只有「选中的节点本身就是注释」时才返回注释内容。这条错一次，页面上
// 带 `<!-- 注解 -->` 的片名就会多出几个字。
func textContent(node *html.Node) string {
	if node.Type == html.TextNode || node.Type == html.CommentNode {
		return node.Data
	}
	var builder strings.Builder
	for child := node.FirstChild; child != nil; child = child.NextSibling {
		switch child.Type {
		case html.TextNode:
			builder.WriteString(child.Data)
		case html.ElementNode:
			builder.WriteString(textContent(child))
		}
	}
	return builder.String()
}

// selectXPath 在 scope 子树里求值表达式。
//
// 绝对路径（以单个 `/` 开头）必须回到文档根——XPath 里 `/` 就是从根算起的，
// Node 侧靠 xmldom 的 ownerDocument 天然满足。这条不能省：ezdmw 的
// chapterResult 是 `/self::*[@class='line_button1']/following-sibling::...`，
// 在上下文节点上求值会「意外修好」这条规则、与 Node 行为不一致。
//
// `//x` 故意不走绝对分支：Node 的 toRelativeXPath 会先把它改写成 `.//x`，
// 语义始终是「当前子树」，Go 里让 navigator 的根落在 scope 上即可等价。
func (d *xpathDoc) selectXPath(scope *html.Node, expression string) []xvalue {
	trimmed := strings.TrimSpace(expression)
	if trimmed == "" {
		return nil
	}
	compiled := compileXPath(trimmed)
	if compiled == nil {
		return nil
	}
	target := scope
	if target == nil {
		target = d.root
	}
	if strings.HasPrefix(trimmed, "/") && !strings.HasPrefix(trimmed, "//") {
		target = d.root
	}
	return flattenXPathValue(compiled.Evaluate(htmlquery.CreateXPathNavigator(target)))
}

// flattenXPathValue 把求值结果摊平成一串 xvalue。
func flattenXPathValue(value any) []xvalue {
	switch v := value.(type) {
	case *xpath.NodeIterator:
		values := make([]xvalue, 0, 8)
		for v.MoveNext() {
			navigator := v.Current()
			// 属性轴取不到 html.Node，按标量处理（textContent 语义等价）。
			if navigator.NodeType() == xpath.AttributeNode {
				values = append(values, xvalue{scalar: navigator.Value()})
				continue
			}
			if node, ok := navigator.(*htmlquery.NodeNavigator); ok {
				values = append(values, xvalue{node: node.Current()})
			}
		}
		return values
	case string:
		return []xvalue{{scalar: v}}
	case float64:
		return []xvalue{{scalar: formatNumber(v)}}
	case bool:
		if v {
			return []xvalue{{scalar: "true"}}
		}
		return []xvalue{{scalar: "false"}}
	}
	return nil
}

// formatNumber 复刻 JS 的数字转字符串（1 → "1"，1.5 → "1.5"）。
func formatNumber(value float64) string {
	return strconv.FormatFloat(value, 'f', -1, 64)
}

// ---------------------------------------------------------------------------
// URL 归一化
// ---------------------------------------------------------------------------

// schemePattern 判断是否已是绝对地址（与 anisubs 的同名正则一致）。
var schemePattern = regexp.MustCompile(`(?i)^[a-z][a-z0-9+.-]*:`)

// normalizeEpisodeURL 对齐上游 episode_url.dart 的 normalizeEpisodeUrl。
//
// 相对路径（含裸 id）基于 baseURL 补全；同站地址的协议统一到 baseURL 声明的
// 协议；去掉 path 尾斜杠（根路径保留）与默认端口。幂等。
//
// 与 Node 的差别只在「序列化」：JS 用 WHATWG URL.toString()，会把非 ASCII
// 百分号编码、空 path 补成 `/`、默认端口去掉。Go 的 url.String() 都不做，
// 所以这里自己拼一遍——否则同一部番在两侧会得出两个不同的 id。
func normalizeEpisodeURL(baseURL, raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}

	base := parseHTTPURL(strings.TrimSpace(baseURL))
	resolved := parseHTTPURL(trimmed)
	if resolved == nil && base != nil {
		if reference, err := url.Parse(trimmed); err == nil {
			resolved = parseHTTPURL(base.ResolveReference(reference).String())
		}
	}
	if resolved == nil {
		// 解析不出主机名：原样返回（Node 同样是 `return trimmed`）。
		return trimmed
	}

	if base != nil && resolved.Scheme != base.Scheme && sameHostPort(resolved, base) {
		resolved.Scheme = base.Scheme
	}

	path := resolved.Path
	for len(path) > 1 && strings.HasSuffix(path, "/") {
		path = strings.TrimSuffix(path, "/")
	}
	resolved.Path = path
	if resolved.RawPath != "" {
		rawPath := resolved.RawPath
		for len(rawPath) > 1 && strings.HasSuffix(rawPath, "/") {
			rawPath = strings.TrimSuffix(rawPath, "/")
		}
		resolved.RawPath = rawPath
	}

	return serializeURL(resolved)
}

// parseHTTPURL 解析 http/https 绝对地址；不满足时返回 nil。
func parseHTTPURL(raw string) *url.URL {
	parsed, err := url.Parse(raw)
	if err != nil {
		return nil
	}
	scheme := strings.ToLower(parsed.Scheme)
	if scheme != "http" && scheme != "https" {
		return nil
	}
	if parsed.Host == "" {
		return nil
	}
	parsed.Scheme = scheme
	return parsed
}

// sameHostPort 判断主机与**显式**端口是否相同。
//
// 必须用 `u.Port()`（没写就是空串），不能用「有效端口」：WHATWG 的
// URL 解析会把默认端口丢掉，所以 `http://a.com` 与 `https://a.com` 的
// port 都是空 —— Node 的 `resolved.host === base.host && port === port`
// 正是这个语义。按有效端口比（80 vs 443）会漏掉「同站换协议」这一支。
func sameHostPort(left, right *url.URL) bool {
	return strings.EqualFold(left.Hostname(), right.Hostname()) && left.Port() == right.Port()
}

// queryEscapeExtra 是 WHATWG query 百分号编码集合里需要转义的 ASCII。
//
// 语法 `"` `#` `<` `>` 与空格必须编码；`'` 只对特殊协议编码，这里一并编码
// （规则里的查询值极少带单引号）。
const queryEscapeExtra = " \"#<>'"

// serializeURL 按 WHATWG URL.toString() 的可见规则拼字符串。
func serializeURL(target *url.URL) string {
	if target.Scheme == "" || target.Host == "" {
		return target.String()
	}
	var builder strings.Builder
	builder.WriteString(strings.ToLower(target.Scheme))
	builder.WriteString("://")
	builder.WriteString(strings.ToLower(target.Hostname()))
	port := target.Port()
	if port != "" && !isDefaultPort(target.Scheme, port) {
		builder.WriteString(":")
		builder.WriteString(port)
	}
	path := target.EscapedPath()
	if path == "" {
		path = "/"
	}
	builder.WriteString(path)
	if target.RawQuery != "" {
		builder.WriteString("?")
		builder.WriteString(escapeQuery(target.RawQuery))
	}
	if target.Fragment != "" {
		builder.WriteString("#")
		builder.WriteString(target.EscapedFragment())
	}
	return builder.String()
}

func isDefaultPort(scheme, port string) bool {
	scheme = strings.ToLower(scheme)
	return (scheme == "http" && port == "80") || (scheme == "https" && port == "443")
}

// escapeQuery 把查询串里需要编码的字符转成 %XX（已编码的 % 保持原样）。
func escapeQuery(raw string) string {
	var builder strings.Builder
	builder.Grow(len(raw))
	for i := 0; i < len(raw); i++ {
		c := raw[i]
		switch {
		case c == '%':
			// 保留已有的百分号编码，避免二次编码成 %25。
			builder.WriteByte(c)
		case c > 0x7e || c < 0x21 || strings.IndexByte(queryEscapeExtra, c) >= 0:
			builder.WriteString("%")
			builder.WriteString(strings.ToUpper(fmt.Sprintf("%02x", c)))
		default:
			builder.WriteByte(c)
		}
	}
	return builder.String()
}

// absoluteURL 把相对地址补成绝对地址（对应 anisubs 的 toAbsoluteUrl）。
func absoluteURL(rawURL, baseURL string) string {
	if rawURL == "" {
		return rawURL
	}
	if schemePattern.MatchString(rawURL) {
		return rawURL
	}
	base, err := url.Parse(baseURL)
	if err != nil {
		return rawURL
	}
	reference, err := url.Parse(rawURL)
	if err != nil {
		return rawURL
	}
	return serializeURL(base.ResolveReference(reference))
}

// originOf 取 origin（对应 anisubs 的 resolveBaseUrl）。
func originOf(rawURL string) string {
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return rawURL
	}
	return strings.ToLower(parsed.Scheme) + "://" + strings.ToLower(parsed.Host)
}

// ---------------------------------------------------------------------------
// 播放地址解析
// ---------------------------------------------------------------------------

// mediaURLPatterns 是页面里「看起来就是视频地址」的正则，按优先级尝试。
//
// 全部带 (?i)：JS 侧是 /gi。`[^"'\s]` 里不能出现引号，否则会把整段 JS
// 当成 URL。
var mediaURLPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)(https?://[^"'\s]+?\.m3u8[^"'\s]*)`),
	regexp.MustCompile(`(?i)(https?://[^"'\s]+?\.mp4[^"'\s]*)`),
	regexp.MustCompile(`(?i)(https?://[^"'\s]+?\.flv[^"'\s]*)`),
	regexp.MustCompile(`(?i)["'](https?://[^"'\s]+?/[^"'\s]*?(?:\.m3u8|\.mp4|\.flv)[^"'\s]*)["']`),
}

// bootstrapPattern 匹配 HHJX 一类播放器内联的引导参数。
var bootstrapPattern = regexp.MustCompile(`(?i)window\.__HHJX_BOOTSTRAP__\s*=\s*(\{[^<]+\})\s*;`)

// playerAaaaPattern 匹配苹果 CMS 播放页内嵌的 player_aaaa 配置。
var playerAaaaPattern = regexp.MustCompile(`(?is)player_aaaa\s*=\s*(\{.*?\})\s*</script>`)

// iframeSrcPattern 取第一个 iframe 的 src。
var iframeSrcPattern = regexp.MustCompile(`(?i)<iframe[^>]+src=["']([^"']+)["']`)

// playerConfigPatterns 匹配 DPlayer 一类播放器配置里的 url 字段。
var playerConfigPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)["']url["']\s*[:=]\s*["'](https?://[^"']+)["']`),
	regexp.MustCompile(`(?i)video\s*:\s*\{[^}]*url\s*:\s*["'](https?://[^"']+)["']`),
	regexp.MustCompile(`(?i)player\([^{]*\{[^}]*url\s*:\s*["'](https?://[^"']+)["']`),
}

// jsUnescapePattern 匹配 `%uXXXX` 形式的转义。
var jsUnescapePattern = regexp.MustCompile(`%u([0-9A-Fa-f]{4})`)

// findMediaURL 在页面里找第一个可用的视频地址。
func findMediaURL(markup string) string {
	for _, pattern := range mediaURLPatterns {
		if match := pattern.FindStringSubmatch(markup); match != nil && len(match) > 1 {
			return match[1]
		}
	}
	return ""
}

// resolveBootstrapPlayer 解析 HHJX 一类在页面里公开引导参数的播放器。
//
// 返回空串表示「这页不是这种播放器」或「解析不出」（youku 那一类还需要
// 浏览器环境的 CNA/JSONP，后端静态拿不到）。
func resolveBootstrapPlayer(ctx context.Context, playerURL, markup, userAgent string) string {
	match := bootstrapPattern.FindStringSubmatch(markup)
	if match == nil || len(match) < 2 {
		return ""
	}
	var bootstrap map[string]any
	if err := json.Unmarshal([]byte(match[1]), &bootstrap); err != nil {
		return ""
	}
	rawURL, ok := bootstrap["url"].(string)
	if !ok {
		return ""
	}
	if _, ok := bootstrap["t"].(float64); !ok {
		return ""
	}
	key, ok := bootstrap["key"].(string)
	if !ok {
		return ""
	}

	// `new URL('/api/parse', playerUrl).href`：换掉 path、保留 origin。
	origin := originOf(playerURL)
	endpoint := origin + "/api/parse"

	payload := map[string]any{"url": rawURL, "t": bootstrap["t"], "key": key}
	if act, ok := bootstrap["act"].(float64); ok && act == 99 {
		payload["act"] = 99
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return ""
	}

	result := webfetch.Fetch(ctx, endpoint, webfetch.Options{
		Method:      "POST",
		Body:        string(body),
		ContentType: "application/json",
		Timeout:     20 * time.Second,
		Headers: map[string]string{
			"User-Agent": firstNonEmpty(userAgent, defaultUserAgent),
			"Referer":    playerURL,
			"Origin":     origin,
			"Accept":     "application/json, text/plain, */*",
		},
	})
	if !result.OK {
		return ""
	}
	var response struct {
		Code any `json:"code"`
		URL  any `json:"url"`
		Ext  any `json:"ext"`
	}
	if err := json.Unmarshal([]byte(result.Body), &response); err != nil {
		return ""
	}
	code, ok := response.Code.(float64)
	if !ok || code != 200 {
		return ""
	}
	resolvedURL, ok := response.URL.(string)
	if !ok {
		return ""
	}
	if ext, ok := response.Ext.(string); ok && ext == "youku" {
		return ""
	}
	return resolvedURL
}

// resolveIframeVideoURL 递归解析 iframe 里的播放器（最多 3 层）。
func resolveIframeVideoURL(ctx context.Context, iframeURL, referer, userAgent string, depth int) string {
	if depth > 2 {
		return ""
	}
	markup, err := fetchHTML(ctx, iframeURL, userAgent, referer)
	if err != nil {
		return ""
	}

	if direct := findMediaURL(markup); direct != "" {
		return absoluteURL(direct, iframeURL)
	}
	if bootstrap := resolveBootstrapPlayer(ctx, iframeURL, markup, userAgent); bootstrap != "" {
		return absoluteURL(bootstrap, iframeURL)
	}
	match := iframeSrcPattern.FindStringSubmatch(markup)
	if match == nil || len(match) < 2 {
		return ""
	}
	nested := absoluteURL(match[1], iframeURL)
	return resolveIframeVideoURL(ctx, nested, iframeURL, userAgent, depth+1)
}

// decodeJSUnescape 还原 `%uXXXX` 转义。
func decodeJSUnescape(value string) string {
	return jsUnescapePattern.ReplaceAllStringFunc(value, func(token string) string {
		code, err := strconv.ParseUint(token[2:], 16, 32)
		if err != nil {
			return token
		}
		return string(rune(code))
	})
}

// resolvePlayerAaaa 解析苹果 CMS 播放页内嵌的 player_aaaa 配置。
//
// encrypt 0=明文（由外层正则覆盖）/ 1=base64 / 2=unescape(base64)；
// encrypt 3 是各站私有变体（要它自己的播放器 JS 才能还原），交给后续回退链。
func resolvePlayerAaaa(markup string) string {
	match := playerAaaaPattern.FindStringSubmatch(markup)
	if match == nil || len(match) < 2 {
		return ""
	}
	var config map[string]any
	// 页面里的 JSON 常把 `/` 转义成 `\/`，JS 侧同样先替换再解析。
	raw := strings.ReplaceAll(match[1], `\/`, "/")
	if err := json.Unmarshal([]byte(raw), &config); err != nil {
		return ""
	}
	rawURL, ok := config["url"].(string)
	if !ok {
		return ""
	}
	rawURL = strings.TrimSpace(rawURL)
	if rawURL == "" {
		return ""
	}
	encrypt := float64(0)
	if value, ok := config["encrypt"].(float64); ok {
		encrypt = value
	}

	decoded, err := base64.StdEncoding.DecodeString(rawURL)
	if err != nil {
		// Node 的 Buffer.from(x, 'base64') 对非法输入是「尽力解码」，
		// 解出空串；这里按同样语义降级。
		decoded = nil
	}
	switch encrypt {
	case 1:
		text := string(decoded)
		if strings.HasPrefix(text, "http://") || strings.HasPrefix(text, "https://") {
			return text
		}
	case 2:
		text := decodeJSUnescape(string(decoded))
		if strings.HasPrefix(text, "http://") || strings.HasPrefix(text, "https://") {
			return text
		}
	}
	return ""
}

// resolvedVideo 是播放地址解析结果。
type resolvedVideo struct {
	URL    string
	Format string
}

// resolveVideoURL 解析剧集页面的真实视频地址。
//
// 回退链：直接正则匹配 → player_aaaa 配置 → 播放器配置 url 字段 → iframe 嵌套递归。
func resolveVideoURL(ctx context.Context, episodeURL string, rule *Rule) (*resolvedVideo, error) {
	markup, err := fetchHTML(ctx, episodeURL, rule.UserAgent, firstNonEmpty(rule.Referer, rule.BaseURL))
	if err != nil {
		return nil, err
	}

	base := originOf(episodeURL)
	resolve := func(rawURL string) *resolvedVideo {
		absolute := absoluteURL(rawURL, base)
		return &resolvedVideo{URL: absolute, Format: string(anisubs.DetectMediaFormat(absolute))}
	}

	if direct := findMediaURL(markup); direct != "" {
		return resolve(direct), nil
	}
	if aaaa := resolvePlayerAaaa(markup); aaaa != "" {
		return resolve(aaaa), nil
	}
	for _, pattern := range playerConfigPatterns {
		if match := pattern.FindStringSubmatch(markup); match != nil && len(match) > 1 {
			return resolve(match[1]), nil
		}
	}

	if match := iframeSrcPattern.FindStringSubmatch(markup); match != nil && len(match) > 1 {
		iframeURL := absoluteURL(match[1], base)
		userAgent := rule.UserAgent
		if userAgent == "" {
			userAgent = defaultUserAgent
		}
		// iframe 抓取失败在 Node 侧是被吞掉的（`catch {}`），不影响整体结论。
		if nested := resolveIframeVideoURL(ctx, iframeURL, episodeURL, userAgent, 0); nested != "" {
			return &resolvedVideo{
				URL:    nested,
				Format: string(anisubs.DetectMediaFormat(nested)),
			}, nil
		}
	}
	return nil, nil
}

// errEmptyEpisodeURL 表示请求里没带剧集页地址。
var errEmptyEpisodeURL = errors.New("缺少剧集页面地址")
