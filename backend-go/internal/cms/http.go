package cms

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

// 上游文本获取，对应 services/anisubs/httpClient.ts#fetchText 的 Go 版。
//
// Node 版在 fetch 失败后会退到 PowerShell（借 .NET 的 TLS 指纹绕过
// Cloudflare）。Go 的 TLS 栈本来就是自己的指纹，没有「Node 指纹被拦」这个
// 问题，所以这里**不迁 PowerShell 兜底**——真遇到按指纹拦的站点，
// 该修的是站点侧的 UA/Referer，而不是在服务端起子进程。

// DefaultUserAgent 与 Node 侧 cmsProvider.ts 的 DEFAULT_USER_AGENT 一致。
const DefaultUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

// fetchResult 是 fetchText 的返回结构。
type fetchResult struct {
	Status int
	Body   string
	OK     bool
	Error  string
}

// fetchText 获取 URL 文本内容（自动跟随重定向、按 charset 解码）。
//
// 失败不返回 error：调用方（配置加载器 / CMS provider）需要区分
// 「HTTP 非 2xx」与「网络失败」，并统一格式化成 Node 的
// `拉取配置失败 [0]: url (socket hang up)` 这类文案。
func fetchText(ctx context.Context, url string, headers map[string]string, timeout time.Duration) *fetchResult {
	reqCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, url, nil)
	if err != nil {
		return &fetchResult{Status: 0, Error: err.Error()}
	}
	for key, value := range headers {
		req.Header.Set(key, value)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		message := err.Error()
		if errors.Is(reqCtx.Err(), context.DeadlineExceeded) {
			message = fmt.Sprintf("请求超时 (%dms)", timeout.Milliseconds())
		}
		return &fetchResult{Status: 0, Error: message}
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return &fetchResult{Status: resp.StatusCode, Error: err.Error()}
	}

	return &fetchResult{
		Status: resp.StatusCode,
		Body:   decodeBody(raw, resp.Header.Get("Content-Type")),
		OK:     resp.StatusCode >= 200 && resp.StatusCode < 300,
	}
}

// charsetPattern 从 Content-Type 里取 charset 标签。
var charsetPattern = regexp.MustCompile(`charset\s*=\s*"?([\w-]+)"?`)

// decodeBody 按字符集解码响应字节。
//
// 优先级与 Node 的 decodeBody 完全一致：
//  1. 服务器声明了非 UTF-8 的 charset → 按它解；
//  2. 否则严格 UTF-8 嗅探；
//  3. 失败回退 GB18030（GB2312/GBK 的超集，国内 TVBox 配置/CMS 站点常见编码）。
//
// 这一步不能省：Node 的 `res.text()` 在 charset 缺失时按 UTF-8 硬解，
// GBK 源站的中文片名会整片乱码，而「搜索不到影片」的表象会让人去查接口。
func decodeBody(raw []byte, contentType string) string {
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
