package instance

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestWriteReadRemove(t *testing.T) {
	root := t.TempDir()
	info := Info{PID: os.Getpid(), Port: 3456, HTTPS: true, Root: root}
	if err := Write(root, info); err != nil {
		t.Fatalf("写入失败: %v", err)
	}

	got, err := Read(root)
	if err != nil {
		t.Fatalf("读取失败: %v", err)
	}
	if got == nil || got.PID != info.PID || got.Port != 3456 || !got.HTTPS {
		t.Fatalf("读回的内容不对: %+v", got)
	}
	if got.StartedAt == 0 {
		t.Fatal("StartedAt 应自动补齐")
	}
	if got.Root != root {
		t.Fatalf("root 不对: %q", got.Root)
	}

	// 模式 0600：同机其他用户不该看到。
	raw, err := os.Stat(Path(root))
	if err != nil {
		t.Fatalf("stat 失败: %v", err)
	}
	if mode := raw.Mode().Perm(); mode != 0o600 {
		t.Fatalf("文件权限应为 0600，实际 %o", mode)
	}

	if err := Remove(root, info.PID); err != nil {
		t.Fatalf("删除失败: %v", err)
	}
	if again, err := Read(root); err != nil || again != nil {
		t.Fatalf("删除后应读到 nil，实际 %+v, err=%v", again, err)
	}
}

func TestReadMissingIsNotError(t *testing.T) {
	info, err := Read(t.TempDir())
	if err != nil || info != nil {
		t.Fatalf("文件不存在应返回 (nil, nil)，实际 %+v, err=%v", info, err)
	}
}

func TestRemoveOnlyOwnRecord(t *testing.T) {
	root := t.TempDir()
	// 记录属于另一个更快启动的实例（更新后被拉起的那个）。
	if err := Write(root, Info{PID: 4242, Port: 3333, StartedAt: time.Now().UnixMilli()}); err != nil {
		t.Fatalf("写入失败: %v", err)
	}
	if err := Remove(root, 1111); err != nil {
		t.Fatalf("删除失败: %v", err)
	}
	if info, _ := Read(root); info == nil || info.PID != 4242 {
		t.Fatalf("别人的记录不该被删: %+v", info)
	}
}

func TestWriteRejectsInvalidPID(t *testing.T) {
	if err := Write(t.TempDir(), Info{PID: 0}); err == nil {
		t.Fatal("pid=0 应报错")
	}
}

func TestReadCorruptFileReportsError(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, FileName), []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Read(root); err == nil {
		t.Fatal("坏 JSON 应报错，而不是当成没有实例")
	}
}
