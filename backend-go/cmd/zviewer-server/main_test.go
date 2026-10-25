package main

import (
	"testing"

	"zviewer/backend/internal/config"
)

// 监听地址拼接。HOST="::" 是 start-prod.ps1 显式设置的（要双栈），
// 直接 fmt.Sprintf("%s:%d") 会拼出 ":::3333" 让 Listen 失败——服务压根起不来。
func TestListenAddr(t *testing.T) {
	cases := []struct {
		host string
		want string
	}{
		{"", ":3333"},                   // 不指定 host：双栈通配
		{"::", "[::]:3333"},             // IPv6 通配必须加方括号
		{"::1", "[::1]:3333"},           // IPv6 回环
		{"127.0.0.1", "127.0.0.1:3333"}, // IPv4 原样
		{"localhost", "localhost:3333"}, // 主机名原样
	}
	for _, c := range cases {
		cfg := &config.Config{Port: 3333, Host: c.host}
		if got := listenAddr(cfg); got != c.want {
			t.Errorf("listenAddr(host=%q) = %q, want %q", c.host, got, c.want)
		}
	}
}
