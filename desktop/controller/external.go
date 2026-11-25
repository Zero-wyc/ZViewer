package controller

// 外部后端发现：后端在运行根目录写 .runtime.json（见 backend-go/internal/
// instance），本文件读它并校验进程身份。
//
// 为什么需要这一层：controller 原本只认自己 fork 出的子进程，脚本
// （start.sh / start.ps1 / entrypoint.sh）拉起的后端在它眼里根本不存在，
// 于是网页控制台把「正在运行」显示成「未启动」，点启动还会撞端口。
// 后端自报 PID 之后，谁拉起的都能被认出来——启动顺序不用改，也不需要
// 让控制台去扫进程表猜。

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// externalRuntimeFile 必须与 backend-go/internal/instance.FileName 保持一致。
// 两个模块是独立的 go.mod，没法直接 import，只能靠这份约定对齐。
const externalRuntimeFile = ".runtime.json"

// restartMarkerFile 是容器入口脚本认的「这次退出是重启」标记，路径与
// docker/entrypoint-linux-single.sh 里的 RESTART_MARKER 一致。
const restartMarkerFile = ".restart-backend"

// ExternalBackend 是给界面看的外部后端信息。
type ExternalBackend struct {
	PID       int   `json:"pid"`
	Port      int   `json:"port"`
	HTTPS     bool  `json:"https"`
	StartedAt int64 `json:"startedAt"`
	Alive     bool  `json:"alive"`
	// Origin 说明是谁拉起的：container（容器入口）/ external（脚本或手工）。
	Origin string `json:"origin"`
}

// runtimeRecord 是 .runtime.json 的线上格式，字段名与后端一致。
type runtimeRecord struct {
	PID       int    `json:"pid"`
	Port      int    `json:"port"`
	HTTPS     bool   `json:"https"`
	StartedAt int64  `json:"startedAt"`
	Root      string `json:"root,omitempty"`
}

// RefreshExternal 重新发现外部后端，返回状态是否变化（变了才需要推事件）。
func (c *Controller) RefreshExternal() bool {
	next := c.readExternal()
	c.mu.Lock()
	previous := c.external
	c.external = next
	c.mu.Unlock()
	return !sameExternal(previous, next)
}

// externalAlive 返回当前存活的外部后端；没有则返回 nil。
func (c *Controller) externalAlive() *ExternalBackend {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if c.external == nil || !c.external.Alive {
		return nil
	}
	copy := *c.external
	return &copy
}

func (c *Controller) clearExternal() {
	c.mu.Lock()
	c.external = nil
	c.mu.Unlock()
}

// readExternal 读运行信息并做三重校验：PID 存活、进程名对得上、根目录一致。
//
// 留存的记录在进程已死时要顺手删掉：更新脚本替换二进制、容器重建之后，
// 旧 PID 常常已经被系统分给别的进程，不清掉会显示一个幽灵实例。
func (c *Controller) readExternal() *ExternalBackend {
	raw, err := os.ReadFile(filepath.Join(c.root, externalRuntimeFile))
	if err != nil {
		return nil
	}
	var record runtimeRecord
	if err := json.Unmarshal(raw, &record); err != nil || record.PID <= 0 {
		return nil
	}
	if record.Root != "" && !samePath(record.Root, c.root) {
		return nil
	}
	if !processAlive(record.PID) {
		_ = os.Remove(filepath.Join(c.root, externalRuntimeFile))
		return nil
	}
	// PID 可能被系统复用：Linux 读 /proc/<pid>/cmdline、Windows 查映像名，
	// 确认还是后端而不是恰好拿到同一个号的其他程序。
	if !processMatches(record.PID, backendExecutableName()) {
		_ = os.Remove(filepath.Join(c.root, externalRuntimeFile))
		return nil
	}
	origin := "external"
	if isContainer() {
		origin = "container"
	}
	return &ExternalBackend{
		PID:       record.PID,
		Port:      record.Port,
		HTTPS:     record.HTTPS,
		StartedAt: record.StartedAt,
		Alive:     true,
		Origin:    origin,
	}
}

func sameExternal(a, b *ExternalBackend) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return a.PID == b.PID && a.Port == b.Port && a.StartedAt == b.StartedAt &&
		a.Alive == b.Alive && a.Origin == b.Origin
}

func samePath(a, b string) bool {
	cleanA := filepath.Clean(a)
	cleanB := filepath.Clean(b)
	if isWindows() {
		return strings.EqualFold(cleanA, cleanB)
	}
	return cleanA == cleanB
}

