package kazumi

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"

	_ "modernc.org/sqlite"

	"zviewer/backend/internal/store"
	"zviewer/backend/internal/webfetch"
)

// ===========================================================================
// 工具
// ===========================================================================

// stubTransport 按「host+path」路由返回固定文本，并记录查询串与请求体。
type stubTransport struct {
	routes map[string]string
	query  map[string]string
	body   map[string]string
}

func (s *stubTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	key := req.URL.Host + req.URL.Path
	s.query[key] = req.URL.RawQuery
	if req.Body != nil {
		raw, _ := io.ReadAll(req.Body)
		_ = req.Body.Close()
		s.body[key] = string(raw)
	}
	body, ok := s.routes[key]
	if !ok {
		for prefix, value := range s.routes {
			if strings.HasPrefix(key, prefix) {
				body, ok = value, true
				break
			}
		}
	}
	if !ok {
		return &http.Response{
			StatusCode: http.StatusNotFound,
			Body:       io.NopCloser(strings.NewReader("not found")),
			Header:     http.Header{"Content-Type": []string{"text/plain"}},
			Request:    req,
		}, nil
	}
	return &http.Response{
		StatusCode: http.StatusOK,
		Body:       io.NopCloser(strings.NewReader(body)),
		Header:     http.Header{"Content-Type": []string{"text/html; charset=utf-8"}},
		Request:    req,
	}, nil
}

func withStubHTTP(t *testing.T, routes map[string]string) *stubTransport {
	t.Helper()
	stub := &stubTransport{routes: routes, query: map[string]string{}, body: map[string]string{}}
	restore := webfetch.SetTransport(stub)
	t.Cleanup(restore)
	return stub
}

// ===========================================================================
// 纯函数（期望值全部来自 Node 侧同函数的实际输出）
// ===========================================================================

func TestExtractEpisodeNumber(t *testing.T) {
	cases := []struct {
		title string
		want  float64
	}{
		{title: "第1集", want: 1},
		{title: "第 12 话", want: 12},
		{title: "第1.5话", want: 1.5},
		// 数字兜底：这是与 anisubs.ExtractEpisodeNumber 的关键差别。
		{title: "EP12", want: 12},
		{title: "OVA", want: 0},
		{title: "第十二集", want: 0},
	}
	for _, c := range cases {
		t.Run(c.title, func(t *testing.T) {
			if got := extractEpisodeNumber(c.title); got != c.want {
				t.Errorf("extractEpisodeNumber(%q) = %v，期望 %v", c.title, got, c.want)
			}
		})
	}
}

func TestNormalizeEpisodeURL(t *testing.T) {
	cases := []struct {
		name string
		base string
		raw  string
		want string
	}{
		{name: "空值", base: "https://a.com/", raw: "  ", want: ""},
		{name: "裸 id", base: "https://a.com/", raw: "123", want: "https://a.com/123"},
		{name: "相对路径", base: "https://a.com/list/", raw: "detail/1", want: "https://a.com/list/detail/1"},
		{name: "根相对", base: "https://a.com/list/", raw: "/x/", want: "https://a.com/x"},
		{name: "同站协议统一", base: "https://a.com/", raw: "http://a.com/x", want: "https://a.com/x"},
		{name: "异站不动", base: "https://a.com/", raw: "http://b.com/x", want: "http://b.com/x"},
		{name: "根路径保留", base: "https://a.com/", raw: "https://a.com/", want: "https://a.com/"},
		{name: "默认端口去掉", base: "https://a.com/", raw: "https://a.com:443/x", want: "https://a.com/x"},
		{name: "非默认端口保留", base: "https://a.com/", raw: "https://a.com:8443/x", want: "https://a.com:8443/x"},
		{name: "查询与锚点", base: "https://a.com/", raw: "/x?b=2&a=1#f", want: "https://a.com/x?b=2&a=1#f"},
		{name: "非 http 原样", base: "https://a.com/", raw: "magnet:?xt=1", want: "magnet:?xt=1"},
		{name: "没有 base", raw: "abc", want: "abc"},
		{name: "空路径补根", base: "https://a.com", raw: "https://a.com", want: "https://a.com/"},
		{name: "中文百分号编码", base: "https://a.com/", raw: "/中", want: "https://a.com/%E4%B8%AD"},
		{name: "查询里的空格", base: "https://a.com/", raw: "/x?q=a b", want: "https://a.com/x?q=a%20b"},
		{name: "大写主机降级", base: "https://A.COM/", raw: "https://A.COM/X", want: "https://a.com/X"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := normalizeEpisodeURL(c.base, c.raw); got != c.want {
				t.Errorf("normalizeEpisodeURL(%q, %q) = %q，期望 %q", c.base, c.raw, got, c.want)
			}
		})
	}
}

