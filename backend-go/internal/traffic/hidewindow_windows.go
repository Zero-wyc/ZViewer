//go:build windows

package traffic

import (
	"os/exec"
	"syscall"
)

// hideWindow 避免 GUI 宿主下弹出控制台窗口（netstat 是控制台程序）。
func hideWindow(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.HideWindow = true
}
