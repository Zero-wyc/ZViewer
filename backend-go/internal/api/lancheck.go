package api

import (
	"net"
	"net/http"
	"strings"
)

// forwardedHeaders 是七层代理 / 隧道会加上的请求头。
// 只要出现其中之一，就说明这条请求不是「局域网直连」：
// Cloudflare Tunnel、EdgeOne、Nginx 反代都会带上它们。
var forwardedHeaders = []string{
	"Cf-Ray",
	"Cf-Connecting-Ip",
	"X-Forwarded-For",
	"X-Real-Ip",
	"X-Forwarded-Host",
	"Forwarded",
}

// isLANClient 判断请求是否来自「与后端同一局域网」的观看设备。
//
// 用途：FLV 拉流优先直连本机 NMS（/live），不要绕公网 relay。
// 判定顺序：
//  1. 带七层代理头 ⇒ 一定不是局域网（观众经隧道/反代进来）；
//  2. 回环地址 ⇒ 本机（桌面内嵌网页端、本机浏览器）；
//  3. 对端是私网地址且命中本机某张网卡的子网 ⇒ 局域网。
func isLANClient(r *http.Request) bool {
	if r == nil {
		return false
	}
	return isLANAddr(r.RemoteAddr, r.Header)
}

// isLANAddr 与 isLANClient 同语义，供没有 *http.Request 的调用方
// （Socket.IO 握手）使用：remoteAddr 取自握手首个 HTTP 请求。
func isLANAddr(remote string, headers http.Header) bool {
	for _, header := range forwardedHeaders {
		if headers != nil && strings.TrimSpace(headers.Get(header)) != "" {
			return false
		}
	}
	if host, _, err := net.SplitHostPort(remote); err == nil {
		remote = host
	}
	ip := net.ParseIP(strings.Trim(remote, "[]"))
	if ip == nil {
		return false
	}
	if ip.IsLoopback() {
		return true
	}
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return false
	}
	for _, addr := range addrs {
		ipnet, ok := addr.(*net.IPNet)
		if !ok || ipnet.IP.IsLoopback() {
			continue
		}
		if ipnet.Contains(ip) {
			return true
		}
	}
	return false
}
