package main

// 系统托盘：Wails v2 没有内置托盘，这里直接用 Shell_NotifyIcon 实现，
// 菜单项固定为显示控制台 / 启停服务 / 打开网页端 / 退出。

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"unicode/utf16"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	wmApp            = 0x8000
	wmTrayCallback   = wmApp + 1
	wmRButtonUp      = 0x0205
	wmLButtonUp      = 0x0202
	wmClose          = 0x0010
	wmDestroy        = 0x0002
	wmNull           = 0x0000
	imageIcon        = 1
	notificationMsg  = 0x00000001 // NIF_MESSAGE
	notificationIcon = 0x00000002
	notificationTip  = 0x00000004
	notificationInfo = 0x00000010 // NIF_INFO
	niifInfo         = 0x00000001
	tpmReturnCmd     = 0x0100
	tpmRightButton   = 0x0002
	mfString         = 0x0000
	mfSeparator      = 0x0800
	mfGrayed         = 0x0001
	menuShow         = 1
	menuToggle       = 2
	menuRestart      = 3
	menuOpenWeb      = 4
	menuCli          = 5
	menuLogs         = 6
	menuQuit         = 7
)

var (
	shell32              = windows.NewLazySystemDLL("shell32.dll")
	procShellNotifyIcon  = shell32.NewProc("Shell_NotifyIconW")
	procRegisterClassEx  = user32.NewProc("RegisterClassExW")
	procCreateWindowEx   = user32.NewProc("CreateWindowExW")
	procDefWindowProc    = user32.NewProc("DefWindowProcW")
	procDestroyWindow    = user32.NewProc("DestroyWindow")
	procLoadImage        = user32.NewProc("LoadImageW")
	procCreatePopupMenu  = user32.NewProc("CreatePopupMenu")
	procAppendMenu       = user32.NewProc("AppendMenuW")
	procTrackPopupMenu   = user32.NewProc("TrackPopupMenu")
	procSetForeground    = user32.NewProc("SetForegroundWindow")
	procPostMessage      = user32.NewProc("PostMessageW")
	procGetCursorPos     = user32.NewProc("GetCursorPos")
	procGetMessage       = user32.NewProc("GetMessageW")
	procTranslateMessage = user32.NewProc("TranslateMessage")
	procDispatchMessage  = user32.NewProc("DispatchMessageW")
	procGetModuleHandle  = windows.NewLazySystemDLL("kernel32.dll").NewProc("GetModuleHandleW")
	procUnregisterClass  = user32.NewProc("UnregisterClassW")
	procPostQuitMessage  = user32.NewProc("PostQuitMessage")
)

type point struct {
	X int32
	Y int32
}

type wndClassEx struct {
	Size       uint32
	Style      uint32
	WndProc    uintptr
	ClsExtra   int32
	WndExtra   int32
	Instance   uintptr
	Icon       uintptr
	Cursor     uintptr
	Background uintptr
	MenuName   *uint16
	ClassName  *uint16
	IconSm     uintptr
}

type windowMessage struct {
	Hwnd    uintptr
	Message uint32
	Wparam  uintptr
	Lparam  uintptr
	Time    uint32
	Pt      point
	Private uint32
}

type notifyIconData struct {
	Size             uint32
	Wnd              uintptr
	ID               uint32
	Flags            uint32
	CallbackMessage  uint32
	Icon             uintptr
	Tip              [128]uint16
	State            uint32
	StateMask        uint32
	Info             [256]uint16
	TimeoutOrVersion uint32
	InfoTitle        [64]uint16
	InfoFlags        uint32
	GUID             [16]byte
	BalloonIcon      uintptr
}

type trayIcon struct {
	app  *App
	hwnd uintptr
	mu   sync.Mutex
	done bool
}

func utf16Ptr(value string) *uint16 {
	encoded := utf16.Encode([]rune(value))
	encoded = append(encoded, 0)
	return &encoded[0]
}

func copyUTF16(target []uint16, value string) {
	encoded := utf16.Encode([]rune(value))
	if len(encoded) >= len(target) {
		encoded = encoded[:len(target)-1]
	}
	for index := range target {
		target[index] = 0
	}
	copy(target, encoded)
}

var activeTray *trayIcon

func newTray(app *App) *trayIcon {
	tray := &trayIcon{app: app}
	if err := tray.start(); err != nil {
		app.ctrl.Log("系统托盘不可用："+err.Error(), "console", "WARN")
		return nil
	}
	return tray
}

