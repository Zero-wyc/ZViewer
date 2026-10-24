package clientlog

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFormatLine(t *testing.T) {
	line := formatLine(Entry{
		Level:     "warn",
		Messages:  []json.RawMessage{json.RawMessage(`"播放失败"`), json.RawMessage(`{"code":500}`)},
		Timestamp: "2026-10-25T01:02:03.456Z",
		URL:       "https://example.com/room/1",
		UserID:    "42",
		RoomID:    "room-1",
	})
	want := "[2026-10-25T01:02:03.456Z] [WARN ] [room=room-1 user=42 url=https://example.com/room/1] 播放失败 {\"code\":500}\n"
	if line != want {
		t.Fatalf("日志行不符:\n得到 %q\n期望 %q", line, want)
	}
}

func TestFormatLineDefaults(t *testing.T) {
	// 没传 level / timestamp 时的兜底：level 默认 log，时间取当前。
	line := formatLine(Entry{Messages: []json.RawMessage{json.RawMessage(`"hi"`)}})
	if !strings.HasPrefix(line, "[") || !strings.Contains(line, "] [LOG  ] hi") {
		t.Fatalf("兜底格式不符: %q", line)
	}
	if strings.Contains(line, "user=") {
		t.Fatalf("没有 userId 时不应输出 user= 段: %q", line)
	}
}

func TestFormatLineNumericUserID(t *testing.T) {
	// JSON 数字解出来是 float64，不能写成 3.4e+07 或 42.0
	line := formatLine(Entry{Level: "error", UserID: float64(42)})
	if !strings.Contains(line, "user=42]") {
		t.Fatalf("数字 userId 格式化不符: %q", line)
	}
}

func TestUnmarshalBatchRejectsGarbage(t *testing.T) {
	if got := UnmarshalBatch([]byte(`{"entries":[]}`)); len(got) != 0 {
		t.Fatalf("空数组应返回空，得到 %d", len(got))
	}
	if got := UnmarshalBatch([]byte(`{"entries":"x"}`)); got != nil {
		t.Fatalf("类型不对应返回 nil，得到 %v", got)
	}
	if got := UnmarshalBatch([]byte(`not json`)); got != nil {
		t.Fatalf("非 JSON 应返回 nil，得到 %v", got)
	}
}

func TestWriteAllAppends(t *testing.T) {
	root := t.TempDir()
	entries := []Entry{
		{Level: "info", Messages: []json.RawMessage{json.RawMessage(`"first"`)}},
		{Level: "error", Messages: []json.RawMessage{json.RawMessage(`"second"`)}},
	}
	WriteAll(root, entries)
	WriteAll(root, entries)

	raw, err := os.ReadFile(filepath.Join(root, "log", "frontend-console.log"))
	if err != nil {
		t.Fatalf("读取日志失败: %v", err)
	}
	lines := strings.Split(strings.TrimRight(string(raw), "\n"), "\n")
	if len(lines) != 4 {
		t.Fatalf("两次写入应得 4 行，得到 %d 行: %q", len(lines), raw)
	}
	if !strings.Contains(lines[0], "first") || !strings.Contains(lines[1], "second") {
		t.Fatalf("行内容不符: %q", lines[:2])
	}
}
