package crawler

import (
	"encoding/json"
	"strings"
	"testing"

	"golang.org/x/text/encoding/simplifiedchinese"
	"golang.org/x/text/transform"
)

const sampleHTML = `<!doctype html><html><head><title>搜索：流浪地球</title></head><body>
<div class="result-list">
  <div class="result-item">
    <a class="title" href="/movie/1">流浪地球 4K 高清</a>
    <img class="cover" src="/img/1.jpg">
    <span class="desc">国产科幻  电影</span>
    <span class="duration">2小时05分</span>
  </div>
  <div class="result-item">
    <a class="title" href="/movie/2">流浪地球2</a>
    <img class="cover" src="https://cdn.example.com/2.jpg">
    <span class="desc">续集</span>
  </div>
  <div class="result-item">
    <a class="title" href="/movie/1">重复条目</a>
    <img class="cover" src="/img/1.jpg">
  </div>
  <div class="result-item">
    <a class="title" href="">缺链接</a>
  </div>
  <div class="result-item empty"></div>
</div>
</body></html>`

func htmlRule() *Rule {
	return &Rule{
		Name:        "示例站",
		Site:        "example.com",
		Enabled:     true,
		Description: "测试",
		Search: Search{
			Mode: "http",
			Request: SearchRequest{
				Method: "GET",
				URL:    "https://example.com/search?q={keyword}",
			},
		},
		Parse: Parse{
			Type:      "html",
			Container: ".result-item",
			Fields: map[string]Field{
				"title":      {Selector: ".title"},
				"url":        {Selector: ".title", Attr: "href"},
				"cover":      {Selector: "img.cover", Attr: "src"},
				"description": {Selector: ".desc"},
				"duration":   {Selector: ".duration"},
			},
		},
	}
}

func TestExtractHTML(t *testing.T) {
	rule, err := Validate(htmlRule())
	if err != nil {
		t.Fatalf("validate: %v", err)
	}
	items, skipped, err := ExtractItems(rule, sampleHTML, "https://example.com/search?q=x")
	if err != nil {
		t.Fatalf("extract: %v", err)
	}
	// 5 个 container：1 条重复（按 url 去重）、1 条缺 url、1 条全空 → 只剩 2 条。
	if len(items) != 2 {
		t.Fatalf("want 2 items, got %d: %+v", len(items), items)
	}
	if skipped != 2 {
		t.Errorf("want skipped=2, got %d", skipped)
	}
	first := items[0]
	if first["title"] != "流浪地球 4K 高清" {
		t.Errorf("title = %q", first["title"])
	}
	if first["url"] != "https://example.com/movie/1" {
		t.Errorf("url not absolutised: %q", first["url"])
	}
	// cover 默认补绝对地址；已经是绝对地址的保持不变。
	if first["cover"] != "https://example.com/img/1.jpg" {
		t.Errorf("cover = %q", first["cover"])
	}
	if items[1]["cover"] != "https://cdn.example.com/2.jpg" {
		t.Errorf("absolute cover changed: %q", items[1]["cover"])
	}
	// 连续空白（含换行）折叠成单空格。
	if first["description"] != "国产科幻 电影" {
		t.Errorf("description = %q", first["description"])
	}
}

func TestContainsPseudo(t *testing.T) {
	dom, err := ParseHTML(sampleHTML)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	// Python 版 :contains 不区分大小写，cascadia 是区分大小写的。
	found, err := dom.SelectAll(`.result-item:contains("流浪地球2")`)
	if err != nil {
		t.Fatalf("contains: %v", err)
	}
	if len(found) != 1 {
		t.Fatalf("want 1 match for :contains, got %d", len(found))
	}
	// 验证 :not 与 :nth-child 可用。
	if _, err := dom.SelectAll(`.result-item:not(.empty):nth-child(1)`); err != nil {
		t.Fatalf("not/nth-child: %v", err)
	}
}

