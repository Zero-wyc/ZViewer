//go:build linux

package livekit

import (
	"os/exec"
	"syscall"
)

// prepareCmd 设置 Pdeathsig：父进程无论怎么死（包括 SIGKILL），
// 内核都会给子进程发 SIGKILL。Linux 上这是唯一能覆盖强杀场景的机制。
func prepareCmd(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGKILL}
}

// afterStart 在 Linux 上不需要额外动作（Pdeathsig 已覆盖）。
func afterStart(cmd *exec.Cmd) error { return nil }
