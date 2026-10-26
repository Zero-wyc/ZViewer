package controller

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestTunnelRefreshLimitAndCancellation(t *testing.T) {
	t.Run("five refreshes after initial candidate", func(t *testing.T) {
		attempts, refreshes := 0, 0
		err := runTunnelRefreshes(context.Background(), func(_ context.Context, index int) error {
			if index != attempts {
				t.Fatalf("unexpected candidate index %d", index)
			}
			attempts++
			return errors.New("HTTP 502")
		}, func(index int, _ error) {
			refreshes++
			if index != refreshes {
				t.Fatalf("unexpected refresh index %d", index)
			}
		})
		if err == nil || attempts != 6 || refreshes != 5 {
			t.Fatalf("attempts=%d refreshes=%d error=%v", attempts, refreshes, err)
		}
	})
	t.Run("stop during refresh prevents another launch", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		attempts := 0
		err := runTunnelRefreshes(ctx, func(context.Context, int) error { attempts++; return errors.New("failed") }, func(int, error) { cancel() })
		if !errors.Is(err, context.Canceled) || attempts != 1 {
			t.Fatalf("a canceled refresh launched another candidate: %d %v", attempts, err)
		}
	})
	t.Run("healthy candidate ends startup retries", func(t *testing.T) {
		attempts := 0
		err := runTunnelRefreshes(context.Background(), func(_ context.Context, index int) error {
			attempts++
			if index < 1 {
				return errors.New("failed")
			}
			return nil
		}, func(int, error) {})
		if err != nil || attempts != 2 {
			t.Fatalf("healthy candidate was replaced: %d %v", attempts, err)
		}
	})
}

func TestTunnelShortHealthChecks(t *testing.T) {
	t.Run("two timed out requests do not wait forty five seconds", func(t *testing.T) {
		calls := 0
		started := time.Now()
		_, err := checkTunnelCandidate(context.Background(), func(ctx context.Context) (time.Duration, error) { calls++; <-ctx.Done(); return 0, ctx.Err() }, func(error) {})
		if err == nil || calls != 2 || time.Since(started) > 6*time.Second {
			t.Fatalf("request budgets were not bounded: calls=%d elapsed=%s error=%v", calls, time.Since(started), err)
		}
	})
	t.Run("two failures stop this candidate promptly", func(t *testing.T) {
		calls := 0
		started := time.Now()
		_, err := checkTunnelCandidate(context.Background(), func(context.Context) (time.Duration, error) { calls++; return 0, errors.New("HTTP 502") }, func(error) {})
		if err == nil || calls != 2 || time.Since(started) > time.Second {
			t.Fatalf("slow or unbounded detection: calls=%d elapsed=%s error=%v", calls, time.Since(started), err)
		}
	})
	t.Run("cancel interrupts an in-flight request", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		entered := make(chan struct{})
		result := make(chan error, 1)
		go func() {
			_, err := checkTunnelCandidate(ctx, func(ctx context.Context) (time.Duration, error) { close(entered); <-ctx.Done(); return 0, ctx.Err() }, func(error) {})
			result <- err
		}()
		<-entered
		cancel()
		select {
		case err := <-result:
			if !errors.Is(err, context.Canceled) {
				t.Fatal(err)
			}
		case <-time.After(time.Second):
			t.Fatal("health request ignored cancellation")
		}
	})
}

func TestTunnelPublicOriginIdentity(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			io.WriteString(w, `{"status":"ok","startedAt":123}`)
		} else {
			io.WriteString(w, "ZViewer fixture")
		}
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, err := probePublicTunnel(ctx, server.URL, 123, server.Client()); err != nil {
		t.Fatal(err)
	}
	if _, err := probePublicTunnel(ctx, server.URL, 456, server.Client()); err == nil {
		t.Fatal("accepted a different backend generation")
	}
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(502) }))
	defer bad.Close()
	if _, err := probePublicTunnel(ctx, bad.URL, 0, bad.Client()); err == nil || !strings.Contains(err.Error(), "502") {
		t.Fatalf("gateway failure not identified: %v", err)
	}
}

func TestTunnelReconnectKeepsPublishedAddress(t *testing.T) {
	c := &Controller{tunnelGeneration: 1, tunnelState: "running", tunnelHealth: "healthy", tunnelURL: "https://same-address.trycloudflare.com"}
	originFailed := c.observeTunnelEvent(1, tunnelEvent{err: "HTTP/2 connection closed"}, false)
	if c.tunnelState != "reconnecting" || c.tunnelHealth != "degraded" {
		t.Fatalf("connection loss remained healthy: %s %s", c.tunnelState, c.tunnelHealth)
	}
	originFailed = c.observeTunnelEvent(1, tunnelEvent{registered: true}, originFailed)
	if c.tunnelState != "running" || c.tunnelURL != "https://same-address.trycloudflare.com" || c.tunnelRefreshCount != 0 {
		t.Fatal("reconnection changed the published tunnel")
	}
	originFailed = c.observeTunnelEvent(1, tunnelEvent{err: "Unable to reach the origin service", origin: true}, originFailed)
	c.observeTunnelEvent(1, tunnelEvent{registered: true}, originFailed)
	if c.tunnelHealth != "degraded" {
		t.Fatal("edge registration hid an unresolved origin error")
	}
}

type tunnelRoundTripFunc func(*http.Request) (*http.Response, error)

