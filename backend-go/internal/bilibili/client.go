package bilibili

import (
	"bytes"
	"compress/flate"
	"compress/gzip"
	"compress/zlib"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math/rand/v2"
	"net/http"
	"strings"
	"sync"
	"time"
)

const (
	// defaultUserAgent 与 client.ts / cdn.ts / resolver.ts 保持同一串。
	defaultUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

	// maxRetries 与 client.ts 的 MAX_RETRIES 一致（含首次共 3 次）。
	maxRetries = 3

	// requestTimeout 是单次请求上限。
	//
	// B站 偶发「TCP 连着但不回数据」的挂起，fetch 既不 resolve 也不 reject，
	// 表现为前端一直停在「正在选择可用 CDN...」。必须有硬超时打断。
	requestTimeout = 10 * time.Second

	// anonSessionTTL 是匿名会话 Cookie 的复用时长。
	anonSessionTTL = 30 * time.Minute
)

// BizError 是 B站 业务码非 0 的错误。
//
// 消息格式刻意与 client.ts 逐字符一致（`B站 API 业务错误 [code] message: url`），
// 因为上层 resolver/pgc 用 strings.Contains 匹配 `[-404]` `[-101]` 等子串来
// 分流错误提示。格式一改，那些分支全部静默失效。
type BizError struct {
	Code    int
	Message string
	URL     string
}

func (e *BizError) Error() string {
	return fmt.Sprintf("B站 API 业务错误 [%d] %s: %s", e.Code, e.Message, e.URL)
}

// Envelope 是 B站 API 的统一响应外壳。
//
// 必须同时保留 result 与 data：UGC 接口把载荷放 data，PGC 接口（season / pgc
// playurl）放顶层 result。只留 data 会让 PGC 解析永远拿到空载荷——而且
// 错误信息看起来像「接口失败」，实际是读错了位置。
type Envelope struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	TTL     int             `json:"ttl"`
	Result  json.RawMessage `json:"result"`
	Data    json.RawMessage `json:"data"`
}

// DecodeData 把 Envelope.Data 解成具体结构。
func DecodeData[T any](env *Envelope) (T, error) {
	var out T
	if len(env.Data) == 0 || string(env.Data) == "null" {
		return out, nil
	}
	if err := json.Unmarshal(env.Data, &out); err != nil {
		return out, fmt.Errorf("解析 B站 响应失败: %w", err)
	}
	return out, nil
}

// FetchOptions 对应 client.ts 的 BilibiliFetchOptions。
type FetchOptions struct {
	// Cookie 为空时自动复用匿名会话 Cookie。
	Cookie string
	// IgnoreBizCode 跳过业务码检查，供「业务失败但 data 仍有效」的接口使用
	// （典型：匿名 nav 返回 -101 但仍下发 wbi_img）。
	IgnoreBizCode bool
	// ExtraHeaders 覆盖默认头。
	ExtraHeaders map[string]string
}

// Client 是 B站 API 客户端。
//
// 做成类型而非包级全局，是为了让测试能替换 Transport，也让未来多实例
// （不同出口 IP）成为可能。
type Client struct {
	http *http.Client

	mu           sync.Mutex
	anonCookie   string
	anonWarmedAt time.Time
	anonWarming  chan struct{}
}

// NewClient 构造客户端。
func NewClient() *Client {
	return &Client{
		http: &http.Client{
			// 不设 client.Timeout：改用 per-request context，
			// 避免「整体超时」误伤偶发慢响应。
			Transport: http.DefaultTransport.(*http.Transport).Clone(),
		},
	}
}

// SetTransport 供测试注入（例如全部打到 httptest）。
func (c *Client) SetTransport(rt http.RoundTripper) {
	c.http.Transport = rt
}

// anonCookieSnapshot 读当前匿名 Cookie。
func (c *Client) anonCookieSnapshot() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.anonCookie
}

