package anisubs

import (
	"context"
	"database/sql"
	"io"
	"net/http"
	"strings"
	"testing"

	_ "modernc.org/sqlite"

	"zviewer/backend/internal/store"
	"zviewer/backend/internal/webfetch"
)

// ===========================================================================
// 工具
// ===========================================================================

// stubTransport 按「host+path」路由返回固定文本。
type stubTransport struct {
	routes map[string]string
	query  map[string]string
}

func (s *stubTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	key := req.URL.Host + req.URL.Path
	if s.query != nil {
		s.query[key] = req.URL.RawQuery
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

// withStubHTTP 把 webfetch 的客户端换成假 transport。
func withStubHTTP(t *testing.T, routes map[string]string) *stubTransport {
	t.Helper()
	stub := &stubTransport{routes: routes, query: map[string]string{}}
	restore := webfetch.SetTransport(stub)
	t.Cleanup(restore)
	return stub
}

// ===========================================================================
// 纯函数（期望值全部来自 Node 侧同函数的实际输出）
// ===========================================================================

func TestExtractEpisodeNumber(t *testing.T) {
	cases := []struct {
		name    string
		title   string
		pattern string
		want    float64
	}{
		{name: "默认中文话", title: "第 3 话", want: 3},
		{name: "默认小数", title: "第 1.5 话", want: 1.5},
		{name: "默认不认 EP", title: "EP12", want: 0},
		{name: "命名分组", title: "第 3 集", pattern: `第\s*(?<ep>\d+)\s*集`, want: 3},
		{name: "分组不中走兜底", title: "12 话", pattern: `S(\d+)`, want: 12},
		{name: "全不中", title: "OVA", pattern: `第\s*(?<ep>\d+)\s*集`, want: 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := ExtractEpisodeNumber(c.title, c.pattern); got != c.want {
				t.Errorf("ExtractEpisodeNumber(%q, %q) = %v，期望 %v", c.title, c.pattern, got, c.want)
			}
		})
	}
}

func TestMatchChannelName(t *testing.T) {
	cases := []struct {
		name    string
		channel string
		pattern string
		want    bool
	}{
		{name: "无规则恒真", channel: "任意", pattern: "", want: true},
		{name: "命名分组", channel: "线路1", pattern: `^(?<ch>线路.+?)(\d+)?$`, want: true},
		{name: "命名分组不中", channel: "预告", pattern: `^(?<ch>线路.+?)(\d+)?$`, want: false},
		// `(?!...)` 开头：命中 inner 就排除，不命中再看 rest。
		{name: "负向断言排除", channel: "线路1", pattern: `(?!线路).+`, want: false},
		{name: "负向断言放行", channel: "预告", pattern: `(?!线路).+`, want: true},
		{name: "负向断言带 rest 不中", channel: "预告", pattern: `(?!线路)正片`, want: false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := MatchChannelName(c.channel, c.pattern); got != c.want {
				t.Errorf("MatchChannelName(%q, %q) = %v，期望 %v", c.channel, c.pattern, got, c.want)
			}
		})
	}
}

func TestDetectMediaFormat(t *testing.T) {
	cases := map[string]MediaFormat{
		"https://x/a.m3u8?t=1":  FormatHLS,
		"https://x/a.flv":       FormatFLV,
		"https://x/a.MP4":       FormatMP4,
		"https://x/a.mp4/index": FormatMP4,
		"https://x/a.mkv":       FormatUnknown,
		"":                      FormatUnknown,
	}
	for input, want := range cases {
		if got := DetectMediaFormat(input); got != want {
			t.Errorf("DetectMediaFormat(%q) = %q，期望 %q", input, got, want)
		}
	}
}

func TestToAbsoluteURL(t *testing.T) {
	cases := []struct{ in, base, want string }{
		{"/s/1", "https://a.com/search?q=x", "https://a.com/s/1"},
		{"s/1", "https://a.com/x/y", "https://a.com/x/s/1"},
		{"https://b.com/z", "https://a.com/", "https://b.com/z"},
		{"", "https://a.com/", ""},
	}
	for _, c := range cases {
		if got := ToAbsoluteURL(c.in, c.base); got != c.want {
			t.Errorf("ToAbsoluteURL(%q, %q) = %q，期望 %q", c.in, c.base, got, c.want)
		}
	}
}

