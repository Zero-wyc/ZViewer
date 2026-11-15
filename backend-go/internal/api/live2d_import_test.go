package api

import (
	"archive/zip"
	"bytes"
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"zviewer/backend/internal/auth"
	"zviewer/backend/internal/config"
)

// ==================== 目标地址校验 ====================

func TestLive2DImportTargetRejects(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want string
	}{
		{"空", "   ", "请填写"},
		{"协议不支持", "ftp://example.com/a.zip", "只支持 http / https"},
		{"file 协议", "file:///C:/a.zip", "只支持 http / https"},
		{"非 URL", "javascript:alert(1)", "只支持 http / https"},
		{"缺主机", "http:///a.zip", "链接格式不正确"},
		{"带账号密码", "http://u:p@example.com/a.zip", "不要带账号密码"},
		{"回环 v4", "http://127.0.0.1:9000/a.zip", "不支持内网地址"},
		{"回环 v6", "http://[::1]/a.zip", "不支持内网地址"},
		{"localhost", "http://localhost:8080/a.zip", "不支持内网地址"},
		{"私网 10", "http://10.1.2.3/a.zip", "不支持内网地址"},
		{"私网 192.168", "http://192.168.1.20/a.zip", "不支持内网地址"},
		// 云厂商元数据地址：SSRF 最常见的目标
		{"链路本地", "http://169.254.169.254/latest/meta-data/", "不支持内网地址"},
		{"本机名", "http://box.local/a.zip", "不支持内网地址"},
		{"过长", "https://example.com/" + strings.Repeat("a", 2100), "链接过长"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, problem := live2dImportTarget(tc.raw)
			if got != nil {
				t.Fatalf("应拒绝，却解析出 %v", got)
			}
			if !strings.Contains(problem, tc.want) {
				t.Fatalf("提示应为 %q，得到 %q", tc.want, problem)
			}
		})
	}
}

func TestLive2DImportTargetAccepts(t *testing.T) {
	for _, raw := range []string{
		"https://example.com/packs/Hiyori.zip",
		"http://cdn.example.com:8443/a/b.zip?token=1",
	} {
		if _, problem := live2dImportTarget(raw); problem != "" {
			t.Fatalf("%s 应通过，得到 %q", raw, problem)
		}
	}
}

// 只查主机名挡不住「公网域名解析到 127.0.0.1」，所以真正的闸门在建连那一步。
func TestLive2DImportDialBlocksInternal(t *testing.T) {
	dial := guardLive2DImportDial(&net.Dialer{})
	for _, address := range []string{
		"127.0.0.1:80",
		"[::1]:80",
		"10.1.2.3:80",
		"192.168.1.20:80",
		"169.254.169.254:80",
	} {
		conn, err := dial(context.Background(), "tcp", address)
		if conn != nil {
			conn.Close()
			t.Fatalf("%s 不应被连接", address)
		}
		if err == nil {
			t.Fatalf("%s 应返回错误", address)
		}
	}
}

// ==================== 下载链路 ====================

// importTestZip 造一个最小可用模型包（与 live2d_models_test.go 的结构同源，
// 那个在 api_test 包里拿不到）。
func importTestZip(t *testing.T) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	files := map[string]string{
		"pack/Hiyori.model3.json": `{"Version":3,"FileReferences":{"Moc":"Hiyori.moc3","Textures":["texture_00.png"]}}`,
		"pack/Hiyori.moc3":        "MOC3",
		"pack/texture_00.png":     "\x89PNG\r\n\x1a\n",
	}
	for name, data := range files {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatalf("建 zip 条目失败: %v", err)
		}
		if _, err := w.Write([]byte(data)); err != nil {
			t.Fatalf("写 zip 条目失败: %v", err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("关闭 zip 失败: %v", err)
	}
	return buf.Bytes()
}

// useTestImportClient 把导入用的 client 换成 httptest 的 client。
//
// 单测服务器必然监听在回环地址上，默认 client 的建连闸门会把它拦下——
// 这里换 client 是**测试专用**的放行，不代表生产允许回环。
func useTestImportClient(t *testing.T, client *http.Client) {
	t.Helper()
	previous := live2dImportClient
	live2dImportClient = client
	t.Cleanup(func() { live2dImportClient = previous })
}

// allowLoopbackHops 让「跳转目标」的判定放行回环地址。
//
// httptest 服务器必然在 127.0.0.1 上，真实判定的第一条就是拒回环；而这里要
// 验证的是「跳转会被跟随、且每一跳都重新过一遍判定」。所以只放宽判定，
// 不放宽建连闸门（client 已被 useTestImportClient 换掉）。
func allowLoopbackHops(t *testing.T) {
	t.Helper()
	previous := live2dImportHopCheck
	live2dImportHopCheck = func(raw string) (*url.URL, string) {
		parsed, err := url.Parse(raw)
		if err != nil {
			return nil, "链接格式不正确"
		}
		if parsed.Scheme != "http" && parsed.Scheme != "https" {
			return nil, "只支持 http / https 链接"
		}
		return parsed, ""
	}
	t.Cleanup(func() { live2dImportHopCheck = previous })
}

