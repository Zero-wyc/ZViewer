package anime

import (
	"context"
	"database/sql"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"

	_ "modernc.org/sqlite"

	"zviewer/backend/internal/bilibili"
	"zviewer/backend/internal/store"
)

// ===========================================================================
// 工具
// ===========================================================================

// textResponse 构造一个 200 文本响应。
func textResponse(body string) *http.Response {
	return &http.Response{
		StatusCode: http.StatusOK,
		Body:       io.NopCloser(strings.NewReader(body)),
		Header:     make(http.Header),
		Request:    &http.Request{URL: &url.URL{Scheme: "https", Host: "example.com"}},
	}
}

// stubTransport 按「host+path」路由返回固定文本。
type stubTransport struct {
	routes map[string]string
	query  map[string]string
}

func (s *stubTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if s.query != nil {
		s.query[req.URL.Host+req.URL.Path] = req.URL.RawQuery
	}
	key := req.URL.Host + req.URL.Path
	body, ok := s.routes[key]
	if !ok {
		// 允许前缀匹配：模板插值出来的路径（/search/abc）没法预先写死。
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
			Body:       io.NopCloser(strings.NewReader(`{"error":"not found"}`)),
			Header:     make(http.Header),
			Request:    req,
		}, nil
	}
	return textResponse(body), nil
}

// withStubHTTP 把包级客户端换成假 transport。
func withStubHTTP(t *testing.T, routes map[string]string) *stubTransport {
	t.Helper()
	stub := &stubTransport{routes: routes, query: map[string]string{}}
	previous := httpClient
	httpClient = &http.Client{Transport: stub}
	t.Cleanup(func() { httpClient = previous })
	return stub
}

// ===========================================================================
// seasonId 抠取
// ===========================================================================

func TestExtractSeasonID(t *testing.T) {
	cases := []struct {
		name  string
		input string
		want  string
	}{
		{name: "ss 前缀", input: "ss1234", want: "1234"},
		{name: "大写 SS", input: "SS 5678", want: "5678"},
		{name: "ep 前缀", input: "ep42", want: "42"},
		{name: "裸数字", input: "番剧 12345", want: "12345"},
		{name: "ss 优先于 ep", input: "ss11 ep22", want: "11"},
		{name: "没有数字", input: "孤独摇滚", want: ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := extractSeasonID(c.input); got != c.want {
				t.Errorf("extractSeasonID(%q) = %q，期望 %q", c.input, got, c.want)
			}
		})
	}
}

// ===========================================================================
// RSS
// ===========================================================================

const sampleRSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>示例订阅</title>
    <item>
      <title><![CDATA[<b>孤独摇滚</b> 第1话]]></title>
      <link>https://example.com/ep/1</link>
      <description><![CDATA[<p>波奇酱 &amp; 朋友们</p>]]></description>
      <pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate>
      <enclosure url="https://cdn.example.com/1.mp4" type="video/mp4"/>
    </item>
    <item>
      <title>只有附件的一集</title>
      <enclosure url="https://cdn.example.com/2.mp4"/>
    </item>
    <item>
      <title>没有链接的一集</title>
      <description>该条目既无 link 也无 enclosure</description>
    </item>
  </channel>
