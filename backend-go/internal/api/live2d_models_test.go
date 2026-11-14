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

// setupLive2DLibrary 建环境 + 一个普通用户令牌。
//
// 模型库是**服务端公共**的，上传/删除不再需要房间，所以这里也不建房间。
func setupLive2DLibrary(t *testing.T) (*testEnv, string, int64) {
	t.Helper()
	env := newTestEnv(t)
	// 与现有用例一致：不 defer 的话 Windows 上 sqlite 还占着句柄，
	// t.TempDir 的清理会失败（子测试尤其容易踩到）。
	t.Cleanup(env.teardown)
	user := env.seedUser(t, "l2d-user", "pw123456", "user", "active")
	return env, env.token(t, user, "user", "l2d-user"), user
}

func uploadLive2D(t *testing.T, env *testEnv, token string, content []byte) apiResponse {
	t.Helper()
	return env.doMultipart(t, "/api/live2d/models", token, "file", "Hiyori.zip", "application/zip", content)
}

func TestLive2DUploadAndServe(t *testing.T) {
	env, token, _ := setupLive2DLibrary(t)
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

	// 落盘形状：直接躺在库根下（不再有房间号这一层），入口固定名、
	// 贴图保留子目录、macOS 垃圾文件已被丢弃。
	dir := filepath.Join(env.uploads, "live2d", id)
	expect := []string{
		"model.model3.json",
		".meta.json",
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
	req, _ := http.NewRequest(http.MethodGet, "/uploads/live2d/"+id+"/model.model3.json", nil)
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

	// .meta.json 里带上传者 userId，它绝不能随模型一起被公开下载。
	metaReq, _ := http.NewRequest(http.MethodGet, "/uploads/live2d/"+id+"/.meta.json", nil)
	metaRec := httptest.NewRecorder()
	env.handler.ServeHTTP(metaRec, metaReq)
	if metaRec.Code != http.StatusNotFound {
		t.Errorf("元数据文件应 404，得到 %d", metaRec.Code)
	}

	// 目录列表没有用途，直接 404（否则等于把整包文件清单公开）。
	dirReq, _ := http.NewRequest(http.MethodGet, "/uploads/live2d/"+id+"/", nil)
	dirRec := httptest.NewRecorder()
	env.handler.ServeHTTP(dirRec, dirReq)
	if dirRec.Code != http.StatusNotFound {
		t.Errorf("目录列表应 404，得到 %d", dirRec.Code)
	}

	// 列表能看到这个模型；上传者本人拿到 canManage（能再传）与 deletable（能删）。
	list := env.do(t, http.MethodGet, "/api/live2d/models", token, nil)
	if list.status != http.StatusOK {
		t.Fatalf("列表应成功: %d %s", list.status, list.raw)
	}
	models, _ := list.body["models"].([]any)
	if len(models) != 1 {
		t.Fatalf("列表应有 1 个模型，得到 %d: %s", len(models), list.raw)
	}
	if manage, _ := list.body["canManage"].(bool); !manage {
		t.Errorf("登录用户应拿到 canManage=true")
	}
	first, _ := models[0].(map[string]any)
	if deletable, _ := first["deletable"].(bool); !deletable {
		t.Errorf("上传者本人应能删除自己的模型")
	}
	if owner, has := first["owner"]; has {
		t.Errorf("列表不应外发 owner 字段，得到 %v", owner)
	}
}

// 库是全服务端共用的：A 传的模型，B（另一个用户、没进过任何房间）也能看到、
// 也能自己再传一个。游客只能看，不能往库里写。
func TestLive2DLibrarySharedAcrossUsers(t *testing.T) {
	env, tokenA, _ := setupLive2DLibrary(t)
	if resp := uploadLive2D(t, env, tokenA, makeLive2DZip(t, nil)); resp.status != http.StatusOK {
		t.Fatalf("A 上传应成功，得到 %d: %s", resp.status, resp.raw)
	}

	userB := env.seedUser(t, "l2d-other", "pw123456", "user", "active")
	tokenB := env.token(t, userB, "user", "l2d-other")

	list := env.do(t, http.MethodGet, "/api/live2d/models", tokenB, nil)
	if list.status != http.StatusOK {
		t.Fatalf("B 列表应成功: %d %s", list.status, list.raw)
	}
	models, _ := list.body["models"].([]any)
	if len(models) != 1 {
		t.Fatalf("B 应看到 A 传的模型，得到 %d 条: %s", len(models), list.raw)
	}
	first, _ := models[0].(map[string]any)
	if deletable, _ := first["deletable"].(bool); deletable {
		t.Errorf("B 不应能删除 A 传的模型")
	}
	if resp := uploadLive2D(t, env, tokenB, makeLive2DZip(t, nil)); resp.status != http.StatusOK {
		t.Fatalf("B 也应能上传，得到 %d: %s", resp.status, resp.raw)
	}

	// 游客：能看（要加载别人选的模型），不能写。
	guest := env.guestToken(t)
	if list := env.do(t, http.MethodGet, "/api/live2d/models", guest, nil); list.status != http.StatusOK {
		t.Fatalf("游客列表应成功: %d %s", list.status, list.raw)
	} else if manage, _ := list.body["canManage"].(bool); manage {
		t.Errorf("游客不应拿到 canManage=true")
	}
	if resp := uploadLive2D(t, env, guest, makeLive2DZip(t, nil)); resp.status != http.StatusForbidden {
		t.Fatalf("游客上传应 403，得到 %d: %s", resp.status, resp.raw)
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
			env, token, _ := setupLive2DLibrary(t)
			resp := uploadLive2D(t, env, token, makeLive2DZip(t, tc.extra))
			if resp.status != http.StatusBadRequest {
				t.Fatalf("应 400，得到 %d: %s", resp.status, resp.raw)
			}
			if msg := resp.message(); !strings.Contains(msg, tc.want) {
				t.Fatalf("错误信息应包含 %q，得到 %q", tc.want, msg)
			}
			// 被拒绝的包不能在磁盘上留下任何东西（临时目录也要清掉）。
			entries, _ := os.ReadDir(filepath.Join(env.uploads, "live2d"))
			for _, entry := range entries {
				t.Errorf("拒绝后不应残留目录: %s", entry.Name())
			}
		})
	}
}