func TestLive2DImportDownloadThenInstall(t *testing.T) {
	payload := importTestZip(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/packs/Hiyori.zip" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/zip")
		_, _ = w.Write(payload)
	}))
	defer server.Close()
	useTestImportClient(t, server.Client())

	dir := t.TempDir()
	srv := &Server{Deps: Deps{Cfg: &config.Config{UploadsDir: dir}}}

	target, err := url.Parse(server.URL + "/packs/Hiyori.zip")
	if err != nil {
		t.Fatalf("解析地址失败: %v", err)
	}
	tmp, err := os.CreateTemp(dir, ".import-*")
	if err != nil {
		t.Fatalf("建临时文件失败: %v", err)
	}
	defer tmp.Close()

	label, size, problem, err := downloadLive2DZip(context.Background(), target, tmp)
	if err != nil || problem != "" {
		t.Fatalf("下载应成功，得到 problem=%q err=%v", problem, err)
	}
	if size != int64(len(payload)) {
		t.Fatalf("字节数应为 %d，得到 %d", len(payload), size)
	}
	if label != "Hiyori.zip" {
		t.Fatalf("文件名应取自路径末段，得到 %q", label)
	}

	zr, err := zip.NewReader(tmp, size)
	if err != nil {
		t.Fatalf("下载内容不是 zip: %v", err)
	}

	claims := &auth.Claims{UserID: 7, Role: auth.RoleUser}
	meta, message, problem, err := srv.installLive2DZip(claims, zr.File, label)
	if err != nil || problem != "" {
		t.Fatalf("落库应成功，得到 problem=%q err=%v", problem, err)
	}
	if meta.Label != "Hiyori" {
		t.Fatalf("显示名应去掉 .zip，得到 %q", meta.Label)
	}
	if meta.Owner != 7 {
		t.Fatalf("归属应为发起导入的用户，得到 %d", meta.Owner)
	}
	if _, err := os.Stat(filepath.Join(dir, "live2d", meta.ID, live2dEntryFile)); err != nil {
		t.Fatalf("入口未落地: %v", err)
	}
	_ = message
}

func TestLive2DImportFollowsRedirectToPublic(t *testing.T) {
	payload := importTestZip(t)
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/short" {
			// 相对跳转：Location 由 client 按当前请求地址解出绝对 URL
			http.Redirect(w, r, "/files/real.zip", http.StatusFound)
			return
		}
		_, _ = w.Write(payload)
	}))
	defer server.Close()
	useTestImportClient(t, server.Client())
	allowLoopbackHops(t)

	target, _ := url.Parse(server.URL + "/short")
	var sink bytes.Buffer
	label, size, problem, err := downloadLive2DZip(context.Background(), target, &sink)
	if err != nil || problem != "" {
		t.Fatalf("跳转应被跟随，得到 problem=%q err=%v", problem, err)
	}
	if label != "real.zip" {
		t.Fatalf("文件名应取最终地址，得到 %q", label)
	}
	if size != int64(len(payload)) {
		t.Fatalf("字节数不对: %d", size)
	}
}

// 公网地址跳到内网，是最经典的 SSRF 绕过。
func TestLive2DImportRejectsRedirectToInternal(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://169.254.169.254/latest/meta-data/", http.StatusFound)
	}))
	defer server.Close()
	useTestImportClient(t, server.Client())

	target, _ := url.Parse(server.URL + "/a.zip")
	var sink bytes.Buffer
	_, _, problem, err := downloadLive2DZip(context.Background(), target, &sink)
	if err != nil {
		t.Fatalf("不该是服务端错误: %v", err)
	}
	if !strings.Contains(problem, "跳转到了不允许的地址") {
		t.Fatalf("应拒绝内网跳转，得到 %q", problem)
	}
	if sink.Len() != 0 {
		t.Fatal("被拒的跳转不应写入任何字节")
	}
}

func TestLive2DImportRejectsTooManyRedirects(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/loop", http.StatusFound)
	}))
	defer server.Close()
	useTestImportClient(t, server.Client())
	allowLoopbackHops(t)

	target, _ := url.Parse(server.URL + "/loop")
	var sink bytes.Buffer
	_, _, problem, err := downloadLive2DZip(context.Background(), target, &sink)
	if err != nil {
		t.Fatalf("不该是服务端错误: %v", err)
	}
	if !strings.Contains(problem, "跳转次数过多") {
		t.Fatalf("应拦下循环跳转，得到 %q", problem)
	}
}

// 声明了大体积就当场拒，不要先下 96MB 再说。
func TestLive2DImportRejectsOversize(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "999999999")
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	useTestImportClient(t, server.Client())

	target, _ := url.Parse(server.URL + "/big.zip")
	var sink bytes.Buffer
	_, _, problem, err := downloadLive2DZip(context.Background(), target, &sink)
	if err != nil {
		t.Fatalf("不该是服务端错误: %v", err)
	}
	if !strings.Contains(problem, "不能超过") {
		t.Fatalf("应拦下超大文件，得到 %q", problem)
	}
}

func TestLive2DImportReportsHTTPError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "nope", http.StatusForbidden)
	}))
	defer server.Close()
	useTestImportClient(t, server.Client())

	target, _ := url.Parse(server.URL + "/a.zip")
	var sink bytes.Buffer
	_, _, problem, err := downloadLive2DZip(context.Background(), target, &sink)
	if err != nil {
		t.Fatalf("不该是服务端错误: %v", err)
	}
	if !strings.Contains(problem, "403") {
		t.Fatalf("应把状态码回显给用户，得到 %q", problem)
	}
}

func TestLive2DImportLabelFallback(t *testing.T) {
	cases := map[string]string{
		"https://cdn.example.com/packs/Hiyori.zip":         "Hiyori.zip",
		"https://cdn.example.com/packs/":                   "cdn.example.com",
		"https://cdn.example.com":                          "cdn.example.com",
		"https://cdn.example.com/a/%E5%B0%8F%E7%99%BD.zip": "小白.zip",
	}
	for raw, want := range cases {
		parsed, err := url.Parse(raw)
		if err != nil {
			t.Fatalf("解析 %s 失败: %v", raw, err)
		}
		if got := live2dImportLabel(parsed); got != want {
			t.Errorf("%s 的显示名应为 %q，得到 %q", raw, want, got)
		}
	}
}
