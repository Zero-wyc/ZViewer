package proxy

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestOrdinaryProxyFollowsRedirectsWithRange(t *testing.T) {
	for _, status := range []int{301, 302, 303, 307, 308} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			var rangeHeader string
			rec := runProxy(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/old.mp4" {
					w.Header().Set("Location", "/final.mp4")
					w.WriteHeader(status)
					return
				}
				rangeHeader = r.Header.Get("Range")
				w.Header().Set("Content-Type", "video/mp4")
				w.Header().Set("Content-Range", "bytes 2-5/10")
				w.WriteHeader(206)
				io.WriteString(w, "2345")
			}), func() *http.Request {
				r := httptest.NewRequest("GET", "/old.mp4", nil)
				r.Header.Set("Range", "bytes=2-5")
				return r
			}(), HTTPOptions{})
			if rec.Code != 206 || rec.Body.String() != "2345" || rangeHeader != "bytes=2-5" {
				t.Fatal(rec.Code, rec.Body.String(), rangeHeader)
			}
		})
	}
}

func TestResolveUpstreamURLUsesBoundedGETAndStripsRedirectCredentials(t *testing.T) {
	var gotRange, leaked bool
	cdn := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotRange = r.Method == http.MethodGet && r.Header.Get("Range") == "bytes=0-0"
		leaked = r.Header.Get("X-Emby-Token") != "" || r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != ""
		w.WriteHeader(206)
		io.WriteString(w, "x")
	}))
	defer cdn.Close()
	final := cdn.URL + "/episode.mkv?signature=fixture"
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodHead {
			w.WriteHeader(405)
			return
		}
		http.Redirect(w, r, final, http.StatusFound)
	}))
	defer gateway.Close()
	resolved, err := ResolveUpstreamURL(context.Background(), HTTPOptions{
		URL: gateway.URL + "/stream", Headers: UpstreamHeaders{Cookie: "fixture", Extra: map[string]string{"X-Emby-Token": "fixture", "Authorization": "fixture"}},
	})
	if err != nil || resolved != final || !gotRange || leaked {
		t.Fatal(resolved, err, gotRange, leaked)
	}
}

func TestRedirectPolicyAndCredentialsApplyToEveryHop(t *testing.T) {
	var leaked bool
	rec := runProxy(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/start" {
			w.Header().Set("Location", "http://other.example.invalid/final")
			w.WriteHeader(302)
			return
		}
		leaked = r.Header.Get("Cookie") != "" || r.Header.Get("Authorization") != "" || r.Header.Get("X-Emby-Token") != ""
		io.WriteString(w, "ok")
	}), httptest.NewRequest("GET", "/start", nil), HTTPOptions{Headers: UpstreamHeaders{Cookie: "fixture-private", Extra: map[string]string{"Authorization": "fixture-secret", "X-Emby-Token": "fixture-secret"}}})
	if rec.Code != 200 || leaked {
		t.Fatal(rec.Code, leaked)
	}
	var reached bool
	rec = runProxy(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/start" {
			w.Header().Set("Location", "http://other.example.invalid/final")
			w.WriteHeader(302)
			return
		}
		reached = true
	}), httptest.NewRequest("GET", "/start", nil), HTTPOptions{ValidateTarget: func(u *url.URL) error {
		if u.Hostname() != "media.example.com" {
			return errors.New("outside image domain")
		}
		return nil
	}})
	if rec.Code != 502 || reached {
		t.Fatal("redirect escaped allowlist", rec.Code, reached)
	}
}

func TestRedirectFinalURLIsHLSBaseAndLoopBounded(t *testing.T) {
	var base string
	rec := runProxy(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/start" {
			w.Header().Set("Location", "/final/index.m3u8")
			w.WriteHeader(302)
			return
		}
		w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
		io.WriteString(w, "#EXTM3U\nsegment.ts\n")
	}), httptest.NewRequest("GET", "/start", nil), HTTPOptions{RewriteHLSUri: func(uri, playlistURL string) string { base = playlistURL; return uri }})
	if rec.Code != 200 || base != "http://media.example.com/final/index.m3u8" {
		t.Fatal(rec.Code, base)
	}
	var hops int
	rec = runProxy(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hops++
		w.Header().Set("Location", "/loop")
		w.WriteHeader(302)
	}), httptest.NewRequest("GET", "/loop", nil), HTTPOptions{})
	if rec.Code != 502 || hops > 21 {
		t.Fatal(rec.Code, hops)
	}
}

func TestPublicTransportRejectsActualPrivateDial(t *testing.T) {
	// This exercises the actual dial boundary, not only URL pre-validation.
	transport := publicClient.Transport.(*http.Transport)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	for _, target := range []string{"127.0.0.1:9", "[::1]:9", "localhost:9"} {
		if conn, err := transport.DialContext(ctx, "tcp", target); err == nil {
			conn.Close()
			t.Fatal("private connection allowed", target)
		} else if !strings.Contains(err.Error(), "内网") {
			t.Fatal(err)
		}
	}
}
