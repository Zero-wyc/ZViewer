package ncmapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// stubCaller 记录调用并返回固定响应。
type stubCaller struct {
	calls []Call
	reply string
}

// Do 实现 Caller。
func (s *stubCaller) Do(_ context.Context, call Call) (*Result, error) {
	s.calls = append(s.calls, call)
	body := s.reply
	if body == "" {
		body = `{"code":200}`
	}
	return &Result{Status: 200, Body: []byte(body)}, nil
}

// frontendPaths 是前端实际调用的路径全集（从 frontend/src 提取）。
//
// 这份清单是兼容层的验收口径：少一条就意味着某个页面会出现 404。
var frontendPaths = []string{
	"/album", "/album/new", "/album/sublist", "/artist/sublist", "/artists",
	"/banner", "/cloudsearch", "/comment", "/comment/floor", "/comment/like",
	"/comment/new", "/dj/sublist", "/fm_trash", "/history/recommend/songs",
	"/history/recommend/songs/detail", "/like", "/likelist", "/login/qr/check",
	"/login/qr/create", "/login/qr/key", "/lyric", "/mv/detail", "/mv/sublist",
	"/personal/fm/mode", "/personal_fm", "/personalized", "/personalized/newsong",
	"/playlist/create", "/playlist/detail", "/playlist/track/all", "/playlist/tracks",
	"/recommend/songs", "/search", "/search/hot/detail", "/search/suggest",
	"/search/suggest/pc", "/song/detail", "/top/artists", "/toplist",
	"/user/account", "/user/cloud", "/user/cloud/del", "/user/playlist", "/user/subcount",
}

// specialPaths 是走专门处理函数（不是表驱动）的路径。
var specialPaths = map[string]bool{
	"/login/qr/create":    true,
	"/login/qr/key":       true,
	"/playlist/track/all": true,
}

// TestEveryFrontendPathRouted 保证前端 44 条路径一条不落地有归属。
func TestEveryFrontendPathRouted(t *testing.T) {
	for _, path := range frontendPaths {
		if specialPaths[path] {
			continue
		}
		if _, ok := routes[path]; !ok {
			t.Errorf("路径 %s 没有任何映射", path)
		}
	}
}

// TestNoDanglingRoute 反向检查：表里的每条都能真正产出上游路径。
func TestNoDanglingRoute(t *testing.T) {
	for path, spec := range routes {
		apiPath, _ := spec.build(Params{})
		if !strings.HasPrefix(apiPath, "/api/") {
			t.Errorf("路径 %s 产出的上游路径异常: %q", path, apiPath)
		}
		if spec.crypto == "" {
			t.Errorf("路径 %s 没有指定加密方式", path)
		}
	}
}

// doGet 打一次 handler 并返回记录到的调用。
func doGet(t *testing.T, stub *stubCaller, target string) *http.Response {
	t.Helper()
	server := httptest.NewServer(NewHandlerWith(stub))
	defer server.Close()

	request, err := http.NewRequest(http.MethodGet, server.URL+target, nil)
	if err != nil {
		t.Fatalf("构造请求失败: %v", err)
	}
	request.Header.Set("Cookie", "MUSIC_U=abc; __csrf=xyz")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("请求失败: %v", err)
	}
	t.Cleanup(func() { _ = response.Body.Close() })
	return response
}

// TestBannerMapping 校验 banner 的 clientType 映射与通道。
func TestBannerMapping(t *testing.T) {
	stub := &stubCaller{}
	doGet(t, stub, "/banner?type=1&timestamp=1")
	if len(stub.calls) != 1 {
		t.Fatalf("应当调用一次上游，实际 %d 次", len(stub.calls))
	}
	call := stub.calls[0]
	if call.Path != "/api/v2/banner/get" {
		t.Fatalf("上游路径错误: %s", call.Path)
	}
	if call.Crypto != cryptoEapi {
		t.Fatalf("通道错误: %s", call.Crypto)
	}
	if call.Data["clientType"] != "android" {
		t.Fatalf("clientType 映射错误: %#v", call.Data["clientType"])
	}
	if call.Cookie != "MUSIC_U=abc; __csrf=xyz" {
		t.Fatalf("cookie 未透传: %q", call.Cookie)
	}
}

// TestSongDetailMapping 校验 c 参数拼装与类型。
func TestSongDetailMapping(t *testing.T) {
	stub := &stubCaller{}
	doGet(t, stub, "/song/detail?ids=1,2,3")
	data := stub.calls[0].Data
	if data["c"] != `[{"id":1},{"id":2},{"id":3}]` {
		t.Fatalf("c 参数错误: %#v", data["c"])
	}
}

