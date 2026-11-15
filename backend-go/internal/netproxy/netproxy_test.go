package netproxy

import (
	"net/url"
	"testing"
)

// TestParseProxyServerShared 覆盖 Windows 上最常见的一种写法：
// ProxyServer 只有一个地址，所有协议共用（Clash / v2rayN 默认就是这样）。
func TestParseProxyServerShared(t *testing.T) {
	settings := parseProxyServer("127.0.0.1:7890", "<local>")
	if settings.shared != "127.0.0.1:7890" {
		t.Fatalf("shared = %q", settings.shared)
	}
	addr, kind := settings.pick("https")
	if addr != "127.0.0.1:7890" || kind != "" {
		t.Fatalf("pick(https) = %q/%q", addr, kind)
	}
	// 共用地址时不带类别，proxyURL 会按 http 处理
	parsed, err := proxyURL(addr, kind)
	if err != nil {
		t.Fatalf("proxyURL: %v", err)
	}
	if parsed.String() != "http://127.0.0.1:7890" {
		t.Fatalf("代理 URL = %s", parsed)
	}
}

// TestParseProxyServerPerScheme 覆盖按协议分开写的形态。
//
// 关键点：Windows 上很多工具只写 `http=` 一行，https 请求必须能回落到它，
// 否则所有站点都会被当成「没配代理」而直连。
func TestParseProxyServerPerScheme(t *testing.T) {
	settings := parseProxyServer("http=1.2.3.4:8080;ftp=1.2.3.4:8081", "")
	if addr, kind := settings.pick("https"); addr != "1.2.3.4:8080" || kind != "http" {
		t.Fatalf("pick(https) 应回落到 http 项，得到 %q/%q", addr, kind)
	}
	settings = parseProxyServer("http=1.2.3.4:8080;https=1.2.3.4:8443", "")
	if addr, kind := settings.pick("https"); addr != "1.2.3.4:8443" || kind != "https" {
		t.Fatalf("pick(https) = %q/%q", addr, kind)
	}
	if addr, _ := settings.pick("http"); addr != "1.2.3.4:8080" {
		t.Fatalf("pick(http) = %q", addr)
	}
}

// TestParseProxyServerSocks SOCKS 项要转成 socks5 代理。
func TestParseProxyServerSocks(t *testing.T) {
	settings := parseProxyServer("socks=127.0.0.1:1080", "")
	addr, kind := settings.pick("https")
	parsed, err := proxyURL(addr, kind)
	if err != nil {
		t.Fatalf("proxyURL: %v", err)
	}
	if parsed.Scheme != "socks5" || parsed.Host != "127.0.0.1:1080" {
		t.Fatalf("代理 URL = %s", parsed)
	}
}

// TestProxyURLKeepsExplicitScheme ProxyServer 里已经带了协议前缀时要原样保留。
func TestProxyURLKeepsExplicitScheme(t *testing.T) {
	parsed, err := proxyURL("socks5://127.0.0.1:1080", "")
	if err != nil {
		t.Fatalf("proxyURL: %v", err)
	}
	if parsed.String() != "socks5://127.0.0.1:1080" {
		t.Fatalf("代理 URL = %s", parsed)
	}
}

// TestBypass 覆盖 ProxyOverride 的三种写法：<local>、通配、本域+子域。
func TestBypass(t *testing.T) {
	settings := parseProxyServer("127.0.0.1:7890", "<local>;*.internal.example.com;example.org;10.*")
	cases := []struct {
		host string
		want bool
	}{
		{"nas", true},                    // <local>：不含点的主机名
		{"nas.local", false},             // 含点就不是 local 了
		{"a.internal.example.com", true}, // *.internal.example.com
		// 星号写法连裸域一起匹配：与 Go 自己的 NO_PROXY 语义一致
		// （x/net/http/httpproxy 里 "*.foo.com" 也匹配 "foo.com"），
		// 排除规则宽松一点不会把人坑住，漏排除反而会让内网请求被代理。
		{"internal.example.com", true},
		{"example.org", true},     // 本域
		{"www.example.org", true}, // 子域
		{"notexample.org", false}, // 后缀要按「点」边界算
		{"10.1.2.3", true},        // 通配
		{"tvtfun.net", false},     // 其余一律走代理
	}
	for _, c := range cases {
		if got := settings.bypasses(c.host); got != c.want {
			t.Errorf("bypasses(%q) = %v，期望 %v", c.host, got, c.want)
		}
	}
}

// TestMatchHostEmpty pattern 或 host 为空时一律不匹配（别把「空串」当通配）。
func TestMatchHostEmpty(t *testing.T) {
	if matchHost("", "example.com") {
		t.Error("空 pattern 不该匹配")
	}
	if matchHost("example.com", "") {
		t.Error("空 host 不该匹配")
	}
}

// TestProxyable 只代理 http/https，其余 scheme 与空主机一律直连。
func TestProxyable(t *testing.T) {
	cases := []struct {
		raw  string
		want bool
	}{
		{"https://www.tvtfun.net/api", true},
		{"http://sub.creamycake.org/v1/css1.json", true},
		{"file:///C:/x.json", false},
		{"ftp://example.com/a", false},
		{"http://", false},
	}
	for _, c := range cases {
		parsed, err := url.Parse(c.raw)
		if err != nil {
			t.Fatalf("url.Parse(%q): %v", c.raw, err)
		}
		if got := proxyable(parsed); got != c.want {
			t.Errorf("proxyable(%q) = %v，期望 %v", c.raw, got, c.want)
		}
	}
	if proxyable(nil) {
		t.Error("nil URL 不该代理")
	}
}
