//go:build windows

package livekit

import (
	"fmt"
	"os/exec"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// prepareCmd 让伴生进程不弹控制台窗口（与 Node 的 windowsHide: true 同义）。
func prepareCmd(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
}

// afterStart 把子进程挂进一个「父进程一死内核就杀」的 Job 对象。
//
// 为什么需要：父进程被 TerminateProcess 强杀（`taskkill /F`、任务管理器结束进程、
// 桌面壳崩溃）时，Go 的任何 defer / 信号处理都不会跑，从进程内部完全没有机会
// 清理子进程——实测会留下一个占着 3336/3333/3337 的孤儿 livekit，下次启动语音直接失败。
//
// JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE 的语义：job 的最后一个句柄关闭时杀掉所有成员。
// 父进程退出时内核关闭它的句柄，于是成员跟着死。
//
// job 句柄故意不关闭（进程退出时由内核回收）：显式关闭会立刻杀掉还在正常工作的
// livekit。失败不致命，降级为「只有正常退出一条路能清理」，因此只返回错误不计日志。
func afterStart(cmd *exec.Cmd) error {
	if cmd.Process == nil {
		return fmt.Errorf("进程未启动")
	}
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return err
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(
		job,
		windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)),
		uint32(unsafe.Sizeof(info)),
	); err != nil {
		_ = windows.CloseHandle(job)
		return err
	}
	proc, err := windows.OpenProcess(
		windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE,
		false,
		uint32(cmd.Process.Pid),
	)
	if err != nil {
		_ = windows.CloseHandle(job)
		return err
	}
	defer windows.CloseHandle(proc)
	// 桌面壳本身用 Job Object 托管后端，这里是嵌套 job：Windows 8+ 支持，
	// 极老系统会返回错误，此时只影响「强杀清理」这一条路径。
	return windows.AssignProcessToJobObject(job, proc)
}