func (t *trayIcon) start() error {
	// 窗口必须与消息循环在同一个线程：Windows 的消息投递按线程队列，
	// 在别的线程里 GetMessage 永远收不到这个窗口的消息。
	ready := make(chan error, 1)
	go func() {
		runtime.LockOSThread()
		if err := t.createWindow(); err != nil {
			ready <- err
			return
		}
		ready <- nil
		t.messageLoop()
	}()
	return <-ready
}

func (t *trayIcon) createWindow() error {
	instance, _, _ := procGetModuleHandle.Call(0)
	if instance == 0 {
		return errors.New("无法获取模块句柄")
	}
	className := "zviewerTrayWindow"
	// 先注册窗口类：同名类已存在（上一次进程残留）时直接复用。
	class := wndClassEx{
		Size:      uint32(unsafe.Sizeof(wndClassEx{})),
		WndProc:   windows.NewCallback(trayWindowProc),
		Instance:  instance,
		ClassName: utf16Ptr(className),
	}
	if result, _, err := procRegisterClassEx.Call(uintptr(unsafe.Pointer(&class))); result == 0 {
		if errno, ok := err.(windows.Errno); !ok || errno != windows.ERROR_CLASS_ALREADY_EXISTS {
			return errors.New("注册托盘窗口失败")
		}
	}
	hwnd, _, err := procCreateWindowEx.Call(0, uintptr(unsafe.Pointer(utf16Ptr(className))),
		uintptr(unsafe.Pointer(utf16Ptr("ZViewer Tray"))), 0, 0, 0, 0, 0, 0, 0, instance, 0)
	if hwnd == 0 {
		return errors.New("创建托盘窗口失败：" + err.Error())
	}
	t.hwnd = hwnd
	activeTray = t
	if err := t.notify(false, t.tooltip()); err != nil {
		return err
	}
	return nil
}

func (t *trayIcon) notify(modify bool, tooltip string) error {
	data := notifyIconData{
		Wnd:             t.hwnd,
		ID:              1,
		Flags:           notificationMsg | notificationIcon | notificationTip,
		CallbackMessage: wmTrayCallback,
		Icon:            t.iconHandle(),
	}
	data.Size = uint32(unsafe.Sizeof(data))
	copyUTF16(data.Tip[:], tooltip)
	// NIM_ADD = 0，NIM_MODIFY = 1
	message := uintptr(0)
	if modify {
		message = 1
	}
	result, _, _ := procShellNotifyIcon.Call(message, uintptr(unsafe.Pointer(&data)))
	if result == 0 {
		return errors.New("无法注册托盘图标")
	}
	return nil
}

func (t *trayIcon) iconHandle() uintptr {
	path := filepath.Join(t.app.stateDir, "app.ico")
	if !fileExists(path) {
		_ = os.WriteFile(path, appIconICO, 0o600)
	}
	handle, _, _ := procLoadImage.Call(0, uintptr(unsafe.Pointer(utf16Ptr(path))), imageIcon, 0, 0, 0x0010) // LR_LOADFROMFILE
	return handle
}

func (t *trayIcon) tooltip() string {
	status := map[string]string{
		"stopped": "未启动", "starting": "启动中", "running": "运行中", "stopping": "停止中", "error": "异常",
	}[t.app.ctrl.Snapshot().Backend]
	if status == "" {
		status = "未启动"
	}
	return "ZViewer · " + status
}

