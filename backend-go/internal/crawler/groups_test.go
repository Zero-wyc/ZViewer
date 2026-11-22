package crawler

import (
	"encoding/json"
	"net/http"
	"testing"
)

// CMS/TVBox 的真实形态：线路名与集数串各自用 $$$ 分组，组内用 # 分集、$ 分集名与链接。
const cmsPlayFrom = "ffm3u8$$$ldm3u8"
const cmsPlayURL = "第01集$https://cdn.a/1.m3u8#第02集$https://cdn.a/2.m3u8$$$第01集$https://cdn.b/1.m3u8"

func TestBuildGroupsWithNames(t *testing.T) {
	spec := normalizeGroupSpec(&GroupSpec{Field: "play_url", NamesField: "play_from"})
	groups := BuildGroups(spec, map[string]string{
		"play_url":  cmsPlayURL,
		"play_from": cmsPlayFrom,
	})
	if len(groups) != 2 {
		t.Fatalf("groups = %d, want 2", len(groups))
	}
	if groups[0].Name != "ffm3u8" || groups[1].Name != "ldm3u8" {
		t.Errorf("names = %q / %q", groups[0].Name, groups[1].Name)
	}
	if len(groups[0].Episodes) != 2 {
		t.Fatalf("episodes = %d, want 2", len(groups[0].Episodes))
	}
	first := groups[0].Episodes[0]
	if first.Name != "第01集" || first.URL != "https://cdn.a/1.m3u8" {
		t.Errorf("episode = %+v", first)
	}
}

func TestBuildGroupsWithoutNames(t *testing.T) {
	spec := normalizeGroupSpec(&GroupSpec{Field: "play"})
	groups := BuildGroups(spec, map[string]string{"play": "第1集$https://a/1.mp4#第2集$https://a/2.mp4"})
	if len(groups) != 1 {
		t.Fatalf("groups = %d, want 1", len(groups))
	}
	if groups[0].Name != "线路 1" {
		t.Errorf("name = %q", groups[0].Name)
	}
	if len(groups[0].Episodes) != 2 {
		t.Errorf("episodes = %d", len(groups[0].Episodes))
	}
}

func TestBuildGroupsMissingField(t *testing.T) {
	spec := normalizeGroupSpec(&GroupSpec{Field: "play"})
	if groups := BuildGroups(spec, map[string]string{"title": "只有标题"}); groups != nil {
		t.Fatalf("want nil, got %+v", groups)
	}
	if groups := BuildGroups(nil, map[string]string{"play": "x"}); groups != nil {
		t.Fatalf("nil spec should return nil")
	}
}

// 没有集名分隔符时整段当链接，集名按顺序补。
func TestBuildGroupsNoNameSeparator(t *testing.T) {
	spec := normalizeGroupSpec(&GroupSpec{Field: "play", EpisodeSep: "|"})
	groups := BuildGroups(spec, map[string]string{"play": "https://a/1.mp4|https://a/2.mp4"})
	if len(groups) != 1 {
		t.Fatalf("groups = %+v", groups)
	}
	if len(groups[0].Episodes) != 2 {
		t.Fatalf("episodes = %+v", groups[0].Episodes)
	}
	if groups[0].Episodes[1].Name != "第 2 集" || groups[0].Episodes[1].URL != "https://a/2.mp4" {
		t.Errorf("episode = %+v", groups[0].Episodes[1])
	}
}

func TestRuleGroupsRoundTrip(t *testing.T) {
	raw := `{
		"name": "采集站",
		"site": "example.com",
		"search": {"mode": "http", "request": {"url": "https://example.com/api.php/provide/vod/?ac=detail&wd={keyword}"}},
		"parse": {
			"type": "json",
			"list_path": "$.list",
			"fields": {
				"title": {"path": "vod_name"},
				"url": {"path": "vod_id", "prefix": "https://example.com/detail/"},
				"play_url": {"path": "vod_play_url"},
				"play_from": {"path": "vod_play_from"}
			},
			"groups": {"field": "play_url", "names_field": "play_from"}
		}
	}`
	rule, err := DecodeRule([]byte(raw))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if rule.Parse.Groups == nil {
		t.Fatal("groups 没有被读进来")
	}
	if rule.Parse.Groups.GroupSep != "$$$" || rule.Parse.Groups.EpisodeSep != "#" || rule.Parse.Groups.NameSep != "$" {
		t.Errorf("分隔符默认值没补上: %+v", rule.Parse.Groups)
	}
}

