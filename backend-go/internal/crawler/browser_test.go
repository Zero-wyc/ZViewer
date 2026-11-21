package crawler

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestFindBrowserBinary(t *testing.T) {
	binary, err := FindBrowserBinary("")
	if err != nil {
		t.Skipf("本机没有 Chromium 内核浏览器: %v", err)
	}
	if !strings.Contains(strings.ToLower(binary), "msedge") &&
		!strings.Contains(strings.ToLower(binary), "chrome") &&
		!strings.Contains(strings.ToLower(binary), "chromium") {
		t.Errorf("unexpected binary: %s", binary)
	}
	// 显式配置了不存在的路径要报错，而不是悄悄回落。
	if _, err := FindBrowserBinary("/definitely/not/here/msedge"); err == nil {
		t.Error("explicit missing binary should fail")
	}
}

func TestBrowserSniff(t *testing.T) {
	if testing.Short() {
		t.Skip("跳过需要真实浏览器的用例")
	}
	if _, err := FindBrowserBinary(""); err != nil {
		t.Skipf("本机没有 Chromium 内核浏览器: %v", err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/page", func(w http.ResponseWriter, r *http.Request) {
		// 页面把媒体地址写在 video 里，CollectMedia 应当捞到。
		_, _ = w.Write([]byte(`<html><head><title>播放页</title></head><body>
			<video src="/media/live.m3u8"></video>
			<script>fetch('/media/live.m3u8').catch(() => {});</script>
		</body></html>`))
	})
	mux.HandleFunc("/media/live.m3u8", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
		w.WriteHeader(http.StatusPartialContent)
		_, _ = w.Write([]byte("#EXTM3U\n"))
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	browser := NewBrowser(BrowserOptions{Headless: true, ProfileDir: t.TempDir(), Port: 9455})
	defer browser.Close()
	if !browser.Available() {
		t.Fatal("browser should be available")
	}
	result, ok := browser.Sniff(server.URL+"/page", map[string]string{"Referer": server.URL + "/"}, nil)
	if !ok {
		t.Fatal("sniff failed: no media collected")
	}
	if result["source"] != "browser" {
		t.Errorf("source = %v", result["source"])
	}
	mediaURL, _ := result["url"].(string)
	if !strings.Contains(mediaURL, "live.m3u8") {
		t.Errorf("url = %v", result["url"])
	}
	if result["title"] != "播放页" {
		t.Errorf("title = %v", result["title"])
	}
}
