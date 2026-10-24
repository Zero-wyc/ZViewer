package bilibili

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"regexp"
	"strings"

	qrcode "github.com/skip2/go-qrcode"
)

// 账号域：扫码登录、Cookie 校验、账号信息缓存。
//
// 对应 routes/stream/bilibili-account.routes.ts + helpers.ts 的服务层部分。
// 与解析链的区别是这里**不碰解析状态**：只做「B站 账号是谁」这一件事，
// 结果按 userId 缓存 5 分钟（与 cache.ts 的 USER_INFO_CACHE_TTL_MS 一致）。

const (
	// navURL 是 B站 账号信息接口（登录态判定的事实源）。
	navURL = "https://api.bilibili.com/x/web-interface/nav"
	// qrGenerateURL / qrPollURL 是 passport 的扫码登录接口。
	qrGenerateURL = "https://passport.bilibili.com/x/passport-login/web/qrcode/generate"
	qrPollURL     = "https://passport.bilibili.com/x/passport-login/web/qrcode/poll"

	// maxSSORedirects 与 helpers.ts#fetchCookiesFromSsoUrl 的 maxRedirects 一致。
	maxSSORedirects = 10
)

var (
	// midPattern 取 Cookie 里的 DedeUserID（B站 账号 mid）。
	midPattern = regexp.MustCompile(`(?:^|;\s*)DedeUserID=(\d+)`)
	// csrfPattern 取 Cookie 里的 bili_jct（写操作 csrf）。
	csrfPattern = regexp.MustCompile(`(?:^|;\s*)bili_jct=([^;]+)`)
)

// NavInfo 是 x/web-interface/nav 的 data 载荷（字段子集）。
type NavInfo struct {
	IsLogin   bool   `json:"isLogin"`
	Mid       int64  `json:"mid"`
	Uname     string `json:"uname"`
	Face      string `json:"face"`
	VipStatus int    `json:"vipStatus"`
	VipType   int    `json:"vipType"`
}

// NormalizeImageURL 把 B站 返回的图片地址补全为 HTTPS 绝对地址。
//
// B站 有些接口回 `//i0.hdslb.com/...`（协议相对），有些回 `http://`。
// 前者直接交给前端会按当前页面协议解析，代理链路上就会 404。
func NormalizeImageURL(raw string) string {
	if raw == "" {
		return ""
	}
	if strings.HasPrefix(raw, "//") {
		return "https:" + raw
	}
	lower := strings.ToLower(raw)
	if strings.HasPrefix(lower, "http://") {
		return "https://" + raw[len("http://"):]
	}
	if strings.HasPrefix(lower, "http://") || strings.HasPrefix(lower, "https://") {
		return raw
	}
	return "https://" + raw
}

// ExtractMid 从 Cookie 中取 DedeUserID。
func ExtractMid(cookie string) string {
	if m := midPattern.FindStringSubmatch(cookie); len(m) == 2 {
		return m[1]
	}
	return ""
}

// ExtractCSRF 从 Cookie 中取 bili_jct；缺失返回空串。
func ExtractCSRF(cookie string) string {
	if m := csrfPattern.FindStringSubmatch(cookie); len(m) == 2 {
		return m[1]
	}
	return ""
}

// Nav 查询账号信息。
//
// 注意不能传 IgnoreBizCode：未登录时 B站 回 code=-101，Node 侧的
// bilibiliFetch 会把它当业务错误抛出，`/user-info` 的 catch 分支依赖这个
// 错误文案（「B站 API 业务错误 [-101] 账号未登录: …」）原样透给前端。
func (s *Service) Nav(ctx context.Context, cookie string) (*NavInfo, error) {
	env, err := s.Client.Fetch(ctx, navURL, FetchOptions{Cookie: cookie})
	if err != nil {
		return nil, err
	}
	var nav NavInfo
	if _, err := DecodeDataInto(env, &nav); err != nil {
		return nil, err
	}
	return &nav, nil
}

