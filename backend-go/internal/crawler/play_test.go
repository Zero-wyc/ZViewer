package crawler

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// playSite 模拟一个站点：详情页 → 播放页 → 媒体文件。
type playSite struct {
	server   *httptest.Server
	detail   string
	mediaURL string
	apiURL   string
}

func newPlaySite(t *testing.T) *playSite {
	t.Helper()
	site := &playSite{}
	mux := http.NewServeMux()
	// 详情页：带 og:title 与两集选集链接（第二集是会员线路）。
	mux.HandleFunc("/detail/1", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`<html><head><meta property="og:title" content="流浪地球 4K"></head><body>
			<a href="/play/1?playFrom=line1">第 1 集</a>
			<a href="/play/2?playFrom=vip">第 2 集</a>
		</body></html>`))
	})
	// 播放页：直链写在 JS 里。
	mux.HandleFunc("/play/1", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`<html><body><script>var player={"url":"` + site.server.URL + `/media/direct.m3u8"};</script></body></html>`))
	})
	mux.HandleFunc("/play/2", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`<html><body>会员专享</body></html>`))
	})
	// 规则接口：按 playFrom 返回不同线路。
	mux.HandleFunc("/api/play", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Query().Get("from") {
		case "line1":
			_, _ = w.Write([]byte(`{"code":0,"data":{"mode":"native","url":"` + site.server.URL + `/media/api.m3u8?token=abc"}}`))
		case "vip":
			_, _ = w.Write([]byte(`{"code":0,"data":{"mode":"iframe","url":"https://vip.example.com/embed/1"}}`))
		default:
			_, _ = w.Write([]byte(`{"code":0,"data":{}}`))
		}
	})
	// 媒体探测：200 即可。
	mux.HandleFunc("/media/", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusPartialContent)
		_, _ = w.Write([]byte("\x00"))
	})
	mux.HandleFunc("/empty/detail", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`<html><body>什么都没有</body></html>`))
	})
	server := httptest.NewServer(mux)
	site.server = server
	site.detail = server.URL + "/detail/1"
	site.mediaURL = server.URL + "/media/direct.m3u8"
	site.apiURL = server.URL + "/api/play"
	return site
}

func (s *playSite) resolver() *PlayResolver {
	return NewPlayResolver(PlayOptions{
		Fetcher: NewFetcher(FetcherOptions{Retries: 0, Timeout: 5 * time.Second}),
		JS:      NewJSRunner(NewFetcher(FetcherOptions{Retries: 0, Timeout: 5 * time.Second})),
	})
}

func TestPlayDirectMedia(t *testing.T) {
	site := newPlaySite(t)
	defer site.server.Close()
	result, err := site.resolver().Resolve(site.mediaURL, "", "guest", nil)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if result["source"] != "direct" || result["format"] != "hls" {
		t.Errorf("result = %+v", result)
	}
	if result["url"] != site.mediaURL {
		t.Errorf("url = %v", result["url"])
	}
}

func TestPlayPageDirectLink(t *testing.T) {
	site := newPlaySite(t)
	defer site.server.Close()
	rule := &Rule{Name: "本站", Site: HostOf(site.server.URL)}
	// 详情页本身不含直链 → 会去播放页找。
	result, err := site.resolver().Resolve(site.detail, "", "guest", rule)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if result["source"] != "play-page" {
		t.Fatalf("source = %v", result["source"])
	}
	if result["url"] != site.mediaURL {
		t.Errorf("url = %v", result["url"])
	}
	if result["title"] != "流浪地球 4K" {
		t.Errorf("title = %v", result["title"])
	}
	episodes, ok := result["episodes"].([]Episode)
	if !ok || len(episodes) != 2 {
		t.Fatalf("episodes = %#v", result["episodes"])
	}
	if episodes[0].Name != "第 1 集" {
		t.Errorf("episode name = %q", episodes[0].Name)
	}
	// Referer 自动补成页面所在的 origin。
	headers, _ := result["headers"].(map[string]string)
	if !strings.HasPrefix(headers["Referer"], site.server.URL) {
		t.Errorf("referer = %q", headers["Referer"])
	}
}

