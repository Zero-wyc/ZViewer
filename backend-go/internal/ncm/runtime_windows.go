//go:build windows

package ncm

import (
	"os/exec"
	"syscall"
)

func prepareRuntime(cmd *exec.Cmd) { cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true} }