func TestContainsCaseInsensitive(t *testing.T) {
	dom, err := ParseHTML(`<div class="x">HD 高清</div><div class="x">hd 标清</div>`)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	// 规则作者常写 :contains("HD")，站点可能写 hd。Python 版两种都命中。
	found, err := dom.SelectAll(`.x:contains("HD")`)
	if err != nil {
		t.Fatalf("contains: %v", err)
	}
	if len(found) != 2 {
		t.Errorf(":contains should be case-insensitive, matched %d of 2", len(found))
	}
}

const sampleJSON = `{
  "code": 0,
  "data": {
    "list": [
      {"title": "流浪地球", "play_url": "/play/1", "pic": "//img/1.jpg", "year": 2019},
      {"title": "流浪地球2", "play_url": "/play/2", "pic": "//img/2.jpg", "tags": ["科幻", "院线"]},
      {"title": "流浪地球", "play_url": "/play/1", "pic": "//img/1.jpg"}
    ]
  }
}`

func jsonRule() *Rule {
	return &Rule{
		Name:    "JSON 站",
		Site:    "api.example.com",
		Enabled: true,
		Search: Search{
			Mode:    "http",
			Request: SearchRequest{Method: "GET", URL: "https://api.example.com/s?q={keyword}"},
		},
		Parse: Parse{
			Type:     "json",
			ListPath: "data.list",
			Fields: map[string]Field{
				"title": {Path: "title"},
				"url":   {Path: "play_url"},
				"cover": {Path: "pic"},
				"extra": {Path: "tags"},
			},
		},
	}
}

func TestExtractJSON(t *testing.T) {
	rule, err := Validate(jsonRule())
	if err != nil {
		t.Fatalf("validate: %v", err)
	}
	items, _, err := ExtractItems(rule, sampleJSON, "https://api.example.com/s?q=x")
	if err != nil {
		t.Fatalf("extract: %v", err)
	}
	if len(items) != 2 {
		t.Fatalf("want 2 deduped items, got %d", len(items))
	}
	if items[0]["url"] != "https://api.example.com/play/1" {
		t.Errorf("url = %q", items[0]["url"])
	}
	// //img/1.jpg 的 netloc 就是 img，urljoin 补成 https://img/1.jpg
	// （Python 的 urljoin 同样是这个结果，不是拼成 api.example.com/img）。
	if items[0]["cover"] != "https://img/1.jpg" {
		t.Errorf("cover = %q", items[0]["cover"])
	}
	if items[1]["extra"] != `["科幻","院线"]` {
		t.Errorf("array field = %q", items[1]["extra"])
	}
}

func TestJSONPathForms(t *testing.T) {
	var data any
	decoder := json.NewDecoder(strings.NewReader(`{"a":{"b":[{"t":"x"},{"t":"y"}]},"c":[[1,2]]}`))
	decoder.UseNumber()
	if err := decoder.Decode(&data); err != nil {
		t.Fatalf("decode: %v", err)
	}
	cases := map[string]int{
		"a.b":          1, // 命中一个 list 本身
		"a.b[*].t":     2,
		"$.a.b[1].t":   1,
		"a.b[0]":       1,
		"c[0][1]":      1,
		"a.b[*].missing": 0,
	}
	for path, want := range cases {
		values, err := jsonPath(data, path)
		if err != nil {
			t.Fatalf("%s: %v", path, err)
		}
		if len(values) != want {
			t.Errorf("%s: want %d values, got %d", path, want, len(values))
		}
	}
}