// ValidateCookie 校验 Cookie 是否可用，成功时写入用户信息缓存。
//
// 失败一律返回 false 而不是错误：调用方（扫码登录 / Cookie 登录）需要
// 用「能不能拿到昵称」来决定回哪句文案，错误细节只进日志。
func (s *Service) ValidateCookie(ctx context.Context, userID, cookie string) (UserInfo, bool) {
	nav, err := s.Nav(ctx, cookie)
	if err != nil {
		log.Printf("[bilibili] cookie validation error: %v", err)
		return UserInfo{}, false
	}
	if !nav.IsLogin {
		log.Printf("[bilibili] cookie validation failed: isLogin=false")
		return UserInfo{}, false
	}
	info := UserInfo{
		Name:      nav.Uname,
		Avatar:    NormalizeImageURL(nav.Face),
		Mid:       nav.Mid,
		VipStatus: nav.VipStatus,
		VipType:   nav.VipType,
	}
	s.Caches.SetUserInfo(userID, info)
	return info, true
}

// QRCode 是扫码登录二维码。
type QRCode struct {
	QrcodeKey string
	URL       string
}

// ErrQRCodeInvalid 表示上游没有下发可用的二维码 key/url。
//
// 单独一个哨兵值是为了让路由层区分两种 500 文案：缺字段回「获取二维码失败」，
// 其余（请求失败、渲染失败）回「生成二维码失败」。
var ErrQRCodeInvalid = errors.New("获取二维码失败")

// GenerateQRCode 申请一张登录二维码。
func (s *Service) GenerateQRCode(ctx context.Context) (*QRCode, error) {
	env, err := s.Client.Fetch(ctx, qrGenerateURL, FetchOptions{})
	if err != nil {
		return nil, err
	}
	var data struct {
		URL       string `json:"url"`
		QrcodeKey string `json:"qrcode_key"`
	}
	if _, err := DecodeDataInto(env, &data); err != nil {
		return nil, err
	}
	if data.QrcodeKey == "" || data.URL == "" {
		return nil, ErrQRCodeInvalid
	}
	return &QRCode{QrcodeKey: data.QrcodeKey, URL: data.URL}, nil
}

// QRDataURL 把二维码内容渲染成 PNG data URL。
//
// Node 用 qrcode.toDataURL(url)，默认 PNG + 中等纠错。尺寸由前端 CSS 缩放，
// 这里固定 256px 是为了不让 4K 屏把二维码拉成马赛克。
func QRDataURL(content string) (string, error) {
	png, err := qrcode.Encode(content, qrcode.Medium, 256)
	if err != nil {
		return "", err
	}
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(png), nil
}

// QRPollResult 是一次轮询的结果。
type QRPollResult struct {
	// Code 是新版接口 data.code（86101 未扫码 / 86090 已扫码 / 86038 过期）。
	Code int
	// Status 是旧版接口的 data.status；新版不下发，零值需要由调用方当成 -1。
	Status       int
	HasStatus    bool
	Message      string
	URL          string
	RefreshToken string
	// SetCookie 是旧版流程在响应头里直接下发的 Cookie（名值对，'; ' 连接）。
	SetCookie string
}

