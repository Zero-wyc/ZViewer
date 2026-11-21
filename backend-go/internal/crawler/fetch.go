package crawler

import (
	"bytes"
	"compress/flate"
	"compress/gzip"
	"compress/zlib"
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"golang.org/x/text/encoding/htmlindex"
	"golang.org/x/text/transform"

	"zviewer/backend/internal/netproxy"
)

// 引擎统一的抓取器。语义对齐 crawler/engine/fetch.py：
//   - 默认 UA 与浏览器一致，Accept-Language 偏中文；
//   - 自己声明 gzip/deflate 并手写解压（Go 只在自动协商时才解 gzip）；
//   - 编码探测顺序：响应头 charset → <meta charset> → BOM → utf-8；
//   - 单次最多读 maxBytes，5xx/429/网络错误重试，退避 0.6s×次数。

const (
	defaultUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
	defaultTimeout   = 25 * time.Second
	defaultMaxBytes  = 3 << 20
)

var (
	charsetHeaderRe = regexp.MustCompile(`(?i)charset="?([\w.-]+)`)
	charsetMetaRe   = regexp.MustCompile(`(?i)<meta[^>]+charset=["']?\s*([\w.-]+)`)
	httpURLRe       = regexp.MustCompile(`(?i)^https?://`)
)

// FetchResult 是一次抓取的结果。Raw 是解压后的字节，Text 是按探测到的
// 编码解码出的字符串，Encoding 是最终采用的编码名。
type FetchResult struct {
	Status   int
	URL      string
	Headers  map[string]string
	Text     string
	Raw      []byte
	Encoding string
}

// FetcherOptions 控制抓取行为。
type FetcherOptions struct {
	Timeout     time.Duration
	MaxBytes    int64
	UserAgent   string
	Retries     int
	InsecureTLS bool
}

// Fetcher 可复用，内部持有 http.Client。
type Fetcher struct {
	client    *http.Client
	maxBytes  int64
	userAgent string
	retries   int
	timeout   time.Duration
}

// NewFetcher 构造抓取器。Transport 用 netproxy：桌面端由 Explorer 拉起，
// 没有 HTTP_PROXY 环境变量，直接走 http.DefaultTransport 等于永远直连。
func NewFetcher(opts FetcherOptions) *Fetcher {
	transport := netproxy.Transport()
	if opts.InsecureTLS {
		transport.TLSClientConfig = &tls.Config{InsecureSkipVerify: true} //nolint:gosec // 站点证书错乱时用户显式开启
	}
	timeout := opts.Timeout
	if timeout <= 0 {
		timeout = defaultTimeout
	}
	maxBytes := opts.MaxBytes
	if maxBytes <= 0 {
		maxBytes = defaultMaxBytes
	}
	agent := opts.UserAgent
	if strings.TrimSpace(agent) == "" {
		agent = defaultUserAgent
	}
	retries := opts.Retries
	if retries < 0 {
		retries = 0
	}
	return &Fetcher{
		client:    &http.Client{Transport: transport, Timeout: timeout},
		maxBytes:  maxBytes,
		userAgent: agent,
		retries:   retries,
		timeout:   timeout,
	}
}

// Request 描述一次抓取请求。
type Request struct {
	URL     string
	Method  string
	Headers map[string]string
	Body    []byte
	Timeout time.Duration
}

// Fetch 执行抓取，失败返回 *EngineError（code=fetch_error）。
func (f *Fetcher) Fetch(ctx context.Context, req Request) (*FetchResult, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	target := strings.TrimSpace(req.URL)
	if target == "" {
		return nil, FetchError("URL 为空", 0, "", nil)
	}
	if !httpURLRe.MatchString(target) {
		return nil, FetchError("仅支持 http/https URL: "+target, 0, target, nil)
	}
	headers := map[string]string{
		"User-Agent":      f.userAgent,
		"Accept":          "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
		"Accept-Language": "zh-CN,zh;q=0.9,en;q=0.6",
		"Accept-Encoding": "gzip, deflate",
	}
	for key, value := range req.Headers {
		headers[key] = value
	}
	timeout := req.Timeout
	if timeout <= 0 {
		timeout = f.timeout
	}

	var lastErr error
	for attempt := 1; attempt <= f.retries+1; attempt++ {
		result, err := f.once(ctx, target, req, headers, timeout)
		if err == nil {
			return result, nil
		}
		lastErr = err
		if !retryable(err) || attempt > f.retries {
			return nil, err
		}
		select {
		case <-ctx.Done():
			return nil, FetchError("请求已取消", 0, target, nil)
		case <-time.After(time.Duration(600*attempt) * time.Millisecond):
		}
	}
	if lastErr == nil {
		lastErr = FetchError("请求失败", 0, target, nil)
	}
	return nil, lastErr
}

