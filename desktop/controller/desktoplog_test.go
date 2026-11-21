package controller

import (
	"os"
	"path/filepath"
	"testing"
)

// writeSizedFile 生成指定字节数的文件，用来模拟历史日志。
func writeSizedFile(t *testing.T, path string, size int64) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatalf("mkdir %s: %v", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, bytesOfSize(size), 0o600); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func bytesOfSize(size int64) []byte {
	buf := make([]byte, size)
	for i := range buf {
		buf[i] = 'x'
	}
	return buf
}

// pruneDesktopLogs 必须清掉旧版本残留与超额滚动文件。
func TestPruneDesktopLogsRemovesLegacyAndExtra(t *testing.T) {
	dir := t.TempDir()
	logDir := filepath.Join(dir, "logs")
	writeSizedFile(t, filepath.Join(logDir, "desktop.log"), 1024)
	writeSizedFile(t, filepath.Join(logDir, "desktop.log.1"), 1024)
	writeSizedFile(t, filepath.Join(logDir, "desktop.log.2"), 1024)
	writeSizedFile(t, filepath.Join(logDir, "desktop.log.3"), 1024)
	writeSizedFile(t, filepath.Join(logDir, "desktop.log.previous"), 1024)
	writeSizedFile(t, filepath.Join(logDir, "frontend-console.log"), 1024)

	pruneDesktopLogs(dir)

	for _, name := range []string{"desktop.log.3", "desktop.log.previous"} {
		if _, err := os.Stat(filepath.Join(logDir, name)); !os.IsNotExist(err) {
			t.Errorf("%s 应被删除，err=%v", name, err)
		}
	}
	for _, name := range []string{"desktop.log", "desktop.log.1", "desktop.log.2"} {
		if _, err := os.Stat(filepath.Join(logDir, name)); err != nil {
			t.Errorf("%s 应保留：%v", name, err)
		}
	}
	// 非 desktop.log 系列不在本函数职责内，必须原样保留。
	if _, err := os.Stat(filepath.Join(logDir, "frontend-console.log")); err != nil {
		t.Errorf("frontend-console.log 不应被删除：%v", err)
	}
}

// 超过总预算时从最老的备份开始删，直到落回预算内。
func TestPruneDesktopLogsEnforcesTotalBudget(t *testing.T) {
	dir := t.TempDir()
	logDir := filepath.Join(dir, "logs")
	active := int64(maxDesktopLogTotalBytes/3 + 1)
	writeSizedFile(t, filepath.Join(logDir, "desktop.log"), active)
	writeSizedFile(t, filepath.Join(logDir, "desktop.log.1"), active)
	writeSizedFile(t, filepath.Join(logDir, "desktop.log.2"), active)

	pruneDesktopLogs(dir)

	if got := desktopLogDirBytes(logDir); got > maxDesktopLogTotalBytes {
		t.Fatalf("清理后仍超预算：%d > %d", got, maxDesktopLogTotalBytes)
	}
	// 三份各 ~2MiB+1 超出预算，最老的 .2 必须先被删掉。
	if _, err := os.Stat(filepath.Join(logDir, "desktop.log.2")); !os.IsNotExist(err) {
		t.Errorf("最老备份 desktop.log.2 应被删除，err=%v", err)
	}
	if _, err := os.Stat(filepath.Join(logDir, "desktop.log")); err != nil {
		t.Errorf("当前日志 desktop.log 不应被删除：%v", err)
	}
}

// 空目录 / 目录不存在时不能 panic。
func TestPruneDesktopLogsMissingDir(t *testing.T) {
	pruneDesktopLogs(filepath.Join(t.TempDir(), "not-exist"))
}

// 日志目录统计只算 desktop.log 系列。
func TestDesktopLogDirBytes(t *testing.T) {
	dir := t.TempDir()
	if got := desktopLogDirBytes(dir); got != 0 {
		t.Errorf("空目录应为 0，得到 %d", got)
	}
	writeSizedFile(t, filepath.Join(dir, "desktop.log"), 100)
	writeSizedFile(t, filepath.Join(dir, "desktop.log.1"), 50)
	writeSizedFile(t, filepath.Join(dir, "other.log"), 999)
	if got := desktopLogDirBytes(dir); got != 150 {
		t.Errorf("应为 150，得到 %d", got)
	}
}

// LiveKit 日志记录起点判定：栈帧行必须返回 false，否则过滤会把后续记录吞掉。
func TestLivekitRecordStart(t *testing.T) {
	rec := "2026-11-06T19:18:32.098+0800\tERROR\tlivekit\thwstats/cpu_null.go:38\tCPU monitoring unsupported"
	cases := []struct {
		line string
		want bool
	}{
		{rec, true},
		{"\tgithub.com/livekit/livekit-server/pkg/rtc.(*RTC).Start()", false},
		{"\t/home/runner/go/pkg/mod/github.com/livekit/server-sdk-go@v1.2.3/room.go:88 +0x1c", false},
		{"", false},
		{"2026-11-06", false},
		{"2026-11-06T19:18:32.098+0800\tINFO\tlivekit\tstarting", true},
		{"2026/11/06 19:18:32 服务已就绪", false},
	}
	for _, c := range cases {
		if got := livekitRecordStart(c.line); got != c.want {
			t.Errorf("livekitRecordStart(%q) = %v，期望 %v", c.line, got, c.want)
		}
	}
}

// rotateDesktopLog 滚动顺序：.1 → .2，当前 → .1，旧版 .previous 清掉，最老的 .2 被覆盖。
func TestRotateDesktopLog(t *testing.T) {
	dir := t.TempDir()
	active := filepath.Join(dir, "desktop.log")
	writeSizedFile(t, active, 1024)
	writeSizedFile(t, active+".1", 2048)
	writeSizedFile(t, active+".2", 4096)
	writeSizedFile(t, active+".previous", 512)

	rotateDesktopLog(active)

	if _, err := os.Stat(active); !os.IsNotExist(err) {
		t.Errorf("当前日志应被移走，err=%v", err)
	}
	if _, err := os.Stat(active + ".previous"); !os.IsNotExist(err) {
		t.Errorf("desktop.log.previous 应被清掉，err=%v", err)
	}
	if got := fileSize(t, active+".1"); got != 1024 {
		t.Errorf(".1 应为原当前日志（1024B），得到 %d", got)
	}
	if got := fileSize(t, active+".2"); got != 2048 {
		t.Errorf(".2 应为原 .1（2048B），得到 %d", got)
	}
	if got := fileSize(t, active+".3"); got != 0 {
		t.Errorf("不应生成 .3，得到 %d", got)
	}
}

func fileSize(t *testing.T, path string) int64 {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		return 0
	}
	return info.Size()
}
