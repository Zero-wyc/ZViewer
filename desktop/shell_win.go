package main

// Windows 平台细节：错误弹窗、DWM 材质深浅、开机启动项与文件工具。

import (
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

const (
	dxgiWaitTimeout = 50 * time.Millisecond
	runKey          = `Software\Microsoft\Windows\CurrentVersion\Run`
	runValueName    = "ZViewer Desktop"
	dwmDarkMode     = 20
	windowTitle     = "ZViewer · Windows 控制台"
)

const (
	swShow         = 5
	swpNoSize      = 0x0001
	swpNoMove      = 0x0002
	hwndTopMost    = ^uintptr(0)     // -1
	hwndNotTopMost = ^uintptr(0) - 1 // -2
)

var (
	user32              = windows.NewLazySystemDLL("user32.dll")
	procMessageBox      = user32.NewProc("MessageBoxW")
	procFindWindowW     = user32.NewProc("FindWindowW")
	procIsWindowVisible = user32.NewProc("IsWindowVisible")
	procShowWindow      = user32.NewProc("ShowWindow")
	procSetWindowPos    = user32.NewProc("SetWindowPos")
	procBringForeground = user32.NewProc("SetForegroundWindow")
	procActiveWindow    = user32.NewProc("GetForegroundWindow")
	procWindowThread    = user32.NewProc("GetWindowThreadProcessId")
	procAttachInput     = user32.NewProc("AttachThreadInput")
	procCurrentThread   = windows.NewLazySystemDLL("kernel32.dll").NewProc("GetCurrentThreadId")
	dwmapi              = windows.NewLazySystemDLL("dwmapi.dll")
	procDwmSetAttribute = dwmapi.NewProc("DwmSetWindowAttribute")
)

// mainWindowHandle 按窗口标题找到主窗口，供托盘与二次实例唤醒时直接操作。
func mainWindowHandle() uintptr {
	name, err := windows.UTF16PtrFromString(windowTitle)
	if err != nil {
		return 0
	}
	hwnd, _, _ := procFindWindowW.Call(0, uintptr(unsafe.Pointer(name)))
	return hwnd
}

func isWindowVisible(hwnd uintptr) bool {
	if hwnd == 0 {
		return false
	}
	visible, _, _ := procIsWindowVisible.Call(hwnd)
	return visible != 0
}

// bringToFront 把窗口显示出来并抢到前台。
// Wails 的 WindowShow 走窗口线程派发，在托盘回调里调用时可能落空；
// 置顶再取消置顶、必要时挂靠前台线程，是为了绕过后台进程抢焦点的限制。
func bringToFront(hwnd uintptr) {
	if hwnd == 0 {
		return
	}
	if !isWindowVisible(hwnd) {
		procShowWindow.Call(hwnd, swShow)
	}
	flags := uintptr(swpNoMove | swpNoSize)
	procSetWindowPos.Call(hwnd, hwndTopMost, 0, 0, 0, 0, flags)
	procSetWindowPos.Call(hwnd, hwndNotTopMost, 0, 0, 0, 0, flags)
	focusWindow(hwnd)
}

// focusWindow 先直接激活；被前台锁拒绝时临时挂靠当前前台线程再试一次。
func focusWindow(hwnd uintptr) {
	if result, _, _ := procBringForeground.Call(hwnd); result != 0 {
		return
	}
	foreground, _, _ := procActiveWindow.Call()
	if foreground == 0 || foreground == hwnd {
		return
	}
	outer, _, _ := procWindowThread.Call(foreground, 0)
	current, _, _ := procCurrentThread.Call()
	if outer == 0 || outer == current {
		return
	}
	if attached, _, _ := procAttachInput.Call(current, outer, 1); attached == 0 {
		return
	}
	procBringForeground.Call(hwnd)
	procAttachInput.Call(current, outer, 0)
}

func fileExists(path string) bool {
	if path == "" {
		return false
	}
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

// dirExists 判目录。fileExists 显式排除了目录（`!info.IsDir()`），拿它测目录
// 永远为 false——这个坑已经在 packagedInstall 上踩过一次，别再踩第二遍。
func dirExists(path string) bool {
	if path == "" {
		return false
	}
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

func sleep(milliseconds int) { time.Sleep(time.Duration(milliseconds) * time.Millisecond) }

func fatalDialog(title, message string) {
	caption, err := windows.UTF16PtrFromString(title)
	if err != nil {
		return
	}
	body, err := windows.UTF16PtrFromString(message)
	if err != nil {
		return
	}
	const mbIconError = 0x10
	_, _, _ = procMessageBox.Call(0, uintptr(unsafe.Pointer(body)), uintptr(unsafe.Pointer(caption)), mbIconError)
}

func hideWindow(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.HideWindow = true
}

// setBackdropTheme 让 Mica 材质的深浅跟随页面主题，
// 否则浅色页面会叠在深色材质上发灰。
func setBackdropTheme(title string, dark bool) bool {
	name, err := windows.UTF16PtrFromString(title)
	if err != nil {
		return false
	}
	hwnd, _, _ := procFindWindowW.Call(0, uintptr(unsafe.Pointer(name)))
	if hwnd == 0 {
		return false
	}
	value := int32(0)
	if dark {
		value = 1
	}
	hr, _, _ := procDwmSetAttribute.Call(hwnd, uintptr(dwmDarkMode),
		uintptr(unsafe.Pointer(&value)), unsafe.Sizeof(value))
	return hr == 0
}

// setLoginItem 写入/清理当前用户的开机启动项。
func setLoginItem(enabled bool) error {
	key, _, err := registry.CreateKey(registry.CURRENT_USER, runKey, registry.SET_VALUE|registry.QUERY_VALUE)
	if err != nil {
		return err
	}
	defer key.Close()
	if !enabled {
		if err := key.DeleteValue(runValueName); err != nil && err != registry.ErrNotExist {
			return err
		}
		return nil
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	return key.SetStringValue(runValueName, `"`+exe+`"`)
}