// retryable 只对 5xx / 429 / 网络层错误重试；4xx（含 403 验证页）直接上抛，
// 让上层走人机验证流程。
func retryable(err error) bool {
	engineErr, ok := err.(*EngineError)
	if !ok || engineErr.Code != "fetch_error" {
		return true
	}
	status, _ := engineErr.Details["status"].(int)
	if status == 0 {
		return true
	}
	return status >= 500 || status == 429
}

func (f *Fetcher) once(ctx context.Context, target string, req Request, headers map[string]string, timeout time.Duration) (*FetchResult, error) {
	reqCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	method := strings.ToUpper(strings.TrimSpace(req.Method))
	if method == "" {
		method = http.MethodGet
	}
	var bodyReader io.Reader
	if len(req.Body) > 0 {
		bodyReader = bytes.NewReader(req.Body)
	}
	httpReq, err := http.NewRequestWithContext(reqCtx, method, target, bodyReader)
	if err != nil {
		return nil, FetchError("请求构造失败: "+err.Error(), 0, target, nil)
	}
	for key, value := range headers {
		httpReq.Header.Set(key, value)
	}

	resp, err := f.client.Do(httpReq)
	if err != nil {
		if reqCtx.Err() == context.DeadlineExceeded {
			return nil, FetchError(fmt.Sprintf("请求超时 (%dms)", timeout.Milliseconds()), 0, target, nil)
		}
		return nil, FetchError("连接失败: "+err.Error(), 0, target, nil)
	}
	defer resp.Body.Close()

	outHeaders := make(map[string]string, len(resp.Header))
	for key, values := range resp.Header {
		if len(values) > 0 {
			outHeaders[strings.ToLower(key)] = values[0]
		}
	}

	raw, err := io.ReadAll(io.LimitReader(resp.Body, f.maxBytes+1))
	if err != nil {
		return nil, FetchError("读取响应失败: "+err.Error(), resp.StatusCode, target, nil)
	}
	if int64(len(raw)) > f.maxBytes {
		raw = raw[:f.maxBytes]
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		snippet := raw
		if len(snippet) > 2048 {
			snippet = snippet[:2048]
		}
		return nil, FetchError(fmt.Sprintf("HTTP %d", resp.StatusCode), resp.StatusCode, target,
			map[string]any{"snippet": string(snippet)})
	}

	decoded := decodeContent(outHeaders, raw)
	encoding := detectEncoding(outHeaders, decoded)
	text, encoding := decodeText(decoded, encoding)
	finalURL := target
	if resp.Request != nil && resp.Request.URL != nil {
		finalURL = resp.Request.URL.String()
	}
	return &FetchResult{
		Status:   resp.StatusCode,
		URL:      finalURL,
		Headers:  outHeaders,
		Text:     text,
		Raw:      decoded,
		Encoding: encoding,
	}, nil
}

// decodeContent 手动解 gzip/deflate。解不开就原样返回（Python 同款容错）。
func decodeContent(headers map[string]string, raw []byte) []byte {
	encoding := strings.ToLower(headers["content-encoding"])
	switch {
	case strings.Contains(encoding, "gzip"):
		reader, err := gzip.NewReader(bytes.NewReader(raw))
		if err != nil {
			return raw
		}
		defer reader.Close()
		out, err := io.ReadAll(reader)
		if err != nil {
			return raw
		}
		return out
	case strings.Contains(encoding, "deflate"):
		if reader, err := zlib.NewReader(bytes.NewReader(raw)); err == nil {
			defer reader.Close()
			if out, err := io.ReadAll(reader); err == nil {
				return out
			}
		}
		reader := flate.NewReader(bytes.NewReader(raw))
		defer reader.Close()
		if out, err := io.ReadAll(reader); err == nil {
			return out
		}
	}
	return raw
}

