package webgui

import "embed"

// 网页端自己的页面（登录/设置）与外壳样式；控制台主体界面仍来自 ui 包。
//
//go:embed web/*
var webAssets embed.FS