func TestJSONPathRead(t *testing.T) {
	document := map[string]any{
		"data": map[string]any{
			"list": []any{
				map[string]any{"id": float64(11), "title": "一"},
				map[string]any{"id": float64(12), "title": "二"},
				map[string]any{"title": "没有 id"},
			},
			"token": "tk",
		},
	}

	cases := []struct {
		expression string
		want       int
	}{
		{expression: "$.data.list[*].id", want: 2},
		// 数字下标**不生效**（见下面的专门断言）。
		{expression: "$.data.list[0].title", want: 0},
		{expression: "$['data']['list'][1]['id']", want: 0},
		{expression: "$.data.list[*].missing", want: 0},
		{expression: "$.data.token", want: 1},
	}
	for _, c := range cases {
		t.Run(c.expression, func(t *testing.T) {
			values, err := jsonPathRead(document, c.expression)
			if err != nil {
				t.Fatalf("解析失败: %v", err)
			}
			if len(values) != c.want {
				t.Errorf("匹配 %d 个，期望 %d（%v）", len(values), c.want, values)
			}
		})
	}

	// `[n]` 撞上数组时会先「按元素展开」，随后 index 作用于对象被跳过 ——
	// Node 的 readTokens 就是这样（注释写着「标准语义」，实际只认 `[*]`）。
	// 规则里也确实只用 `[*]`；这里锁住它，免得以后「顺手修好」破坏一致性。
	if values, _ := jsonPathRead(document, "$.data.list[0].id"); len(values) != 0 {
		t.Errorf("数组下标应不生效，得到 %v", values)
	}

	values, err := jsonPathRead(document, "$.data.list[*].id")
	if err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	if len(values) != 2 || values[0].(float64) != 11 {
		t.Errorf("id 列表 = %v，期望 [11 12]", values)
	}

	// `[*]` 作用于对象时按键名排序（Go 的 map 无序，只能给稳定结果）。
	wildcard, err := jsonPathRead(map[string]any{"b": float64(2), "a": float64(1)}, "$[*]")
	if err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	if len(wildcard) != 2 || wildcard[0].(float64) != 1 {
		t.Errorf("对象通配 = %v，期望按住键排序后 [1 2]", wildcard)
	}
}

func TestJSONPathErrors(t *testing.T) {
	cases := []struct {
		expression string
		wantSubstr string
	}{
		{expression: "data.list", wantSubstr: "必须以 $ 开头"},
		{expression: "$.data[?(@.id>1)]", wantSubstr: "不支持的 JSONPath 片段"},
		{expression: "$.data[", wantSubstr: "缺少 ]"},
		{expression: "$.data..list", wantSubstr: "不支持的 JSONPath"},
		{expression: "$", wantSubstr: ""},
	}
	for _, c := range cases {
		t.Run(c.expression, func(t *testing.T) {
			_, err := jsonPathRead(map[string]any{}, c.expression)
			if c.wantSubstr == "" {
				if err != nil {
					t.Errorf("应能解析，得到 %v", err)
				}
				return
			}
			if err == nil {
				t.Fatalf("应报错")
			}
			if !strings.Contains(err.Error(), c.wantSubstr) {
				t.Errorf("错误 %q 里没有 %q", err.Error(), c.wantSubstr)
			}
		})
	}
}

func TestRenderTemplate(t *testing.T) {
	variables := map[string]any{"keyword": "孤独 摇滚", "id": float64(7), "nil": nil}

	got, err := renderTemplate("https://a.com/s?wd=@keyword", variables, true)
	if err != nil {
		t.Fatalf("渲染失败: %v", err)
	}
	// encodeURIComponent 语义：空格给 %20，不给 +。
	if got != "https://a.com/s?wd=%E5%AD%A4%E7%8B%AC%20%E6%91%87%E6%BB%9A" {
		t.Errorf("渲染结果 = %q", got)
	}

	got, err = renderTemplate("@id-@nil", variables, false)
	if err != nil {
		t.Fatalf("渲染失败: %v", err)
	}
	if got != "7-" {
		t.Errorf("数字/null 渲染 = %q，期望 \"7-\"", got)
	}

	// 紧跟在标识符字符后面的 @ 不算变量（JS 是 (?<![A-Za-z0-9_])@）。
	got, err = renderTemplate("mail@host", variables, false)
	if err != nil {
		t.Fatalf("渲染失败: %v", err)
	}
	if got != "mail@host" {
		t.Errorf("mail@host 被当成变量了：%q", got)
	}

	if _, err := renderTemplate("@nope", variables, false); err == nil {
		t.Error("缺变量应报错")
	}
}

