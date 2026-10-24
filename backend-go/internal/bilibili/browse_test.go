package bilibili

import (
	"context"
	"database/sql"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"

	_ "modernc.org/sqlite"
)

// stubTransport 把 B站 上游整体替换成按 URL 路由的假实现。
type stubTransport struct {
	routes  map[string]func(*http.Request) string
	queries map[string]*string
	bodies  map[string]string
}

func (s *stubTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if s.queries != nil {
		query := req.URL.RawQuery
		s.queries[req.URL.Path] = &query
	}
	if req.Body != nil && s.bodies != nil {
		raw, err := io.ReadAll(req.Body)
		if err == nil {
			s.bodies[req.URL.Path] = string(raw)
		}
	}
	handler, ok := s.routes[req.URL.Path]
	if !ok {
		return jsonResponse(http.StatusNotFound, `{"code":-404,"message":"not found"}`), nil
	}
	return jsonResponse(http.StatusOK, handler(req)), nil
}

func jsonResponse(status int, body string) *http.Response {
	return &http.Response{
		StatusCode: status,
		Header:     make(http.Header),
		Body:       io.NopCloser(strings.NewReader(body)),
	}
}

// newStubService 构造一个所有上游都走 stub 的 Service。
func newStubService(t *testing.T, routes map[string]func(*http.Request) string) (*Service, *stubTransport) {
	t.Helper()
	service := NewService(nil)
	transport := &stubTransport{routes: routes, queries: map[string]*string{}, bodies: map[string]string{}}
	service.Client.SetTransport(transport)
	return service, transport
}

// TestResolveSearchPage 锁住「虚拟页 → (排序分片, 真实页码)」的映射。
//
// 单一排序最多翻 50 页是 B站 接口硬限制，映射错一位就会出现
// 「第 51 页翻回第 1 页内容」这种看起来像缓存串味的问题。
func TestResolveSearchPage(t *testing.T) {
	cases := []struct {
		page      int
		wantOrder string
		wantPage  int
	}{
		{page: 1, wantOrder: "", wantPage: 1},
		{page: 50, wantOrder: "", wantPage: 50},
		{page: 51, wantOrder: "click", wantPage: 1},
		{page: 100, wantOrder: "click", wantPage: 50},
		{page: 101, wantOrder: "dm", wantPage: 1},
		{page: 151, wantOrder: "stow", wantPage: 1},
		{page: 200, wantOrder: "stow", wantPage: 50},
		{page: 9999, wantOrder: "stow", wantPage: 50},
	}
	for _, tc := range cases {
		order, page := resolveSearchPage(tc.page)
		if order != tc.wantOrder || page != tc.wantPage {
			t.Errorf("resolveSearchPage(%d) = (%q,%d)，期望 (%q,%d)",
				tc.page, order, page, tc.wantOrder, tc.wantPage)
		}
	}
}

// TestParseSpaceLink 覆盖三种链接形态与几处容易误判的输入。
func TestParseSpaceLink(t *testing.T) {
	cases := []struct {
		name     string
		input    string
		wantOK   bool
		wantKind LinkKind
		wantMid  int64
		wantList int64
	}{
		{name: "合集-新版", input: "https://space.bilibili.com/123/lists/456?type=season", wantOK: true, wantKind: LinkSeason, wantMid: 123, wantList: 456},
		{name: "合集-旧版", input: "https://space.bilibili.com/123/channel/collectiondetail?sid=456", wantOK: true, wantKind: LinkSeason, wantMid: 123, wantList: 456},
		{name: "系列-旧版", input: "https://space.bilibili.com/123/channel/seriesdetail?sid=789", wantOK: true, wantKind: LinkSeries, wantMid: 123, wantList: 789},
		{name: "收藏夹", input: "https://space.bilibili.com/123/favlist?fid=321&ftype=create", wantOK: true, wantKind: LinkFavlist, wantMid: 123, wantList: 321},
		// 任意 bilibili.com 子域 + 空间路径都算：Node 只判 host 后缀。
		{name: "子域", input: "https://www.bilibili.com/123/lists/5", wantOK: true, wantKind: LinkSeason, wantMid: 123, wantList: 5},
		{name: "非B站", input: "https://example.com/123/lists/456", wantOK: false},
		{name: "缺fid", input: "https://space.bilibili.com/123/favlist", wantOK: false},
		{name: "缺sid", input: "https://space.bilibili.com/123/lists/", wantOK: false},
		{name: "视频页", input: "https://www.bilibili.com/video/BV1GJ411x7h7", wantOK: false},
	}
	for _, tc := range cases {
		meta, ok := ParseSpaceLink(tc.input)
		if ok != tc.wantOK {
			t.Errorf("%s: ParseSpaceLink(%q) ok=%v，期望 %v", tc.name, tc.input, ok, tc.wantOK)
			continue
		}
		if !ok {
			continue
		}
		if meta.Kind != tc.wantKind || meta.Mid != tc.wantMid || meta.ListID != tc.wantList {
			t.Errorf("%s: got %+v，期望 kind=%s mid=%d list=%d",
				tc.name, meta, tc.wantKind, tc.wantMid, tc.wantList)
		}
	}
}

