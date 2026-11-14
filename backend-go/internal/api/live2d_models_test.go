package api_test

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// makeLive2DZip 造一个最小可用的模型包。
//
// 结构故意做成「外层目录 + 入口 + 贴图子目录」：这是官方模型素材最常见的
// 打包形状，也能顺带验证「摊平一层目录」这条逻辑。
func makeLive2DZip(t *testing.T, extra map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)

	model := map[string]any{
		"Version": 3,
		"FileReferences": map[string]any{
			"Moc":      "hiyori.moc3",
			"Textures": []string{"hiyori.2048/texture_00.png"},
			"Physics":  "hiyori.physics3.json",
		},
	}
	raw, err := json.Marshal(model)
	if err != nil {
		t.Fatalf("序列化模型清单失败: %v", err)
	}
	files := map[string][]byte{
		"pack/hiyori.model3.json":            raw,
		"pack/hiyori.moc3":                   []byte("MOC3"),
		"pack/hiyori.2048/texture_00.png":    []byte("\x89PNG\r\n\x1a\n"),
		"pack/hiyori.physics3.json":          []byte(`{"Version":3}`),
		"pack/readme.txt":                    []byte("license"),
		"__MACOSX/pack/._hiyori.model3.json": []byte("junk"),
	}
	for name, data := range files {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatalf("创建 zip 条目失败: %v", err)
		}
		if _, err := w.Write(data); err != nil {
			t.Fatalf("写入 zip 条目失败: %v", err)
		}
	}
	for name, data := range extra {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatalf("创建 zip 条目失败: %v", err)
		}
		if _, err := w.Write([]byte(data)); err != nil {
			t.Fatalf("写入 zip 条目失败: %v", err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("关闭 zip 失败: %v", err)
	}
	return buf.Bytes()
}

// setupLive2DRoom 建一个用户+房间，返回房主令牌与所有者 id。
func setupLive2DRoom(t *testing.T) (*testEnv, string, int64) {
	t.Helper()
	env := newTestEnv(t)
	// 与现有用例一致：不 defer 的话 Windows 上 sqlite 还占着句柄，
	// t.TempDir 的清理会失败（子测试尤其容易踩到）。
	t.Cleanup(env.teardown)
	owner := env.seedUser(t, "l2d-host", "pw123456", "user", "active")
	env.seedRoom(t, "AB12CD", "active", &owner)
	return env, env.token(t, owner, "user", "l2d-host"), owner
}

func uploadLive2D(t *testing.T, env *testEnv, token string, content []byte) apiResponse {
	t.Helper()
	return env.doMultipart(t, "/api/rooms/AB12CD/live2d/models", token, "file", "Hiyori.zip", "application/zip", content)
}

