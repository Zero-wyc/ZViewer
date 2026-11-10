package webdav

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"zviewer/backend/internal/proxy"
)

// newFileServer 模拟一台支持 Range 的 WebDAV：只认 GET，PROPFIND 会被
// 记进 methods（用来断言首播没有多一次 stat 往返）。
func newFileServer(t *testing.T, size int64) (*httptest.Server, *[]string, *[]string) {
	t.Helper()
	var methods []string
	var ranges []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		methods = append(methods, r.Method)
		if r.Method == "PROPFIND" {
			// 只为对照路径服务：给出真实的 getcontentlength，其余字段留空。
			w.Header().Set("Content-Type", "application/xml; charset=utf-8")
			w.WriteHeader(http.StatusMultiStatus)
			_, _ = io.WriteString(w, `<?xml version="1.0" encoding="utf-8"?>`+
				`<d:multistatus xmlns:d="DAV:"><d:response><d:href>`+r.URL.Path+
				`</d:href><d:propstat><d:prop><d:getcontentlength>`+
				strconv.FormatInt(size, 10)+`</d:getcontentlength><d:resourcetype/>`+
				`</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>`+
				`</d:response></d:multistatus>`)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		ranges = append(ranges, r.Header.Get("Range"))
		start, end := int64(0), size-1
		if raw := r.Header.Get("Range"); raw != "" {
			spec := strings.TrimPrefix(raw, "bytes=")
			parts := strings.SplitN(spec, "-", 2)
			if s, err := strconv.ParseInt(parts[0], 10, 64); err == nil {
				start = s
			}
			if len(parts) == 2 && parts[1] != "" {
				if e, err := strconv.ParseInt(parts[1], 10, 64); err == nil && e < end {
					end = e
				}
			}
			if start >= size {
				w.Header().Set("Content-Range", "bytes */"+strconv.FormatInt(size, 10))
				w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
				return
			}
			w.Header().Set("Content-Range", "bytes "+strconv.FormatInt(start, 10)+"-"+
				strconv.FormatInt(end, 10)+"/"+strconv.FormatInt(size, 10))
			w.Header().Set("Content-Length", strconv.FormatInt(end-start+1, 10))
			w.Header().Set("Content-Type", "video/mp4")
			w.WriteHeader(http.StatusPartialContent)
			return
		}
		w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
		w.Header().Set("Content-Type", "video/mp4")
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)
	return srv, &methods, &ranges
}

// 首播的关键回归：只发一次 GET，不再先 PROPFIND。
func TestOpenStreamSkipsPropfind(t *testing.T) {
	const size int64 = 100 << 20
	srv, methods, ranges := newFileServer(t, size)

	stream, err := OpenStream(context.Background(),
		Params{ServerURL: srv.URL, Path: "/movies/a.mp4"},
		"bytes=0-", proxy.MaxRangeChunkBytes)
	if err != nil {
		t.Fatalf("OpenStream: %v", err)
	}
	defer stream.Body.Close()

	if len(*methods) != 1 || (*methods)[0] != http.MethodGet {
		t.Fatalf("首播应只发 1 次 GET，实际 %v", *methods)
	}
	if got := (*ranges)[0]; got != "bytes=0-8388607" {
		t.Errorf("开放式 Range 应收敛为 8MiB 分片，实际 %q", got)
	}
	if !stream.Ranged {
		t.Error("上游 206 时应标记 Ranged")
	}
	if stream.Total != size {
		t.Errorf("总长应取自 Content-Range，实际 %d", stream.Total)
	}
	if stream.Start != 0 || stream.End != proxy.MaxRangeChunkBytes-1 {
		t.Errorf("区间应来自上游，实际 %d-%d", stream.Start, stream.End)
	}
	if stream.ContentType != "video/mp4" {
		t.Errorf("Content-Type 应透传上游，实际 %q", stream.ContentType)
	}
}

func TestOpenStreamKeepsExplicitRange(t *testing.T) {
	srv, _, ranges := newFileServer(t, 10<<20)

	stream, err := OpenStream(context.Background(),
		Params{ServerURL: srv.URL, Path: "/a.mp4"}, "bytes=1024-2047", 0)
	if err != nil {
		t.Fatalf("OpenStream: %v", err)
	}
	defer stream.Body.Close()

	if got := (*ranges)[0]; got != "bytes=1024-2047" {
		t.Errorf("闭合 Range 应原样透传，实际 %q", got)
	}
	if stream.Start != 1024 || stream.End != 2047 {
		t.Errorf("区间应为 1024-2047，实际 %d-%d", stream.Start, stream.End)
	}
}

