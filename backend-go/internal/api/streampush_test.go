package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
	"zviewer/backend/internal/auth"
	"zviewer/backend/internal/store"
)

// insertPushRoom 插一个投屏房间：streamKey 允许为 nil（NULL）。
func (e *testEnv) insertPushRoom(t *testing.T, roomID, mode string, streamKey *string) {
	t.Helper()
	var key any
	if streamKey != nil {
		key = *streamKey
	}
	if _, err := e.conn.Exec(
		`INSERT INTO "room" ("roomId","name","status","mode","shareMethod","streamKey")
		 VALUES (?,?,?,?,?,?)`,
		roomID, "测试房间", "active", mode, "stream-push", key,
	); err != nil {
		t.Fatalf("插入房间失败: %v", err)
	}
}

func (e *testEnv) roomStreamKey(t *testing.T, roomID string) *string {
	t.Helper()
	var key *string
	if err := e.conn.QueryRow(
		`SELECT "streamKey" FROM "room" WHERE "roomId" = ?`, roomID,
	).Scan(&key); err != nil {
		t.Fatalf("读取 streamKey 失败: %v", err)
	}
	return key
}

// doObsConfig 发 obs-config 请求并可指定 Host 头。
func (e *testEnv) doObsConfig(t *testing.T, roomID, token, host string) (*http.Response, string) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/stream-push/obs-config/"+roomID, nil)
	if host != "" {
		req.Host = host
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	e.handler.ServeHTTP(rec, req)
	return rec.Result(), rec.Body.String()
}

func TestObsConfigRequiresAuth(t *testing.T) {
	env := newTestEnv(t)
	defer env.teardown()
	env.insertPushRoom(t, "PUSH0001", "screen-share", nil)

	resp, body := env.doObsConfig(t, "PUSH0001", "", "")
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("未登录应 401，得到 %d（%s）", resp.StatusCode, body)
	}
}

func TestObsConfigRejectsMissingRoom(t *testing.T) {
	env := newTestEnv(t)
	defer env.teardown()
	userID := env.seedUser(t, "alice", "pass1234", "user", "active")
	token := env.token(t, userID, "user", "alice")

	resp, body := env.doObsConfig(t, "NOSUCHRM", token, "")
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("房间不存在应 404，得到 %d（%s）", resp.StatusCode, body)
	}
	if !strings.Contains(body, "房间不存在") {
		t.Fatalf("404 文案不对: %s", body)
	}
}

func TestObsConfigRejectsNonScreenShareRoom(t *testing.T) {
	env := newTestEnv(t)
	defer env.teardown()
	userID := env.seedUser(t, "alice", "pass1234", "user", "active")
	token := env.token(t, userID, "user", "alice")
	env.insertPushRoom(t, "PUSH0002", "watch-together", nil)
	env.conn.Exec(`UPDATE room SET ownerUserId=? WHERE roomId=?`, userID, "PUSH0002")

	resp, body := env.doObsConfig(t, "PUSH0002", token, "")
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("非投屏模式应 400，得到 %d（%s）", resp.StatusCode, body)
	}
	if !strings.Contains(body, "该房间不是投屏模式") {
		t.Fatalf("400 文案不对: %s", body)
	}
}