func TestLive2DUploadAndServe(t *testing.T) {
	env, token, owner := setupLive2DRoom(t)
	resp := uploadLive2D(t, env, token, makeLive2DZip(t, nil))
	if resp.status != http.StatusOK {
		t.Fatalf("上传应成功，得到 %d: %s", resp.status, resp.raw)
	}
	model, ok := resp.body["model"].(map[string]any)
	if !ok {
		t.Fatalf("响应缺少 model: %s", resp.raw)
	}
	id, _ := model["id"].(string)
	if id == "" {
		t.Fatalf("模型 id 为空: %s", resp.raw)
	}
	if label, _ := model["label"].(string); label != "Hiyori" {
		t.Fatalf("显示名应取压缩包名，得到 %q", label)
	}

	// 落盘形状：入口固定名、贴图保留子目录、macOS 垃圾文件已被丢弃。
	dir := filepath.Join(env.uploads, "live2d", "AB12CD", id)
	expect := []string{
		"model.model3.json",
		"_meta.json",
		"hiyori.moc3",
		filepath.Join("hiyori.2048", "texture_00.png"),
		"hiyori.physics3.json",
	}
	for _, name := range expect {
		if _, err := os.Stat(filepath.Join(dir, name)); err != nil {
			t.Errorf("缺少文件 %s: %v", name, err)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "readme.txt")); err != nil {
		t.Errorf("外层目录里的文档应被保留: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "._hiyori.model3.json")); err == nil {
		t.Error("macOS 残留文件不应落地")
	}
	for _, junk := range []string{".DS_Store", "Thumbs.db"} {
		if _, err := os.Stat(filepath.Join(dir, junk)); err == nil {
			t.Errorf("系统垃圾文件 %s 不应落地", junk)
		}
	}

	// 入口重命名后，JSON 必须还能被解析（内容未被改写）。
	raw, err := os.ReadFile(filepath.Join(dir, "model.model3.json"))
	if err != nil {
		t.Fatalf("读取入口失败: %v", err)
	}
	var anyDoc map[string]any
	if err := json.Unmarshal(raw, &anyDoc); err != nil {
		t.Fatalf("入口不是合法 JSON: %v", err)
	}

	// 静态下发：公开可访问、带 nosniff、带长期缓存。
	env.do(t, http.MethodGet, "/api/rooms/AB12CD/live2d/models", token, nil)
	req, _ := http.NewRequest(http.MethodGet, "/uploads/live2d/AB12CD/"+id+"/model.model3.json", nil)
	rec := httptest.NewRecorder()
	env.handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("静态下发应 200，得到 %d", rec.Code)
	}
	if got := rec.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Errorf("缺少 nosniff: %q", got)
	}
	if got := rec.Header().Get("Cache-Control"); !strings.Contains(got, "immutable") {
		t.Errorf("缺少长期缓存头: %q", got)
	}

	// 目录列表没有用途，直接 404（否则等于把整包文件清单公开）。
	dirReq, _ := http.NewRequest(http.MethodGet, "/uploads/live2d/AB12CD/"+id+"/", nil)
	dirRec := httptest.NewRecorder()
	env.handler.ServeHTTP(dirRec, dirReq)
	if dirRec.Code != http.StatusNotFound {
		t.Errorf("目录列表应 404，得到 %d", dirRec.Code)
	}

	// 列表能看到这个模型，并且房主拿到的 canManage 为 true。
	list := env.do(t, http.MethodGet, "/api/rooms/AB12CD/live2d/models", token, nil)
	if list.status != http.StatusOK {
		t.Fatalf("列表应成功: %d %s", list.status, list.raw)
	}
	models, _ := list.body["models"].([]any)
	if len(models) != 1 {
		t.Fatalf("列表应有 1 个模型，得到 %d: %s", len(models), list.raw)
	}
	if manage, _ := list.body["canManage"].(bool); !manage {
		t.Errorf("房主应拿到 canManage=true")
	}
	_ = owner
}

func TestLive2DUploadRejectsNonHost(t *testing.T) {
	env, _, _ := setupLive2DRoom(t)
	guest := env.seedUser(t, "l2d-viewer", "pw123456", "user", "active")
	token := env.token(t, guest, "user", "l2d-viewer")

	resp := uploadLive2D(t, env, token, makeLive2DZip(t, nil))
	if resp.status != http.StatusForbidden {
		t.Fatalf("非房主上传应 403，得到 %d: %s", resp.status, resp.raw)
	}
	// 列表仍可读（观众要加载模型），但 canManage 为 false。
	list := env.do(t, http.MethodGet, "/api/rooms/AB12CD/live2d/models", token, nil)
	if list.status != http.StatusOK {
		t.Fatalf("观众列表应成功: %d %s", list.status, list.raw)
	}
	if manage, _ := list.body["canManage"].(bool); manage {
		t.Errorf("观众不应拿到 canManage=true")
	}
}

