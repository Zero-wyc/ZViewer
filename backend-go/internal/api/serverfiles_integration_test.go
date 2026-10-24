package api_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// doRaw 发一个不带 JSON body 的请求（GET/HEAD/DELETE），并把响应头一并带回。
func (e *testEnv) doRaw(t *testing.T, method, path, token string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, nil)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	e.handler.ServeHTTP(rec, req)
	return rec
}

// doUploadFiles 按前端的方式上传：先写 targetDir 字段，再逐个写 files。
func (e *testEnv) doUploadFiles(t *testing.T, token, targetDir string, names ...string) apiResponse {
	t.Helper()
	var buf bytes.Buffer
	writer := multipart.NewWriter(&buf)
	if targetDir != "" {
		if err := writer.WriteField("targetDir", targetDir); err != nil {
			t.Fatalf("写字段失败: %v", err)
		}
	}
	for _, name := range names {
		header := textproto.MIMEHeader{}
		header.Set("Content-Disposition", fmt.Sprintf(`form-data; name="files"; filename=%q`, name))
		header.Set("Content-Type", "video/mp4")
		part, err := writer.CreatePart(header)
		if err != nil {
			t.Fatalf("建 part 失败: %v", err)
		}
		if _, err := part.Write([]byte("payload-" + name)); err != nil {
			t.Fatalf("写 part 失败: %v", err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("关闭 multipart 失败: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/server-files/upload", &buf)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	e.handler.ServeHTTP(rec, req)
	resp := apiResponse{status: rec.Code, raw: rec.Body.String()}
	_ = json.Unmarshal(rec.Body.Bytes(), &resp.body)
	return resp
}

// TestServerFilesRootsAndBrowse 覆盖根目录维护与目录浏览。
func TestServerFilesRootsAndBrowse(t *testing.T) {
	env := newTestEnv(t)
	defer env.teardown()
	rootID := env.seedUser(t, "root", "root-pw", "root", "active")
	userID := env.seedUser(t, "viewer", "viewer-pw", "user", "active")
	rootToken := env.token(t, rootID, "root", "root")
	userToken := env.token(t, userID, "user", "viewer")

	// 非 root 一律 403（管理类端点）
	resp := env.do(t, http.MethodGet, "/api/server-files/roots", userToken, nil)
	if resp.status != http.StatusForbidden {
		t.Fatalf("普通用户访问 /roots 状态码 = %d，期望 403", resp.status)
	}

	resp = env.do(t, http.MethodGet, "/api/server-files/roots", rootToken, nil)
	if resp.status != http.StatusOK {
		t.Fatalf("/roots 状态码 = %d，期望 200（%s）", resp.status, resp.raw)
	}
	roots, _ := resp.body["roots"].([]any)
	if len(roots) != 1 {
		t.Fatalf("初始应只有 uploads 根，得到 %d 个", len(roots))
	}
	uploadsRoot, _ := roots[0].(map[string]any)
	if uploadsRoot["key"] != "uploads" || uploadsRoot["name"] != "默认空间" {
		t.Fatalf("uploads 根描述不符: %v", uploadsRoot)
	}
	if uploadsRoot["exists"] != true {
		t.Fatalf("uploads 根应存在: %v", uploadsRoot)
	}

	// 新增自定义根：名称为空 / 路径不存在 / 重复 / 成功
	if resp = env.do(t, http.MethodPost, "/api/server-files/roots", rootToken,
		map[string]any{"name": " ", "absPath": env.uploads}); resp.status != 400 || resp.message() != "名称不能为空" {
		t.Fatalf("空名称应 400，得到 %d %q", resp.status, resp.message())
	}
	if resp = env.do(t, http.MethodPost, "/api/server-files/roots", rootToken,
		map[string]any{"name": "x", "absPath": filepath.Join(env.uploads, "nope")}); resp.message() != "目录不存在或无访问权限" {
		t.Fatalf("不存在路径文案不符: %q", resp.message())
	}
	if resp = env.do(t, http.MethodPost, "/api/server-files/roots", rootToken,
		map[string]any{"name": "x", "absPath": env.uploads}); resp.message() != "该目录已是默认空间" {
		t.Fatalf("uploads 根重复添加文案不符: %q", resp.message())
	}

	customDir := t.TempDir()
	resp = env.do(t, http.MethodPost, "/api/server-files/roots", rootToken,
		map[string]any{"name": "自定义", "absPath": customDir, "readonly": true})
	if resp.status != 200 {
		t.Fatalf("新增自定义根失败: %s", resp.raw)
	}
	added, _ := resp.body["root"].(map[string]any)
	if added["key"] != "custom:1" || added["readonly"] != true {
		t.Fatalf("新增根描述不符: %v", added)
	}
	if resp = env.do(t, http.MethodPost, "/api/server-files/roots", rootToken,
		map[string]any{"name": "again", "absPath": customDir}); resp.message() != "该目录已添加" {
		t.Fatalf("重复添加文案不符: %q", resp.message())
	}

	// 浏览：目录在前、隐藏文件剔除、size 只出现在文件上
	if err := os.MkdirAll(filepath.Join(env.uploads, "dirB"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(env.uploads, "dirA"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(env.uploads, "z.mp4"), []byte("12345"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(env.uploads, ".hidden"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	resp = env.do(t, http.MethodGet, "/api/server-files/browse?path=uploads:/", rootToken, nil)
	if resp.status != 200 {
		t.Fatalf("browse 失败: %s", resp.raw)
	}
	if resp.body["currentPath"] != "uploads:/" || resp.body["readonly"] != false {
		t.Fatalf("browse 元信息不符: %v", resp.body)
	}
	entries, _ := resp.body["entries"].([]any)
	// 按名字索引：测试环境里 uploads 根下还有 avatars 目录，不比总数只比相对顺序。
	indexOf := func(name string) int {
		for i, raw := range entries {
			item, _ := raw.(map[string]any)
			if item["name"] == name {
				return i
			}
		}
		return -1
	}
	if indexOf(".hidden") >= 0 {
		t.Fatalf("隐藏文件不应出现在列表里: %v", entries)
	}
	dirA, dirB, file := indexOf("dirA"), indexOf("dirB"), indexOf("z.mp4")
	if dirA < 0 || dirB < 0 || file < 0 {
		t.Fatalf("缺少预期条目（dirA=%d dirB=%d z.mp4=%d）: %v", dirA, dirB, file, entries)
	}
	if !(dirA < dirB && dirB < file) {
		t.Fatalf("排序应为「目录在前 + 名称升序」，得到 dirA=%d dirB=%d z.mp4=%d", dirA, dirB, file)
	}
	firstItem, _ := entries[dirA].(map[string]any)
	if firstItem["type"] != "directory" {
		t.Fatalf("dirA 的 type 应为 directory: %v", firstItem)
	}
	if _, hasSize := firstItem["size"]; hasSize {
		t.Fatalf("目录不应带 size 键: %v", firstItem)
	}
	fileItem, _ := entries[file].(map[string]any)
	if fileItem["size"] != float64(5) {
		t.Fatalf("文件大小不符: %v", fileItem)
	}
	if fileItem["path"] != "uploads:/z.mp4" {
		t.Fatalf("文件 path 未加前缀: %v", fileItem["path"])
	}

	// 越权路径：必须 400，且文案为路径越权
	resp = env.do(t, http.MethodGet, "/api/server-files/browse?path="+url.QueryEscape("uploads:../x"), rootToken, nil)
	if resp.status != 400 || resp.message() != "路径越权" {
		t.Fatalf("越权路径应 400 路径越权，得到 %d %q", resp.status, resp.message())
	}

	// 浏览系统目录：不带参数时返回系统根
	resp = env.do(t, http.MethodGet, "/api/server-files/browse-system", rootToken, nil)
	if resp.status != 200 || resp.body["isRoot"] != true {
		t.Fatalf("browse-system 根应 isRoot=true，得到 %d %v", resp.status, resp.body)
	}

	// 删除自定义根
	resp = env.do(t, http.MethodDelete, "/api/server-files/roots/1", rootToken, nil)
	if resp.status != 200 {
		t.Fatalf("删除根失败: %s", resp.raw)
	}
	if resp = env.do(t, http.MethodDelete, "/api/server-files/roots/1", rootToken, nil); resp.status != 404 {
		t.Fatalf("重复删除应 404，得到 %d", resp.status)
	}
}

// TestServerFilesMutations 覆盖上传/新建目录/重命名/删除。
func TestServerFilesMutations(t *testing.T) {
	env := newTestEnv(t)
	defer env.teardown()
	rootID := env.seedUser(t, "root", "root-pw", "root", "active")
	rootToken := env.token(t, rootID, "root", "root")

	// 上传到不存在的目录：要自动创建
	resp := env.doUploadFiles(t, rootToken, "uploads:/movies", "a.mp4")
	if resp.status != 200 {
		t.Fatalf("上传失败: %s", resp.raw)
	}
	files, _ := resp.body["files"].([]any)
	if len(files) != 1 {
		t.Fatalf("上传结果数量不符: %v", resp.body)
	}
	uploaded, _ := files[0].(map[string]any)
	if uploaded["name"] != "a.mp4" || uploaded["path"] != "uploads:/movies/a.mp4" {
		t.Fatalf("上传结果不符: %v", uploaded)
	}

	// 同名再传：追加序号而非覆盖
	resp = env.doUploadFiles(t, rootToken, "uploads:/movies", "a.mp4")
	files, _ = resp.body["files"].([]any)
	uploaded, _ = files[0].(map[string]any)
	if uploaded["name"] != "a (1).mp4" {
		t.Fatalf("重名文件应改名，得到 %v", uploaded["name"])
	}

	// 未收到文件
	req := httptest.NewRequest(http.MethodPost, "/api/server-files/upload", bytes.NewReader(nil))
	req.Header.Set("Authorization", "Bearer "+rootToken)
	rec := httptest.NewRecorder()
	env.handler.ServeHTTP(rec, req)
	if rec.Code != 400 || !strings.Contains(rec.Body.String(), "未接收到文件") {
		t.Fatalf("空上传应 400 未接收到文件，得到 %d %s", rec.Code, rec.Body.String())
	}

	// 新建文件夹：非法字符 / 重名 / 成功
	if resp = env.do(t, http.MethodPost, "/api/server-files/folder", rootToken,
		map[string]any{"parent": "uploads:/", "name": "a/b"}); resp.message() != "文件夹名称包含非法字符" {
		t.Fatalf("非法字符文案不符: %q", resp.message())
	}
	if resp = env.do(t, http.MethodPost, "/api/server-files/folder", rootToken,
		map[string]any{"parent": "uploads:/", "name": "movies"}); resp.message() != "同名项目已存在" {
		t.Fatalf("重名目录文案不符: %q", resp.message())
	}
	resp = env.do(t, http.MethodPost, "/api/server-files/folder", rootToken,
		map[string]any{"parent": "uploads:/", "name": "新目录"})
	if resp.status != 200 || resp.body["path"] != "uploads:/新目录" {
		t.Fatalf("新建目录失败: %s", resp.raw)
	}

	// 重命名
	resp = env.do(t, http.MethodPost, "/api/server-files/rename", rootToken,
		map[string]any{"path": "uploads:/新目录", "newName": "改名后"})
	if resp.status != 200 || resp.body["path"] != "uploads:/改名后" {
		t.Fatalf("重命名失败: %s", resp.raw)
	}
	if resp = env.do(t, http.MethodPost, "/api/server-files/rename", rootToken,
		map[string]any{"path": "uploads:/不存在", "newName": "x"}); resp.status != 404 {
		t.Fatalf("重命名不存在的路径应 404，得到 %d", resp.status)
	}

	// 删除：根目录保护优先于存在性检查
	if resp = env.do(t, http.MethodDelete, "/api/server-files/file?path="+url.QueryEscape("uploads:/"), rootToken, nil); resp.message() != "不能删除根目录" {
		t.Fatalf("删根文案不符: %q", resp.message())
	}
	if resp = env.do(t, http.MethodDelete, "/api/server-files/file?path="+url.QueryEscape("uploads:/movies/a.mp4"), rootToken, nil); resp.status != 200 {
		t.Fatalf("删除文件失败: %s", resp.raw)
	}
	if resp = env.do(t, http.MethodDelete, "/api/server-files/file?path="+url.QueryEscape("uploads:/movies/a.mp4"), rootToken, nil); resp.status != 404 {
		t.Fatalf("重复删除应 404，得到 %d", resp.status)
	}
}

// TestServerFilesResolveAndProxy 覆盖 /resolve 与 /proxy（Range + HEAD）。
func TestServerFilesResolveAndProxy(t *testing.T) {
	env := newTestEnv(t)
	defer env.teardown()
	userID := env.seedUser(t, "viewer", "viewer-pw", "user", "active")
	userToken := env.token(t, userID, "user", "viewer")

	content := []byte("0123456789")
	target := filepath.Join(env.uploads, "sample.mkv")
	if err := os.WriteFile(target, content, 0o644); err != nil {
		t.Fatal(err)
	}

	// /resolve：普通用户也能用（观众要能播房主推送的本地视频）
	resp := env.do(t, http.MethodGet, "/api/server-files/resolve?path="+url.QueryEscape("uploads:/sample.mkv"), userToken, nil)
	if resp.status != 200 {
		t.Fatalf("/resolve 失败: %s", resp.raw)
	}
	if resp.body["title"] != "sample.mkv" || resp.body["format"] != "mkv" {
		t.Fatalf("/resolve 元信息不符: %v", resp.body)
	}
	if resp.body["size"] != float64(len(content)) {
		t.Fatalf("/resolve size 不符: %v", resp.body["size"])
	}
	if resp.body["videoUrl"] != "/api/server-files/proxy?path="+url.PathEscape("uploads:/sample.mkv") {
		// url.PathEscape 与 encodeURIComponent 对 ':' '/' 的处理不同，这里只校验前缀
		if !strings.HasPrefix(fmt.Sprint(resp.body["videoUrl"]), "/api/server-files/proxy?path=") {
			t.Fatalf("/resolve videoUrl 不符: %v", resp.body["videoUrl"])
		}
	}

	// /resolve 缺少 path
	if resp = env.do(t, http.MethodGet, "/api/server-files/resolve", userToken, nil); resp.status != 400 {
		t.Fatalf("缺 path 应 400，得到 %d", resp.status)
	}
	// /resolve 目录
	if resp = env.do(t, http.MethodGet, "/api/server-files/resolve?path=uploads:/", userToken, nil); resp.status != 404 {
		t.Fatalf("目录应 404，得到 %d", resp.status)
	}

	// HEAD /proxy：只回头
	head := env.doRaw(t, http.MethodHead, "/api/server-files/proxy?path="+url.QueryEscape("uploads:/sample.mkv"), userToken, nil)
	if head.Code != 200 {
		t.Fatalf("HEAD /proxy 状态码 = %d", head.Code)
	}
	if head.Header().Get("Content-Length") != "10" || head.Header().Get("Accept-Ranges") != "bytes" {
		t.Fatalf("HEAD 头不符: %v", head.Header())
	}
	if head.Header().Get("Content-Type") != "video/x-matroska" {
		t.Fatalf("Content-Type 不符: %q", head.Header().Get("Content-Type"))
	}
	if head.Body.Len() != 0 {
		t.Fatalf("HEAD 不应有响应体，得到 %q", head.Body.String())
	}

	// GET /proxy 带 Range：206 + Content-Range
	rec := env.doRaw(t, http.MethodGet, "/api/server-files/proxy?path="+url.QueryEscape("uploads:/sample.mkv"), userToken,
		map[string]string{"Range": "bytes=2-5"})
	if rec.Code != http.StatusPartialContent {
		t.Fatalf("Range 请求状态码 = %d，期望 206", rec.Code)
	}
	if rec.Body.String() != "2345" {
		t.Fatalf("Range 响应体 = %q，期望 2345", rec.Body.String())
	}
	if rec.Header().Get("Content-Range") != "bytes 2-5/10" {
		t.Fatalf("Content-Range 不符: %q", rec.Header().Get("Content-Range"))
	}

	// 不可满足的 Range：416 + bytes */size
	rec = env.doRaw(t, http.MethodGet, "/api/server-files/proxy?path="+url.QueryEscape("uploads:/sample.mkv"), userToken,
		map[string]string{"Range": "bytes=100-200"})
	if rec.Code != http.StatusRequestedRangeNotSatisfiable {
		t.Fatalf("越界 Range 状态码 = %d，期望 416", rec.Code)
	}
	if rec.Header().Get("Content-Range") != "bytes */10" {
		t.Fatalf("416 的 Content-Range 不符: %q", rec.Header().Get("Content-Range"))
	}

	// 完整下载：200 + 全量内容
	rec = env.doRaw(t, http.MethodGet, "/api/server-files/proxy?path="+url.QueryEscape("uploads:/sample.mkv"), userToken, nil)
	if rec.Code != 200 || rec.Body.String() != "0123456789" {
		t.Fatalf("完整下载不符: %d %q", rec.Code, rec.Body.String())
	}

	// 未登录：401（/proxy 只要求登录，不要求 root）
	rec = env.doRaw(t, http.MethodGet, "/api/server-files/proxy?path="+url.QueryEscape("uploads:/sample.mkv"), "", nil)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("未登录访问 /proxy 应 401，得到 %d", rec.Code)
	}
}