func TestObsConfigGeneratesStreamKey(t *testing.T) {
	env := newTestEnv(t)
	defer env.teardown()
	userID := env.seedUser(t, "alice", "pass1234", "user", "active")
	token := env.token(t, userID, "user", "alice")
	env.insertPushRoom(t, "PUSH0003", "screen-share", nil)
	env.conn.Exec(`UPDATE room SET ownerUserId=? WHERE roomId=?`, userID, "PUSH0003")

	resp, body := env.doObsConfig(t, "PUSH0003", token, "media.example.com:3333")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("应 200，得到 %d（%s）", resp.StatusCode, body)
	}
	if got := resp.Header.Get("Content-Disposition"); got != `attachment; filename="zviewer-obs-config.json"` {
		t.Fatalf("Content-Disposition 不对: %q", got)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "application/json; charset=utf-8" {
		t.Fatalf("Content-Type 不对: %q", ct)
	}
	if strings.HasSuffix(body, "\n") {
		t.Fatal("响应体不应带尾换行（Node 的 res.json 不带）")
	}

	var cfg struct {
		CurrentScene string `json:"current_scene"`
		SceneOrder   []struct {
			Name string `json:"name"`
		} `json:"scene_order"`
		Sources []struct {
			Name     string `json:"name"`
			ID       string `json:"id"`
			Settings struct {
				Server  string `json:"server"`
				Key     string `json:"key"`
				UseAuth *bool  `json:"use_auth"`
			} `json:"settings"`
			VersionedID string `json:"versioned_id"`
		} `json:"sources"`
		Service struct {
			Type     string `json:"type"`
			Settings struct {
				Server string `json:"server"`
				Key    string `json:"key"`
			} `json:"settings"`
		} `json:"service"`
	}
	if err := json.Unmarshal([]byte(body), &cfg); err != nil {
		t.Fatalf("响应不是合法 JSON: %v（%s）", err, body)
	}

	if cfg.CurrentScene != "ZViewer 推流" {
		t.Errorf("current_scene = %q", cfg.CurrentScene)
	}
	if len(cfg.SceneOrder) != 1 || cfg.SceneOrder[0].Name != "ZViewer 推流" {
		t.Errorf("scene_order 不对: %+v", cfg.SceneOrder)
	}
	if len(cfg.Sources) != 2 {
		t.Fatalf("sources 应有 2 项，实际 %d", len(cfg.Sources))
	}
	if cfg.Sources[0].ID != "scene" || cfg.Sources[0].VersionedID != "scene" {
		t.Errorf("sources[0] 应为场景，实际 %+v", cfg.Sources[0])
	}
	if cfg.Sources[1].ID != "rtmp_output" || cfg.Sources[1].VersionedID != "rtmp_output" {
		t.Errorf("sources[1] 应为 rtmp_output，实际 %+v", cfg.Sources[1])
	}

	const wantServer = "rtmp://media.example.com:3334/live"
	if cfg.Sources[1].Settings.Server != wantServer {
		t.Errorf("推流地址 = %q, want %q", cfg.Sources[1].Settings.Server, wantServer)
	}
	if cfg.Sources[1].Settings.UseAuth == nil || *cfg.Sources[1].Settings.UseAuth {
		t.Error("use_auth 应为 false 且键存在")
	}
	if cfg.Service.Type != "rtmp_custom" {
		t.Errorf("service.type = %q", cfg.Service.Type)
	}
	if cfg.Service.Settings.Server != wantServer || cfg.Service.Settings.Key == "" {
		t.Errorf("service.settings 不对: %+v", cfg.Service.Settings)
	}

	key := cfg.Sources[1].Settings.Key
	if len(key) != 8 {
		t.Fatalf("推流码长度 = %d, want 8（%q）", len(key), key)
	}
	if cfg.Service.Settings.Key != key {
		t.Error("两个位置的推流码必须一致")
	}
	// 生成后必须落库：下次下载配置要拿到同一个码，OBS 里填的才不会失效。
	stored := env.roomStreamKey(t, "PUSH0003")
	if stored == nil || *stored != key {
		t.Fatalf("推流码未落库: stored=%v key=%q", stored, key)
	}
}

func TestObsConfigReusesExistingStreamKey(t *testing.T) {
	env := newTestEnv(t)
	defer env.teardown()
	userID := env.seedUser(t, "alice", "pass1234", "user", "active")
	token := env.token(t, userID, "user", "alice")
	existing := "AbCd2345"
	env.insertPushRoom(t, "PUSH0004", "screen-share", &existing)
	env.conn.Exec(`UPDATE room SET ownerUserId=? WHERE roomId=?`, userID, "PUSH0004")

	resp, body := env.doObsConfig(t, "PUSH0004", token, "media.example.com")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("应 200，得到 %d（%s）", resp.StatusCode, body)
	}
	if !strings.Contains(body, existing) {
		t.Fatalf("应复用已有推流码 %q，实际响应 %s", existing, body)
	}
	if stored := env.roomStreamKey(t, "PUSH0004"); stored == nil || *stored != existing {
		t.Fatalf("已有推流码被覆盖: %v", stored)
	}
}

