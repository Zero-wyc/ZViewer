package webfetch

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"golang.org/x/text/encoding/htmlindex"
	"golang.org/x/text/transform"
)

// 上游文本获取，对应 services/anisubs/httpClient.ts 与 services/cms/http.ts。
//
// Node 版在 fetch 失败后会退到 PowerShell（借 .NET/Schannel 的 TLS 指纹绕过
// Cloudflare）。Go 的 TLS 栈本来就是独立指纹，不存在「Node 指纹被拦」这个
// 前提，所以这里**不迁 PowerShell 兜底**——真遇到按指纹拦的站点，该改的是
// UA/Referer 或换源。

// Result 是一次抓取的结果。
//
// 失败时（网络层）Status 为 0 且 Error 非空：调用方需要区分「HTTP 非 2xx」
// 与「压根没连上」，并各自拼出 Node 的同款文案。
type Result struct {
	Status int
	Body   string
	OK     bool
	// Headers 只保留 Cloudflare 判定需要的几个：server / cf-ray / content-type。
	Headers map[string]string
	Error   string
}

// Options 是一次抓取的参数。
type Options struct {
	Headers map[string]string
	Timeout time.Duration
	// Method 为空时按 GET 处理。
	Method string
	// Body 仅在非 GET 时发送。
	Body string
	// ContentType 仅在非 GET 且有 Body 时生效。
	ContentType string
}

// defaultTimeout 与 Node 的 timeoutMs 默认值（20s）一致。
const defaultTimeout = 20 * time.Second

// httpClient 是包级客户端（单测用它注入假 transport）。
var httpClient = http.DefaultClient

// SetTransport 替换底层 transport（仅测试用）。
func SetTransport(rt http.RoundTripper) func() {
	previous := httpClient
	if rt == nil {
		httpClient = http.DefaultClient
	} else {
		httpClient = &http.Client{Transport: rt}
	}
	return func() { httpClient = previous }
}

// Fetch 抓取 URL 文本。
//
// charset 处理与 Node 的 decodeBody 一致（见 DecodeBody）。
// **刻意剥掉调用方传的 Accept-Encoding**：浏览器头里写着 `gzip, deflate, br`，
// 照抄给 Go 会让服务端回 brotli，而 net/http 只会自动解 gzip（且只在它自己
// 加的请求头时才解）——最后拿到的是一堆二进制。交给 transport 自己协商。
func Fetch(ctx context.Context, url string, opts Options) *Result {
	timeout := opts.Timeout
	if timeout <= 0 {
		timeout = defaultTimeout
	}
	reqCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	method := strings.ToUpper(strings.TrimSpace(opts.Method))
	if method == "" {
		method = http.MethodGet
	}
	var bodyReader io.Reader
	if method != http.MethodGet && opts.Body != "" {
		bodyReader = strings.NewReader(opts.Body)
	}

	req, err := http.NewRequestWithContext(reqCtx, method, url, bodyReader)
	if err != nil {
		return &Result{Error: err.Error(), Headers: map[string]string{}}
	}
	for key, value := range opts.Headers {
		if strings.EqualFold(key, "Accept-Encoding") {
			continue
		}
		req.Header.Set(key, value)
	}
	if opts.ContentType != "" && method != http.MethodGet {
		req.Header.Set("Content-Type", opts.ContentType)
	}

	resp, err := httpClient.Do(req)
	if err != nil {
		message := err.Error()
		if errors.Is(reqCtx.Err(), context.DeadlineExceeded) {
			message = fmt.Sprintf("请求超时 (%dms)", timeout.Milliseconds())
		}
		return &Result{Error: message, Headers: map[string]string{}}
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return &Result{Status: resp.StatusCode, Error: err.Error(), Headers: map[string]string{}}
	}

	headers := map[string]string{}
	contentType := resp.Header.Get("Content-Type")
	for key, name := range map[string]string{
		"server":       "server",
		"cf-ray":       "cf-ray",
		"content-type": "content-type",
	} {
		if value := resp.Header.Get(name); value != "" {
			headers[key] = value
		}
	}

	return &Result{
		Status:  resp.StatusCode,
		Body:    DecodeBody(raw, contentType),
		OK:      resp.StatusCode >= 200 && resp.StatusCode < 300,
		Headers: headers,
	}
}

// IsCloudflareBlocked 判断响应是否被 Cloudflare 的 JS/Managed Challenge 拦下。
//
// 只看 403/503 + `server: cloudflare`（或存在 `cf-ray`）。这套判定与 Node 一致：
// 宁可漏判也别误判——误判会把「站点真的 403」说成「被 Cloudflare 拦」，
// 让用户去关防护而不是换源。
func IsCloudflareBlocked(status int, headers map[string]string) bool {
	if status != http.StatusForbidden && status != http.StatusServiceUnavailable {
		return false
	}
	if strings.Contains(strings.ToLower(headers["server"]), "cloudflare") {
		return true
	}
	return headers["cf-ray"] != ""
}

// charsetPattern 从 Content-Type 里取 charset 标签。
var charsetPattern = regexp.MustCompile(`charset\s*=\s*"?([\w-]+)"?`)

// DecodeBody 按字符集解码响应字节。
//
// 优先级与 Node 的 decodeBody 完全一致：
//  1. 服务器声明了非 UTF-8 的 charset → 按它解；
//  2. 否则严格 UTF-8 嗅探；
//  3. 失败回退 GB18030（GB2312/GBK 的超集，国内站点常见编码）。
//
// 这一步不能省：`res.text()` 在 charset 缺失时按 UTF-8 硬解，GBK 源站的
// 中文片名会整片乱码，表象却是「搜索不到」。
func DecodeBody(raw []byte, contentType string) string {
	declared := ""
	if m := charsetPattern.FindStringSubmatch(contentType); len(m) == 2 {
		declared = strings.ToLower(m[1])
	}
	if declared != "" && declared != "utf-8" && declared != "utf8" {
		if enc, err := htmlindex.Get(declared); err == nil {
			if decoded, _, err := transform.Bytes(enc.NewDecoder(), raw); err == nil {
				return string(decoded)
			}
		}
	}
	if utf8.Valid(raw) {
		return string(raw)
	}
	if enc, err := htmlindex.Get("gb18030"); err == nil {
		if decoded, _, err := transform.Bytes(enc.NewDecoder(), raw); err == nil {
			return string(decoded)
		}
	}
	return string(raw)
}