// mergeAnonCookie 把新拿到的 Cookie 片段并入匿名罐。
func (c *Client) mergeAnonCookie(parts string) {
	if parts == "" {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.anonCookie == "" {
		c.anonCookie = parts
	} else {
		c.anonCookie += "; " + parts
	}
}

// EnsureAnonymousSession 预热匿名会话。
//
// 无 Cookie 的请求极易触发 B站 412 风控，而一次解析要打 3+ 个接口，
// 每次重试退避 1~2s，累计能拖十几秒。预热时用一次 spi 请求取回
// buvid3/buvid4 存进匿名罐，后续所有匿名请求自动携带。
//
// 失败静默：匿名无 Cookie 仍可解析，只是风控概率略升。
func (c *Client) EnsureAnonymousSession(ctx context.Context) {
	c.mu.Lock()
	if time.Since(c.anonWarmedAt) < anonSessionTTL {
		c.mu.Unlock()
		return
	}
	if ch := c.anonWarming; ch != nil {
		// 已有预热在飞：等它结束，避免并发解析时重复打接口。
		c.mu.Unlock()
		select {
		case <-ch:
		case <-ctx.Done():
		}
		return
	}
	done := make(chan struct{})
	c.anonWarming = done
	c.mu.Unlock()

	defer func() {
		c.mu.Lock()
		c.anonWarming = nil
		// 无论成败都记时间：失败时 30 分钟内不重复空转，
		// 否则每次未登录解析都要先吃一次完整的失败重试耗时。
		c.anonWarmedAt = time.Now()
		c.mu.Unlock()
		close(done)
	}()

	// 注意：不能用 nav 预热。B站 已把匿名 nav 改为返回 code=-101
	// 且不再下发 Set-Cookie。spi 接口匿名可用，返回 b_3/b_4 即 buvid3/buvid4。
	env, err := c.Fetch(ctx, "https://api.bilibili.com/x/frontend/finger/spi", FetchOptions{})
	if err != nil {
		log.Printf("[bilibili] 匿名会话预热失败（忽略）: %v", err)
		return
	}
	var spi struct {
		B3 string `json:"b_3"`
		B4 string `json:"b_4"`
	}
	if _, err := DecodeDataInto(env, &spi); err != nil {
		return
	}
	var parts []string
	if spi.B3 != "" {
		parts = append(parts, "buvid3="+spi.B3)
	}
	if spi.B4 != "" {
		parts = append(parts, "buvid4="+spi.B4)
	}
	c.mergeAnonCookie(strings.Join(parts, "; "))
}

// DecodeDataInto 把 Envelope.Data 解进调用方提供的指针。
func DecodeDataInto(env *Envelope, dst any) (bool, error) {
	if env == nil || len(env.Data) == 0 || string(env.Data) == "null" {
		return false, nil
	}
	if err := json.Unmarshal(env.Data, dst); err != nil {
		return false, fmt.Errorf("解析 B站 响应失败: %w", err)
	}
	return true, nil
}

// Fetch 发起一次带重试的 B站 API 请求。
//
// 重试覆盖三类失败：412 风控、网络/超时、响应非 JSON（B站 出错时会吐 HTML 页面）。
// 业务码非 0 直接返回 BizError，不重试——那是权限/参数问题，重试无意义。
func (c *Client) Fetch(ctx context.Context, url string, opts FetchOptions) (*Envelope, error) {
	effectiveCookie := opts.Cookie
	if effectiveCookie == "" {
		effectiveCookie = c.anonCookieSnapshot()
	}

	var lastErr error
	for attempt := 0; attempt < maxRetries; attempt++ {
		if err := ctx.Err(); err != nil {
			return nil, err
		}

		env, retry, err := c.fetchOnce(ctx, url, opts, effectiveCookie)
		if err == nil {
			return env, nil
		}
		lastErr = err

		// 外部取消（客户端断开）不重试，直接抛出。
		if ctx.Err() != nil {
			return nil, err
		}
		if !retry {
			return nil, err
		}
		if attempt < maxRetries-1 {
			select {
			case <-time.After(randomBackoff()):
			case <-ctx.Done():
				return nil, lastErr
			}
			// 重试时若期间匿名罐已被别的请求填好，顺带用上。
			if opts.Cookie == "" {
				effectiveCookie = c.anonCookieSnapshot()
			}
		}
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("B站 API 请求失败: %s", url)
	}
	return nil, lastErr
}

// fetchOnce 执行单次请求，返回 (结果, 是否值得重试, 错误)。
func (c *Client) fetchOnce(
	parent context.Context,
	url string,
	opts FetchOptions,
	cookie string,
) (*Envelope, bool, error) {
	ctx, cancel := context.WithTimeout(parent, requestTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, false, err
	}
	req.Header.Set("User-Agent", defaultUserAgent)
	req.Header.Set("Referer", "https://www.bilibili.com")
	req.Header.Set("Origin", "https://www.bilibili.com")
	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}
	for k, v := range opts.ExtraHeaders {
		req.Header.Set(k, v)
	}

	resp, err := c.http.Do(req)
	if err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) && parent.Err() == nil {
			return nil, true, fmt.Errorf("B站 API 请求超时 (%dms): %s", requestTimeout.Milliseconds(), url)
		}
		return nil, true, err
	}
	defer resp.Body.Close()

	// 未登录时收集 Set-Cookie，供后续匿名请求复用。
	// 只在调用方没传 Cookie 时收集：登录态不该被匿名罐污染。
	if opts.Cookie == "" {
		if joined := parseSetCookies(resp.Header); joined != "" {
			c.mergeAnonCookie(joined)
		}
	}

	if resp.StatusCode == http.StatusPreconditionFailed { // 412 风控
		return nil, true, fmt.Errorf("B站 API 返回 412 风控拦截: %s", url)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, false, fmt.Errorf("B站 API 请求失败 [%d] %s: %s", resp.StatusCode, http.StatusText(resp.StatusCode), url)
	}

	var env Envelope
	dec := json.NewDecoder(resp.Body)
	if err := dec.Decode(&env); err != nil {
		// 接口失效/风控时 B站 可能返回 HTML 错误页，此时 JSON 解析必然失败。
		return nil, true, fmt.Errorf("B站 接口返回异常响应（非 JSON）: %s", url)
	}

	if env.Code != 0 && !opts.IgnoreBizCode {
		return nil, false, &BizError{Code: env.Code, Message: env.Message, URL: url}
	}
	return &env, false, nil
}

