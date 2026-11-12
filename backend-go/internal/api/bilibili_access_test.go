package api_test

import (
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
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

// TestCliHostResolveGuards 覆盖 CLI「房主直链」的四道闸门：
// 必须带 movieId、管理员开关、房主必须有 B站 身份、正常放行且用房主 Cookie。
func TestCliHostResolveGuards(t *testing.T) {
	e := newTestEnv(t)
	defer e.teardown()

	owner := e.seedUser(t, "cli-owner", "fixture-pass", "user", "active")
	noAccount := e.seedUser(t, "cli-noaccount", "fixture-pass", "user", "active")
	viewer := e.seedUser(t, "cli-viewer", "fixture-pass", "user", "active")
	e.seedRoom(t, "CLIHOST1", "active", &owner)
	e.seedRoom(t, "CLIHOST2", "active", &noAccount)
	shared := e.seedMovie(t, "CLIHOST1", "bilibili", "")
	bare := e.seedMovie(t, "CLIHOST2", "bilibili", "")
	video := "https://www.bilibili.com/video/BV17x411w7KC"

	mustExec := func(query string, args ...any) {
		t.Helper()
		if _, err := e.conn.Exec(query, args...); err != nil {
			t.Fatal(err)
		}
	}
	mustExec(`UPDATE "movie" SET "url"=? WHERE "id"=?`, video, shared)
	mustExec(`UPDATE "movie" SET "url"=? WHERE "id"=?`, video, bare)
	mustExec(`CREATE TABLE "bilibili_credential" ("userId" INTEGER PRIMARY KEY, "cookie" TEXT, "refreshToken" TEXT)`)
	dummy := "SESSDATA=fixture-never-a-real-account"
	mustExec(`INSERT INTO "bilibili_credential" ("userId","cookie") VALUES (?,?)`, owner, base64.StdEncoding.EncodeToString([]byte(dummy)))
	mustExec(`INSERT INTO "session" ("roomId","socketId","role","userId") VALUES ('CLIHOST1','cli-s1','viewer',?)`, viewer)
	mustExec(`INSERT INTO "session" ("roomId","socketId","role","userId") VALUES ('CLIHOST2','cli-s2','viewer',?)`, viewer)

	svc := bilibili.NewService(e.conn)
	capture := &boundaryTransport{}
	svc.Client.SetTransport(capture)
	dir := t.TempDir()
	cfg := &config.Config{ProjectRoot: dir, ConfigDir: dir, UploadsDir: dir, AvatarsDir: dir, MediaDir: dir, FrontendDist: dir}
	srv := api.New(api.Deps{Cfg: cfg, DB: e.conn, Users: e.users, Settings: store.NewSettings(e.conn), Tokens: e.tokens, Auth: auth.NewAuthenticator(e.tokens, e.users), Movies: store.NewMovies(e.conn), Rooms: store.NewRooms(e.conn), Bilibili: svc})
	e.handler = srv.Handler()

	setPrefs := func(allow bool) {
		t.Helper()
		raw := fmt.Sprintf(`{"allowHostResolveForCli":%t}`, allow)
		if err := os.WriteFile(filepath.Join(dir, "cli-prefs.json"), []byte(raw), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	call := func(movieID int64, extra string) apiResponse {
		t.Helper()
		capture.mu.Lock()
		capture.cookies = nil
		capture.mu.Unlock()
		path := "/api/stream/resolve-bilibili?url=" + video + "&cliHost=1" + extra
		if movieID > 0 {
			path += "&movieId=" + fmt.Sprint(movieID)
		}
		return e.do(t, http.MethodGet, path, e.token(t, viewer, "user", "fixture"), nil)
	}
	errCode := func(r apiResponse) string {
		s, _ := r.body["code"].(string)
		return s
	}

	setPrefs(true)
	t.Run("requires movie", func(t *testing.T) {
		r := call(0, "")
		if r.status != 400 || errCode(r) != "CLI_HOST_RESOLVE_REQUIRES_MOVIE" {
			t.Fatalf("status=%d body=%+v", r.status, r.body)
		}
	})

	t.Run("admin disabled", func(t *testing.T) {
		setPrefs(false)
		defer setPrefs(true)
		r := call(shared, "")
		if r.status != 403 || errCode(r) != "CLI_HOST_RESOLVE_DISABLED" {
			t.Fatalf("status=%d body=%+v", r.status, r.body)
		}
		if len(capture.cookies) != 0 {
			t.Fatal("被拒绝的请求不应打到上游")
		}
	})

	t.Run("host has no account", func(t *testing.T) {
		r := call(bare, "")
		if r.status != 400 || errCode(r) != "HOST_NO_BILIBILI_ACCOUNT" {
			t.Fatalf("status=%d body=%+v", r.status, r.body)
		}
	})

	t.Run("host resolve borrows cookie", func(t *testing.T) {
		r := call(shared, "&skipCdnCheck=1&forceDash=1")
		if r.status != 200 {
			t.Fatalf("status=%d body=%+v", r.status, r.body)
		}
		capture.mu.Lock()
		defer capture.mu.Unlock()
		found := false
		for _, cookie := range capture.cookies {
			if strings.Contains(cookie, dummy) {
				found = true
			}
		}
		if !found {
			t.Fatal("房主直链解析没有使用房主 Cookie")
		}
	})
}