// TestCommentNewCursor 校验三种排序的 cursor 规则。
func TestCommentNewCursor(t *testing.T) {
	cases := []struct {
		query      string
		wantCursor string
		wantSort   int
	}{
		{"id=10&type=0&sortType=3&pageSize=20&pageNo=1&cursor=0", "0", 3},
		{"id=10&type=0&sortType=2&pageSize=20&pageNo=2", "normalHot#20", 2},
		{"id=10&type=0&sortType=1&pageSize=20&pageNo=3", "40", 99},
	}
	for _, item := range cases {
		stub := &stubCaller{}
		doGet(t, stub, "/comment/new?"+item.query)
		call := stub.calls[0]
		if call.Path != "/api/v2/resource/comments" {
			t.Fatalf("上游路径错误: %s", call.Path)
		}
		if call.Data["threadId"] != "R_SO_4_10" {
			t.Fatalf("threadId 错误: %#v", call.Data["threadId"])
		}
		if call.Data["cursor"] != item.wantCursor {
			t.Fatalf("%s 的 cursor 错误: %#v，期望 %q", item.query, call.Data["cursor"], item.wantCursor)
		}
		if call.Data["sortType"] != item.wantSort {
			t.Fatalf("%s 的 sortType 错误: %#v，期望 %d", item.query, call.Data["sortType"], item.wantSort)
		}
	}
}

// TestSongURLKeepsLevelAndTypes 校验音质参数与类型（weapi 的参数是 JSON，类型敏感）。
func TestSongURLKeepsLevelAndTypes(t *testing.T) {
	stub := &stubCaller{}
	doGet(t, stub, "/song/url/v1?id=123&level=hires")
	call := stub.calls[0]
	if call.Path != "/api/song/enhance/player/url/v1" {
		t.Fatalf("上游路径错误: %s", call.Path)
	}
	if call.Data["ids"] != "[123]" {
		t.Fatalf("ids 参数错误: %#v", call.Data["ids"])
	}
	if call.Data["level"] != "hires" || call.Data["encodeType"] != "flac" {
		t.Fatalf("音质参数错误: %#v", call.Data)
	}
}

// TestQrCreateIsLocal 二维码必须本地生成，不能打到上游（上游没有这个接口）。
func TestQrCreateIsLocal(t *testing.T) {
	stub := &stubCaller{}
	response := doGet(t, stub, "/login/qr/create?key=abc&qrimg=true")
	if len(stub.calls) != 0 {
		t.Fatalf("二维码生成不应调用上游，实际 %d 次", len(stub.calls))
	}
	var body struct {
		Code int `json:"code"`
		Data struct {
			QRURL string `json:"qrurl"`
			QRImg string `json:"qrimg"`
		} `json:"data"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatalf("响应不是合法 JSON: %v", err)
	}
	if !strings.Contains(body.Data.QRURL, "codekey=abc") {
		t.Fatalf("qrurl 错误: %s", body.Data.QRURL)
	}
	if !strings.HasPrefix(body.Data.QRImg, "data:image/png;base64,") {
		t.Fatalf("qrimg 不是 PNG data URL: %.40s", body.Data.QRImg)
	}
}

// TestQRKeyWrapped 扫码 key 必须包在 data 里（前端读 data.data.unikey）。
func TestQRKeyWrapped(t *testing.T) {
	stub := &stubCaller{reply: `{"code":200,"unikey":"KEY123"}`}
	response := doGet(t, stub, "/login/qr/key")
	var body struct {
		Code int `json:"code"`
		Data struct {
			UniKey string `json:"unikey"`
		} `json:"data"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatalf("响应不是合法 JSON: %v", err)
	}
	if body.Code != 200 || body.Data.UniKey != "KEY123" {
		t.Fatalf("扫码 key 结构错误: %+v", body)
	}
}

// TestPlaylistTrackAllTwoStage 校验两段式取数：先详情再批量歌曲。
func TestPlaylistTrackAllTwoStage(t *testing.T) {
	stub := &stubCaller{reply: `{"code":200,"playlist":{"trackIds":[{"id":11},{"id":22},{"id":33}]},"songs":[]}`}
	doGet(t, stub, "/playlist/track/all?id=99&limit=2&offset=1")
	if len(stub.calls) != 2 {
		t.Fatalf("应当调用两次上游，实际 %d 次", len(stub.calls))
	}
	if stub.calls[0].Path != "/api/v6/playlist/detail" {
		t.Fatalf("第一段路径错误: %s", stub.calls[0].Path)
	}
	if stub.calls[1].Path != "/api/v3/song/detail" {
		t.Fatalf("第二段路径错误: %s", stub.calls[1].Path)
	}
	if stub.calls[1].Data["c"] != `[{"id":22},{"id":33}]` {
		t.Fatalf("分页切片错误: %#v", stub.calls[1].Data["c"])
	}
}

// TestRootProbe 根路径必须 200，否则 internal/ncm 会把整个音乐域判成离线。
func TestRootProbe(t *testing.T) {
	stub := &stubCaller{}
	response := doGet(t, stub, "/")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("根路径应当 200，实际 %d", response.StatusCode)
	}
}

// TestUnknownPath404 未知路径必须 404（而不是静默 200 空对象）。
func TestUnknownPath404(t *testing.T) {
	stub := &stubCaller{}
	response := doGet(t, stub, "/not-a-real-endpoint")
	if response.StatusCode != http.StatusNotFound {
		t.Fatalf("未知路径应当 404，实际 %d", response.StatusCode)
	}
}
