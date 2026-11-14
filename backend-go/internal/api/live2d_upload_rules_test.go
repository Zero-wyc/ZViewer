package api_test

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// makeLive2DZipWithEntry 用指定的 model3.json 内容造包，用于验证自动补登记。
func makeLive2DZipWithEntry(t *testing.T, entry string, extra map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	files := map[string]string{
		"pack/deep.model3.json":         entry,
		"pack/deep.moc3":                "MOC3",
		"pack/deep.2048/texture_00.png": "\x89PNG\r\n\x1a\n",
	}
	for name, data := range extra {
		files[name] = data
	}
	for name, data := range files {
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

func readEntryJSON(t *testing.T, dir string) (map[string]any, map[string]any) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(dir, "model.model3.json"))
	if err != nil {
		t.Fatalf("读取入口失败: %v", err)
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("入口不是合法 JSON: %v", err)
	}
	refs, _ := doc["FileReferences"].(map[string]any)
	if refs == nil {
		t.Fatalf("入口缺少 FileReferences: %s", string(raw))
	}
	return doc, refs
}

// TestLive2DUploadSkipsHostMetadata 守住 VTube Studio 导出目录的上传：
// .vbridger / .vtube.json / items_pinned_to_model.json 这些宿主配置不属于
// Cubism 模型，过去会让整包被「不支持的文件类型」退回。
func TestLive2DUploadSkipsHostMetadata(t *testing.T) {
	env, token, _ := setupLive2DLibrary(t)
	resp := uploadLive2D(t, env, token, makeLive2DZip(t, map[string]string{
		"pack/AdvancedARKitSettings.vbridger": "\x00\x01binary",
		"pack/hiyori.vtube.json":              `{"Hotkeys":[]}`,
		"pack/items_pinned_to_model.json":     `[]`,
	}))
	if resp.status != http.StatusOK {
		t.Fatalf("带宿主配置的模型包应能上传，得到 %d: %s", resp.status, resp.raw)
	}
	if msg := resp.message(); !strings.Contains(msg, "忽略") {
		t.Fatalf("消息应说明忽略了几个文件，得到 %q", msg)
	}

	model, _ := resp.body["model"].(map[string]any)
	id, _ := model["id"].(string)
	dir := filepath.Join(env.uploads, "live2d", id)
	if _, err := os.Stat(filepath.Join(dir, "AdvancedARKitSettings.vbridger")); err == nil {
		t.Error("非模型文件不应落盘")
	}
	// .json 属于白名单，照常落地（.vtube.json 只是数据，留着无害）
	if _, err := os.Stat(filepath.Join(dir, "hiyori.vtube.json")); err != nil {
		t.Errorf(".json 文件应保留: %v", err)
	}
}

// TestLive2DUploadRegistersExpressionsAndIdle 覆盖「VTS 导出不写登记」这一常见形状：
// 表情躺在 Exp3/、动画躺在 Animation/，model3.json 只列 Moc/Textures。
// 不补登记的话，模型在任何 Cubism 载入器里都是「能显示但没有表情、不会待机」。
func TestLive2DUploadRegistersExpressionsAndIdle(t *testing.T) {
	env, token, _ := setupLive2DLibrary(t)
	body := makeLive2DZipWithEntry(t,
		`{"Version":3,"FileReferences":{"Moc":"deep.moc3","Textures":["deep.2048/texture_00.png"]}}`,
		map[string]string{
			"pack/Exp3/兔牙.exp3.json":           `{"Type":"Live2D Expression","Parameters":[]}`,
			"pack/Exp3/脸红.exp3.json":           `{"Type":"Live2D Expression","Parameters":[]}`,
			"pack/Animation/IDLE.motion3.json": `{"Version":3}`,
			"pack/Animation/举手.motion3.json":   `{"Version":3}`,
		})
	resp := uploadLive2D(t, env, token, body)
	if resp.status != http.StatusOK {
		t.Fatalf("上传应成功，得到 %d: %s", resp.status, resp.raw)
	}
	model, _ := resp.body["model"].(map[string]any)
	id, _ := model["id"].(string)
	dir := filepath.Join(env.uploads, "live2d", id)

	_, refs := readEntryJSON(t, dir)

	exprs, _ := refs["Expressions"].([]any)
	if len(exprs) != 2 {
		t.Fatalf("应补登记 2 个表情，得到 %v", refs["Expressions"])
	}
	names := map[string]string{}
	for _, item := range exprs {
		entry, _ := item.(map[string]any)
		name, _ := entry["Name"].(string)
		file, _ := entry["File"].(string)
		names[name] = file
		if _, err := os.Stat(filepath.Join(dir, filepath.FromSlash(file))); err != nil {
			t.Errorf("表情文件应存在: %s (%v)", file, err)
		}
	}
	if names["兔牙"] != "Exp3/兔牙.exp3.json" {
		t.Errorf("表情名与路径不对: %v", names)
	}

	motions, _ := refs["Motions"].(map[string]any)
	idle, _ := motions["Idle"].([]any)
	if len(idle) != 1 {
		t.Fatalf("只有 IDLE.motion3.json 该进 Idle 组，得到 %v", motions)
	}
	first, _ := idle[0].(map[string]any)
	if file, _ := first["File"].(string); file != "Animation/IDLE.motion3.json" {
		t.Errorf("Idle 组路径不对: %v", first)
	}
}

// TestLive2DUploadKeepsExplicitRegistrations 守住「已有登记一个字节都不改」：
// 作者显式写了表情/动作，服务端不该再往里塞。
func TestLive2DUploadKeepsExplicitRegistrations(t *testing.T) {
	env, token, _ := setupLive2DLibrary(t)
	entry := `{"Version":3,"FileReferences":{"Moc":"deep.moc3",` +
		`"Textures":["deep.2048/texture_00.png"],` +
		`"Expressions":[{"Name":"官方命名","File":"Exp3/兔牙.exp3.json"}],` +
		`"Motions":{"TapBody":[{"File":"Animation/举手.motion3.json"}]}}}`
	body := makeLive2DZipWithEntry(t, entry, map[string]string{
		"pack/Exp3/兔牙.exp3.json":           `{"Parameters":[]}`,
		"pack/Exp3/脸红.exp3.json":           `{"Parameters":[]}`,
		"pack/Animation/IDLE.motion3.json": `{"Version":3}`,
		"pack/Animation/举手.motion3.json":   `{"Version":3}`,
	})
	resp := uploadLive2D(t, env, token, body)
	if resp.status != http.StatusOK {
		t.Fatalf("上传应成功，得到 %d: %s", resp.status, resp.raw)
	}
	model, _ := resp.body["model"].(map[string]any)
	id, _ := model["id"].(string)
	dir := filepath.Join(env.uploads, "live2d", id)
	_, refs := readEntryJSON(t, dir)

	exprs, _ := refs["Expressions"].([]any)
	if len(exprs) != 1 {
		t.Fatalf("已有登记不应被追加，得到 %v", refs["Expressions"])
	}
	first, _ := exprs[0].(map[string]any)
	if name, _ := first["Name"].(string); name != "官方命名" {
		t.Errorf("已有表情名被改写: %v", first)
	}
	motions, _ := refs["Motions"].(map[string]any)
	if _, ok := motions["Idle"]; ok {
		t.Error("已有 Motions 时不应再补 Idle 组")
	}
}
