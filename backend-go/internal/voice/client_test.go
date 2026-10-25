package voice

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func mustRequest(t *testing.T, target string) *http.Request {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, target, nil)
	if err != nil {
		t.Fatalf("构造请求失败: %v", err)
	}
	return req
}

func TestTrackKind(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want string
	}{
		// protojson 省略零值枚举：AUDIO 轨的 type 字段常常整个不存在，
		// 当成「未知」就会漏禁言——这是本函数最要紧的一条。
		{name: "缺失即 AUDIO", raw: "", want: TrackAudio},
		{name: "字符串 AUDIO", raw: `"AUDIO"`, want: TrackAudio},
		{name: "字符串小写", raw: `"audio"`, want: TrackAudio},
		{name: "字符串 VIDEO", raw: `"VIDEO"`, want: TrackVideo},
		{name: "数字 0", raw: `0`, want: TrackAudio},
		{name: "数字 1", raw: `1`, want: TrackVideo},
		{name: "数字 2", raw: `2`, want: TrackData},
		{name: "未知数字", raw: `9`, want: ""},
		{name: "非法内容", raw: `{"x":1}`, want: ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := trackKind(json.RawMessage(c.raw)); got != c.want {
				t.Errorf("trackKind(%s) = %q, want %q", c.raw, got, c.want)
			}
		})
	}
}

// newFakeLiveKit 起一个记录请求的 Twirp 端点。
type twirpCall struct {
	path   string
	body   map[string]any
	auth   string
	method string
}

func newFakeLiveKit(t *testing.T, status int, response string) (*httptest.Server, *[]twirpCall) {
	t.Helper()
	calls := &[]twirpCall{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		*calls = append(*calls, twirpCall{
			path:   r.URL.Path,
			body:   body,
			auth:   r.Header.Get("Authorization"),
			method: r.Method,
		})
		w.Header().Set("Content-Type", "application/json")
		if status != 0 {
			w.WriteHeader(status)
		}
		_, _ = w.Write([]byte(response))
	}))
	t.Cleanup(srv.Close)
	return srv, calls
}

func TestListParticipantsParseeProtojson(t *testing.T) {
	t.Setenv("LIVEKIT_API_KEY", "k")
	t.Setenv("LIVEKIT_API_SECRET", "s")

	srv, calls := newFakeLiveKit(t, 0, `{"participants":[
		{"identity":"user:1","tracks":[
			{"sid":"TR_A","type":"AUDIO"},
			{"sid":"TR_V","type":"VIDEO"}
		]},
		{"identity":"user:2","tracks":[{"sid":"TR_B"}]}
	]}`)

	svc := New(nil)
	svc.HTTP = srv.Client()
	t.Setenv("LIVEKIT_API_HOST", srv.URL)

	participants, err := svc.ListParticipants(t.Context(), "ROOM1")
	if err != nil {
		t.Fatalf("ListParticipants 失败: %v", err)
	}
	if len(participants) != 2 {
		t.Fatalf("参与者数量 = %d, want 2", len(participants))
	}
	if participants[0].Identity != "user:1" || len(participants[0].Tracks) != 2 {
		t.Fatalf("第一个参与者解析不对: %+v", participants[0])
	}
	if participants[0].Tracks[0].Kind != TrackAudio || participants[0].Tracks[1].Kind != TrackVideo {
		t.Errorf("轨道类型不对: %+v", participants[0].Tracks)
	}
	// type 缺失的轨必须按 AUDIO 处理（protojson 省略零值）
	if participants[1].Tracks[0].Kind != TrackAudio {
		t.Errorf("缺失 type 的轨应为 AUDIO，实际 %q", participants[1].Tracks[0].Kind)
	}

	call := (*calls)[0]
	if call.method != http.MethodPost {
		t.Errorf("method = %s", call.method)
	}
	if call.path != "/twirp/livekit.RoomService/ListParticipants" {
		t.Errorf("path = %q", call.path)
	}
	if call.body["room"] != "voice:ROOM1" {
		t.Errorf("body.room = %v", call.body["room"])
	}
	if !strings.HasPrefix(call.auth, "Bearer ") {
		t.Errorf("缺少 Bearer admin token: %q", call.auth)
	}
}

func TestMutePublishedTrackBody(t *testing.T) {
	t.Setenv("LIVEKIT_API_KEY", "k")
	t.Setenv("LIVEKIT_API_SECRET", "s")

	srv, calls := newFakeLiveKit(t, 0, `{}`)
	t.Setenv("LIVEKIT_API_HOST", srv.URL)

	svc := New(nil)
	svc.HTTP = srv.Client()
	if err := svc.MutePublishedTrack(t.Context(), "ROOM1", "user:2", "TR_A", true); err != nil {
		t.Fatalf("调用失败: %v", err)
	}

	call := (*calls)[0]
	if call.path != "/twirp/livekit.RoomService/MutePublishedTrack" {
		t.Errorf("path = %q", call.path)
	}
	want := map[string]any{
		"room": "voice:ROOM1", "identity": "user:2", "trackSid": "TR_A", "muted": true,
	}
	for key, value := range want {
		if call.body[key] != value {
			t.Errorf("body.%s = %#v, want %#v", key, call.body[key], value)
		}
	}
}

func TestUpdateParticipantMetadataBody(t *testing.T) {
	t.Setenv("LIVEKIT_API_KEY", "k")
	t.Setenv("LIVEKIT_API_SECRET", "s")

	srv, calls := newFakeLiveKit(t, 0, `{"participant":{}}`)
	t.Setenv("LIVEKIT_API_HOST", srv.URL)

	svc := New(nil)
	svc.HTTP = srv.Client()
	if err := svc.UpdateParticipantMetadata(t.Context(), "ROOM1", "user:2", `{"adminMuted":true}`); err != nil {
		t.Fatalf("调用失败: %v", err)
	}
	call := (*calls)[0]
	if call.path != "/twirp/livekit.RoomService/UpdateParticipant" {
		t.Errorf("path = %q", call.path)
	}
	if call.body["metadata"] != `{"adminMuted":true}` {
		t.Errorf("metadata = %v", call.body["metadata"])
	}
}

func TestTwirpErrorCarriesDetail(t *testing.T) {
	t.Setenv("LIVEKIT_API_KEY", "k")
	t.Setenv("LIVEKIT_API_SECRET", "s")

	srv, _ := newFakeLiveKit(t, http.StatusInternalServerError,
		`{"code":"internal","msg":"livekit 挂了"}`)
	t.Setenv("LIVEKIT_API_HOST", srv.URL)

	svc := New(nil)
	svc.HTTP = srv.Client()
	err := svc.RemoveParticipant(t.Context(), "ROOM1", "user:2")
	if err == nil {
		t.Fatal("非 2xx 应返回错误")
	}
	// 上游错误体带进错误串：排查「语音里踢不掉人」时全靠它
	if !strings.Contains(err.Error(), "500") || !strings.Contains(err.Error(), "livekit 挂了") {
		t.Errorf("错误信息缺少状态码或上游详情: %v", err)
	}
}

func TestAPIHostDefaultsAndTrailingSlash(t *testing.T) {
	svc := New(nil)
	t.Setenv("LIVEKIT_API_HOST", "")
	if got := svc.apiHost(); got != "http://127.0.0.1:3336" {
		t.Errorf("默认管理地址 = %q", got)
	}
	t.Setenv("LIVEKIT_API_HOST", "http://10.0.0.2:3336/")
	if got := svc.apiHost(); got != "http://10.0.0.2:3336" {
		t.Errorf("尾斜杠未去掉: %q", got)
	}
}
