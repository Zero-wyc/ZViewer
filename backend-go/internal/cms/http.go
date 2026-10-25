package cms

import (
	"context"
	"time"

	"zviewer/backend/internal/webfetch"
)

// 上游文本获取：薄适配层，真正的实现在 internal/webfetch。
//
// 抽出去的动机：anisubs 的抓取逻辑与这里逐字相同（同样的 charset 嗅探、
// 同样的「HTTP 非 2xx 不返回 error」约定），两份拷贝迟早会漂。
//
// Node 版在 fetch 失败后会退到 PowerShell（借 .NET 的 TLS 指纹绕过
// Cloudflare）。Go 的 TLS 栈本来就是自己的指纹，没有「Node 指纹被拦」这个
// 问题，所以这里**不迁 PowerShell 兜底**。

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
	result := webfetch.Fetch(ctx, url, webfetch.Options{
		Headers: headers,
		Timeout: timeout,
	})
	return &fetchResult{
		Status: result.Status,
		Body:   result.Body,
		OK:     result.OK,
		Error:  result.Error,
	}
}

// decodeBody 按字符集解码响应字节（测试与个别调用点直接用）。
func decodeBody(raw []byte, contentType string) string {
	return webfetch.DecodeBody(raw, contentType)
}
