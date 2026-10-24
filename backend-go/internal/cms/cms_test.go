package cms

import (
	"context"
	"database/sql"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	_ "modernc.org/sqlite"

	"zviewer/backend/internal/store"
)

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

// newTestSettings 建一个只有 settings 行的内存库。
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

// TestIsCMSAPI 覆盖采集接口识别（TVBox 里混着各种 type，先按地址筛一遍）。
func TestIsCMSAPI(t *testing.T) {
	cases := map[string]bool{
		"https://a.com/api.php/provide/vod":              true,
		"https://a.com/api.php/provide/vod/from/dbm3u8/": true,
		"https://a.com/provide/vod/at/json":              true,
		"https://a.com/api.php":                          true,
		"http://a.com/api.php/provide/vod":               true,
		"ftp://a.com/api.php/provide/vod":                false,
		"https://a.com/other":                            false,
		"":                                               false,
		"https://a.com/vod":                              false,
	}
	for input, want := range cases {
		if got := IsCMSAPI(input); got != want {
			t.Errorf("IsCMSAPI(%q) = %v，期望 %v", input, got, want)
		}
	}
}

// TestExtractSite 覆盖 type 判定与字段清洗。
func TestExtractSite(t *testing.T) {
	base := func() map[string]any {
		return map[string]any{
			"key":  " siteA ",
			"name": " 站点A ",
			"type": float64(1),
			"api":  "https://a.com/api.php/provide/vod",
		}
	}

	site, ok := ExtractSite(base())
	if !ok {
		t.Fatal("合法站点被判为无效")
	}
	if site.Key != "siteA" || site.Name != "站点A" || !site.Searchable {
		t.Errorf("站点字段错误: %+v", site)
	}

	// type 为字符串 "1" 时 JS 的 `!== 1` 成立 → 过滤。
	entry := base()
	entry["type"] = "1"
	if _, ok := ExtractSite(entry); ok {
		t.Error("type 为字符串时应被过滤")
	}

	// searchable: 0 → false；缺省 → true。
	entry = base()
	entry["searchable"] = float64(0)
	if site, ok := ExtractSite(entry); !ok || site.Searchable {
		t.Errorf("searchable=0 应得到 false，实际 %+v", site)
	}

	entry = base()
	entry["api"] = "https://a.com/other"
	if _, ok := ExtractSite(entry); ok {
		t.Error("非 CMS api 应被过滤")
	}
	entry = base()
	delete(entry, "name")
	if _, ok := ExtractSite(entry); ok {
		t.Error("缺 name 应被过滤")
	}
}

// TestParsePlayGroups 覆盖 vod_play_url 的 $$$ / # 语义。
func TestParsePlayGroups(t *testing.T) {
	rawURL := "第1集$https://cdn/a1.m3u8#第2集$https://cdn/a2.m3u8$$$正片$https://cdn/b1.mp4#花絮$https://cdn/b2.mp4"
	rawFrom := "线路一$$$线路二"
	groups := parsePlayGroups(rawURL, rawFrom, "42")

	if len(groups) != 2 {
		t.Fatalf("播放组数 = %d，期望 2", len(groups))
	}
	if groups[0].Name != "线路一" || len(groups[0].Episodes) != 2 {
		t.Errorf("第一组错误: %+v", groups[0])
	}
	if groups[0].Episodes[1].Title != "第2集" {
		t.Errorf("集标题 = %q", groups[0].Episodes[1].Title)
	}
	if groups[0].Episodes[1].PlaybackParams != (PlaybackParams{VodID: "42", PlayFromIndex: 0, EpisodeIndex: 1}) {
		t.Errorf("playbackParams 错误: %+v", groups[0].Episodes[1].PlaybackParams)
	}
	if groups[1].Episodes[0].PlaybackParams.PlayFromIndex != 1 {
		t.Errorf("第二组的 playFromIndex = %d，期望 1", groups[1].Episodes[0].PlaybackParams.PlayFromIndex)
	}

	// 无组名 → 播放源N；无 '$' 的条目被丢弃；空组被跳过。
	groups = parsePlayGroups("第1集$https://cdn/a1.mp4#没有地址$$$$$$第3集$https://cdn/a3.mp4", "", "7")
	if len(groups) != 2 {
		t.Fatalf("播放组数 = %d，期望 2（空组应跳过）", len(groups))
	}
	if groups[0].Name != "播放源1" || groups[1].Name != "播放源3" {
		t.Errorf("组名回落错误: %q / %q", groups[0].Name, groups[1].Name)
	}
	if len(groups[0].Episodes) != 1 {
		t.Errorf("没有地址的条目应被丢弃，实际 %d 集", len(groups[0].Episodes))
	}
	if groups[1].Episodes[0].PlaybackParams.PlayFromIndex != 2 {
		t.Errorf("组序号必须保留原始 $$$ 下标，实际 %d", groups[1].Episodes[0].PlaybackParams.PlayFromIndex)
	}
}