// TestQRLoginStatus 锁住扫码状态映射（前端只认 0/1/2/3）。
func TestQRLoginStatus(t *testing.T) {
	cases := []struct {
		name string
		poll QRPollResult
		want int
	}{
		{name: "未扫码", poll: QRPollResult{Code: 86101}, want: 0},
		{name: "已扫码", poll: QRPollResult{Code: 86090}, want: 1},
		{name: "已确认", poll: QRPollResult{Code: 0, URL: "https://passport.bilibili.com/x"}, want: 2},
		{name: "已过期", poll: QRPollResult{Code: 86038}, want: 3},
		{name: "未知码回落status", poll: QRPollResult{Code: 12345, Status: 7, HasStatus: true}, want: 7},
		{name: "未知码无status", poll: QRPollResult{Code: 12345}, want: -1},
		{name: "空url不算确认", poll: QRPollResult{Code: 0}, want: -1},
	}
	for _, tc := range cases {
		if got := QRLoginStatus(&tc.poll); got != tc.want {
			t.Errorf("%s: QRLoginStatus(%+v) = %d，期望 %d", tc.name, tc.poll, got, tc.want)
		}
	}
}

// TestNormalizeImageURL 覆盖协议相对地址与裸路径。
func TestNormalizeImageURL(t *testing.T) {
	cases := map[string]string{
		"//i0.hdslb.com/a.jpg":       "https://i0.hdslb.com/a.jpg",
		"http://i0.hdslb.com/a.jpg":  "https://i0.hdslb.com/a.jpg",
		"https://i0.hdslb.com/a.jpg": "https://i0.hdslb.com/a.jpg",
		"i0.hdslb.com/a.jpg":         "https://i0.hdslb.com/a.jpg",
		"":                           "",
	}
	for input, want := range cases {
		if got := NormalizeImageURL(input); got != want {
			t.Errorf("NormalizeImageURL(%q) = %q，期望 %q", input, got, want)
		}
	}
}

// TestParseDurationString 覆盖 "mm:ss" 与 "hh:mm:ss" 两种时长格式。
func TestParseDurationString(t *testing.T) {
	cases := map[string]int{
		"03:20":   200,
		"1:02:03": 3723,
		"":        0,
		"bad":     0,
	}
	for input, want := range cases {
		if got := parseDurationString(input); got != want {
			t.Errorf("parseDurationString(%q) = %d，期望 %d", input, got, want)
		}
	}
}

// TestMapReply 覆盖表情归一化与「IP属地：」前缀剥离。
func TestMapReply(t *testing.T) {
	raw := rawReply{
		Rpid:   1001,
		Mid:    42,
		Like:   7,
		Rcount: 3,
		Ctime:  1700000000,
	}
	raw.Member.Uname = "观众"
	raw.Member.Avatar = "//i0.hdslb.com/avatar.jpg"
	raw.Content.Message = "好听"
	raw.Content.Emote = map[string]struct {
		URL string `json:"url"`
	}{
		"[笑]": {URL: "//i0.hdslb.com/emote.png"},
		"[空]": {},
	}
	raw.ReplyControl.Location = "IP属地：广东"

	item, ok := mapReply(raw)
	if !ok {
		t.Fatal("mapReply 丢弃了合法条目")
	}
	if item.Name != "观众" || item.Avatar != "https://i0.hdslb.com/avatar.jpg" {
		t.Errorf("用户字段映射错误: %+v", item)
	}
	if item.Location != "广东" {
		t.Errorf("IP 属地未剥离: %q", item.Location)
	}
	if len(item.Emote) != 1 || item.Emote["[笑]"] != "https://i0.hdslb.com/emote.png" {
		t.Errorf("表情映射错误: %+v", item.Emote)
	}

	if _, ok := mapReply(rawReply{}); ok {
		t.Error("rpid=0 的条目应当被丢弃")
	}
}

