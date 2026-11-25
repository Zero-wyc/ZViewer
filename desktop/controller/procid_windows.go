//go:build windows

package controller

// 进程存活与终止（Windows）：OpenProcess + QueryFullProcessImageName。
// 不用 tasklist/taskkill：需要按 PID 精确操作，且控制台自己可能没有 shell。

import (
	"errors"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/windows"
)

// stillActive 是 GetExitCodeProcess 对「进程还在跑」返回的魔数（STILL_ACTIVE）。
// x/sys/windows 没有导出它，按 WinBase.h 的定义抄一份。
const stillActive = 0x103

func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		// ACCESS_DENIED 说明进程存在（只是权限不够查详情），按活着处理，
		// 否则系统账户跑的后端会被误判为已退出。
		return errors.Is(err, windows.ERROR_ACCESS_DENIED)
	}
	defer windows.CloseHandle(handle)
	var code uint32
	if err := windows.GetExitCodeProcess(handle, &code); err != nil {
		return false
	}
	return code == stillActive
}

func processMatches(pid int, name string) bool {
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		// 查不到映像名时不阻断：能读到 PID 且存活，已足够避免幽灵实例。
		return errors.Is(err, windows.ERROR_ACCESS_DENIED)
	}
	defer windows.CloseHandle(handle)
	buffer := make([]uint16, windows.MAX_PATH)
	size := uint32(len(buffer))
	if err := windows.QueryFullProcessImageName(handle, 0, &buffer[0], &size); err != nil {
		return false
	}
	exe := filepath.Base(windows.UTF16ToString(buffer[:size]))
	return strings.EqualFold(exe, name)
}

// terminatePID 直接 TerminateProcess。
//
// Windows 没有能被跨进程组投递的优雅停止信号：GenerateConsoleCtrlEvent 只能
// 作用于同控制台进程组，而后端是隐藏窗口的独立进程。后端写库走 SQLite WAL，
// 异常终止最多留 -wal 需要重放，不会把主库写坏。
func terminatePID(pid int) error {
	if pid <= 0 || !processAlive(pid) {
		return nil
	}
	handle, err := windows.OpenProcess(windows.PROCESS_TERMINATE|windows.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		if errors.Is(err, windows.ERROR_INVALID_PARAMETER) || errors.Is(err, windows.ERROR_ACCESS_DENIED) {
			return err
		}
		return err
	}
	defer windows.CloseHandle(handle)
	if err := windows.TerminateProcess(handle, 1); err != nil {
		return err
	}
	_, _ = windows.WaitForSingleObject(handle, uint32((10 * time.Second).Milliseconds()))
	return nil
}
