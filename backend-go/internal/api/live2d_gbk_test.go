package api

import (
	"archive/zip"
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"zviewer/backend/internal/config"
)

// 中文压缩工具（好压 / 快压 / 部分 WinRAR 设置）会把条目名按 GBK 写进 zip，
// 并且**不置** UTF-8 标志位。Go 的 archive/zip 于是原样返回那串 GBK 字节，
// 落地时 Windows 把非法 UTF-8 换成 U+FFFD，磁盘上就成了 `������.moc3`；
// 而 model3.json 里的引用是正常 UTF-8 的「大肥鱼.moc3」，引用校验 stat 不到，
// 用户看到「model3.json 引用的文件不存在：大肥鱼.moc3」——包里明明有这个文件。
//
// 这个用例守的就是这条链路：GBK 条目名 → 正确 UTF-8 落地 → 引用校验通过。
func TestLive2DGBKEntryNames(t *testing.T) {
	// 「大肥鱼」的 GBK 字节。故意写成转义，避免源码文件编码干扰。
	const gbkStem = "\xb4\xf3\xb7\xca\xd3\xe3"

	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	write := func(name, data string) {
		t.Helper()
		// NonUTF8 让 writer 清掉 0x800 标志位，原样写入 GBK 字节，
		// 这样才能复现用户的真实压缩包（Go 默认会按内容自动置位）。
		h := &zip.FileHeader{Name: name, Method: zip.Deflate, NonUTF8: true}
		w, err := zw.CreateHeader(h)
		if err != nil {
			t.Fatalf("创建 zip 条目失败: %v", err)
		}
		if _, err := w.Write([]byte(data)); err != nil {
			t.Fatalf("写入 zip 条目失败: %v", err)
		}
	}
	entry := `{"Version":3,"FileReferences":{"Moc":"大肥鱼.moc3",` +
		`"Textures":["大肥鱼.2048/texture_00.png"]}}`
	write(gbkStem+".model3.json", entry)
	write(gbkStem+".moc3", "MOC3")
	write(gbkStem+".2048/texture_00.png", "\x89PNG\r\n\x1a\n")
	if err := zw.Close(); err != nil {
		t.Fatalf("关闭 zip 失败: %v", err)
	}

	zr, err := zip.NewReader(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if err != nil {
		t.Fatalf("读取 zip 失败: %v", err)
	}

	plan, problem := planLive2DExtract(zr.File)
	if problem != "" {
		t.Fatalf("规划失败: %s", problem)
	}
	if plan.entryRel != "大肥鱼.model3.json" {
		t.Fatalf("入口名未解码成 UTF-8: %q", plan.entryRel)
	}

	dir := t.TempDir()
	if _, problem := extractLive2DZip(zr.File, plan, dir); problem != "" {
		t.Fatalf("解压失败: %s", problem)
	}
	// 落地的必须是正常中文名，而不是一串替换字符。
	for _, name := range []string{"大肥鱼.moc3", "大肥鱼.2048", "model.model3.json"} {
		if _, err := os.Stat(filepath.Join(dir, name)); err != nil {
			t.Fatalf("落地文件缺失 %q: %v", name, err)
		}
	}
	if problem := validateLive2DReferences(filepath.Join(dir, live2dEntryFile), dir); problem != "" {
		t.Fatalf("引用校验失败: %s", problem)
	}
}

// model3.json 被记事本存成 ANSI（GBK）时，解析前应先转码，
// 而不是直接报「不是合法的 JSON」。
func TestLive2DGBKEntryContent(t *testing.T) {
	// 「大肥鱼.moc3」的 GBK 字节，模拟记事本另存为 ANSI 的结果。
	gbkJSON := []byte(`{"Version":3,"FileReferences":{"Moc":"` +
		"\xb4\xf3\xb7\xca\xd3\xe3" + `.moc3"}}`)
	dir := t.TempDir()
	entryPath := filepath.Join(dir, live2dEntryFile)
	if err := os.WriteFile(entryPath, gbkJSON, 0o644); err != nil {
		t.Fatalf("写入口失败: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "大肥鱼.moc3"), []byte("MOC3"), 0o644); err != nil {
		t.Fatalf("写 moc3 失败: %v", err)
	}
	if problem := validateLive2DReferences(entryPath, dir); problem != "" {
		t.Fatalf("GBK 编码的入口被误判: %s", problem)
	}
}

// 解码后的中文文件名必须能被静态下发取到：前端拼的是
// /uploads/live2d/<id>/大肥鱼.4096/texture_00.png，若这里 404，
// 模型换成了「找不到 moc」之外的另一种失败（贴图缺失）。
func TestLive2DServesChineseAssetPath(t *testing.T) {
	dir := t.TempDir()
	modelDir := filepath.Join(dir, "live2d", "m-1")
	texDir := filepath.Join(modelDir, "大肥鱼.4096")
	if err := os.MkdirAll(texDir, 0o755); err != nil {
		t.Fatalf("建目录失败: %v", err)
	}
	if err := os.WriteFile(filepath.Join(texDir, "texture_00.png"), []byte("png-bytes"), 0o644); err != nil {
		t.Fatalf("写贴图失败: %v", err)
	}

	srv := &Server{Deps: Deps{Cfg: &config.Config{UploadsDir: dir}}}
	h := srv.live2dModelsHandler()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/uploads/live2d/m-1/大肥鱼.4096/texture_00.png", nil)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("中文路径静态下发应 200，得到 %d", rec.Code)
	}
	if body := rec.Body.String(); body != "png-bytes" {
		t.Fatalf("下发内容不对: %q", body)
	}
}