func TestImageURL(t *testing.T) {
	if got := ImageURL("//cdn/x.png", "https://a.com/b"); got == nil || *got != "https://cdn/x.png" {
		t.Errorf("协议相对地址 = %v，期望补成 https", got)
	}
	if got := ImageURL("  ", "https://a.com/"); got != nil {
		t.Errorf("空白应返回 nil，得到 %v", got)
	}
	if got := ImageURL("data:image/png;base64,x", "https://a.com/"); got != nil {
		t.Errorf("data URL 应返回 nil，得到 %v", got)
	}
}

func TestSelectJSONPath(t *testing.T) {
	document := map[string]any{
		"data": map[string]any{
			"videos": []any{
				map[string]any{"slug": "a", "name": "A"},
				map[string]any{"slug": "b", "name": "B"},
			},
		},
	}
	values, err := SelectJSONPath(document, "$.data.videos[*].slug")
	if err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	if len(values) != 2 || values[0] != "a" || values[1] != "b" {
		t.Errorf("结果 = %v", values)
	}

	list := []any{map[string]any{"url": "u1", "link": "l1"}, map[string]any{"url": "u2"}}
	values, err = SelectJSONPath(list, "$[*]['url', 'link']")
	if err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	want := []any{"u1", "l1", "u2", nil}
	if len(values) != len(want) {
		t.Fatalf("结果 = %v", values)
	}
	for i := range want {
		if values[i] != want[i] {
			t.Errorf("第 %d 项 = %v，期望 %v", i, values[i], want[i])
		}
	}

	if _, err := SelectJSONPath(document, "data.videos"); err == nil {
		t.Error("不以 $ 开头的表达式应报错")
	}
}

// ===========================================================================
// 搜索结果页
// ===========================================================================

const searchHTML = `<html><body>
<div class="item"><a href="/s/1"><img data-src="//cdn.example.com/1.jpg"></a><h3>番剧一</h3></div>
<div class="item"><a href="/s/2">番剧二</a></div>
</body></html>`

func TestParseSearchResultsA(t *testing.T) {
	config := &SearchConfig{
		SubjectFormatID:        "a",
		SelectorSubjectFormatA: &SubjectFormatA{SelectLists: "div.item > a"},
	}
	results, err := ParseSearchResults(searchHTML, config, "https://a.example.com/search?q=x")
	if err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	// 第一个 <a> 只有图片、没有文本也没 title/alt → 标题为空，按 Node 语义丢弃。
	if len(results) != 1 {
		t.Fatalf("结果 = %+v，期望只剩 1 条", results)
	}
	if results[0].Title != "番剧二" || results[0].URL != "https://a.example.com/s/2" {
		t.Errorf("结果 = %+v", results[0])
	}
	if results[0].Cover != nil {
		t.Errorf("第二条没有图，cover 应为 nil，得到 %v", *results[0].Cover)
	}
}

func TestParseSearchResultsACover(t *testing.T) {
	html := `<div class="item"><a href="/s/1">番剧一</a><img src="https://cdn.example.com/1.jpg"></div>`
	config := &SearchConfig{
		SubjectFormatID:        "a",
		SelectorSubjectFormatA: &SubjectFormatA{SelectLists: "div.item > a"},
	}
	results, err := ParseSearchResults(html, config, "https://a.example.com/search")
	if err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	if len(results) != 1 || results[0].Cover == nil || *results[0].Cover != "https://cdn.example.com/1.jpg" {
		t.Fatalf("结果 = %+v，期望从兄弟节点借到封面", results)
	}
}

func TestParseSearchResultsKeepsNeighbourPoster(t *testing.T) {
	// 列表容器里挤着两部番时，不能把隔壁的封面借过来。
	html := `<div class="list">
  <div class="item"><a href="/s/1">番剧一</a><img src="https://cdn.example.com/1.jpg"></div>
  <div class="item"><a href="/s/2">番剧二</a></div>
</div>`
	config := &SearchConfig{
		SubjectFormatID:        "a",
		SelectorSubjectFormatA: &SubjectFormatA{SelectLists: "div.item > a"},
	}
	results, err := ParseSearchResults(html, config, "https://a.example.com/search")
	if err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	if len(results) != 2 {
		t.Fatalf("结果 = %+v", results)
	}
	if results[1].Cover != nil {
		t.Errorf("第二条不该借到第一条的封面，得到 %v", *results[1].Cover)
	}
}