func TestValidateRejectsUnknownGroupField(t *testing.T) {
	raw := `{
		"name": "采集站",
		"site": "example.com",
		"search": {"mode": "http", "request": {"url": "https://example.com/api.php/provide/vod/?ac=detail&wd={keyword}"}},
		"parse": {
			"type": "json",
			"list_path": "$.list",
			"fields": {"title": {"path": "vod_name"}, "url": {"path": "vod_id"}},
			"groups": {"field": "play_url"}
		}
	}`
	var rule Rule
	if err := json.Unmarshal([]byte(raw), &rule); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if _, err := Validate(&rule); err == nil {
		t.Fatal("groups.field 不在 parse.fields 里应当报错")
	}
}

// 端到端：JSON 规则跑一次搜索，结果条目带 groups。
func TestSearchAttachesGroups(t *testing.T) {
	wrapper, store, shutdown := newTestServiceWithURL(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"list":[{"vod_name":"流浪地球","vod_id":"42","vod_play_from":"` + cmsPlayFrom + `","vod_play_url":"` + cmsPlayURL + `"}]}`))
	}))
	defer shutdown()

	rule := &Rule{
		Name:    "采集站",
		Site:    hostOfServer(wrapper.baseURL),
		Enabled: true,
		Search: Search{
			Mode:    "http",
			Request: SearchRequest{Method: "GET", URL: wrapper.baseURL + "/api.php/provide/vod/?ac=detail&wd={keyword}"},
		},
		Parse: Parse{
			Type:     "json",
			ListPath: "$.list",
			Fields: map[string]Field{
				"title":     {Path: "vod_name"},
				"url":       {Path: "vod_id"},
				"play_url":  {Path: "vod_play_url"},
				"play_from": {Path: "vod_play_from"},
			},
			Groups: &GroupSpec{Field: "play_url", NamesField: "play_from"},
		},
	}
	if _, err := store.Save(rule, ""); err != nil {
		t.Fatalf("save: %v", err)
	}
	result, err := wrapper.service.Search("采集站", "流浪地球", "", "guest", 0, nil, true)
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	items := result["items"].([]map[string]any)
	if len(items) != 1 {
		t.Fatalf("items = %d", len(items))
	}
	groups, ok := items[0]["groups"].([]PlayGroup)
	if !ok {
		t.Fatalf("groups 类型不对: %#v", items[0]["groups"])
	}
	if len(groups) != 2 || groups[1].Name != "ldm3u8" {
		t.Fatalf("groups = %+v", groups)
	}

	// JSON 序列化后前端拿到的是对象数组。
	encoded, err := json.Marshal(items[0]["groups"])
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var decoded []map[string]any
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if decoded[0]["name"] != "ffm3u8" {
		t.Errorf("decoded = %v", decoded[0])
	}
}

// XPath 规则：容器与字段都是 XPath（Kazumi 的形态）。
func TestExtractXPathRule(t *testing.T) {
	rule := &Rule{
		Parse: Parse{
			Type:           "html",
			ContainerXPath: `//div[@class="module-item"]`,
			Fields: map[string]Field{
				"title": {XPath: `.//a[@class="title"]`},
				"url":   {XPath: `.//a[@class="title"]`, Attr: "href"},
				"cover": {XPath: `.//img`, Attr: "data-src"},
			},
		},
	}
	html := `<html><body>
		<div class="module-item"><a class="title" href="/v/1">片一</a><img data-src="/c/1.jpg"></div>
		<div class="module-item"><a class="title" href="/v/2">片二</a><img data-src="/c/2.jpg"></div>
	</body></html>`
	items, skipped, err := ExtractItems(rule, html, "https://example.com/search")
	if err != nil {
		t.Fatalf("extract: %v", err)
	}
	if skipped != 0 || len(items) != 2 {
		t.Fatalf("items=%d skipped=%d", len(items), skipped)
	}
	if items[0]["title"] != "片一" {
		t.Errorf("title = %q", items[0]["title"])
	}
	if items[0]["url"] != "https://example.com/v/1" {
		t.Errorf("url = %q", items[0]["url"])
	}
	if items[1]["cover"] != "https://example.com/c/2.jpg" {
		t.Errorf("cover = %q", items[1]["cover"])
	}
}
