package api

import (
	"net"
	"net/http/httptest"
	"testing"
)

func TestIsLANClientForwardedHeaders(t *testing.T) {
	r := httptest.NewRequest("GET", "/api/stream-push/watch/room", nil)
	r.RemoteAddr = "192.168.1.50:1000"
	r.Header.Set("Cf-Ray", "8f00000000000000-HKG")
	if isLANClient(r) {
		t.Fatal("带 Cloudflare 头的请求不应判成局域网")
	}
	r2 := httptest.NewRequest("GET", "/api/stream-push/watch/room", nil)
	r2.RemoteAddr = "127.0.0.1:1000"
	r2.Header.Set("X-Forwarded-For", "1.2.3.4")
	if isLANClient(r2) {
		t.Fatal("经反代的请求即使是回环来源也不应判成局域网")
	}
}

func TestIsLANClientLoopback(t *testing.T) {
	r := httptest.NewRequest("GET", "/api/stream-push/watch/room", nil)
	r.RemoteAddr = "127.0.0.1:1000"
	if !isLANClient(r) {
		t.Fatal("回环请求应判成局域网直连")
	}
	r6 := httptest.NewRequest("GET", "/api/stream-push/watch/room", nil)
	r6.RemoteAddr = "[::1]:1000"
	if !isLANClient(r6) {
		t.Fatal("IPv6 回环请求应判成局域网直连")
	}
}

func TestIsLANClientSameSubnet(t *testing.T) {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		t.Skipf("枚举网卡失败: %v", err)
	}
	for _, addr := range addrs {
		ipnet, ok := addr.(*net.IPNet)
		if !ok || ipnet.IP.IsLoopback() || ipnet.IP.To4() == nil {
			continue
		}
		ip := append(net.IP(nil), ipnet.IP.To4()...)
		ip[3]++
		if !ipnet.Contains(ip) {
			continue
		}
		r := httptest.NewRequest("GET", "/api/stream-push/watch/room", nil)
		r.RemoteAddr = ip.String() + ":1000"
		if !isLANClient(r) {
			t.Fatalf("同网段地址 %s 应判成局域网直连", ip)
		}
		return
	}
	t.Skip("没有可用的非回环 IPv4 网卡")
}
