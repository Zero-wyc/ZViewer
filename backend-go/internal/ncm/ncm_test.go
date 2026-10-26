package ncm

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// funcCaller 把函数适配成 caller（单测用）。
type funcCaller func(ctx context.Context, call Call) (*upstreamResult, error)

func (f funcCaller) Do(ctx context.Context, call Call) (*upstreamResult, error) {
	return f(ctx, call)
}

// newTestService 构造一个上游被替换掉的服务。
func newTestService(fake caller) *Service {
	service := NewService(nil)
	service.api = newAPIWith(fake)
	return service
}

func TestCookieHelpers(t *testing.T) {
	// 空串被滤掉；"bad" 这种没有 = 的项 Node 也会保留（只做 length>0 与 trim 判断）
	raw := `["MUSIC_U=abc; Path=/; HttpOnly","__csrf=xyz","","bad"]`
	if got := ToCookieHeader(raw); got != "MUSIC_U=abc; __csrf=xyz; bad" {
		t.Errorf("ToCookieHeader = %q", got)
	}
	if got := ToCookieHeader("not-json"); got != "" {
		t.Errorf("非法 JSON 应返回空串，实际 %q", got)
	}

	parsed := ParseStoredCookies(raw)
	if len(parsed) != 4 {
		t.Errorf("ParseStoredCookies 长度 = %d，期望 4", len(parsed))
	}

	// 同名后写胜出，且顺序按首次出现（与 JS 的 Map 一致）
	merged := MergeCookies(
		[]string{"A=1; Path=/", "B=2"},
		[]string{"A=9; Path=/new", "C=3"},
	)
	want := []string{"A=9; Path=/new", "B=2", "C=3"}
	if len(merged) != len(want) {
		t.Fatalf("MergeCookies = %v", merged)
	}
	for index := range want {
		if merged[index] != want[index] {
			t.Errorf("第 %d 项 = %q，期望 %q", index, merged[index], want[index])
		}
	}

	if !HasLoginCookies([]string{"MUSIC_U=x; Path=/"}) {
		t.Error("MUSIC_U 应判定为登录态 cookie")
	}
	if !HasLoginCookies([]string{"__csrf=1"}) {
		t.Error("csrf 应判定为登录态 cookie")
	}
	if HasLoginCookies([]string{"NMTID=1"}) {
		t.Error("NMTID 不该判定为登录态 cookie")
	}
}

func TestExtractProfile(t *testing.T) {
	body := map[string]any{
		"profile": map[string]any{
			"nickname":  "网易云用户",
			"avatarUrl": "https://p1.music.126.net/a.jpg",
			"vipType":   float64(0),
		},
	}
	profile := ExtractProfile(body)
	if profile == nil || profile.Nickname == nil || *profile.Nickname != "网易云用户" {
		t.Fatalf("profile = %+v", profile)
	}
	if profile.VIPType == nil || *profile.VIPType != 0 {
		t.Errorf("vipType=0 必须保留（0 会触发 /vip/info 兜底），实际 %v", profile.VIPType)
	}

	// data.profile 形态
	nested := map[string]any{"data": map[string]any{"profile": map[string]any{"nickname": "嵌套"}}}
	if got := ExtractProfile(nested); got == nil || *got.Nickname != "嵌套" {
		t.Errorf("data.profile 未识别: %+v", got)
	}

	// 昵称与头像都为空 → nil
	empty := map[string]any{"profile": map[string]any{"nickname": "", "avatarUrl": ""}}
	if got := ExtractProfile(empty); got != nil {
		t.Errorf("空资料应返回 nil，实际 %+v", got)
	}
	if got := ExtractProfile("not-an-object"); got != nil {
		t.Errorf("非对象应返回 nil，实际 %+v", got)
	}
}

func TestQualityLevels(t *testing.T) {
	cases := []struct {
		requested string
		want      []string
	}{
		{"exhigh", []string{"exhigh", "higher", "standard"}},
		{"standard", []string{"standard"}},
		{"lossless", []string{"lossless", "exhigh", "higher", "standard"}},
		{"unknown", []string{"lossless", "exhigh", "higher", "standard"}},
		{"", []string{"lossless", "exhigh", "higher", "standard"}},
	}
	for _, c := range cases {
		got := QualityLevels(c.requested)
		if strings.Join(got, ",") != strings.Join(c.want, ",") {
			t.Errorf("QualityLevels(%q) = %v，期望 %v", c.requested, got, c.want)
		}
	}
}

