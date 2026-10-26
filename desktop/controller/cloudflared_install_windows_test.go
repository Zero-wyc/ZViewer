//go:build windows

package controller

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

type cloudflaredLockingReader struct {
	io.Reader
	onEOF func()
	once  sync.Once
}

func (r *cloudflaredLockingReader) Read(p []byte) (int, error) {
	n, err := r.Reader.Read(p)
	if err == io.EOF {
		r.once.Do(r.onEOF)
	}
	return n, err
}

func lockCloudflaredFile(t *testing.T, path string) windows.Handle {
	t.Helper()
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		t.Fatal(err)
	}
	handle, err := windows.CreateFile(name, windows.GENERIC_READ,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING,
		windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		t.Fatal(err)
	}
	return handle
}

// Reproduce the actual Windows sharing violation on the just-downloaded file
// after the proxy has failed and the official source has returned the binary.
func TestCloudflaredFallbackRetriesWindowsFileLock(t *testing.T) {
	dir := t.TempDir()
	c := &Controller{root: dir, dir: dir, tunnelGeneration: 1}
	asset := append([]byte("MZ"), bytes.Repeat([]byte{0x41}, (1<<20)+64)...)
	digest := fmt.Sprintf("%x", sha256.Sum256(asset))
	const download = "https://github.com/cloudflare/cloudflared/releases/download/2026.10.3/cloudflared-windows-amd64.exe"
	proxyAPI := cloudflaredSourceURL(cloudflaredSourceProxy, cloudflaredReleaseAPI)
	var requests []string
	var release sync.WaitGroup
	defer release.Wait()
	transport := tunnelRoundTripFunc(func(r *http.Request) (*http.Response, error) {
		u := r.URL.String()
		requests = append(requests, u)
		status := http.StatusOK
		var body io.Reader
		switch u {
		case proxyAPI:
			status, body = http.StatusBadGateway, bytes.NewReader(nil)
		case cloudflaredReleaseAPI:
			body = bytes.NewBufferString(fmt.Sprintf(`{"tag_name":"2026.10.3","body":"cloudflared-windows-amd64.exe: %s"}`, digest))
		case download:
			body = &cloudflaredLockingReader{Reader: bytes.NewReader(asset), onEOF: func() {
				files, _ := filepath.Glob(filepath.Join(dir, ".cloudflared-*.download"))
				if len(files) != 1 {
					t.Fatalf("expected one download: %v", files)
				}
				handle := lockCloudflaredFile(t, files[0])
				release.Add(1)
				go func() { defer release.Done(); time.Sleep(250 * time.Millisecond); windows.CloseHandle(handle) }()
			}}
		default:
			t.Fatalf("unexpected request: %s", u)
		}
		return &http.Response{StatusCode: status, Body: io.NopCloser(body), Header: http.Header{}, ContentLength: -1, Request: r}, nil
	})
	previousClient, previousTransport := http.DefaultClient, http.DefaultTransport
	http.DefaultClient, http.DefaultTransport = &http.Client{Transport: transport}, transport
	t.Cleanup(func() { http.DefaultClient, http.DefaultTransport = previousClient, previousTransport })
	path, err := c.prepareCloudflared(context.Background(), 1, cloudflaredSourceProxy)
	if err != nil {
		t.Fatalf("official fallback failed while Windows temporarily held the file: %v", err)
	}
	if path != filepath.Join(dir, "cloudflared.exe") {
		t.Fatalf("wrong installed path: %s", path)
	}
	if !reflect.DeepEqual(requests, []string{proxyAPI, cloudflaredReleaseAPI, download}) {
		t.Fatalf("unexpected repeated downloads: %v", requests)
	}
	leftovers, _ := filepath.Glob(filepath.Join(dir, ".cloudflared-*"))
	if len(leftovers) != 0 {
		t.Fatalf("locked download leftovers: %v", leftovers)
	}
}

