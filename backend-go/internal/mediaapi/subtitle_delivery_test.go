package mediaapi_test

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"zviewer/backend/internal/emby"
	"zviewer/backend/internal/jellyfin"
	"zviewer/backend/internal/mediaapi"
)

func TestSubtitleByDeliveryURLPreservesQueryAndAddsPrefixOnce(t *testing.T) {
	var gotPath, gotToken string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotToken = r.URL.RequestURI(), r.Header.Get("X-Emby-Token")
		w.Write([]byte("subtitle"))
	}))
	defer server.Close()

	client := mediaapi.NewClientWithProtocol(server.URL, "fixture-token", emby.Protocol)
	for _, delivery := range []string{
		"/Videos/item/Subtitles/2/Stream.srt?api_key=delivery-key&tag=one",
		"/emby/Videos/item/Subtitles/2/Stream.srt?api_key=delivery-key&tag=one",
	} {
		body, err := client.SubtitleByDeliveryURL(context.Background(), delivery)
		if err != nil || body != "subtitle" {
			t.Fatalf("SubtitleByDeliveryURL() = %q, %v", body, err)
		}
		if gotPath != "/emby/Videos/item/Subtitles/2/Stream.srt?api_key=delivery-key&tag=one" {
			t.Fatalf("request URI = %q", gotPath)
		}
		if gotToken != "fixture-token" {
			t.Fatalf("auth token = %q", gotToken)
		}
	}

	subpathClient := mediaapi.NewClientWithProtocol(server.URL+"/media", "fixture-token", emby.Protocol)
	for _, delivery := range []string{
		"/Videos/item/Subtitles/2/Stream.srt",
		"/emby/Videos/item/Subtitles/2/Stream.srt",
		"/media/emby/Videos/item/Subtitles/2/Stream.srt",
	} {
		body, err := subpathClient.SubtitleByDeliveryURL(context.Background(), delivery)
		if err != nil || body != "subtitle" {
			t.Fatalf("subpath SubtitleByDeliveryURL(%q) = %q, %v", delivery, body, err)
		}
		if gotPath != "/media/emby/Videos/item/Subtitles/2/Stream.srt" {
			t.Fatalf("subpath request URI for %q = %q", delivery, gotPath)
		}
	}
}

func TestSubtitleByDeliveryURLJellyfinBasePath(t *testing.T) {
	const path = "/jellyfin/Videos/item/Subtitles/2/Stream.srt"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != path {
			http.NotFound(w, r)
			return
		}
		io.WriteString(w, "subtitle")
	}))
	defer server.Close()
	client := mediaapi.NewClientWithProtocol(server.URL+"/jellyfin", "fixture-token", jellyfin.Protocol)
	for _, delivery := range []string{strings.TrimPrefix(path, "/jellyfin"), path, server.URL + path} {
		if body, err := client.SubtitleByDeliveryURL(context.Background(), delivery); err != nil || body != "subtitle" {
			t.Errorf("SubtitleByDeliveryURL(%q) = %q, %v", delivery, body, err)
		}
	}
}

func TestSubtitlesRejectCrossOriginRedirect(t *testing.T) {
	var requests atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		io.WriteString(w, "subtitle")
	}))
	defer target.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/emby/delivered" {
			io.WriteString(w, "subtitle")
			return
		}
		location := target.URL
		if r.URL.Path == "/emby/local" {
			location = "/emby/delivered"
		}
		http.Redirect(w, r, location, http.StatusFound)
	}))
	defer server.Close()
	client := emby.NewClient(server.URL, "fixture-token")
	ctx := context.Background()
	for _, extract := range []func(context.Context, string, string, int, string) (string, error){client.SubtitleContent, client.SubtitleContentFromStart} {
		if _, err := extract(ctx, "item", "version", 2, "srt"); err == nil {
			t.Error("cross-origin subtitle redirect succeeded")
		}
	}
	if _, err := client.SubtitleByDeliveryURL(ctx, "/remote"); err == nil || requests.Load() != 0 {
		t.Fatalf("cross-origin redirect was not blocked: requests=%d, err=%v", requests.Load(), err)
	}
	if body, err := client.SubtitleByDeliveryURL(ctx, "/local"); err != nil || body != "subtitle" {
		t.Fatalf("same-origin redirect failed: %q, %v", body, err)
	}
}

func TestSubtitleByDeliveryURLRejectsInvalidResponses(t *testing.T) {
	const limit = 4 * 1024 * 1024
	for _, fixture := range []struct {
		name, contentType, body string
		oversized               bool
	}{
		{"empty", "text/plain", " \ufeff\n", false},
		{"html-content-type", "text/html; charset=utf-8", "Login", false},
		{"html-doctype", "text/plain", " \ufeff \n<!DOCTYPE HTML>", false},
		{"html-tag", "text/plain", "<HTML lang=en>", false},
		{"oversized", "text/plain", strings.Repeat("x", limit+1), true},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", fixture.contentType)
				io.WriteString(w, fixture.body)
			}))
			defer server.Close()
			client := emby.NewClient(server.URL, "fixture-token")
			ctx := context.Background()
			if _, err := client.SubtitleByDeliveryURL(ctx, "/delivery"); err == nil {
				t.Error("invalid response was accepted")
			}
			if fixture.oversized {
				for _, extract := range []func(context.Context, string, string, int, string) (string, error){client.SubtitleContent, client.SubtitleContentFromStart} {
					_, err := extract(ctx, "item", "version", 2, "srt")
					var upstream *mediaapi.Error
					if !errors.As(err, &upstream) || upstream.Status != http.StatusRequestEntityTooLarge {
						t.Errorf("expected size limit error, got %v", err)
					}
				}
			}
		})
	}
}

func TestSubtitleByDeliveryURLRejectsOtherOrigins(t *testing.T) {
	client := mediaapi.NewClientWithProtocol("https://media.example", "fixture-token", emby.Protocol)
	for _, delivery := range []string{"https://elsewhere.example/subtitle.srt", "//elsewhere.example/subtitle.srt", "subtitle.srt"} {
		if _, err := client.SubtitleByDeliveryURL(context.Background(), delivery); err == nil {
			t.Errorf("SubtitleByDeliveryURL(%q) unexpectedly succeeded", delivery)
		}
	}
}