func TestValidateRejects(t *testing.T) {
	cases := []struct {
		name string
		rule *Rule
		want string
	}{
		{
			name: "缺 name",
			rule: &Rule{Site: "a.com", Search: Search{Request: SearchRequest{URL: "https://a.com/?q={keyword}"}}, Parse: Parse{Container: ".x", Fields: map[string]Field{"title": {Selector: "a"}, "url": {Selector: "a"}}}},
			want: "缺少规则名称",
		},
		{
			name: "缺占位符",
			rule: &Rule{Name: "x", Site: "a.com", Search: Search{Request: SearchRequest{URL: "https://a.com/search"}}, Parse: Parse{Container: ".x", Fields: map[string]Field{"title": {Selector: "a"}, "url": {Selector: "a"}}}},
			want: "占位符",
		},
		{
			name: "html 缺 container",
			rule: &Rule{Name: "x", Site: "a.com", Search: Search{Request: SearchRequest{URL: "https://a.com/?q={keyword}"}}, Parse: Parse{Fields: map[string]Field{"title": {Selector: "a"}, "url": {Selector: "a"}}}},
			want: "parse.container 不能为空",
		},
		{
			name: "script runtime 非 node",
			rule: &Rule{Name: "x", Site: "a.com", Search: Search{Mode: "script", Script: Script{Runtime: "quickjs", Source: "1"}}, Parse: Parse{Type: "html", Container: ".x", Fields: map[string]Field{"title": {Selector: "a"}, "url": {Selector: "a"}}}},
			want: "runtime 目前只支持 node",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := Validate(tc.rule)
			if err == nil {
				t.Fatalf("want error containing %q, got nil", tc.want)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("want error containing %q, got %q", tc.want, err.Error())
			}
			if code := ErrorCode(err); code != "rule_error" {
				t.Errorf("code = %s", code)
			}
		})
	}
}

func TestNormalizeDefaults(t *testing.T) {
	raw := []byte(`{"name":" 示例 ","site":"HTTPS://WWW.Example.com:8080/path","search":{"request":{"url":"https://a.com/?q={keyword}"}},"parse":{"container":" .item ","fields":{"title":{"selector":".t"},"url":{"selector":"a","attr":"href"}}}}`)
	rule, err := DecodeRule(raw)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if rule.Site != "www.example.com" {
		t.Errorf("site = %q", rule.Site)
	}
	if rule.Name != "示例" {
		t.Errorf("name = %q", rule.Name)
	}
	if !rule.Enabled {
		t.Error("enabled should default to true")
	}
	if rule.Visibility != "public" || rule.CreatedBy != "root" || rule.Version != 1 {
		t.Errorf("defaults wrong: %+v", rule)
	}
	if rule.Parse.Limit != 30 || rule.Parse.DedupeBy != "url" {
		t.Errorf("parse defaults wrong: limit=%d dedupe=%q", rule.Parse.Limit, rule.Parse.DedupeBy)
	}
	if rule.Search.Mode != "http" || rule.Search.Request.Method != "GET" || rule.Search.Encoding != "utf-8" {
		t.Errorf("search defaults wrong: %+v", rule.Search)
	}
	if rule.Parse.Container != ".item" {
		t.Errorf("container should be trimmed, got %q", rule.Parse.Container)
	}
	if rule.Search.Script.Runtime != "node" || rule.Search.Script.TimeoutSec != 20 {
		t.Errorf("script defaults wrong: %+v", rule.Search.Script)
	}
}

func TestStringShorthandFields(t *testing.T) {
	raw := []byte(`{"name":"x","site":"a.com","search":{"request":{"url":"https://a.com/?q={keyword}"}},"parse":{"type":"html","container":".i","fields":{"title":".t","url":{"selector":"a","attr":"href"}}},"play":{"playUrlRegex":"m3u8","api":{"skipFrom":"a"}}}`)
	rule, err := DecodeRule(raw)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if rule.Parse.Fields["title"].Selector != ".t" {
		t.Errorf("string shorthand not applied: %+v", rule.Parse.Fields["title"])
	}
	if rule.Play == nil || rule.Play.PlayURLRegex != "m3u8" {
		t.Fatalf("play alias not parsed: %+v", rule.Play)
	}
	if len(rule.Play.API.SkipFrom) != 1 || rule.Play.API.SkipFrom[0] != "a" {
		t.Errorf("skipFrom alias wrong: %+v", rule.Play.API.SkipFrom)
	}
}