// TestDetectMediaFormat 覆盖带 query/fragment 的地址嗅探。
func TestDetectMediaFormat(t *testing.T) {
	cases := map[string]MediaFormat{
		"https://x/a.m3u8":             FormatHLS,
		"https://x/a.M3U8?sign=1":      FormatHLS,
		"https://x/a.flv#t=1":          FormatFLV,
		"https://x/a.mp4?e=2":          FormatMP4,
		"https://x/a.mkv":              FormatMP4,
		"https://x/a.ts":               FormatUnknown,
		"https://x/play?id=1&f=a.m3u8": FormatUnknown,
	}
	for input, want := range cases {
		if got := DetectMediaFormat(input); got != want {
			t.Errorf("DetectMediaFormat(%q) = %q，期望 %q", input, got, want)
		}
	}
}

// TestDecodeBody 覆盖 UTF-8 / GBK 嗅探。
func TestDecodeBody(t *testing.T) {
	utf8Body := []byte("站点：测试")
	if got := decodeBody(utf8Body, "application/json"); got != string(utf8Body) {
		t.Errorf("UTF-8 被改坏了: %q", got)
	}

	// "中文" 的 GBK 编码：D6 D0 CE C4
	gbk := []byte{0xD6, 0xD0, 0xCE, 0xC4}
	if got := decodeBody(gbk, "application/json"); got != "中文" {
		t.Errorf("GBK 嗅探失败: %q", got)
	}
	if got := decodeBody(gbk, "text/html; charset=gbk"); got != "中文" {
		t.Errorf("按声明 charset 解码失败: %q", got)
	}
}

// cmsMock 起一个假采集站 + 假 TVBox 配置。
type cmsMock struct {
	server    *httptest.Server
	acCalls   atomic.Int32
	detailHit atomic.Int32
}

