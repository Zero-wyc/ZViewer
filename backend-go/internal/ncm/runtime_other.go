//go:build !windows

package ncm

import "os/exec"

func prepareRuntime(cmd *exec.Cmd) {}
