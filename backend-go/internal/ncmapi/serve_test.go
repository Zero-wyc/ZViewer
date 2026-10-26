package ncmapi

import (
	"io"
	"net/http"
	"strings"
	"testing"
)

// TestHandlerTransportKeepsHTTPContract 校验进程内传输仍保留 internal/ncm
// 依赖的那几项 HTTP 语义：状态码、原始 Set-Cookie、响应体、请求体送达。
func TestHandlerTransportKeepsHTTPContract(t *testing.T) {
	var gotBody string
	var gotCookie string
	transport := &handlerTransport{handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		gotBody = string(raw)
		gotCookie = r.Header.Get("Cookie")
		w.Header().Add("Set-Cookie", "MUSIC_U=abc; Path=/; HttpOnly")
		w.Header().Add("Set-Cookie", "__csrf=xyz")
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusTeapot)
		_, _ = w.Write([]byte(`{"code":418}`))
	})}

	req, err := http.NewRequest(http.MethodPost, LoopbackBase+"/song/url/v1?id=1&level=lossless",
		strings.NewReader(`{"ids":"1"}`))
	if err != nil {
		t.Fatalf("构造请求失败: %v", err)
	}
	req.Header.Set("Cookie", "MUSIC_U=stored")
	resp, err := transport.RoundTrip(req)
	if err != nil {
		t.Fatalf("RoundTrip 失败: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusTeapot {
		t.Errorf("StatusCode = %d，期望 418", resp.StatusCode)
	}
	cookies := resp.Header.Values("Set-Cookie")
	if len(cookies) != 2 || !strings.Contains(cookies[0], "MUSIC_U=abc") {
		t.Errorf("Set-Cookie 未原样保留: %v", cookies)
	}
	raw, _ := io.ReadAll(resp.Body)
	if string(raw) != `{"code":418}` {
		t.Errorf("响应体 = %q", raw)
	}
	if gotBody != `{"ids":"1"}` {
		t.Errorf("请求体未送达，handler 收到 %q", gotBody)
	}
	if gotCookie != "MUSIC_U=stored" {
		t.Errorf("Cookie 头未送达，handler 收到 %q", gotCookie)
	}
}

// TestHandlerTransportDefaultsTo200 校验 handler 只 Write 不 WriteHeader 时
// 状态码是 200（真实 socket 的行为，少了这条会变成 0）。
func TestHandlerTransportDefaultsTo200(t *testing.T) {
	transport := &handlerTransport{handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("null"))
	})}
	req, _ := http.NewRequest(http.MethodGet, LoopbackBase+"/", nil)
	resp, err := transport.RoundTrip(req)
	if err != nil {
		t.Fatalf("RoundTrip 失败: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("StatusCode = %d，期望 200", resp.StatusCode)
	}
}

// TestStartInProcessLifecycle 校验哨兵地址与传输层的挂载/卸载。
func TestStartInProcessLifecycle(t *testing.T) {
	if InProcessTransport() != nil {
		t.Fatal("未启动时不该有进程内传输")
	}
	base, stop := StartInProcess()
	if base != LoopbackBase {
		t.Errorf("base = %q，期望 %q", base, LoopbackBase)
	}
	if InProcessTransport() == nil {
		t.Fatal("启动后应能拿到进程内传输")
	}
	stop()
	if InProcessTransport() != nil {
		t.Fatal("停止后进程内传输应被卸载")
	}
}