// TestFavVideosFolderSelection 锁住收藏夹选择顺序：
// 显式 mediaId → 默认夹（id == mid）→ 第一个 → 显式 id 兜底。
func TestFavVideosFolderSelection(t *testing.T) {
	folders := `{"code":0,"data":{"list":[
		{"id":7,"title":"A"},
		{"id":42,"title":"默认收藏夹"},
		{"id":9,"title":"B"}
	]}}`
	media := `{"code":0,"data":{"info":{"total":2,"media_count":2},"medias":[
		{"bvid":"BV1GJ411x7h7","title":"v1","cover":"//i0.hdslb.com/c1.jpg","duration":10,
		 "fav_time":1700000000,"upper":{"name":"up1"},"cnt_info":{"play":5,"danmaku":1}},
		{"bvid":"","title":"非视频条目"}
	]}}`

	cases := []struct {
		name      string
		mediaID   int64
		wantTitle string
		wantQuery string
	}{
		{name: "默认夹", mediaID: 0, wantTitle: "默认收藏夹", wantQuery: "media_id=42"},
		{name: "指定夹", mediaID: 9, wantTitle: "B", wantQuery: "media_id=9"},
		// 列表里找不到显式 mediaId 时，Node 的 `??` 链先回落到「默认夹」，
		// 再是 list[0]，显式 id 只是最后兜底——这条故意锁住那个顺序。
		{name: "列表外夹", mediaID: 99, wantTitle: "默认收藏夹", wantQuery: "media_id=42"},
	}
	for _, tc := range cases {
		service, transport := newStubService(t, map[string]func(*http.Request) string{
			"/x/web-interface/nav": func(*http.Request) string {
				return `{"code":0,"data":{"isLogin":true,"mid":42,"uname":"u"}}`
			},
			"/x/v3/fav/folder/created/list-all": func(*http.Request) string { return folders },
			"/x/v3/fav/resource/list":           func(*http.Request) string { return media },
		})

		title, items, total, err := service.FavVideos(context.Background(), "SESSDATA=x", tc.mediaID, 1, 20)
		if err != nil {
			t.Fatalf("%s: FavVideos 失败: %v", tc.name, err)
		}
		if title != tc.wantTitle {
			t.Errorf("%s: folderTitle = %q，期望 %q", tc.name, title, tc.wantTitle)
		}
		if len(items) != 1 {
			t.Fatalf("%s: 条目数 = %d，期望 1（空 bvid 应被丢弃）", tc.name, len(items))
		}
		if items[0].Pic != "https://i0.hdslb.com/c1.jpg" || items[0].View != 5 || items[0].Danmaku != 1 {
			t.Errorf("%s: 条目字段映射错误: %+v", tc.name, items[0])
		}
		if total == nil || *total != 2 {
			t.Errorf("%s: total = %v，期望 2", tc.name, total)
		}
		if query := transport.queries["/x/v3/fav/resource/list"]; query == nil || !strings.Contains(*query, tc.wantQuery) {
			t.Errorf("%s: 收藏夹参数错误: %v，期望包含 %q", tc.name, query, tc.wantQuery)
		}
	}
}

// TestFavVideosWithoutCookie 覆盖未绑定 B站 的 401 分支。
func TestFavVideosWithoutCookie(t *testing.T) {
	service, _ := newStubService(t, nil)
	if _, _, _, err := service.FavVideos(context.Background(), "", 0, 1, 20); err != ErrBiliNotLoggedIn {
		t.Errorf("未登录时应回 ErrBiliNotLoggedIn，实际 %v", err)
	}
	if _, err := service.FavFolders(context.Background(), ""); err != ErrBiliNotLoggedIn {
		t.Errorf("未登录时应回 ErrBiliNotLoggedIn，实际 %v", err)
	}
}

// TestFavFoldersStopsWithoutCount 锁住「接口不给 count 时只翻一页」的行为。
//
// Node 的 total 初值是 +Infinity，第二行是 `total = count ?? rawList.length`
// ——没有 count 时 total 变成 0（push 之前取的长度），循环立刻结束。
func TestFavFoldersStopsWithoutCount(t *testing.T) {
	pages := 0
	service, _ := newStubService(t, map[string]func(*http.Request) string{
		"/x/web-interface/nav": func(*http.Request) string {
			return `{"code":0,"data":{"isLogin":true,"mid":42}}`
		},
		"/x/v3/fav/folder/created/list": func(*http.Request) string {
			pages++
			return `{"code":0,"data":{"list":[{"id":1,"title":"","media_count":3,"cover":"//i0.hdslb.com/f.jpg"}]}}`
		},
	})

	folders, err := service.FavFolders(context.Background(), "SESSDATA=x")
	if err != nil {
		t.Fatalf("FavFolders 失败: %v", err)
	}
	if pages != 1 {
		t.Errorf("缺 count 时应只请求 1 页，实际 %d 页", pages)
	}
	if len(folders) != 1 || folders[0].Title != "默认收藏夹" || folders[0].Cover != "https://i0.hdslb.com/f.jpg" {
		t.Errorf("收藏夹映射错误: %+v", folders)
	}
}

