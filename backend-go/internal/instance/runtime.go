// Package instance 记录「当前哪个进程占着这份运行目录」。
//
// 后端启动时把 PID、端口、启动时间写到运行根目录下的 .runtime.json，退出时
// 删掉。它不是控制通道，只是一份**自描述的运行信息**：谁拉起这个进程
// （start.sh / entrypoint / 用户手敲 / 控制台自己）都不影响它被发现。
//
// 网页控制台（zviewer-webgui）读这份文件，配合 /health 探测，就能在「后端
// 不是自己 fork 的」情况下照样显示运行状态、拿到 PID 去停止或重启。没有
// 这份文件时控制台只能退回「端口通不通」的判断，看不到 PID。
package instance

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// FileName 是运行信息文件名。放在运行根目录而不是 config/：控制台与后端
// 都以 root 为基准定位，不依赖 CONFIG_DIR 是否被改过。
const FileName = ".runtime.json"

// Info 描述一个正在运行的后端实例。
type Info struct {
	PID       int   `json:"pid"`
	Port      int   `json:"port"`
	HTTPS     bool  `json:"https"`
	StartedAt int64 `json:"startedAt"`
	// Root 是实例认的运行根目录。同一台机器上跑多份运行包时，控制台据此
	// 判断这条记录是不是自己该管的那个实例。
	Root string `json:"root,omitempty"`
}

// Path 返回运行信息文件路径。
func Path(root string) string { return filepath.Join(root, FileName) }

// Read 读取运行信息。文件不存在返回 (nil, nil)——「没有」不是错误。
func Read(root string) (*Info, error) {
	raw, err := os.ReadFile(Path(root))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var info Info
	if err := json.Unmarshal(raw, &info); err != nil {
		return nil, fmt.Errorf("解析 %s 失败: %w", FileName, err)
	}
	if info.PID <= 0 {
		return nil, fmt.Errorf("%s 的 pid 无效: %d", FileName, info.PID)
	}
	if info.StartedAt == 0 {
		info.StartedAt = time.Now().UnixMilli()
	}
	return &info, nil
}

// Write 原子写入运行信息：先写临时文件再 rename，避免控制台读到半截 JSON。
func Write(root string, info Info) error {
	if info.PID <= 0 {
		return errors.New("pid 必须为正数")
	}
	if info.StartedAt == 0 {
		info.StartedAt = time.Now().UnixMilli()
	}
	raw, err := json.Marshal(info)
	if err != nil {
		return err
	}
	raw = append(raw, '\n')

	target := Path(root)
	temp := target + ".tmp"
	// 0600：里面有 PID 与目录布局，不需要给其他用户读。
	if err := os.WriteFile(temp, raw, 0o600); err != nil {
		return err
	}
	if err := os.Rename(temp, target); err != nil {
		_ = os.Remove(temp)
		return err
	}
	return nil
}

// Remove 只删除「自己的」记录。
//
// 退出路径上可能已经有新实例起来了（更新脚本先杀旧进程再拉新进程，或用户
// 手动重启）：这时文件里的 PID 不是自己，删掉会让控制台丢失新实例的信息。
// 按 PID 比对可以避免这种自伤。
func Remove(root string, pid int) error {
	info, err := Read(root)
	if err != nil || info == nil || info.PID != pid {
		return nil
	}
	if err := os.Remove(Path(root)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}