func TestParseFlacSampleRate(t *testing.T) {
	// 44100 Hz 的 STREAMINFO 片段：前 8 字节是 'fLaC' + 块头，
	// 之后 10 字节块/帧尺寸，再 3 字节含 20-bit 采样率。
	buf := make([]byte, 64)
	copy(buf[0:4], "fLaC")
	buf[4] = 0x00 // 块类型 0 = STREAMINFO
	buf[18] = 0x0A
	buf[19] = 0xC4
	buf[20] = 0x40 // 0x0AC440 >> 4 = 44100
	if got := parseFlacSampleRate(buf); got != 44100 {
		t.Errorf("采样率 = %d，期望 44100", got)
	}

	bad := append([]byte{}, buf...)
	copy(bad[0:4], "OggS")
	if got := parseFlacSampleRate(bad); got != 0 {
		t.Errorf("非 FLAC 应返回 0，实际 %d", got)
	}
	if got := parseFlacSampleRate(buf[:20]); got != 0 {
		t.Errorf("长度不足应返回 0，实际 %d", got)
	}
	// 块类型非 STREAMINFO（buf[4] 低 7 位 != 0）
	other := append([]byte{}, buf...)
	other[4] = 0x01
	if got := parseFlacSampleRate(other); got != 0 {
		t.Errorf("非 STREAMINFO 块应返回 0，实际 %d", got)
	}
}

func TestValidateAudioURL(t *testing.T) {
	cases := []struct {
		raw    string
		want   string
		wantOK bool
	}{
		{"http://m801.music.126.net/a.mp3", "https://m801.music.126.net/a.mp3", true},
		{"https://music.126.net/a.flac", "https://music.126.net/a.flac", true},
		{"https://evil.example.com/a.mp3", "", false},
		{"not-a-url", "", false},
	}
	for _, c := range cases {
		got, ok := ValidateAudioURL(c.raw)
		if ok != c.wantOK || got != c.want {
			t.Errorf("ValidateAudioURL(%q) = (%q,%v)，期望 (%q,%v)", c.raw, got, ok, c.want, c.wantOK)
		}
	}
}

// TestForwardPassesParams 覆盖转发层最容易被改坏的两件事：
// 客户端传的登录态必须被丢弃、其余参数原样到达路由表。
func TestForwardPassesParams(t *testing.T) {
	// /echo 只在测试里存在：原样把参数表当成上游参数，便于断言。
	routes["/echo"] = route{crypto: cryptoAPI, build: func(p params) (string, map[string]any) {
		out := make(map[string]any, len(p))
		for key, value := range p {
			out[key] = value
		}
		return "/api/echo", out
	}}
	t.Cleanup(func() { delete(routes, "/echo") })

	var seen []Call
	service := newTestService(funcCaller(func(_ context.Context, call Call) (*upstreamResult, error) {
		seen = append(seen, call)
		raw, _ := json.Marshal(map[string]any{"path": call.Path, "cookie": call.Cookie, "data": call.Data})
		return &upstreamResult{Body: raw}, nil
	}))

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/music/ncm/echo?cookie=evil&noCookie=1&x=2", nil)
	service.Forward(recorder, request, "/echo?cookie=evil&noCookie=1&x=2", 0)
	if recorder.Code != http.StatusOK {
		t.Fatalf("状态码 = %d，响应 = %s", recorder.Code, recorder.Body.String())
	}
	payload := lastCallPayload(t, seen, recorder)
	if payload["path"] != "/api/echo" {
		t.Errorf("上游路径 = %v", payload["path"])
	}
	if payload["cookie"] != "" {
		t.Errorf("游客不该注入 cookie，实际 %q", payload["cookie"])
	}
	data, _ := payload["data"].(map[string]any)
	if _, present := data["cookie"]; present {
		t.Error("query 里的 cookie 应被剥掉")
	}
	if _, present := data["noCookie"]; present {
		t.Error("query 里的 noCookie 应被剥掉")
	}
	if data["x"] != "2" {
		t.Errorf("其余参数应保留，实际 %v", data)
	}

	// POST body 里的 cookie / noCookie 也要剥掉
	seen = nil
	recorder = httptest.NewRecorder()
	request = httptest.NewRequest(http.MethodPost, "/api/music/ncm/echo", bytes.NewBufferString(`{"cookie":"evil","noCookie":1,"a":2}`))
	request.Header.Set("Content-Type", "application/json")
	service.Forward(recorder, request, "/echo", 0)
	if recorder.Code != http.StatusOK {
		t.Fatalf("POST 状态码 = %d", recorder.Code)
	}
	payload = lastCallPayload(t, seen, recorder)
	data, _ = payload["data"].(map[string]any)
	if _, present := data["cookie"]; present {
		t.Error("body 里的 cookie 应被剥掉")
	}
	if _, present := data["noCookie"]; present {
		t.Error("body 里的 noCookie 应被剥掉")
	}
	if data["a"] != "2" {
		t.Errorf("其余字段应保留，实际 %v", data)
	}
}