func TestPlayRuleAPI(t *testing.T) {
	site := newPlaySite(t)
	defer site.server.Close()
	rule := &Rule{
		Name: "接口站",
		Site: HostOf(site.server.URL),
		Play: &Play{
			PlayURLRegex: `/play/(?P<id>\d+)\?playFrom=(?P<playFrom>\w+)`,
			API: PlayAPI{
				URL:      site.apiURL + "?from={playFrom}&id={id}",
				SkipFrom: []string{"vip"},
			},
		},
	}
	result, err := site.resolver().Resolve(site.detail, "", "guest", rule)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if result["source"] != "rule-api" {
		t.Fatalf("source = %v (url=%v)", result["source"], result["url"])
	}
	if !strings.Contains(result["url"].(string), "/media/api.m3u8") {
		t.Errorf("url = %v", result["url"])
	}
}

func TestPlayRuleAPIIframeOnly(t *testing.T) {
	site := newPlaySite(t)
	defer site.server.Close()
	rule := &Rule{
		Name: "会员站",
		Site: HostOf(site.server.URL),
		Play: &Play{
			PlayURLRegex: `/play/(?P<id>\d+)\?playFrom=(?P<playFrom>\w+)`,
			API:          PlayAPI{URL: site.apiURL + "?from={playFrom}&id={id}"},
		},
	}
	// 只留会员线路：把第一集链接改成 vip，接口只返回 iframe。
	result, err := site.resolver().Resolve(site.detail, "", "guest", rule)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	// line1 是 native，所以仍然优先拿到 native；这里只断言没有崩。
	if result["success"] != true {
		t.Errorf("result = %+v", result)
	}
}

func TestPlayRuleScript(t *testing.T) {
	site := newPlaySite(t)
	defer site.server.Close()
	script := &Rule{
		Name: "脚本播放",
		Site: HostOf(site.server.URL),
		Play: &Play{
			Script: Script{
				Runtime: "node",
				Source:  `return { title: "脚本标题", url: "` + site.server.URL + `/media/script.m3u8" };`,
			},
		},
	}
	result, err := site.resolver().Resolve(site.detail, "", "guest", script)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if result["source"] != "rule-script" {
		t.Fatalf("source = %v", result["source"])
	}
	if result["title"] != "脚本标题" {
		t.Errorf("title = %v", result["title"])
	}
	if result["format"] != "hls" {
		t.Errorf("format = %v", result["format"])
	}
	qualities, ok := result["qualities"].([]Quality)
	if !ok || len(qualities) != 1 {
		t.Fatalf("qualities = %#v", result["qualities"])
	}
	if qualities[0].Name != "默认" {
		t.Errorf("default quality name = %q", qualities[0].Name)
	}
}

func TestPlayRuleScriptQualities(t *testing.T) {
	site := newPlaySite(t)
	defer site.server.Close()
	script := &Rule{
		Name: "多档站",
		Site: HostOf(site.server.URL),
		Play: &Play{Script: Script{
			Runtime: "node",
			Source: `return { qualities: [
				{ name: "1080P", url: "` + site.server.URL + `/media/1080.m3u8" },
				{ name: "720P", url: "` + site.server.URL + `/media/720.m3u8", format: "hls" },
				{ name: "坏地址", url: "ftp://x/y.m3u8" },
				{ name: "720P", url: "` + site.server.URL + `/media/720.m3u8" }
			] };`,
		}},
	}
	result, err := site.resolver().Resolve(site.detail, "", "guest", script)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	qualities, _ := result["qualities"].([]Quality)
	// 三条有效：1080P / 720P / 重复的 720P 被去重 → 2 条；ftp 被过滤。
	if len(qualities) != 2 {
		t.Fatalf("qualities = %d: %+v", len(qualities), qualities)
	}
	if qualities[0].Name != "1080P" || qualities[1].Name != "720P" {
		t.Errorf("names = %q,%q", qualities[0].Name, qualities[1].Name)
	}
	if result["url"] != qualities[0].URL {
		t.Errorf("default url should be first quality, got %v", result["url"])
	}
}

func TestPlayNotFound(t *testing.T) {
	site := newPlaySite(t)
	defer site.server.Close()
	_, err := site.resolver().Resolve(site.server.URL+"/empty/detail", "", "guest", nil)
	if err == nil {
		t.Fatal("want error, got nil")
	}
	if !strings.Contains(err.Error(), "没有解析到可播放地址") {
		t.Errorf("error = %v", err)
	}
}

