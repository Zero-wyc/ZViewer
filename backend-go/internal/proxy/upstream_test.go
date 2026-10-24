package proxy

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// stubResolver 把 DNS 解析钉死，避免单测依赖真实网络。
//
// 这是一条重要的隔离：公网代理的 SSRF 拦截会调 DNS，
// 单测若真去解析域名，测试会随机失败在别人的 DNS 上。
func stubResolver(t *testing.T, internal []string, err error) {
	t.Helper()
	prev := resolveAddresses
	resolveAddresses = func(string) ([]string, error) { return internal, err }
	t.Cleanup(func() { resolveAddresses = prev })
}

// clientDialing 返回一个"总是拨到指定地址"的 client。
//
// 这样测试可以用公网域名当 URL（过 SSRF 检查），实际连的是本地 httptest。
func clientDialing(t *testing.T, server *httptest.Server) *http.Client {
	t.Helper()
	addr := strings.TrimPrefix(server.URL, "http://")
	return &http.Client{
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
				var d net.Dialer
				return d.DialContext(ctx, network, addr)
			},
		},
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

// runProxy 起一个 httptest 响应端，再把代理的响应写进 recorder。
func runProxy(t *testing.T, upstream http.Handler, req *http.Request, opts HTTPOptions) *httptest.ResponseRecorder {
	t.Helper()
	srv := httptest.NewServer(upstream)
	t.Cleanup(srv.Close)

	stubResolver(t, nil, nil)
	opts.URL = "http://media.example.com" + req.URL.Path
	if opts.Client == nil {
		opts.Client = clientDialing(t, srv)
	}
	rec := httptest.NewRecorder()
	ProxyHTTPUpstream(rec, req, opts)
	return rec
}

func TestProxyClampsOpenRangeAndPassesHeaders(t *testing.T) {
	var gotRange string
	upstream := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotRange = r.Header.Get("Range")
		w.Header().Set("Content-Range", "bytes 0-8388607/100000000")
		w.Header().Set("Content-Length", "10")
		w.Header().Set("ETag", `"abc"`)
		w.Header().Set("Content-Type", "video/mp4")
		w.WriteHeader(http.StatusPartialContent)
		_, _ = w.Write([]byte("0123456789"))
	})

	req := httptest.NewRequest(http.MethodGet, "/movie.mp4", nil)
	req.Header.Set("Range", "bytes=0-")
	rec := runProxy(t, upstream, req, HTTPOptions{LogTag: "test", ErrorMessage: "代理媒体失败"})

	if gotRange != "bytes=0-8388607" {
		t.Fatalf("开放式 Range 应收敛为 8MiB 分片，上游实际收到 %q", gotRange)
	}
	if rec.Code != http.StatusPartialContent {
		t.Fatalf("期望 206，实际 %d", rec.Code)
	}
	if got := rec.Header().Get("Content-Range"); got != "bytes 0-8388607/100000000" {
		t.Fatalf("Content-Range 未透传: %q", got)
	}
	if got := rec.Header().Get("ETag"); got != `"abc"` {
		t.Fatalf("ETag 未透传: %q", got)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "*" {
		t.Fatalf("缺通配 CORS: %q", got)
	}
	if got := rec.Header().Get("X-Accel-Buffering"); got != "no" {
		t.Fatalf("缺 X-Accel-Buffering: %q", got)
	}
	if got := rec.Body.String(); got != "0123456789" {
		t.Fatalf("正文不正确: %q", got)
	}
}

func TestProxyKeepsExplicitRange(t *testing.T) {
	var gotRange string
	upstream := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotRange = r.Header.Get("Range")
		w.WriteHeader(http.StatusPartialContent)
	})
	req := httptest.NewRequest(http.MethodGet, "/seg.m4s", nil)
	req.Header.Set("Range", "bytes=1048576-15728640")
	runProxy(t, upstream, req, HTTPOptions{LogTag: "test", ErrorMessage: "e"})

	if gotRange != "bytes=1048576-15728640" {
		t.Fatalf("显式 Range 不得截断，上游实际收到 %q", gotRange)
	}
}

