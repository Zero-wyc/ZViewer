package api_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"zviewer/backend/internal/openlist"
)

// fakeAList 是最小的 AList 服务器：登录 / 列目录 / 取文件 / 搜索 / me。
//
// 为什么不用真 AList：这些端点的语义全在「我们怎么拼请求、怎么翻译错误」，
// 上游行为用固定响应就能锁定；真机反而不可复现。
type fakeAList struct {
	srv      *httptest.Server
	requests []string
}

func newFakeAList(t *testing.T) *fakeAList {
	t.Helper()
	f := &fakeAList{}
	mux := http.NewServeMux()

	mux.HandleFunc("POST /api/auth/login", func(w http.ResponseWriter, r *http.Request) {
		writeAList(w, map[string]any{"token": "fake-token"})
	})
	mux.HandleFunc("POST /api/auth/login/hash", func(w http.ResponseWriter, r *http.Request) {
		writeAList(w, map[string]any{"token": "fake-token-hash"})
	})
	mux.HandleFunc("POST /api/fs/list", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Path string `json:"path"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.requests = append(f.requests, "list:"+body.Path)
		if body.Path == "/missing" {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"code": 500, "message": "object not found",
			})
			return
		}
		writeAList(w, map[string]any{
			"content": []map[string]any{
				{"name": "Movies", "size": 0, "is_dir": true, "type": 1,
					"modified": "2026-01-02T03:04:05Z"},
				{"name": "Sample.mp4", "size": 2048, "is_dir": false, "type": 0,
					"modified": "2026-02-03T04:05:06Z"},
			},
			"total":    2,
			"provider": "Local",
		})
	})
	mux.HandleFunc("POST /api/fs/get", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Path string `json:"path"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.requests = append(f.requests, "get:"+body.Path)
		writeAList(w, map[string]any{
			"name":     "Sample.mp4",
			"size":     2048,
			"is_dir":   false,
			"provider": "Local",
			"raw_url":  f.srv.URL + "/d/Sample.mp4?sign=abc",
			"related": []map[string]any{
				{"name": "Sample.srt", "type": 4},
			},
		})
	})
	mux.HandleFunc("POST /api/fs/search", func(w http.ResponseWriter, r *http.Request) {
		writeAList(w, map[string]any{
			"content": []map[string]any{
				{"parent": "/", "name": "Sample.mp4", "is_dir": false, "size": 2048, "type": 0},
			},
			"total": 1,
		})
	})
	mux.HandleFunc("GET /api/me", func(w http.ResponseWriter, r *http.Request) {
		writeAList(w, map[string]any{
			"id": 1, "username": "alice", "permission": 1,
			"base_path": "/", "role": 0, "disabled": false, "otp": false,
		})
	})
	// 直链本体：Range 透传
	mux.HandleFunc("GET /d/Sample.mp4", func(w http.ResponseWriter, r *http.Request) {
		body := []byte("0123456789")
		if r.Header.Get("Range") == "bytes=2-5" {
			w.Header().Set("Content-Range", "bytes 2-5/10")
			w.Header().Set("Content-Length", "4")
			w.WriteHeader(http.StatusPartialContent)
			_, _ = w.Write(body[2:6])
			return
		}
		w.Header().Set("Content-Type", "video/mp4")
		_, _ = w.Write(body)
	})

	f.srv = httptest.NewServer(mux)
	t.Cleanup(f.srv.Close)
	return f
}

func writeAList(w http.ResponseWriter, data any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"code": 200, "data": data})
}