func TestQuoteKeyword(t *testing.T) {
	utf8Encoded, err := QuoteKeyword("流浪地球", "utf-8")
	if err != nil {
		t.Fatalf("quote: %v", err)
	}
	if utf8Encoded != "%E6%B5%81%E6%B5%AA%E5%9C%B0%E7%90%83" {
		t.Errorf("utf-8 quote = %s", utf8Encoded)
	}
	gbkEncoded, err := QuoteKeyword("流浪地球", "gbk")
	if err != nil {
		t.Fatalf("quote gbk: %v", err)
	}
	if gbkEncoded != "%C1%F7%C0%CB%B5%D8%C7%F2" {
		t.Errorf("gbk quote = %s", gbkEncoded)
	}
	// 空格编成 %20（不是 +），与 Python 的 quote(safe="") 一致。
	spaced, err := QuoteKeyword("a b", "utf-8")
	if err != nil {
		t.Fatalf("quote: %v", err)
	}
	if spaced != "a%20b" {
		t.Errorf("space encoding = %s", spaced)
	}
}

func TestBuildRequestPostJSON(t *testing.T) {
	rule, err := Validate(&Rule{
		Name: "post", Site: "a.com",
		Search: Search{
			Mode: "http",
			Request: SearchRequest{
				Method:   "POST",
				URL:      "https://a.com/api/search",
				Body:     `{"kw":"{keyword}"}`,
				BodyType: "json",
			},
			Encoding: "utf-8",
		},
		Parse: Parse{Type: "html", Container: ".i", Fields: map[string]Field{
			"title": {Selector: ".t"}, "url": {Selector: "a"},
		}},
	})
	if err != nil {
		t.Fatalf("validate: %v", err)
	}
	built, err := BuildRequest(rule, "流浪地球")
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if built.Method != "POST" || len(built.Body) == 0 {
		t.Fatalf("body not set: %+v", built)
	}
	if built.Headers["Content-Type"] != "application/json; charset=utf-8" {
		t.Errorf("content-type = %q", built.Headers["Content-Type"])
	}
	if !strings.Contains(string(built.Body), "%E6%B5%81") {
		t.Errorf("keyword not encoded in body: %s", built.Body)
	}
}

func TestDecodeGBK(t *testing.T) {
	raw, _, err := transform.Bytes(simplifiedchinese.GBK.NewEncoder(), []byte("流浪地球"))
	if err != nil {
		t.Fatalf("encode gbk: %v", err)
	}
	text, encoding := decodeText(raw, "gbk")
	if text != "流浪地球" {
		t.Errorf("decoded = %q", text)
	}
	if encoding != "gbk" {
		t.Errorf("encoding = %q", encoding)
	}
	// 声明 gb2312 时按 GBK 解（浏览器行为），不因个别字报错。
	text2312, _ := decodeText(raw, "gb2312")
	if text2312 != "流浪地球" {
		t.Errorf("gb2312 decoded = %q", text2312)
	}
}

func TestDetectEncodingFromMeta(t *testing.T) {
	body := []byte(`<html><head><meta charset="gbk"></head><body></body></html>`)
	if got := detectEncoding(map[string]string{}, body); got != "gbk" {
		t.Errorf("meta charset = %q", got)
	}
	if got := detectEncoding(map[string]string{"content-type": "text/html; charset=GB18030"}, body); got != "gb18030" {
		t.Errorf("header charset = %q", got)
	}
}

func TestPublicViewShape(t *testing.T) {
	rule, err := DecodeRule([]byte(`{"id":"abc","name":"示例","site":"a.com","search":{"request":{"url":"https://a.com/?q={keyword}"}},"parse":{"container":".i","fields":{"title":".t","url":"a"}}}`))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	view := PublicView(rule, false)
	for _, key := range []string{"id", "name", "site", "aliases", "enabled", "visibility", "allowedRooms", "description", "createdBy", "createdAt", "updatedAt", "version", "stats"} {
		if _, ok := view[key]; !ok {
			t.Errorf("missing key %s", key)
		}
	}
	if _, ok := view["parse"]; ok {
		t.Error("parse should be hidden without includeParse")
	}
	full := PublicView(rule, true)
	if _, ok := full["parse"]; !ok {
		t.Error("parse missing with includeParse")
	}
	encoded, err := json.Marshal(full)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(encoded), `"allowedRooms"`) || !strings.Contains(string(encoded), `"container"`) {
		t.Errorf("unexpected json: %s", encoded)
	}
}
