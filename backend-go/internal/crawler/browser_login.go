package crawler

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"
)

// 浏览器可见窗口与登录态导出。
//
// Python 版 browser.py 支持「无头 ↔ 可见」两种模式共用一个 profile，
// 人工登录后用 save_login 把 Cookie 存成账号。Go 侧按同样的语义实现：
//   - 切换模式 = 关掉当前实例、按新模式的参数重启（profile 不变，登录态保留）；
//   - Cookie 通过 CDP Network.getAllCookies 读取，只取匹配站点的部分。

// Mode 返回当前模式（"" / "headless" / "visible"）。
func (b *Browser) Mode() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.client == nil {
		return ""
	}
	if b.opts.Headless {
		return "headless"
	}
	return "visible"
}

// LaunchMode 按指定模式重启浏览器并可选打开页面。mode 为 headless / visible。
func (b *Browser) LaunchMode(ctx context.Context, mode, target string) error {
	headless := mode != "visible"
	b.mu.Lock()
	b.opts.Headless = headless
	b.mu.Unlock()
	// 先关掉旧实例：同一 debug 端口只能有一个 owner，否则新实例连不上。
	b.closeSession(ctx)
	return b.Start(ctx)
}

// closeSession 关掉 CDP 连接并让浏览器进程退出（不动 profile 目录）。
func (b *Browser) closeSession(ctx context.Context) {
	b.mu.Lock()
	client := b.client
	b.client = nil
	b.mu.Unlock()
	if client != nil {
		// Browser.close 会连带关掉整个浏览器；失败也无所谓，下面还会按端口兜底。
		_ = client.Call(ctx, "Browser.close", map[string]any{}, nil)
		client.Close()
	} else if ws := fetchWebSocketURL(ctx, fmt.Sprintf("http://127.0.0.1:%d/json/version", b.port)); ws != "" {
		// 孤儿实例（上次切换留下的）：连 browser-level target 让它自己退出。
		if orphan, err := newCDPClient(ctx, ws); err == nil {
			_ = orphan.Call(ctx, "Browser.close", map[string]any{}, nil)
			orphan.Close()
		}
	}
	// 端口释放有延迟，等一小会儿再让 Start 去抢。
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if fetchWebSocketURL(ctx, fmt.Sprintf("http://127.0.0.1:%d/json/version", b.port)) == "" {
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(200 * time.Millisecond):
		}
	}
}

// Show 把窗口显示出来（必要时从无头切到可见），并打开指定页面。
func (b *Browser) Show(ctx context.Context, target string) (map[string]any, error) {
	trimmed := strings.TrimSpace(target)
	if b.Mode() != "visible" {
		if err := b.LaunchMode(ctx, "visible", ""); err != nil {
			return nil, err
		}
	}
	if trimmed != "" {
		if err := b.Navigate(ctx, trimmed); err != nil {
			return nil, err
		}
	}
	pageURL, _ := b.evaluateURL()
	return map[string]any{
		"success": true,
		"mode":    "visible",
		"page":    map[string]any{"url": pageURL},
		"message": "浏览器窗口已经显示，请在同一窗口里完成登录。",
	}, nil
}

// Hide 收起窗口转回无头（保留页面与 profile 登录态）。
func (b *Browser) Hide(ctx context.Context) (map[string]any, error) {
	if b.Mode() == "" {
		return map[string]any{"success": true, "mode": "", "message": "浏览器没有在运行。"}, nil
	}
	if b.Mode() != "visible" {
		return map[string]any{
			"success": true, "mode": "headless",
			"message": "浏览器本来就在后台运行。",
		}, nil
	}
	current, _ := b.evaluateURL()
	if strings.TrimSpace(current) == "" {
		current = "about:blank"
	}
	if err := b.LaunchMode(ctx, "headless", current); err != nil {
		return nil, err
	}
	return map[string]any{
		"success": true, "mode": "headless",
		"message": "已收起浏览器窗口，转回后台无头运行。",
	}, nil
}