// TestBangumiEpisodesPayload 覆盖 PGC 顶层 result 与集数映射。
func TestBangumiEpisodesPayload(t *testing.T) {
	body := `{"code":0,"message":"0","result":{"episodes":[
		{"bvid":"BV1GJ411x7h7","cid":111,"title":"1","long_title":"开场","title_format":"第1话"},
		{"bvid":"BV1GJ411x7h8","cid":222,"title":"2","long_title":"","title_format":""},
		{"cid":333,"title":"3"}
	]}}`
	service, _ := newStubService(t, map[string]func(*http.Request) string{
		"/pgc/view/web/season": func(*http.Request) string { return body },
	})

	episodes, err := service.BangumiEpisodes(context.Background(), "", "123")
	if err != nil {
		t.Fatalf("BangumiEpisodes 失败: %v", err)
	}
	if len(episodes) != 3 {
		t.Fatalf("集数 = %d，期望 3", len(episodes))
	}
	if episodes[0].Title != "第1话 开场" {
		t.Errorf("第一集标题 = %q，期望 %q", episodes[0].Title, "第1话 开场")
	}
	if episodes[0].Index != "1" {
		t.Errorf("第一集 index = %v，期望 %q", episodes[0].Index, "1")
	}
	// 第二集 title_format 与 long_title 都为空 → 回落到 title。
	if episodes[1].Title != "2" {
		t.Errorf("第二集标题 = %q，期望 %q", episodes[1].Title, "2")
	}
	// 第三集 title 是 "3" → index 取 title（Node: ep.title || ep.index || idx+1）。
	if episodes[2].Index != "3" {
		t.Errorf("第三集 index = %v，期望 %q", episodes[2].Index, "3")
	}
}

// TestFavStatusOmitsEmptyFolder 覆盖「未收藏时只有 collected 键」的语义。
func TestFavStatusOmitsEmptyFolder(t *testing.T) {
	service, _ := newStubService(t, map[string]func(*http.Request) string{
		"/x/web-interface/view": func(*http.Request) string {
			return `{"code":0,"data":{"aid":999}}`
		},
		"/x/v3/fav/folder/created/list-all": func(*http.Request) string {
			return `{"code":0,"data":{"list":[{"id":7,"title":"A","fav_state":0}]}}`
		},
	})
	status, err := service.FavStatusOf(context.Background(), "SESSDATA=x; DedeUserID=42", "BV1GJ411x7h7")
	if err != nil {
		t.Fatalf("FavStatusOf 失败: %v", err)
	}
	if status.Collected || status.FolderID != 0 {
		t.Errorf("未收藏时结果错误: %+v", status)
	}
}

// TestCredentialSaveAndClear 校验凭证写入是 base64（与 Node 互读）且可覆盖。
func TestCredentialSaveAndClear(t *testing.T) {
	conn, err := sql.Open("sqlite", "file::memory:?_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatalf("打开内存库失败: %v", err)
	}
	t.Cleanup(func() { conn.Close() })
	conn.SetMaxOpenConns(1)

	if _, err := conn.Exec(`CREATE TABLE "bilibili_credential" (
		"id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
		"userId" varchar NOT NULL,
		"cookie" TEXT NOT NULL,
		"refreshToken" TEXT,
		"createdAt" datetime NOT NULL DEFAULT (datetime('now')),
		"updatedAt" datetime NOT NULL DEFAULT (datetime('now'))
	)`); err != nil {
		t.Fatalf("建表失败: %v", err)
	}

	store := NewCredentialStore(conn)
	ctx := context.Background()
	if err := store.Save(ctx, "7", "SESSDATA=abc", "refresh-1"); err != nil {
		t.Fatalf("Save 失败: %v", err)
	}

	var stored string
	if err := conn.QueryRow(`SELECT "cookie" FROM "bilibili_credential" WHERE "userId" = '7'`).Scan(&stored); err != nil {
		t.Fatalf("读取失败: %v", err)
	}
	if stored != "U0VTU0RBVEE9YWJj" { // base64("SESSDATA=abc")
		t.Errorf("落库值 = %q，期望 base64", stored)
	}

	// 同用户再写一次必须走 UPDATE，不能插入第二行。
	if err := store.Save(ctx, "7", "SESSDATA=def", ""); err != nil {
		t.Fatalf("再次 Save 失败: %v", err)
	}
	var count int
	if err := conn.QueryRow(`SELECT COUNT(*) FROM "bilibili_credential"`).Scan(&count); err != nil {
		t.Fatalf("统计失败: %v", err)
	}
	if count != 1 {
		t.Errorf("凭证行数 = %d，期望 1", count)
	}

	cred, err := store.Get(ctx, "7")
	if err != nil {
		t.Fatalf("Get 失败: %v", err)
	}
	if cred.Cookie != "SESSDATA=def" || cred.RefreshToken != "" {
		t.Errorf("读取结果 = %+v，期望覆盖后的值且 refreshToken 为空", cred)
	}

	if err := store.Clear(ctx, "7"); err != nil {
		t.Fatalf("Clear 失败: %v", err)
	}
	if _, err := store.Get(ctx, "7"); err == nil {
		t.Error("Clear 后仍能读到凭证")
	}
}

