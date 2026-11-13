package cms

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

// 采集站的分享页没有媒体扩展名，真链写在内联脚本里且各站变量名不同。
// 这里固定住三种真实形态，防止后续改动把「分享页还原」弄丢。
func TestResolvePlayablePage(t *testing.T) {
	cases := []struct {
		name    string
		body    string
		wantURL string
		wantFmt MediaFormat
	}{
		{
			name:    "const url 相对路径",
			body:    `<script>const vid = "abc"; const url = "/20250302/13121_74890305/index.m3u8?sign=b4c18b3f";</script>`,
			wantURL: "/20250302/13121_74890305/index.m3u8?sign=b4c18b3f",
			wantFmt: FormatHLS,
		},
		{
			name:    "var main 相对路径",
			body:    "<script>var main = \"/20220404/794_e47294f5/index.m3u8?sign=68f4afb9\"</script>",
			wantURL: "/20220404/794_e47294f5/index.m3u8?sign=68f4afb9",
			wantFmt: FormatHLS,
		},
		{
			name:    "JSON 转义的绝对地址",
			body:    `<script>{"url":"https:\/\/cdn.example.com\/a\/index.m3u8?sign=1"}</script>`,
			wantURL: "https://cdn.example.com/a/index.m3u8?sign=1",
			wantFmt: FormatHLS,
		},
		{
			name:    "HTML 实体转义的签名参数",
			body:    `<script>src="https://cdn.example.com/a/index.m3u8?sign=1&amp;t=2"</script>`,
			wantURL: "https://cdn.example.com/a/index.m3u8?sign=1&t=2",
			wantFmt: FormatHLS,
		},
		{
			name:    "mp4 直链",
			body:    `<script>const url = "/d/file/a/ep01.mp4"</script>`,
			wantURL: "/d/file/a/ep01.mp4",
			wantFmt: FormatMP4,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "text/html; charset=utf-8")
				_, _ = w.Write([]byte(tc.body))
			}))
			defer server.Close()

			pageURL := server.URL + "/share/abc123"
			got, format, ok := resolvePlayablePage(context.Background(), pageURL, nil)
			if !ok {
				t.Fatal("应当从分享页里还原出媒体地址")
			}
			want := tc.wantURL
			if want[0] == '/' {
				want = server.URL + want
			}
			if got != want {
				t.Fatalf("url=%q want=%q", got, want)
			}
			if format != tc.wantFmt {
				t.Fatalf("format=%q want=%q", format, tc.wantFmt)
			}
		})
	}
}

// 已经是媒体地址时不该多抓一次页面。
func TestResolvePlayablePageSkipsMedia(t *testing.T) {
	var hits int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits++
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	original := server.URL + "/a/index.m3u8"
	got, format, ok := resolvePlayablePage(context.Background(), original, nil)
	if !ok || got != original || format != FormatHLS {
		t.Fatalf("got=%q format=%q ok=%v", got, format, ok)
	}
	if hits != 0 {
		t.Fatalf("媒体地址不应触发页面抓取，hits=%d", hits)
	}
}

// 页面里找不到地址时返回 ok=false，调用方保持原值（不把错误升级成解析失败）。
func TestResolvePlayablePageNoMatch(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte(`<html><body>404 not found</body></html>`))
	}))
	defer server.Close()

	if _, _, ok := resolvePlayablePage(context.Background(), server.URL+"/share/x", nil); ok {
		t.Fatal("没有媒体地址时不应返回 ok")
	}
}