func TestLive2DUploadRejectsMissingReference(t *testing.T) {
	env, token, _ := setupLive2DLibrary(t)
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
	env, token, _ := setupLive2DLibrary(t)
	up := uploadLive2D(t, env, token, makeLive2DZip(t, nil))
	model, _ := up.body["model"].(map[string]any)
	id, _ := model["id"].(string)
	if id == "" {
		t.Fatalf("上传未返回 id: %s", up.raw)
	}
	path := fmt.Sprintf("/api/live2d/models/%s", id)

	// 别人删不了：模型库是公共的，但删除仍然只限本人或管理员。
	other := env.seedUser(t, "l2d-thief", "pw123456", "user", "active")
	otherToken := env.token(t, other, "user", "l2d-thief")
	if resp := env.do(t, http.MethodDelete, path, otherToken, nil); resp.status != http.StatusForbidden {
		t.Fatalf("删别人的模型应 403，得到 %d", resp.status)
	}
	if _, err := os.Stat(filepath.Join(env.uploads, "live2d", id)); err != nil {
		t.Fatalf("被拒绝的删除不应动文件: %v", err)
	}

	if resp := env.do(t, http.MethodDelete, path, token, nil); resp.status != http.StatusOK {
		t.Fatalf("本人删除应 200，得到 %d: %s", resp.status, resp.raw)
	}
	if _, err := os.Stat(filepath.Join(env.uploads, "live2d", id)); !os.IsNotExist(err) {
		t.Errorf("删除后目录应消失，stat err=%v", err)
	}
	if list := env.do(t, http.MethodGet, "/api/live2d/models", token, nil); list.status == http.StatusOK {
		if models, _ := list.body["models"].([]any); len(models) != 0 {
			t.Errorf("删除后列表应为空，得到 %d 条", len(models))
		}
	}
}

// 管理员可以收拾任何一条：库里出了问题（模型损坏/传错）得有人能删。
func TestLive2DDeleteByRoot(t *testing.T) {
	env, token, _ := setupLive2DLibrary(t)
	up := uploadLive2D(t, env, token, makeLive2DZip(t, nil))
	model, _ := up.body["model"].(map[string]any)
	id, _ := model["id"].(string)

	root := env.seedUser(t, "l2d-root", "pw123456", "root", "active")
	rootToken := env.token(t, root, "root", "l2d-root")
	if resp := env.do(t, http.MethodDelete, fmt.Sprintf("/api/live2d/models/%s", id), rootToken, nil); resp.status != http.StatusOK {
		t.Fatalf("root 删除应 200，得到 %d: %s", resp.status, resp.raw)
	}
}

// TestLive2DModelIDRejectsTraversal 守住 id 正则：删除接口如果放过 `..%2F`，
// 一条请求就能删掉整个 live2d 根目录。
func TestLive2DModelIDRejectsTraversal(t *testing.T) {
	env, token, _ := setupLive2DLibrary(t)
	resp := env.do(t, http.MethodDelete, "/api/live2d/models/..%2Fother", token, nil)
	if resp.status == http.StatusOK {
		t.Fatalf("非法 id 不应成功: %s", resp.raw)
	}
}