// seedOpenListMount 直接插库：绕过创建端点，专注被测端点本身。
func (e *testEnv) seedOpenListMount(
	t *testing.T, userID int64, serverURL, path string, username, password *string, directLink bool,
) int64 {
	t.Helper()
	res, err := e.conn.Exec(
		`INSERT INTO "user_mount" ("userId","type","name","serverUrl","path","username","password","directLink")
		 VALUES (?,?,?,?,?,?,?,?)`,
		userID, "openlist", "测试挂载", serverURL, path, username, password, directLink,
	)
	if err != nil {
		t.Fatalf("插入 OpenList 挂载失败: %v", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		t.Fatalf("取挂载 ID 失败: %v", err)
	}
	return id
}

func strPtr(v string) *string { return &v }

// ===========================================================================
// 挂载 CRUD
// ===========================================================================

func TestOpenListCreateMountHashesPassword(t *testing.T) {
	env := newTestEnv(t)
	defer env.teardown()
	alist := newFakeAList(t)

	uid := env.seedUser(t, "ol-creator", "pw123456", "user", "active")
	token := env.token(t, uid, "user", "ol-creator")

	resp := env.do(t, http.MethodPost, "/api/openlist/mounts", token, map[string]any{
		"name":      "我的网盘",
		"serverUrl": alist.srv.URL,
		"path":      "/Movies",
		"username":  "alice",
		"password":  "plain-pw",
	})
	if resp.status != http.StatusCreated {
		t.Fatalf("应 201，得到 %d（%s）", resp.status, resp.raw)
	}
	mount, ok := resp.body["mount"].(map[string]any)
	if !ok {
		t.Fatalf("响应缺少 mount: %s", resp.raw)
	}
	if _, has := mount["password"]; has {
		t.Errorf("mount 不应下发 password 字段: %s", resp.raw)
	}
	// 地址要补 /dav：与 Node 的 normalizeOpenListServerUrl 一致，
	// 否则「用户填 192.168.1.5:5244」和「挂载表里的 /dav 地址」永远匹配不上。
	if got, _ := mount["serverUrl"].(string); got != alist.srv.URL+"/dav" {
		t.Errorf("serverUrl = %q，期望补 /dav", got)
	}

	// 落库的必须是 sha256(明文+salt)，明文不落盘
	var stored *string
	if err := env.conn.QueryRow(
		`SELECT "password" FROM "user_mount" WHERE "id" = ?`, int64(mount["id"].(float64)),
	).Scan(&stored); err != nil {
		t.Fatalf("读回密码失败: %v", err)
	}
	if stored == nil {
		t.Fatal("密码未落库")
	}
	if *stored == "plain-pw" {
		t.Fatal("明文密码被直接落库")
	}
	if *stored != openlist.HashPassword("plain-pw") {
		t.Errorf("落库密码 = %q，期望 %q", *stored, openlist.HashPassword("plain-pw"))
	}
	if !openlist.IsHashedPassword(*stored) {
		t.Errorf("落库密码不是 64 位 hex: %q", *stored)
	}
}

func TestOpenListMountValidationAndOwnership(t *testing.T) {
	env := newTestEnv(t)
	defer env.teardown()
	alist := newFakeAList(t)

	owner := env.seedUser(t, "ol-owner", "pw123456", "user", "active")
	other := env.seedUser(t, "ol-other", "pw123456", "user", "active")
	ownerToken := env.token(t, owner, "user", "ol-owner")
	otherToken := env.token(t, other, "user", "ol-other")

	// 缺名字
	resp := env.do(t, http.MethodPost, "/api/openlist/mounts", ownerToken, map[string]any{
		"serverUrl": alist.srv.URL,
	})
	if resp.status != http.StatusBadRequest || resp.message() != "挂载名称不能为空" {
		t.Errorf("缺名字应 400/挂载名称不能为空，得到 %d/%q", resp.status, resp.message())
	}
	// 缺地址
	resp = env.do(t, http.MethodPost, "/api/openlist/mounts", ownerToken, map[string]any{
		"name": "x",
	})
	if resp.status != http.StatusBadRequest || resp.body["code"] != "INVALID_URL" {
		t.Errorf("缺地址应 400/INVALID_URL，得到 %d/%v", resp.status, resp.body["code"])
	}

	id := env.seedOpenListMount(t, owner, alist.srv.URL+"/dav", "/", strPtr("alice"), strPtr(openlist.HashPassword("pw")), false)

	// 别人的挂载一律 404（不能回 403：那等于确认了这条记录存在）
	for _, path := range []string{
		"/api/openlist/mounts/" + itoa64(id) + "/browse",
		"/api/openlist/resolve?mountId=" + itoa64(id) + "&path=/a.mp4",
		"/api/openlist/direct-url?mountId=" + itoa64(id) + "&path=/a.mp4",
		"/api/openlist/me?mountId=" + itoa64(id),
		"/api/openlist/search?mountId=" + itoa64(id) + "&keywords=a",
	} {
		got := env.do(t, http.MethodGet, path, otherToken, nil)
		if got.status != http.StatusNotFound {
			t.Errorf("%s 应 404，得到 %d（%s）", path, got.status, got.raw)
		}
	}
}

func TestOpenListMountTestAndDelete(t *testing.T) {
	env := newTestEnv(t)
	defer env.teardown()
	alist := newFakeAList(t)

	uid := env.seedUser(t, "ol-crud", "pw123456", "user", "active")
	token := env.token(t, uid, "user", "ol-crud")

	resp := env.do(t, http.MethodPost, "/api/openlist/mounts/test", token, map[string]any{
		"serverUrl": alist.srv.URL,
		"username":  "alice",
		"password":  "pw",
		"path":      "/",
	})
	if resp.status != http.StatusOK || resp.body["success"] != true {
		t.Fatalf("测试连接应 200/success，得到 %d（%s）", resp.status, resp.raw)
	}
	// Node 只回 { success: true }，多下发字段会让前端 DTO 校验失败
	if _, has := resp.body["itemCount"]; has {
		t.Errorf("不应下发 itemCount: %s", resp.raw)
	}

	id := env.seedOpenListMount(t, uid, alist.srv.URL+"/dav", "/", strPtr("alice"), nil, false)
	list := env.do(t, http.MethodGet, "/api/openlist/mounts", token, nil)
	mounts, _ := list.body["mounts"].([]any)
	if len(mounts) != 1 {
		t.Fatalf("应 1 条挂载，得到 %d（%s）", len(mounts), list.raw)
	}

	del := env.do(t, http.MethodDelete, "/api/openlist/mounts/"+itoa64(id), token, nil)
	if del.status != http.StatusOK {
		t.Fatalf("删除应 200，得到 %d（%s）", del.status, del.raw)
	}
	list = env.do(t, http.MethodGet, "/api/openlist/mounts", token, nil)
	if mounts, _ := list.body["mounts"].([]any); len(mounts) != 0 {
		t.Errorf("删除后应为空，得到 %s", list.raw)
	}
	// 再删一次必须 404（Node 的 findOneBy + remove 语义）
	del = env.do(t, http.MethodDelete, "/api/openlist/mounts/"+itoa64(id), token, nil)
	if del.status != http.StatusNotFound {
		t.Errorf("重复删除应 404，得到 %d", del.status)
	}
}

// ===========================================================================
// 浏览 / 解析 / 直链 / me / 搜索
// ===========================================================================

func TestOpenListBrowseAndResolve(t *testing.T) {
	env := newTestEnv(t)
	defer env.teardown()
	alist := newFakeAList(t)

	uid := env.seedUser(t, "ol-browse", "pw123456", "user", "active")
	token := env.token(t, uid, "user", "ol-browse")
	id := env.seedOpenListMount(t, uid, alist.srv.URL+"/dav", "/Movies",
		strPtr("alice"), strPtr(openlist.HashPassword("pw")), false)

	browse := env.do(t, http.MethodGet,
		"/api/openlist/mounts/"+itoa64(id)+"/browse?path=/Movies", token, nil)
	if browse.status != http.StatusOK {
		t.Fatalf("浏览应 200，得到 %d（%s）", browse.status, browse.raw)
	}
	entries, _ := browse.body["entries"].([]any)
	if len(entries) != 2 {
		t.Fatalf("应 2 条目录项，得到 %s", browse.raw)
	}
	first, _ := entries[0].(map[string]any)
	if first["name"] != "Movies" || first["type"] != "directory" {
		t.Errorf("目录项 = %v", first)
	}
	// path 必须是完整路径，前端点进去要用它
	if first["path"] != "/Movies/Movies" {
		t.Errorf("path = %v", first["path"])
	}
	if first["lastModified"] != "2026-01-02T03:04:05Z" {
		t.Errorf("lastModified 应原样透传，得到 %v", first["lastModified"])
	}
	if browse.body["provider"] != "Local" {
		t.Errorf("provider = %v", browse.body["provider"])
	}

	resolve := env.do(t, http.MethodGet,
		"/api/openlist/resolve?mountId="+itoa64(id)+"&path=/Movies/Sample.mp4", token, nil)
	if resolve.status != http.StatusOK {
		t.Fatalf("解析应 200，得到 %d（%s）", resolve.status, resolve.raw)
	}
	videoURL, _ := resolve.body["videoUrl"].(string)
	if !strings.HasPrefix(videoURL, "/api/openlist/proxy?mountId=") {
		t.Errorf("videoUrl = %q", videoURL)
	}
	if !strings.Contains(videoURL, "path=%2FMovies%2FSample.mp4") {
		t.Errorf("path 未按 encodeURIComponent 编码: %q", videoURL)
	}
	if resolve.body["format"] != "mp4" {
		t.Errorf("format = %v", resolve.body["format"])
	}
	if size, _ := resolve.body["size"].(float64); size != 2048 {
		t.Errorf("size = %v", resolve.body["size"])
	}
}

func TestOpenListDirectURLRejectsInternalAddress(t *testing.T) {
	env := newTestEnv(t)
	defer env.teardown()

	uid := env.seedUser(t, "ol-direct", "pw123456", "user", "active")
	token := env.token(t, uid, "user", "ol-direct")
	id := env.seedOpenListMount(t, uid, "http://192.168.1.9:5244/dav", "/",
		strPtr("alice"), nil, true)

	// 内网地址即使挂载上写着 directLink=true 也不能给直链：
	// 浏览器根本连不到 192.168.x.x，给了只会让播放器卡在加载中。
	resp := env.do(t, http.MethodGet,
		"/api/openlist/direct-url?mountId="+itoa64(id)+"&path=/a.mp4", token, nil)
	if resp.status != http.StatusBadRequest {
		t.Fatalf("应 400，得到 %d（%s）", resp.status, resp.raw)
	}
	if resp.body["code"] != "INTERNAL_NETWORK_FORBIDDEN" {
		t.Errorf("code = %v", resp.body["code"])
	}
	if resp.message() != "该挂载为内网地址，无法使用直链模式，请使用服务器转发" {
		t.Errorf("message = %q", resp.message())
	}
}

func TestOpenListMeAndSearch(t *testing.T) {
	env := newTestEnv(t)
	defer env.teardown()
	alist := newFakeAList(t)

	uid := env.seedUser(t, "ol-me", "pw123456", "user", "active")
	token := env.token(t, uid, "user", "ol-me")
	id := env.seedOpenListMount(t, uid, alist.srv.URL+"/dav", "/",
		strPtr("alice"), strPtr(openlist.HashPassword("pw")), false)

	me := env.do(t, http.MethodGet, "/api/openlist/me?mountId="+itoa64(id), token, nil)
	if me.status != http.StatusOK {
		t.Fatalf("me 应 200，得到 %d（%s）", me.status, me.raw)
	}
	info, _ := me.body["info"].(map[string]any)
	if info["username"] != "alice" {
		t.Errorf("info = %v", me.body["info"])
	}
	// AList 的 snake_case 必须原样透传（前端按 base_path 显示根目录）
	if _, has := info["base_path"]; !has {
		t.Errorf("info 丢了 base_path: %v", info)
	}

	search := env.do(t, http.MethodGet,
		"/api/openlist/search?mountId="+itoa64(id)+"&keywords=Sample&parent=/", token, nil)
	if search.status != http.StatusOK {
		t.Fatalf("搜索应 200，得到 %d（%s）", search.status, search.raw)
	}
	entries, _ := search.body["entries"].([]any)
	if len(entries) != 1 {
		t.Fatalf("应 1 条命中，得到 %s", search.raw)
	}
	hit, _ := entries[0].(map[string]any)
	// camelCase：Node 把 AList 的 is_dir 重组成 isDir
	if hit["name"] != "Sample.mp4" || hit["isDir"] != false {
		t.Errorf("命中项 = %v", hit)
	}
	// 搜索没命中时不能是 404（Node 用 notFound:false）
	missing := env.do(t, http.MethodGet,
		"/api/openlist/search?mountId="+itoa64(id)+"&keywords=", token, nil)
	if missing.status != http.StatusBadRequest {
		t.Errorf("空关键词应 400，得到 %d（%s）", missing.status, missing.raw)
	}
}

// ===========================================================================
// 流代理
// ===========================================================================

func TestOpenListProxyStreamsRawURL(t *testing.T) {
	env := newTestEnv(t)
	defer env.teardown()
	alist := newFakeAList(t)

	uid := env.seedUser(t, "ol-proxy", "pw123456", "user", "active")
	token := env.token(t, uid, "user", "ol-proxy")
	id := env.seedOpenListMount(t, uid, alist.srv.URL+"/dav", "/",
		strPtr("alice"), strPtr(openlist.HashPassword("pw")), false)

	req := httptest.NewRequest(http.MethodGet,
		"/api/openlist/proxy?mountId="+itoa64(id)+"&path=/Sample.mp4", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	env.handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("代理应 200，得到 %d（%s）", rec.Code, rec.Body.String())
	}
	if got := rec.Body.String(); got != "0123456789" {
		t.Errorf("透传字节 = %q", got)
	}
	// video.src 跨源必须拿到通配 CORS，否则被 ORB 拦
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "*" {
		t.Errorf("ACAO = %q", got)
	}

	// Range 必须原样透传：seek 依赖它
	req = httptest.NewRequest(http.MethodGet,
		"/api/openlist/proxy?mountId="+itoa64(id)+"&path=/Sample.mp4", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Range", "bytes=2-5")
	rec = httptest.NewRecorder()
	env.handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusPartialContent {
		t.Fatalf("Range 应 206，得到 %d（%s）", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Content-Range"); got != "bytes 2-5/10" {
		t.Errorf("Content-Range = %q", got)
	}
	if got := rec.Body.String(); got != "2345" {
		t.Errorf("分片字节 = %q", got)
	}
}

func itoa64(v int64) string {
	if v == 0 {
		return "0"
	}
	neg := v < 0
	if neg {
		v = -v
	}
	var buf [24]byte
	i := len(buf)
	for v > 0 {
		i--
		buf[i] = byte('0' + v%10)
		v /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