func TestParseSearchResultsIndexed(t *testing.T) {
	html := `<a class="n">番剧一</a><a class="n">番剧二</a><i class="l" data-href="x"></i>
<ul><li><a class="l" href="/s/1"></a></li><li><a class="l" href="/s/2"></a></li></ul>`
	config := &SearchConfig{
		SubjectFormatID:              "indexed",
		SelectorSubjectFormatIndexed: &SubjectFormatIndexed{SelectNames: "a.n", SelectLinks: "a.l"},
	}
	results, err := ParseSearchResults(html, config, "https://a.example.com/search")
	if err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	if len(results) != 2 || results[0].Title != "番剧一" || results[1].URL != "https://a.example.com/s/2" {
		t.Errorf("结果 = %+v", results)
	}
}

func TestParseSearchResultsJSONPath(t *testing.T) {
	body := `{"data":{"videos":[{"slug":"a","name":"A","pic":"/p/a.jpg"},{"slug":"b","name":"B"}]}}`
	config := &SearchConfig{
		SubjectFormatID: "json-path-indexed",
		SelectorSubjectFormatJSONPathIndexed: &SubjectFormatJSONPathIndexed{
			SelectNames:  "$.data.videos[*].name",
			SelectLinks:  "$.data.videos[*].slug",
			SelectCovers: "$.data.videos[*].pic",
		},
	}
	results, err := ParseSearchResults(body, config, "https://a.example.com/search")
	if err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	if len(results) != 2 {
		t.Fatalf("结果 = %+v", results)
	}
	// 链接是相对地址，按 searchUrl（而不是 rawBaseUrl，这里没配）补全。
	if results[0].URL != "https://a.example.com/a" {
		t.Errorf("链接 = %q，期望按 searchUrl 解析成 https://a.example.com/a", results[0].URL)
	}
	if results[0].Cover == nil || *results[0].Cover != "https://a.example.com/p/a.jpg" {
		t.Errorf("封面 = %v", results[0].Cover)
	}
	if results[1].Cover != nil {
		t.Errorf("第二条没给图，封面应为 nil")
	}
}

func TestParseSearchResultsUnsupportedFormat(t *testing.T) {
	_, err := ParseSearchResults("<html></html>", &SearchConfig{SubjectFormatID: "wat"}, "https://a.com/")
	if err == nil || err.Error() != "不支持的搜索结果格式: wat" {
		t.Errorf("错误 = %v", err)
	}
}

// ===========================================================================
// 详情页
// ===========================================================================

func TestParseEpisodesNoChannel(t *testing.T) {
	html := `<div class="ep"><a href="/p/1">第 1 集</a><a href="/p/2">第 2 集</a><a href="/p/3">OVA</a></div>`
	config := &SearchConfig{
		ChannelFormatID: "no-channel",
		SelectorChannelFormatNoChannel: &ChannelFormatNoChannel{
			SelectEpisodes:           ".ep a",
			MatchEpisodeSortFromName: `第\s*(?<ep>\d+)\s*集`,
		},
	}
	episodes, err := ParseEpisodes(html, config, "https://a.example.com/subject/1")
	if err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	if len(episodes) != 3 {
		t.Fatalf("集数 = %d", len(episodes))
	}
	if episodes[0].ID != "第 1 集-1" || episodes[0].EpisodeNumber != 1 {
		t.Errorf("第一集 = %+v", episodes[0])
	}
	if episodes[2].ID != "OVA-0" {
		t.Errorf("没抠到集号时应写 0（前端按 1 兜底），实际 %q", episodes[2].ID)
	}
	if episodes[0].URL != "https://a.example.com/p/1" {
		t.Errorf("URL = %q，期望按 origin 补全", episodes[0].URL)
	}
}

