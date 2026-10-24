package anime

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"time"
)

// 动漫源的外部取数（RSS 订阅、第三方 HTTP 源）。
//
// Node 侧直接用全局 fetch：GET、跟随重定向、UTF-8 文本、失败抛错。
// Go 这里保持同样的语义，只额外给了 30s 超时——Node 的 fetch 没有超时，
// 一个挂住的上游会永久占着请求；Go 里挂住即泄漏 goroutine，必须收口。

// fetchTimeout 是单次上游请求的上限。
const fetchTimeout = 30 * time.Second

// httpClient 是包级客户端（单测用它注入假 transport）。
var httpClient = http.DefaultClient

// fetchResponse 是一次上游响应。
type fetchResponse struct {
	Status int
	Body   []byte
}

// httpGet 发起 GET 请求并读全响应体。
//
// 非 2xx 不返回 error（Node 的 fetch 也是 resolve），由调用方按各自的
// 文案抛「[status]: url」。
func httpGet(ctx context.Context, target string, headers map[string]string) (*fetchResponse, error) {
	reqCtx, cancel := context.WithTimeout(ctx, fetchTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, target, nil)
	if err != nil {
		return nil, err
	}
	for key, value := range headers {
		req.Header.Set(key, value)
	}

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	return &fetchResponse{Status: resp.StatusCode, Body: body}, nil
}

// getJSON 取 JSON 并解码到 out。
func getJSON(ctx context.Context, target string, headers map[string]string, out any) error {
	resp, err := httpGet(ctx, target, headers)
	if err != nil {
		return err
	}
	return json.Unmarshal(resp.Body, out)
}
