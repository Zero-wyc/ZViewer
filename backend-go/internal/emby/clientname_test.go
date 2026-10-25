package emby

import (
	"regexp"
	"strings"
	"testing"
)

// TestResolveClientName 覆盖 EMBY_CLIENT_NAME 的归一化规则（PR #27）。
func TestResolveClientName(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want string
	}{
		{"未设置回落默认", "", "ZViewer"},
		{"纯空格回落默认", "   ", "ZViewer"},
		{"去掉首尾空格", "  Emby Web  ", "Emby Web"},
		{"去掉双引号（避免截断键值）", `My "Client"`, "My Client"},
		{"去掉 CR/LF（避免非法头）", "Emby\r\nInjected: 1", "EmbyInjected: 1"},
		{"只有引号也回落默认", `""`, "ZViewer"},
		{"正常值原样使用", "SenPlayer", "SenPlayer"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := resolveClientName(c.raw); got != c.want {
				t.Errorf("resolveClientName(%q) = %q, want %q", c.raw, got, c.want)
			}
		})
	}
}

// TestAuthHeaderFromEnv 验证环境变量到请求头的整条链路。
func TestAuthHeaderFromEnv(t *testing.T) {
	t.Setenv("EMBY_CLIENT_NAME", "Emby Web")
	header := authHeaderFromEnv()
	if !strings.HasPrefix(header, `MediaBrowser Client="Emby Web", Device="Web Browser"`) {
		t.Errorf("客户端名未生效: %q", header)
	}

	t.Setenv("EMBY_CLIENT_NAME", "")
	header = authHeaderFromEnv()
	if !strings.HasPrefix(header, `MediaBrowser Client="ZViewer", Device="Web Browser"`) {
		t.Errorf("空值应回落默认: %q", header)
	}
}

// TestAuthHeaderShape 锁住头部的整体形状：Emby 按字段名解析，少一个都会退化成匿名会话。
func TestAuthHeaderShape(t *testing.T) {
	pattern := regexp.MustCompile(`^MediaBrowser Client="[^"]+", Device="[^"]+", DeviceId="zviewer-web-[0-9a-z]{10}", Version="[^"]+"$`)
	for _, name := range []string{"ZViewer", "Emby Web", "SenPlayer"} {
		if header := buildAuthHeader(name); !pattern.MatchString(header) {
			t.Errorf("头部形状不合法（client=%q）: %q", name, header)
		}
	}
}
