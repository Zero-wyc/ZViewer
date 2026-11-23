// Package ui 把桌面控制台的静态界面打包进二进制。
//
// 以前 //go:embed 直接写在 package main（shell_assets.go），只能给 Wails 用；
// 网页端（webgui）与 Linux 的独立 GUI 也要同一套界面，所以单独拆成包：
// go:embed 不允许引用父目录，静态文件必须和 embed 指令在同一个包里。
package ui

import (
	"embed"
	"io/fs"
)

//go:embed *.html *.js *.css *.png
var assets embed.FS

// FS 返回网站根目录对应的文件系统（index.html 在根部）。
func FS() fs.FS {
	sub, err := fs.Sub(assets, ".")
	if err != nil {
		// 只有 embed 失败才会走到这里，属于构建期错误。
		panic(err)
	}
	return sub
}
