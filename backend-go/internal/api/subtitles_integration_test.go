package api_test

import (
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

// seedMovie 直接插库：字幕端点只关心 movie 行的 source / path / serverUrl。
func (e *testEnv) seedMovie(t *testing.T, roomID, source, path string) int64 {
	t.Helper()
	res, err := e.conn.Exec(
		`INSERT INTO "movie" ("roomId","url","title","source","path") VALUES (?,?,?,?,?)`,
		roomID, "http://example.invalid/v.mp4", "测试影片", source, path,
	)
	if err != nil {
		t.Fatalf("插入影片失败: %v", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		t.Fatalf("取影片 id 失败: %v", err)
	}
	return id
}

// writeUpload 在 uploads 根下写文件（相对路径用正斜杠）。
func (e *testEnv) writeUpload(t *testing.T, rel, content string) {
	t.Helper()
	full := filepath.Join(e.uploads, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatalf("建目录失败: %v", err)
	}
	if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
		t.Fatalf("写文件失败: %v", err)
	}
}

// TestSubtitlesMovieGuard 覆盖中间件层的 401/400/404/403 四道门。
//
// Node 侧 `router.use(authenticateToken, requireMovieReadAccess)` 是路由级
// 中间件，先于 handler 执行，所以「缺 movieId」永远是中间件的
// 「movieId 参数无效」，而不是各 handler 自己的「缺少 movieId 参数」。
// 这条容易被顺手「优化」掉，必须钉住。
func TestSubtitlesMovieGuard(t *testing.T) {
	env := newTestEnv(t)
	defer env.teardown()

	ownerID := env.seedUser(t, "owner", "pass1234", "root", "active")
	otherID := env.seedUser(t, "other", "pass1234", "user", "active")
	ownerToken := env.token(t, ownerID, "root", "owner")
	otherToken := env.token(t, otherID, "user", "other")

	env.seedRoom(t, "SUBROOM", "active", &ownerID)
	env.seedMovie(t, "SUBROOM", "server-files", "uploads:/anime/EP01.mkv")

	paths := []string{
		"/api/subtitles/search",
		"/api/subtitles/browse",
		"/api/subtitles/load?path=uploads:/a.srt",
		"/api/subtitles/embedded-tracks",
		"/api/subtitles/embedded-extract?index=0",
	}

	for _, p := range paths {
		if resp := env.do(t, http.MethodGet, p, "", nil); resp.status != http.StatusUnauthorized {
			t.Fatalf("%s 未登录应 401，得到 %d", p, resp.status)
		}
		sep := "?"
		if containsQuestion(p) {
			sep = "&"
		}
		resp := env.do(t, http.MethodGet, p+sep+"movieId=abc", ownerToken, nil)
		if resp.status != http.StatusBadRequest || resp.message() != "movieId 参数无效" {
			t.Fatalf("%s movieId 非法应 400/movieId 参数无效，得到 %d/%q", p, resp.status, resp.message())
		}
		resp = env.do(t, http.MethodGet, p+sep+"movieId=99999", ownerToken, nil)
		if resp.status != http.StatusNotFound || resp.message() != "影片不存在" {
			t.Fatalf("%s 影片不存在应 404，得到 %d/%q", p, resp.status, resp.message())
		}
		resp = env.do(t, http.MethodGet, p+sep+"movieId=1", otherToken, nil)
		if resp.status != http.StatusForbidden || resp.message() != "请先通过房间准入验证" {
			t.Fatalf("%s 无准入应 403，得到 %d/%q", p, resp.status, resp.message())
		}
	}
}

func containsQuestion(s string) bool {
	for _, c := range s {
		if c == '?' {
			return true
		}
	}
	return false
}

// TestSubtitlesServerFiles 覆盖 server-files 源的 search/browse/load。
func TestSubtitlesServerFiles(t *testing.T) {
	env := newTestEnv(t)
	defer env.teardown()

	ownerID := env.seedUser(t, "owner", "pass1234", "root", "active")
	ownerToken := env.token(t, ownerID, "root", "owner")
	env.seedRoom(t, "SUBROOM", "active", &ownerID)

	env.writeUpload(t, "anime/EP01.mkv", "video")
	env.writeUpload(t, "anime/EP01.chs.srt", "1\n00:00:01,000 --> 00:00:02,000\n你好\n")
	env.writeUpload(t, "anime/EP02.srt", "other")
	env.writeUpload(t, "anime/.hidden", "h")
	movieID := env.seedMovie(t, "SUBROOM", "server-files", "uploads:/anime/EP01.mkv")

	// search：只命中 EP01 的字幕。
	resp := env.do(t, http.MethodGet,
		"/api/subtitles/search?movieId="+itoa(movieID), ownerToken, nil)
	if resp.status != http.StatusOK {
		t.Fatalf("search 应 200，得到 %d/%s", resp.status, resp.raw)
	}
	subs, _ := resp.body["subtitles"].([]any)
	if len(subs) != 1 {
		t.Fatalf("search 应命中 1 条，得到 %d: %s", len(subs), resp.raw)
	}
	first, _ := subs[0].(map[string]any)
	if first["filename"] != "EP01.chs.srt" || first["format"] != "srt" {
		t.Fatalf("search 结果不正确: %s", resp.raw)
	}

	// browse：默认浏览影片所在目录；隐藏文件被过滤。
	resp = env.do(t, http.MethodGet,
		"/api/subtitles/browse?movieId="+itoa(movieID), ownerToken, nil)
	if resp.status != http.StatusOK {
		t.Fatalf("browse 应 200，得到 %d/%s", resp.status, resp.raw)
	}
	if resp.body["currentPath"] != "uploads:/anime" {
		t.Fatalf("currentPath 应为 uploads:/anime，得到 %v", resp.body["currentPath"])
	}
	if resp.body["parentPath"] != "uploads:" {
		t.Fatalf("parentPath 应为 uploads:，得到 %v", resp.body["parentPath"])
	}
	entries, _ := resp.body["entries"].([]any)
	names := map[string]map[string]any{}
	for _, raw := range entries {
		e, _ := raw.(map[string]any)
		name, _ := e["name"].(string)
		names[name] = e
	}
	if _, ok := names[".hidden"]; ok {
		t.Fatalf("隐藏文件不该出现在列表里: %s", resp.raw)
	}
	if len(names) != 3 {
		t.Fatalf("应有 3 个可见文件，得到 %d: %s", len(names), resp.raw)
	}
	// 非字幕文件没有 size 以外的问题：isSubtitle 必须是 false。
	if e := names["EP01.mkv"]; e == nil || e["isSubtitle"] != false {
		t.Fatalf("EP01.mkv 的 isSubtitle 应为 false: %s", resp.raw)
	}
	if e := names["EP01.chs.srt"]; e == nil || e["isSubtitle"] != true {
		t.Fatalf("EP01.chs.srt 的 isSubtitle 应为 true: %s", resp.raw)
	}

	// browse 指定子目录（不存在的目录 → 空列表 + parentPath null）。
	resp = env.do(t, http.MethodGet,
		"/api/subtitles/browse?movieId="+itoa(movieID)+"&path=uploads:/nope", ownerToken, nil)
	if resp.status != http.StatusOK {
		t.Fatalf("browse 不存在目录应 200，得到 %d/%s", resp.status, resp.raw)
	}
	if resp.body["parentPath"] != nil {
		t.Fatalf("不存在目录的 parentPath 应为 null，得到 %v", resp.body["parentPath"])
	}
	if list, _ := resp.body["entries"].([]any); len(list) != 0 {
		t.Fatalf("不存在目录应返回空列表，得到 %s", resp.raw)
	}

	// load：读内容。
	resp = env.do(t, http.MethodGet,
		"/api/subtitles/load?movieId="+itoa(movieID)+"&path=uploads:/anime/EP01.chs.srt",
		ownerToken, nil)
	if resp.status != http.StatusOK {
		t.Fatalf("load 应 200，得到 %d/%s", resp.status, resp.raw)
	}
	if resp.body["filename"] != "EP01.chs.srt" || resp.body["format"] != "srt" {
		t.Fatalf("load 元信息不正确: %s", resp.raw)
	}
	if content, _ := resp.body["content"].(string); content == "" {
		t.Fatalf("load 内容为空: %s", resp.raw)
	}

	// load 缺 path → 400「缺少 path 参数」。
	resp = env.do(t, http.MethodGet,
		"/api/subtitles/load?movieId="+itoa(movieID), ownerToken, nil)
	if resp.status != http.StatusBadRequest || resp.message() != "缺少 path 参数" {
		t.Fatalf("load 缺 path 应 400/缺少 path 参数，得到 %d/%q", resp.status, resp.message())
	}

	// load 文件不存在 → 404「字幕文件不存在」。
	resp = env.do(t, http.MethodGet,
		"/api/subtitles/load?movieId="+itoa(movieID)+"&path=uploads:/anime/nope.srt",
		ownerToken, nil)
	if resp.status != http.StatusNotFound || resp.message() != "字幕文件不存在" {
		t.Fatalf("load 文件不存在应 404，得到 %d/%q", resp.status, resp.message())
	}
}

// TestSubtitlesSourceGates 覆盖非文件源 / 非 Emby 源的 400 文案。
func TestSubtitlesSourceGates(t *testing.T) {
	env := newTestEnv(t)
	defer env.teardown()

	ownerID := env.seedUser(t, "owner", "pass1234", "root", "active")
	ownerToken := env.token(t, ownerID, "root", "owner")
	env.seedRoom(t, "SUBROOM", "active", &ownerID)

	// bilibili 源：search 返回空列表（不是错误），browse / load 400。
	biliID := env.seedMovie(t, "SUBROOM", "bilibili", "")
	resp := env.do(t, http.MethodGet,
		"/api/subtitles/search?movieId="+itoa(biliID), ownerToken, nil)
	if resp.status != http.StatusOK {
		t.Fatalf("bilibili search 应 200，得到 %d/%s", resp.status, resp.raw)
	}
	if list, ok := resp.body["subtitles"].([]any); !ok || len(list) != 0 {
		t.Fatalf("bilibili search 应返回空数组（非 null），得到 %s", resp.raw)
	}

	resp = env.do(t, http.MethodGet,
		"/api/subtitles/browse?movieId="+itoa(biliID), ownerToken, nil)
	if resp.status != http.StatusBadRequest || resp.message() != "该影片源类型不支持目录浏览" {
		t.Fatalf("bilibili browse 应 400，得到 %d/%q", resp.status, resp.message())
	}

	resp = env.do(t, http.MethodGet,
		"/api/subtitles/load?movieId="+itoa(biliID)+"&path=/a.srt", ownerToken, nil)
	if resp.status != http.StatusBadRequest || resp.message() != "该影片源类型不支持字幕加载" {
		t.Fatalf("bilibili load 应 400，得到 %d/%q", resp.status, resp.message())
	}

	// 文件源但没有 path → 400「影片没有路径信息」。
	noPathID := env.seedMovie(t, "SUBROOM", "server-files", "")
	resp = env.do(t, http.MethodGet,
		"/api/subtitles/browse?movieId="+itoa(noPathID), ownerToken, nil)
	if resp.status != http.StatusBadRequest || resp.message() != "影片没有路径信息" {
		t.Fatalf("缺 path 的影片 browse 应 400，得到 %d/%q", resp.status, resp.message())
	}

	// 内嵌字幕：非 Emby 源 → 400（两条文案不同，不能混用）。
	resp = env.do(t, http.MethodGet,
		"/api/subtitles/embedded-tracks?movieId="+itoa(biliID), ownerToken, nil)
	if resp.status != http.StatusBadRequest ||
		resp.message() != "该来源的内嵌字幕提取已前端化，后端不再提供探测" {
		t.Fatalf("非 emby embedded-tracks 应 400，得到 %d/%q", resp.status, resp.message())
	}
	resp = env.do(t, http.MethodGet,
		"/api/subtitles/embedded-extract?movieId="+itoa(biliID)+"&index=1", ownerToken, nil)
	if resp.status != http.StatusBadRequest ||
		resp.message() != "该来源的内嵌字幕提取已前端化，后端不再提供提取" {
		t.Fatalf("非 emby embedded-extract 应 400，得到 %d/%q", resp.status, resp.message())
	}

	// index 非法 → 400「缺少或无效的 movieId/index 参数」。
	embyID := env.seedMovie(t, "SUBROOM", "emby", "item-1")
	resp = env.do(t, http.MethodGet,
		"/api/subtitles/embedded-extract?movieId="+itoa(embyID)+"&index=abc", ownerToken, nil)
	if resp.status != http.StatusBadRequest ||
		resp.message() != "缺少或无效的 movieId/index 参数" {
		t.Fatalf("index 非法应 400，得到 %d/%q", resp.status, resp.message())
	}
}

// itoa 见 admin_integration_test.go（同一个测试包内复用）。
