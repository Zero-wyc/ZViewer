package api_test

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"zviewer/backend/internal/store"
)

func TestEmbyPlaybackDisabledTranscodingAndRedirect(t *testing.T) {
	for _, kind := range []string{"emby", "jellyfin"} {
		t.Run(kind, func(t *testing.T) {
			e := newTestEnv(t)
			defer e.teardown()
			owner := e.seedUser(t, "media-owner", "fixture-password", "user", "active")
			token := e.token(t, owner, "user", "media-owner")
			e.seedRoom(t, "EMBYMODE", "active", &owner)
			media := []byte{0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02}
			var hlsRequested bool
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch {
				case strings.HasSuffix(r.URL.Path, "/PlaybackInfo"):
					w.Header().Set("Content-Type", "application/json")
					fmt.Fprint(w, `{"MediaSources":[{"Id":"ms1","Path":"/episode.mkv","SupportsTranscoding":false,"MediaStreams":[{"Type":"Audio","Codec":"dts"}]},{"Id":"ms2","Path":"/episode-4k.mkv","SupportsTranscoding":false,"MediaStreams":[{"Type":"Audio","Codec":"dts"}]}]}`)
				case strings.HasSuffix(r.URL.Path, "/main.m3u8"):
					hlsRequested = true
					w.WriteHeader(403)
				case strings.HasSuffix(r.URL.Path, "/stream"):
					if r.URL.Query().Get("MediaSourceId") != "ms2" {
						t.Error("selected version lost")
					}
					http.Redirect(w, r, "/cdn/episode.mkv", http.StatusFound)
				case r.URL.Path == "/cdn/episode.mkv":
					w.Header().Set("Content-Type", "video/x-matroska")
					w.Header().Set("Content-Range", "bytes 0-5/6")
					w.WriteHeader(206)
					w.Write(media)
				default:
					http.NotFound(w, r)
				}
			}))
			defer upstream.Close()
			key, userID, base := "fixture-api-key", "fixture-user", upstream.URL
			mount, err := store.NewMounts(e.conn).Create(context.Background(), store.MountInput{
				UserID: owner, Type: kind, Name: kind, ServerURL: &base, APIKey: &key, EmbyUserID: &userID,
			})
			if err != nil {
				t.Fatal(err)
			}
			legacyFormat, item := "hls", "episode"
			movie, err := store.NewMovies(e.conn).Create(context.Background(), "EMBYMODE", store.MovieInput{
				URL: "/old.m3u8", Title: "legacy DTS", Source: &kind, ServerURL: &base,
				SourceMountID: &mount.ID, Path: &item, Format: &legacyFormat,
			}, owner)
			if err != nil {
				t.Fatal(err)
			}
			resolved := e.do(t, "GET", fmt.Sprintf("/api/%s/movie-source?movieId=%d&ms=ms2&direct=1", kind, movie.ID), token, nil)
			if resolved.status != 200 || resolved.body["format"] != "mkv" {
				t.Fatal(resolved.status, resolved.raw)
			}
			streamURL := fmt.Sprint(resolved.body["streamUrl"])
			if !strings.Contains(streamURL, "at=0&ms=ms2") {
				t.Fatal(streamURL)
			}
			if resolved.body["resolvedDirectUrl"] != base+"/cdn/episode.mkv" || !strings.Contains(fmt.Sprint(resolved.body["directUrl"]), "MediaSourceId=ms2") {
				t.Fatal("CDN URL must be separate from stable version URL", resolved.body)
			}
			stream := e.doRaw(t, "GET", streamURL, token, nil)
			if stream.Code != 206 || !bytes.Equal(stream.Body.Bytes(), media) || hlsRequested {
				t.Fatalf("legacy HLS must use redirected original media: %d, %x, HLS=%v", stream.Code, stream.Body.Bytes(), hlsRequested)
			}
		})
	}
}
