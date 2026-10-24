// Package netutil 提供内网地址判定与服务器 URL 规范化。
//
// 对应 Node 版 services/network-utils.ts。该文件的存在本身就是一条教训：
// 历史上 http-proxy / openlist-errors / webdav / emby-client 各自实现了一套
// 「内网判断」，语义互不一致（有的不认 localhost，有的不认 IPv6）。
// Go 侧同样只保留这一份，任何模块要判内网都必须调这里。
package netutil

import (
	"net"
	"net/url"
	"strings"
)

// IsInternalNetworkHost 判断主机名是否为内网/回环地址。
//
// 覆盖范围（与 network-utils.ts 逐条对齐）：
//   - IPv4: 0.0.0.0/8、127.0.0.0/8、10/8、172.16/12、192.168/16、169.254/16
//   - IPv6: ::、::1、fc00::/7（唯一本地）、fe80::/10（链路本地）
//   - IPv4 映射的 IPv6（::ffff:192.168.1.1）
//   - 主机名: localhost、*.localhost、*.local（mDNS）
//
// hostname 不含端口与协议。空字符串按"非内网"处理（调用方已做过参数校验）。
func IsInternalNetworkHost(hostname string) bool {
	host := strings.ToLower(strings.TrimSpace(hostname))
	host = strings.TrimPrefix(host, "[")
	host = strings.TrimSuffix(host, "]")
	host = strings.TrimSuffix(host, ".")
	if host == "" {
		return false
	}

	// Node 版用 /^0\./ 覆盖 0.0.0.0 与 0.x 整段
	if strings.HasPrefix(host, "0.") {
		return true
	}

	if host == "localhost" || strings.HasSuffix(host, ".localhost") || strings.HasSuffix(host, ".local") {
		return true
	}

	// IPv6 可能带 zone（fe80::1%eth0），剥掉再解析
	if idx := strings.IndexByte(host, '%'); idx >= 0 {
		host = host[:idx]
	}

	if ip := net.ParseIP(host); ip != nil {
		if ip.IsUnspecified() || ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() {
			return true
		}
		// IPv4 映射地址已被 To4 覆盖，但 Go 的 IsPrivate 对 4-in-6 的处理
		// 依赖内部 To4 判定，这里显式再兜一次，避免驱动版本差异带来行为漂移。
		if v4 := ip.To4(); v4 != nil {
			ip = v4
			if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsUnspecified() {
				return true
			}
		}
		// fc00::/7 唯一本地地址
		if len(ip) == net.IPv6len && ip[0]&0xfe == 0xfc {
			return true
		}
		return false
	}

	// 不是合法 IP：按主机名继续判断（localhost/.local 已在上面处理）
	return false
}

// IsInternalServerURL 判断服务器 URL 是否指向内网。
//
// 无协议前缀时按 http:// 处理，兼容用户输入 `192.168.1.5:8096` 这类裸地址。
// URL 解析失败返回 false（保守策略：不做强制限制，与 Node 版一致）。
func IsInternalServerURL(serverURL string) bool {
	raw := strings.TrimSpace(serverURL)
	if raw == "" {
		return false
	}
	if !hasScheme(raw) {
		raw = "http://" + raw
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return false
	}
	return IsInternalNetworkHost(parsed.Hostname())
}

// NormalizeServerURLWithScheme 规范化用户输入的服务器地址：
// 去空白、缺协议补 http://、去掉末尾多余斜杠。
//
// NAS 用户常省略协议，不补会让后续 url.Parse 失败或按相对路径处理。
func NormalizeServerURLWithScheme(serverURL string) string {
	normalized := strings.TrimSpace(serverURL)
	if normalized == "" {
		return normalized
	}
	if !hasScheme(normalized) {
		normalized = "http://" + normalized
	}
	// 只裁剪路径末尾的斜杠，不能把 "http://" 本身裁成 "http:"
	for strings.HasSuffix(normalized, "/") && !strings.HasSuffix(normalized, "://") {
		normalized = normalized[:len(normalized)-1]
	}
	return normalized
}

// hasScheme 等价于 Node 版的 /^[a-z][a-z0-9+.-]*:\/\//i。
func hasScheme(raw string) bool {
	idx := strings.Index(raw, "://")
	if idx <= 0 {
		return false
	}
	for i, c := range raw[:idx] {
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z':
		case i > 0 && (c >= '0' && c <= '9' || c == '+' || c == '.' || c == '-'):
		default:
			return false
		}
	}
	return true
}

// ResolveInternalAddresses 解析主机名并返回其中属于内网的地址。
//
// 用于 publicOnly 代理的 DNS 层 SSRF 拦截：只看 URL 里的字面主机名不够，
// 攻击者可以用一个解析到 127.0.0.1 的公网域名绕过。返回空切片表示全部安全。
func ResolveInternalAddresses(hostname string) ([]string, error) {
	host := strings.Trim(strings.TrimSpace(hostname), "[]")
	addrs, err := net.LookupIP(host)
	if err != nil {
		return nil, err
	}
	var internal []string
	for _, addr := range addrs {
		if IsInternalNetworkHost(addr.String()) {
			internal = append(internal, addr.String())
		}
	}
	return internal, nil
}