// FetchRaw 发起一次返回「非 JSON 载荷」的请求（弹幕 XML、字幕 JSON 文件），
// 返回解压后的响应体与状态码。
//
// 单独开一条路径而不是复用 Fetch，是因为这些地址不套 B站 API 的外壳结构，
// 而且会**无条件**回 `Content-Encoding: deflate`——即便请求里写的是
// `Accept-Encoding: identity` 也一样（实测 dm/list.so 如此）。
// Go 的 http.Transport 只自动解 gzip，且只在自己补上 Accept-Encoding 时才解；
// 裸 deflate 必须自己处理，否则读到的是二进制乱码，正则一条都匹配不上，
// 表现为「弹幕接口成功但列表为空」，而且不报任何错。
func (c *Client) FetchRaw(ctx context.Context, url string, opts FetchOptions) ([]byte, int, error) {
	effectiveCookie := opts.Cookie
	if effectiveCookie == "" {
		effectiveCookie = c.anonCookieSnapshot()
	}

	var lastErr error
	for attempt := 0; attempt < maxRetries; attempt++ {
		if err := ctx.Err(); err != nil {
			return nil, 0, err
		}
		body, status, retry, err := c.fetchRawOnce(ctx, url, opts, effectiveCookie)
		if err == nil {
			return body, status, nil
		}
		lastErr = err
		if ctx.Err() != nil {
			return nil, status, err
		}
		if !retry {
			return nil, status, err
		}
		if attempt < maxRetries-1 {
			select {
			case <-time.After(randomBackoff()):
			case <-ctx.Done():
				return nil, status, lastErr
			}
			if opts.Cookie == "" {
				effectiveCookie = c.anonCookieSnapshot()
			}
		}
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("B站 请求失败: %s", url)
	}
	return nil, 0, lastErr
}

