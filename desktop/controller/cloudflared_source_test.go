package controller

import (
	"bytes"
	"context"
	"crypto/sha256"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func TestCloudflaredSourceConfig(t *testing.T) {
	config, err := Validate(map[string]any{})
	if err != nil || config.CloudflaredSource != cloudflaredSourceGitCode {
		t.Fatalf("old settings must default to the GitCode mirror: %+v, %v", config, err)
	}
	for _, invalid := range []any{"mirror", "", true, nil} {
		if _, err := Validate(map[string]any{"cloudflaredSource": invalid}); err == nil {
			t.Fatalf("accepted invalid source: %v", invalid)
		}
	}
	dir := t.TempDir()
	store, err := NewStore(dir, dir, plainCipher{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Save(map[string]any{"cloudflaredSource": cloudflaredSourceGitHub}, nil); err != nil {
		t.Fatal(err)
	}
	reloaded, err := NewStore(dir, dir, plainCipher{})
	if err != nil || reloaded.Value.CloudflaredSource != cloudflaredSourceGitHub {
		t.Fatalf("source not persisted: %+v, %v", reloaded, err)
	}
}

func TestCloudflaredSourceRequestsAndFallback(t *testing.T) {
	asset := append([]byte("MZ"), bytes.Repeat([]byte{0x41}, (1<<20)+64)...)
	digest := fmt.Sprintf("%x", sha256.Sum256(asset))
	const directDownload = "https://github.com/cloudflare/cloudflared/releases/download/2026.10.3/cloudflared-windows-amd64.exe"
	proxyAPI := cloudflaredSourceURL(cloudflaredSourceProxy, cloudflaredReleaseAPI)
	proxyDownload := cloudflaredSourceURL(cloudflaredSourceProxy, directDownload)
	cases := []struct {
		name, source                                                                 string
		failProxyAPI, failProxyDownload, badProxyChecksum, cancel, failAll, existing bool
		want                                                                         []string
	}{
		{name: "proxy metadata and binary", source: cloudflaredSourceProxy, want: []string{proxyAPI, proxyDownload}},
		{name: "official metadata and binary", source: cloudflaredSourceGitHub, want: []string{cloudflaredReleaseAPI, directDownload}},
		{name: "API fallback", source: cloudflaredSourceProxy, failProxyAPI: true, want: []string{proxyAPI, cloudflaredReleaseAPI, directDownload}},
		{name: "download fallback", source: cloudflaredSourceProxy, failProxyDownload: true, want: []string{proxyAPI, proxyDownload, cloudflaredReleaseAPI, directDownload}},
		{name: "corrupt proxy binary", source: cloudflaredSourceProxy, badProxyChecksum: true, want: []string{proxyAPI, proxyDownload, cloudflaredReleaseAPI, directDownload}},
		{name: "cancellation prevents fallback", source: cloudflaredSourceProxy, cancel: true, want: []string{proxyAPI}},
		{name: "keep installed component offline", source: cloudflaredSourceProxy, failAll: true, existing: true, want: []string{proxyAPI, cloudflaredReleaseAPI}},
		{name: "official error never uses proxy", source: cloudflaredSourceGitHub, failAll: true, want: []string{cloudflaredReleaseAPI, cloudflaredDownloadURL}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			c := &Controller{root: dir, dir: dir, tunnelGeneration: 1}
			target := filepath.Join(dir, "cloudflared.exe")
			if tc.existing {
				if err := os.WriteFile(target, []byte("existing component fixture"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			var requests []string
			transport := tunnelRoundTripFunc(func(r *http.Request) (*http.Response, error) {
				u := r.URL.String()
				requests = append(requests, u)
				if tc.cancel {
					cancel()
					return nil, ctx.Err()
				}
				status, body := http.StatusOK, []byte{}
				switch u {
				case proxyAPI, cloudflaredReleaseAPI:
					body = []byte(fmt.Sprintf(`{"tag_name":"2026.10.3","body":"cloudflared-windows-amd64.exe: %s"}`, digest))
					if tc.failAll || (u == proxyAPI && tc.failProxyAPI) {
						status = http.StatusBadGateway
					}
				case proxyDownload, directDownload, cloudflaredDownloadURL:
					body = asset
					if tc.failAll || (u == proxyDownload && tc.failProxyDownload) {
						status = http.StatusBadGateway
					}
					if u == proxyDownload && tc.badProxyChecksum {
						body = append([]byte("MZ"), bytes.Repeat([]byte{0x42}, (1<<20)+64)...)
					}
				default:
					t.Fatalf("unexpected request: %s", u)
				}
				return &http.Response{StatusCode: status, Body: io.NopCloser(bytes.NewReader(body)), Header: http.Header{}, ContentLength: int64(len(body)), Request: r}, nil
			})
			oldClient, oldTransport := http.DefaultClient, http.DefaultTransport
			http.DefaultClient, http.DefaultTransport = &http.Client{Transport: transport}, transport
			t.Cleanup(func() { http.DefaultClient, http.DefaultTransport = oldClient, oldTransport })
			path, err := c.prepareCloudflared(ctx, 1, tc.source)
			if !reflect.DeepEqual(requests, tc.want) {
				t.Fatalf("requests=%v, want=%v", requests, tc.want)
			}
			if tc.cancel || (tc.failAll && !tc.existing) {
				if err == nil {
					t.Fatal("expected failure")
				}
				if _, err := os.Stat(target); !os.IsNotExist(err) {
					t.Fatal("failed download left an installed file")
				}
				return
			}
			if err != nil || path != target {
				t.Fatalf("path=%q, error=%v", path, err)
			}
			got, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			if tc.existing {
				if string(got) != "existing component fixture" {
					t.Fatal("old component changed")
				}
			} else if !bytes.Equal(got, asset) {
				t.Fatal("installed component is not the expected official artifact")
			}
			leftovers, _ := filepath.Glob(filepath.Join(dir, ".cloudflared-*"))
			if len(leftovers) != 0 {
				t.Fatalf("download leftovers: %v", leftovers)
			}
		})
	}
}

func TestCloudflaredDownloadHostPolicy(t *testing.T) {
	for _, raw := range []string{
		cloudflaredDownloadURL,
		cloudflaredSourceURL(cloudflaredSourceProxy, cloudflaredDownloadURL),
		"https://release-assets.githubusercontent.com/file.exe",
	} {
		if !validCloudflaredDownloadURL(raw) {
			t.Errorf("rejected known source %s", raw)
		}
	}
	for _, raw := range []string{
		"http://gh-proxy.com/file.exe", "https://gh-proxy.com.evil.example/file.exe",
		"https://github.com.evil.example/file.exe", "https://github.com:8443/file.exe",
		"https://user:pass@github.com/file.exe", "https://example.com/file.exe",
	} {
		if validCloudflaredDownloadURL(raw) {
			t.Errorf("accepted unexpected source %s", raw)
		}
	}
}

// Opt in to installing only the official component in a disposable directory;
// no tunnel is opened and no user service or settings are accessed.
func TestCloudflaredProxyDownloadLive(t *testing.T) {
	if os.Getenv("ZVIEWER_TEST_CLOUDFLARED_DOWNLOAD") != "1" {
		t.Skip("set ZVIEWER_TEST_CLOUDFLARED_DOWNLOAD=1 for a real component download")
	}
	dir := t.TempDir()
	c := &Controller{root: dir, dir: dir, tunnelGeneration: 1}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	exe, err := c.prepareCloudflared(ctx, 1, cloudflaredSourceProxy)
	if err != nil {
		t.Fatal(err)
	}
	if version := installedCloudflaredVersion(ctx, exe); version == "" {
		t.Fatal("downloaded component did not report its version")
	} else {
		t.Logf("installed cloudflared %s from proxy", version)
	}
}