// PollQRCode 轮询扫码状态。
//
// 走裸 HTTP 而不是 Fetch：poll 的载荷里 code 有两层（顶层与 data.code），
// 且旧版流程的登录 Cookie 直接在响应头里，必须自己收 Set-Cookie。
func (s *Service) PollQRCode(ctx context.Context, key string) (*QRPollResult, error) {
	target := qrPollURL + "?qrcode_key=" + encodeComponent(key)
	resp, body, err := s.rawGet(ctx, target, "")
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("B站 API 请求失败 [%d] %s: %s", resp.StatusCode, http.StatusText(resp.StatusCode), target)
	}
	var payload struct {
		Data struct {
			Code         int    `json:"code"`
			Status       *int   `json:"status"`
			Message      string `json:"message"`
			URL          string `json:"url"`
			RefreshToken string `json:"refresh_token"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, fmt.Errorf("B站 接口返回异常响应（非 JSON）: %s", target)
	}
	result := &QRPollResult{
		Code:         payload.Data.Code,
		Message:      payload.Data.Message,
		URL:          payload.Data.URL,
		RefreshToken: payload.Data.RefreshToken,
		SetCookie:    joinResponseCookies(resp),
	}
	if payload.Data.Status != nil {
		result.Status = *payload.Data.Status
		result.HasStatus = true
	}
	return result, nil
}

// QRLoginStatus 把新版 data.code 映射成前端约定的 0/1/2/3。
//
//	0 未扫码 / 1 已扫码未确认 / 2 已确认登录 / 3 二维码过期
//
// 映射表与 bilibili-account.routes.ts 逐条对应；未命中时回落 `status ?? -1`，
// 旧版接口就是靠这个字段表达状态的。
func QRLoginStatus(poll *QRPollResult) int {
	status := -1
	if poll.HasStatus {
		status = poll.Status
	}
	switch {
	case poll.Code == 0 && poll.URL != "":
		return 2
	case poll.Code == 86101:
		return 0
	case poll.Code == 86090:
		return 1
	case poll.Code == 86038:
		return 3
	}
	return status
}

// CollectSSOCookie 跟随扫码登录成功后返回的跨域 URL，收集最终登录 Cookie。
//
// passport 的 poll 只给一个 `https://passport.biligame.com/...` 之类的跳转链，
// 各跳转点的 Set-Cookie 才是真正的登录凭据（SESSDATA / bili_jct / DedeUserID）。
// 必须手动逐跳（redirect: manual）才能把每一跳的 Set-Cookie 都收下来。
func (s *Service) CollectSSOCookie(ctx context.Context, ssoURL string) (string, error) {
	client := &http.Client{
		Transport: s.Client.http.Transport,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}

	var order []string
	values := make(map[string]string)
	seen := make(map[string]bool)
	current := ssoURL

	for i := 0; i <= maxSSORedirects; i++ {
		if seen[current] {
			log.Printf("[bilibili] sso redirect loop detected at %s", current)
			break
		}
		seen[current] = true

		reqCtx, cancel := context.WithTimeout(ctx, requestTimeout)
		req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, current, nil)
		if err != nil {
			cancel()
			return "", err
		}
		req.Header.Set("User-Agent", defaultUserAgent)
		req.Header.Set("Referer", "https://www.bilibili.com")
		if len(order) > 0 {
			parts := make([]string, 0, len(order))
			for _, name := range order {
				parts = append(parts, name+"="+values[name])
			}
			req.Header.Set("Cookie", strings.Join(parts, "; "))
		}

		resp, err := client.Do(req)
		if err != nil {
			cancel()
			return "", err
		}
		for _, c := range resp.Cookies() {
			if _, ok := values[c.Name]; !ok {
				order = append(order, c.Name)
			}
			values[c.Name] = c.Value
		}
		location := resp.Header.Get("Location")
		status := resp.StatusCode
		// 响应体不读也必须关，否则连接池里的连接永远不归还。
		_, _ = io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		cancel()

		if location == "" {
			break
		}
		next, parseErr := url.Parse(location)
		if parseErr != nil {
			break
		}
		base, baseErr := url.Parse(current)
		if baseErr != nil {
			break
		}
		current = base.ResolveReference(next).String()
		if status < 300 || status >= 400 {
			break
		}
	}

	// 三个键缺一不可：缺 SESSDATA 等于没登录，缺 bili_jct 收藏/投币全都会 -400，
	// 缺 DedeUserID 则后面所有「按 mid 查收藏夹」的请求都会打空。
	for _, required := range []string{"SESSDATA", "bili_jct", "DedeUserID"} {
		if _, ok := values[required]; !ok {
			return "", fmt.Errorf("sso cookie missing required key: %s", required)
		}
	}

	parts := make([]string, 0, len(order))
	for _, name := range order {
		parts = append(parts, name+"="+values[name])
	}
	return strings.Join(parts, "; "), nil
}

// rawGet 发起一次裸 HTTP GET（带 B站 默认 UA / Referer），返回响应与响应体。
func (s *Service) rawGet(ctx context.Context, target, cookie string) (*http.Response, []byte, error) {
	reqCtx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, target, nil)
	if err != nil {
		return nil, nil, err
	}
	req.Header.Set("User-Agent", defaultUserAgent)
	req.Header.Set("Referer", "https://www.bilibili.com")
	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}

	resp, err := s.Client.http.Do(req)
	if err != nil {
		if errors.Is(reqCtx.Err(), context.DeadlineExceeded) && ctx.Err() == nil {
			return nil, nil, fmt.Errorf("B站 请求超时 (%dms): %s", requestTimeout.Milliseconds(), target)
		}
		return nil, nil, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, nil, err
	}
	return resp, body, nil
}

// joinResponseCookies 把 Set-Cookie 压成 "name=value; name=value"。
func joinResponseCookies(resp *http.Response) string {
	cookies := resp.Cookies()
	if len(cookies) == 0 {
		return ""
	}
	parts := make([]string, 0, len(cookies))
	for _, c := range cookies {
		if c.Name == "" {
			continue
		}
		parts = append(parts, c.Name+"="+c.Value)
	}
	return strings.Join(parts, "; ")
}