// 源站忽略 Range 直接回 200 时不能伪造成 206：否则客户端会从错误偏移解码。
func TestOpenStreamHonours200WhenServerIgnoresRange(t *testing.T) {
	const size int64 = 1 << 20
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
		w.Header().Set("Content-Type", "video/mp4")
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	stream, err := OpenStream(context.Background(),
		Params{ServerURL: srv.URL, Path: "/a.mp4"}, "bytes=0-", proxy.MaxRangeChunkBytes)
	if err != nil {
		t.Fatalf("OpenStream: %v", err)
	}
	defer stream.Body.Close()

	if stream.Ranged {
		t.Error("上游回 200 时不能声明 Ranged（会写出错位的 Content-Range）")
	}
	if stream.Total != size {
		t.Errorf("总长应取自 Content-Length，实际 %d", stream.Total)
	}
}

// 越界 Range 退化为一次全量请求，与 OpenRangeStream 的既有语义一致。
func TestOpenStreamFallsBackOn416(t *testing.T) {
	const size int64 = 1024
	srv, methods, ranges := newFileServer(t, size)

	stream, err := OpenStream(context.Background(),
		Params{ServerURL: srv.URL, Path: "/a.mp4"}, "bytes=999999-", 0)
	if err != nil {
		t.Fatalf("OpenStream: %v", err)
	}
	defer stream.Body.Close()

	if len(*methods) != 2 {
		t.Fatalf("416 后应重试一次全量请求，实际请求序列 %v", *methods)
	}
	if (*ranges)[1] != "" {
		t.Errorf("重试不应再带 Range，实际 %q", (*ranges)[1])
	}
	if stream.Ranged {
		t.Error("全量请求应标记为非 Ranged")
	}
}

func TestClampClientRange(t *testing.T) {
	const chunk int64 = 8 << 20
	cases := []struct {
		name  string
		input string
		chunk int64
		want  string
	}{
		{"无 Range", "", chunk, ""},
		{"开放式", "bytes=0-", chunk, "bytes=0-8388607"},
		{"有起始的开放式", "bytes=16777216-", chunk, "bytes=16777216-25165823"},
		{"小闭合区间原样", "bytes=100-199", chunk, "bytes=100-199"},
		{"大闭合区间收敛", "bytes=0-99999999", chunk, "bytes=0-8388607"},
		{"尾部区间收敛", "bytes=-99999999", chunk, "bytes=-8388608"},
		{"非法多段", "bytes=0-1,5-6", chunk, ""},
		{"非法格式", "items=0-1", chunk, ""},
		{"无上限", "bytes=0-", 0, "bytes=0-"},
	}
	for _, tc := range cases {
		if got := clampClientRange(tc.input, tc.chunk); got != tc.want {
			t.Errorf("%s: clampClientRange(%q)=%q，期望 %q", tc.name, tc.input, got, tc.want)
		}
	}
}

func TestParseContentRange(t *testing.T) {
	cases := []struct {
		in                string
		start, end, total int64
		ok                bool
	}{
		{"bytes 0-1023/4096", 0, 1023, 4096, true},
		{"bytes 10-19/*", 10, 19, 0, true},
		{"bytes */4096", 0, 0, 0, false},
		{"", 0, 0, 0, false},
		{"bytes 5-1/100", 0, 0, 0, false},
	}
	for _, tc := range cases {
		start, end, total, ok := parseContentRange(tc.in)
		if ok != tc.ok || start != tc.start || end != tc.end || total != tc.total {
			t.Errorf("parseContentRange(%q)=(%d,%d,%d,%v)，期望 (%d,%d,%d,%v)",
				tc.in, start, end, total, ok, tc.start, tc.end, tc.total, tc.ok)
		}
	}
}

// 首播往返数的直接对照：老路径（stat + GET）2 次，新路径 1 次。
//
// 这是本文件存在的核心目的——公网 NAS 上每次往返 100~300ms，
// 少一次就是少 0.1~0.3 秒的起播等待。
func TestFirstPlaybackRoundTrips(t *testing.T) {
	const size int64 = 100 << 20

	oldSrv, oldMethods, _ := newFileServer(t, size)
	oldStream, err := OpenRangeStream(context.Background(),
		Params{ServerURL: oldSrv.URL, Path: "/a.mp4"}, "bytes=0-", nil)
	if err != nil {
		t.Fatalf("OpenRangeStream: %v", err)
	}
	_ = oldStream.Body.Close()

	newSrv, newMethods, _ := newFileServer(t, size)
	newStream, err := OpenStream(context.Background(),
		Params{ServerURL: newSrv.URL, Path: "/a.mp4"}, "bytes=0-", proxy.MaxRangeChunkBytes)
	if err != nil {
		t.Fatalf("OpenStream: %v", err)
	}
	_ = newStream.Body.Close()

	if len(*oldMethods) != 2 {
		t.Fatalf("老路径应为 stat+GET 两次往返，实际 %v", *oldMethods)
	}
	if len(*newMethods) != 1 {
		t.Fatalf("新路径应只一次往返，实际 %v", *newMethods)
	}
}