func TestParseEpisodesIndexGrouped(t *testing.T) {
	html := `<div class="tabs"><a class="ch">线路1</a><a class="ch">预告</a></div>
<div class="list"><a href="/p/1-1">第 1 集</a></div>
<div class="list"><a href="/p/2-1">第 1 集</a></div>`
	config := &SearchConfig{
		ChannelFormatID: "index-grouped",
		SelectorChannelFormatFlattened: &ChannelFormatFlattened{
			SelectChannelNames:       "a.ch",
			MatchChannelName:         `^(?<ch>线路.+?)(\d+)?$`,
			SelectEpisodeLists:       "div.list",
			SelectEpisodesFromList:   "a",
			MatchEpisodeSortFromName: `第\s*(?<ep>\d+)\s*集`,
		},
	}
	episodes, err := ParseEpisodes(html, config, "https://a.example.com/subject/1")
	if err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	// 「预告」被 matchChannelName 过滤掉，只剩一条。
	if len(episodes) != 1 {
		t.Fatalf("集数 = %d：%+v", len(episodes), episodes)
	}
	if episodes[0].ID != "线路1-第 1 集-1" || episodes[0].Title != "[线路1] 第 1 集" {
		t.Errorf("集 = %+v", episodes[0])
	}
}

// ===========================================================================
// 播放地址
// ===========================================================================

func TestFindVideoURL(t *testing.T) {
	// 规则来自真实订阅：带 (?!...) 负向先行断言，RE2 编不出来，必须靠 regexp2。
	config := &MatchVideo{
		MatchVideoURL: `(^http(s)?:\/\/(?!.*http).+\.(mp4|m3u8|flv))|(url=(?<v>http(s)?:\/\/.+\.(mp4|m3u8|flv)))`,
	}
	html := `<script>var x = "url=https://cdn.example.com/a.m3u8&amp;t=1";</script>`
	match := findVideoURL(html, config, "https://a.example.com/play/1")
	if match == nil {
		t.Fatal("应匹配到播放地址")
	}
	// 贪婪匹配到扩展名就停（JS 侧同样如此），查询串不在捕获范围里。
	if match.URL != "https://cdn.example.com/a.m3u8" {
		t.Errorf("URL = %q，期望剥掉 url= 前缀", match.URL)
	}
	if match.Headers["Referer"] != "https://a.example.com/play/1" {
		t.Errorf("未配 referer 时应回落页面地址，实际 %q", match.Headers["Referer"])
	}
	if match.Format != FormatHLS {
		t.Errorf("格式 = %q", match.Format)
	}

	if got := findVideoURL("<html>nothing</html>", config, "https://a.example.com/"); got != nil {
		t.Errorf("无匹配应返回 nil，得到 %+v", got)
	}
}

func TestFindVideoURLDecodesEntities(t *testing.T) {
	// 捕获组吃到查询串时，&amp; 必须还原（HTML 里 & 总是被转义）。
	config := &MatchVideo{MatchVideoURL: `url=(?<v>https://cdn\.example\.com/[^"']+)`}
	match := findVideoURL(`<script>u = "url=https://cdn.example.com/a.m3u8&amp;t=1"</script>`, config, "https://a.example.com/play/1")
	if match == nil {
		t.Fatal("应匹配到播放地址")
	}
	if match.URL != "https://cdn.example.com/a.m3u8&t=1" {
		t.Errorf("URL = %q，期望还原 &amp;", match.URL)
	}
}

func TestFindVideoURLHeaders(t *testing.T) {
	config := &MatchVideo{MatchVideoURL: `(?<v>https://cdn/.+\.mp4)`}
	empty := ""
	config.AddHeadersToVideo = &struct {
		Referer   *string `json:"referer"`
		UserAgent string  `json:"userAgent"`
		Origin    string  `json:"origin"`
	}{Referer: &empty, UserAgent: "UA/1", Origin: "https://up.example"}

	match := findVideoURL(`<a href="https://cdn/v.mp4">`, config, "https://a.example.com/play/1")
	if match == nil {
		t.Fatal("应匹配到播放地址")
	}
	if _, exists := match.Headers["Referer"]; exists {
		t.Errorf("referer 显式配空串时不该下发 Referer，实际 %v", match.Headers)
	}
	if match.Headers["User-Agent"] != "UA/1" || match.Headers["Origin"] != "https://up.example" {
		t.Errorf("headers = %v", match.Headers)
	}
}

// ===========================================================================
// provider 全链路（假站点）
// ===========================================================================

