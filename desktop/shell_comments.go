package main

// 桌面壳的「独立评论窗口」模式。
//
// 启动方式：主窗口把 URL（含一次性登录票据）通过
// --comments-window-url=<url> 传给同一个 desktop.exe，此时不再拉起后端、
// 不接管托盘与单实例锁，只渲染一个无边框、可置顶、可缩放的评论窗口。
//
// 为什么外层页面由壳自己提供：Wails v2 的 JS↔Go IPC 走同源 WebSocket
// （/wails/ipc），窗口一旦直接加载后端页面就再也拿不到 window.runtime。
// 因此壳用 assetserver 提供 comments-window.html，再用 iframe 嵌后端页面。

import (
	"context"
	"errors"
	"net/http"
	"path/filepath"
	"sync/atomic"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	windowsopts "github.com/wailsapp/wails/v2/pkg/options/windows"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// CommentsWindow 是绑定给 comments-window.html 的对象（window.go.main.CommentsWindow）。
type CommentsWindow struct {
	ctx     context.Context
	pageURL string
	pinned  atomic.Bool
}

// Info 返回 iframe 要加载的地址与当前置顶状态。
func (c *CommentsWindow) Info() (map[string]any, error) {
	return map[string]any{
		"url":    c.pageURL,
		"pinned": c.pinned.Load(),
	}, nil
}

// SetPinned 切换窗口置顶。
func (c *CommentsWindow) SetPinned(pinned bool) error {
	c.pinned.Store(pinned)
	if c.ctx != nil {
		runtime.WindowSetAlwaysOnTop(c.ctx, pinned)
	}
	return nil
}

// Close 关闭评论窗口（只退出这个进程，不影响主窗口的后端）。
func (c *CommentsWindow) Close() error {
	if c.ctx != nil {
		runtime.Quit(c.ctx)
	}
	return nil
}

// commentsWindowAssets 把根路径改写成专用外壳页，资源仍然走内嵌 ui。
func commentsWindowAssets(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" || r.URL.Path == "/index.html" {
			clone := r.Clone(r.Context())
			clone.URL.Path = "/comments-window.html"
			next.ServeHTTP(w, clone)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// runCommentsWindow 运行评论窗口模式，返回时进程结束。
func runCommentsWindow(stateDir, pageURL string) {
	window := &CommentsWindow{pageURL: pageURL}
	window.pinned.Store(true)

	appOptions := &options.App{
		Title:            "ZViewer · 评论区",
		Width:            400,
		Height:           640,
		MinWidth:         220,
		MinHeight:        160,
		Frameless:        true,
		AlwaysOnTop:      true,
		BackgroundColour: &options.RGBA{R: 0, G: 0, B: 0, A: 0},
		AssetServer: &assetserver.Options{
			Assets:     uiFS(),
			Middleware: commentsWindowAssets,
		},
		Bind: []interface{}{window},
		OnStartup: func(ctx context.Context) {
			window.ctx = ctx
			// Wails 在创建窗口时按 AlwaysOnTop 加 WS_EX_TOPMOST，实测有时不生效，
			// 这里显式再设一次（歌词式浮层必须压在其他窗口之上）。
			runtime.WindowSetAlwaysOnTop(ctx, true)
		},
		Windows: &windowsopts.Options{
			Theme:                windowsopts.SystemDefault,
			BackdropType:         windowsopts.None,
			WebviewIsTransparent: true,
			WindowIsTranslucent:  true,
			// frameless 默认仍带 Aero 阴影/圆角，桌面歌词式浮层要彻底没有这些装饰
			DisableFramelessWindowDecorations: true,
			// 独立的 WebView2 配置目录：不与主窗口那份 cookie/缓存混用。
			WebviewUserDataPath: filepath.Join(stateDir, "webview-comments"),
			WindowClassName:     "zviewerCommentsWindow",
		},
	}
	if err := wails.Run(appOptions); err != nil && !errors.Is(err, context.Canceled) {
		fatalDialog("ZViewer 评论窗口启动失败", err.Error())
	}
}