// balloon 在托盘图标上弹一条系统通知（Win10/11 会进通知中心）。
// 用 Shell_NotifyIcon 的 NIF_INFO，不依赖进程内 COM 或外部脚本。
func (t *trayIcon) balloon(title, body string) {
	if t == nil {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.done || t.hwnd == 0 {
		return
	}
	data := notifyIconData{
		Wnd:              t.hwnd,
		ID:               1,
		Flags:            notificationInfo,
		InfoFlags:        niifInfo,
		TimeoutOrVersion: 10000,
	}
	data.Size = uint32(unsafe.Sizeof(data))
	copyUTF16(data.InfoTitle[:], title)
	copyUTF16(data.Info[:], body)
	// NIM_MODIFY = 1
	if result, _, _ := procShellNotifyIcon.Call(1, uintptr(unsafe.Pointer(&data))); result == 0 {
		t.app.ctrl.Log("托盘通知发送失败", "tray", "WARN")
	}
}

// refresh 在状态变化时更新提示文字。
func (t *trayIcon) refresh() {
	if t == nil {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.done {
		return
	}
	_ = t.notify(true, t.tooltip())
}

func (t *trayIcon) remove() {
	if t == nil {
		return
	}
	t.mu.Lock()
	if t.done {
		t.mu.Unlock()
		return
	}
	t.done = true
	t.mu.Unlock()
	data := notifyIconData{Wnd: t.hwnd, ID: 1}
	data.Size = uint32(unsafe.Sizeof(data))
	procShellNotifyIcon.Call(2, uintptr(unsafe.Pointer(&data))) // NIM_DELETE
	if t.hwnd != 0 {
		// DestroyWindow 只能由创建它的线程调用，这里交给托盘消息循环收尾。
		procPostMessage.Call(t.hwnd, wmClose, 0, 0)
	}
}

func (t *trayIcon) messageLoop() {
	runtime.LockOSThread()
	var message windowMessage
	for {
		result, _, _ := procGetMessage.Call(uintptr(unsafe.Pointer(&message)), 0, 0, 0)
		if int32(result) <= 0 {
			return
		}
		procTranslateMessage.Call(uintptr(unsafe.Pointer(&message)))
		procDispatchMessage.Call(uintptr(unsafe.Pointer(&message)))
	}
}

func trayWindowProc(hwnd, message, wparam, lparam uintptr) uintptr {
	tray := activeTray
	switch message {
	case wmClose:
		procDestroyWindow.Call(hwnd)
		return 0
	case wmDestroy:
		procPostQuitMessage.Call(0)
		return 0
	}
	if message == wmTrayCallback && tray != nil {
		switch uint32(lparam) & 0xFFFF {
		case wmLButtonUp:
			tray.app.showWindow()
		case wmRButtonUp:
			tray.popup()
		}
		return 0
	}
	result, _, _ := procDefWindowProc.Call(hwnd, message, wparam, lparam)
	return result
}

// popup 弹出托盘右键菜单。
func (t *trayIcon) popup() {
	if t == nil || t.hwnd == 0 {
		return
	}
	snapshot := t.app.ctrl.Snapshot()
	status := map[string]string{
		"stopped": "未启动", "starting": "启动中", "running": "运行中", "stopping": "停止中", "error": "异常",
	}[snapshot.Backend]
	if status == "" {
		status = "未启动"
	}
	menu, _, _ := procCreatePopupMenu.Call()
	if menu == 0 {
		return
	}
	add := func(id uint32, text string, disabled bool) {
		flags := uint32(mfString)
		if disabled {
			flags |= mfGrayed
		}
		procAppendMenu.Call(menu, uintptr(flags), uintptr(id), uintptr(unsafe.Pointer(utf16Ptr(text))))
	}
	add(0, "ZViewer · "+status, true)
	procAppendMenu.Call(menu, mfSeparator, 0, 0)
	add(menuShow, "显示控制台", false)
	toggle := "启动服务"
	if snapshot.Pid != nil {
		toggle = "停止服务"
	}
	add(menuToggle, toggle, t.app.ctrl.Busy())
	add(menuRestart, "重启服务", t.app.ctrl.Busy() || snapshot.Pid == nil)
	add(menuOpenWeb, "打开网页端", false)
	add(menuCli, "高画质代理", false)
	add(menuLogs, "查看运行日志", false)
	procAppendMenu.Call(menu, mfSeparator, 0, 0)
	add(menuQuit, "退出并停止受管服务", false)

	var cursor point
	procGetCursorPos.Call(uintptr(unsafe.Pointer(&cursor)))
	procSetForeground.Call(t.hwnd)
	choice, _, _ := procTrackPopupMenu.Call(menu, tpmReturnCmd|tpmRightButton, uintptr(cursor.X), uintptr(cursor.Y), 0, t.hwnd, 0)
	procPostMessage.Call(t.hwnd, wmNull, 0, 0)
	t.runMenuCommand(uint32(choice))
}

func (t *trayIcon) runMenuCommand(id uint32) {
	app := t.app
	run := func(task func() error) {
		go func() {
			if err := task(); err != nil {
				app.ctrl.Log(err.Error(), "console", "ERROR")
			}
		}()
	}
	switch id {
	case menuShow:
		app.showWindow()
	case menuToggle:
		if app.ctrl.Snapshot().Pid != nil {
			run(func() error { _, err := app.ctrl.Stop(); return err })
		} else {
			run(func() error { _, err := app.ctrl.Start(); return err })
		}
	case menuRestart:
		run(func() error { _, err := app.ctrl.Restart(); return err })
	case menuOpenWeb:
		run(func() error { return app.openLocalPage(false) })
	case menuCli:
		app.showWindow()
		app.navigate("cli")
	case menuLogs:
		app.showWindow()
		app.navigate("logs")
	case menuQuit:
		app.quit()
	}
}
