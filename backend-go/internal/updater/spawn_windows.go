//go:build windows

package updater

import (
	"os/exec"
	"syscall"

	"golang.org/x/sys/windows"
)

// spawnScript 以 detached 方式拉起更新脚本。
//
// 为什么必须 detached：脚本第一步就是 taskkill 掉本进程。若留在同一个
// 进程组 / 控制台里，脚本会跟着一起被收走，更新就停在「杀完自己但没覆盖文件」
// 的状态。CREATE_NEW_PROCESS_GROUP 让它脱离本组的 Ctrl+C 传播，
// DETACHED_PROCESS 让它不共享控制台窗口。
//
// 不走 cmd /c start：start 会再包一层中转进程，taskkill /IM cmd.exe 之类的
// 兜底逻辑容易误伤，而且拿不到退出码。
func spawnScript(isWindows bool, scriptPath, root string) error {
	cmd := exec.Command("cmd", "/c", scriptPath)
	cmd.Dir = root
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: windows.CREATE_NEW_PROCESS_GROUP | windows.DETACHED_PROCESS,
		HideWindow:    true,
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	// 父进程马上会被脚本杀掉，不 Release 会留下一个永远等不到的僵尸句柄。
	return cmd.Process.Release()
}