func TestProxyForwardsClientHeaders(t *testing.T) {
	var snapshot http.Header
	upstream := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		snapshot = r.Header.Clone()
		w.WriteHeader(http.StatusOK)
	})
	req := httptest.NewRequest(http.MethodGet, "/x.mp4", nil)
	opts := HTTPOptions{
		LogTag:       "test",
		ErrorMessage: "e",
		Headers: UpstreamHeaders{
			Referer:   "https://anime.example.com/",
			Origin:    "https://anime.example.com",
			UserAgent: "custom-ua",
			Cookie:    "sid=1",
		},
	}
	runProxy(t, upstream, req, opts)

	if got := snapshot.Get("Referer"); got != "https://anime.example.com/" {
		t.Fatalf("Referer 未透传: %q", got)
	}
	if got := snapshot.Get("Origin"); got != "https://anime.example.com" {
		t.Fatalf("Origin 未透传: %q", got)
	}
	if got := snapshot.Get("User-Agent"); got != "custom-ua" {
		t.Fatalf("User-Agent 未透传: %q", got)
	}
	if got := snapshot.Get("Cookie"); got != "sid=1" {
		t.Fatalf("Cookie 未透传: %q", got)
	}
}

func TestProxyDefaultUserAgent(t *testing.T) {
	var ua string
	upstream := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ua = r.Header.Get("User-Agent")
		w.WriteHeader(http.StatusOK)
	})
	req := httptest.NewRequest(http.MethodGet, "/x.mp4", nil)
	runProxy(t, upstream, req, HTTPOptions{LogTag: "test", ErrorMessage: "e"})
	if ua != DefaultProxyUA {
		t.Fatalf("缺省 UA 不对: %q", ua)
	}
}

func TestProxyNon2xxPassesStatusWithoutBody(t *testing.T) {
	upstream := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Range", "bytes */12345")
		w.Header().Set("Content-Length", "999")
		w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
		_, _ = w.Write([]byte(strings.Repeat("x", 999)))
	})
	req := httptest.NewRequest(http.MethodGet, "/x.mp4", nil)
	rec := runProxy(t, upstream, req, HTTPOptions{LogTag: "test", ErrorMessage: "e"})

	if rec.Code != http.StatusRequestedRangeNotSatisfiable {
		t.Fatalf("期望 416 透传，实际 %d", rec.Code)
	}
	// 416 的 Content-Range 必须透传，否则客户端不知道真实大小
	if got := rec.Header().Get("Content-Range"); got != "bytes */12345" {
		t.Fatalf("Content-Range 未透传: %q", got)
	}
	// 正文不转发：长度按 0 回，否则客户端会等 999 字节
	if got := rec.Header().Get("Content-Length"); got != "0" {
		t.Fatalf("错误响应 Content-Length 应为 0，实际 %q", got)
	}
	if rec.Body.Len() != 0 {
		t.Fatalf("错误响应不应带正文，实际 %d 字节", rec.Body.Len())
	}
}

func TestProxyFixesJsonContentType(t *testing.T) {
	upstream := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("binary-video-bytes"))
	})
	req := httptest.NewRequest(http.MethodGet, "/x.mp4", nil)
	rec := runProxy(t, upstream, req, HTTPOptions{
		LogTag: "test", ErrorMessage: "e", DefaultContentType: "video/mp4",
	})
	if got := rec.Header().Get("Content-Type"); got != "video/mp4" {
		t.Fatalf("application/json 应被纠正为 video/mp4，实际 %q", got)
	}
}

func TestProxyRewritesHLS(t *testing.T) {
	playlist := "#EXTM3U\n" +
		"#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"\n" +
		"#EXTINF:4.0,\n" +
		"seg-1.ts\n" +
		"\n" +
		"#EXTINF:4.0,\n" +
		"https://cdn.example.com/seg-2.ts\n"
	upstream := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, playlist)
	})
	req := httptest.NewRequest(http.MethodGet, "/index.m3u8", nil)
	rec := runProxy(t, upstream, req, HTTPOptions{
		LogTag:       "test",
		ErrorMessage: "e",
		RewriteHLSUri: func(uri, playlistURL string) string {
			if strings.HasPrefix(uri, "http") {
				return uri
			}
			return "/api/proxy?url=" + uri
		},
	})

	body := rec.Body.String()
	want := []string{
		"#EXT-X-KEY:METHOD=AES-128,URI=\"/api/proxy?url=key.bin\"",
		"/api/proxy?url=seg-1.ts",
		"https://cdn.example.com/seg-2.ts", // 绝对地址不再包装
		"#EXTM3U",
	}
	for _, w := range want {
		if !strings.Contains(body, w) {
			t.Fatalf("改写结果缺少 %q，实际:\n%s", w, body)
		}
	}
	if got := rec.Header().Get("Cache-Control"); got != "private, no-store" {
		t.Fatalf("播放列表不应被缓存，实际 Cache-Control=%q", got)
	}
}

