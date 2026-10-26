package ncm

import (
	"context"
	"log"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"zviewer/backend/internal/ncmapi"
)

// StartBundled 决定音乐接口的来源，返回基地址与停止函数。
//
// 优先级（每一层都能单独回退，方便灰度与排障）：
//  1. 显式 NCM_API_BASE —— 运维指定外部服务，进程内实现与随包组件都不启动；
//  2. 进程内 Go 实现（默认）—— internal/ncmapi 监听回环随机端口，无子进程、
//     无 Node 运行时；
//  3. 随包 Node 组件（NCM_UPSTREAM=node，或进程内启动失败且有 ncm/ 目录）。
//
// 每层都自带回环随机端口：不会被同机其他实例误连，也不会和用户自建的
// 36530 撞车。凭证仍由后端自己的 per-user 凭证库管理，与谁提供协议无关。
func StartBundled(parent context.Context, root, configDir, base string) (string, func()) {
	noop := func() {}
	if os.Getenv("NCM_API_BASE") != "" {
		return base, noop
	}
	mode := strings.ToLower(strings.TrimSpace(os.Getenv("NCM_UPSTREAM")))
	if mode != "node" {
		local, stop, err := ncmapi.Listen()
		if err == nil {
			log.Printf("[ncm] 音乐接口由进程内实现提供: %s", local)
			return local, stop
		}
		log.Printf("[ncm] 内置音乐接口启动失败，改用随包组件: %v", err)
	}
	return startBundledNode(parent, root, configDir, base)
}

// startBundledNode 拉起随包 Node 组件（历史路径，保留作回退）。
func startBundledNode(parent context.Context, root, configDir, base string) (string, func()) {
	noop := func() {}
	runtimeDir := filepath.Join(root, "ncm")
	node := filepath.Join(runtimeDir, "node.exe")
	if _, err := os.Stat(node); err != nil {
		return base, noop
	}
	if _, err := os.Stat(filepath.Join(runtimeDir, "start.cjs")); err != nil {
		log.Print("[ncm] 音乐组件不完整，无法启动")
		return base, noop
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		log.Printf("[ncm] 无法分配本地端口: %v", err)
		return base, noop
	}
	port := listener.Addr().(*net.TCPAddr).Port
	listener.Close()
	ctx, cancel := context.WithCancel(parent)
	done := make(chan struct{})
	tempDir := filepath.Join(configDir, "ncm-cache")
	if err := os.MkdirAll(tempDir, 0700); err != nil {
		cancel()
		return base, noop
	}
	go func() {
		defer close(done)
		for {
			if ctx.Err() != nil {
				return
			}
			cmd := exec.CommandContext(ctx, node, filepath.Join(runtimeDir, "start.cjs"))
			cmd.Dir = runtimeDir
			cmd.Env = append(os.Environ(), "NCM_PORT="+strconv.Itoa(port), "NCM_PARENT_PID="+strconv.Itoa(os.Getpid()), "TEMP="+tempDir, "TMP="+tempDir, "TMPDIR="+tempDir)
			// Do not forward upstream logs: they can contain QR keys and cookie data.
			prepareRuntime(cmd)
			if err := cmd.Run(); ctx.Err() != nil {
				return
			} else if err != nil {
				log.Printf("[ncm] 音乐组件退出，将在 3 秒后重启: %v", err)
			}
			select {
			case <-ctx.Done():
				return
			case <-time.After(3 * time.Second):
			}
		}
	}()
	stop := func() { cancel(); <-done }
	return "http://127.0.0.1:" + strconv.Itoa(port), stop
}
