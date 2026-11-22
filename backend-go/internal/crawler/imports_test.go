package crawler

import (
	"net/http"
	"strings"
	"testing"

	"zviewer/backend/internal/anisubs"
)

// CMS 导入的规则要真能跑：起一个假的 provide/vod，走一次搜索并拿到分组。
func TestCMSRuleFromAPIRuns(t *testing.T) {
	wrapper, store, shutdown := newTestServiceWithURL(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.URL.Query().Get("ac"); got != "detail" {
			t.Errorf("ac = %q", got)
		}
		if got := r.URL.Query().Get("wd"); got != "流浪地球" {
			t.Errorf("wd = %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"code":1,"list":[{"vod_id":7,"vod_name":"流浪地球","vod_pic":"/p.jpg","vod_remarks":"HD",
			"vod_play_from":"` + cmsPlayFrom + `","vod_play_url":"` + cmsPlayURL + `"}]}`))
	}))
	defer shutdown()

	imported := CMSRuleFromAPI("测试采集站", wrapper.baseURL+"/api.php/provide/vod/")
	if imported.Rule == nil {
		t.Fatalf("import failed: %s", imported.Reason)
	}
	rule, err := Validate(imported.Rule)
	if err != nil {
		t.Fatalf("validate: %v", err)
	}
	if _, err := store.Save(rule, ""); err != nil {
		t.Fatalf("save: %v", err)
	}
	result, err := wrapper.service.Search("测试采集站", "流浪地球", "", "guest", 0, nil, true)
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	items := result["items"].([]map[string]any)
	if len(items) != 1 {
		t.Fatalf("items = %d", len(items))
	}
	groups, ok := items[0]["groups"].([]PlayGroup)
	if !ok || len(groups) != 2 {
		t.Fatalf("groups = %#v", items[0]["groups"])
	}
	if groups[0].Episodes[0].Name != "第01集" {
		t.Errorf("episode = %+v", groups[0].Episodes[0])
	}
}

func TestCMSRuleRejectsBadAPI(t *testing.T) {
	if imported := CMSRuleFromAPI("x", "ftp://example.com"); imported.Rule != nil || imported.Reason == "" {
		t.Fatalf("imported = %+v", imported)
	}
}

func TestTVBoxSites(t *testing.T) {
	config := `{"sites":[
		{"key":"a","name":"甲站","type":1,"api":"https://a.example.com/api.php/provide/vod/","searchable":1},
		{"key":"b","name":"乙站","type":1,"api":"https://a.example.com/api.php/provide/vod/","searchable":1},
		{"key":"c","name":"非CMS","type":3,"api":"https://c.example.com/api"},
		{"key":"d","name":"丙站","type":1,"api":"https://d.example.com/api.php/provide/vod/"}
	]}`
	sites, err := TVBoxSites([]byte(config))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(sites) != 2 {
		t.Fatalf("sites = %d (%+v)", len(sites), sites)
	}
	rules := CMSRulesFromSites(sites)
	if len(rules) != 2 || rules[0].Rule == nil {
		t.Fatalf("rules = %+v", rules)
	}
}

func TestAniSubsRuleFromWebSelector(t *testing.T) {
	source := anisubs.MediaSource{FactoryID: "web-selector"}
	source.Arguments.Name = "某番剧站"
	source.Arguments.SearchConfig = &anisubs.SearchConfig{
		SearchURL:       "https://anime.example.com/search?q={keyword}",
		SubjectFormatID: "a",
		SelectorSubjectFormatA: &anisubs.SubjectFormatA{
			SelectLists: ".video-list .video-item",
		},
		ChannelFormatID: "no-channel",
		SelectorChannelFormatNoChannel: &anisubs.ChannelFormatNoChannel{
			SelectEpisodes:           ".episode-list li",
			SelectEpisodeLinks:       "a",
			MatchEpisodeSortFromName: "",
		},
	}
	imported := AniSubsRule(source)
	if imported.Rule == nil {
		t.Fatalf("import failed: %s", imported.Reason)
	}
	rule, err := Validate(imported.Rule)
	if err != nil {
		t.Fatalf("validate: %v", err)
	}
	// ani-subs 的 format a：列表项本身就是链接。
	page := `<html><body>
		<div class="video-list">
			<a class="video-item" href="/v/1">片一</a>
			<a class="video-item" href="/v/2">片二</a>
		</div>
	</body></html>`
	items, _, err := ExtractItems(rule, page, "https://anime.example.com/search")
	if err != nil {
		t.Fatalf("extract: %v", err)
	}
	if len(items) != 2 || items[0]["title"] != "片一" {
		t.Fatalf("items = %+v", items)
	}
	if !strings.HasSuffix(items[0]["url"], "/v/1") {
		t.Errorf("url = %q", items[0]["url"])
	}
	if rule.Play == nil || rule.Play.Episodes == nil {
		t.Fatal("选集段没有编译出来")
	}
	detail := `<html><body><ul class="episode-list">
		<li><a href="/p/1">第1话</a></li><li><a href="/p/2">第2话</a></li>
	</ul></body></html>`
	episodes := episodesFromParse(rule.Play, detail, "https://anime.example.com/v/1")
	if len(episodes) != 2 || episodes[0].Name != "第1话" {
		t.Fatalf("episodes = %+v", episodes)
	}
}

func TestAniSubsRuleSkipsRSS(t *testing.T) {
	source := anisubs.MediaSource{FactoryID: "rss"}
	source.Arguments.Name = "RSS 源"
	if imported := AniSubsRule(source); imported.Rule != nil || imported.Reason == "" {
		t.Fatalf("imported = %+v", imported)
	}
}

func TestKazumiRuleXPath(t *testing.T) {
	raw := `{
		"api": "1", "type": "anime", "name": "某番剧",
		"baseURL": "https://anime.example.com",
		"searchURL": "/search/@keyword",
		"searchList": "//div[@class='module-item']",
		"searchName": ".//a[@class='title']",
		"searchResult": ".//a[@class='title']",
		"chapterRoads": "//div[@class='episode-list']",
		"chapterResult": ".//li/a",
		"searchMode": "xpath", "chapterMode": "xpath"
	}`
	imported := KazumiRule([]byte(raw))
	if imported.Rule == nil {
		t.Fatalf("import failed: %s", imported.Reason)
	}
	rule, err := Validate(imported.Rule)
	if err != nil {
		t.Fatalf("validate: %v", err)
	}
	if rule.Search.Request.URL != "https://anime.example.com/search/{keyword}" {
		t.Errorf("url = %q", rule.Search.Request.URL)
	}
	page := `<html><body>
		<div class="module-item"><a class="title" href="/v/1">片一</a></div>
	</body></html>`
	items, _, err := ExtractItems(rule, page, "https://anime.example.com/search")
	if err != nil || len(items) != 1 {
		t.Fatalf("items = %+v err = %v", items, err)
	}
	if !strings.HasSuffix(items[0]["url"], "/v/1") {
		t.Errorf("url = %q", items[0]["url"])
	}
}

func TestKazumiRuleSkipsAPIMode(t *testing.T) {
	raw := `{"api":"1","name":"API 规则","searchMode":"api","searchApiConfig":{"request":{"url":"https://x/?wd=@keyword"}}}`
	imported := KazumiRule([]byte(raw))
	if imported.Rule != nil || imported.Reason == "" {
		t.Fatalf("imported = %+v", imported)
	}
	if !strings.Contains(imported.Reason, "API") {
		t.Errorf("reason = %q", imported.Reason)
	}
}

func TestNormalizeCSSSelector(t *testing.T) {
	cases := map[string]string{
		".nav a[href^=#playlist]": `.nav a[href^="#playlist"]`,
		".a[data-x='1']":          `.a[data-x='1']`,
		".plain":                  ".plain",
	}
	for input, want := range cases {
		if got := normalizeCSSSelector(input); got != want {
			t.Errorf("%s → %s, want %s", input, got, want)
		}
	}
}

func TestDeriveListPath(t *testing.T) {
	cases := map[string]string{
		"$.data[*].name":     "$.data[*]",
		"data.list[*].title": "data.list[*]",
		"":                   "",
	}
	for input, want := range cases {
		if got := deriveListPath(input); got != want {
			t.Errorf("%s → %q, want %q", input, got, want)
		}
	}
}

// 导入的规则必须能通过校验并落库（避免产出「看起来对、存不进去」的规则）。
func TestImportedRulesValidate(t *testing.T) {
	rules := []*Rule{
		CMSRuleFromAPI("站", "https://a.example.com/api.php/provide/vod/").Rule,
		AniSubsRule(anisubs.MediaSource{}).Rule,
		KazumiRule([]byte(`{}`)).Rule,
	}
	for index, rule := range rules {
		if rule == nil {
			continue
		}
		if _, err := Validate(rule); err != nil {
			t.Errorf("rule %d: %v", index, err)
		}
	}
	_ = rules
}