func TestRenderValueKeepsRawScalar(t *testing.T) {
	rendered, err := renderValue(map[string]any{
		"page": float64(1),
		"ok":   true,
		"wd":   "@keyword",
		"text": "前缀 @keyword",
	}, map[string]any{"keyword": "abc"})
	if err != nil {
		t.Fatalf("渲染失败: %v", err)
	}
	object := rendered.(map[string]any)
	// 整串恰为 @var 时原样返回：数字仍是数字，不带引号。
	if object["page"].(float64) != 1 || object["ok"].(bool) != true {
		t.Errorf("标量被改写了：%v", object)
	}
	if object["text"].(string) != "前缀 abc" {
		t.Errorf("内嵌变量渲染 = %v", object["text"])
	}
}

// ===========================================================================
// XPath
// ===========================================================================

const sampleHTML = `<html><body>
<div class="x">
  <a href="/a">A</a>
  <a href="/b">B<span>C</span></a>
  <!-- 注释不算文本 -->
</div>
<div class="y">Y</div>
</body></html>`

func newSampleDoc(t *testing.T) *xpathDoc {
	t.Helper()
	document, err := parseHTMLDocument(sampleHTML)
	if err != nil {
		t.Fatalf("解析 HTML 失败: %v", err)
	}
	return document
}

func TestSelectXPath(t *testing.T) {
	document := newSampleDoc(t)

	if got := document.selectXPath(nil, "//div[@class='x']//a"); len(got) != 2 {
		t.Errorf("`//div//a` 命中 %d 个，期望 2", len(got))
	}
	if got := document.selectXPath(nil, "//a[contains(@href,'/b')]"); len(got) != 1 {
		t.Errorf("contains 断言命中 %d 个，期望 1", len(got))
	}
	if got := document.selectXPath(nil, "//div[starts-with(@class,'y')]"); len(got) != 1 {
		t.Errorf("starts-with 断言命中 %d 个，期望 1", len(got))
	}

	// 嵌套文本：textContent 要把后代文本拼起来。
	nodes := document.selectXPath(nil, "//div[@class='x']/a[2]")
	if len(nodes) != 1 || nodes[0].text() != "BC" {
		t.Errorf("嵌套文本 = %v，期望 BC", nodes)
	}

	// 注释不计入 textContent（空白照算，所以用紧凑片段断言）。
	compact, err := parseHTMLDocument(`<div id="t">前缀<!-- 注释 -->后缀</div>`)
	if err != nil {
		t.Fatalf("解析 HTML 失败: %v", err)
	}
	if nodes := compact.selectXPath(nil, "//div[@id='t']"); len(nodes) != 1 || nodes[0].text() != "前缀后缀" {
		t.Errorf("带注释的文本 = %v，期望 前缀后缀", nodes)
	}

	// text() 选的是文本节点。
	texts := document.selectXPath(nil, "//div[@class='y']/text()")
	if len(texts) != 1 || texts[0].text() != "Y" {
		t.Errorf("text() = %v，期望 [Y]", texts)
	}

	// 属性轴取出来是标量。
	attrs := document.selectXPath(nil, "//a/@href")
	if len(attrs) != 2 || attrs[0].text() != "/a" {
		t.Errorf("属性轴 = %v，期望 [/a /b]", attrs)
	}

	// 非法表达式只影响这一条，返回空（Node 侧同样是 catch 后 []）。
	if got := document.selectXPath(nil, "//div["); got != nil {
		t.Errorf("非法表达式应返回 nil，得到 %v", got)
	}
}

func TestSelectXPathAbsoluteStaysAtRoot(t *testing.T) {
	document := newSampleDoc(t)
	scopes := document.selectXPath(nil, "//div[@class='x']")
	if len(scopes) != 1 {
		t.Fatalf("准备上下文失败")
	}

	// `//a` 是相对子树（Node 的 toRelativeXPath 会改写成 `.//a`）。
	if got := document.selectXPath(scopes[0].node, "//a"); len(got) != 2 {
		t.Errorf("`//a` 相对命中 %d 个，期望 2", len(got))
	}
	// 单个 `/` 开头是绝对路径：从文档根算，落在上下文节点上是错的。
	if got := document.selectXPath(scopes[0].node, "/self::*[@class='x']"); len(got) != 0 {
		t.Errorf("/self::* 在上下文节点上求值命中 %d 个，应为 0（Node 同样为 0）", len(got))
	}
}

