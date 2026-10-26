package serverfiles

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
)

func makeEscapeLink(t *testing.T, link, target string) {
	t.Helper()
	if runtime.GOOS != "windows" {
		if err := os.Symlink(target, link); err != nil {
			t.Fatal(err)
		}
		return
	}
	cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "New-Item -ItemType Junction -Path $env:ZVIEWER_TEST_LINK -Target $env:ZVIEWER_TEST_TARGET | Out-Null")
	cmd.Env = append(os.Environ(), "ZVIEWER_TEST_LINK="+link, "ZVIEWER_TEST_TARGET="+target)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("junction: %v %s", err, out)
	}
}

func TestRootedIORejectsJunctionAndReplacement(t *testing.T) {
	base := t.TempDir()
	inside := filepath.Join(base, "root")
	outside := filepath.Join(base, "outside")
	for _, dir := range []string{inside, outside} {
		if err := os.MkdirAll(dir, 0755); err != nil {
			t.Fatal(err)
		}
	}
	sentinel := filepath.Join(outside, "sentinel.srt")
	os.WriteFile(sentinel, []byte("private fixture"), 0600)
	root := RootInfo{Key: "uploads", AbsPath: inside}
	makeEscapeLink(t, filepath.Join(inside, "escape"), outside)
	if _, _, err := ResolveSafePath("uploads:/escape/sentinel.srt", []RootInfo{root}); err == nil {
		t.Fatal("escaping link resolved")
	}
	if _, err := Open(root, filepath.Join(inside, "escape/sentinel.srt")); err == nil {
		t.Fatal("escaping read allowed")
	}
	if err := MkdirAll(root, filepath.Join(inside, "escape/new"), 0755); err == nil {
		t.Fatal("escaping mkdir allowed")
	}
	if _, err := OpenFile(root, filepath.Join(inside, "escape/new.srt"), os.O_CREATE|os.O_WRONLY, 0600); err == nil {
		t.Fatal("escaping write allowed")
	}
	// Replace a directory after a successful lexical/real-path check.
	os.Mkdir(filepath.Join(inside, "replace"), 0755)
	abs, _, err := ResolveSafePath("uploads:/replace/sentinel.srt", []RootInfo{root})
	if err != nil {
		t.Fatal(err)
	}
	os.Remove(filepath.Join(inside, "replace"))
	makeEscapeLink(t, filepath.Join(inside, "replace"), outside)
	if _, err := Open(root, abs); err == nil {
		t.Fatal("check/use replacement escaped")
	}
	if err := Rename(root, abs, filepath.Join(inside, "moved.srt")); err == nil {
		t.Fatal("escaping rename allowed")
	}
	// Removing a link itself may be allowed; traversing to its child is never allowed.
	if err := RemoveAll(root, abs); err == nil {
		t.Fatal("escaping delete allowed")
	}
	if data, err := os.ReadFile(sentinel); err != nil || string(data) != "private fixture" {
		t.Fatal("outside sentinel changed", err)
	}
}

func TestRootedIOPreservesRootLinksAndReadonly(t *testing.T) {
	base := t.TempDir()
	real := filepath.Join(base, "real")
	os.Mkdir(real, 0755)
	rootPath := filepath.Join(base, "configured-link")
	makeEscapeLink(t, rootPath, real)
	root := RootInfo{Key: "uploads", AbsPath: rootPath}
	f, err := OpenFile(root, filepath.Join(rootPath, "valid.srt"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	f.Close()
	root.Readonly = true
	if _, err := OpenFile(root, filepath.Join(rootPath, "new.srt"), os.O_CREATE|os.O_WRONLY, 0600); err != ErrRootReadonly {
		t.Fatal(err)
	}
	f, err = Open(root, filepath.Join(rootPath, "valid.srt"))
	if err != nil {
		t.Fatal(err)
	}
	f.Close()
}