func TestObsConfigMigratesLegacyKeyOnceUnderConcurrentDownloads(t *testing.T) {
	env := newTestEnv(t)
	defer env.teardown()
	userID := env.seedUser(t, "obs-owner", "pass1234", "user", "active")
	token := env.token(t, userID, "user", "obs-owner")
	legacy := strings.Repeat("AbCd2345", 4)
	env.insertPushRoom(t, "MIGRATE8", "screen-share", &legacy)
	env.conn.Exec(`UPDATE room SET ownerUserId=? WHERE roomId=?`, userID, "MIGRATE8")
	responses := make(chan *httptest.ResponseRecorder, 12)
	var wg sync.WaitGroup
	for range 12 {
		wg.Go(func() {
			req := httptest.NewRequest("GET", "/api/stream-push/obs-config/MIGRATE8", nil)
			req.Header.Set("Authorization", "Bearer "+token)
			rec := httptest.NewRecorder()
			env.handler.ServeHTTP(rec, req)
			responses <- rec
		})
	}
	wg.Wait()
	close(responses)
	stored := env.roomStreamKey(t, "MIGRATE8")
	if stored == nil || len(*stored) != 8 {
		t.Fatal("旧 32 位码未迁移为八位")
	}
	for rec := range responses {
		var cfg struct {
			Service struct {
				Settings struct {
					Key string `json:"key"`
				} `json:"settings"`
			} `json:"service"`
		}
		if rec.Code != 200 || json.Unmarshal(rec.Body.Bytes(), &cfg) != nil || cfg.Service.Settings.Key != *stored {
			t.Fatalf("并发配置未返回同一个已保存的八位码：%d %s", rec.Code, rec.Body.String())
		}
	}
	// 过期房主或已关闭房间的迟到迁移不能改写当前码。
	otherOwner := userID + 1
	if _, err := store.NewRooms(env.conn).EnsureStreamKey(context.Background(), "MIGRATE8", &otherOwner, "NEWKEY88"); err == nil {
		t.Fatal("房主不匹配时仍允许更新")
	}
	env.conn.Exec(`UPDATE room SET status='closed' WHERE roomId='MIGRATE8'`)
	if _, err := store.NewRooms(env.conn).EnsureStreamKey(context.Background(), "MIGRATE8", &userID, "NEWKEY88"); err == nil {
		t.Fatal("已关闭房间仍允许更新")
	}
}

// TestObsConfigHonorsServerHostEnv 覆盖 SERVER_HOST / RTMP_PORT 显式配置。
func TestObsConfigHonorsServerHostEnv(t *testing.T) {
	t.Setenv("SERVER_HOST", "push.example.com")
	t.Setenv("RTMP_PORT", "1935")
	t.Setenv("NMS_HTTP_FLV_URL", "http://127.0.0.1:1") // 探测必然失败，本用例不关心

	env := newTestEnv(t)
	defer env.teardown()
	userID := env.seedUser(t, "alice", "pass1234", "user", "active")
	token := env.token(t, userID, "user", "alice")
	env.insertPushRoom(t, "PUSH0005", "screen-share", nil)
	env.conn.Exec(`UPDATE room SET ownerUserId=? WHERE roomId=?`, userID, "PUSH0005")

	resp, body := env.doObsConfig(t, "PUSH0005", token, "192.168.1.10:3333")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("应 200，得到 %d（%s）", resp.StatusCode, body)
	}
	if !strings.Contains(body, "rtmp://push.example.com:1935/live") {
		t.Fatalf("SERVER_HOST/RTMP_PORT 未生效: %s", body)
	}
}

// upstreamCapture 记录假 NMS 收到的请求（顺序执行，无需加锁）。
type upstreamCapture struct {
	path string
	ua   string
}

// newPushUpstream 起一个假的 NMS：/live/ABCD1234.flv 回固定 FLV 字节，
// 其余路径回 404。
func newPushUpstream(t *testing.T, payload []byte) (*httptest.Server, *upstreamCapture) {
	t.Helper()
	capture := &upstreamCapture{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capture.path = r.URL.Path
		if r.URL.RawQuery != "" {
			capture.path += "?" + r.URL.RawQuery
		}
		capture.ua = r.Header.Get("User-Agent")
		if r.URL.Path != "/live/ABCD1234.flv" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "video/x-flv")
		w.Header().Set("Accept-Ranges", "bytes")
		_, _ = w.Write(payload)
	}))
	t.Cleanup(srv.Close)
	return srv, capture
}

