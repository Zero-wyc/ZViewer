package console

// Host 是控制台与「宿主」之间的边界：桌面壳用 Wails 实现（系统对话框、窗口、
// 托盘、更新脚本），网页端用 HTTP 实现（SSE 推送、下载令牌、浏览器打开链接）。
//
// 这样控制台核心逻辑（controller 的调用、命令分发、爬虫桥接）不依赖任何 GUI
// 框架，Windows 桌面壳与 Linux 网页端可以共用同一份实现。
//
// 约定：
//   - EmitUpdate / Emit / Navigate 是单向通知，允许并发调用；
//   - DeliverFile / PickFile / SetLoginItem 等由命令处理同步调用，失败要返回
//     可读的中文错误；用户取消返回 ErrCanceled（由调用方转成 {canceled:true}）；
//   - 网页端不支持的桌面能力（开机启动、自动更新）返回 ErrUnsupported。

import (
	"errors"

	"zviewer/desktop/controller"
)

// ErrCanceled 表示用户在文件对话框里点了取消。
var ErrCanceled = errors.New("已取消")

// ErrUnsupported 表示当前宿主（网页端/无 GUI 模式）不支持该操作。
var ErrUnsupported = errors.New("当前运行模式不支持该操作")

// FileFilter 与 Wails 的 FileFilter 字段对齐，便于桌面宿主直接转换。
type FileFilter struct {
	DisplayName string
	Pattern     string
}

// FileRequest 描述一次「打开/保存文件」的请求。
type FileRequest struct {
	Title            string
	DefaultName      string
	DefaultDirectory string
	Filters          []FileFilter
}

// Host 由桌面壳 / 网页端分别实现。
type Host interface {
	// EmitUpdate 推送完整状态快照（桌面：desktop-update 事件；网页：SSE）。
	EmitUpdate(snapshot map[string]any)
	// Emit 推送带名字的事件（crawler-challenge 等）。
	Emit(name string, payload any)
	// Navigate 让界面切换到指定页面。
	Navigate(page string)
	// OpenURL 用系统浏览器打开链接；网页端改为向已连接的页面推送 open-url 事件。
	OpenURL(url string) error
	// Message 展示一条提示（桌面：系统消息框；网页：日志 + 事件）。
	Message(title, message string)
	// DeliverFile 把导出的文件交给用户（桌面：保存对话框；网页：一次性下载令牌）。
	DeliverFile(name string, data []byte) error
	// PickFile 让用户选择文件并读入内容（网页端不支持，导入走上传）。
	PickFile(req FileRequest) (name string, data []byte, err error)
	// OpenDataDir 打开配置目录（桌面 explorer；网页端不支持）。
	OpenDataDir(path string) error
	// Notify 弹一条系统通知（桌面托盘气泡；网页端无操作）。
	Notify(title, message string)
	// ShowWindow 把主窗口显示出来（网页端无操作）。
	ShowWindow()
	// SetLoginItem 写入/清理开机启动项（网页端不支持）。
	SetLoginItem(enabled bool) error
	// LaunchUpdate 启动更新脚本（网页端不支持，需手动安装）。
	LaunchUpdate(scriptPath string) error
	// FinishAndQuit 更新脚本已启动，延迟退出当前进程。
	FinishAndQuit(delayMillis int)
	// DownloadsDir 返回默认下载目录（可为空）。
	DownloadsDir() string
	// TrayAvailable 表示当前宿主是否有系统托盘。
	TrayAvailable() bool
	// InitialAdmin 首次初始化数据库后提示管理员账号。
	InitialAdmin(admin controller.InitialAdmin)
}

// HostBase 提供 Host 的全套空实现，宿主只需覆盖自己关心的部分。
type HostBase struct{}

func (HostBase) EmitUpdate(map[string]any)                    {}
func (HostBase) Emit(string, any)                             {}
func (HostBase) Navigate(string)                              {}
func (HostBase) OpenURL(string) error                         { return ErrUnsupported }
func (HostBase) Message(string, string)                       {}
func (HostBase) DeliverFile(string, []byte) error             { return ErrUnsupported }
func (HostBase) PickFile(FileRequest) (string, []byte, error) { return "", nil, ErrUnsupported }
func (HostBase) OpenDataDir(string) error                     { return ErrUnsupported }
func (HostBase) Notify(string, string)                        {}
func (HostBase) ShowWindow()                                  {}
func (HostBase) SetLoginItem(bool) error                      { return ErrUnsupported }
func (HostBase) LaunchUpdate(string) error                    { return ErrUnsupported }
func (HostBase) FinishAndQuit(int)                            {}
func (HostBase) DownloadsDir() string                         { return "" }
func (HostBase) TrayAvailable() bool                          { return false }
func (HostBase) InitialAdmin(controller.InitialAdmin)         {}