// externalOriginLabel 把来源翻成界面/错误提示里的说法。
func externalOriginLabel(origin string) string {
	if origin == "container" {
		return "容器入口脚本"
	}
	return "外部启动脚本"
}

// stopExternal 处理「外部托管的后端」的停止请求。
//
// 容器里不能真停：后端退出会让 PID 1（entrypoint）结束整个容器，restart
// policy 又会把它拉回来，用户看到的是「停一下又活了」。所以容器内改成
// 重启后端——点「停止」的诉求九成是让新配置生效，重启正好满足。
func (c *Controller) stopExternal(ext *ExternalBackend) (any, error) {
	if ext.Origin == "container" {
		return c.restartExternal(ext)
	}

	c.setBackendState("stopping")
	c.emit()
	if err := terminatePID(ext.PID); err != nil {
		c.setBackendState("error")
		return nil, fmt.Errorf("停止外部后端（PID %d）失败: %w", ext.PID, err)
	}
	if !waitPortClosed(ext.Port, 15*time.Second) {
		c.setBackendState("error")
		return nil, fmt.Errorf("已向 PID %d 发送停止信号，但端口 %d 仍在监听", ext.PID, ext.Port)
	}
	_ = os.Remove(filepath.Join(c.root, externalRuntimeFile))
	c.clearExternal()
	c.setBackendState("stopped")
	c.setVoiceState("stopped")
	c.log(fmt.Sprintf("已停止%s启动的后端（PID %d）", externalOriginLabel(ext.Origin), ext.PID), "backend", "INFO")
	return c.Snapshot(), nil
}

// restartExternal 让容器入口脚本重启后端：先写重启标记，再让后端退出。
// entrypoint 看到标记会等更新脚本结束后重新拉起后端，容器本身不动。
func (c *Controller) restartExternal(ext *ExternalBackend) (any, error) {
	marker := filepath.Join(c.root, restartMarkerFile)
	if err := os.WriteFile(marker, []byte("restart\n"), 0o644); err != nil {
		return nil, fmt.Errorf("写入重启标记失败: %w", err)
	}
	if err := terminatePID(ext.PID); err != nil {
		_ = os.Remove(marker)
		return nil, fmt.Errorf("重启后端失败: %w", err)
	}
	c.setBackendState("starting")
	c.emit()

	// 等新实例登记（PID 与旧的不同且存活），最多 45 秒；更新脚本等文件复制
	// 最多要 120 秒，但那种情况由更新流程自己处理，这里只兜「重启」。
	deadline := time.Now().Add(45 * time.Second)
	for time.Now().Before(deadline) {
		if next := c.readExternal(); next != nil && next.PID != ext.PID {
			c.mu.Lock()
			c.external = next
			c.mu.Unlock()
			c.setBackendState("running")
			c.setVoiceState("running")
			c.log(fmt.Sprintf("后端已重启（PID %d → %d）", ext.PID, next.PID), "backend", "INFO")
			return c.Snapshot(), nil
		}
		time.Sleep(500 * time.Millisecond)
	}
	c.setBackendState("error")
	return nil, errors.New("已触发容器内重启，但 45 秒内没等到新实例登记；请查看容器日志")
}

// waitPortClosed 等端口释放：后端优雅退出要落盘、关库，通常 1~3 秒。
func waitPortClosed(port int, timeout time.Duration) bool {
	if port <= 0 {
		return true
	}
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if !portOpen(port) {
			return true
		}
		time.Sleep(300 * time.Millisecond)
	}
	return !portOpen(port)
}

func portOpen(port int) bool {
	conn, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), 400*time.Millisecond)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

// isContainer 判断当前是否跑在容器里。docker 会在根目录放 .dockerenv，
// podman 用 /run/.containerenv；也允许入口脚本显式设 ZVIEWER_CONTAINER=1。
var (
	containerOnce   sync.Once
	containerCached bool
)

func isContainer() bool {
	containerOnce.Do(func() {
		switch strings.ToLower(strings.TrimSpace(os.Getenv("ZVIEWER_CONTAINER"))) {
		case "1", "true", "yes":
			containerCached = true
			return
		case "0", "false", "no":
			// 显式否认：LXC 之类也会放 /.dockerenv 的环境里，允许用户把
			// 「容器内只能重启」的语义关掉，恢复真正的停止行为。
			containerCached = false
			return
		}
		for _, marker := range []string{"/.dockerenv", "/run/.containerenv"} {
			if _, err := os.Stat(marker); err == nil {
				containerCached = true
				return
			}
		}
	})
	return containerCached
}
