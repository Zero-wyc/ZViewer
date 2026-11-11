package api_test

import (
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"testing"

	"zviewer/backend/internal/api"
	"zviewer/backend/internal/auth"
	"zviewer/backend/internal/bilibili"
	"zviewer/backend/internal/config"
	"zviewer/backend/internal/store"
)

// liveTransport 返回直播间信息与取流响应，记录请求头以校验 Referer / Cookie 注入。
type liveTransport struct {
	mu        sync.Mutex
	referers  []string
	cookies   []string
	playCalls int
}

func (tr *liveTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	tr.mu.Lock()
	tr.referers = append(tr.referers, r.Header.Get("Referer"))
	tr.cookies = append(tr.cookies, r.Header.Get("Cookie"))
	path := r.URL.Path
	if strings.Contains(path, "getRoomPlayInfo") {
		tr.playCalls++
	}
	tr.mu.Unlock()

	body := "{}"
	switch {
	case strings.Contains(path, "/room/v1/Room/get_info"):
		body = `{"code":0,"data":{"room_id":32153039,"uid":229158998,"title":"测试直播间",
"live_status":1,"live_time":"2026-11-11 22:13:39","user_cover":"https://i0.hdslb.com/cover.jpg",
"online":21262,"area_name":"聊天电台","parent_area_name":"电台"}}`
	case strings.Contains(path, "/live_user/v1/Master/info"):
		body = `{"code":0,"data":{"info":{"uid":229158998,"uname":"测试主播"}}}`
	case strings.Contains(path, "getRoomPlayInfo"):
		body = `{"code":0,"data":{"playurl_info":{"playurl":{"current_qn":10000,
"g_qn_desc":[{"qn":10000,"desc":"原画"},{"qn":250,"desc":"超清"}],
"stream":[{"protocol_name":"http_stream","format":[{"format_name":"flv","codec":[
{"codec_name":"avc","current_qn":10000,"accept_qn":[10000,250],
"base_url":"/live-bvc/avc.flv","url_info":[{"host":"https://live-cdn.example.com","extra":"?expires=1794415262"}]}]}]}]}}}}`
	}
	return &http.Response{
		StatusCode: 200,
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Request:    r,
		Body:       io.NopCloser(strings.NewReader(body)),
	}, nil
}

// TestBilibiliLiveResolve 覆盖直播取流端点：参数校验、房主 Cookie 借用、影片归属校验。
func TestBilibiliLiveResolve(t *testing.T) {
	e := newTestEnv(t)
	defer e.teardown()
	owner := e.seedUser(t, "live-owner", "fixture-pass", "user", "active")
	outsider := e.seedUser(t, "live-outsider", "fixture-pass", "user", "active")
	e.seedRoom(t, "LIVE0001", "active", &owner)
	e.seedRoom(t, "LIVE0002", "active", &outsider)
	movie := e.seedMovie(t, "LIVE0001", "bilibili", "")
	other := e.seedMovie(t, "LIVE0002", "bilibili", "")
	mustExec := func(query string, args ...any) {
		t.Helper()
		if _, err := e.conn.Exec(query, args...); err != nil {
			t.Fatal(err)
		}
	}
	mustExec(`UPDATE "movie" SET "url"='https://live.bilibili.com/32153039' WHERE "id"=?`, movie)
	mustExec(`UPDATE "movie" SET "url"='https://live.bilibili.com/99999' WHERE "id"=?`, other)
	mustExec(`CREATE TABLE "bilibili_credential" ("userId" INTEGER PRIMARY KEY, "cookie" TEXT, "refreshToken" TEXT)`)
	dummy := "SESSDATA=live-fixture-cookie"
	mustExec(`INSERT INTO "bilibili_credential" ("userId","cookie") VALUES (?,?)`, owner, dummy)

	svc := bilibili.NewService(e.conn)
	tr := &liveTransport{}
	svc.Client.SetTransport(tr)
	dir := t.TempDir()
	cfg := &config.Config{ProjectRoot: dir, ConfigDir: dir, UploadsDir: dir, AvatarsDir: dir, MediaDir: dir, FrontendDist: dir}
	srv := api.New(api.Deps{Cfg: cfg, DB: e.conn, Users: e.users, Settings: store.NewSettings(e.conn), Tokens: e.tokens, Auth: auth.NewAuthenticator(e.tokens, e.users), Movies: store.NewMovies(e.conn), Rooms: store.NewRooms(e.conn), Bilibili: svc})
	e.handler = srv.Handler()

	// 1) 房主直接解析：返回开播信息与 FLV 地址，上游必须带 live Referer。
	resp := e.do(t, http.MethodGet, "/api/stream/resolve-bilibili-live?url=https%3A%2F%2Flive.bilibili.com%2F32153039", e.token(t, owner, "user", "fixture"), nil)
	if resp.status != 200 {
		t.Fatalf("status=%d body=%+v", resp.status, resp.body)
	}
	if resp.body["format"] != "flv" || resp.body["videoUrl"] != "https://live-cdn.example.com/live-bvc/avc.flv?expires=1794415262" {
		t.Fatalf("unexpected payload: %+v", resp.body)
	}
	if resp.body["title"] != "测试直播间" || resp.body["uname"] != "测试主播" {
		t.Fatalf("room meta missing: %+v", resp.body)
	}
	if resp.body["resolvedUrl"] != "https://live.bilibili.com/32153039" {
		t.Fatalf("resolvedUrl=%v", resp.body["resolvedUrl"])
	}
	tr.mu.Lock()
	for _, referer := range tr.referers {
		if referer != "https://live.bilibili.com" {
			t.Fatalf("live upstream must carry live referer, got %q", referer)
		}
	}
	tr.mu.Unlock()

	// 2) 观众带 movieId：改用房主 Cookie，且影片必须属于所请求的直播间。
	tr.mu.Lock()
	tr.cookies = nil
	tr.mu.Unlock()
	shared := "?url=https%3A%2F%2Flive.bilibili.com%2F32153039&movieId=" + strconv.FormatInt(movie, 10)
	if resp := e.do(t, http.MethodGet, "/api/stream/resolve-bilibili-live"+shared, e.token(t, owner, "user", "fixture"), nil); resp.status != 200 {
		t.Fatalf("shared status=%d body=%+v", resp.status, resp.body)
	}
	tr.mu.Lock()
	found := false
	for _, cookie := range tr.cookies {
		if strings.Contains(cookie, dummy) {
			found = true
		}
	}
	tr.mu.Unlock()
	if !found {
		t.Fatal("room owner bilibili cookie was not used for live resolve")
	}

	// 3) 影片与房间号不匹配：必须 400 且不打上游。
	tr.mu.Lock()
	tr.referers = nil
	tr.playCalls = 0
	tr.mu.Unlock()
	mismatch := "?url=https%3A%2F%2Flive.bilibili.com%2F32153039&movieId=" + strconv.FormatInt(other, 10)
	if resp := e.do(t, http.MethodGet, "/api/stream/resolve-bilibili-live"+mismatch, e.token(t, outsider, "user", "fixture"), nil); resp.status != 400 {
		t.Fatalf("mismatch status=%d body=%+v", resp.status, resp.body)
	}

	// 4) 非直播间链接：400。
	if resp := e.do(t, http.MethodGet, "/api/stream/resolve-bilibili-live?url=https%3A%2F%2Fwww.bilibili.com%2Fvideo%2FBV1xx411c7mD", e.token(t, owner, "user", "fixture"), nil); resp.status != 400 {
		t.Fatalf("non-live status=%d body=%+v", resp.status, resp.body)
	}
}