func TestLive2DUploadRejectsUnsafePackages(t *testing.T) {
	cases := []struct {
		name  string
		extra map[string]string
		want  string
	}{
		{
			name:  "目录穿越",
			extra: map[string]string{"pack/../../evil.txt": "x"},
			want:  "非法路径",
		},
		{
			name:  "可执行文件",
			extra: map[string]string{"pack/tool.exe": "MZ"},
			want:  "不支持的文件类型",
		},
		{
			name:  "多个入口",
			extra: map[string]string{"pack/another.model3.json": `{"Version":3}`},
			want:  "多个 model3.json",
		},
		{
			name:  "入口目录外的文件",
			extra: map[string]string{"other/data.png": "png"},
			want:  "不在模型入口所在目录",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			env, token, _ := setupLive2DRoom(t)
			resp := uploadLive2D(t, env, token, makeLive2DZip(t, tc.extra))
			if resp.status != http.StatusBadRequest {
				t.Fatalf("应 400，得到 %d: %s", resp.status, resp.raw)
			}
			if msg := resp.message(); !strings.Contains(msg, tc.want) {
				t.Fatalf("错误信息应包含 %q，得到 %q", tc.want, msg)
			}
			// 被拒绝的包不能在磁盘上留下任何东西。
			roomDir := filepath.Join(env.uploads, "live2d", "AB12CD")
			entries, _ := os.ReadDir(roomDir)
			for _, entry := range entries {
				t.Errorf("拒绝后不应残留目录: %s", entry.Name())
			}
		})
	}
}

func TestLive2DUploadRejectsMissingReference(t *testing.T) {
	env, token, _ := setupLive2DRoom(t)
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, _ := zw.Create("m/pack.model3.json")
	_, _ = w.Write([]byte(`{"Version":3,"FileReferences":{"Moc":"gone.moc3"}}`))
	if err := zw.Close(); err != nil {
		t.Fatalf("关闭 zip 失败: %v", err)
	}

	resp := uploadLive2D(t, env, token, buf.Bytes())
	if resp.status != http.StatusBadRequest {
		t.Fatalf("引用缺失应 400，得到 %d: %s", resp.status, resp.raw)
	}
	if msg := resp.message(); !strings.Contains(msg, "gone.moc3") {
		t.Fatalf("错误信息应指出缺哪个文件，得到 %q", msg)
	}
}

func TestLive2DDeleteModel(t *testing.T) {
	env, token, _ := setupLive2DRoom(t)
	up := uploadLive2D(t, env, token, makeLive2DZip(t, nil))
	model, _ := up.body["model"].(map[string]any)
	id, _ := model["id"].(string)
	if id == "" {
		t.Fatalf("上传未返回 id: %s", up.raw)
	}

	other := env.seedUser(t, "l2d-other", "pw123456", "user", "active")
	otherToken := env.token(t, other, "user", "l2d-other")
	if resp := env.do(t, http.MethodDelete, fmt.Sprintf("/api/rooms/AB12CD/live2d/models/%s", id), otherToken, nil); resp.status != http.StatusForbidden {
		t.Fatalf("非房主删除应 403，得到 %d", resp.status)
	}

	if resp := env.do(t, http.MethodDelete, fmt.Sprintf("/api/rooms/AB12CD/live2d/models/%s", id), token, nil); resp.status != http.StatusOK {
		t.Fatalf("房主删除应 200，得到 %d: %s", resp.status, resp.raw)
	}
	if _, err := os.Stat(filepath.Join(env.uploads, "live2d", "AB12CD", id)); !os.IsNotExist(err) {
		t.Errorf("删除后目录应消失，stat err=%v", err)
	}
	if list := env.do(t, http.MethodGet, "/api/rooms/AB12CD/live2d/models", token, nil); list.status == http.StatusOK {
		if models, _ := list.body["models"].([]any); len(models) != 0 {
			t.Errorf("删除后列表应为空，得到 %d 条", len(models))
		}
	}
}

// TestLive2DModelIDRejectsTraversal 守住 id 正则：删除接口如果放过 `..%2F`，
// 一条请求就能删掉整个 live2d 根目录。
func TestLive2DModelIDRejectsTraversal(t *testing.T) {
	env, token, _ := setupLive2DRoom(t)
	resp := env.do(t, http.MethodDelete, "/api/rooms/AB12CD/live2d/models/..%2Fother", token, nil)
	if resp.status == http.StatusOK {
		t.Fatalf("非法 id 不应成功: %s", resp.raw)
	}
}