</rss>`

func TestParseRSSItems(t *testing.T) {
	items := parseRSSItems(sampleRSS)
	if len(items) != 2 {
		t.Fatalf("解析出 %d 条，期望 2 条（无链接的条目要丢弃）", len(items))
	}
	first := items[0]
	if first.title != "孤独摇滚 第1话" {
		t.Errorf("标题 = %q，期望剥掉 HTML 标签", first.title)
	}
	if first.link != "https://example.com/ep/1" {
		t.Errorf("链接 = %q", first.link)
	}
	if first.description != "波奇酱 & 朋友们" {
		t.Errorf("描述 = %q，期望解实体并把标签换成空格", first.description)
	}
	if first.pubDate != "Mon, 01 Jan 2024 00:00:00 GMT" {
		t.Errorf("pubDate = %q", first.pubDate)
	}
	if first.enclosureURL != "https://cdn.example.com/1.mp4" {
		t.Errorf("enclosure = %q", first.enclosureURL)
	}
	// 没有 link 时用 enclosure 顶上。
	if items[1].link != "https://cdn.example.com/2.mp4" {
		t.Errorf("第二条 link = %q，期望回落 enclosure", items[1].link)
	}
}

func TestParseAtomItems(t *testing.T) {
	xml := `<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>番剧 &amp; 剧场版</title>
    <link rel="alternate" href="https://example.com/a/1"/>
    <summary>简介</summary>
    <published>2024-01-01T00:00:00Z</published>
  </entry>
  <entry>
    <title>没有 href</title>
  </entry>
</feed>`
	items := parseAtomItems(xml)
	if len(items) != 1 {
		t.Fatalf("解析出 %d 条，期望 1 条", len(items))
	}
	if items[0].title != "番剧 & 剧场版" {
		t.Errorf("标题 = %q", items[0].title)
	}
	if items[0].link != "https://example.com/a/1" {
		t.Errorf("链接 = %q", items[0].link)
	}
}

func TestDecodeXMLEntities(t *testing.T) {
	input := `&amp;lt; &#39; &#65; &#x42; &quot;`
	want := `&lt; ' A B "`
	if got := decodeXMLEntities(input); got != want {
		t.Errorf("decodeXMLEntities = %q，期望 %q", got, want)
	}
}

