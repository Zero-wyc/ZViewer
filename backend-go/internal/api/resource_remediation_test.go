package api_test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"zviewer/backend/internal/proxy"
	"zviewer/backend/internal/store"
	"zviewer/backend/internal/subtitle"
)

func TestRemediationOBSBoundaryAndForwardedHost(t *testing.T) {
	t.Setenv("SERVER_HOST", "")
	t.Setenv("TRUSTED_PROXY_CIDRS", "127.0.0.0/8")
	e := newTestEnv(t)
	defer e.teardown()
	owner := e.seedUser(t, "publish-owner", "fixture-password", "user", "active")
	ownerToken := e.token(t, owner, "user", "publish-owner")
	key := strings.Repeat("LEGACY88", 4)
	e.insertPushRoom(t, "SECURE01", "screen-share", &key)
	e.conn.Exec(`UPDATE room SET ownerUserId=? WHERE roomId='SECURE01'`, owner)
	if got, _ := e.doObsConfig(t, "SECURE01", e.guestToken(t), "localhost:3333"); got.StatusCode != 403 {
		t.Fatal(got.StatusCode)
	}
	for _, tc := range []struct{ remote, forwarded, want string }{
		{"127.0.0.1:1234", "public.example.invalid", "rtmp://public.example.invalid:3334/live"},
		{"192.0.2.1:1234", "attacker.invalid", "rtmp://localhost:3334/live"},
		{"127.0.0.1:1234", "bad.invalid,other.invalid", "rtmp://localhost:3334/live"},
		{"127.0.0.1:1234", "[2001:db8::1]", "rtmp://[2001:db8::1]:3334/live"},
	} {
		req := httptest.NewRequest("GET", "/api/stream-push/obs-config/SECURE01", nil)
		req.RemoteAddr = tc.remote
		req.Host = "localhost:3333"
		req.Header.Set("X-Forwarded-Host", tc.forwarded)
		req.Header.Set("Authorization", "Bearer "+ownerToken)
		rec := httptest.NewRecorder()
		e.handler.ServeHTTP(rec, req)
		if rec.Code != 200 || !strings.Contains(rec.Body.String(), tc.want) || strings.Contains(rec.Body.String(), key) {
			t.Fatalf("%d %s", rec.Code, rec.Body.String())
		}
	}
	e.conn.Exec(`UPDATE room SET status='closed' WHERE roomId='SECURE01'`)
	if got, _ := e.doObsConfig(t, "SECURE01", ownerToken, ""); got.StatusCode != 403 {
		t.Fatal(got.StatusCode)
	}
}

