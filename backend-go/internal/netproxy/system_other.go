//go:build !windows

package netproxy

// readSystemProxy 只在 Windows 上读注册表。
//
// macOS / Linux 的「系统代理」没有统一的读取方式（macOS 要跑 scutil，
// Linux 要看 GNOME/桌面环境），而这两个平台的用户本来就习惯用环境变量或
// 容器网络，所以这里只认环境变量，直连兜底。
func readSystemProxy() (bool, string, string, string) {
	return false, "", "", ""
}
