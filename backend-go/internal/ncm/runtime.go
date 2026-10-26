package ncm

import (
	"context"
	"log"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"time"
)

// StartBundled starts the private music runtime only when NCM_API_BASE was not
// configured by the operator. Each backend gets its own loopback port and temp
// directory; credentials remain in the backend's per-user credential store.
func StartBundled(parent context.Context, root, configDir, base string) (string, func()) {
	noop := func() {}
	if os.Getenv("NCM_API_BASE") != "" {
		return base, noop
	}
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
