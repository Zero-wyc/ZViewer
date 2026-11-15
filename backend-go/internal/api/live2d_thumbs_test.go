package api

import (
	"archive/zip"
	"bytes"
	"encoding/binary"
	"hash/crc32"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"zviewer/backend/internal/auth"
	"zviewer/backend/internal/config"
)

// writeTestTexture 造一张 512×256 的 PNG，只在 (300,100) 起 100×50 的范围内
// 画实心块，其余全透明。缩略图应当把这个块裁出来（长边 160、比例 2:1）。
func writeTestTexture(t *testing.T, dir string) {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, 512, 256))
	for y := 100; y < 150; y++ {
		for x := 300; x < 400; x++ {
			img.SetNRGBA(x, y, color.NRGBA{R: 200, G: 40, B: 90, A: 255})
		}
	}
	raw := new(bytes.Buffer)
	if err := png.Encode(raw, img); err != nil {
		t.Fatalf("生成测试贴图失败: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "tex.png"), raw.Bytes(), 0o644); err != nil {
		t.Fatalf("写测试贴图失败: %v", err)
	}
}

func writeTestModel3(t *testing.T, dir, texture string) {
	t.Helper()
	body := `{"Version":3,"FileReferences":{"Moc":"a.moc3","Textures":["` + texture + `"]}}`
	if err := os.WriteFile(filepath.Join(dir, live2dEntryFile), []byte(body), 0o644); err != nil {
		t.Fatalf("写入模型入口失败: %v", err)
	}
}

func TestWriteLive2DThumb(t *testing.T) {
	dir := t.TempDir()
	writeTestTexture(t, dir)
	writeTestModel3(t, dir, "tex.png")

	if err := writeLive2DThumb(dir); err != nil {
		t.Fatalf("生成缩略图失败: %v", err)
	}

	f, err := os.Open(filepath.Join(dir, live2dThumbFile))
	if err != nil {
		t.Fatalf("缩略图不存在: %v", err)
	}
	defer f.Close()
	img, err := png.Decode(f)
	if err != nil {
		t.Fatalf("缩略图不是合法 PNG: %v", err)
	}
	// 裁掉透明边之后是 100×50（2:1），长边缩到 160。
	if got := img.Bounds().Dx(); got != 160 {
		t.Errorf("缩略图宽应为 160，得到 %d", got)
	}
	if got := img.Bounds().Dy(); got != 80 {
		t.Errorf("缩略图高应为 80（保持 2:1），得到 %d", got)
	}
	// 中心应保留原来的颜色（缩放不能把整张图变成透明）。
	r, g, b, a := img.At(80, 40).RGBA()
	if a < 0xf000 {
		t.Fatalf("缩略图中心不该是透明的：alpha=%d", a)
	}
	if r < 0x8000 || g > 0x4000 {
		t.Errorf("缩略图中心颜色不对：r=%d g=%d b=%d", r, g, b)
	}
}

// 原包里自带 __thumb.png 时必须放过：那是用户的素材，覆盖掉就可能弄坏模型。
func TestWriteLive2DThumbKeepsExistingFile(t *testing.T) {
	dir := t.TempDir()
	writeTestTexture(t, dir)
	writeTestModel3(t, dir, "tex.png")
	original := []byte("not a png")
	if err := os.WriteFile(filepath.Join(dir, live2dThumbFile), original, 0o644); err != nil {
		t.Fatalf("写入占位文件失败: %v", err)
	}

	if err := writeLive2DThumb(dir); err == nil {
		t.Fatal("已存在同名文件时应跳过而不是覆盖")
	}
	got, err := os.ReadFile(filepath.Join(dir, live2dThumbFile))
	if err != nil {
		t.Fatalf("读取失败: %v", err)
	}
	if !bytes.Equal(got, original) {
		t.Error("原文件被覆盖了")
	}
}

// 超大贴图必须在 DecodeConfig 这一步就被拒绝：这里只放一个只有 IHDR 的
// 截断 PNG，DecodeConfig 能过、Decode 不行。若实现先解码再判尺寸，就会在
// 这里分配几百 MB。
func TestDecodeLive2DTextureRejectsHugeImage(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "big.png"), hugePNGHeader(5000, 5000), 0o644); err != nil {
		t.Fatalf("写入测试文件失败: %v", err)
	}
	if _, err := decodeLive2DTexture(dir, "big.png"); err == nil {
		t.Fatal("超大贴图应被拒绝")
	}
}

// 贴图路径必须限定在模型目录里，否则一个 ../ 就能把服务端任意文件当图片解。
func TestDecodeLive2DTextureRejectsEscape(t *testing.T) {
	dir := t.TempDir()
	for _, rel := range []string{"../secret.png", "/etc/passwd", "a/../../x.png"} {
		if _, err := decodeLive2DTexture(dir, rel); err == nil {
			t.Errorf("越界路径应被拒绝：%s", rel)
		}
	}
}

func TestPickLive2DTexture(t *testing.T) {
	dir := t.TempDir()
	writeTestModel3(t, dir, "tex.png")
	if rel, ok := pickLive2DTexture(filepath.Join(dir, live2dEntryFile)); !ok || rel != "tex.png" {
		t.Fatalf("应取到第一张贴图，得到 %q ok=%v", rel, ok)
	}
	// 没有贴图的模型（纯 MOC3）不该生成缩略图，但不能报错炸掉上传。
	plain := t.TempDir()
	if err := os.WriteFile(filepath.Join(plain, live2dEntryFile), []byte(`{"Version":3}`), 0o644); err != nil {
		t.Fatalf("写入失败: %v", err)
	}
	if _, ok := pickLive2DTexture(filepath.Join(plain, live2dEntryFile)); ok {
		t.Error("没有贴图时不该取到路径")
	}
}