func (f tunnelRoundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestTunnelStopCancelsVersionRequest(t *testing.T) {
	for _, sourceExit := range []bool{false, true} {
		t.Run(fmt.Sprintf("sourceExit=%t", sourceExit), func(t *testing.T) {
			dir := t.TempDir()
			controller, err := New(Options{StateDir: dir, Root: dir, Cipher: plainCipher{}})
			if err != nil {
				t.Fatal(err)
			}
			origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, `{"status":"ok","startedAt":123}`) }))
			defer origin.Close()
			controller.store.Value.Port = origin.Listener.Addr().(*net.TCPAddr).Port
			controller.store.Value.Https = false
			// 主服务沿用旧配置运行时，隧道也必须读取刚保存的获取源。
			active := controller.store.Value.Clone()
			active.CloudflaredSource = cloudflaredSourceGitHub
			controller.active = &active
			if err := os.WriteFile(filepath.Join(dir, "cloudflared.exe"), []byte("never execute this fixture"), 0600); err != nil {
				t.Fatal(err)
			}
			entered := make(chan struct{})
			previous := http.DefaultClient
			http.DefaultClient = &http.Client{Transport: tunnelRoundTripFunc(func(r *http.Request) (*http.Response, error) {
				if r.URL.String() != cloudflaredSourceURL(cloudflaredSourceProxy, cloudflaredReleaseAPI) {
					t.Errorf("used stale active source for version check: %s", r.URL)
				}
				close(entered)
				<-r.Context().Done()
				return nil, r.Context().Err()
			})}
			defer func() { http.DefaultClient = previous }()
			if _, err := controller.StartTunnel(); err != nil {
				t.Fatal(err)
			}
			select {
			case <-entered:
			case <-time.After(3 * time.Second):
				t.Fatal("startup never reached version request")
			}
			started := time.Now()
			if sourceExit {
				controller.stopTunnelForOriginFailure()
			} else if err := controller.StopTunnel(); err != nil {
				t.Fatal(err)
			}
			if time.Since(started) > time.Second {
				t.Fatal("stop did not interrupt blocked version request")
			}
			report := controller.TunnelReport()
			if sourceExit && (report.State != "error" || report.URL != "") {
				t.Fatalf("dead origin remained connected: %+v", report)
			}
			if !sourceExit && report.State != "stopped" {
				t.Fatalf("stop did not finish: %+v", report)
			}
		})
	}
}

// Opt-in real network acceptance: only a disposable HTTPS fixture is exposed.
func TestTunnelHTTP2Live(t *testing.T) {
	exe := os.Getenv("ZVIEWER_TEST_CLOUDFLARED")
	if exe == "" {
		t.Skip("set ZVIEWER_TEST_CLOUDFLARED for live fixture acceptance")
	}
	dir := t.TempDir()
	controller, err := New(Options{StateDir: dir, Root: dir, Cipher: plainCipher{}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if t.Failed() {
			for _, event := range controller.events {
				if event.Source == "tunnel" {
					t.Log(event.Message)
				}
			}
		}
	})
	if _, err = controller.certs.Ensure("localhost", ""); err != nil {
		t.Fatal(err)
	}
	paths := controller.certs.Paths()
	cert, err := tls.LoadX509KeyPair(paths.Cert, paths.Key)
	if err != nil {
		t.Fatal(err)
	}
	origin := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			io.WriteString(w, `{"status":"ok","startedAt":123}`)
		} else {
			io.WriteString(w, "isolated ZViewer acceptance")
		}
	}))
	origin.TLS = &tls.Config{Certificates: []tls.Certificate{cert}}
	origin.StartTLS()
	defer origin.Close()
	config := DefaultConfig()
	config.Port = origin.Listener.Addr().(*net.TCPAddr).Port
	config.Https = true
	controller.tunnelGeneration = 1
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	if _, err := controller.probeTunnelOrigin(ctx, config); err != nil {
		t.Fatal(err)
	}
	var candidate *tunnelCandidate
	err = runTunnelRefreshes(ctx, func(ctx context.Context, index int) error {
		var err error
		candidate, err = controller.startTunnelCandidate(ctx, 1, config, exe, 123)
		return err
	}, func(index int, err error) { t.Logf("startup refresh %d/5: %v", index, err) })
	if err != nil {
		t.Fatal(err)
	}
	defer stopTunnelCandidate(candidate)
	for index := 0; index < 6; index++ {
		probeCtx, probeCancel := context.WithTimeout(ctx, 5*time.Second)
		_, err := probePublicTunnel(probeCtx, candidate.url, 123, http.DefaultClient)
		probeCancel()
		if err != nil {
			t.Fatalf("round trip %d: %v", index, err)
		}
		if err := waitTunnel(ctx, 2*time.Second); err != nil {
			t.Fatal(err)
		}
	}
	request, _ := http.NewRequestWithContext(ctx, http.MethodGet, candidate.url+"/", nil)
	response, err := (&http.Client{Timeout: 5 * time.Second}).Do(request)
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 4096))
	response.Body.Close()
	if err != nil || response.StatusCode != 200 || string(body) != "isolated ZViewer acceptance" {
		t.Fatalf("public homepage did not match HTTPS origin: HTTP %d %q %v", response.StatusCode, body, err)
	}
	t.Logf("HTTP/2 HTTPS fixture passed repeated end-to-end requests; initial probe %d ms", candidate.latencyMs)
}
