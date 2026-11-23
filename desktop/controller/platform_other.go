//go:build !windows

package controller

import (
	"os/exec"
	"regexp"
)

var regexpSID = regexp.MustCompile(`S-1-5-[\d-]+`)

func isWindows() bool { return false }

// backendExecutableName 返回后端可执行文件名（非 Windows 无扩展名）。
func backendExecutableName() string { return "zviewer-backend" }

func hideWindow(cmd *exec.Cmd) {}