func (c *Client) fetchRawOnce(
	parent context.Context,
	url string,
	opts FetchOptions,
	cookie string,
) ([]byte, int, bool, error) {
	ctx, cancel := context.WithTimeout(parent, requestTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, 0, false, err
	}
	req.Header.Set("User-Agent", defaultUserAgent)
	req.Header.Set("Referer", "https://www.bilibili.com")
	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}
	for k, v := range opts.ExtraHeaders {
		req.Header.Set(k, v)
	}

	resp, err := c.http.Do(req)
	if err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) && parent.Err() == nil {
			return nil, 0, true, fmt.Errorf("B站 请求超时 (%dms): %s", requestTimeout.Milliseconds(), url)
		}
		return nil, 0, true, err
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusPreconditionFailed {
		return nil, resp.StatusCode, true, fmt.Errorf("B站 请求返回 412 风控拦截: %s", url)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		// 状态码交给调用方决定文案（弹幕接口的报错文案含状态码）。
		return nil, resp.StatusCode, false, &StatusError{Code: resp.StatusCode, URL: url}
	}

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, resp.StatusCode, true, err
	}
	body, err := decodeBody(raw, resp.Header.Get("Content-Encoding"))
	if err != nil {
		return nil, resp.StatusCode, true, fmt.Errorf("解压 B站 响应失败 (%s): %w", url, err)
	}
	return body, resp.StatusCode, false, nil
}

// StatusError 是非 2xx 响应。
type StatusError struct {
	Code int
	URL  string
}

func (e *StatusError) Error() string {
	return fmt.Sprintf("B站 请求失败 [%d]: %s", e.Code, e.URL)
}

// decodeBody 按 Content-Encoding 解压响应体。
//
// deflate 优先按**裸 deflate** 解：B站 实际发的就是没有 zlib 头的裸流，
// 用 zlib.NewReader 会报 "incorrect header check"。反过来（真的收到 zlib 流）
// 再用 zlib 兜底。
func decodeBody(raw []byte, encoding string) ([]byte, error) {
	switch strings.ToLower(strings.TrimSpace(encoding)) {
	case "", "identity":
		return raw, nil
	case "gzip", "x-gzip":
		zr, err := gzip.NewReader(bytes.NewReader(raw))
		if err != nil {
			return nil, err
		}
		defer zr.Close()
		return io.ReadAll(zr)
	case "deflate":
		if out, err := io.ReadAll(flate.NewReader(bytes.NewReader(raw))); err == nil {
			return out, nil
		}
		zr, err := zlib.NewReader(bytes.NewReader(raw))
		if err != nil {
			return nil, err
		}
		defer zr.Close()
		return io.ReadAll(zr)
	default:
		// br 等未支持的编码：原样返回，由调用方按内容判断。
		return raw, nil
	}
}

// parseSetCookies 把响应头里的 Set-Cookie 汇总成 `k=v; k2=v2` 形式。
func parseSetCookies(h http.Header) string {
	values := h.Values("Set-Cookie")
	if len(values) == 0 {
		return ""
	}
	parts := make([]string, 0, len(values))
	for _, raw := range values {
		// 只取 `name=value` 部分，丢弃 Path/Domain/Expires 等属性。
		pair := raw
		if idx := strings.IndexByte(pair, ';'); idx >= 0 {
			pair = pair[:idx]
		}
		pair = strings.TrimSpace(pair)
		if strings.Contains(pair, "=") {
			parts = append(parts, pair)
		}
	}
	return strings.Join(parts, "; ")
}

// randomBackoff 返回 1~2s 的随机退避。
func randomBackoff() time.Duration {
	return time.Second + time.Duration(rand.IntN(1000))*time.Millisecond
}