func TestRSSProviderSearch(t *testing.T) {
	withStubHTTP(t, map[string]string{"feeds.example.com/rss": sampleRSS})
	provider := newRSSProvider("rss_1", "示例源", "https://feeds.example.com/rss")

	results, err := provider.Search(context.Background(), "孤独")
	if err != nil {
		t.Fatalf("搜索失败: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("命中 %d 条，期望 1 条", len(results))
	}
	if results[0].ID != "https://example.com/ep/1" {
		t.Errorf("id = %q", results[0].ID)
	}
	if results[0].Cover != nil {
		t.Error("RSS 结果不该有 cover 字段")
	}
	if results[0].Description == nil || *results[0].Description != "波奇酱 & 朋友们" {
		t.Errorf("description = %v", results[0].Description)
	}
	if results[0].Extra["feedUrl"] != "https://example.com/ep/1" {
		t.Errorf("extra = %v", results[0].Extra)
	}
}

func TestRSSProviderSearchMiss(t *testing.T) {
	withStubHTTP(t, map[string]string{"feeds.example.com/rss": sampleRSS})
	provider := newRSSProvider("rss_1", "示例源", "https://feeds.example.com/rss")

	results, err := provider.Search(context.Background(), "不存在的番")
	if err != nil {
		t.Fatalf("搜索失败: %v", err)
	}
	if len(results) != 0 {
		t.Errorf("命中 %d 条，期望 0 条", len(results))
	}
}

func TestRSSProviderEpisodes(t *testing.T) {
	withStubHTTP(t, map[string]string{"feeds.example.com/rss": sampleRSS})
	provider := newRSSProvider("rss_1", "示例源", "https://feeds.example.com/rss")

	episodes, err := provider.Episodes(context.Background(), "https://example.com/ep/1")
	if err != nil {
		t.Fatalf("取分集失败: %v", err)
	}
	if len(episodes) != 1 || episodes[0].EpisodeNumber != 1 {
		t.Fatalf("分集 = %+v", episodes)
	}
	if episodes[0].PlaybackParams["url"] != "https://cdn.example.com/1.mp4" {
		t.Errorf("播放参数 = %v，期望优先 enclosure", episodes[0].PlaybackParams)
	}

	if _, err := provider.Episodes(context.Background(), "https://example.com/missing"); err == nil {
		t.Error("找不到条目时应报错")
	}
}

func TestRSSProviderPlaybackURL(t *testing.T) {
	provider := newRSSProvider("rss_1", "示例源", "https://feeds.example.com/rss")

	result, err := provider.PlaybackURL(context.Background(), Episode{
		PlaybackParams: map[string]any{"url": "https://cdn.example.com/1.mp4"},
	})
	if err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	if result.URL != "https://cdn.example.com/1.mp4" {
		t.Errorf("url = %q", result.URL)
	}

	if _, err := provider.PlaybackURL(context.Background(), Episode{PlaybackParams: map[string]any{}}); err == nil {
		t.Error("缺少 url 时应报错")
	}
}

func TestRSSFetchErrors(t *testing.T) {
	// 非 2xx 与空响应各有独立文案。
	stub := &stubTransport{routes: map[string]string{}}
	previous := httpClient
	httpClient = &http.Client{Transport: stub}
	t.Cleanup(func() { httpClient = previous })

	_, err := fetchFeedItems(context.Background(), "https://feeds.example.com/rss")
	if err == nil || !strings.Contains(err.Error(), "RSS 订阅请求失败 [404]") {
		t.Errorf("错误 = %v，期望带状态码的文案", err)
	}

	withStubHTTP(t, map[string]string{"feeds.example.com/empty": "   "})
	_, err = fetchFeedItems(context.Background(), "https://feeds.example.com/empty")
	if err == nil || err.Error() != "RSS 订阅返回为空" {
		t.Errorf("错误 = %v", err)
	}
}

// ===========================================================================
// 第三方源
// ===========================================================================

func TestInterpolateURL(t *testing.T) {
	got := interpolateURL("https://api.example.com/search/{keyword}?page={page}", map[string]string{
		"keyword": "孤独 摇滚",
	})
	if got != "https://api.example.com/search/%E5%AD%A4%E7%8B%AC%20%E6%91%87%E6%BB%9A?page=" {
		t.Errorf("插值结果 = %q", got)
	}
}

func TestThirdPartySearch(t *testing.T) {
	withStubHTTP(t, map[string]string{
		"api.example.com/search": `{"code":0,"data":[
			{"animeId":7,"name":"孤独摇滚","cover":"//cdn/a.jpg","description":"乐队","extra":{"k":1}},
			{"seasonId":"9","title":"轻音少女","cover":""},
			{"id":11}
		]}`,
	})
	provider := newThirdPartyProvider("third_party_1", "第三方", ThirdPartyConfig{
		BaseURL: "https://api.example.com",
	})

	results, err := provider.Search(context.Background(), "孤独")
	if err != nil {
		t.Fatalf("搜索失败: %v", err)
	}
	if len(results) != 2 {
		t.Fatalf("命中 %d 条，期望 2 条（无 title 的条目要丢弃）", len(results))
	}
	if results[0].ID != "7" || results[0].Title != "孤独摇滚" {
		t.Errorf("第一条 = %+v，期望 id 走 animeId 回落", results[0])
	}
	if results[0].Cover == nil || *results[0].Cover != "//cdn/a.jpg" {
		t.Errorf("cover = %v", results[0].Cover)
	}
	if results[0].Extra["k"] != float64(1) {
		t.Errorf("extra = %v", results[0].Extra)
	}
	if results[1].ID != "9" || results[1].Title != "轻音少女" {
		t.Errorf("第二条 = %+v，期望 id 走 seasonId 回落", results[1])
	}
	if results[1].Cover != nil {
		t.Error("cover 为空串时不该下发该字段")
	}
	if results[1].Description != nil {
		t.Error("没有 description 时不该下发该字段")
	}
}

func TestThirdPartyEpisodes(t *testing.T) {
	withStubHTTP(t, map[string]string{
		"api.example.com/episodes/7": `[
			{"id":"ep1","title":"第一话","episodeNumber":1,"playbackParams":{"u":"a"}},
			{"episodeNumber":"3"},
			{}
		]`,
	})
	provider := newThirdPartyProvider("third_party_1", "第三方", ThirdPartyConfig{
		BaseURL: "https://api.example.com",
	})

	episodes, err := provider.Episodes(context.Background(), "7")
	if err != nil {
		t.Fatalf("取分集失败: %v", err)
	}
	if len(episodes) != 3 {
		t.Fatalf("分集数 = %d", len(episodes))
	}
	if episodes[0].PlaybackParams["u"] != "a" {
		t.Errorf("播放参数 = %v", episodes[0].PlaybackParams)
	}
	if episodes[1].ID != "2" {
		t.Errorf("缺 id 时按序号补 = %q", episodes[1].ID)
	}
	if episodes[1].EpisodeNumber != 3 {
		t.Errorf("字符串集号 = %d，期望 3", episodes[1].EpisodeNumber)
	}
	if episodes[1].Title != "第 3 集" {
		t.Errorf("缺标题时 = %q", episodes[1].Title)
	}
	if episodes[2].Title != "第 3 集" {
		t.Errorf("第三条 = %q，期望按序号生成（idx=3）", episodes[2].Title)
	}
}

func TestThirdPartyPlaybackURL(t *testing.T) {
	withStubHTTP(t, map[string]string{
		"api.example.com/resolve/ep1": `{"videoUrl":"https://cdn/x.m3u8","headers":{"Referer":"https://a.b"}}`,
		"api.example.com/resolve/ep2": `{"url":""}`,
		"api.example.com/resolve/ep3": `["not-an-object"]`,
	})
	provider := newThirdPartyProvider("third_party_1", "第三方", ThirdPartyConfig{
		BaseURL: "https://api.example.com",
	})

	result, err := provider.PlaybackURL(context.Background(), Episode{ID: "ep1"})
	if err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	if result.URL != "https://cdn/x.m3u8" || result.Headers["Referer"] != "https://a.b" {
		t.Errorf("结果 = %+v，期望回落 videoUrl 并透传 headers", result)
	}

	if result, err := provider.PlaybackURL(context.Background(), Episode{ID: "ep2"}); err != nil || result != nil {
		t.Errorf("空地址应返回 nil，得到 %+v / %v", result, err)
	}
	if result, err := provider.PlaybackURL(context.Background(), Episode{ID: "ep3"}); err != nil || result != nil {
		t.Errorf("非对象响应应返回 nil，得到 %+v / %v", result, err)
	}
}

func TestThirdPartyURLTemplateModes(t *testing.T) {
	stub := withStubHTTP(t, map[string]string{
		"api.example.com/custom/search": `[]`,
		"api.example.com/episodes":      `[]`,
		"api.example.com/list":          `[]`,
	})
	provider := newThirdPartyProvider("third_party_1", "第三方", ThirdPartyConfig{
		BaseURL: "https://api.example.com",
		Endpoints: ThirdPartyEndpoints{
			SearchURL: "https://api.example.com/custom/search/{keyword}",
			// 不含占位的端点 → 走查询串
			EpisodesURL: "https://api.example.com/list",
		},
	})

	// 模板含 {keyword} → 插进路径，不拼 ?keyword=
	if _, err := provider.Search(context.Background(), "abc"); err != nil {
		t.Fatalf("搜索失败: %v", err)
	}
	if got := stub.query["api.example.com/custom/search/abc"]; got != "" {
		t.Errorf("模板含占位时不该拼查询串，实际 query = %q", got)
	}

	// 不含占位 → 拼 ?id=
	if _, err := provider.Episodes(context.Background(), "abc"); err != nil {
		t.Fatalf("取分集失败: %v", err)
	}
	if got := stub.query["api.example.com/list"]; got != "id=abc" {
		t.Errorf("query = %q，期望 id=abc", got)
	}

	// 默认端点自带 {id}，直接插进路径
	if _, err := newThirdPartyProvider("third_party_2", "默认", ThirdPartyConfig{
		BaseURL: "https://api.example.com",
	}).Episodes(context.Background(), "abc"); err != nil {
		t.Fatalf("默认端点取分集失败: %v", err)
	}
	if got := stub.query["api.example.com/episodes/abc"]; got != "" {
		t.Errorf("默认端点 query = %q，期望空（id 在路径里）", got)
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

func TestServiceListAndGet(t *testing.T) {
	config := `{"rssSources":[{"id":"a","url":"https://x/rss"},{"id":"b","name":"自定名","url":"https://x/rss2"},{"id":"c"}],
		"thirdPartySources":[{"id":"p1","name":"三方一","baseUrl":"https://api"},{"name":"没 id"}]}`
	service := NewService(newTestSettings(t, config), nil)

	sources, err := service.List(context.Background())
	if err != nil {
		t.Fatalf("列出数据源失败: %v", err)
	}
	want := []SourceInfo{
		{ID: BilibiliSourceID, Name: "哔哩哔哩番剧"},
		{ID: "rss_a", Name: "RSS: a"},
		{ID: "rss_b", Name: "自定名"},
		{ID: "third_party_p1", Name: "三方一"},
	}
	if len(sources) != len(want) {
		t.Fatalf("数据源 = %+v，期望 %d 个（缺 url / 缺 id 的要跳过）", sources, len(want))
	}
	for i := range want {
		if sources[i] != want[i] {
			t.Errorf("第 %d 个 = %+v，期望 %+v", i, sources[i], want[i])
		}
	}

	if provider := service.Get(context.Background(), "rss_b"); provider == nil || provider.Name() != "自定名" {
		t.Errorf("按 id 取源失败: %+v", provider)
	}
	if provider := service.Get(context.Background(), "nope"); provider != nil {
		t.Errorf("未知 id 应返回 nil，得到 %+v", provider)
	}
}

func TestServiceEmptyConfig(t *testing.T) {
	service := NewService(newTestSettings(t, "null"), nil)
	sources, err := service.List(context.Background())
	if err != nil {
		t.Fatalf("列出数据源失败: %v", err)
	}
	if len(sources) != 1 || sources[0].ID != BilibiliSourceID {
		t.Errorf("空配置应只有内置 B站源，实际 %+v", sources)
	}
}

// ===========================================================================
// B站番剧源
// ===========================================================================

// biliSeasonBody 构造 pgc season 响应。
func biliSeasonBody() string {
	return `{"code":0,"message":"0","result":{
		"season_id":33378,
		"title":"孤独摇滚！",
		"cover":"//i0.hdslb.com/cover.jpg",
		"episodes":[
			{"bvid":"BV1a","cid":111,"aid":999,"title":"1","long_title":"转校生","title_format":"第1话"},
			{"bvid":"BV1b","cid":222,"title":"2"}
		]
	}}`
}

func newBiliProvider(t *testing.T, routes map[string]string) *bilibiliProvider {
	t.Helper()
	service := bilibili.NewService(nil)
	stub := &stubTransport{routes: routes}
	service.Client.SetTransport(stub)
	return newBilibiliProvider(service)
}

func TestBilibiliEpisodes(t *testing.T) {
	provider := newBiliProvider(t, map[string]string{
		"api.bilibili.com/pgc/view/web/season": biliSeasonBody(),
	})

	episodes, err := provider.Episodes(context.Background(), "ss33378")
	if err != nil {
		t.Fatalf("取分集失败: %v", err)
	}
	if len(episodes) != 2 {
		t.Fatalf("分集数 = %d", len(episodes))
	}
	if episodes[0].ID != "33378-111" {
		t.Errorf("id = %q", episodes[0].ID)
	}
	if episodes[0].Title != "孤独摇滚！ - 第1话 转校生" {
		t.Errorf("title = %q", episodes[0].Title)
	}
	if episodes[0].EpisodeNumber != 1 {
		t.Errorf("集号 = %d，期望解析 index 字符串", episodes[0].EpisodeNumber)
	}
	if episodes[0].PlaybackParams["cid"] != float64(111) {
		t.Errorf("播放参数 = %v", episodes[0].PlaybackParams)
	}
	if episodes[0].PlaybackParams["aid"] != float64(999) {
		t.Errorf("aid 应透传: %v", episodes[0].PlaybackParams)
	}
	// 第二条没有 title/index → 集号回落序号，且没有 aid 键。
	if episodes[1].EpisodeNumber != 2 {
		t.Errorf("第二条集号 = %d，期望 2", episodes[1].EpisodeNumber)
	}
	if _, exists := episodes[1].PlaybackParams["aid"]; exists {
		t.Errorf("aid 缺失时不该出现该键: %v", episodes[1].PlaybackParams)
	}
}

func TestBilibiliEpisodesNoSeasonID(t *testing.T) {
	provider := newBiliProvider(t, nil)
	if _, err := provider.Episodes(context.Background(), "孤独摇滚"); err == nil || err.Error() != "无法解析番剧 ID" {
		t.Errorf("错误 = %v", err)
	}
}

func TestBilibiliEpisodeFallback(t *testing.T) {
	provider := newBiliProvider(t, map[string]string{
		"api.bilibili.com/pgc/view/web/season": `{"code":0,"result":{"season_id":5,"title":"只有标题"}}`,
	})
	episodes, err := provider.Episodes(context.Background(), "5")
	if err != nil {
		t.Fatalf("取分集失败: %v", err)
	}
	if len(episodes) != 1 || episodes[0].ID != "5-1" || episodes[0].Title != "只有标题" {
		t.Errorf("无分集时应给整季占位，实际 %+v", episodes)
	}
}

func TestBilibiliSearchDirectSeason(t *testing.T) {
	provider := newBiliProvider(t, map[string]string{
		"api.bilibili.com/pgc/view/web/season": biliSeasonBody(),
	})
	results, err := provider.Search(context.Background(), "ss33378")
	if err != nil {
		t.Fatalf("搜索失败: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("结果数 = %d，期望直连 seasonId 命中 1 条", len(results))
	}
	if results[0].ID != "33378" || results[0].Title != "孤独摇滚！" {
		t.Errorf("结果 = %+v", results[0])
	}
	if results[0].Cover == nil || *results[0].Cover != "https://i0.hdslb.com/cover.jpg" {
		t.Errorf("封面 = %v，期望补齐 https:", results[0].Cover)
	}
	if results[0].Description != nil {
		t.Error("直连分支不该有 description 字段")
	}
}

func TestBilibiliPlaybackURL(t *testing.T) {
	provider := newBiliProvider(t, nil)
	result, err := provider.PlaybackURL(context.Background(), Episode{
		PlaybackParams: map[string]any{"bvid": "BV1a", "cid": float64(111)},
	})
	if err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	want := "/api/stream/resolve-bilibili?url=" + url.QueryEscape("https://www.bilibili.com/video/BV1a")
	if result.URL != want {
		t.Errorf("url = %q，期望 %q", result.URL, want)
	}
	if result.Headers["Referer"] != "https://www.bilibili.com" {
		t.Errorf("headers = %v", result.Headers)
	}

	for _, params := range []map[string]any{
		{"cid": float64(1)},
		{"bvid": "BV1a"},
		{"bvid": "BV1a", "cid": float64(0)},
		{"bvid": float64(1), "cid": float64(1)},
	} {
		if _, err := provider.PlaybackURL(context.Background(), Episode{PlaybackParams: params}); err == nil {
			t.Errorf("参数 %v 应报错", params)
		}
	}
}

func TestBilibiliSeasonMissingResult(t *testing.T) {
	provider := newBiliProvider(t, map[string]string{
		"api.bilibili.com/pgc/view/web/season": `{"code":0,"message":"0","data":{}}`,
	})
	_, err := provider.Episodes(context.Background(), "5")
	if !errors.Is(err, bilibili.ErrBangumiInfo) {
		t.Errorf("错误 = %v，期望 ErrBangumiInfo", err)
	}
}