// TestFavCollectCreatesFolder 覆盖「收藏到不存在的夹 → 先建夹再收藏」的写链路。
//
// 这条路径对拍覆盖不到（需要真实 B站 Cookie），只能靠假上游锁住：
//   - 建夹用表单 POST，带 title/privacy/csrf；
//   - deal 的 add_media_ids 是纯数字（带方括号会被 B站 判 -400）。
func TestFavCollectCreatesFolder(t *testing.T) {
	cookie := "SESSDATA=abc; bili_jct=csrf-token; DedeUserID=42"
	service, transport := newStubService(t, map[string]func(*http.Request) string{
		"/x/web-interface/view": func(*http.Request) string {
			return `{"code":0,"data":{"aid":999}}`
		},
		"/x/v3/fav/folder/created/list-all": func(*http.Request) string {
			return `{"code":0,"data":{"list":[{"id":7,"title":"其它"}]}}`
		},
		"/x/v3/fav/folder/add": func(*http.Request) string {
			return `{"code":0,"data":{"id":123}}`
		},
		"/x/v3/fav/resource/deal": func(*http.Request) string {
			return `{"code":0,"data":{}}`
		},
	})

	folderID, title, err := service.FavCollect(context.Background(), cookie, "BV1GJ411x7h7", 0, false, "Music", false)
	if err != nil {
		t.Fatalf("FavCollect 失败: %v", err)
	}
	if folderID != 123 || title != "Music" {
		t.Errorf("返回值 = (%d,%q)，期望 (123,\"Music\")", folderID, title)
	}

	addBody := transport.bodies["/x/v3/fav/folder/add"]
	if !strings.Contains(addBody, "title=Music") || !strings.Contains(addBody, "csrf=csrf-token") {
		t.Errorf("建夹表单错误: %q", addBody)
	}
	dealBody := transport.bodies["/x/v3/fav/resource/deal"]
	if !strings.Contains(dealBody, "add_media_ids=123") || !strings.Contains(dealBody, "del_media_ids=") {
		t.Errorf("收藏表单错误: %q", dealBody)
	}
	if !strings.Contains(dealBody, "rid=999") || !strings.Contains(dealBody, "type=2") {
		t.Errorf("收藏表单缺少 rid/type: %q", dealBody)
	}
}

// TestFavCollectMissingFolderOnRemove 锁住「取消收藏时夹不存在 = 尚未收藏」。
func TestFavCollectMissingFolderOnRemove(t *testing.T) {
	cookie := "SESSDATA=abc; bili_jct=csrf-token; DedeUserID=42"
	service, _ := newStubService(t, map[string]func(*http.Request) string{
		"/x/web-interface/view": func(*http.Request) string {
			return `{"code":0,"data":{"aid":999}}`
		},
		"/x/v3/fav/folder/created/list-all": func(*http.Request) string {
			return `{"code":0,"data":{"list":[]}}`
		},
	})

	_, _, err := service.FavCollect(context.Background(), cookie, "BV1GJ411x7h7", 0, false, "Music", true)
	if !errors.Is(err, ErrFolderMissing) {
		t.Errorf("取消收藏且夹不存在时应回 ErrFolderMissing，实际 %v", err)
	}
}

// TestFavCollectRequiresCSRF 锁住 csrf 缺失的早退分支。
func TestFavCollectRequiresCSRF(t *testing.T) {
	service, _ := newStubService(t, nil)
	_, _, err := service.FavCollect(context.Background(), "SESSDATA=abc", "BV1GJ411x7h7", 0, false, "Music", false)
	if !errors.Is(err, ErrMissingCSRF) {
		t.Errorf("缺 bili_jct 时应回 ErrMissingCSRF，实际 %v", err)
	}
}
