package ncm

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
)

// Client 是内部 NCM API 服务的调用客户端。
//
// 与 Node 的 `callNcmApi` / `forwardNcmRequest` 共用一份实现：所有网易云业务
// 都经这里发请求，避免每处各自拼 URL / 解 JSON / 收 Set-Cookie。
type Client struct {
	HTTP *http.Client
}

// NewClient 构造客户端。
//
// **不设整体超时**：时长由请求自带的 context 决定（浏览器断连即取消）。
// 与 Node 的 fetch 一致——长音频解析本来就可能跑几十秒。
func NewClient() *Client {
	return &Client{HTTP: &http.Client{
		// 转发要自己看 3xx 的 Location（/song/url/v1_302 之类的重定向端点），
		// 所以一律不跟随
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}}
}

// Response 是一次上游调用的结果。
type Response struct {
	Status int
	// Body 是解析后的 JSON；Parsed 为 false 时 Body 为 nil（上游返回的不是 JSON）。
	Body       any
	Parsed     bool
	SetCookies []string
	Location   string
}

// Call 以 GET 调内部服务并解析 JSON，自动附加 timestamp。
//
// timestamp 是**绕过 apicache** 的关键：内部服务挂了 2 分钟的 apicache 中间件，
// 缓存 key 只含 method+URL（不含 cookie），不同登录态的同一个 URL 会命中同一份
// 缓存导致串味（匿名结果被 VIP 用户拿到），必须以唯一 URL 绕过。
func (c *Client) Call(ctx context.Context, base, path, cookieHeader string) (*Response, error) {
	separator := "?"
	if containsByte(path, '?') {
		separator = "&"
	}
	target := base + path + separator + "timestamp=" + strconv.FormatInt(time.Now().UnixMilli(), 10)
	return c.Do(ctx, http.MethodGet, target, nil, "", cookieHeader)
}

// Do 发一次请求并归一化响应。
//
// 上游重定向不跟随，Location 原样带回（forward 层据此回 `{code:'REDIRECT'}`）。
func (c *Client) Do(
	ctx context.Context,
	method, target string,
	body []byte,
	contentType, cookieHeader string,
) (*Response, error) {
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, target, reader)
	if err != nil {
		return nil, err
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	if cookieHeader != "" {
		req.Header.Set("Cookie", cookieHeader)
	}

	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	return DecodeUpstream(resp)
}

// DecodeUpstream 把上游响应读成 Response（JSON 解析失败时 Parsed=false）。
//
// 空响应体按「成功解析出的 null」处理——Node 是 `text ? JSON.parse(text) : null`，
// 空串不会抛错，而是得到 null。
func DecodeUpstream(resp *http.Response) (*Response, error) {
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	result := &Response{
		Status:     resp.StatusCode,
		SetCookies: resp.Header.Values("Set-Cookie"),
		Location:   resp.Header.Get("Location"),
	}
	if len(raw) == 0 {
		result.Parsed = true
		return result, nil
	}
	var parsed any
	if err := json.Unmarshal(raw, &parsed); err == nil {
		result.Body = parsed
		result.Parsed = true
	}
	return result, nil
}

// Probe 探测内部服务是否可达（对应 Node 的 waitForApiReachable / getNcmApiBase 非空）。
func (c *Client) Probe(ctx context.Context, base string) error {
	probeCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(probeCtx, http.MethodGet, base+"/", nil)
	if err != nil {
		return err
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	_ = resp.Body.Close()
	return nil
}

// extractSongURLData 取 /song/url/v1 响应里的 data[0]。
func extractSongURLData(body any) map[string]any {
	root, ok := body.(map[string]any)
	if !ok {
		return nil
	}
	data, ok := root["data"].([]any)
	if !ok || len(data) == 0 {
		return nil
	}
	first, ok := data[0].(map[string]any)
	if !ok {
		return nil
	}
	return first
}

// containsByte 是 strings.ContainsRune 的字节版（只用来判断 '?'）。
func containsByte(value string, target byte) bool {
	for index := 0; index < len(value); index++ {
		if value[index] == target {
			return true
		}
	}
	return false
}

// errUpstream 包装上游错误，便于路由层统一映射 502。
func errUpstream(err error) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("NCM 上游请求失败: %w", err)
}