func TestExtractAttrSemantics(t *testing.T) {
	document := newSampleDoc(t)
	nodes := document.selectXPath(nil, "//div[@class='y']")
	if len(nodes) != 1 {
		t.Fatalf("准备节点失败")
	}
	if _, ok := nodes[0].attr("href"); ok {
		t.Error("没有的属性应返回 false")
	}
	if value, ok := nodes[0].attr("class"); !ok || value != "y" {
		t.Errorf("class = %q/%v，期望 y/true", value, ok)
	}
}

// ===========================================================================
// 播放页解析
// ===========================================================================

func TestResolvePlayerAaaa(t *testing.T) {
	plain := base64.StdEncoding.EncodeToString([]byte("https://cdn.example.com/a.m3u8"))
	escaped := base64.StdEncoding.EncodeToString([]byte("https://cdn.example.com/b%u002Em3u8"))

	if got := resolvePlayerAaaa(`<script>player_aaaa = {"url":"` + plain + `","encrypt":1} </script>`); got != "https://cdn.example.com/a.m3u8" {
		t.Errorf("encrypt=1 解出 %q", got)
	}
	if got := resolvePlayerAaaa(`<script>player_aaaa = {"url":"` + escaped + `","encrypt":2} </script>`); got != "https://cdn.example.com/b.m3u8" {
		t.Errorf("encrypt=2 解出 %q", got)
	}
	// encrypt=0（明文）交给外层正则，这里不重复处理。
	if got := resolvePlayerAaaa(`<script>player_aaaa = {"url":"https://cdn.example.com/c.m3u8","encrypt":0} </script>`); got != "" {
		t.Errorf("encrypt=0 不该在这里解出，得到 %q", got)
	}
	if got := resolvePlayerAaaa(`<script>player_aaaa = 坏了 </script>`); got != "" {
		t.Errorf("非法配置应返回空，得到 %q", got)
	}
}

func TestResolveVideoURLChain(t *testing.T) {
	bootstrapHTML := `<html><body><script>window.__HHJX_BOOTSTRAP__ = {"url":"https://v.example/x","t":1730000000,"key":"k"};</script></body></html>`
	player := base64.StdEncoding.EncodeToString([]byte("https://cdn.example.com/player.m3u8"))
	stub := withStubHTTP(t, map[string]string{
		"a.example.com/play/direct":  `<video src="https://cdn.example.com/direct.m3u8?token=1"></video>`,
		"a.example.com/play/player":  `<script>var player_aaaa={"url":"` + player + `","encrypt":1}</script>`,
		"a.example.com/play/iframe":  `<iframe src="/frame/normal"></iframe>`,
		"a.example.com/frame/normal": `<video src="https://cdn.example.com/frame.mp4"></video>`,
		"a.example.com/play/hhjx":    `<iframe src="/frame/hhjx"></iframe>`,
		"a.example.com/frame/hhjx":   bootstrapHTML,
		"a.example.com/api/parse":    `{"code":200,"url":"https://cdn.example.com/hhjx.m3u8","ext":"mp4"}`,
		"a.example.com/play/none":    `<html><body>什么都没有</body></html>`,
	})
	rule := &Rule{BaseURL: "https://a.example.com/"}

	cases := []struct {
		name       string
		page       string
		wantURL    string
		wantFormat string
	}{
		{name: "直链", page: "/play/direct", wantURL: "https://cdn.example.com/direct.m3u8?token=1", wantFormat: "hls"},
		{name: "player_aaaa", page: "/play/player", wantURL: "https://cdn.example.com/player.m3u8", wantFormat: "hls"},
		{name: "iframe 嵌套", page: "/play/iframe", wantURL: "https://cdn.example.com/frame.mp4", wantFormat: "mp4"},
		{name: "HHJX bootstrap", page: "/play/hhjx", wantURL: "https://cdn.example.com/hhjx.m3u8", wantFormat: "hls"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			result, err := resolveVideoURL(context.Background(), "https://a.example.com"+c.page, rule)
			if err != nil {
				t.Fatalf("解析失败: %v", err)
			}
			if result == nil || result.URL != c.wantURL || result.Format != c.wantFormat {
				t.Errorf("解析结果 = %+v，期望 %s/%s", result, c.wantURL, c.wantFormat)
			}
		})
	}

	// bootstrap 的 POST 体要把 t/key 原样带过去（数字不能变字符串）。
	body := stub.body["a.example.com/api/parse"]
	if !strings.Contains(body, `"t":1730000000`) || !strings.Contains(body, `"key":"k"`) {
		t.Errorf("bootstrap 请求体 = %s", body)
	}

	result, err := resolveVideoURL(context.Background(), "https://a.example.com/play/none", rule)
	if err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	if result != nil {
		t.Errorf("没有可播地址时应返回 nil，得到 %+v", result)
	}
}