func TestWebSelectorProviderFlow(t *testing.T) {
	stub := withStubHTTP(t, map[string]string{
		"a.example.com/search": searchHTML,
		"a.example.com/s/2":    `<div class="ep"><a href="/p/1">第 1 集</a></div>`,
		"a.example.com/p/1":    `<script>const u="https://cdn.example.com/1.m3u8";</script>`,
	})
	config := &SearchConfig{
		SearchURL:              "https://a.example.com/search?wd={keyword}&x=1",
		SearchRemoveSpecial:    true,
		SubjectFormatID:        "a",
		SelectorSubjectFormatA: &SubjectFormatA{SelectLists: "div.item > a"},
		ChannelFormatID:        "no-channel",
		SelectorChannelFormatNoChannel: &ChannelFormatNoChannel{
			SelectEpisodes:           ".ep a",
			MatchEpisodeSortFromName: `第\s*(?<ep>\d+)\s*集`,
		},
		MatchVideo: &MatchVideo{MatchVideoURL: `(?<v>https://cdn\.example\.com/[^"]+\.m3u8)`},
	}
	provider := NewWebSelectorProvider("ani_subs_web-selector_0", "假站", config)

	results, err := provider.Search(context.Background(), "番剧！二")
	if err != nil {
		t.Fatalf("搜索失败: %v", err)
	}
	if len(results) != 1 || results[0].ID != "https://a.example.com/s/2" {
		t.Fatalf("结果 = %+v", results)
	}
	if got := stub.query["a.example.com/search"]; !strings.Contains(got, "wd=%E7%95%AA%E5%89%A7%20%E4%BA%8C") {
		t.Errorf("搜索词应剥特殊字符并编码，实际 query = %q", got)
	}

	episodes, err := provider.Episodes(context.Background(), "https://a.example.com/s/2")
	if err != nil {
		t.Fatalf("取分集失败: %v", err)
	}
	if len(episodes) != 1 || episodes[0].PlaybackParams["episodeUrl"] != "https://a.example.com/p/1" {
		t.Fatalf("分集 = %+v", episodes)
	}

	playback, err := provider.PlaybackURL(context.Background(), episodes[0])
	if err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	if playback.URL != "https://cdn.example.com/1.m3u8" || playback.Format != "hls" {
		t.Errorf("播放地址 = %+v", playback)
	}

	// 缺 episodeUrl / 缺 matchVideo 都要有自己的文案。
	if _, err := provider.PlaybackURL(context.Background(), Episode{}); err == nil || err.Error() != "缺少剧集页面地址" {
		t.Errorf("错误 = %v", err)
	}
	noMatch := NewWebSelectorProvider("x", "x", &SearchConfig{SearchURL: "https://a.example.com/search"})
	if _, err := noMatch.PlaybackURL(context.Background(), Episode{
		PlaybackParams: map[string]any{"episodeUrl": "https://a.example.com/p/1"},
	}); err == nil || err.Error() != "数据源未配置视频匹配规则" {
		t.Errorf("错误 = %v", err)
	}
}

func TestWebSelectorProviderEmptyKeyword(t *testing.T) {
	provider := NewWebSelectorProvider("x", "x", &SearchConfig{
		SearchURL:           "https://a.example.com/search?wd={keyword}",
		SearchRemoveSpecial: true,
	})
	results, err := provider.Search(context.Background(), "！@@#")
	if err != nil {
		t.Fatalf("搜索失败: %v", err)
	}
	if len(results) != 0 {
		t.Errorf("剥完特殊字符为空时不该发请求，得到 %+v", results)
	}
}

// ===========================================================================
// RSS provider
// ===========================================================================

const rssXML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <item>
    <title><![CDATA[<b>孤独摇滚</b> 第1话]]></title>
    <link>https://example.com/ep/1</link>
    <description><![CDATA[<p>波奇酱 &amp; 朋友们</p>]]></description>
    <enclosure url="https://cdn.example.com/1.mp4"/>
  </item>
  <item>
    <title>只有附件</title>
    <enclosure url="https://cdn.example.com/2.mp4"/>
  </item>
