package piikbridge

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// openPersistent 在 dir 上起一个带房间库的桥接层。调用方负责 Close，
// 因为「重启」这件事正好就是 Close 再 New 一次。
func openPersistent(t *testing.T, dir string) *Bridge {
	t.Helper()
	bridge, err := New(Options{StateDir: dir})
	if err != nil {
		t.Fatalf("New(%s): %v", dir, err)
	}
	t.Cleanup(func() { _ = bridge.Close(context.Background()) })
	return bridge
}

func readBindings(t *testing.T, dir string) bindingDocument {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(dir, bindingFileName))
	if err != nil {
		t.Fatalf("read bindings: %v", err)
	}
	var document bindingDocument
	if err := json.Unmarshal(data, &document); err != nil {
		t.Fatalf("decode bindings: %v", err)
	}
	return document
}

// 重启是最常见的一次「房间库还在不在」的检验：房主与观众手里的凭证都是
// 进程发出去的，重启后必须仍然能进同一个房间。
func TestRoomSurvivesRestart(t *testing.T) {
	dir := t.TempDir()

	first := openPersistent(t, dir)
	host, err := first.Host("ROOM0001")
	if err != nil {
		t.Fatalf("Host: %v", err)
	}
	viewer, err := first.Viewer("ROOM0001")
	if err != nil {
		t.Fatalf("Viewer: %v", err)
	}
	if err := first.Close(context.Background()); err != nil {
		t.Fatalf("Close: %v", err)
	}

	second := openPersistent(t, dir)
	again, err := second.Host("ROOM0001")
	if err != nil {
		t.Fatalf("Host after restart: %v", err)
	}
	if again != host {
		t.Fatalf("host credentials changed across restart:\n got %+v\nwant %+v", again, host)
	}
	viewerAgain, err := second.Viewer("ROOM0001")
	if err != nil {
		t.Fatalf("Viewer after restart: %v", err)
	}
	if viewerAgain != viewer {
		t.Fatalf("viewer credentials changed across restart:\n got %+v\nwant %+v", viewerAgain, viewer)
	}
}

// 映射改了就要落盘：否则重启后房间库还在、映射却是旧的。
func TestReleaseForgetsPersistedBinding(t *testing.T) {
	dir := t.TempDir()

	first := openPersistent(t, dir)
	host, err := first.Host("ROOM0002")
	if err != nil {
		t.Fatalf("Host: %v", err)
	}
	if err := first.Release("ROOM0002"); err != nil {
		t.Fatalf("Release: %v", err)
	}
	if err := first.Close(context.Background()); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if rooms := readBindings(t, dir).Rooms; len(rooms) != 0 {
		t.Fatalf("bindings after Release = %v, want empty", rooms)
	}

	second := openPersistent(t, dir)
	if _, err := second.Viewer("ROOM0002"); err != ErrNoRoom {
		t.Fatalf("Viewer after restart = %v, want ErrNoRoom", err)
	}
	recreated, err := second.Host("ROOM0002")
	if err != nil {
		t.Fatalf("Host after restart: %v", err)
	}
	if recreated.Token == host.Token {
		t.Fatal("released room was resurrected from the binding file")
	}
}

// 房间库被删掉（换机器、手滑 rm）而映射文件还在时，死映射必须丢掉：
// 每条死映射都占着一个房间码，9000 个码经不起几次重启。
func TestStaleBindingsDroppedWhenRoomDatabaseLost(t *testing.T) {
	dir := t.TempDir()

	first := openPersistent(t, dir)
	if _, err := first.Host("ROOM0003"); err != nil {
		t.Fatalf("Host: %v", err)
	}
	if err := first.Close(context.Background()); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if err := os.Remove(filepath.Join(dir, roomDatabaseName)); err != nil {
		t.Fatalf("remove room database: %v", err)
	}

	second := openPersistent(t, dir)
	if rooms := readBindings(t, dir).Rooms; len(rooms) != 0 {
		t.Fatalf("stale bindings kept: %v", rooms)
	}
	if _, err := second.Viewer("ROOM0003"); err != ErrNoRoom {
		t.Fatalf("Viewer = %v, want ErrNoRoom", err)
	}
	if _, err := second.Host("ROOM0003"); err != nil {
		t.Fatalf("Host after losing the database: %v", err)
	}
}

// 运行期的映射失效（房间被空房回收）也要写回磁盘，否则下次重启又会把
// 那条死映射读回来。
func TestRecreatedRoomRewritesBinding(t *testing.T) {
	dir := t.TempDir()

	first := openPersistent(t, dir)
	host, err := first.Host("ROOM0004")
	if err != nil {
		t.Fatalf("Host: %v", err)
	}
	// 绕开 Release：只结束 Piik 房间、留下映射，模拟空房超时回收。
	if err := first.signal.EndRoom(host.RoomID, host.Token); err != nil {
		t.Fatalf("EndRoom: %v", err)
	}
	recreated, err := first.Host("ROOM0004")
	if err != nil {
		t.Fatalf("Host after expiry: %v", err)
	}
	if recreated.Token == host.Token {
		t.Fatal("expired room authority was reused")
	}

	rooms := readBindings(t, dir).Rooms
	if len(rooms) != 1 || rooms[0].PiikRoomID != recreated.RoomID {
		t.Fatalf("bindings = %v, want the new room %s", rooms, recreated.RoomID)
	}
}

// 映射文件坏了不该让共享整体不可用：备份原文件、按空映射启动，之后照常写。
func TestCorruptBindingsFileRecovers(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, bindingFileName)
	if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
		t.Fatalf("write corrupt file: %v", err)
	}

	bridge := openPersistent(t, dir)
	if _, err := bridge.Host("ROOM0005"); err != nil {
		t.Fatalf("Host: %v", err)
	}
	if _, err := os.Stat(path + ".corrupt"); err != nil {
		t.Fatalf("corrupt file was not preserved: %v", err)
	}
	if rooms := readBindings(t, dir).Rooms; len(rooms) != 1 {
		t.Fatalf("bindings after recovery = %v", rooms)
	}
}

// token 是明文落盘的（Piik 库里只有摘要），权限必须收紧。
func TestBindingsFileIsPrivate(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows 上不体现 POSIX 权限位")
	}
	dir := t.TempDir()
	bridge := openPersistent(t, dir)
	if _, err := bridge.Host("ROOM0006"); err != nil {
		t.Fatalf("Host: %v", err)
	}
	info, err := os.Stat(filepath.Join(dir, bindingFileName))
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if mode := info.Mode().Perm(); mode != 0o600 {
		t.Fatalf("mode = %o, want 600", mode)
	}
}

// 不配 StateDir 时保持纯内存：测试与嵌入式用法不该凭空多出文件。
func TestDefaultBridgeWritesNoFiles(t *testing.T) {
	dir := t.TempDir()
	t.Chdir(dir)
	bridge, err := New(Options{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if _, err := bridge.Host("ROOM0007"); err != nil {
		t.Fatalf("Host: %v", err)
	}
	if err := bridge.Close(context.Background()); err != nil {
		t.Fatalf("Close: %v", err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read dir: %v", err)
	}
	if len(entries) != 0 {
		t.Fatalf("in-memory bridge wrote %v", entries)
	}
}