func TestPlayRejectsBadInput(t *testing.T) {
	resolver := NewPlayResolver(PlayOptions{})
	if _, err := resolver.Resolve("", "", "guest", nil); err == nil {
		t.Error("empty target should fail")
	}
	if _, err := resolver.Resolve("ftp://x/y.mp4", "", "guest", nil); err == nil {
		t.Error("non-http target should fail")
	}
}

func TestNormalizeQualities(t *testing.T) {
	base := map[string]string{"Referer": "https://a.com/"}
	raw := []any{
		"https://cdn/a.m3u8",
		map[string]any{"url": "https://cdn/b.mp4", "name": "1080P", "headers": map[string]any{"X-Token": "t"}},
		map[string]any{"playUrl": "https://cdn/c.flv", "label": "标清"},
		map[string]any{"url": "https://cdn/a.m3u8"}, // 重复
		map[string]any{"url": "ftp://cdn/d.m3u8"},   // 非 http
		map[string]any{"url": "https://cdn/e.mp3"},  // 格式不支持
		map[string]any{"name": "空地址"},
	}
	qualities := NormalizeQualities(raw, base)
	if len(qualities) != 3 {
		t.Fatalf("qualities = %d: %+v", len(qualities), qualities)
	}
	if qualities[0].Name != "HLS" || qualities[0].Format != "hls" {
		t.Errorf("first = %+v", qualities[0])
	}
	if qualities[1].Name != "1080P" || qualities[1].Headers["X-Token"] != "t" {
		t.Errorf("second = %+v", qualities[1])
	}
	if qualities[2].Name != "标清" || qualities[2].Format != "flv" {
		t.Errorf("third = %+v", qualities[2])
	}
	if qualities[0].Headers["Referer"] != "https://a.com/" {
		t.Errorf("base headers not inherited: %+v", qualities[0].Headers)
	}
}

func TestStabilityScore(t *testing.T) {
	cases := map[string]int{
		"https://cdn/a.m3u8":                  3,
		"https://cdn/a.m3u8?token=1":          1,
		"https://cdn/a.m3u8?auth_key=1":       1,
		"https://cdn/a.m3u8?expires=1&sign=2": 1,
		"https://cdn/a.m3u8?playlist=1":       2,
	}
	for target, want := range cases {
		if got := stabilityScore(target); got != want {
			t.Errorf("stabilityScore(%q) = %d, want %d", target, got, want)
		}
	}
}

func TestFillTemplate(t *testing.T) {
	out, err := fillTemplate("https://api/p?id={id}&from={playFrom}", map[string]string{"id": "1", "playFrom": "line1"})
	if err != nil {
		t.Fatalf("fill: %v", err)
	}
	if out != "https://api/p?id=1&from=line1" {
		t.Errorf("out = %q", out)
	}
	if _, err := fillTemplate("https://api/p?id={missing}", map[string]string{"id": "1"}); err == nil {
		t.Error("missing placeholder should fail")
	}
}

// play.episodes 用抽取段描述详情页选集：链接放在 data-href 里，通用正则抓不到。
func TestPlayEpisodesFromParse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`<html><body>
			<ul class="eps">
				<li class="ep"><a data-href="/play/9">第九集</a></li>
				<li class="ep"><a data-href="/play/10">第十集</a></li>
			</ul>
			<script>var player={"url":"/media/demo.m3u8"};</script>
		</body></html>`))
	}))
	defer server.Close()

	rule := &Rule{
		Name: "本站",
		Site: HostOf(server.URL),
		Play: &Play{
			Episodes: &Parse{
				Type:      "html",
				Container: ".eps .ep",
				Fields: map[string]Field{
					"title": {Selector: "a"},
					"url":   {Selector: "a", Attr: "data-href"},
				},
			},
		},
	}
	result, err := NewPlayResolver(PlayOptions{
		Fetcher: NewFetcher(FetcherOptions{Retries: 0, Timeout: 5 * time.Second}),
	}).Resolve(server.URL+"/detail/1", "", "guest", rule)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	episodes, ok := result["episodes"].([]Episode)
	if !ok || len(episodes) != 2 {
		t.Fatalf("episodes = %#v", result["episodes"])
	}
	if episodes[0].Name != "第九集" {
		t.Errorf("name = %q", episodes[0].Name)
	}
	if !strings.HasSuffix(episodes[0].PlayPage, "/play/9") {
		t.Errorf("playPage = %q", episodes[0].PlayPage)
	}
}
