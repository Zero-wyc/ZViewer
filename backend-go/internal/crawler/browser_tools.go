package crawler

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"
)

// 给 LLM 工具用的浏览器包装方法。
//
// CDP 只提供 Evaluate/Navigate 等原语，这里按工具的语义组合：
// 读取文本、读 HTML、点元素、看 Cookie 概要。所有方法都要求浏览器
// 已启动（Start 过），否则返回 browser_error。

// Status 返回浏览器当前状态（供 browser_status 工具与 GUI）。
func (b *Browser) Status() map[string]any {
	b.mu.Lock()
	defer b.mu.Unlock()
	bin, binErr := FindBrowserBinary(b.opts.Bin)
	status := map[string]any{
		"available": binErr == nil,
		"running":   b.client != nil,
		"port":      b.port,
		"headless":  b.opts.Headless,
	}
	if binErr == nil {
		status["binary"] = bin
	} else {
		status["error"] = binErr.Error()
	}
	if b.client != nil {
		if url, err := b.evaluateURL(); err == nil {
			status["pageUrl"] = url
		}
	}
	return status
}

// OpenPage 打开页面并等待渲染，返回标题与正文摘要。
func (b *Browser) OpenPage(ctx context.Context, target string, waitSec float64) (map[string]any, error) {
	if err := b.Start(ctx); err != nil {
		return nil, err
	}
	if err := b.Navigate(ctx, target); err != nil {
		return nil, err
	}
	if waitSec > 0 {
		if waitSec > 10 {
			waitSec = 10
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(time.Duration(waitSec * float64(time.Second))):
		}
	}
	title, _ := b.Evaluate(ctx, "document.title")
	titleText, _ := title.(string)
	text, _, textErr := b.PageText(ctx, "", 4000)
	if textErr != nil {
		text = ""
	}
	return map[string]any{
		"url":   target,
		"title": titleText,
		"text":  text,
	}, nil
}

// PageText 读取当前页面正文；selector 非空时限定区域，maxChars 截断。
func (b *Browser) PageText(ctx context.Context, selector string, maxChars int) (string, string, error) {
	if err := b.ensureStarted(ctx); err != nil {
		return "", "", err
	}
	if maxChars <= 0 {
		maxChars = 8000
	}
	expression := "document.body ? document.body.innerText : document.documentElement.innerText"
	if trimmed := strings.TrimSpace(selector); trimmed != "" {
		escaped, _ := json.Marshal(trimmed)
		expression = fmt.Sprintf("(document.querySelector(%s) || {innerText: ''}).innerText", string(escaped))
	}
	value, err := b.Evaluate(ctx, expression)
	if err != nil {
		return "", "", err
	}
	text, _ := value.(string)
	if maxChars > 0 && len([]rune(text)) > maxChars {
		text = truncateRunes(text, maxChars)
	}
	pageURL, _ := b.evaluateURL()
	return text, pageURL, nil
}

// PageHTML 读取渲染后的 HTML，maxChars 截断（0 = 不限制但最多 200KB）。
func (b *Browser) PageHTML(ctx context.Context, maxChars int) (string, string, error) {
	if err := b.ensureStarted(ctx); err != nil {
		return "", "", err
	}
	htmlText, err := b.HTML(ctx)
	if err != nil {
		return "", "", err
	}
	if maxChars <= 0 {
		maxChars = 200000
	}
	if len([]rune(htmlText)) > maxChars {
		htmlText = truncateRunes(htmlText, maxChars)
	}
	pageURL, _ := b.evaluateURL()
	return htmlText, pageURL, nil
}

// EvalValue 执行任意 JS 表达式（支持 await），返回值与当前页面地址。
func (b *Browser) EvalValue(ctx context.Context, script string) (any, string, error) {
	if err := b.ensureStarted(ctx); err != nil {
		return nil, "", err
	}
	value, err := b.Evaluate(ctx, script)
	if err != nil {
		return nil, "", err
	}
	pageURL, _ := b.evaluateURL()
	return value, pageURL, nil
}

// Click 点击第一个匹配的元素（scrollIntoView 后调用原生 click）。
func (b *Browser) Click(ctx context.Context, selector string) (map[string]any, error) {
	if err := b.ensureStarted(ctx); err != nil {
		return nil, err
	}
	escaped, _ := json.Marshal(strings.TrimSpace(selector))
	script := fmt.Sprintf(`(() => {
		const el = document.querySelector(%s);
		if (!el) return {clicked: false, reason: 'not found'};
		el.scrollIntoView({block: 'center'});
		el.click();
		return {clicked: true, tag: el.tagName};
	})()`, string(escaped))
	value, err := b.Evaluate(ctx, script)
	if err != nil {
		return nil, err
	}
	result, _ := value.(map[string]any)
	if result == nil {
		result = map[string]any{"clicked": false}
	}
	return result, nil
}

// CookieSummary 返回当前页面的 Cookie 名称与数量（不含值）。
func (b *Browser) CookieSummary(ctx context.Context) (map[string]any, error) {
	if err := b.ensureStarted(ctx); err != nil {
		return nil, err
	}
	value, err := b.Evaluate(ctx, `document.cookie`)
	if err != nil {
		return nil, err
	}
	raw, _ := value.(string)
	names := make([]string, 0, 8)
	seen := map[string]bool{}
	for _, part := range strings.Split(raw, ";") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		name := part
		if idx := strings.Index(part, "="); idx >= 0 {
			name = part[:idx]
		}
		name = strings.TrimSpace(name)
		if name == "" || seen[name] {
			continue
		}
		seen[name] = true
		names = append(names, name)
	}
	sort.Strings(names)
	pageURL, _ := b.evaluateURL()
	host := ""
	if pageURL != "" {
		host = HostOf(pageURL)
	}
	return map[string]any{
		"site":    host,
		"names":   names,
		"count":   len(names),
		"pageUrl": pageURL,
	}, nil
}

// evaluateURL 读当前页面地址（失败返回空串，不当作错误）。
func (b *Browser) evaluateURL() (string, error) {
	value, err := b.Evaluate(context.Background(), "location.href")
	if err != nil {
		return "", err
	}
	text, _ := value.(string)
	return text, nil
}

// ensureStarted 没启动就先启动（工具调用方不关心复用细节）。
func (b *Browser) ensureStarted(ctx context.Context) error {
	if b.clientLocked() != nil {
		return nil
	}
	return b.Start(ctx)
}
