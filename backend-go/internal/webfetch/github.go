package webfetch

import "strings"

// githubCDNBase 是公共 GitHub 加速代理（与系统设置里「CDN 加速」的默认地址一致）。
//
// 历史沿革：曾自建 `github.cdn.zero251.xyz`（域名替换式），该服务已下线，
// 现在统一用 gh-proxy.com 的前缀式代理。
const githubCDNBase = "https://gh-proxy.com"

// ProxyGitHubURL 把 GitHub 公开地址改写成加速代理地址；其余原样返回。
//
// 前缀式：原完整 URL 直接拼在代理域名之后。ani-subs 订阅与 Kazumi 规则都
// 托管在 raw.githubusercontent.com，国内直连不稳，这条改写是可用性前提。
func ProxyGitHubURL(raw string) string {
	if raw == "" {
		return raw
	}
	if strings.HasPrefix(raw, "https://github.com/") ||
		strings.HasPrefix(raw, "https://raw.githubusercontent.com/") ||
		strings.HasPrefix(raw, "https://api.github.com/") {
		return githubCDNBase + "/" + raw
	}
	return raw
}