func TestLiveProxyForwardsFLV(t *testing.T) {
	payload := []byte("FLV\x01\x05fake-stream-bytes")
	upstream, capture := newPushUpstream(t, payload)
	t.Setenv("NMS_HTTP_FLV_URL", upstream.URL)

	env := newTestEnv(t)
	defer env.teardown()

	req := httptest.NewRequest(http.MethodGet, env.watchURL(t), nil)
	req.Header.Set("User-Agent", "OBS-Test/1.0")
	rec := httptest.NewRecorder()
	env.handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("应 200，得到 %d（%s）", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Content-Type"); got != "video/x-flv" {
		t.Errorf("Content-Type = %q", got)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "*" {
		t.Errorf("ACAO = %q, want *", got)
	}
	if got := rec.Header().Get("X-Accel-Buffering"); got != "no" {
		t.Errorf("X-Accel-Buffering = %q, want no", got)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-transform" {
		t.Errorf("Cache-Control = %q", got)
	}
	if !bytes.Equal(rec.Body.Bytes(), payload) {
		t.Errorf("转发的字节不一致: %q", rec.Body.Bytes())
	}
	// 上游必须收到完整原始 URI（含查询串），Node 也是用 originalUrl 拼的
	if !strings.HasPrefix(capture.path, "/live/ABCD1234.flv?ticket=") {
		t.Errorf("上游路径 = %q", capture.path)
	}
	if capture.ua != "OBS-Test/1.0" {
		t.Errorf("客户端 UA 未透传: %q", capture.ua)
	}
}

func TestLiveProxyFallsBackWhenNMSUnavailable(t *testing.T) {
	// 占一个端口再释放：探测必然连不上 → 走 SPA 回退
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("监听失败: %v", err)
	}
	addr := ln.Addr().String()
	_ = ln.Close()
	t.Setenv("NMS_HTTP_FLV_URL", "http://"+addr)

	env := newTestEnv(t)
	defer env.teardown()

	req := httptest.NewRequest(http.MethodGet, env.watchURL(t), nil)
	rec := httptest.NewRecorder()
	env.handler.ServeHTTP(rec, req)

	// 没有前端产物时 SPA 回退返回 404 文本；关键是**不能**是代理的 502 JSON。
	if rec.Code == http.StatusBadGateway || strings.Contains(rec.Body.String(), "拉流代理失败") {
		t.Fatalf("NMS 不可用时不应报代理错误: %d %s", rec.Code, rec.Body.String())
	}
	if rec.Code != http.StatusNotFound {
		t.Fatalf("应落到 SPA 回退（无产物 → 404），得到 %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "前端构建产物不存在") {
		t.Fatalf("未走 SPA 回退: %s", rec.Body.String())
	}
}

// TestLiveProxyStreamsIdleConnection 模拟直播长连接：上游先发一段再挂住，
// 客户端（httptest）仍然能立刻读到已写出的首块，而不是等整条流结束。
func TestLiveProxyStreamsIdleConnection(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "video/x-flv")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("FIRST-CHUNK"))
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		// 保持连接不关闭：真实 FLV 推流就是这样
		<-r.Context().Done()
	}))
	defer upstream.Close()
	t.Setenv("NMS_HTTP_FLV_URL", upstream.URL)

	env := newTestEnv(t)
	defer env.teardown()

	srv := httptest.NewServer(env.handler)
	defer srv.Close()

	resp, err := http.Get(srv.URL + env.watchURL(t))
	if err != nil {
		t.Fatalf("请求失败: %v", err)
	}
	defer resp.Body.Close()

	buf := make([]byte, len("FIRST-CHUNK"))
	if _, err := io.ReadFull(resp.Body, buf); err != nil {
		t.Fatalf("读取首块失败: %v", err)
	}
	if string(buf) != "FIRST-CHUNK" {
		t.Fatalf("首块内容 = %q", buf)
	}
}

func (e *testEnv) watchURL(t *testing.T) string {
	t.Helper()
	id := e.seedUser(t, "watch-owner", "fixture-password", auth.RoleUser, "active")
	key := "ABCD1234"
	e.insertPushRoom(t, "WATCH001", "screen-share", &key)
	if _, err := e.conn.Exec(`UPDATE room SET ownerUserId=? WHERE roomId='WATCH001'`, id); err != nil {
		t.Fatal(err)
	}
	claims, err := e.tokens.VerifyAccess(e.token(t, id, auth.RoleUser, "watch-owner"))
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(map[string]any{"r": "WATCH001", "c": claims})
	return "/live/WATCH001.flv?ticket=" + url.QueryEscape(e.tokens.SignCapability("flv-watch", string(raw), time.Hour))
}