// ===========================================================================
// 规则加载
// ===========================================================================

func TestBuildIndexedRuleURL(t *testing.T) {
	cases := []struct {
		index string
		name  string
		want  string
	}{
		{index: "https://a.com/rules/index.json", name: "alpha", want: "https://a.com/rules/alpha.json"},
		{index: "https://a.com/rules/index.json?v=2", name: "alpha", want: "https://a.com/rules/alpha.json?v=2"},
		{index: "https://a.com/rules/index.json#x", name: "alpha", want: "https://a.com/rules/alpha.json#x"},
		{index: "https://a.com/rules/", name: "alpha", want: "https://a.com/rules/alpha.json"},
		{index: "https://a.com/rules", name: "alpha", want: "https://a.com/alpha.json"},
	}
	for _, c := range cases {
		t.Run(c.index, func(t *testing.T) {
			if got := buildIndexedRuleURL(c.index, c.name); got != c.want {
				t.Errorf("buildIndexedRuleURL(%q) = %q，期望 %q", c.index, got, c.want)
			}
		})
	}
}

func TestExpandRuleSource(t *testing.T) {
	withStubHTTP(t, map[string]string{
		"rules.example.com/index.json":  `[{"name":"alpha"},{"name":"beta"},{"name":"bad name!"},{"name":123}]`,
		"rules.example.com/single.json": `{"name":"gamma","baseURL":"https://g.example/","searchURL":"https://g.example/s?wd=@keyword"}`,
		"rules.example.com/empty.json":  `[{"noname":1}]`,
		// 官方仓库地址会走 GitHub 加速前缀，key 里带着完整原地址。
		"gh-proxy.com/https://raw.githubusercontent.com/Predidit/KazumiRules/main/index.json": `[{"name":"alpha"}]`,
	})

	urls, err := expandRuleSource(context.Background(), "https://rules.example.com/index.json")
	if err != nil {
		t.Fatalf("展开失败: %v", err)
	}
	want := []string{
		"https://rules.example.com/alpha.json",
		"https://rules.example.com/beta.json",
	}
	if len(urls) != len(want) || urls[0] != want[0] || urls[1] != want[1] {
		t.Errorf("展开结果 = %v，期望 %v", urls, want)
	}

	// 非数组（规则文件本身）原样返回。
	urls, err = expandRuleSource(context.Background(), "https://rules.example.com/single.json")
	if err != nil || len(urls) != 1 || urls[0] != "https://rules.example.com/single.json" {
		t.Errorf("单规则展开 = %v/%v", urls, err)
	}

	if _, err := expandRuleSource(context.Background(), "https://rules.example.com/empty.json"); err == nil {
		t.Error("没有合法规则名时应报错")
	}

	// 仓库主页 → 索引 → 逐条规则。
	urls, err = expandRuleSource(context.Background(), "https://github.com/Predidit/KazumiRules.git/")
	if err != nil {
		t.Fatalf("仓库展开失败: %v", err)
	}
	if len(urls) != 1 || urls[0] != "https://raw.githubusercontent.com/Predidit/KazumiRules/main/alpha.json" {
		t.Errorf("仓库展开 = %v", urls)
	}
}

func TestFetchRuleValidation(t *testing.T) {
	withStubHTTP(t, map[string]string{
		"rules.example.com/ok.json":       `{"name":"a","baseURL":"https://a.example/","searchURL":"https://a.example/s?wd=@keyword"}`,
		"rules.example.com/api.json":      `{"name":"b","baseURL":"https://b.example/","searchMode":"api","searchApiConfig":{"request":{"url":"https://b.example/api"}}}`,
		"rules.example.com/no-url.json":   `{"name":"c","baseURL":"https://c.example/"}`,
		"rules.example.com/not-json.json": `<html>不是 JSON</html>`,
	})

	if _, err := fetchRule(context.Background(), "https://rules.example.com/ok.json"); err != nil {
		t.Errorf("正常规则不该报错: %v", err)
	}
	// apiLevel 9：searchURL 为空但配了 api 搜索，合法。
	if _, err := fetchRule(context.Background(), "https://rules.example.com/api.json"); err != nil {
		t.Errorf("API 规则不该报错: %v", err)
	}
	if _, err := fetchRule(context.Background(), "https://rules.example.com/no-url.json"); err == nil {
		t.Error("缺搜索入口应报错")
	}
	if _, err := fetchRule(context.Background(), "https://rules.example.com/not-json.json"); err == nil {
		t.Error("非 JSON 应报错")
	}
}

