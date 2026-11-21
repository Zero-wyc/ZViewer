package main

import _ "embed"

// 规则文档内置副本：构建时由 scripts/build-shell.mjs 从 crawler/docs/engine.md 刷新。
// 分享包省略 docs 目录时，GUI 的「规则文档」按钮仍可打开这份副本。
//
//go:embed assets/crawler-engine.md
var embeddedCrawlerDocs string
