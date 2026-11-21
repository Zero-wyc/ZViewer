//go:build windows

package crawler

import "syscall"

// sysProcAttr 让浏览器进程不弹控制台窗口。
func sysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
}