// lastCallPayload 取出响应体里的回显结构。
func lastCallPayload(t *testing.T, calls []Call, recorder *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	if len(calls) == 0 {
		t.Fatalf("没有调用上游，响应 = %s", recorder.Body.String())
	}
	var payload map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("响应不是 JSON: %s", recorder.Body.String())
	}
	return payload
}

func TestForwardRejectsOtherMethods(t *testing.T) {
	service := newTestService(&stubCaller{})
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPut, "/api/music/ncm/echo", nil)
	service.Forward(recorder, request, "/echo", 0)
	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("状态码 = %d，期望 405", recorder.Code)
	}
}

func TestForwardUnknownPath(t *testing.T) {
	service := newTestService(&stubCaller{})
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/music/ncm/not-a-real-endpoint", nil)
	service.Forward(recorder, request, "/not-a-real-endpoint", 0)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("状态码 = %d，期望 404", recorder.Code)
	}
	if !strings.Contains(recorder.Body.String(), "接口不存在") {
		t.Errorf("响应 = %s", recorder.Body.String())
	}
}

func TestResolveSongURLAlongChain(t *testing.T) {
	// 试听片段（freeTrialInfo 非空）必须被跳过，继续降级到 exhigh。
	service := newTestService(funcCaller(func(_ context.Context, call Call) (*upstreamResult, error) {
		level, _ := call.Data["level"].(string)
		if level == "lossless" {
			return &upstreamResult{Body: []byte(`{"data":[{"url":"https://m801.music.126.net/a.flac","level":"lossless","freeTrialInfo":{"start":0,"end":30}}]}`)}, nil
		}
		return &upstreamResult{Body: []byte(`{"data":[{"url":"https://m801.music.126.net/a.mp3","level":"` + level + `","br":320000,"type":"mp3","sr":44100}]}`)}, nil
	}))

	resolved, lastData := service.ResolveSongURLAlongChain(context.Background(), 1, QualityLevels("lossless"), "")
	if resolved == nil || resolved["level"] != "exhigh" {
		t.Fatalf("resolved = %v（lastData = %v）", resolved, lastData)
	}
}

func TestResolveSongURLLegacyFallback(t *testing.T) {
	// v1 拿不到 data → 必须回退老接口，并补写 level。
	service := newTestService(funcCaller(func(_ context.Context, call Call) (*upstreamResult, error) {
		if _, legacy := call.Data["br"]; legacy {
			return &upstreamResult{Body: []byte(`{"data":[{"url":"https://m801.music.126.net/legacy.mp3","br":320000,"type":"mp3"}]}`)}, nil
		}
		return &upstreamResult{Body: []byte(`{"data":[]}`)}, nil
	}))

	resolved, _ := service.ResolveSongURLAlongChain(context.Background(), 2, []string{"exhigh"}, "")
	if resolved == nil {
		t.Fatal("应回退老接口拿到地址")
	}
	if resolved["level"] != "exhigh" {
		t.Errorf("老接口响应要补写 level，实际 %v", resolved["level"])
	}
}

func TestProxyAudioPassesThroughRange(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Range") != "bytes=0-3" {
			t.Errorf("Range 未透传: %q", r.Header.Get("Range"))
		}
		w.Header().Set("Content-Type", "audio/mpeg")
		w.Header().Set("Content-Range", "bytes 0-3/100")
		w.Header().Set("Content-Length", "4")
		w.WriteHeader(http.StatusPartialContent)
		_, _ = w.Write([]byte("abcd"))
	}))
	t.Cleanup(upstream.Close)

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/music/stream?songId=1", nil)
	request.Header.Set("Range", "bytes=0-3")
	ProxyAudio(recorder, request, upstream.URL+"/a.mp3")

	if recorder.Code != http.StatusPartialContent {
		t.Fatalf("状态码 = %d，期望 206", recorder.Code)
	}
	if recorder.Body.String() != "abcd" {
		t.Errorf("响应体 = %q", recorder.Body.String())
	}
	if got := recorder.Header().Get("Content-Range"); got != "bytes 0-3/100" {
		t.Errorf("Content-Range = %q", got)
	}
	if got := recorder.Header().Get("Accept-Ranges"); got != "bytes" {
		t.Errorf("Accept-Ranges = %q", got)
	}
}
