package anisubs

import (
	"context"
	"fmt"
	"net/url"
	"time"

	"zviewer/backend/internal/webfetch"
)

// 上游 HTML / 订阅抓取，对应 services/anisubs/httpClient.ts + scraper.ts 的抓取部分。
//
// Node 版在 fetch 失败后会退到 PowerShell（借 .NET 的 TLS 指纹过 Cloudflare）。
// Go 的 TLS 栈本来就是独立指纹，不迁那条兜底（与 internal/cms 同一取舍）。

// defaultUserAgent 与 Node 侧 scraper.ts 的 DEFAULT_USER_AGENT 一致。
const defaultUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

// browserAccept 是浏览器级 Accept 头。
//
// 有的站点只检查「像不像浏览器」，把 RSS 的 accept 也一起带上是刻意的
// （ani-subs 的订阅 URL 常常就是 feed 地址）。
const browserAccept = "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,application/rss+xml,application/atom+xml,*/*;q=0.8"

// browserAcceptLanguage 是浏览器级 Accept-Language。
const browserAcceptLanguage = "zh-CN,zh;q=0.9,en;q=0.8,ja;q=0.7"

// fetchTimeout 是单次页面抓取的上限（Node 默认 20s）。
const fetchTimeout = 20 * time.Second

// subscriptionTimeout 是订阅拉取的上限（Node 显式传 30s）。
const subscriptionTimeout = 30 * time.Second

// BuildBrowserHeaders 构造浏览器级请求头。
//
// 注意：**不要在这里加 Accept-Encoding**。浏览器会写 `gzip, deflate, br`，
// 照抄给 Go 会让服务端回 brotli，而 net/http 只会自动解 gzip（且只在它自己
// 加的请求头时才解），最后拿到的是一堆二进制。webfetch 也会兜底剥掉这个头。
func BuildBrowserHeaders(rawURL string, extra map[string]string) map[string]string {
	headers := map[string]string{
		"User-Agent":                defaultUserAgent,
		"Accept":                    browserAccept,
		"Accept-Language":           browserAcceptLanguage,
		"Cache-Control":             "no-cache",
		"Pragma":                    "no-cache",
		"Sec-Ch-Ua":                 `"Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"`,
		"Sec-Ch-Ua-Mobile":          "?0",
		"Sec-Ch-Ua-Platform":        `"Windows"`,
		"Sec-Fetch-Dest":            "document",
		"Sec-Fetch-Mode":            "navigate",
		"Sec-Fetch-Site":            "none",
		"Sec-Fetch-User":            "?1",
		"Upgrade-Insecure-Requests": "1",
	}

	if parsed, err := url.Parse(rawURL); err == nil && parsed.Scheme != "" && parsed.Host != "" {
		origin := parsed.Scheme + "://" + parsed.Host
		headers["Origin"] = origin
		headers["Referer"] = origin + "/"
	}
	for key, value := range extra {
		headers[key] = value
	}
	return headers
}

// IsCloudflareBlocked 判断响应是否被 Cloudflare 挑战页拦下。
func IsCloudflareBlocked(result *webfetch.Result) bool {
	return webfetch.IsCloudflareBlocked(result.Status, result.Headers)
}

// cloudflareError 是统一的拦截文案（前端会原样展示给用户）。
func cloudflareError(status int) error {
	return fmt.Errorf("该数据源被 Cloudflare 防护拦截 [%d]，服务器无法直接访问", status)
}

// requestErrorSuffix 拼上 Node 在错误信息尾部附带的 ` (detail)`。
func requestErrorSuffix(result *webfetch.Result) string {
	if result.Error == "" {
		return ""
	}
	return " (" + result.Error + ")"
}

// fetchHTML 抓取页面 HTML。
func fetchHTML(ctx context.Context, rawURL string, cookies string) (string, error) {
	var extra map[string]string
	if cookies != "" {
		extra = map[string]string{"Cookie": cookies}
	}
	result := webfetch.Fetch(ctx, rawURL, webfetch.Options{
		Headers: BuildBrowserHeaders(rawURL, extra),
		Timeout: fetchTimeout,
	})
	if IsCloudflareBlocked(result) {
		return "", cloudflareError(result.Status)
	}
	if !result.OK {
		return "", fmt.Errorf("请求失败 [%d]: %s%s", result.Status, rawURL, requestErrorSuffix(result))
	}
	return result.Body, nil
}

// FetchSubscription 拉取 ani-subs 订阅 JSON。
//
// 走 GitHub CDN 前缀（订阅多半托管在 raw.githubusercontent.com）；
// 失败时若命中内置的默认订阅则回退本地副本——那两个默认订阅挂在
// Cloudflare 后面，Node 侧的 TLS 指纹会被拦，内嵌副本是最后可用性保障。
func FetchSubscription(ctx context.Context, rawURL string) (*Subscription, error) {
	proxied := proxyGitHubURL(rawURL)
	result := webfetch.Fetch(ctx, proxied, webfetch.Options{
		Headers: map[string]string{
			"User-Agent": defaultUserAgent,
			"Accept":     "application/json",
		},
		Timeout: subscriptionTimeout,
	})

	var fetchErr error
	if !result.OK {
		fetchErr = fmt.Errorf("获取 ani-subs 订阅失败 [%d]: %s%s", result.Status, proxied, requestErrorSuffix(result))
	}

	if fetchErr == nil {
		subscription, err := decodeSubscription(result.Body)
		if err == nil {
			return subscription, nil
		}
		fetchErr = err
	}

	if fallback := localFallback(rawURL); fallback != nil {
		return fallback, nil
	}
	return nil, fetchErr
}

// proxyGitHubURL 与 Node 的 proxyGitHubUrl 逐字一致（前缀式代理）。
//
// 实现放在 webfetch 里：Kazumi 的规则拉取也要走同一条改写，两处各写一份
// 迟早会分叉（比如只改一边的代理域名）。
func proxyGitHubURL(raw string) string {
	return webfetch.ProxyGitHubURL(raw)
}