func TestRemediationFileAndSubtitleAdmission(t *testing.T) {
	e := newTestEnv(t)
	defer e.teardown()
	owner := e.seedUser(t, "file-owner", "fixture-password", "root", "active")
	viewer := e.seedUser(t, "file-viewer", "fixture-password", "user", "active")
	ownerToken := e.token(t, owner, "root", "file-owner")
	token := e.token(t, viewer, "user", "file-viewer")
	e.seedRoom(t, "FILE0001", "active", &owner)
	id := e.seedMovie(t, "FILE0001", "server-files", "uploads:/shared/video.mp4")
	e.writeUpload(t, "shared/video.mp4", "0123456789")
	e.writeUpload(t, "shared/video.srt", "1\n00:00:00,000 --> 00:00:01,000\nfixture\n")
	e.writeUpload(t, "shared/private.txt", "private")
	e.writeUpload(t, "private/note.srt", "private subtitle")
	endpoint := fmt.Sprintf("/api/server-files/proxy?movieId=%d&path=uploads:/shared/private.txt", id)
	if got := e.do(t, "GET", endpoint, token, nil); got.status != 403 {
		t.Fatal(got.status)
	}
	if _, err := e.conn.Exec(`INSERT INTO session(roomId,socketId,role,userId) VALUES('FILE0001','viewer','viewer',?)`, viewer); err != nil {
		t.Fatal(err)
	}
	if got := e.do(t, "GET", "/api/server-files/proxy?path=uploads:/shared/private.txt", token, nil); got.status != 403 {
		t.Fatal(got.status)
	}
	rec := e.doRaw(t, "GET", endpoint, token, map[string]string{"Range": "bytes=2-5"})
	if rec.Code != 206 || rec.Body.String() != "2345" {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	for _, tc := range []struct {
		path   string
		status int
	}{{"uploads:/shared/video.srt", 200}, {"uploads:/shared/private.txt", 400}, {"uploads:/private/note.srt", 403}} {
		got := e.do(t, "GET", fmt.Sprintf("/api/subtitles/load?movieId=%d&path=%s", id, url.QueryEscape(tc.path)), token, nil)
		if got.status != tc.status {
			t.Fatalf("%s: %d %s", tc.path, got.status, got.raw)
		}
	}
	if got := e.do(t, "GET", fmt.Sprintf("/api/subtitles/browse?movieId=%d&path=uploads:/private", id), token, nil); got.status != 403 {
		t.Fatal(got.status)
	}
	if got := e.do(t, "GET", fmt.Sprintf("/api/subtitles/load?movieId=%d&path=uploads:/private/note.srt", id), ownerToken, nil); got.status != 200 {
		t.Fatal(got.status, got.raw)
	}
	for _, size := range []int{subtitle.MaxSubtitleBytes, subtitle.MaxSubtitleBytes + 1} {
		e.writeUpload(t, "shared/large.srt", strings.Repeat("x", size))
		got := e.do(t, "GET", fmt.Sprintf("/api/subtitles/load?movieId=%d&path=uploads:/shared/large.srt", id), token, nil)
		if size == subtitle.MaxSubtitleBytes && got.status != 200 {
			t.Fatal(got.status)
		}
		if size > subtitle.MaxSubtitleBytes && (got.status != 413 || got.body["code"] != "SUBTITLE_TOO_LARGE") {
			t.Fatal(got.status, got.raw)
		}
	}
	e.conn.Exec(`UPDATE session SET endedAt=datetime('now') WHERE socketId='viewer'`)
	if got := e.do(t, "GET", endpoint, token, nil); got.status != 403 {
		t.Fatal(got.status)
	}
	// Creating a movie must not turn a guessed registered path into a new grant.
	_, err := store.NewMovies(e.conn).Create(context.Background(), "FILE0001", store.MovieInput{URL: "/api/server-files/proxy?path=x", Title: "guessed", Source: ptrString("server-files"), Path: ptrString("uploads:/shared/private.txt")}, viewer)
	if err != store.ErrLocalFileShare {
		t.Fatalf("unexpected file share: %v", err)
	}
}

func ptrString(s string) *string { return &s }

func TestRemediationAvatarContentAndGenericProxy(t *testing.T) {
	e := newTestEnv(t)
	defer e.teardown()
	owner := e.seedUser(t, "avatar-secure", "fixture-password", "user", "active")
	token := e.token(t, owner, "user", "avatar-secure")
	upload := e.doMultipart(t, "/api/auth/avatar", token, "avatar", "image.html", "image/png", []byte("<!doctype html><body>inert fixture</body>"))
	if upload.status != 400 {
		t.Fatal(upload.status, upload.raw)
	}
	upload = e.doMultipart(t, "/api/auth/avatar", token, "avatar", "image.html", "text/plain", validAvatar(t))
	if upload.status != 200 {
		t.Fatal(upload.status, upload.raw)
	}
	avatar := fmt.Sprint(upload.userField("avatar"))
	if !strings.HasSuffix(avatar, ".png") {
		t.Fatal(avatar)
	}
	rec := e.doRaw(t, "GET", avatar, "", nil)
	if rec.Code != 200 || rec.Header().Get("Content-Type") != "image/png" || rec.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatal(rec.Code, rec.Header())
	}
	os.WriteFile(filepath.Join(e.avatars, "legacy.html"), []byte("<!doctype html>legacy fixture"), 0600)
	for _, path := range []string{"/uploads/avatars/", "/uploads/avatars/legacy.html"} {
		if got := e.doRaw(t, "GET", path, "", nil); got.Code != 404 {
			t.Fatal(got.Code)
		}
	}
	var calls atomic.Int32
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); io.WriteString(w, "private") }))
	defer up.Close()
	got := e.do(t, "GET", "/api/stream/proxy?url="+url.QueryEscape(up.URL), e.guestToken(t), nil)
	if got.status != 403 || calls.Load() != 0 {
		t.Fatal(got.status, calls.Load())
	}
}

