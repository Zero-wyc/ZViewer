package bilibili

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
)

// TestLiveRoomID 覆盖直播间链接的各种形态与不该误判的地址。
func TestLiveRoomID(t *testing.T) {
	cases := []struct {
		input string
		want  int64
	}{
		{"https://live.bilibili.com/32153039", 32153039},
		{"https://live.bilibili.com/32153039?broadcast_type=0", 32153039},
		{"https://live.bilibili.com/blanc/21452505", 21452505},
		{"https://live.bilibili.com/h5/1234/", 1234},
		{"http://live.bilibili.com/6", 6},
		// 不该识别为直播间的地址
		{"https://www.bilibili.com/video/BV1xx411c7mD", 0},
		{"https://www.bilibili.com/bangumi/play/ep123", 0},
		{"https://space.bilibili.com/12345", 0},
		{"https://live.bilibili.com/p/eden/area-tags", 0},
		{"", 0},
	}
	for _, c := range cases {
		if got := LiveRoomID(c.input); got != c.want {
			t.Fatalf("LiveRoomID(%q) = %d, want %d", c.input, got, c.want)
		}
	}
}

// liveTransport 按请求路径返回房间信息 / 取流响应。
type liveTransport struct {
	roomJSON string
	playJSON string
}

func (tr liveTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	body := "{}"
	switch {
	case strings.Contains(r.URL.Path, "/room/v1/Room/get_info"):
		body = tr.roomJSON
	case strings.Contains(r.URL.Path, "/live_user/v1/Master/info"):
		body = `{"code":0,"data":{"info":{"uid":229158998,"uname":"测试主播"}}}`
	case strings.Contains(r.URL.Path, "/getRoomPlayInfo"):
		body = tr.playJSON
	}
	return &http.Response{
		StatusCode: 200,
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Request:    r,
		Body:       io.NopCloser(strings.NewReader(body)),
	}, nil
}

const liveRoomJSON = `{"code":0,"data":{"room_id":32153039,"short_id":0,"uid":229158998,
"title":"测试直播间","live_status":1,"live_time":"2026-11-11 22:13:39",
"user_cover":"https://i0.hdslb.com/bfs/live/cover.jpg","online":21262,
"area_name":"聊天电台","parent_area_name":"电台"}}`

// 同一清晰度下同时给 HEVC FLV 与 AVC FLV：必须选 AVC（浏览器硬解兼容性）。
const livePlayMixedCodec = `{"code":0,"data":{"playurl_info":{"playurl":{
"current_qn":10000,
"g_qn_desc":[{"qn":10000,"desc":"原画"},{"qn":250,"desc":"超清"}],
"stream":[
 {"protocol_name":"http_stream","format":[{"format_name":"flv","codec":[
   {"codec_name":"hevc","current_qn":10000,"accept_qn":[10000,250],
    "base_url":"/live-bvc/hevc.flv","url_info":[{"host":"https://hevc.example.com","extra":"?expires=1794415262"}]},
   {"codec_name":"avc","current_qn":10000,"accept_qn":[10000,250],
    "base_url":"/live-bvc/avc.flv","url_info":[{"host":"https://avc.example.com","extra":"?expires=1794415262"}]}
 ]}]},
 {"protocol_name":"http_hls","format":[{"format_name":"ts","codec":[
   {"codec_name":"avc","current_qn":10000,"accept_qn":[10000,250],
    "base_url":"/live-bvc/avc.m3u8","url_info":[{"host":"https://hls.example.com","extra":""}]}
 ]}]}
]}}}}`

// 只推 HEVC 的直播间：没有 AVC 时仍要能取到流（由前端提示解码能力）。
const livePlayHevcOnly = `{"code":0,"data":{"playurl_info":{"playurl":{
"current_qn":10000,
"g_qn_desc":[{"qn":10000,"desc":"原画"}],
"stream":[
 {"protocol_name":"http_stream","format":[{"format_name":"flv","codec":[
   {"codec_name":"hevc","current_qn":10000,"accept_qn":[10000],
    "base_url":"/live-bvc/hevc.flv","url_info":[{"host":"https://hevc.example.com","extra":"?expires=1794415262"}]}
 ]}]}
]}}}}`

func newLiveTestService(playJSON string) *Service {
	service := NewService(nil)
	service.Client.SetTransport(liveTransport{roomJSON: liveRoomJSON, playJSON: playJSON})
	return service
}

// TestResolveLivePrefersAvcFlv 确认同清晰度下优先 AVC FLV，而不是直接拿第一条 HEVC。
func TestResolveLivePrefersAvcFlv(t *testing.T) {
	result, err := newLiveTestService(livePlayMixedCodec).ResolveLive(context.Background(), 32153039, 0, "")
	if err != nil {
		t.Fatal(err)
	}
	if result.Format != "flv" || result.Codec != "avc" {
		t.Fatalf("want flv/avc, got %s/%s", result.Format, result.Codec)
	}
	if !strings.HasPrefix(result.VideoURL, "https://avc.example.com/live-bvc/avc.flv?expires=") {
		t.Fatalf("unexpected url %q", result.VideoURL)
	}
	if result.ExpiresAt != 1794415262 {
		t.Fatalf("expiresAt = %d", result.ExpiresAt)
	}
	if result.Room.Uname != "测试主播" || result.Room.Title != "测试直播间" {
		t.Fatalf("room not filled: %+v", result.Room)
	}
	if len(result.Qualities) != 2 || result.Qualities[0].ID != 10000 || result.Qualities[1].ID != 250 {
		t.Fatalf("qualities should be desc ordered: %+v", result.Qualities)
	}
}

// TestResolveLiveFallsBackToHevc 确认没有 AVC 轨时不会返回空流。
func TestResolveLiveFallsBackToHevc(t *testing.T) {
	result, err := newLiveTestService(livePlayHevcOnly).ResolveLive(context.Background(), 32153039, 0, "")
	if err != nil {
		t.Fatal(err)
	}
	if result.Format != "flv" || result.Codec != "hevc" || result.VideoURL == "" {
		t.Fatalf("want hevc flv fallback, got %+v", result)
	}
}

// TestResolveLiveOfflineSkipsUpstreamPlayURL 确认未开播时直接返回、不再请求取流接口。
func TestResolveLiveOfflineSkipsUpstreamPlayURL(t *testing.T) {
	service := NewService(nil)
	service.Client.SetTransport(liveTransport{
		roomJSON: strings.Replace(liveRoomJSON, `"live_status":1`, `"live_status":0`, 1),
		playJSON: `{"code":-400,"message":"should not be requested"}`,
	})
	result, err := service.ResolveLive(context.Background(), 32153039, 0, "")
	if err != nil {
		t.Fatal(err)
	}
	if result.Room.LiveStatus != 0 || result.VideoURL != "" {
		t.Fatalf("offline room should have no stream: %+v", result)
	}
}

// TestLiveURLExpiresAt 确认签名过期时间解析容错。
func TestLiveURLExpiresAt(t *testing.T) {
	if got := liveURLExpiresAt("https://a.example.com/live.flv?expires=1794415262&pt=web"); got != 1794415262 {
		t.Fatalf("expires parse = %d", got)
	}
	if got := liveURLExpiresAt("https://a.example.com/live.flv?deadline=123"); got != 123 {
		t.Fatalf("deadline parse = %d", got)
	}
	if got := liveURLExpiresAt("https://a.example.com/live.flv"); got != 0 {
		t.Fatalf("no signature should be 0, got %d", got)
	}
}
