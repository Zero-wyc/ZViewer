//go:build !windows

package updater

import (
	"os/exec"
	"syscall"
)

// spawnScript 以 detached 方式拉起更新脚本。
//
// Setsid 新建会话与进程组：脚本的 STOP_SECTION 会用 pgrep -f 找
// zviewer-backend 逐个 kill，同组的话脚本自己也会被匹配到（部署路径里
// 常带 zviewer-backend 字样），SELF_PID 那层排除只是第二道保险。
func spawnScript(isWindows bool, scriptPath, root string) error {
	cmd := exec.Command("bash", scriptPath)
	cmd.Dir = root
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}
