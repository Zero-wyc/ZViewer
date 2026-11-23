package main

// 界面资源已移到 desktop/ui 包（go:embed 不能引用父目录，网页端也要复用），
// 这里只保留桌面壳专属的嵌入文件。即使是 string / []byte，go:embed 也要求
// 空导入 embed 包。
import _ "embed"

//go:embed lib/windows-process.ps1
var processHelperScript string

//go:embed assets/app.ico
var appIconICO []byte