// 老模型（本次改动之前入库的）靠启动回填补缩略图；有图的不能重复生成。
func TestWarmLive2DThumbs(t *testing.T) {
	dir := t.TempDir()
	srv := &Server{Deps: Deps{Cfg: &config.Config{UploadsDir: dir}}}
	root := srv.live2dRoot()

	withTex := filepath.Join(root, "hiyori-aaaaaa")
	plain := filepath.Join(root, "broken-bbbbbb")
	for _, d := range []string{withTex, plain} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatalf("建目录失败: %v", err)
		}
	}
	writeTestTexture(t, withTex)
	writeTestModel3(t, withTex, "tex.png")
	// 入口在、贴图不在：回填要跳过它而不是报错中断整轮。
	writeTestModel3(t, plain, "missing.png")

	srv.warmLive2DThumbs()
	if !srv.live2dHasThumb("hiyori-aaaaaa") {
		t.Fatal("有贴图的模型应补出缩略图")
	}
	if srv.live2dHasThumb("broken-bbbbbb") {
		t.Fatal("没有贴图的模型不该凭空多出缩略图")
	}
}

// 缩略图必须能通过静态下发拿到——文件名以 "_" 开头是刻意的：
// 静态下发会拒绝任何 "." 开头的路径段（元数据正是靠这条不公开）。
func TestLive2DThumbIsServed(t *testing.T) {
	dir := t.TempDir()
	srv := &Server{Deps: Deps{Cfg: &config.Config{UploadsDir: dir}}}
	modelDir := filepath.Join(srv.live2dRoot(), "hiyori-aaaaaa")
	if err := os.MkdirAll(modelDir, 0o755); err != nil {
		t.Fatalf("建目录失败: %v", err)
	}
	writeTestTexture(t, modelDir)
	writeTestModel3(t, modelDir, "tex.png")
	if err := writeLive2DThumb(modelDir); err != nil {
		t.Fatalf("生成缩略图失败: %v", err)
	}

	handler := srv.live2dModelsHandler()
	req, _ := http.NewRequest(http.MethodGet, "/uploads/live2d/hiyori-aaaaaa/"+live2dThumbFile, nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("缩略图应可访问，得到 %d", rec.Code)
	}
	if got := rec.Header().Get("Content-Type"); got != "image/png" {
		t.Errorf("Content-Type 应为 image/png，得到 %q", got)
	}
}

// hugePNGHeader 造一个只有 IHDR 的 PNG（无 IDAT）。DecodeConfig 只需要
// IHDR，所以拿它测「解码前先按尺寸拒绝」最省内存。
func hugePNGHeader(width, height uint32) []byte {
	var buf bytes.Buffer
	buf.Write([]byte("\x89PNG\r\n\x1a\n"))
	data := make([]byte, 13)
	binary.BigEndian.PutUint32(data[0:4], width)
	binary.BigEndian.PutUint32(data[4:8], height)
	data[8] = 8 // bit depth
	data[9] = 6 // color type: RGBA
	// compression/filter/interlace 全为 0，data[10..12] 保持零值即可。
	chunk := append([]byte("IHDR"), data...)
	var length [4]byte
	binary.BigEndian.PutUint32(length[:], uint32(len(data)))
	buf.Write(length[:])
	buf.Write(chunk)
	var sum [4]byte
	binary.BigEndian.PutUint32(sum[:], crc32.ChecksumIEEE(chunk))
	buf.Write(sum[:])
	return buf.Bytes()
}

// 端到端：上传一个带真实贴图的包，列表里就该看到 hasThumb。
// 走 installLive2DZip 而不是只调 writeLive2DThumb——要确认缩略图生成插在
// 「临时目录改名前」，否则成品目录里根本不会有它。
func TestInstallLive2DZipWritesThumb(t *testing.T) {
	dir := t.TempDir()
	srv := &Server{Deps: Deps{Cfg: &config.Config{UploadsDir: dir}}}

	tex := image.NewNRGBA(image.Rect(0, 0, 64, 64))
	for y := 0; y < 64; y++ {
		for x := 0; x < 64; x++ {
			tex.SetNRGBA(x, y, color.NRGBA{R: 30, G: 90, B: 160, A: 255})
		}
	}
	var texRaw bytes.Buffer
	if err := png.Encode(&texRaw, tex); err != nil {
		t.Fatalf("生成贴图失败: %v", err)
	}

	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	files := map[string][]byte{
		"pack/demo.model3.json": []byte(`{"Version":3,"FileReferences":{"Moc":"demo.moc3","Textures":["tex.png"]}}`),
		"pack/demo.moc3":        []byte("MOC3"),
		"pack/tex.png":          texRaw.Bytes(),
	}
	for name, data := range files {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatalf("建 zip 条目失败: %v", err)
		}
		if _, err := w.Write(data); err != nil {
			t.Fatalf("写 zip 条目失败: %v", err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("关闭 zip 失败: %v", err)
	}

	zr, err := zip.NewReader(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if err != nil {
		t.Fatalf("读取 zip 失败: %v", err)
	}
	meta, _, problem, err := srv.installLive2DZip(&auth.Claims{UserID: 7}, zr.File, "demo.zip")
	if err != nil || problem != "" {
		t.Fatalf("入库失败: problem=%q err=%v", problem, err)
	}
	if !srv.live2dHasThumb(meta.ID) {
		t.Fatal("成品目录里应有缩略图（而不是留在临时目录里被删掉）")
	}
	if !srv.live2dModelDTO(meta, nil).HasThumb {
		t.Error("列表 DTO 应带 hasThumb=true")
	}
}
