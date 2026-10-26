package controller

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptrace"
	"os"
	"path/filepath"
	"testing"
	"testing/synctest"
	"time"
)

type cloudflaredDownloadChunk struct {
	delay time.Duration
	data  []byte
}

type cloudflaredDownloadTestBody struct {
	ctx     context.Context
	chunks  []cloudflaredDownloadChunk
	pending []byte
	stall   bool
	closed  bool
}

func (b *cloudflaredDownloadTestBody) Read(p []byte) (int, error) {
	if len(b.pending) == 0 {
		if len(b.chunks) == 0 {
			if b.stall {
				<-b.ctx.Done()
				return 0, b.ctx.Err()
			}
			return 0, io.EOF
		}
		chunk := b.chunks[0]
		b.chunks = b.chunks[1:]
		if err := waitTunnel(b.ctx, chunk.delay); err != nil {
			return 0, err
		}
		b.pending = chunk.data
	}
	n := copy(p, b.pending)
	b.pending = b.pending[n:]
	return n, nil
}

func (b *cloudflaredDownloadTestBody) Close() error { b.closed = true; return nil }

func cloudflaredDownloadFixture(t *testing.T, roundTrip func(*http.Request) (*http.Response, error)) *Controller {
	t.Helper()
	oldTransport := http.DefaultTransport
	http.DefaultTransport = tunnelRoundTripFunc(roundTrip)
	t.Cleanup(func() { http.DefaultTransport = oldTransport })
	dir := t.TempDir()
	return &Controller{root: dir, dir: dir}
}

func assertCloudflaredDownloadClean(t *testing.T, c *Controller) {
	t.Helper()
	leftovers, err := filepath.Glob(filepath.Join(c.root, ".cloudflared-*"))
	if err != nil || len(leftovers) != 0 {
		t.Fatalf("temporary files after download: %v, %v", leftovers, err)
	}
}

func TestCloudflaredDownloadNoResponseTimeout(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		c := cloudflaredDownloadFixture(t, func(r *http.Request) (*http.Response, error) {
			<-r.Context().Done()
			return nil, r.Context().Err()
		})
		started := time.Now()
		_, err := c.downloadCloudflared(t.Context(), cloudflaredDownloadURL, "", false)
		if !errors.Is(err, errCloudflaredDownloadIdle) || time.Since(started) != time.Minute {
			t.Fatalf("no-response timeout: elapsed=%v, error=%v", time.Since(started), err)
		}
		if _, err := os.Stat(filepath.Join(c.root, "cloudflared.exe")); !os.IsNotExist(err) {
			t.Fatal("no-response download installed a file")
		}
		assertCloudflaredDownloadClean(t, c)
	})
}

func TestCloudflaredDownloadBodyStallAndCancellation(t *testing.T) {
	for _, cancelByUser := range []bool{false, true} {
		name := "idle timeout preserves old component"
		if cancelByUser {
			name = "user cancellation preserves old component"
		}
		t.Run(name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				var body *cloudflaredDownloadTestBody
				c := cloudflaredDownloadFixture(t, func(r *http.Request) (*http.Response, error) {
					body = &cloudflaredDownloadTestBody{ctx: r.Context(), chunks: []cloudflaredDownloadChunk{{delay: 40 * time.Second, data: []byte("MZpartial")}}, stall: true}
					return &http.Response{StatusCode: http.StatusOK, Body: body, Header: http.Header{}, ContentLength: -1}, nil
				})
				target := filepath.Join(c.root, "cloudflared.exe")
				const old = "existing component must survive an interrupted download"
				if err := os.WriteFile(target, []byte(old), 0600); err != nil {
					t.Fatal(err)
				}
				ctx, cancel := context.WithCancel(t.Context())
				defer cancel()
				if cancelByUser {
					time.AfterFunc(50*time.Second, cancel)
				}
				started := time.Now()
				_, err := c.downloadCloudflared(ctx, cloudflaredDownloadURL, "", true)
				wantErr, wantElapsed := errCloudflaredDownloadIdle, 100*time.Second
				if cancelByUser {
					wantErr, wantElapsed = context.Canceled, 50*time.Second
				}
				if !errors.Is(err, wantErr) || time.Since(started) != wantElapsed {
					t.Fatalf("interrupted body: elapsed=%v, error=%v", time.Since(started), err)
				}
				if !body.closed {
					t.Fatal("response body was not closed")
				}
				data, err := os.ReadFile(target)
				if err != nil || string(data) != old {
					t.Fatalf("existing component changed: %q, %v", data, err)
				}
				assertCloudflaredDownloadClean(t, c)
			})
		})
	}
}