// detectEncoding 按 header → meta → BOM 的顺序探测编码。
func detectEncoding(headers map[string]string, raw []byte) string {
	if match := charsetHeaderRe.FindStringSubmatch(headers["content-type"]); len(match) > 1 {
		return strings.ToLower(match[1])
	}
	head := raw
	if len(head) > 8192 {
		head = head[:8192]
	}
	if match := charsetMetaRe.FindSubmatch(head); len(match) > 1 {
		return strings.ToLower(string(match[1]))
	}
	if bytes.HasPrefix(raw, []byte{0xEF, 0xBB, 0xBF}) {
		return "utf-8-sig"
	}
	if bytes.HasPrefix(raw, []byte{0xFF, 0xFE}) || bytes.HasPrefix(raw, []byte{0xFE, 0xFF}) {
		return "utf-16"
	}
	return "utf-8"
}

// decodeText 把字节解成字符串。返回实际采用的编码名（探测失败回退 utf-8）。
//
// 用 WHATWG 编码标签表（htmlindex）而不是 Python 的 codecs 名字：
// gb2312 在这里按 GBK 解，是浏览器行为，不会因为个别字报错；
// 非法字节统一替换成 U+FFFD，与 Python 的 errors="replace" 等价。
func decodeText(raw []byte, name string) (string, string) {
	normalized := strings.ToLower(strings.TrimSpace(name))
	switch normalized {
	case "", "utf-8", "utf8":
		return string(bytes.TrimPrefix(raw, []byte{0xEF, 0xBB, 0xBF})), "utf-8"
	case "utf-8-sig":
		return string(bytes.TrimPrefix(raw, []byte{0xEF, 0xBB, 0xBF})), "utf-8"
	}
	if normalized == "utf-16" {
		if bytes.HasPrefix(raw, []byte{0xFF, 0xFE}) {
			normalized = "utf-16le"
			raw = raw[2:]
		} else if bytes.HasPrefix(raw, []byte{0xFE, 0xFF}) {
			normalized = "utf-16be"
			raw = raw[2:]
		}
	}
	encoding, err := htmlindex.Get(normalized)
	if err != nil || encoding == nil {
		return string(raw), "utf-8"
	}
	decoded, _, err := transform.Bytes(encoding.NewDecoder(), raw)
	if err != nil {
		return string(raw), "utf-8"
	}
	return string(decoded), normalized
}

// DecodeText 按编码名解码字节，返回文本与实际采用的编码（验证反代复用）。
func DecodeText(raw []byte, name string) (string, string) { return decodeText(raw, name) }

// QuoteKeyword 按指定编码把关键词转成百分号编码，等价 Python 的
// urllib.parse.quote(keyword, safe="")：只保留 A-Za-z0-9-._~，空格编成 %20。
// 国内站点常见 encoding=gbk，先转字节再编码，不能直接对 UTF-8 编码。
func QuoteKeyword(keyword, encoding string) (string, error) {
	trimmed := strings.TrimSpace(keyword)
	payload := []byte(trimmed)
	normalized := strings.ToLower(strings.TrimSpace(encoding))
	if normalized != "" && normalized != "utf-8" && normalized != "utf8" {
		if enc, err := htmlindex.Get(normalized); err == nil && enc != nil {
			converted, _, convErr := transform.Bytes(enc.NewEncoder(), payload)
			if convErr != nil {
				return "", RuleErrorf("关键词无法按 %s 编码: %v", normalized, convErr)
			}
			payload = converted
		}
	}
	var builder strings.Builder
	builder.Grow(len(payload) * 3)
	for _, b := range payload {
		if isUnreserved(b) {
			builder.WriteByte(b)
			continue
		}
		fmt.Fprintf(&builder, "%%%02X", b)
	}
	return builder.String(), nil
}

func isUnreserved(b byte) bool {
	switch {
	case b >= 'a' && b <= 'z', b >= 'A' && b <= 'Z', b >= '0' && b <= '9':
		return true
	case b == '-', b == '.', b == '_', b == '~':
		return true
	}
	return false
}

// joinURL 等价 Python 的 urljoin：以 base 为基准解析 ref。
func joinURL(base, ref string) string {
	trimmed := strings.TrimSpace(ref)
	if trimmed == "" {
		return ""
	}
	baseURL, err := url.Parse(strings.TrimSpace(base))
	if err != nil {
		return trimmed
	}
	refURL, err := url.Parse(trimmed)
	if err != nil {
		return trimmed
	}
	return baseURL.ResolveReference(refURL).String()
}
