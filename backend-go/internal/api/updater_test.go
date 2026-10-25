package api_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// 桌面托管的提示文案：前端会原样显示，改一个字都要两端同步。
const wantDesktopHint = "当前由 ZViewer Desktop 桌面端管理，请去 GUI 的更新功能中更新"

// doBinary 发带任意 Content-Type 的请求体。
func (e *testEnv) doBinary(t *testing.T, path, token, contentType string, body []byte) apiResponse {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(body))
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	e.handler.ServeHTTP(rec, req)

	resp := apiResponse{status: rec.Code, raw: rec.Body.String()}
	_ = json.Unmarshal(rec.Body.Bytes(), &resp.body)
	return resp
}

// TestUpdaterAuthBoundaries 五个端点共用同一套门禁：401 → 403 → 409。
//
// 顺序不能反：409 放在鉴权之前等于对陌生人宣告「这台是桌面版」。
func TestUpdaterAuthBoundaries(t *testing.T) {
	env := newTestEnv(t)
	defer env.teardown()

	rootID := env.seedUser(t, "root1", "pass1234", "root", "active")
	userID := env.seedUser(t, "alice", "pass1234", "user", "active")
	rootToken := env.token(t, rootID, "root", "root1")
	userToken := env.token(t, userID, "user", "alice")

	endpoints := []struct{ method, path string }{
		{http.MethodGet, "/api/system/update/check"},
		{http.MethodPost, "/api/system/update/apply-stream"},
		{http.MethodPost, "/api/system/update/apply"},
		{http.MethodPost, "/api/system/update/upload-stream"},
		{http.MethodPost, "/api/system/update/upload"},
	}

	for _, endpoint := range endpoints {
		t.Run(endpoint.path, func(t *testing.T) {
			if resp := env.do(t, endpoint.method, endpoint.path, "", nil); resp.status != http.StatusUnauthorized {
				t.Fatalf("未登录应 401，得到 %d", resp.status)
			}
			resp := env.do(t, endpoint.method, endpoint.path, userToken, nil)
			if resp.status != http.StatusForbidden {
				t.Fatalf("普通用户应 403，得到 %d", resp.status)
			}
			if resp.message() != "无权限：仅 root 可操作" {
				t.Fatalf("403 文案不对: %q", resp.message())
			}
		})
	}

	t.Setenv("ZVIEWER_DESKTOP", "1")
	resp := env.do(t, http.MethodGet, "/api/system/update/check", rootToken, nil)
	if resp.status != http.StatusConflict {
		t.Fatalf("桌面托管应 409，得到 %d", resp.status)
	}
	if resp.body["desktopManaged"] != true {
		t.Fatalf("409 应带 desktopManaged=true，实际 %v", resp.body)
	}
	if resp.message() != wantDesktopHint {
		t.Fatalf("409 文案不对: %q", resp.message())
	}
	if resp.body["success"] != false {
		t.Fatalf("409 应带 success=false，实际 %v", resp.body)
	}
}

// TestUpdaterUploadValidation 上传端点的入参校验（都在真正解压之前）。
func TestUpdaterUploadValidation(t *testing.T) {
	env := newTestEnv(t)
	defer env.teardown()
	// 默认可能是容器/桌面环境，这里显式关掉桌面托管，走到真实 handler。
	t.Setenv("ZVIEWER_DESKTOP", "")

	rootID := env.seedUser(t, "root1", "pass1234", "root", "active")
	rootToken := env.token(t, rootID, "root", "root1")

	// 没有 Content-Type：Express 的 raw 根本不解析 body，等同于空。
	resp := env.doBinary(t, "/api/system/update/upload", rootToken, "", []byte("payload"))
	if resp.status != http.StatusBadRequest || resp.message() != "未收到有效的文件数据" {
		t.Fatalf("缺 Content-Type 应 400，得到 %d/%q", resp.status, resp.message())
	}

	// Content-Type 对但 body 为空。
	resp = env.doBinary(t, "/api/system/update/upload", rootToken, "application/zip", nil)
	if resp.status != http.StatusBadRequest || resp.message() != "未收到有效的文件数据" {
		t.Fatalf("空 body 应 400，得到 %d/%q", resp.status, resp.message())
	}

	// 不在白名单的 Content-Type 同样按「没收到数据」处理。
	resp = env.doBinary(t, "/api/system/update/upload", rootToken, "application/json", []byte(`{}`))
	if resp.status != http.StatusBadRequest {
		t.Fatalf("非白名单类型应 400，得到 %d", resp.status)
	}

	// 扩展名不在白名单：校验发生在解压之前，不会碰文件。
	resp = env.doBinary(t, "/api/system/update/upload?filename=update.tar", rootToken,
		"application/octet-stream", []byte("whatever"))
	if resp.status != http.StatusInternalServerError {
		t.Fatalf("非法扩展名应 500，得到 %d", resp.status)
	}
	if resp.message() != "仅支持 .zip 或 .tar.gz 格式的压缩包" {
		t.Fatalf("扩展名错误文案不对: %q", resp.message())
	}

	// 扩展名对但内容不是压缩包：解压失败，路径已含「解压失败」。
	resp = env.doBinary(t, "/api/system/update/upload", rootToken, "application/zip", []byte("not a zip"))
	if resp.status != http.StatusInternalServerError {
		t.Fatalf("坏包应 500，得到 %d", resp.status)
	}
	if !strings.Contains(resp.message(), "解压失败") {
		t.Fatalf("坏包文案应含「解压失败」，实际 %q", resp.message())
	}
}

// TestUpdaterUploadStreamErrorEvent 校验失败要落在 SSE 的 error 事件里。
//
// 这条路径的关键在于「先校验、后切流」：一旦切了 SSE，状态码就恒为 200，
// 前端只能从事件里读错误，所以两端的字节必须完全一致。
func TestUpdaterUploadStreamErrorEvent(t *testing.T) {
	env := newTestEnv(t)
	defer env.teardown()
	t.Setenv("ZVIEWER_DESKTOP", "")

	rootID := env.seedUser(t, "root1", "pass1234", "root", "active")
	rootToken := env.token(t, rootID, "root", "root1")

	resp := env.doBinary(t, "/api/system/update/upload-stream?filename=bad.tar", rootToken,
		"application/octet-stream", []byte("whatever"))
	if resp.status != http.StatusOK {
		t.Fatalf("切流后状态码应 200，得到 %d", resp.status)
	}
	want := "data: {\"stage\":\"error\",\"message\":\"仅支持 .zip 或 .tar.gz 格式的压缩包\"}\n\n"
	if resp.raw != want {
		t.Fatalf("SSE 事件不一致:\n  期望 %q\n  实际 %q", want, resp.raw)
	}
}
