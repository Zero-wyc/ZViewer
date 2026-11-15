package api

import (
	"archive/zip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"strings"
	"time"

	"zviewer/backend/internal/auth"
	"zviewer/backend/internal/httpx"
	"zviewer/backend/internal/netutil"
)

// 从链接导入模型库。
//
// 与「上传压缩包」是同一件事的另一种输入：包不在用户手上，而在某个直链后面。
// 落库规则完全复用 installLive2DZip，本文件只负责**安全地把字节取回来**。
//
// 这是整个 Live2D 模块唯一一处「服务端主动访问用户给的地址」，也就是唯一
// 带 SSRF 面的代码。宿主机上跑着数据库、内网 NAS、云厂商元数据服务
// （169.254.169.254），一次盲目的 GET 就能把它们的内容写进模型库、
// 再通过 /uploads/live2d/… 原样读出来。所以下面四道闸都必须存在：
//
//  1. 协议白名单：只允许 http/https，且不接受 URL 里带账号密码。
//  2. 字面地址预检：主机名本身就是内网/回环的直接拒（给用户明确原因）。
//  3. **建连时**按解析出的 IP 再校验一次：只查主机名挡不住「公网域名解析到
//     127.0.0.1」，所以要用解析结果里通过校验的那个 IP 去连，而不是把域名
//     交给系统再去解析一遍（那是 TOCTOU + DNS rebinding）。
//  4. 跳转自己跟、逐跳复审，并且体积与时长都有硬上限。

const (
	// 跳转上限。每一跳都要重新过第 2、3 道闸，跳数越多越难审计。
	live2dImportMaxHops = 3
	// 整个下载（DNS + TLS + 传输）的墙钟上限。
	live2dImportTimeout = 90 * time.Second
	// 等响应头的时间：目标站点挂起时不能一直占着 goroutine 与临时文件。
	live2dImportHeaderTimeout = 20 * time.Second
	// 下载 UA：部分对象存储会拒绝空 UA 的请求。
	live2dImportUserAgent = "ZViewer-Live2D-Import/1.0"
)

// errLive2DImportBlocked 是「目标指向内网」的内部哨兵，对外转成固定文案：
// 不能把解析出来的内网 IP 回显给调用方，那等于白送一张内网存活探测表。
var errLive2DImportBlocked = errors.New("live2d import: target is not a public address")

// live2dImportClient 可替换，便于单测用 httptest 的 client 打通下载链路
// （本地测试服务器必然在回环地址上，会被默认闸门拦下）。
var live2dImportClient = newLive2DImportClient()

// live2dImportHopCheck 是「这一跳能不能去」的判定，实现就是 live2dImportTarget。
// 单测要在回环地址上验证跳转后仍会重新校验，所以留了这一个替换点。
var live2dImportHopCheck = live2dImportTarget

func (s *Server) registerLive2DImportRoute(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/live2d/models/import", s.Auth.Require(s.handleImportLive2DModel))
}

func newLive2DImportClient() *http.Client {
	dialer := &net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second}
	transport := &http.Transport{
		// 环境代理会让请求绕过 DialContext 里的 IP 校验（由代理去解析域名），
		// 这条路必须封死。
		Proxy:                 nil,
		DialContext:           guardLive2DImportDial(dialer),
		TLSHandshakeTimeout:   15 * time.Second,
		ResponseHeaderTimeout: live2dImportHeaderTimeout,
		MaxIdleConns:          2,
		IdleConnTimeout:       30 * time.Second,
	}
	return &http.Client{
		Transport: transport,
		// 自己跟跳转：默认的自动跟随只看 Location，不看它指向哪。
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

// guardLive2DImportDial 返回一个「只肯连公网地址」的 DialContext。
func guardLive2DImportDial(dialer *net.Dialer) func(ctx context.Context, network, address string) (net.Conn, error) {
	return func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, err
		}
		if netutil.IsInternalNetworkHost(host) {
			return nil, errLive2DImportBlocked
		}
		addrs, err := net.DefaultResolver.LookupIPAddr(ctx, host)
		if err != nil {
			return nil, err
		}
		var lastErr error
		for _, addr := range addrs {
			ip := addr.IP
			// IsGlobalUnicast 还能挡掉组播与 0.0.0.0/8 的边角情况。
			if !ip.IsGlobalUnicast() || netutil.IsInternalNetworkHost(ip.String()) {
				continue
			}
			conn, err := dialer.DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
			if err == nil {
				return conn, nil
			}
			lastErr = err
		}
		if lastErr != nil {
			return nil, lastErr
		}
		return nil, errLive2DImportBlocked
	}
}

// live2dImportTarget 校验用户给的地址，返回可用的 URL。
func live2dImportTarget(raw string) (*url.URL, string) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil, "请填写模型包的下载链接"
	}
	if len(trimmed) > 2048 {
		return nil, "链接过长"
	}
	parsed, err := url.Parse(trimmed)
	if err != nil {
		return nil, "链接格式不正确"
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, "只支持 http / https 链接"
	}
	if parsed.Hostname() == "" {
		return nil, "链接格式不正确"
	}
	if parsed.User != nil {
		return nil, "链接里不要带账号密码"
	}
	if netutil.IsInternalNetworkHost(parsed.Hostname()) {
		return nil, "不支持内网地址"
	}
	return parsed, ""
}

// live2dImportProblem 把底层错误翻译成用户能看懂的一句话。
func live2dImportProblem(err error) string {
	switch {
	case errors.Is(err, errLive2DImportBlocked):
		return "不支持内网地址"
	case errors.Is(err, context.DeadlineExceeded):
		return "下载超时，请确认链接可以直接下载"
	}
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		return "无法解析链接的域名"
	}
	return "无法下载：" + err.Error()
}