func TestRemediationExplicitMountAndPortablePoster(t *testing.T) {
	e := newTestEnv(t)
	defer e.teardown()
	owner := e.seedUser(t, "mount-owner", "fixture-password", "user", "active")
	token := e.token(t, owner, "user", "mount-owner")
	e.seedRoom(t, "MOUNT001", "active", &owner)
	ctx := context.Background()
	mounts := store.NewMounts(e.conn)
	base := "http://localhost:8096"
	one := "one"
	two := "two"
	password := "fixture-password"
	m1, err := mounts.Create(ctx, store.MountInput{UserID: owner, Type: "webdav", Name: "one", ServerURL: &base, Username: &one, Password: &password})
	if err != nil {
		t.Fatal(err)
	}
	m2, err := mounts.Create(ctx, store.MountInput{UserID: owner, Type: "webdav", Name: "two", ServerURL: &base, Username: &two, Password: &password})
	if err != nil {
		t.Fatal(err)
	}
	payload := map[string]any{"url": base + "/v.mp4", "title": "fixture", "source": "webdav", "serverUrl": base, "path": "/v.mp4", "sourceMountId": m2.ID, "directLink": true}
	got := e.do(t, "POST", "/api/rooms/MOUNT001/movies", token, payload)
	if got.status != 201 {
		t.Fatal(got.status, got.raw)
	}
	movie := got.body["movie"].(map[string]any)
	if movie["sourceMountId"] != float64(m2.ID) || movie["directLink"] != false || !strings.HasPrefix(fmt.Sprint(movie["url"]), "/api/webdav/stream?movieId=") {
		t.Fatal(movie)
	}
	id := int64(movie["id"].(float64))
	stored, err := store.NewMovies(e.conn).FindByID(ctx, id)
	if err != nil || stored.Username == nil || *stored.Username != two {
		t.Fatal(stored, err)
	}
	// Same repository boundary is used by add-movie Socket, including credentials.
	input := store.MovieInput{URL: base + "/v.mp4", Title: "socket fixture", Source: ptrString("webdav"), ServerURL: &base, Path: ptrString("/v.mp4"), SourceMountID: &m2.ID, DirectLink: true}
	socketMovie, err := store.NewMovies(e.conn).Create(ctx, "MOUNT001", input, owner)
	if err != nil || socketMovie.DirectLink || *socketMovie.SourceMountID != m2.ID || *socketMovie.Username != two {
		t.Fatal(socketMovie, err)
	}
	resolver := proxy.NewStreamResolver(store.NewMovies(e.conn), store.NewRooms(e.conn), mounts)
	if _, err := resolver.Resolve(ctx, id, "webdav", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := e.conn.Exec(`UPDATE user_mount SET password='fixture-new-password' WHERE id=?`, m2.ID); err != nil {
		t.Fatal(err)
	}
	resolved, err := resolver.Resolve(ctx, id, "webdav", nil)
	if err != nil || resolved.Password != "fixture-new-password" {
		t.Fatal("anchored mount retained stale credentials", resolved, err)
	}
	e.conn.Exec(`DELETE FROM user_mount WHERE id=?`, m2.ID)
	if _, err := resolver.Resolve(ctx, id, "webdav", nil); err == nil {
		t.Fatal("deleted mount silently rebound to first account")
	}
	payload["sourceMountId"] = m1.ID
	payload["serverUrl"] = "http://different.invalid"
	if bad := e.do(t, "POST", "/api/rooms/MOUNT001/movies", token, payload); bad.status != 400 {
		t.Fatal(bad.status, bad.raw)
	}
	// Both image surfaces reject unsigned hashes before touching upstream credentials.
	var calls atomic.Int32
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Content-Type", "image/png")
		w.Write(validAvatar(t))
	}))
	defer up.Close()
	for _, kind := range []string{"emby", "jellyfin"} {
		apiKey, user := "FIXTURE_API_KEY", "fixture-user"
		server := up.URL
		mount, err := mounts.Create(ctx, store.MountInput{UserID: owner, Type: kind, Name: kind, ServerURL: &server, APIKey: &apiKey, EmbyUserID: &user})
		if err != nil {
			t.Fatal(err)
		}
		endpoint := fmt.Sprintf("/api/%s/mounts/%d/image?itemId=poster", kind, mount.ID)
		for _, tag := range []string{"", "&tag=upstream-cache-hash"} {
			if rec := e.doRaw(t, "GET", endpoint+tag, "", nil); rec.Code != 403 {
				t.Fatal(rec.Code)
			}
		}
		cover := "http://localhost:3333/private-channel" + endpoint + "&tag=old-expired-tag"
		in := store.MovieInput{URL: server + "/video", Title: "poster fixture", Source: &kind, SourceMountID: &mount.ID, ServerURL: &server, Path: ptrString("episode"), Cover: &cover}
		mv, err := store.NewMovies(e.conn).Create(ctx, "MOUNT001", in, owner)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(*mv.Cover, "localhost") || strings.Contains(*mv.Cover, "tag=") {
			t.Fatal(*mv.Cover)
		}
		list := e.do(t, "GET", "/api/rooms/MOUNT001/movies", token, nil)
		if list.status != 200 {
			t.Fatal(list.status, list.raw)
		}
		var signed string
		for _, raw := range list.body["movies"].([]any) {
			dto := raw.(map[string]any)
			if dto["id"] == float64(mv.ID) {
				signed = fmt.Sprint(dto["cover"])
			}
		}
		if !strings.HasPrefix(signed, "/api/") || strings.Contains(signed, apiKey) {
			t.Fatal(signed)
		}
		rec := e.doRaw(t, "GET", signed, "", nil)
		if rec.Code != 200 {
			t.Fatal(rec.Code, rec.Body.String())
		}
		for _, bad := range []string{strings.Replace(signed, "itemId=poster", "itemId=other", 1), strings.Replace(signed, "maxWidth=600", "maxWidth=9000", 1)} {
			if got := e.doRaw(t, "GET", bad, "", nil); got.Code == 200 {
				t.Fatal("invalid poster allowed")
			}
		}
	}
	if calls.Load() != 2 {
		t.Fatal(calls.Load())
	}
}

