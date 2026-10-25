package danmaku

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"zviewer/backend/internal/webfetch"
)

// 夹具比对：上游地址是硬编码的，没法起假站对拍；改成「同一份夹具 + Node 侧
// 生成的期望输出」。expected.json 由 scripts/gen-danmaku-fixtures.js 用 Node
// 的 provider 跑出来的，Go 侧只负责证明自己解析出一样的东西。

// fixtureTransport 按「host + path」返回 testdata 里的夹具。
type fixtureTransport struct {
	files map[string]string
}

func (f *fixtureTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	name, ok := f.files[req.URL.Host+req.URL.Path]
	if !ok {
		return &http.Response{
			StatusCode: http.StatusNotFound,
			Body:       io.NopCloser(strings.NewReader("not found")),
			Header:     http.Header{"Content-Type": []string{"text/plain"}},
			Request:    req,
		}, nil
	}
	raw, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		return nil, err
	}
	contentType := "text/html; charset=utf-8"
	if strings.HasSuffix(name, ".json") {
		contentType = "application/json; charset=utf-8"
	}
	return &http.Response{
		StatusCode: http.StatusOK,
		Body:       io.NopCloser(strings.NewReader(string(raw))),
		Header:     http.Header{"Content-Type": []string{contentType}},
		Request:    req,
	}, nil
}

func withFixtures(t *testing.T, routes map[string]string) {
	t.Helper()
	restore := webfetch.SetTransport(&fixtureTransport{files: routes})
	t.Cleanup(restore)
}