func (s *Server) handleImportLive2DModel(w http.ResponseWriter, r *http.Request) {
	claims := auth.ClaimsFrom(r.Context())
	if !live2dCanUpload(claims) {
		httpx.Forbidden(w, "无权限：请登录后再导入模型")
		return
	}

	var body struct {
		URL string `json:"url"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 8<<10)
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpx.BadRequest(w, "请求格式不正确")
		return
	}
	target, problem := live2dImportTarget(body.URL)
	if problem != "" {
		httpx.BadRequest(w, problem)
		return
	}

	root := s.live2dRoot()
	if err := os.MkdirAll(root, 0o755); err != nil {
		httpx.InternalError(w, "live2d-import/mkdir", err)
		return
	}
	// 边下边写盘：96MB 不进内存。临时文件以 "." 开头，列表扫描会跳过。
	tmp, err := os.CreateTemp(root, ".import-*")
	if err != nil {
		httpx.InternalError(w, "live2d-import/tmpfile", err)
		return
	}
	tmpPath := tmp.Name()
	defer func() {
		tmp.Close()
		_ = os.Remove(tmpPath)
	}()

	ctx, cancel := context.WithTimeout(r.Context(), live2dImportTimeout)
	defer cancel()

	label, size, problem, err := downloadLive2DZip(ctx, target, tmp)
	if err != nil {
		httpx.InternalError(w, "live2d-import/download", err)
		return
	}
	if problem != "" {
		httpx.BadRequest(w, problem)
		return
	}

	zr, err := zip.NewReader(tmp, size)
	if err != nil {
		httpx.BadRequest(w, "链接指向的不是 zip 压缩包")
		return
	}

	meta, message, problem, err := s.installLive2DZip(claims, zr.File, label)
	if err != nil {
		httpx.InternalError(w, "live2d-import/install", err)
		return
	}
	if problem != "" {
		httpx.BadRequest(w, problem)
		return
	}

	httpx.OK(w, map[string]any{
		"success": true,
		"message": message,
		"model":   meta,
	})
}

// downloadLive2DZip 手动跟跳转把包写进 dst，返回推断出的文件名与字节数。
func downloadLive2DZip(ctx context.Context, target *url.URL, dst io.Writer) (string, int64, string, error) {
	// 每次取一份 client 副本并关掉自动跳转：跟随策略必须由本函数掌控，
	// 不能依赖 client 上恰好设了 CheckRedirect（否则重定向就会绕过逐跳校验）。
	client := *live2dImportClient
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }

	current := target
	for hop := 0; hop <= live2dImportMaxHops; hop++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, current.String(), nil)
		if err != nil {
			return "", 0, "链接格式不正确", nil
		}
		req.Header.Set("User-Agent", live2dImportUserAgent)
		req.Header.Set("Accept", "application/zip, application/octet-stream, */*")

		resp, err := client.Do(req)
		if err != nil {
			return "", 0, live2dImportProblem(err), nil
		}

		if isLive2DRedirect(resp.StatusCode) {
			location := resp.Header.Get("Location")
			// 丢弃跳转响应体，避免连接泄漏。
			_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4<<10))
			resp.Body.Close()
			if location == "" {
				return "", 0, "下载地址返回了空跳转", nil
			}
			// 相对 Location 按「当前这一跳」解，不依赖 resp.Request（那要看
			// 具体 transport 有没有回填）。
			next, err := current.Parse(location)
			if err != nil {
				return "", 0, "下载地址的跳转不正确", nil
			}
			// 逐跳复审：公网地址跳到 127.0.0.1 是这类接口最经典的绕过方式。
			checked, problem := live2dImportHopCheck(next.String())
			if problem != "" {
				return "", 0, "跳转到了不允许的地址", nil
			}
			current = checked
			continue
		}

		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return "", 0, fmt.Sprintf("下载失败：目标返回 %d，请确认是文件的直链", resp.StatusCode), nil
		}
		if resp.ContentLength > live2dUploadMaxBytes {
			return "", 0, fmt.Sprintf("模型包不能超过 %dMB", live2dUploadMaxBytes>>20), nil
		}

		// LimitReader 多留 1 字节用来判断「超了」：没有 Content-Length 的分块
		// 响应只能靠实际读到的字节数拦。
		written, copyErr := io.Copy(dst, io.LimitReader(resp.Body, live2dUploadMaxBytes+1))
		if copyErr != nil {
			return "", 0, live2dImportProblem(copyErr), nil
		}
		if written > live2dUploadMaxBytes {
			return "", 0, fmt.Sprintf("模型包不能超过 %dMB", live2dUploadMaxBytes>>20), nil
		}
		return live2dImportLabel(current), written, "", nil
	}
	return "", 0, "下载地址跳转次数过多", nil
}

func isLive2DRedirect(status int) bool {
	switch status {
	case http.StatusMovedPermanently, http.StatusFound, http.StatusSeeOther,
		http.StatusTemporaryRedirect, http.StatusPermanentRedirect:
		return true
	}
	return false
}

// live2dImportLabel 从最终地址推断显示名：取最后一段路径，去掉扩展名。
// 取不到时退回主机名——总比让用户看到一串空名字好。
func live2dImportLabel(u *url.URL) string {
	// 以 / 结尾或没有路径，说明这不是一个文件地址，名字只能退回主机名。
	if u.Path == "" || strings.HasSuffix(u.Path, "/") {
		return u.Hostname()
	}
	seg := path.Base(u.Path)
	if unescaped, err := url.PathUnescape(seg); err == nil {
		seg = unescaped
	}
	seg = strings.TrimSpace(seg)
	if seg == "" || seg == "." || seg == "/" {
		seg = u.Hostname()
	}
	return seg
}