// ===========================================================================
// 注册表
// ===========================================================================

const settingsDDL = `CREATE TABLE "system_settings" (
	"id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	"autoDeleteInactiveRooms" boolean NOT NULL DEFAULT (1),
	"autoDeleteAfterHours" INTEGER NOT NULL DEFAULT (24),
	"roomDefaultMusicVolume" INTEGER NOT NULL DEFAULT (50),
	"dataSourceConfig" json,
	"registrationMode" TEXT NOT NULL DEFAULT ('approval'),
	"roomCreationMode" TEXT NOT NULL DEFAULT ('admin-only'),
	"roomPermissionMatrix" json,
	"roomMultiInstanceLogin" boolean NOT NULL DEFAULT (0),
	"betaFeaturesEnabled" boolean NOT NULL DEFAULT (0),
	"dashDisabled" boolean NOT NULL DEFAULT (0),
	"bilibiliDefaultParseMode" TEXT NOT NULL DEFAULT ('mp4'),
	"bilibiliPgcDefaultMode" TEXT NOT NULL DEFAULT ('mp4'),
	"cdnAccelerate" boolean NOT NULL DEFAULT (0),
	"playsvideoEnabled" boolean NOT NULL DEFAULT (1),
	"cdnProxyUrl" TEXT NOT NULL DEFAULT ('https://gh-proxy.com'),
	"livekitExternalUrl" TEXT NOT NULL DEFAULT (''),
	"announceAutoPopupOnUpdate" boolean NOT NULL DEFAULT (1),
	"createdAt" datetime NOT NULL DEFAULT (datetime('now')),
	"updatedAt" datetime NOT NULL DEFAULT (datetime('now'))
)`

func newTestSettings(t *testing.T, dataSourceConfig string) *store.Settings {
	t.Helper()
	conn, err := sql.Open("sqlite", "file::memory:?_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatalf("打开内存库失败: %v", err)
	}
	t.Cleanup(func() { conn.Close() })
	conn.SetMaxOpenConns(1)

	if _, err := conn.Exec(settingsDDL); err != nil {
		t.Fatalf("建表失败: %v", err)
	}
	if _, err := conn.Exec(
		`INSERT INTO "system_settings" ("dataSourceConfig") VALUES (?)`, dataSourceConfig,
	); err != nil {
		t.Fatalf("写入配置失败: %v", err)
	}
	return store.NewSettings(conn)
}

func TestRuleURLsDefaults(t *testing.T) {
	if got := ruleURLs(nil); len(got) != len(defaultRules) {
		t.Errorf("nil 配置应给默认规则，得到 %v", got)
	}
	// 空数组同样回落默认规则（Node 的 `length > 0` 判断）。
	if got := ruleURLs(json.RawMessage(`{"kazumiRules":[]}`)); len(got) != len(defaultRules) {
		t.Errorf("空数组应给默认规则，得到 %v", got)
	}
	got := ruleURLs(json.RawMessage(`{"kazumiRules":["https://a.com/1.json","https://a.com/2.json"]}`))
	if len(got) != 2 || got[1] != "https://a.com/2.json" {
		t.Errorf("自定义规则 = %v", got)
	}
}

func TestServiceRegistryKeepsIndexOnFailure(t *testing.T) {
	withStubHTTP(t, map[string]string{
		"rules.example.com/index.json":  `[{"name":"alpha"},{"name":"broken"},{"name":"gamma"}]`,
		"rules.example.com/alpha.json":  `{"name":"alpha","baseURL":"https://a.example/","searchURL":"https://a.example/s?wd=@keyword"}`,
		"rules.example.com/broken.json": `{"name":"broken"}`,
		"rules.example.com/gamma.json":  `{"name":"gamma","baseURL":"https://g.example/","searchURL":"https://g.example/s?wd=@keyword"}`,
	})
	service := NewService(newTestSettings(t, `{"kazumiRules":["https://rules.example.com/index.json"]}`))

	sources, err := service.List(context.Background())
	if err != nil {
		t.Fatalf("列数据源失败: %v", err)
	}
	// 坏规则跳过，但下标照常推进 → kazumi_2 而不是 kazumi_1。
	want := []Source{{ID: "kazumi_0", Name: "alpha"}, {ID: "kazumi_2", Name: "gamma"}}
	if len(sources) != len(want) {
		t.Fatalf("数据源 = %+v，期望 %+v", sources, want)
	}
	for index := range want {
		if sources[index] != want[index] {
			t.Errorf("第 %d 个 = %+v，期望 %+v", index, sources[index], want[index])
		}
	}

	if provider, err := service.Get(context.Background(), "kazumi_2"); err != nil || provider == nil {
		t.Errorf("按 id 取源失败: %v/%v", provider, err)
	}
	if provider, _ := service.Get(context.Background(), "kazumi_1"); provider != nil {
		t.Errorf("跳过的 id 不该有 provider，得到 %+v", provider)
	}
}

