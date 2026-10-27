package api_test

import (
	"io"
	"net/http"
	"strings"
	"testing"

	"zviewer/backend/internal/api"
	"zviewer/backend/internal/auth"
	"zviewer/backend/internal/bilibili"
	"zviewer/backend/internal/config"
	"zviewer/backend/internal/store"
)

type cidResolveTransport struct{ cid string }

func (c *cidResolveTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	body := `{"code":0,"data":{"wbi_img":{"img_url":"https://i0.hdslb.com/bfs/wbi/0123456789abcdef0123456789abcdef.png","sub_url":"https://i0.hdslb.com/bfs/wbi/fedcba9876543210fedcba9876543210.png"}}}`
	if strings.Contains(r.URL.Path, "playurl") {
		c.cid = r.URL.Query().Get("cid")
		body = `{"code":-404,"message":"controlled stop before CDN"}`
	}
	return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/json"}}, Request: r, Body: io.NopCloser(strings.NewReader(body))}, nil
}

func TestMusicResolveForwardsTheSelectedPartCID(t *testing.T) {
	e := newTestEnv(t)
	defer e.teardown()
	user := e.seedUser(t, "parts-user", "fixture-password", "user", "active")
	service := bilibili.NewService(e.conn)
	transport := &cidResolveTransport{}
	service.Client.SetTransport(transport)
	service.Caches.SetVideoInfo("BV1BDk2YCEHF", bilibili.VideoInfo{Cid: 101, Duration: 500, Pages: []bilibili.VideoPage{{Page: 1, Cid: 101, Duration: 212}, {Page: 2, Cid: 202, Duration: 250}}})
	dir := t.TempDir()
	cfg := &config.Config{ProjectRoot: dir, ConfigDir: dir, UploadsDir: dir, AvatarsDir: dir, MediaDir: dir, FrontendDist: dir}
	server := api.New(api.Deps{Cfg: cfg, DB: e.conn, Users: e.users, Settings: store.NewSettings(e.conn), Tokens: e.tokens, Auth: auth.NewAuthenticator(e.tokens, e.users), Bilibili: service})
	e.handler = server.Handler()
	token := e.token(t, user, "user", "parts-user")
	result := e.do(t, "GET", "/api/stream/resolve-bilibili?url=https://www.bilibili.com/video/BV1BDk2YCEHF&forceDash=true&cid=202", token, nil)
	if result.status != 200 || transport.cid != "202" {
		t.Fatalf("selected part lost: status=%d cid=%s", result.status, transport.cid)
	}
	for _, cid := range []string{"0", "-1", "invalid"} {
		denied := e.do(t, "GET", "/api/stream/resolve-bilibili?url=https://www.bilibili.com/video/BV1BDk2YCEHF&cid="+cid, token, nil)
		if denied.status != 400 {
			t.Fatalf("invalid cid=%s accepted: %d", cid, denied.status)
		}
	}
}
