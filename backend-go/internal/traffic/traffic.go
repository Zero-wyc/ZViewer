// Package traffic 提供服务器网卡级流量统计（OS 计数器，尽力而为）。
//
// - Linux：读 /proc/net/dev，跳过 lo；
// - Windows：解析 `netstat -e` 的「字节 / Bytes」行；
// - macOS：解析 `netstat -ib`，跳过 lo*。
//
// 取不到（不支持的平台 / 命令失败）时返回 ok=false，前端据此隐藏流量区块。
package traffic

import (
	"context"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Stats 是一次采样结果（累计值 + 即时速度）。
type Stats struct {
	RxBytes int64   `json:"rxBytes"`
	TxBytes int64   `json:"txBytes"`
	RxSpeed float64 `json:"rxSpeed"`
	TxSpeed float64 `json:"txSpeed"`
}

// sampler 保存上一次采样，用于算速度。
//
// 全局单例是有意的：速度是「两次采样差值 / 时间差」，多实例各自算会互相
// 干扰出尖刺。Node 侧同样是模块级变量。
type sampler struct {
	mu        sync.Mutex
	hasLast   bool
	lastRx    int64
	lastTx    int64
	lastAt    time.Time
	lastRxSpd float64
	lastTxSpd float64
}

var global sampler

// Get 采样一次并返回统计；平台不支持时 ok=false。
func Get(ctx context.Context) (Stats, bool) {
	sample, ok := readNicBytes(ctx)
	if !ok {
		return Stats{}, false
	}

	global.mu.Lock()
	defer global.mu.Unlock()

	now := time.Now()
	rxSpeed, txSpeed := 0.0, 0.0
	if global.hasLast && sample.rx >= global.lastRx && sample.tx >= global.lastTx {
		dt := now.Sub(global.lastAt).Seconds()
		if dt > 0.2 {
			rxSpeed = maxFloat(0, float64(sample.rx-global.lastRx)/dt)
			txSpeed = maxFloat(0, float64(sample.tx-global.lastTx)/dt)
			global.lastRxSpd, global.lastTxSpd = rxSpeed, txSpeed
		} else {
			// 采样间隔过短（前端轮询比 200ms 还快）：沿用上次速度，
			// 否则 0.05s 的抖动会被放大成 20 倍尖刺。
			rxSpeed, txSpeed = global.lastRxSpd, global.lastTxSpd
		}
	} else {
		// 计数器回绕 / 网卡重置：速度归零，等下一轮再算。
		global.lastRxSpd, global.lastTxSpd = 0, 0
	}
	global.hasLast = true
	global.lastRx, global.lastTx, global.lastAt = sample.rx, sample.tx, now

	return Stats{RxBytes: sample.rx, TxBytes: sample.tx, RxSpeed: rxSpeed, TxSpeed: txSpeed}, true
}

type nicSample struct {
	rx int64
	tx int64
}

func readNicBytes(ctx context.Context) (nicSample, bool) {
	switch runtime.GOOS {
	case "linux":
		return readLinuxProc()
	case "windows":
		return readNetstat(ctx, []string{"-e"})
	case "darwin":
		return readDarwinNetstat(ctx)
	}
	return nicSample{}, false
}

// readNetstat 解析 `netstat` 输出。
//
// 不同平台/语言差异极大，但共同点是「标签 + 两个纯数字」这一行：
// Windows 是 `Bytes 1,857,485,134 424,213,945`（中英文都带千分位），
// macOS 需要按列取，单独走 readDarwinNetstat。
func readNetstat(ctx context.Context, args []string) (nicSample, bool) {
	out, err := runCommand(ctx, "netstat", args...)
	if err != nil {
		return nicSample{}, false
	}
	sample := parseWindowsNetstat(out)
	if sample.rx+sample.tx == 0 {
		return nicSample{}, false
	}
	return sample, true
}

// parseWindowsNetstat 从 `netstat -e` 输出里取累计收发字节。
//
// 中英文输出都靠「标签 + 两个纯数字」这一行识别（Windows 的千分位
// 逗号要先剥掉）；Unicast packets 是 4 列、IPv4/IPv6 段列数更多，
// 都不会误匹配。
func parseWindowsNetstat(out string) nicSample {
	// 取前若干行即可命中，避免把 IPv4/IPv6 统计段扫一遍。
	lines := strings.Split(out, "\n")
	for i, line := range lines {
		if i > 20 {
			break
		}
		cols := strings.Fields(line)
		if len(cols) != 3 {
			continue
		}
		rx, err1 := parseGroupedNumber(cols[1])
		tx, err2 := parseGroupedNumber(cols[2])
		if err1 == nil && err2 == nil && rx+tx > 0 {
			return nicSample{rx: rx, tx: tx}
		}
	}
	return nicSample{}
}

// parseGroupedNumber 解析可能带千分位（逗号或点）的整数。
func parseGroupedNumber(raw string) (int64, error) {
	cleaned := strings.NewReplacer(",", "", ".", "").Replace(raw)
	return strconv.ParseInt(cleaned, 10, 64)
}

func readDarwinNetstat(ctx context.Context) (nicSample, bool) {
	out, err := runCommand(ctx, "netstat", "-ib")
	if err != nil {
		return nicSample{}, false
	}
	var rx, tx int64
	matched := false
	lines := strings.Split(out, "\n")
	for i, line := range lines {
		if i == 0 {
			continue // 表头
		}
		cols := strings.Fields(line)
		if len(cols) < 10 {
			continue
		}
		if strings.HasPrefix(cols[0], "lo") {
			continue
		}
		rxBytes, err1 := strconv.ParseInt(cols[6], 10, 64)
		txBytes, err2 := strconv.ParseInt(cols[9], 10, 64)
		if err1 == nil && err2 == nil {
			rx += rxBytes
			tx += txBytes
			matched = true
		}
	}
	return nicSample{rx: rx, tx: tx}, matched
}

func maxFloat(a, b float64) float64 {
	if a > b {
		return a
	}
	return b
}

// runCommand 跑一条系统命令（4 秒超时，隐藏窗口）。
func runCommand(ctx context.Context, name string, args ...string) (string, error) {
	runCtx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()
	cmd := exec.CommandContext(runCtx, name, args...)
	hideWindow(cmd)
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return string(out), nil
}

// readLinuxProc 读 /proc/net/dev，跳过回环接口。
//
// 列序固定：iface: rx_bytes ... tx_bytes（rx 第 1 列、tx 第 9 列，0 起始）。
func readLinuxProc() (nicSample, bool) {
	raw, err := os.ReadFile("/proc/net/dev")
	if err != nil {
		return nicSample{}, false
	}
	var rx, tx int64
	matched := false
	lines := strings.Split(string(raw), "\n")
	for i, line := range lines {
		if i < 2 {
			continue // 两行表头
		}
		idx := strings.Index(line, ":")
		if idx < 0 {
			continue
		}
		name := strings.TrimSpace(line[:idx])
		if name == "" || name == "lo" {
			continue
		}
		cols := strings.Fields(line[idx+1:])
		if len(cols) < 9 {
			continue
		}
		rxBytes, err1 := strconv.ParseInt(cols[0], 10, 64)
		txBytes, err2 := strconv.ParseInt(cols[8], 10, 64)
		if err1 == nil && err2 == nil {
			rx += rxBytes
			tx += txBytes
			matched = true
		}
	}
	return nicSample{rx: rx, tx: tx}, matched
}