func TestRemediationWatchTicketRevokedWithSession(t *testing.T) {
	e := newTestEnv(t)
	defer e.teardown()
	owner := e.seedUser(t, "watch-host", "fixture-password", "user", "active")
	viewer := e.seedUser(t, "watch-viewer", "fixture-password", "user", "active")
	token := e.token(t, viewer, "user", "watch-viewer")
	key := "K2345678"
	e.insertPushRoom(t, "WATCH002", "screen-share", &key)
	e.conn.Exec(`UPDATE room SET ownerUserId=? WHERE roomId='WATCH002'`, owner)
	endpoint := "/api/stream-push/watch/WATCH002"
	if got := e.do(t, "GET", endpoint, token, nil); got.status != 403 {
		t.Fatal(got.status)
	}
	e.conn.Exec(`INSERT INTO session(roomId,socketId,role,userId) VALUES('WATCH002','watch-viewer','viewer',?)`, viewer)
	got := e.do(t, "GET", endpoint, token, nil)
	if got.status != 200 {
		t.Fatal(got.status, got.raw)
	}
	watch := fmt.Sprint(got.body["url"])
	if strings.Contains(watch, key) || !strings.Contains(watch, "ticket=") {
		t.Fatal(watch)
	}
	e.conn.Exec(`UPDATE session SET endedAt=datetime('now') WHERE socketId='watch-viewer'`)
	if rec := e.doRaw(t, "GET", watch, "", nil); rec.Code != 403 {
		t.Fatal(rec.Code)
	}
	// Expired capabilities fail even with otherwise valid resource identity.
	resource, _ := json.Marshal(map[string]any{"m": 1, "i": "poster", "k": "emby"})
	expired := e.tokens.SignCapability("poster", string(resource), -time.Second)
	if rec := e.doRaw(t, "GET", "/api/emby/mounts/1/image?itemId=poster&tag="+url.QueryEscape(expired), "", nil); rec.Code != 403 {
		t.Fatal(rec.Code)
	}
}
