package ncm

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// 假 NCM 上游：把收到的请求原样回显，便于断言「注入了什么」。
func newFakeUpstream(t *testing.T, handler http.HandlerFunc) (*Service, *httptest.Server) {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	return NewService(nil, server.URL), server
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

func TestForwardPassthrough(t *testing.T) {
	service, upstream := newFakeUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/redirect"):
			w.Header().Set("Location", "/target")
			w.WriteHeader(http.StatusFound)
		case strings.HasSuffix(r.URL.Path, "/not-json"):
			w.Header().Set("Content-Type", "text/html")
			_, _ = w.Write([]byte("<html>nope</html>"))
		default:
			body, _ := io.ReadAll(r.Body)
			query := map[string]string{}
			for key, values := range r.URL.Query() {
				if key == "timestamp" {
					continue
				}
				query[key] = strings.Join(values, ",")
			}
			var parsed any
			if len(body) > 0 {
				_ = json.Unmarshal(body, &parsed)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"method": r.Method,
				"path":   r.URL.Path,
				"cookie": r.Header.Get("Cookie"),
				"query":  query,
				"body":   parsed,
			})
		}
	})
	_ = upstream

	// 客户端传的 cookie / noCookie 必须被剥掉
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/music/ncm/echo?cookie=evil&noCookie=1&x=2", nil)
	service.Forward(rec, req, "/echo?cookie=evil&noCookie=1&x=2", 0)
	if rec.Code != http.StatusOK {
		t.Fatalf("状态码 = %d，响应 = %s", rec.Code, rec.Body.String())
	}
	var echoed struct {
		Method string            `json:"method"`
		Path   string            `json:"path"`
		Cookie string            `json:"cookie"`
		Query  map[string]string `json:"query"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &echoed); err != nil {
		t.Fatalf("解析回显失败: %v", err)
	}
	if echoed.Path != "/echo" {
		t.Errorf("路径 = %q", echoed.Path)
	}
	if _, present := echoed.Query["cookie"]; present {
		t.Error("query 里的 cookie 应被剥掉")
	}
	if _, present := echoed.Query["noCookie"]; present {
		t.Error("query 里的 noCookie 应被剥掉")
	}
	if echoed.Query["x"] != "2" {
		t.Errorf("其余 query 应保留，实际 %v", echoed.Query)
	}
	if echoed.Cookie != "" {
		t.Errorf("游客不该注入 cookie，实际 %q", echoed.Cookie)
	}

	// POST body 里的 cookie / noCookie 也要剥掉
	rec = httptest.NewRecorder()
	payload := bytes.NewBufferString(`{"cookie":"evil","noCookie":1,"a":2}`)
	req = httptest.NewRequest(http.MethodPost, "/api/music/ncm/echo", payload)
	req.Header.Set("Content-Type", "application/json")
	service.Forward(rec, req, "/echo", 0)
	if rec.Code != http.StatusOK {
		t.Fatalf("POST 状态码 = %d", rec.Code)
	}
	var postEcho struct {
		Body map[string]any `json:"body"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &postEcho)
	if _, present := postEcho.Body["cookie"]; present {
		t.Error("body 里的 cookie 应被剥掉")
	}
	if _, present := postEcho.Body["noCookie"]; present {
		t.Error("body 里的 noCookie 应被剥掉")
	}
	if postEcho.Body["a"] != float64(2) {
		t.Errorf("其余字段应保留，实际 %v", postEcho.Body)
	}

	// 上游 3xx → 200 + {code:'REDIRECT', location}
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/music/ncm/redirect", nil)
	service.Forward(rec, req, "/redirect", 0)
	if rec.Code != http.StatusOK {
		t.Fatalf("重定向状态码 = %d", rec.Code)
	}
	var redirect map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &redirect)
	if redirect["code"] != "REDIRECT" || redirect["location"] != "/target" {
		t.Errorf("重定向响应 = %v", redirect)
	}

	// 上游非 JSON → 502
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/music/ncm/not-json", nil)
	service.Forward(rec, req, "/not-json", 0)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("非 JSON 状态码 = %d", rec.Code)
	}
}

func TestForwardRejectsOtherMethods(t *testing.T) {
	service := NewService(nil, "http://127.0.0.1:1")
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPut, "/api/music/ncm/echo", nil)
	service.Forward(rec, req, "/echo", 0)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("状态码 = %d，期望 405", rec.Code)
	}
}

func TestForwardUnavailable(t *testing.T) {
	service := NewService(nil, "")
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/music/ncm/echo", nil)
	service.Forward(rec, req, "/echo", 0)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("状态码 = %d，期望 503", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "NCM 服务未启动") {
		t.Errorf("响应 = %s", rec.Body.String())
	}
}

func TestResolveSongURLAlongChain(t *testing.T) {
	service, _ := newFakeUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		level := r.URL.Query().Get("level")
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasSuffix(r.URL.Path, "/song/url/v1"):
			if level == "lossless" {
				_, _ = w.Write([]byte(`{"data":[{"url":"https://m801.music.126.net/a.flac","level":"lossless","freeTrialInfo":{"start":0,"end":30}}]}`))
				return
			}
			_, _ = w.Write([]byte(`{"data":[{"url":"https://m801.music.126.net/a.mp3","level":"` + level + `","br":320000,"type":"mp3","sr":44100}]}`))
		default:
			// 老接口兜底：只在 lossless 档给地址
			br := r.URL.Query().Get("br")
			if br != "999000" {
				_, _ = w.Write([]byte(`{"data":[{"url":null}]}`))
				return
			}
			_, _ = w.Write([]byte(`{"data":[{"url":"https://m801.music.126.net/legacy.flac","br":999000}]}`))
		}
	})

	// 试听片段跳过、继续降级到 exhigh
	resolved, lastData := service.ResolveSongURLAlongChain(
		context.Background(), service.Base, 1, QualityLevels("lossless"), "")
	if resolved == nil || resolved["level"] != "exhigh" {
		t.Fatalf("resolved = %v（lastData = %v）", resolved, lastData)
	}
}

func TestResolveSongURLLegacyFallback(t *testing.T) {
	service, _ := newFakeUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if strings.HasSuffix(r.URL.Path, "/song/url/v1") {
			// v1 依赖残缺 → 404 非 JSON 结构，拿不到 data
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"code":404,"msg":"Not Found"}`))
			return
		}
		_, _ = w.Write([]byte(`{"data":[{"url":"https://m801.music.126.net/legacy.mp3","br":320000,"type":"mp3"}]}`))
	})

	resolved, _ := service.ResolveSongURLAlongChain(
		context.Background(), service.Base, 2, []string{"exhigh"}, "")
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

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/music/stream?songId=1", nil)
	req.Header.Set("Range", "bytes=0-3")
	ProxyAudio(rec, req, upstream.URL+"/a.mp3")

	if rec.Code != http.StatusPartialContent {
		t.Fatalf("状态码 = %d，期望 206", rec.Code)
	}
	if rec.Body.String() != "abcd" {
		t.Errorf("响应体 = %q", rec.Body.String())
	}
	if got := rec.Header().Get("Content-Range"); got != "bytes 0-3/100" {
		t.Errorf("Content-Range = %q", got)
	}
	if got := rec.Header().Get("Accept-Ranges"); got != "bytes" {
		t.Errorf("Accept-Ranges = %q", got)
	}
}
