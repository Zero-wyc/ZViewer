package ncm

import (
	"context"
	"errors"
	"strings"
	"testing"
)

// stubCaller 记录调用并返回固定响应。
type stubCaller struct {
	calls []Call
	reply string
}

// Do 实现 caller。
func (s *stubCaller) Do(_ context.Context, call Call) (*upstreamResult, error) {
	s.calls = append(s.calls, call)
	body := s.reply
	if body == "" {
		body = `{"code":200}`
	}
	return &upstreamResult{Status: 200, Body: []byte(body)}, nil
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
	// /check/music 不在 frontendPaths 里（只由 api/music.go 调用），列在这里是为了
	// 说明它同样是「不是拼路径」的专门实现。
	"/check/music": true,
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
		apiPath, _ := spec.build(params{})
		if !strings.HasPrefix(apiPath, "/api/") {
			t.Errorf("路径 %s 产出的上游路径异常: %q", path, apiPath)
		}
		if spec.crypto == "" {
			t.Errorf("路径 %s 没有指定加密方式", path)
		}
	}
}

// invoke 按浏览器侧的写法调一次分发器。
func invoke(t *testing.T, stub *stubCaller, target string) *Result {
	t.Helper()
	path, p := parseQueryPath(target)
	result, err := newAPIWith(stub).call(context.Background(), path, p, "MUSIC_U=abc; __csrf=xyz")
	if err != nil {
		t.Fatalf("%s 调用失败: %v", target, err)
	}
	return result
}

// TestBannerMapping 校验 banner 的 clientType 映射与通道。
func TestBannerMapping(t *testing.T) {
	stub := &stubCaller{}
	invoke(t, stub, "/banner?type=1")
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
	invoke(t, stub, "/song/detail?ids=1,2,3")
	if data := stub.calls[0].Data; data["c"] != `[{"id":1},{"id":2},{"id":3}]` {
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
		invoke(t, stub, "/comment/new?"+item.query)
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
	invoke(t, stub, "/song/url/v1?id=123&level=hires")
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
	result := invoke(t, stub, "/login/qr/create?key=abc&qrimg=true")
	if len(stub.calls) != 0 {
		t.Fatalf("二维码生成不应调用上游，实际 %d 次", len(stub.calls))
	}
	body, _ := result.Body.(map[string]any)
	data, _ := body["data"].(map[string]any)
	qrURL, _ := data["qrurl"].(string)
	image, _ := data["qrimg"].(string)
	if !strings.Contains(qrURL, "codekey=abc") {
		t.Fatalf("qrurl 错误: %s", qrURL)
	}
	if !strings.HasPrefix(image, "data:image/png;base64,") {
		t.Fatalf("qrimg 不是 PNG data URL: %.40s", image)
	}
}

// TestQRKeyWrapped 扫码 key 必须包在 data 里（前端读 data.data.unikey）。
func TestQRKeyWrapped(t *testing.T) {
	stub := &stubCaller{reply: `{"code":200,"unikey":"KEY123"}`}
	result := invoke(t, stub, "/login/qr/key")
	body, _ := result.Body.(map[string]any)
	data, _ := body["data"].(map[string]any)
	if body["code"] != 200 || data["unikey"] != "KEY123" {
		t.Fatalf("扫码 key 结构错误: %#v", result.Body)
	}
}

// TestPlaylistTrackAllTwoStage 校验两段式取数：先详情再批量歌曲。
func TestPlaylistTrackAllTwoStage(t *testing.T) {
	stub := &stubCaller{reply: `{"code":200,"playlist":{"trackIds":[{"id":11},{"id":22},{"id":33}]},"songs":[]}`}
	invoke(t, stub, "/playlist/track/all?id=99&limit=2&offset=1")
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

// TestUnknownPath 未知路径必须返回明确错误（路由层据此回 404）。
func TestUnknownPath(t *testing.T) {
	stub := &stubCaller{}
	_, err := newAPIWith(stub).call(context.Background(), "/not-a-real-endpoint", params{}, "")
	if !errors.Is(err, unknownPathError) {
		t.Fatalf("未知路径应返回 unknownPathError，实际 %v", err)
	}
}

// TestVipInfoMapping 校验会员信息走 web 的 front 段。
//
// `/api/vip/info` 是不存在的路径（上游 404「接口未找到」），这里把上游路径钉死，
// 免得以后又被写成裸 /api/vip/info。
func TestVipInfoMapping(t *testing.T) {
	stub := &stubCaller{}
	invoke(t, stub, "/vip/info?uid=42")
	if len(stub.calls) != 1 {
		t.Fatalf("应当调用一次上游，实际 %d 次", len(stub.calls))
	}
	call := stub.calls[0]
	if call.Path != "/api/music-vip-membership/front/vip/info" {
		t.Fatalf("上游路径错误: %s", call.Path)
	}
	if call.Crypto != cryptoWeapi {
		t.Fatalf("通道错误: %s", call.Crypto)
	}
	if call.Data["userId"] != "42" {
		t.Fatalf("userId 未透传: %#v", call.Data["userId"])
	}
}

// TestCheckMusicPlayable 校验可播时压成 success=true，且 br 是数字。
func TestCheckMusicPlayable(t *testing.T) {
	stub := &stubCaller{reply: `{"code":200,"data":[{"code":200,"url":"http://m8.music.126.net/a.mp3"}]}`}
	result := invoke(t, stub, "/check/music?id=347230")
	call := stub.calls[0]
	if call.Path != "/api/song/enhance/player/url" || call.Crypto != cryptoWeapi {
		t.Fatalf("上游路径/通道错误: %s %s", call.Path, call.Crypto)
	}
	if call.Data["ids"] != "[347230]" {
		t.Fatalf("ids 拼装错误: %#v", call.Data["ids"])
	}
	if _, ok := call.Data["br"].(int); !ok {
		t.Fatalf("br 必须是数字（字符串会被上游当成 0）: %#v", call.Data["br"])
	}
	body, _ := result.Body.(map[string]any)
	if body["success"] != true {
		t.Fatalf("可播应回 success=true: %#v", body)
	}
}

// TestCheckMusicUnplayable 校验拿不到地址时压成 success=false，并保留上游 code。
func TestCheckMusicUnplayable(t *testing.T) {
	stub := &stubCaller{reply: `{"code":200,"data":[{"code":404,"url":null}]}`}
	result := invoke(t, stub, "/check/music?id=1")
	body, _ := result.Body.(map[string]any)
	if body["success"] != false {
		t.Fatalf("不可播应回 success=false: %#v", body)
	}
	if body["songCode"] != int64(404) {
		t.Fatalf("上游歌曲状态码应被保留: %#v", body)
	}
	if body["code"] != 200 {
		t.Fatalf("接口本身是成功的，外层 code 必须 200: %#v", body)
	}
}

// TestCheckMusicMissingID 缺 id 时不发上游请求，直接回 400。
func TestCheckMusicMissingID(t *testing.T) {
	stub := &stubCaller{}
	result := invoke(t, stub, "/check/music")
	if len(stub.calls) != 0 {
		t.Fatalf("缺 id 不该打扰上游，实际调用 %d 次", len(stub.calls))
	}
	body, _ := result.Body.(map[string]any)
	if body["code"] != 400 {
		t.Fatalf("缺 id 应回 400: %#v", body)
	}
}
