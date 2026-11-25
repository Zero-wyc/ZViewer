//go:build !windows

package controller

// 进程存活与终止（非 Windows）：Linux / macOS 走 kill(2) 与 /proc。
// 这里刻意不引入 gopsutil：只用到三个调用，标准库足够。

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// processAlive 判断 PID 是否指向一个活着的进程。
// EPERM 也算活着：进程存在，只是当前用户没权限发信号。
func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, 0)
	if err == nil {
		return true
	}
	return errors.Is(err, syscall.EPERM)
}

// processMatches 用 /proc/<pid>/cmdline 确认这个 PID 还是后端，
// 防止 PID 被系统回收后误杀恰好拿到同一号码的其他进程。
func processMatches(pid int, name string) bool {
	raw, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/cmdline")
	if err != nil {
		// 没有 /proc（macOS）：无法校验，只能信任 runtime 文件与存活判断。
		if errors.Is(err, os.ErrNotExist) && !hasProcFS() {
			return true
		}
		return false
	}
	if len(raw) == 0 {
		return false
	}
	first := raw
	if index := bytes.IndexByte(first, 0); index >= 0 {
		first = first[:index]
	}
	exe := filepath.Base(strings.TrimSpace(string(first)))
	if strings.TrimSuffix(exe, ".exe") == strings.TrimSuffix(name, ".exe") {
		return true
	}
	return strings.Contains(string(raw), strings.TrimSuffix(name, ".exe"))
}

func hasProcFS() bool {
	_, err := os.Stat("/proc/self/cmdline")
	return err == nil
}

// terminatePID 先 SIGTERM，等 12 秒仍未退出再 SIGKILL。
// 后端收到 SIGTERM 会走优雅退出（停定时器、落盘、关库）。
func terminatePID(pid int) error {
	if pid <= 0 || !processAlive(pid) {
		return nil
	}
	if err := syscall.Kill(pid, syscall.SIGTERM); err != nil && !errors.Is(err, syscall.ESRCH) {
		return err
	}
	deadline := time.Now().Add(12 * time.Second)
	for time.Now().Before(deadline) {
		if !processAlive(pid) {
			return nil
		}
		time.Sleep(200 * time.Millisecond)
	}
	if err := syscall.Kill(pid, syscall.SIGKILL); err != nil && !errors.Is(err, syscall.ESRCH) {
		return err
	}
	return nil
}
