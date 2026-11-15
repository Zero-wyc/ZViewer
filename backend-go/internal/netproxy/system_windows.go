//go:build windows

package netproxy

import "golang.org/x/sys/windows/registry"

// internetSettingsKey 是 IE / 系统代理所在的注册表位置。
//
// Clash、v2rayN、Shadowsocks 这些工具「设置为系统代理」就是写这里，
// 浏览器的代理设置读的也是这里。
const internetSettingsKey = `Software\Microsoft\Windows\CurrentVersion\Internet Settings`

// readSystemProxy 读取系统代理设置。
//
// 只读 HKCU：系统代理是每用户的设置，HKLM 那份是 IE 的旧默认值，读了反而
// 会用一份用户从未配过的代理。
//
// 返回 pac（AutoConfigURL）是给调用方留个判断依据：PAC 是脚本，Go 里没法
// 求值，有 PAC 但没 ProxyServer 时只能直连——记住这一点，别以为是代码没生效。
func readSystemProxy() (enabled bool, server, override, pac string) {
	key, err := registry.OpenKey(registry.CURRENT_USER, internetSettingsKey, registry.QUERY_VALUE)
	if err != nil {
		return false, "", "", ""
	}
	defer key.Close()

	if value, _, err := key.GetIntegerValue("ProxyEnable"); err == nil {
		enabled = value != 0
	}
	server, _, _ = key.GetStringValue("ProxyServer")
	override, _, _ = key.GetStringValue("ProxyOverride")
	pac, _, _ = key.GetStringValue("AutoConfigURL")
	return enabled, server, override, pac
}
