// Package clientlog 收集前端浏览器控制台上报的日志。
//
// 落盘到 `<project-root>/log/frontend-console.log`，单行格式：
//
//	[ISO8601] [LEVEL] [room=.. user=.. url=..] body
//
// 写入失败一律静默：日志系统自身故障不能反过来影响业务请求。
package clientlog

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Entry 是前端上报的一条日志。
type Entry struct {
	Level     string            `json:"level"`
	Messages  []json.RawMessage `json:"messages"`
	Timestamp string            `json:"timestamp"`
	URL       string            `json:"url"`
	UserAgent string            `json:"userAgent"`
	// UserID 用 any：前端传字符串或数字都有，Node 侧只做字符串插值。
	UserID any    `json:"userId"`
	RoomID string `json:"roomId"`
}

// batch 是上报体。
type batch struct {
	Entries []Entry `json:"entries"`
}

// UnmarshalBatch 解析上报体，返回 entries（空表示非法请求）。
func UnmarshalBatch(raw []byte) []Entry {
	var b batch
	if err := json.Unmarshal(raw, &b); err != nil {
		return nil
	}
	return b.Entries
}

// writer 串行化追加写，避免并发上报交错成半行。
var writeMu sync.Mutex

// WriteAll 批量追加写日志（逐条成行）。
func WriteAll(projectRoot string, entries []Entry) {
	if len(entries) == 0 {
		return
	}
	writeMu.Lock()
	defer writeMu.Unlock()

	logDir := filepath.Join(projectRoot, "log")
	if err := os.MkdirAll(logDir, 0o755); err != nil {
		return
	}
	path := filepath.Join(logDir, "frontend-console.log")
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return
	}
	defer f.Close()

	var sb strings.Builder
	for _, entry := range entries {
		sb.WriteString(formatLine(entry))
	}
	_, _ = f.WriteString(sb.String())
}

// formatLine 复刻 client-logger.ts#writeClientLog 的单行格式。
func formatLine(entry Entry) string {
	ts := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	if entry.Timestamp != "" {
		if parsed, err := time.Parse(time.RFC3339Nano, entry.Timestamp); err == nil {
			ts = parsed.UTC().Format("2006-01-02T15:04:05.000Z")
		}
	}
	level := strings.ToUpper(defaultString(entry.Level, "log"))
	// padEnd(5)：`LOG  ` / `ERROR`，对齐后肉眼扫日志更快。
	for len(level) < 5 {
		level += " "
	}

	meta := make([]string, 0, 3)
	if entry.RoomID != "" {
		meta = append(meta, "room="+entry.RoomID)
	}
	if uid := userIDString(entry.UserID); uid != "" {
		meta = append(meta, "user="+uid)
	}
	if entry.URL != "" {
		meta = append(meta, "url="+entry.URL)
	}
	metaPart := ""
	if len(meta) > 0 {
		metaPart = " [" + strings.Join(meta, " ") + "]"
	}

	return "[" + ts + "] [" + level + "]" + metaPart + " " + stringifyMessages(entry.Messages) + "\n"
}

// stringifyMessages 把消息数组拼成一段文本。
func stringifyMessages(messages []json.RawMessage) string {
	if len(messages) == 0 {
		return ""
	}
	parts := make([]string, 0, len(messages))
	for _, raw := range messages {
		trimmed := strings.TrimSpace(string(raw))
		if trimmed == "" {
			parts = append(parts, "undefined")
			continue
		}
		// 字符串按原文（去掉 JSON 引号转义），其余按 JSON 原文。
		if strings.HasPrefix(trimmed, `"`) {
			var s string
			if err := json.Unmarshal(raw, &s); err == nil {
				parts = append(parts, s)
				continue
			}
		}
		parts = append(parts, trimmed)
	}
	return strings.Join(parts, " ")
}

func userIDString(v any) string {
	switch val := v.(type) {
	case nil:
		return ""
	case string:
		return val
	case float64:
		// JSON 数字统一解成 float64；整数值不要输出成 3.4e+02。
		if val == float64(int64(val)) {
			return fmt.Sprintf("%d", int64(val))
		}
		return fmt.Sprintf("%v", val)
	default:
		return fmt.Sprint(val)
	}
}

func defaultString(v, fallback string) string {
	if v == "" {
		return fallback
	}
	return v
}
