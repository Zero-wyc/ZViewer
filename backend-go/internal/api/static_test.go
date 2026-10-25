package api_test

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeDist 造一份最小前端产物：index.html + 一个普通资源 + 一个 ffmpeg 大文件。
func writeDist(t *testing.T, dist string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(dist, "assets"), 0o755); err != nil {
		t.Fatalf("建 assets 目录失败: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(dist, "ffmpeg"), 0o755); err != nil {
		t.Fatalf("建 ffmpeg 目录失败: %v", err)
	}
	files := map[string]string{
		"index.html":       `<html><body><div id="root">ZViewer-SPA</div></body></html>`,
		"assets/app.js":    `console.log('app')`,
		"ffmpeg/core.wasm": "wasm-bytes",
	}
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(dist, filepath.FromSlash(name)), []byte(content), 0o644); err != nil {
			t.Fatalf("写 %s 失败: %v", name, err)
		}
	}
}

func rawGet(t *testing.T, env *testEnv, method, target string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, target, nil)
	rec := httptest.NewRecorder()
	env.handler.ServeHTTP(rec, req)
	return rec
}

// 站点根路径必须回 index.html。
//
// 这是被 `scripts/frontend-smoke.sh` 抓出来的真 bug：`path.Clean("/")` 得到 "/"，
// Join 之后 full == dist（没有尾分隔符），目录穿越防护的 HasPrefix 判定失败，
// 于是 `/` 回了 404 JSON —— 用户直接访问域名会看到一个 JSON 错误。
func TestSpaServesIndexAtRoot(t *testing.T) {
	env := newTestEnv(t)
	defer env.teardown()
	writeDist(t, env.dist)

	rec := rawGet(t, env, http.MethodGet, "/")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET / 应 200，得到 %d（%s）", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "ZViewer-SPA") {
		t.Errorf("GET / 未返回 index.html: %s", rec.Body.String())
	}
}

func TestSpaFallbackAndAssets(t *testing.T) {
	env := newTestEnv(t)
	defer env.teardown()
	writeDist(t, env.dist)

	// 前端路由回退到 index.html（刷新 /room/xxx 不能 404）
	for _, target := range []string{"/login", "/room/ABC", "/admin"} {
		rec := rawGet(t, env, http.MethodGet, target)
		if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "ZViewer-SPA") {
			t.Errorf("%s 应回退 index.html，得到 %d（%s）", target, rec.Code, rec.Body.String())
		}
	}

	// 真实存在的静态资源按原样返回
	rec := rawGet(t, env, http.MethodGet, "/assets/app.js")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "console.log") {
		t.Errorf("/assets/app.js 应 200 且是原文件，得到 %d（%s）", rec.Code, rec.Body.String())
	}

	// ffmpeg 核心要长缓存（32MB，每次播放都重下是最贵的回归）
	rec = rawGet(t, env, http.MethodGet, "/ffmpeg/core.wasm")
	if rec.Code != http.StatusOK {
		t.Fatalf("/ffmpeg/core.wasm 应 200，得到 %d", rec.Code)
	}
	if got := rec.Header().Get("Cache-Control"); !strings.Contains(got, "immutable") {
		t.Errorf("ffmpeg 资源缺少 immutable 缓存头: %q", got)
	}
}

func TestSpaKeepsAPINotFound(t *testing.T) {
	env := newTestEnv(t)
	defer env.teardown()
	writeDist(t, env.dist)

	// /api/* 未命中必须是 JSON 404，绝不能回 index.html（前端会 JSON.parse 崩）
	rec := rawGet(t, env, http.MethodGet, "/api/definitely-not-here")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("未知 /api 路径应 404，得到 %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "接口不存在") {
		t.Errorf("应回 JSON「接口不存在」，得到 %s", rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "ZViewer-SPA") {
		t.Error("/api 未命中被 SPA 回退吃掉了")
	}

	// 非 GET/HEAD 也不能落到 index.html
	rec = rawGet(t, env, http.MethodPost, "/login")
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST /login 应 405，得到 %d", rec.Code)
	}
}

func TestSpaRejectsTraversalAndReportsMissingDist(t *testing.T) {
	env := newTestEnv(t)
	defer env.teardown()
	writeDist(t, env.dist)

	// 目录穿越：Clean 之后落在 dist 内，但绝不能读到 dist 之外的文件
	secret := filepath.Join(filepath.Dir(env.dist), "secret.txt")
	if err := os.WriteFile(secret, []byte("TOP-SECRET"), 0o644); err != nil {
		t.Fatalf("写测试文件失败: %v", err)
	}
	rec := rawGet(t, env, http.MethodGet, "/../secret.txt")
	if strings.Contains(rec.Body.String(), "TOP-SECRET") {
		t.Fatalf("目录穿越读到了 dist 外的文件: %s", rec.Body.String())
	}

	// 产物缺失时明确报错，而不是回一个空 200 让前端白屏
	empty := newTestEnv(t)
	defer empty.teardown()
	rec = rawGet(t, empty, http.MethodGet, "/")
	if rec.Code != http.StatusNotFound {
		t.Errorf("产物缺失时应 404，得到 %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "前端构建产物不存在") {
		t.Errorf("产物缺失的提示文案变了: %s", rec.Body.String())
	}
}
