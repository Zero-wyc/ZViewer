package livekit

import "net"

// cgnat 是运营商级 NAT 段（RFC 6598，100.64.0.0/10）。
// 没有端口映射时对外同样不可达，所以要和 RFC1918 一样被排除。
var cgnat = &net.IPNet{IP: net.IPv4(100, 64, 0, 0), Mask: net.CIDRMask(10, 32)}

// ProbePublicInterfaceIP 返回第一个看起来可以被外网访问的本机地址。
//
// 用途只有一个：决定要不要打「语音外网不可达」的警告。判据与 Node 版一致：
// 排除回环、链路本地、RFC1918 私网、IPv6 ULA（fc00::/7）与 CGNAT。
func ProbePublicInterfaceIP() net.IP {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return nil
	}
	for _, addr := range addrs {
		ipnet, ok := addr.(*net.IPNet)
		if !ok {
			continue
		}
		ip := ipnet.IP
		if ip == nil || ip.IsUnspecified() || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
			continue
		}
		if ip4 := ip.To4(); ip4 != nil && cgnat.Contains(ip4) {
			continue
		}
		// IsPrivate 覆盖 RFC1918 与 IPv6 ULA（fc00::/7）
		if ip.IsPrivate() {
			continue
		}
		return ip
	}
	return nil
}