// ===========================================================================
// API 规则
// ===========================================================================

func TestPrepareRequest(t *testing.T) {
	variables := map[string]any{"keyword": "中 文"}

	// 只有 URL 模板、没有额外 query：整条查询串原样保留，
	// 模板里的 @keyword 按 encodeURIComponent 编成 %20。
	prepared, err := prepareRequest(&APIRequest{
		Method: "GET",
		URL:    "https://api.example.com/search?kd=@keyword",
	}, variables, struct{ UserAgent, Referer string }{UserAgent: "UA/1", Referer: "https://a.example/"})
	if err != nil {
		t.Fatalf("渲染请求失败: %v", err)
	}
	if prepared.Method != "GET" || prepared.Body != "" {
		t.Errorf("请求 = %+v", prepared)
	}
	if !strings.Contains(prepared.URL, "kd=%E4%B8%AD%20%E6%96%87") {
		t.Errorf("URL = %q，模板变量应编成 %%20", prepared.URL)
	}
	if prepared.Headers["Referer"] != "https://a.example/" || prepared.Headers["User-Agent"] != "UA/1" {
		t.Errorf("请求头 = %v", prepared.Headers)
	}

	// 有额外 query 时会整条重编码（Node 的 searchParams.set 同样会把
	// 已有的 %20 变成 +）——那是 URLSearchParams 的表单语义，不是 bug。
	prepared, err = prepareRequest(&APIRequest{
		Method: "GET",
		URL:    "https://api.example.com/search?kd=@keyword",
		Query:  map[string]any{"wd": "@keyword", "page": float64(1)},
	}, variables, struct{ UserAgent, Referer string }{})
	if err != nil {
		t.Fatalf("渲染请求失败: %v", err)
	}
	parsed, err := url.Parse(prepared.URL)
	if err != nil {
		t.Fatalf("URL 解析失败: %v", err)
	}
	if parsed.Query().Get("kd") != "中 文" || parsed.Query().Get("wd") != "中 文" {
		t.Errorf("查询参数 = %v", parsed.Query())
	}
	if !strings.Contains(prepared.URL, "kd=%E4%B8%AD+%E6%96%87") {
		t.Errorf("URL = %q，重编码后空格应编成 +", prepared.URL)
	}
	if !strings.Contains(prepared.URL, "page=1") {
		t.Errorf("URL = %q，数字参数应渲染成 1", prepared.URL)
	}

	prepared, err = prepareRequest(&APIRequest{
		Method:   "post",
		URL:      "https://api.example.com/search",
		BodyType: "json",
		Body:     map[string]any{"wd": "@keyword", "page": float64(1)},
	}, variables, struct{ UserAgent, Referer string }{})
	if err != nil {
		t.Fatalf("渲染请求失败: %v", err)
	}
	if prepared.Method != "POST" || prepared.ContentType != "application/json" {
		t.Errorf("请求 = %+v", prepared)
	}
	var body map[string]any
	if err := json.Unmarshal([]byte(prepared.Body), &body); err != nil {
		t.Fatalf("请求体不是 JSON: %v", err)
	}
	if body["wd"] != "中 文" || body["page"].(float64) != 1 {
		t.Errorf("请求体 = %v", body)
	}

	prepared, err = prepareRequest(&APIRequest{
		Method:   "POST",
		URL:      "https://api.example.com/search",
		BodyType: "form",
		Body:     map[string]any{"wd": "@keyword"},
	}, variables, struct{ UserAgent, Referer string }{})
	if err != nil {
		t.Fatalf("渲染请求失败: %v", err)
	}
	if prepared.ContentType != "application/x-www-form-urlencoded" || !strings.Contains(prepared.Body, "wd=%E4%B8%AD+%E6%96%87") {
		t.Errorf("表单请求 = %+v", prepared)
	}

	if _, err := prepareRequest(&APIRequest{Method: "PUT", URL: "https://a.com/"}, variables, struct{ UserAgent, Referer string }{}); err == nil {
		t.Error("只支持 GET/POST")
	}
	if _, err := prepareRequest(&APIRequest{URL: " "}, variables, struct{ UserAgent, Referer string }{}); err == nil {
		t.Error("空 URL 应报错")
	}
	if _, err := prepareRequest(&APIRequest{URL: "ftp://a.com/"}, variables, struct{ UserAgent, Referer string }{}); err == nil {
		t.Error("非 http(s) 应报错")
	}
	if _, err := prepareRequest(&APIRequest{URL: "https://a.com/@nope"}, variables, struct{ UserAgent, Referer string }{}); err == nil {
		t.Error("缺变量应报错")
	}
}