// OpenLogin 是 GUI「显示登录窗口」调用的入口，返回状态快照。
func (b *Browser) OpenLogin(ctx context.Context, target string) (map[string]any, error) {
	result, err := b.Show(ctx, target)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"success": true,
		"status":  b.Status(),
		"message": result["message"],
	}, nil
}

// CloseBrowser 关掉浏览器（GUI「关闭浏览器」）。
func (b *Browser) CloseBrowser(ctx context.Context) (map[string]any, error) {
	b.closeSession(ctx)
	return map[string]any{"success": true, "status": b.Status()}, nil
}

// ClearProfile 删除 profile 目录（仅浏览器已关闭时允许，避免删正在用的文件）。
func (b *Browser) ClearProfile() (map[string]any, error) {
	if b.Mode() != "" {
		return nil, newError("browser_error", "请先关闭浏览器再清空 profile", nil)
	}
	if strings.TrimSpace(b.opts.ProfileDir) == "" {
		return map[string]any{"success": true, "cleared": false}, nil
	}
	if err := os.RemoveAll(b.opts.ProfileDir); err != nil {
		return nil, newError("browser_error", "清空 profile 失败: "+err.Error(), nil)
	}
	_ = os.MkdirAll(b.opts.ProfileDir, 0o755)
	return map[string]any{"success": true, "cleared": true}, nil
}

// CookiesFor 读取匹配站点的 Cookie（含 domain 过滤）。
func (b *Browser) CookiesFor(ctx context.Context, site string) ([]map[string]any, error) {
	client := b.clientLocked()
	if client == nil {
		return nil, newError("browser_error", "浏览器未启动", nil)
	}
	// Network.getAllCookies 要求 Network 域已启用。
	_ = client.Call(ctx, "Network.enable", map[string]any{}, nil)
	var payload struct {
		Cookies []map[string]any `json:"cookies"`
	}
	if err := client.Call(ctx, "Network.getAllCookies", map[string]any{}, &payload); err != nil {
		return nil, err
	}
	needle := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(site), "."))
	matched := make([]map[string]any, 0, len(payload.Cookies))
	for _, cookie := range payload.Cookies {
		domain := strings.ToLower(strings.TrimPrefix(stringOf(cookie["domain"]), "."))
		if needle == "" || strings.HasSuffix(domain, needle) || strings.HasSuffix(needle, domain) {
			matched = append(matched, cookie)
		}
	}
	return matched, nil
}

// SaveLogin 把当前页面的 Cookie 存成账号，然后关闭浏览器。
func (b *Browser) SaveLogin(ctx context.Context, site, name string, accounts *AccountStore) (map[string]any, error) {
	site = strings.ToLower(strings.TrimSpace(site))
	if site == "" {
		return nil, ConfigError("缺少站点域名")
	}
	if accounts == nil {
		return nil, ConfigError("账号存储不可用")
	}
	cookies, err := b.CookiesFor(ctx, site)
	if err != nil {
		return nil, err
	}
	if len(cookies) == 0 {
		return nil, newError("browser_error",
			"没有在 "+site+" 捕获到 Cookie，请确认已在浏览器窗口里登录", nil)
	}
	parts := make([]string, 0, len(cookies))
	for _, cookie := range cookies {
		cookieName := stringOf(cookie["name"])
		if cookieName == "" {
			continue
		}
		parts = append(parts, cookieName+"="+stringOf(cookie["value"]))
	}
	if len(parts) == 0 {
		return nil, newError("browser_error", "没有捕获到有效 Cookie", nil)
	}
	accountName := strings.TrimSpace(name)
	if accountName == "" {
		accountName = site + " 登录"
	}
	saved, saveErr := accounts.Save(map[string]any{
		"name":    accountName,
		"site":    site,
		"cookies": strings.Join(parts, "; "),
		"notes":   "由离屏浏览器人工登录保存",
	})
	if saveErr != nil {
		return nil, saveErr
	}
	b.closeSession(ctx)
	encoded, _ := json.Marshal(saved)
	_ = encoded
	return map[string]any{
		"success": true,
		"account": PublicAccountView(saved, true),
		"cookies": len(parts),
		"status":  b.Status(),
	}, nil
}