func TestCloudflaredDownloadEmptyReadsDoNotExtendTimeout(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		c := cloudflaredDownloadFixture(t, func(r *http.Request) (*http.Response, error) {
			body := &cloudflaredDownloadTestBody{ctx: r.Context(), chunks: []cloudflaredDownloadChunk{
				{delay: 20 * time.Second}, {delay: 20 * time.Second}, {delay: 20 * time.Second},
			}, stall: true}
			return &http.Response{StatusCode: http.StatusOK, Body: body, Header: http.Header{}, ContentLength: -1}, nil
		})
		started := time.Now()
		if _, err := c.downloadCloudflared(t.Context(), cloudflaredDownloadURL, "", false); !errors.Is(err, errCloudflaredDownloadIdle) || time.Since(started) != time.Minute {
			t.Fatalf("empty reads extended timeout: elapsed=%v error=%v", time.Since(started), err)
		}
		assertCloudflaredDownloadClean(t, c)
	})
}

func TestCloudflaredDownloadProgressHasNoTotalDeadline(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		asset := append([]byte("MZ"), bytes.Repeat([]byte{0x41}, (1<<20)+64)...)
		var requestContext context.Context
		c := cloudflaredDownloadFixture(t, func(r *http.Request) (*http.Response, error) {
			requestContext = r.Context()
			body := &cloudflaredDownloadTestBody{ctx: requestContext, chunks: []cloudflaredDownloadChunk{
				{delay: 45 * time.Second, data: asset[:2]},
				{delay: 45 * time.Second, data: asset[2:4]},
				{delay: 45 * time.Second, data: asset[4:6]},
				{delay: 45 * time.Second, data: asset[6:]},
			}}
			return &http.Response{StatusCode: http.StatusOK, Body: body, Header: http.Header{}, ContentLength: int64(len(asset))}, nil
		})
		started := time.Now()
		path, err := c.downloadCloudflared(t.Context(), cloudflaredDownloadURL, "", false)
		if err != nil || time.Since(started) != 3*time.Minute {
			t.Fatalf("progressing download: elapsed=%v, error=%v", time.Since(started), err)
		}
		data, err := os.ReadFile(path)
		if err != nil || !bytes.Equal(data, asset) {
			t.Fatal("slow download did not install the complete component")
		}
		assertCloudflaredDownloadClean(t, c)
		// A finished download must not leave a live timer that later changes
		// its cancellation cause into a spurious idle error.
		time.Sleep(2 * time.Minute)
		if !errors.Is(context.Cause(requestContext), context.Canceled) {
			t.Fatalf("watchdog survived completed download: %v", context.Cause(requestContext))
		}
	})
}

func TestCloudflaredDownloadResponseAndRedirectProgress(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		asset := append([]byte("MZ"), bytes.Repeat([]byte{0x41}, (1<<20)+64)...)
		requests := 0
		c := cloudflaredDownloadFixture(t, func(r *http.Request) (*http.Response, error) {
			requests++
			// First response byte refreshes the budget even before all headers
			// arrive. A redirect then refreshes it for the next request.
			if err := waitTunnel(r.Context(), 40*time.Second); err != nil {
				return nil, err
			}
			if trace := httptrace.ContextClientTrace(r.Context()); trace != nil && trace.GotFirstResponseByte != nil {
				trace.GotFirstResponseByte()
			}
			if err := waitTunnel(r.Context(), 40*time.Second); err != nil {
				return nil, err
			}
			if requests == 1 {
				return &http.Response{StatusCode: http.StatusFound, Header: http.Header{"Location": {"https://release-assets.githubusercontent.com/cloudflared.exe"}}, Body: io.NopCloser(bytes.NewReader(nil)), ContentLength: 0}, nil
			}
			return &http.Response{StatusCode: http.StatusOK, Header: http.Header{}, Body: io.NopCloser(bytes.NewReader(asset)), ContentLength: int64(len(asset))}, nil
		})
		started := time.Now()
		if _, err := c.downloadCloudflared(t.Context(), cloudflaredDownloadURL, "", false); err != nil || requests != 2 || time.Since(started) != 160*time.Second {
			t.Fatalf("response/redirect progress: requests=%d elapsed=%v error=%v", requests, time.Since(started), err)
		}
		assertCloudflaredDownloadClean(t, c)
	})
}
