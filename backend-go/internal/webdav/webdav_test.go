package webdav

import "testing"

// NormalizePath 必须与 JS 的 encodeURIComponent 逐字节一致。
//
// 这条断言的价值在于「编码集合差异」：Go 的 url.PathEscape 会保留
// $&+,;=:@ 却转义 !*'()，JS 恰好相反。文件名带这些字符时，两端请求的
// 就不是同一个 URL——在真实 NAS 上表现为「Node 能播、Go 404」。
func TestNormalizePathMatchesEncodeURIComponent(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"补前导斜杠", "videos/a.mkv", "/videos/a.mkv"},
		{"空格编码为 %20", "/测试 影片.mp4", "/%E6%B5%8B%E8%AF%95%20%E5%BD%B1%E7%89%87.mp4"},
		{"已编码的路径不二次编码", "/a%20b/c.mkv", "/a%20b/c.mkv"},
		{"保留 !*'() 不转义", "/a!b*c'd(e)f", "/a!b*c'd(e)f"},
		{"$&+,;=:@ 需要转义", "/a$b&c+d,e;f=g:h@i", "/a%24b%26c%2Bd%2Ce%3Bf%3Dg%3Ah%40i"},
		{"根路径保持不变", "/", "/"},
		{"非法百分号按原样编码", "/a%zz", "/a%25zz"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := NormalizePath(tc.in); got != tc.want {
				t.Fatalf("NormalizePath(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

// hrefToPath 要剥掉 serverUrl 的 path 前缀。
//
// 不剥的话前端把 path 回传上来会变成 /dav/dav/folder1，PROPFIND 直接 404。
func TestHrefToPathStripsServerPrefix(t *testing.T) {
	cases := []struct {
		name      string
		href      string
		serverURL string
		want      string
	}{
		{"绝对 href + /dav 前缀", "http://host:5244/dav/folder1", "http://host:5244/dav", "/folder1"},
		{"相对 href + /dav 前缀", "/dav/folder1/", "http://host:5244/dav", "/folder1"},
		{"无 path 前缀", "/folder1", "http://host:5244", "/folder1"},
		{"百分号编码要解码", "/dav/%E6%B5%8B%E8%AF%95/a.mkv", "http://host/dav", "/测试/a.mkv"},
		{"根路径", "/dav/", "http://host/dav", "/"},
		{"空 href", "", "http://host/dav", "/"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := hrefToPath(tc.href, tc.serverURL); got != tc.want {
				t.Fatalf("hrefToPath(%q) = %q, want %q", tc.href, got, tc.want)
			}
		})
	}
}

// Latin1RoundTrip 复刻「历史乱码修复」的逆变换：
// UTF-8 字节按 Latin-1 重新解释（！ → ï¼\x81）。
func TestLatin1RoundTrip(t *testing.T) {
	got, ok := Latin1RoundTrip("！")
	if !ok {
		t.Fatalf("全角感叹号应该有逆变换候选")
	}
	want := string([]rune{0xEF, 0xBC, 0x81})
	if got != want {
		t.Fatalf("Latin1RoundTrip(！) = %q, want %q", got, want)
	}

	if _, ok := Latin1RoundTrip("plain.mkv"); ok {
		t.Fatalf("纯 ASCII 不应产生逆变换候选（结果与原串相同）")
	}
	if _, ok := Latin1RoundTrip(""); ok {
		t.Fatalf("空串不应产生候选")
	}
}

// DirectURL 只是拼接，不做编码以外的任何处理。
func TestDirectURL(t *testing.T) {
	got := DirectURL("http://host:5244/dav/", "/movies/a b.mkv")
	want := "http://host:5244/dav/movies/a%20b.mkv"
	if got != want {
		t.Fatalf("DirectURL = %q, want %q", got, want)
	}
}

// StatusForCode 与 mapMountErrorCodeToStatus 必须一致。
func TestStatusForCode(t *testing.T) {
	cases := map[string]int{
		CodeAuthFailed:  401,
		CodeNotFound:    404,
		CodeTimeout:     400,
		CodeTLSFailed:   400,
		CodeUnreachable: 400,
	}
	for code, want := range cases {
		if got := StatusForCode(code, 400); got != want {
			t.Fatalf("StatusForCode(%q) = %d, want %d", code, got, want)
		}
	}
}