func TestProxyTimeoutReturns504(t *testing.T) {
	upstream := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(300 * time.Millisecond)
		w.WriteHeader(http.StatusOK)
	})
	req := httptest.NewRequest(http.MethodGet, "/slow.mp4", nil)
	start := time.Now()
	rec := runProxy(t, upstream, req, HTTPOptions{LogTag: "test", ErrorMessage: "代理媒体失败", TimeoutMs: 50})
	elapsed := time.Since(start)

	if rec.Code != http.StatusGatewayTimeout {
		t.Fatalf("期望 504，实际 %d（%s）", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "上游请求超时") {
		t.Fatalf("504 文案不对: %s", rec.Body.String())
	}
	if elapsed > 250*time.Millisecond {
		t.Fatalf("超时未生效，耗时 %v", elapsed)
	}
}

func TestProxyRejectsInternalTarget(t *testing.T) {
	// 字面量内网目标：PublicOnly 下必须在发起请求前就拒掉
	resolveAddresses = func(string) ([]string, error) { return nil, nil }
	t.Cleanup(func() { resolveAddresses = nil })
	prev := resolveAddresses

	req := httptest.NewRequest(http.MethodGet, "/x.mp4", nil)
	rec := httptest.NewRecorder()
	ProxyHTTPUpstream(rec, req, HTTPOptions{
		URL:          "http://127.0.0.1:9/secret",
		PublicOnly:   true,
		LogTag:       "test",
		ErrorMessage: "代理媒体失败",
	})
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("期望 502，实际 %d", rec.Code)
	}
	_ = prev
}

func TestProxyRejectsInternalRedirect(t *testing.T) {
	upstream := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Location", "http://127.0.0.1:9/internal")
		w.WriteHeader(http.StatusFound)
	})
	req := httptest.NewRequest(http.MethodGet, "/x.mp4", nil)
	rec := runProxy(t, upstream, req, HTTPOptions{
		LogTag: "test", ErrorMessage: "代理媒体失败", PublicOnly: true,
	})
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("重定向到内网应 502，实际 %d（%s）", rec.Code, rec.Body.String())
	}
}

func TestProxyFollowsPublicRedirect(t *testing.T) {
	upstream := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/old.mp4" {
			w.Header().Set("Location", "/new.mp4")
			w.WriteHeader(http.StatusFound)
			return
		}
		w.Header().Set("Content-Type", "video/mp4")
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "final-bytes")
	})
	req := httptest.NewRequest(http.MethodGet, "/old.mp4", nil)
	rec := runProxy(t, upstream, req, HTTPOptions{
		LogTag: "test", ErrorMessage: "代理媒体失败", PublicOnly: true,
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("期望 200，实际 %d（%s）", rec.Code, rec.Body.String())
	}
	if rec.Body.String() != "final-bytes" {
		t.Fatalf("跳转后正文不对: %q", rec.Body.String())
	}
}

func TestProxyCacheControlIncludesNoTransform(t *testing.T) {
	upstream := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	req := httptest.NewRequest(http.MethodGet, "/x.mp4", nil)
	rec := runProxy(t, upstream, req, HTTPOptions{
		LogTag: "test", ErrorMessage: "e", CacheControl: "private, max-age=360",
	})
	if got := rec.Header().Get("Cache-Control"); got != "private, max-age=360, no-transform" {
		t.Fatalf("Cache-Control 不对: %q", got)
	}
}

func TestProxyHeadReturnsHeadersOnly(t *testing.T) {
	upstream := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodHead {
			t.Errorf("代理应转发 HEAD，实际 %s", r.Method)
		}
		w.Header().Set("Content-Length", "1048576")
		w.Header().Set("Content-Type", "video/mp4")
		w.WriteHeader(http.StatusOK)
	})
	req := httptest.NewRequest(http.MethodHead, "/x.mp4", nil)
	rec := runProxy(t, upstream, req, HTTPOptions{LogTag: "test", ErrorMessage: "e"})

	if rec.Code != http.StatusOK {
		t.Fatalf("期望 200，实际 %d", rec.Code)
	}
	if got := rec.Header().Get("Content-Length"); got != "1048576" {
		t.Fatalf("HEAD 应保留上游表示长度，实际 %q", got)
	}
	if rec.Body.Len() != 0 {
		t.Fatalf("HEAD 不应有正文，实际 %d 字节", rec.Body.Len())
	}
}

func TestFormatBytes(t *testing.T) {
	cases := []struct {
		in   int64
		want string
	}{
		{512, "512B"},
		{2048, "2.0KB"},
		{3 << 20, "3.00MB"},
		{2 << 30, "2.00GB"},
	}
	for _, c := range cases {
		if got := formatBytes(c.in); got != c.want {
			t.Fatalf("formatBytes(%d) = %q, want %q", c.in, got, c.want)
		}
	}
}

var _ = fmt.Sprintf