// loadExpected 读取 Node 侧生成的期望输出。
func loadExpected(t *testing.T) map[string]json.RawMessage {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", "expected.json"))
	if err != nil {
		t.Fatalf("读取期望输出失败: %v", err)
	}
	var payload map[string]struct {
		OK    json.RawMessage `json:"ok"`
		Error string          `json:"error"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatalf("解析期望输出失败: %v", err)
	}
	result := make(map[string]json.RawMessage, len(payload))
	for name, entry := range payload {
		if entry.Error != "" {
			t.Fatalf("期望输出里 %s 是错误: %s", name, entry.Error)
		}
		result[name] = entry.OK
	}
	return result
}

// assertSameJSON 比较两份 JSON 的语义（不看键顺序）。
func assertSameJSON(t *testing.T, name string, got any, want json.RawMessage) {
	t.Helper()
	gotRaw, err := json.Marshal(got)
	if err != nil {
		t.Fatalf("%s: 序列化失败: %v", name, err)
	}
	var gotValue, wantValue any
	if err := json.Unmarshal(gotRaw, &gotValue); err != nil {
		t.Fatalf("%s: 解析结果失败: %v", name, err)
	}
	if err := json.Unmarshal(want, &wantValue); err != nil {
		t.Fatalf("%s: 解析期望失败: %v", name, err)
	}
	if !reflect.DeepEqual(gotValue, wantValue) {
		t.Errorf("%s 与 Node 输出不一致\n  go  : %s\n  node: %s", name, string(gotRaw), string(want))
	}
}

func TestBahamutSearchFixture(t *testing.T) {
	expected := loadExpected(t)
	withFixtures(t, map[string]string{
		"ani.gamer.com.tw/search.php": "bahamut-search.html",
	})
	provider := &bahamutProvider{}
	results, err := provider.Search(context.Background(), "孤獨搖滾", Context{})
	if err != nil {
		t.Fatalf("搜索失败: %v", err)
	}
	assertSameJSON(t, "bahamut-search", results, expected["bahamut-search"])
}

func TestBahamutEpisodesFixture(t *testing.T) {
	expected := loadExpected(t)

	t.Run("多集", func(t *testing.T) {
		withFixtures(t, map[string]string{
			"ani.gamer.com.tw/animeRef.php": "bahamut-animeRef.html",
		})
		provider := &bahamutProvider{}
		episodes, err := provider.Episodes(context.Background(), "1234", Context{})
		if err != nil {
			t.Fatalf("取分集失败: %v", err)
		}
		assertSameJSON(t, "bahamut-episodes", episodes, expected["bahamut-episodes"])
	})

	t.Run("单集回落", func(t *testing.T) {
		withFixtures(t, map[string]string{
			"ani.gamer.com.tw/animeRef.php": "bahamut-single.html",
		})
		provider := &bahamutProvider{}
		episodes, err := provider.Episodes(context.Background(), "sn=7777", Context{})
		if err != nil {
			t.Fatalf("取分集失败: %v", err)
		}
		assertSameJSON(t, "bahamut-episodes-single", episodes, expected["bahamut-episodes-single"])
	})
}

func TestBahamutDanmakuFixture(t *testing.T) {
	expected := loadExpected(t)

	t.Run("数组", func(t *testing.T) {
		withFixtures(t, map[string]string{
			"ani.gamer.com.tw/ajax/danmuGet.php": "bahamut-danmu.json",
		})
		provider := &bahamutProvider{}
		items, err := provider.Danmaku(context.Background(), Episode{
			PlaybackParams: map[string]any{"sn": "1234"},
		}, Context{})
		if err != nil {
			t.Fatalf("取弹幕失败: %v", err)
		}
		assertSameJSON(t, "bahamut-danmaku", items, expected["bahamut-danmaku"])
	})

	t.Run("data 包装", func(t *testing.T) {
		withFixtures(t, map[string]string{
			"ani.gamer.com.tw/ajax/danmuGet.php": "bahamut-danmu-wrapped.json",
		})
		provider := &bahamutProvider{}
		items, err := provider.Danmaku(context.Background(), Episode{
			PlaybackParams: map[string]any{"sn": "5678"},
		}, Context{})
		if err != nil {
			t.Fatalf("取弹幕失败: %v", err)
		}
		assertSameJSON(t, "bahamut-danmaku-wrapped", items, expected["bahamut-danmaku-wrapped"])
	})
}

func TestDandanplaySearchFixture(t *testing.T) {
	expected := loadExpected(t)
	withFixtures(t, map[string]string{
		"api.dandanplay.net/api/v2/search/anime": "dandanplay-search.json",
	})
	provider := &dandanplayProvider{}
	results, err := provider.Search(context.Background(), "孤獨搖滾", Context{})
	if err != nil {
		t.Fatalf("搜索失败: %v", err)
	}
	assertSameJSON(t, "dandanplay-search", results, expected["dandanplay-search"])
}

func TestDandanplayEpisodesFixture(t *testing.T) {
	expected := loadExpected(t)
	provider := &dandanplayProvider{}

	t.Run("多集", func(t *testing.T) {
		withFixtures(t, map[string]string{
			"api.dandanplay.net/api/v2/bangumi/11": "dandanplay-bangumi.json",
		})
		episodes, err := provider.Episodes(context.Background(), "11", Context{})
		if err != nil {
			t.Fatalf("取分集失败: %v", err)
		}
		assertSameJSON(t, "dandanplay-episodes", episodes, expected["dandanplay-episodes"])
	})

	t.Run("空集回落", func(t *testing.T) {
		withFixtures(t, map[string]string{
			"api.dandanplay.net/api/v2/bangumi/12": "dandanplay-bangumi-empty.json",
		})
		episodes, err := provider.Episodes(context.Background(), "12", Context{})
		if err != nil {
			t.Fatalf("取分集失败: %v", err)
		}
		assertSameJSON(t, "dandanplay-episodes-empty", episodes, expected["dandanplay-episodes-empty"])
	})
}

func TestDandanplayDanmakuFixture(t *testing.T) {
	expected := loadExpected(t)
	withFixtures(t, map[string]string{
		"api.dandanplay.net/api/v2/comment/101": "dandanplay-comment.json",
	})
	provider := &dandanplayProvider{}
	items, err := provider.Danmaku(context.Background(), Episode{
		PlaybackParams: map[string]any{"animeId": float64(11), "episodeId": float64(101)},
	}, Context{})
	if err != nil {
		t.Fatalf("取弹幕失败: %v", err)
	}
	assertSameJSON(t, "dandanplay-danmaku", items, expected["dandanplay-danmaku"])
}

// ===========================================================================
// 纯函数
// ===========================================================================

func TestParseIntPrefix(t *testing.T) {
	// JS 的 parseInt 只吃开头合法的数字，后面的垃圾不管。
	cases := []struct {
		raw    string
		base   int
		want   int64
		expect bool
	}{
		{raw: "12zz", base: 16, want: 18, expect: true},
		{raw: "#12zz", base: 16, want: 0, expect: false},
		{raw: " 42abc", base: 10, want: 42, expect: true},
		{raw: "abc", base: 10, want: 0, expect: false},
		{raw: "", base: 10, want: 0, expect: false},
	}
	for _, c := range cases {
		got, ok := parseIntPrefix(c.raw, c.base)
		if ok != c.expect || got != c.want {
			t.Errorf("parseIntPrefix(%q, %d) = %d/%v，期望 %d/%v", c.raw, c.base, got, ok, c.want, c.expect)
		}
	}
}

func TestExtractBvid(t *testing.T) {
	cases := []struct {
		input string
		want  string
	}{
		{input: "https://www.bilibili.com/video/BV1GJ411x7h7?p=2", want: "BV1GJ411x7h7"},
		{input: "BV1GJ411x7h7", want: "BV1GJ411x7h7"},
		{input: "av12345", want: "12345"},
		{input: "随便一个词", want: ""},
	}
	for _, c := range cases {
		if got := extractBvid(c.input); got != c.want {
			t.Errorf("extractBvid(%q) = %q，期望 %q", c.input, got, c.want)
		}
	}
}

func TestExtractSeasonID(t *testing.T) {
	cases := []struct {
		input string
		want  string
	}{
		{input: "ss33378", want: "33378"},
		{input: "SS33378", want: "33378"},
		{input: "md28229056", want: "28229056"},
		{input: " 33378 ", want: "33378"},
		{input: "abc", want: ""},
		{input: "", want: ""},
	}
	for _, c := range cases {
		if got := extractSeasonID(c.input); got != c.want {
			t.Errorf("extractSeasonID(%q) = %q，期望 %q", c.input, got, c.want)
		}
	}
}

func TestDandanSignature(t *testing.T) {
	// 期望值来自 Node：base64(sha256(appId + "1700000000" + path + appSecret))，
	// 用的是内置凭证解出来的真实值（这里只放哈希，不放密钥）。
	got := buildDandanSignature(dandanAppIDForTest(t), dandanAppSecretForTest(t), "1700000000", "/api/v2/search/anime")
	const want = "w4uI6cFCd87YSZt+A3XusIwWJYiQZ1e3Hp3k7/zNmlI="
	if got != want {
		t.Errorf("签名 = %q，期望 %q", got, want)
	}
}

// dandanAppIDForTest / dandanAppSecretForTest 拿解出来的凭证（拿不到就跳过）。
func dandanAppIDForTest(t *testing.T) string {
	t.Helper()
	id, _, err := loadDandanCredentials()
	if err != nil {
		t.Skipf("凭证解密失败: %v", err)
	}
	return id
}

func dandanAppSecretForTest(t *testing.T) string {
	t.Helper()
	_, secret, err := loadDandanCredentials()
	if err != nil {
		t.Skipf("凭证解密失败: %v", err)
	}
	return secret
}

func TestDandanCredentialsDecrypt(t *testing.T) {
	id, secret, err := loadDandanCredentials()
	if err != nil {
		t.Fatalf("凭证解密失败: %v", err)
	}
	// 长度与 DevCenter 下发的一致（10 / 32）。
	if len(id) != 10 {
		t.Errorf("AppId 长度 = %d，期望 10", len(id))
	}
	if len(secret) != 32 {
		t.Errorf("AppSecret 长度 = %d，期望 32", len(secret))
	}
}

func TestMapDandanMode(t *testing.T) {
	// 弹弹play 的 1=底部、2=顶部，与统一格式**相反**。
	cases := map[int]int{0: 0, 1: 2, 2: 1, 3: 0, 9: 0}
	for raw, want := range cases {
		if got := mapDandanMode(raw); got != want {
			t.Errorf("mapDandanMode(%d) = %d，期望 %d", raw, got, want)
		}
	}
}

func TestParseCommentParams(t *testing.T) {
	_, mode, size, color := parseCommentParams("1.5,1,18,255,[0,0]")
	if mode != 2 || size != 18 || color != 255 {
		t.Errorf("解析结果 mode=%d size=%d color=%d", mode, size, color)
	}
	// 缺失 p 的整条回默认值。
	timeSeconds, mode, size, color := parseCommentParams(nil)
	if timeSeconds != 0 || mode != 0 || size != 25 || color != 0xffffff {
		t.Errorf("默认值 = %v/%d/%d/%d", timeSeconds, mode, size, color)
	}
	// size 为 0 视为非法，回 25。
	_, _, size, _ = parseCommentParams("1,0,0,0")
	if size != 25 {
		t.Errorf("size = %d，期望 25", size)
	}
}

func TestBahamutHelpers(t *testing.T) {
	if got := decodeHTMLEntities("A &amp; B &#39;x&#39;"); got != "A & B 'x'" {
		t.Errorf("实体解码 = %q", got)
	}
	if cover := normalizeBahamutCover("//a.com/x.jpg"); cover == nil || *cover != "https://a.com/x.jpg" {
		t.Errorf("协议相对封面 = %v", cover)
	}
	if cover := normalizeBahamutCover("/cover/1.jpg"); cover == nil || *cover != "https://ani.gamer.com.tw/cover/1.jpg" {
		t.Errorf("根相对封面 = %v", cover)
	}
	if cover := normalizeBahamutCover("   "); cover != nil {
		t.Errorf("空封面应返回 nil，得到 %v", cover)
	}
	if got := onlyDigits("sn=12ab34"); got != "1234" {
		t.Errorf("onlyDigits = %q", got)
	}
}
