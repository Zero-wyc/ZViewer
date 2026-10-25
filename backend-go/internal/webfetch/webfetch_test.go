package webfetch

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
)

// roundTripFunc 让 http.RoundTripper 写成函数。
type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) { return f(req) }

func TestDecodeBody(t *testing.T) {
	utf8Body := []byte("中文")
	if got := DecodeBody(utf8Body, "application/json"); got != "中文" {
		t.Errorf("UTF-8 = %q", got)
	}
	// GB18030 的「中文」：未声明 charset 时靠嗅探回落。
	gbk := []byte{0xD6, 0xD0, 0xCE, 0xC4}
	if got := DecodeBody(gbk, "application/json"); got != "中文" {
		t.Errorf("无声明 GBK = %q，期望嗅探成中文", got)
	}
	if got := DecodeBody(gbk, "text/html; charset=gbk"); got != "中文" {
		t.Errorf("声明 GBK = %q", got)
	}
}

func TestFetchStripsAcceptEncoding(t *testing.T) {
	var seen http.Header
	restore := SetTransport(roundTripFunc(func(req *http.Request) (*http.Response, error) {
		seen = req.Header.Clone()
		return &http.Response{
			StatusCode: http.StatusOK,
			Body:       io.NopCloser(strings.NewReader("ok")),
			Header:     http.Header{"Content-Type": []string{"text/plain; charset=utf-8"}},
			Request:    req,
		}, nil
	}))
	t.Cleanup(restore)

	result := Fetch(context.Background(), "https://example.com/x", Options{
		Headers: map[string]string{
			"Accept-Encoding": "gzip, deflate, br",
			"User-Agent":      "UA/1",
		},
	})
	if !result.OK || result.Body != "ok" {
		t.Fatalf("结果 = %+v", result)
	}
	// 浏览器头里的 br 照抄给 Go 会拿到无法解压的二进制，必须剥掉。
	if got := seen.Get("Accept-Encoding"); got != "" {
		t.Errorf("Accept-Encoding = %q，期望被剥掉", got)
	}
	if seen.Get("User-Agent") != "UA/1" {
		t.Errorf("其他头应保留，实际 %v", seen)
	}
}

func TestIsCloudflareBlocked(t *testing.T) {
	cases := []struct {
		name    string
		status  int
		headers map[string]string
		want    bool
	}{
		{name: "403 + cloudflare", status: 403, headers: map[string]string{"server": "cloudflare"}, want: true},
		{name: "503 + cf-ray", status: 503, headers: map[string]string{"cf-ray": "abc"}, want: true},
		{name: "403 普通站", status: 403, headers: map[string]string{"server": "nginx"}, want: false},
		{name: "200 带 cf-ray", status: 200, headers: map[string]string{"cf-ray": "abc"}, want: false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := IsCloudflareBlocked(c.status, c.headers); got != c.want {
				t.Errorf("IsCloudflareBlocked(%d, %v) = %v，期望 %v", c.status, c.headers, got, c.want)
			}
		})
	}
}