func TestCloudflaredInstallWindowsLocks(t *testing.T) {
	for _, locked := range []string{"download", "installed"} {
		t.Run(locked, func(t *testing.T) {
			dir := t.TempDir()
			temporary, target := filepath.Join(dir, "new.download"), filepath.Join(dir, "cloudflared.exe")
			if err := os.WriteFile(temporary, []byte("new component"), 0600); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(target, []byte("old component"), 0600); err != nil {
				t.Fatal(err)
			}
			path := temporary
			if locked == "installed" {
				path = target
			}
			handle := lockCloudflaredFile(t, path)
			released := make(chan struct{})
			go func() { defer close(released); time.Sleep(150 * time.Millisecond); windows.CloseHandle(handle) }()
			defer func() { <-released }()
			if err := installCloudflared(context.Background(), temporary, target); err != nil {
				t.Fatal(err)
			}
			got, err := os.ReadFile(target)
			if err != nil || string(got) != "new component" {
				t.Fatalf("new component not installed: %q, %v", got, err)
			}
			if _, err := os.Stat(temporary + ".previous"); !os.IsNotExist(err) {
				t.Fatal("old rollback file was not removed")
			}
		})
	}
}

func TestCloudflaredInstallCancellationRestoresOldFile(t *testing.T) {
	dir := t.TempDir()
	temporary, target := filepath.Join(dir, "new.download"), filepath.Join(dir, "cloudflared.exe")
	if err := os.WriteFile(temporary, []byte("new component"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, []byte("old component"), 0600); err != nil {
		t.Fatal(err)
	}
	handle := lockCloudflaredFile(t, temporary)
	defer windows.CloseHandle(handle)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { time.Sleep(50 * time.Millisecond); cancel() }()
	started := time.Now()
	err := installCloudflared(ctx, temporary, target)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation not propagated: %v", err)
	}
	if time.Since(started) > time.Second {
		t.Fatal("file lock retry ignored cancellation")
	}
	got, readErr := os.ReadFile(target)
	if readErr != nil || string(got) != "old component" {
		t.Fatalf("old component not restored: %q, %v", got, readErr)
	}
}

func TestCloudflaredPersistentInstallLockDoesNotSwitchSource(t *testing.T) {
	dir := t.TempDir()
	c := &Controller{root: dir, dir: dir, tunnelGeneration: 1}
	target := filepath.Join(dir, "cloudflared.exe")
	if err := os.WriteFile(target, []byte("old component fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	handle := lockCloudflaredFile(t, target)
	defer windows.CloseHandle(handle)
	asset := append([]byte("MZ"), bytes.Repeat([]byte{0x41}, (1<<20)+64)...)
	digest := fmt.Sprintf("%x", sha256.Sum256(asset))
	var requests []string
	proxyAPI := cloudflaredSourceURL(cloudflaredSourceProxy, cloudflaredReleaseAPI)
	proxyDownload := cloudflaredSourceURL(cloudflaredSourceProxy, "https://github.com/cloudflare/cloudflared/releases/download/2026.10.3/cloudflared-windows-amd64.exe")
	transport := tunnelRoundTripFunc(func(r *http.Request) (*http.Response, error) {
		u := r.URL.String()
		requests = append(requests, u)
		body := asset
		if u == proxyAPI {
			body = []byte(fmt.Sprintf(`{"tag_name":"2026.10.3","body":"cloudflared-windows-amd64.exe: %s"}`, digest))
		} else if u != proxyDownload {
			t.Fatalf("local installation failure switched network sources: %s", u)
		}
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(bytes.NewReader(body)), Header: http.Header{}, ContentLength: int64(len(body)), Request: r}, nil
	})
	oldClient, oldTransport := http.DefaultClient, http.DefaultTransport
	http.DefaultClient, http.DefaultTransport = &http.Client{Transport: transport}, transport
	t.Cleanup(func() { http.DefaultClient, http.DefaultTransport = oldClient, oldTransport })
	path, err := c.prepareCloudflared(context.Background(), 1, cloudflaredSourceProxy)
	if err != nil || path != target {
		t.Fatalf("did not retain old component: %q, %v", path, err)
	}
	got, _ := os.ReadFile(target)
	if string(got) != "old component fixture" {
		t.Fatal("occupied old component changed")
	}
	if !reflect.DeepEqual(requests, []string{proxyAPI, proxyDownload}) {
		t.Fatalf("unnecessary fallback: %v", requests)
	}
	leftovers, _ := filepath.Glob(filepath.Join(dir, ".cloudflared-*"))
	if len(leftovers) != 0 {
		t.Fatalf("leftover installation files: %v", leftovers)
	}
}
