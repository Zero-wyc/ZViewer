//go:build !windows

package traffic

import "os/exec"

// hideWindow 在非 Windows 平台无需处理。
func hideWindow(cmd *exec.Cmd) {}