func newCMSMock(t *testing.T) *cmsMock {
	t.Helper()
	mock := &cmsMock{}
	mux := http.NewServeMux()

	// TVBox 配置：两个 type 1 站点 + 一个非 CMS 站点。
	mux.HandleFunc("/tvbox.json", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, `{"sites":[
			{"key":"siteA","name":"站点A","type":1,"api":"%s/cmsA/api.php/provide/vod"},
			{"key":"siteB","name":"站点B","type":1,"api":"%s/cmsB/api.php/provide/vod","searchable":0},
			{"key":"tvboxOnly","name":"非采集","type":0,"api":"https://example.com/api.php/provide/vod"}
		]}`, mock.server.URL, mock.server.URL)
	})

	vodHandler := func(site string) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			mock.acCalls.Add(1)
			query := r.URL.Query()
			ac := query.Get("ac")
			// 模拟老站：只认 ac=detail。
			if site == "siteB" && ac != "detail" {
				fmt.Fprint(w, `{"code":0,"list":[]}`)
				return
			}
			if ids := query.Get("ids"); ids != "" {
				mock.detailHit.Add(1)
				fmt.Fprintf(w, `{"code":0,"list":[{
					"vod_id":"%s","vod_name":"示例影片","vod_pic":"https://img/a.jpg",
					"vod_year":2024,"vod_area":"日本","type_name":"动画",
					"vod_content":"简介","vod_remarks":"更新至第2集",
					"vod_play_from":"线路一$$$线路二",
					"vod_play_url":"第1集$https://cdn.a/%s-1.m3u8#第2集$https://cdn.a/%s-2.m3u8$$$第1集$https://cdn.b/%s-1.mp4"
				}]}`, ids, site, site, site)
				return
			}
			// 搜索：两个站点返回同名不同备注，用于验证聚合去重。
			if site == "siteA" {
				fmt.Fprint(w, `{"code":0,"list":[
					{"vod_id":"1","vod_name":"Demo Show","vod_pic":"","vod_remarks":""},
					{"vod_id":"3","vod_name":"另一部","vod_remarks":"HD"}
				]}`)
				return
			}
			fmt.Fprint(w, `{"code":0,"list":[
				{"vod_id":"2","vod_name":"demo-show!","vod_pic":"https://img/b.jpg","vod_remarks":"更新至第3集"}
			]}`)
		}
	}
	mux.HandleFunc("/cmsA/api.php/provide/vod", vodHandler("siteA"))
	mux.HandleFunc("/cmsB/api.php/provide/vod", vodHandler("siteB"))

	// 跳转配置：urls 指向真实配置（相对地址）。
	mux.HandleFunc("/redirect.json", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"urls":[{"url":"/tvbox.json","name":"真实配置"}]}`)
	})

	mock.server = httptest.NewServer(mux)
	t.Cleanup(mock.server.Close)
	return mock
}

// TestServiceProvidersAndSearch 覆盖注册表键、聚合去重与老站 ac=detail 兼容。
func TestServiceProvidersAndSearch(t *testing.T) {
	mock := newCMSMock(t)
	settings := newTestSettings(t, fmt.Sprintf(`{"cmsSources":["%s/tvbox.json"]}`, mock.server.URL))
	service := NewService(settings)
	ctx := context.Background()

	sources, err := service.Sources(ctx)
	if err != nil {
		t.Fatalf("Sources 失败: %v", err)
	}
	if len(sources) != 2 || sources[0].ID != "cms0_siteA" || sources[1].ID != "cms0_siteB" {
		t.Fatalf("数据源列表错误: %+v", sources)
	}

	results, err := service.SearchAll(ctx, "demo")
	if err != nil {
		t.Fatalf("SearchAll 失败: %v", err)
	}
	// Demo Show 与 demo-show! 归一化后同名 → 合并，保留 siteA 的顺序、补上 siteB 的备注与封面。
	if len(results) != 2 {
		t.Fatalf("聚合结果 = %d，期望 2（同名去重）: %+v", len(results), results)
	}
	if results[0].Title != "Demo Show" || results[0].Source != "cms0_siteA" {
		t.Errorf("首条应为 siteA 的 Demo Show: %+v", results[0])
	}
	if results[0].Remark != "更新至第3集" || results[0].Cover != "https://img/b.jpg" {
		t.Errorf("去重未补全备注/封面: %+v", results[0])
	}
	if results[0].ID != "cms0_siteA::1" || results[0].VodID != "1" || results[0].SiteName != "站点A" {
		t.Errorf("聚合条目字段错误: %+v", results[0])
	}
	if results[1].ID != "cms0_siteA::3" {
		t.Errorf("第二条应为 siteA 的另一部: %+v", results[1])
	}
}

// TestProviderDetailAndPlayback 覆盖详情、解析与 Referer 注入。
func TestProviderDetailAndPlayback(t *testing.T) {
	mock := newCMSMock(t)
	settings := newTestSettings(t, fmt.Sprintf(`{"cmsSources":["%s/tvbox.json"]}`, mock.server.URL))
	service := NewService(settings)
	ctx := context.Background()

	provider, err := service.Provider(ctx, "cms0_siteB")
	if err != nil || provider == nil {
		t.Fatalf("取 siteB provider 失败: %v", err)
	}

	detail, err := provider.Detail(ctx, "9")
	if err != nil {
		t.Fatalf("Detail 失败: %v", err)
	}
	if detail.Title != "示例影片" || detail.Year != "2024" || len(detail.PlayGroups) != 2 {
		t.Fatalf("详情错误: %+v", detail)
	}

	playback, err := service.Resolve(ctx, provider, PlaybackParams{VodID: "9", PlayFromIndex: 1, EpisodeIndex: 0})
	if err != nil {
		t.Fatalf("Resolve 失败: %v", err)
	}
	if playback.URL != "https://cdn.b/siteB-1.mp4" {
		t.Errorf("直链 = %q", playback.URL)
	}
	if playback.Format != FormatMP4 {
		t.Errorf("格式 = %q，期望 mp4", playback.Format)
	}
	if playback.Headers["Referer"] != mock.server.URL+"/" {
		t.Errorf("Referer = %q，期望站点根地址", playback.Headers["Referer"])
	}
	if playback.Headers["User-Agent"] != DefaultUserAgent {
		t.Errorf("UA 未注入: %q", playback.Headers["User-Agent"])
	}

	// 同一参数第二次解析必须走缓存（不再打上游）。
	before := mock.detailHit.Load()
	again, err := service.Resolve(ctx, provider, PlaybackParams{VodID: "9", PlayFromIndex: 1, EpisodeIndex: 0})
	if err != nil || again.URL != playback.URL {
		t.Fatalf("二次解析结果不一致: %v / %+v", err, again)
	}
	if mock.detailHit.Load() != before {
		t.Errorf("二次解析未命中缓存（上游请求数 %d → %d）", before, mock.detailHit.Load())
	}

	// 越界集号 → 解析失败文案。
	if _, err := service.Resolve(ctx, provider, PlaybackParams{VodID: "9", PlayFromIndex: 0, EpisodeIndex: 99}); err == nil || !strings.Contains(err.Error(), "无法解析播放地址") {
		t.Errorf("越界集号应回「无法解析播放地址」，实际 %v", err)
	}
}

// TestConfigRedirectConfig 覆盖跳转配置（urls → 相对地址）。
func TestConfigRedirectConfig(t *testing.T) {
	mock := newCMSMock(t)
	settings := newTestSettings(t, fmt.Sprintf(`{"cmsSources":["%s/redirect.json"]}`, mock.server.URL))
	service := NewService(settings)

	sources, err := service.Sources(context.Background())
	if err != nil {
		t.Fatalf("Sources 失败: %v", err)
	}
	if len(sources) != 2 {
		t.Fatalf("跳转配置解析出 %d 个源，期望 2", len(sources))
	}
}

// TestConfigFailureFallsBackToStale 覆盖「拉不到配置时用过期缓存」。
func TestConfigFailureFallsBackToStale(t *testing.T) {
	var broken atomic.Bool
	mock := newCMSMock(t)
	// 包一层：broken 为真时配置接口 500。
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if broken.Load() && r.URL.Path == "/tvbox.json" {
			http.Error(w, "boom", http.StatusInternalServerError)
			return
		}
		resp, err := http.Get(mock.server.URL + r.URL.Path)
		if err != nil {
			http.Error(w, "upstream", http.StatusBadGateway)
			return
		}
		defer resp.Body.Close()
		w.WriteHeader(resp.StatusCode)
		_, _ = w.Write([]byte(readAll(resp)))
	}))
	defer proxy.Close()

	settings := newTestSettings(t, fmt.Sprintf(`{"cmsSources":["%s/tvbox.json"]}`, proxy.URL))
	service := NewService(settings)
	ctx := context.Background()

	if sites, err := service.LoadConfigSites(ctx, proxy.URL+"/tvbox.json", false); err != nil || len(sites) != 2 {
		t.Fatalf("首次加载失败: %v / %d", err, len(sites))
	}

	broken.Store(true)
	// 缓存未过期：直接命中，不打上游。
	if sites, err := service.LoadConfigSites(ctx, proxy.URL+"/tvbox.json", false); err != nil || len(sites) != 2 {
		t.Fatalf("缓存命中失败: %v / %d", err, len(sites))
	}
	// 强制刷新但上游挂掉 → 回退过期缓存。
	if sites, err := service.LoadConfigSites(ctx, proxy.URL+"/tvbox.json", true); err != nil || len(sites) != 2 {
		t.Fatalf("过期缓存回退失败: %v / %d", err, len(sites))
	}
}

// readAll 读完整响应体（测试辅助）。
func readAll(resp *http.Response) string {
	var builder strings.Builder
	buffer := make([]byte, 4096)
	for {
		n, err := resp.Body.Read(buffer)
		if n > 0 {
			builder.Write(buffer[:n])
		}
		if err != nil {
			break
		}
	}
	return builder.String()
}

// TestResolveCacheTTLExpires 锁住「过期后重新执行」而不是永远返回旧值。
func TestResolveCacheTTLExpires(t *testing.T) {
	cache := newResolveCache[string](1, 4)
	calls := 0
	run := func() (string, error) {
		calls++
		return "v", nil
	}
	if _, err := cache.run("k", run); err != nil {
		t.Fatalf("首次执行失败: %v", err)
	}
	if _, err := cache.run("k", run); err != nil {
		t.Fatalf("二次执行失败: %v", err)
	}
	if calls != 1 {
		t.Fatalf("缓存未命中，calls=%d", calls)
	}
	time.Sleep(3 * time.Millisecond)
	if _, err := cache.run("k", run); err != nil {
		t.Fatalf("过期后执行失败: %v", err)
	}
	if calls != 2 {
		t.Errorf("过期后应重新执行，calls=%d", calls)
	}
}
