package api

import (
	"bytes"
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"zviewer/backend/internal/config"
)

// 预压缩副本的下发逻辑：只对白名单后缀 + 客户端支持 br 生效，
// 其余情况必须原样交回 FileServer（回退，而不是 404）。
func TestServePrecompressed(t *testing.T) {
	dir := t.TempDir()
	const raw = "raw-bytes-of-the-wasm-module"

	// 造一个简单的 gzip 流冒充 .br：测试只验证「是否原样下发副本」，
	// 不验证 brotli 本身的正确性（那是 zlib / 预压缩脚本的事）。
	var br bytes.Buffer
	zw := gzip.NewWriter(&br)
	if _, err := zw.Write([]byte(raw)); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}

	wasmPath := filepath.Join(dir, "vision_wasm_internal.wasm")
	if err := os.WriteFile(wasmPath, []byte(raw), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(wasmPath+".br", br.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}

	t.Run("br 副本命中", func(t *testing.T) {
		r := httptest.NewRequest(http.MethodGet, "/live2d/face/wasm/vision_wasm_internal.wasm", nil)
		r.Header.Set("Accept-Encoding", "gzip, deflate, br")
		w := httptest.NewRecorder()

		if !servePrecompressed(w, r, wasmPath, "/live2d/face/wasm/vision_wasm_internal.wasm") {
			t.Fatal("应当命中预压缩副本")
		}
		if got := w.Header().Get("Content-Encoding"); got != "br" {
			t.Errorf("Content-Encoding = %q, 期望 br", got)
		}
		if got := w.Header().Get("Content-Type"); got != "application/wasm" {
			t.Errorf("Content-Type = %q, 期望 application/wasm", got)
		}
		if got := w.Header().Get("Vary"); got != "Accept-Encoding" {
			t.Errorf("Vary = %q, 期望 Accept-Encoding", got)
		}
		// 带 Content-Encoding 时 ServeContent 不会自己写长度，必须由我们补上，
		// 否则退化成 chunked（CDN 缓存与下载进度都依赖确定长度）。
		if got := w.Header().Get("Content-Length"); got != strconv.Itoa(br.Len()) {
			t.Errorf("Content-Length = %q, 期望 %d", got, br.Len())
		}
		if w.Code != http.StatusOK {
			t.Errorf("status = %d, 期望 200", w.Code)
		}
		body, _ := io.ReadAll(w.Body)
		if !bytes.Equal(body, br.Bytes()) {
			t.Errorf("下发的应是压缩副本本身（%d 字节），实际 %d 字节", br.Len(), len(body))
		}
	})

	t.Run("不支持 br 时回退", func(t *testing.T) {
		r := httptest.NewRequest(http.MethodGet, "/x.wasm", nil)
		r.Header.Set("Accept-Encoding", "gzip")
		w := httptest.NewRecorder()

		if servePrecompressed(w, r, wasmPath, "/x.wasm") {
			t.Fatal("不支持 br 时不应命中")
		}
		if got := w.Header().Get("Content-Encoding"); got != "" {
			t.Errorf("回退时不应设置 Content-Encoding，实际 %q", got)
		}
	})

	t.Run("后缀不在白名单", func(t *testing.T) {
		jsPath := filepath.Join(dir, "app.js")
		if err := os.WriteFile(jsPath, []byte(raw), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(jsPath+".br", br.Bytes(), 0o644); err != nil {
			t.Fatal(err)
		}
		r := httptest.NewRequest(http.MethodGet, "/assets/app.js", nil)
		r.Header.Set("Accept-Encoding", "br")
		w := httptest.NewRecorder()

		if servePrecompressed(w, r, jsPath, "/assets/app.js") {
			t.Fatal(".js 不在白名单，不应命中")
		}
	})

	t.Run("缺少 .br 时回退", func(t *testing.T) {
		onlyPath := filepath.Join(dir, "model.task")
		if err := os.WriteFile(onlyPath, []byte(raw), 0o644); err != nil {
			t.Fatal(err)
		}
		r := httptest.NewRequest(http.MethodGet, "/live2d/face/model.task", nil)
		r.Header.Set("Accept-Encoding", "br")
		w := httptest.NewRecorder()

		if servePrecompressed(w, r, onlyPath, "/live2d/face/model.task") {
			t.Fatal("没有 .br 副本时不应命中")
		}
	})

	t.Run("条件请求返回 304", func(t *testing.T) {
		info, err := os.Stat(wasmPath + ".br")
		if err != nil {
			t.Fatal(err)
		}
		r := httptest.NewRequest(http.MethodGet, "/x.wasm", nil)
		r.Header.Set("Accept-Encoding", "br")
		r.Header.Set("If-Modified-Since", info.ModTime().UTC().Format(http.TimeFormat))
		w := httptest.NewRecorder()

		servePrecompressed(w, r, wasmPath, "/x.wasm")
		// ServeContent 对未修改的表示回 304，重复访问不该再传 2MB
		if w.Code != http.StatusNotModified {
			t.Errorf("status = %d, 期望 304", w.Code)
		}
	})
}

func TestAcceptsBrotli(t *testing.T) {
	cases := map[string]bool{
		"":                      false,
		"gzip, deflate":         false,
		"gzip, deflate, br":     true,
		"br":                    true,
		"BR":                    true,
		"br;q=0.8, gzip;q=1.0":  true,
		"gzip;q=1.0,br ; q=0.5": true,
		"gzip, xbr":             false,
	}
	for header, want := range cases {
		if got := acceptsBrotli(header); got != want {
			t.Errorf("acceptsBrotli(%q) = %v, 期望 %v", header, got, want)
		}
	}
}

// spaHandler 的端到端行为：/live2d/face/ 下的 wasm 在客户端支持 br 时
// 必须走预压缩副本，且 Cache-Control / Content-Type 不被覆盖掉。
func TestSPAHandlerServesPrecompressed(t *testing.T) {
	dir := t.TempDir()
	wasmDir := filepath.Join(dir, "live2d", "face", "wasm")
	if err := os.MkdirAll(wasmDir, 0o755); err != nil {
		t.Fatal(err)
	}
	wasmFile := filepath.Join(wasmDir, "vision_wasm_internal.wasm")
	if err := os.WriteFile(wasmFile, []byte("raw-wasm"), 0o644); err != nil {
		t.Fatal(err)
	}
	// 压缩副本刻意写成一串可识别但非法的 brotli 字节：本用例只关心
	// 「下发了哪个文件、带了什么头」，不做真实解码。
	compressed := []byte("brotli-placeholder")
	if err := os.WriteFile(wasmFile+".br", compressed, 0o644); err != nil {
		t.Fatal(err)
	}

	s := &Server{Deps: Deps{Cfg: &config.Config{FrontendDist: dir}}}
	h := s.spaHandler()

	r := httptest.NewRequest(http.MethodGet, "/live2d/face/wasm/vision_wasm_internal.wasm", nil)
	r.Header.Set("Accept-Encoding", "br")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, 期望 200", w.Code)
	}
	if got := w.Header().Get("Content-Encoding"); got != "br" {
		t.Errorf("Content-Encoding = %q, 期望 br", got)
	}
	if got := w.Header().Get("Content-Type"); got != "application/wasm" {
		t.Errorf("Content-Type = %q, 期望 application/wasm", got)
	}
	if got := w.Header().Get("Cache-Control"); got != "public, max-age=86400" {
		t.Errorf("Cache-Control = %q，预压缩分支不应丢掉原有缓存策略", got)
	}
	if body := w.Body.Bytes(); !bytes.Equal(body, compressed) {
		t.Errorf("body = %q, 期望压缩副本", body)
	}

	// 不带 Accept-Encoding 的客户端必须拿到原始字节
	r2 := httptest.NewRequest(http.MethodGet, "/live2d/face/wasm/vision_wasm_internal.wasm", nil)
	w2 := httptest.NewRecorder()
	h.ServeHTTP(w2, r2)
	if w2.Code != http.StatusOK {
		t.Fatalf("status = %d, 期望 200", w2.Code)
	}
	if got := w2.Header().Get("Content-Encoding"); got != "" {
		t.Errorf("Content-Encoding = %q, 未协商 br 时不应设置", got)
	}
	if body := w2.Body.Bytes(); !bytes.Equal(body, []byte("raw-wasm")) {
		t.Errorf("body = %q, 期望原始字节", body)
	}
}