</channel></rss>`

func TestRSSProviderFlow(t *testing.T) {
	withStubHTTP(t, map[string]string{
		"feeds.example.com/rss": rssXML,
		"feeds.example.com/q":   rssXML,
	})
	provider := NewRSSProvider("ani_subs_rss_0", "订阅源", "https://feeds.example.com/rss")

	results, err := provider.Search(context.Background(), "孤独")
	if err != nil {
		t.Fatalf("搜索失败: %v", err)
	}
	if len(results) != 1 || results[0].Title != "孤独摇滚 第1话" {
		t.Fatalf("结果 = %+v", results)
	}
	if results[0].Description == nil || *results[0].Description != "波奇酱 & 朋友们" {
		t.Errorf("描述 = %v", results[0].Description)
	}

	episodes, err := provider.Episodes(context.Background(), "https://example.com/ep/1")
	if err != nil {
		t.Fatalf("取分集失败: %v", err)
	}
	if len(episodes) != 1 || episodes[0].PlaybackParams["url"] != "https://cdn.example.com/1.mp4" {
		t.Fatalf("分集 = %+v", episodes)
	}
	if episodes[0].PlaybackParams["title"] != nil {
		t.Error("anisubs 的 RSS 分集只带 url，不该有 title 参数")
	}

	playback, err := provider.PlaybackURL(context.Background(), episodes[0])
	if err != nil || playback.URL != "https://cdn.example.com/1.mp4" {
		t.Errorf("播放地址 = %+v / %v", playback, err)
	}

	if _, err := provider.Episodes(context.Background(), "https://example.com/none"); err == nil {
		t.Error("找不到条目应报错")
	}
	if _, err := provider.PlaybackURL(context.Background(), Episode{PlaybackParams: map[string]any{}}); err == nil {
		t.Error("缺 url 应报错")
	}
}

func TestRSSProviderKeywordPlaceholder(t *testing.T) {
	stub := withStubHTTP(t, map[string]string{"feeds.example.com/q": rssXML})
	provider := NewRSSProvider("ani_subs_rss_0", "订阅源", "https://feeds.example.com/q?k={keyword}")

	if _, err := provider.Search(context.Background(), "孤独 摇滚"); err != nil {
		t.Fatalf("搜索失败: %v", err)
	}
	if got := stub.query["feeds.example.com/q"]; got != "k=%E5%AD%A4%E7%8B%AC%20%E6%91%87%E6%BB%9A" {
		t.Errorf("query = %q，期望 %%20 而不是 +", got)
	}
}

func TestRSSCloudflareBlocked(t *testing.T) {
	// 403 + server: cloudflare → 专用文案（而不是「请求失败」）。
	restore := webfetch.SetTransport(roundTripFunc(func(req *http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusForbidden,
			Body:       io.NopCloser(strings.NewReader("blocked")),
			Header:     http.Header{"Server": []string{"cloudflare"}},
			Request:    req,
		}, nil
	}))
	t.Cleanup(restore)

	provider := NewRSSProvider("x", "x", "https://feeds.example.com/rss")
	_, err := provider.Search(context.Background(), "x")
	if err == nil || !strings.Contains(err.Error(), "该数据源被 Cloudflare 防护拦截 [403]") {
		t.Errorf("错误 = %v", err)
	}
}

// roundTripFunc 让 http.RoundTripper 可以写成函数。
type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) { return f(req) }

// ===========================================================================
// 订阅与注册表
// ===========================================================================

func TestDecodeSubscriptionToleratesBOM(t *testing.T) {
	subscription, err := decodeSubscription("\uFEFF" + `{"exportedMediaSourceDataList":{"mediaSources":[{"factoryId":"rss","arguments":{"name":"A"}}]}}`)
	if err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	if subscription.ExportedMediaSourceDataList == nil || len(subscription.ExportedMediaSourceDataList.MediaSources) != 1 {
		t.Errorf("结果 = %+v", subscription)
	}
}

func TestEmbeddedSubscriptions(t *testing.T) {
	css1, err := decodeSubscription(string(defaultCSS1))
	if err != nil {
		t.Fatalf("内置 css1 解析失败: %v", err)
	}
	if got := len(css1.ExportedMediaSourceDataList.MediaSources); got != 19 {
		t.Errorf("内置 css1 源数 = %d，期望 19", got)
	}
	bt1, err := decodeSubscription(string(defaultBT1))
	if err != nil {
		t.Fatalf("内置 bt1 解析失败: %v", err)
	}
	if got := len(bt1.ExportedMediaSourceDataList.MediaSources); got != 2 {
		t.Errorf("内置 bt1 源数 = %d，期望 2", got)
	}
}

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
	subscription := `{"exportedMediaSourceDataList":{"mediaSources":[
		{"factoryId":"web-selector","arguments":{"name":"假站","searchConfig":{"searchUrl":"https://a.example.com/search?wd={keyword}"}}},
		{"factoryId":"rss","arguments":{"name":"假订阅","searchConfig":{"searchUrl":"https://feeds.example.com/rss"}}},
		{"factoryId":"rss","arguments":{"name":"没地址的"}},
		{"factoryId":"unknown","arguments":{"name":"不支持的"}}
	]}}`
	withStubHTTP(t, map[string]string{"subs.example.com/sub.json": subscription})

	service := NewService(newTestSettings(t, `{"aniSubsSubscriptions":["https://subs.example.com/sub.json"]}`))
	sources := service.List(context.Background())
	want := []SourceInfo{
		{ID: "ani_subs_web-selector_0", Name: "假站"},
		{ID: "ani_subs_rss_1", Name: "假订阅"},
	}
	if len(sources) != len(want) {
		t.Fatalf("数据源 = %+v，期望 %d 个", sources, len(want))
	}
	for i := range want {
		if sources[i] != want[i] {
			t.Errorf("第 %d 个 = %+v，期望 %+v", i, sources[i], want[i])
		}
	}

	if provider := service.Get(context.Background(), "ani_subs_rss_1"); provider == nil || provider.Name() != "假订阅" {
		t.Errorf("按 id 取源失败: %+v", provider)
	}
	if provider := service.Get(context.Background(), "nope"); provider != nil {
		t.Errorf("未知 id 应返回 nil，得到 %+v", provider)
	}
}

func TestServiceFallsBackToDefaults(t *testing.T) {
	// 配置了空数组 = 用默认订阅（Node 的 `length > 0` 判断）。
	// 上游全失败时走内嵌副本，所以仍然能列出源站。
	withStubHTTP(t, map[string]string{})
	service := NewService(newTestSettings(t, `{"aniSubsSubscriptions":[]}`))

	sources := service.List(context.Background())
	if len(sources) == 0 {
		t.Fatal("内置订阅副本存在，不该一个源都没有")
	}
	found := false
	for _, source := range sources {
		if source.Name == "TvTFun" {
			found = true
		}
	}
	if !found {
		t.Errorf("默认订阅里应包含 TvTFun，实际 %+v", sources)
	}
}

func TestDefaultSourceOverride(t *testing.T) {
	source := MediaSource{FactoryID: "web-selector"}
	source.Arguments.Name = "TvTFun"
	source.Arguments.SearchConfig = &SearchConfig{
		SearchURL:       "https://www.tvtfun.net/api/videos/search?q={keyword}",
		SubjectFormatID: "json-path-indexed",
	}

	// bt1 订阅的条目是 torrent/magnet，整个丢弃。
	if got := DefaultSourceOverride("https://sub.creamycake.org/v1/bt1.json?x=1", source); got != nil {
		t.Errorf("bt1 应返回 nil，得到 %+v", got)
	}

	// 自定义订阅不做任何过滤。
	if got := DefaultSourceOverride("https://custom.example.com/sub.json", source); got == nil {
		t.Error("自定义订阅不该被丢弃")
	}

	// 默认订阅里的已知不可用源要丢弃。
	dead := source
	dead.Arguments.Name = "稀饭动漫"
	if got := DefaultSourceOverride("https://sub.creamycake.org/v1/css1.json", dead); got != nil {
		t.Errorf("已知不可用源应丢弃，得到 %+v", got)
	}

	// TvTFun 要补封面选择器并切到 no-channel。
	patched := DefaultSourceOverride("https://sub.creamycake.org/v1/css1.json", source)
	if patched == nil {
		t.Fatal("TvTFun 应保留")
	}
	config := patched.Arguments.SearchConfig
	if config.ChannelFormatID != "no-channel" || config.SelectorChannelFormatNoChannel == nil {
		t.Errorf("频道格式 = %q / %+v", config.ChannelFormatID, config.SelectorChannelFormatNoChannel)
	}
	if config.SelectorSubjectFormatJSONPathIndexed == nil ||
		config.SelectorSubjectFormatJSONPathIndexed.SelectCovers != "$.data.videos[*].pic" {
		t.Errorf("封面选择器未补齐: %+v", config.SelectorSubjectFormatJSONPathIndexed)
	}
	// 原对象不能被就地改动。
	if source.Arguments.SearchConfig.ChannelFormatID != "json-path-indexed" &&
		source.Arguments.SearchConfig.ChannelFormatID != "" {
		t.Error("不应就地修改原始订阅对象")
	}
}