func TestParseNested(t *testing.T) {
	document := map[string]any{
		"roads": []any{
			map[string]any{
				"name": "线路A",
				"eps": []any{
					map[string]any{"label": "第1集", "id": "e1"},
					map[string]any{"label": "", "id": "e2"},
				},
			},
			map[string]any{"name": "", "eps": []any{}},
		},
	}
	config := &APIChapterConfig{
		RoadsPath:       "$.roads[*]",
		RoadNamePath:    "$.name",
		EpisodesPath:    "$.eps[*]",
		EpisodeNamePath: "$.label",
		EpisodeURLPath:  "$.id",
		EpisodePage: &APIEpisodePageConfig{
			URL:   "https://a.com/play/@episodeUrl?t=@roadNumber&e=@episodeNumber",
			Query: map[string]any{"i": "@episodeIndex"},
		},
	}
	roads, err := parseNested(document, config, map[string]any{}, "https://a.com/")
	if err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	if len(roads) != 1 {
		t.Fatalf("线路数 = %d，期望 1（空线路被跳过）", len(roads))
	}
	if roads[0].Name != "线路A" {
		t.Errorf("线路名 = %q", roads[0].Name)
	}
	want := []string{"https://a.com/play/e1?e=1&i=0&t=1", "https://a.com/play/e2?e=2&i=1&t=1"}
	if len(roads[0].URLs) != 2 || roads[0].URLs[0] != want[0] || roads[0].URLs[1] != want[1] {
		t.Errorf("播放页 = %v，期望 %v", roads[0].URLs, want)
	}
	// 没有集名时按序号补。
	if roads[0].Titles[1] != "第2集" {
		t.Errorf("补位集名 = %q，期望 第2集", roads[0].Titles[1])
	}
}

func TestParseDelimited(t *testing.T) {
	document := map[string]any{
		"from": "线路甲$$$线路乙",
		"url":  "第1集$e1#第2集$e2$$$第3集$e3#坏的没有分隔符#$$$空线路",
	}
	config := &APIChapterConfig{
		RoadNamesPath:    "$.from",
		RoadEpisodesPath: "$.url",
	}
	roads, err := parseDelimited(document, config, map[string]any{}, "https://a.com/")
	if err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	if len(roads) != 2 {
		t.Fatalf("线路数 = %d，期望 2", len(roads))
	}
	if roads[0].Name != "线路甲" || len(roads[0].URLs) != 2 {
		t.Errorf("第一线路 = %+v", roads[0])
	}
	if roads[0].URLs[0] != "https://a.com/e1" {
		t.Errorf("第一集地址 = %q", roads[0].URLs[0])
	}
	// 第二线路的「坏的没有分隔符」被跳过，只剩一集。
	if roads[1].Name != "线路乙" || len(roads[1].URLs) != 1 || roads[1].URLs[0] != "https://a.com/e3" {
		t.Errorf("第二线路 = %+v", roads[1])
	}

	if _, err := parseDelimited(map[string]any{}, config, map[string]any{}, "https://a.com/"); err != nil {
		t.Errorf("空报文不该报错: %v", err)
	}
	empty, err := parseDelimited(map[string]any{}, config, map[string]any{}, "https://a.com/")
	if err != nil || len(empty) != 0 {
		t.Errorf("空报文应给空列表，得到 %v/%v", empty, err)
	}
}

func TestProviderPlaybackURLDirectFormat(t *testing.T) {
	// 媒体地址直接落在 playbackParams 里时不该再抓页面。
	provider := newProvider("kazumi_0", &Rule{Name: "x", BaseURL: "https://a.com/", UserAgent: "UA/1"})
	result, err := provider.PlaybackURL(context.Background(), Episode{
		PlaybackParams: map[string]any{"episodeUrl": "https://cdn.example.com/a.m3u8"},
	})
	if err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	if result == nil || result.URL != "https://cdn.example.com/a.m3u8" || result.Format != "hls" {
		t.Errorf("解析结果 = %+v", result)
	}
	if result.Headers["User-Agent"] != "UA/1" || result.Headers["Referer"] != "https://a.com/" {
		t.Errorf("请求头 = %v", result.Headers)
	}

	if _, err := provider.PlaybackURL(context.Background(), Episode{PlaybackParams: map[string]any{}}); err == nil {
		t.Error("缺剧集页地址应报错")
	}
}
