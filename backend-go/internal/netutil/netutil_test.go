package netutil

import "testing"

func TestIsInternalNetworkHost(t *testing.T) {
	cases := []struct {
		host string
		want bool
	}{
		// 回环 / 未指定
		{"127.0.0.1", true},
		{"127.1.2.3", true},
		{"0.0.0.0", true},
		{"0.1.2.3", true},
		{"::1", true},
		{"::", true},
		{"[::1]", true},
		// RFC1918
		{"10.0.0.1", true},
		{"172.16.0.1", true},
		{"172.31.255.254", true},
		{"172.32.0.1", false}, // 172.32 不在私有段内
		{"192.168.1.5", true},
		{"169.254.1.1", true},
		// IPv6 私有
		{"fc00::1", true},
		{"fd12:3456::1", true},
		{"fe80::1", true},
		{"fe80::1%eth0", true},
		// IPv4 映射
		{"::ffff:192.168.1.1", true},
		{"::ffff:127.0.0.1", true},
		{"::ffff:8.8.8.8", false},
		// 主机名
		{"localhost", true},
		{"api.localhost", true},
		{"nas.local", true},
		{"LOCALHOST", true},
		{"localhost.", true},
		// 公网
		{"8.8.8.8", false},
		{"1.1.1.1", false},
		{"example.com", false},
		{"upos-sz-mirrorcos.bilivideo.com", false},
		{"2408:8207::1", false},
		// 边界
		{"", false},
		{"...", false},
	}
	for _, c := range cases {
		if got := IsInternalNetworkHost(c.host); got != c.want {
			t.Errorf("IsInternalNetworkHost(%q) = %v, want %v", c.host, got, c.want)
		}
	}
}

func TestIsInternalServerURL(t *testing.T) {
	cases := []struct {
		url  string
		want bool
	}{
		{"http://127.0.0.1:8096/video", true},
		{"https://192.168.1.5/media.mp4", true},
		{"192.168.1.5:8096", true}, // 裸地址按 http 处理
		{"http://localhost:3333/x", true},
		{"https://example.com/a.mp4", false},
		{"https://upos-sz-mirrorcos.bilivideo.com/x.m4s", false},
		{"", false},
		{"not a url at all::", false},
	}
	for _, c := range cases {
		if got := IsInternalServerURL(c.url); got != c.want {
			t.Errorf("IsInternalServerURL(%q) = %v, want %v", c.url, got, c.want)
		}
	}
}

func TestNormalizeServerURLWithScheme(t *testing.T) {
	cases := []struct{ in, want string }{
		{"192.168.1.5:8096", "http://192.168.1.5:8096"},
		{"  192.168.1.5:8096/  ", "http://192.168.1.5:8096"},
		{"https://nas.local/", "https://nas.local"},
		{"https://nas.local/emby///", "https://nas.local/emby"},
		{"http://", "http://"}, // 不能把协议本身裁掉
		{"", ""},
	}
	for _, c := range cases {
		if got := NormalizeServerURLWithScheme(c.in); got != c.want {
			t.Errorf("NormalizeServerURLWithScheme(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
