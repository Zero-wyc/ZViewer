package api_test

import (
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"

	"zviewer/backend/internal/api"
	"zviewer/backend/internal/auth"
	"zviewer/backend/internal/bilibili"
	"zviewer/backend/internal/config"
	"zviewer/backend/internal/store"
)

type boundaryTransport struct {
	mu      sync.Mutex
	cookies []string
}

func (c *boundaryTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	c.mu.Lock()
	c.cookies = append(c.cookies, r.Header.Get("Cookie"))
	c.mu.Unlock()
	return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"code":-404,"message":"controlled fixture: no media"}`)), Request: r}, nil
}

func TestBilibiliSharedResolveAccess(t *testing.T) {
	e := newTestEnv(t)
	defer e.teardown()
	owner := e.seedUser(t, "bili-owner", "fixture-pass", "user", "active")
	viewer := e.seedUser(t, "bili-viewer", "fixture-pass", "user", "active")
	outsider := e.seedUser(t, "bili-outsider", "fixture-pass", "user", "active")
	admin := e.seedUser(t, "bili-admin", "fixture-pass", "root", "active")
	e.seedRoom(t, "BILI0001", "active", &owner)
	e.seedRoom(t, "BILI0002", "active", &outsider)
	movie := e.seedMovie(t, "BILI0001", "bilibili", "")
	mustExec := func(query string, args ...any) {
		t.Helper()
		if _, err := e.conn.Exec(query, args...); err != nil {
			t.Fatal(err)
		}
	}
	mustExec(`UPDATE "movie" SET "url"='https://www.bilibili.com/video/BV17x411w7KC' WHERE "id"=?`, movie)
	mustExec(`CREATE TABLE "bilibili_credential" ("userId" INTEGER PRIMARY KEY, "cookie" TEXT, "refreshToken" TEXT)`)
	dummy := "SESSDATA=fixture-never-a-real-account"
	mustExec(`INSERT INTO "bilibili_credential" ("userId","cookie") VALUES (?,?)`, owner, base64.StdEncoding.EncodeToString([]byte(dummy)))
	svc := bilibili.NewService(e.conn)
	capture := &boundaryTransport{}
	svc.Client.SetTransport(capture)
	dir := t.TempDir()
	cfg := &config.Config{ProjectRoot: dir, ConfigDir: dir, UploadsDir: dir, AvatarsDir: dir, MediaDir: dir, FrontendDist: dir}
	srv := api.New(api.Deps{Cfg: cfg, DB: e.conn, Users: e.users, Settings: store.NewSettings(e.conn), Tokens: e.tokens, Auth: auth.NewAuthenticator(e.tokens, e.users), Movies: store.NewMovies(e.conn), Rooms: store.NewRooms(e.conn), Bilibili: svc})
	e.handler = srv.Handler()
	request := func(user int64, role, id, video string, want int, borrow bool) {
		t.Helper()
		capture.mu.Lock()
		capture.cookies = nil
		capture.mu.Unlock()
		query := "/api/stream/resolve-bilibili?preferMp4=true&url=" + video
		if id != "absent" {
			query += "&movieId=" + id
		}
		response := e.do(t, http.MethodGet, query, e.token(t, user, role, "fixture"), nil)
		if response.status != want {
			t.Fatalf("status=%d want=%d: %+v", response.status, want, response.body)
		}
		capture.mu.Lock()
		defer capture.mu.Unlock()
		found := false
		for _, cookie := range capture.cookies {
			if strings.Contains(cookie, dummy) {
				found = true
			}
		}
		if found != borrow {
			t.Fatalf("owner credential used=%t want=%t", found, borrow)
		}
		if want != 200 && len(capture.cookies) != 0 {
			t.Fatal("denied request reached upstream")
		}
	}
	id := fmt.Sprint(movie)
	video := "https://www.bilibili.com/video/BV17x411w7KC"
	t.Run("outsider", func(t *testing.T) { request(outsider, "user", id, video, 403, false) })
	mustExec(`INSERT INTO "session" ("roomId","socketId","role","userId") VALUES ('BILI0002','other-room','viewer',?)`, outsider)
	t.Run("other room", func(t *testing.T) { request(outsider, "user", id, video, 403, false) })
	mustExec(`INSERT INTO "session" ("roomId","socketId","role","userId") VALUES ('BILI0001','ended','viewer',?)`, viewer)
	mustExec(`UPDATE "session" SET "endedAt"=datetime('now') WHERE "socketId"='ended'`)
	t.Run("ended session", func(t *testing.T) { request(viewer, "user", id, video, 403, false) })
	mustExec(`INSERT INTO "session" ("roomId","socketId","role","userId") VALUES ('BILI0001','joined','viewer',?)`, viewer)
	t.Run("member", func(t *testing.T) { request(viewer, "user", id, video, 200, true) })
	t.Run("owner", func(t *testing.T) { request(owner, "user", id, video, 200, true) })
	t.Run("root", func(t *testing.T) { request(admin, "root", id, video, 200, true) })
	t.Run("resource mismatch", func(t *testing.T) {
		request(viewer, "user", id, "https://www.bilibili.com/video/BV1Q541167Qg", 400, false)
	})
	t.Run("invalid id", func(t *testing.T) { request(viewer, "user", "bad", video, 400, false) })
	t.Run("empty id", func(t *testing.T) { request(viewer, "user", "", video, 400, false) })
	t.Run("missing movie", func(t *testing.T) { request(viewer, "user", "999999", video, 404, false) })
	t.Run("own resolve", func(t *testing.T) { request(viewer, "user", "absent", video, 200, false) })
	mustExec(`UPDATE "room" SET "status"='closed' WHERE "roomId"='BILI0001'`)
	t.Run("closed room viewer", func(t *testing.T) { request(viewer, "user", id, video, 403, false) })
	t.Run("closed room owner", func(t *testing.T) { request(owner, "user", id, video, 200, true) })
}
