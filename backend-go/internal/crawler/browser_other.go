//go:build !windows

package crawler

import "syscall"

// sysProcAttr 非 Windows 平台无需额外属性。
func sysProcAttr() *syscall.SysProcAttr { return nil }
