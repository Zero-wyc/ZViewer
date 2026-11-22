package main

// MCP stdio 入口（`zviewer-backend --mcp`）。
//
// 为什么复用后端可执行文件而不是另做一个 zviewer-mcp.exe：
//   - 客户端配置里只需要一个路径，分发目录不用多一个文件，也就不存在「装了新版
//     只更新了后端、MCP 那个 exe 还是旧的」这类版本错位；
//   - 引擎装配（internal/crawler.Boot）本来就在这个模块里，不需要额外依赖。
//
// 这个模式下不读 .env、不连数据库、不开任何监听端口：只把 stdin 上的
// JSON-RPC 交给引擎，把结果写回 stdout。所有诊断信息走 stderr——
// stdout 一旦混进别的东西，客户端会直接把整个会话判为协议错误。

import (
	"context"
	"fmt"
	"log"
	"os"
	"strings"

	"zviewer/backend/internal/crawler"
	"zviewer/backend/internal/mcp"
)

// runMCP 跑 stdio 事件循环，返回进程退出码。
func runMCP(args []string) int {
	// stdout 是协议通道，日志一律走 stderr（stdlib log 默认就是 stderr，
	// 这里显式再设一遍，避免以后有人改了全局默认）。
	log.SetOutput(os.Stderr)
	log.SetPrefix("[crawler-mcp] ")
	log.SetFlags(0)

	if hasFlag(args, "--help") || hasFlag(args, "-h") {
		fmt.Fprintln(os.Stderr, strings.TrimSpace(`
ZViewer 爬虫引擎 · MCP stdio 服务

用法：
  zviewer-backend --mcp [--root <crawler 目录>]

客户端配置示例（Claude Desktop / Cursor / VS Code 的 mcpServers）：
  "zviewer-crawler": {
    "command": "<安装目录>/runtime/zviewer-backend.exe",
    "args": ["--mcp"]
  }

目录优先级：--root → CRAWLER_ROOT → ZVIEWER_CRAWLER_ROOT → exe 附近 crawler/`))
		return 0
	}

	// --root 优先；没给就让 crawler.EnsureRoot 按环境变量与 exe 位置探测。
	if root, ok := flagValue(args, "--root"); ok && strings.TrimSpace(root) != "" {
		if err := os.Setenv("ZVIEWER_CRAWLER_ROOT", strings.TrimSpace(root)); err != nil {
			log.Printf("设置爬虫目录失败：%v", err)
			return 1
		}
	}
	root, err := crawler.EnsureRoot()
	if err != nil {
		log.Printf("启动失败：%v", err)
		return 1
	}
	engine, err := crawler.Boot(root)
	if err != nil {
		log.Printf("引擎装配失败（%s）：%v", root, err)
		return 1
	}
	registry, err := engine.Registry()
	if err != nil {
		log.Printf("工具集装配失败（%s）：%v", root, err)
		return 1
	}
	log.Printf("引擎就绪：%s（%d 个工具）", root, len(registry.Names()))

	handler := mcp.NewHandler(registry, crawler.Version, log.Printf)
	if err := mcp.Serve(context.Background(), os.Stdin, os.Stdout, handler); err != nil {
		log.Printf("协议循环退出：%v", err)
		return 1
	}
	return 0
}
