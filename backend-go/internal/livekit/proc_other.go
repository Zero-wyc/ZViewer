//go:build !windows && !linux

package livekit

import "os/exec"

// prepareCmd 在 darwin/BSD 上没有等价的「父死子死」原语。
func prepareCmd(cmd *exec.Cmd) {}

// afterStart 同上；这类平台靠正常退出路径（Stop / ctx 取消）清理，
// 被强杀时可能残留一个 livekit 进程，需要手动结束。
func afterStart(cmd *exec.Cmd) error { return nil }
