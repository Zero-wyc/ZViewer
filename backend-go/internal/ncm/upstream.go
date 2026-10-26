package ncm

import (
	"bytes"
	"compress/zlib"
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

// 上游域名，与 Node 版 util/config.json 的 APP_CONF 一致。
//
// 三个域名不能混用：api 走 interface.music.163.com、eapi 走
// interfacepc.music.163.com、weapi 走 www（music.163.com）。历史上有人把
// eapi 打到 music.163.com 导致 403，所以这里显式区分。
const (
	domainWeapi = "https://music.163.com"
	domainAPI   = "https://interface.music.163.com"
	domainEapi  = "https://interfacepc.music.163.com"
)

// 各通道的 User-Agent。网易按 UA 判断客户端类型，UA 与 os 不匹配会拿到异常响应。
const (
	uaWeapi    = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0"
	uaAPI      = "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36 Chrome/91.0.4472.164 NeteaseMusicDesktop/3.1.29.205117"
	uaEapi     = "NeteaseMusic/9.1.65.240927161425(9001065);Dalvik/2.1.0 (Linux; U; Android 14; 23127PN0CC Build/UKQ1.230804.001)"
	uaLinuxapi = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/60.0.3112.90 Safari/537.36"
	referer    = "https://music.163.com"
)

// osProfile 是某个通道缺省注入的客户端标识（对应 Node 的 osMap）。
type osProfile struct {
	OS       string
	AppVer   string
	OSVer    string
	Channel  string
	VersionC string
}

// profileFor 返回通道的缺省客户端标识。
//
// 显式区分是必须的：SDK 默认 os=ios，而网页通道必须 os=pc，否则
// personal_fm 之类的接口行为会漂（匿名只给 1 首而不是 3 首）。
func profileFor(mode crypto) osProfile {
	switch mode {
	case cryptoEapi:
		return osProfile{OS: "android", AppVer: "9.1.65", OSVer: "14", Channel: "xiaomi", VersionC: "140"}
	case cryptoLinuxapi:
		return osProfile{OS: "linux", AppVer: "1.2.1.0428", OSVer: "Deepin 20.9", Channel: "netease", VersionC: "140"}
	default:
		return osProfile{OS: "pc", AppVer: "3.1.17.204416", OSVer: "Microsoft-Windows-10-Professional-build-19045-64bit", Channel: "netease", VersionC: "140"}
	}
}

// Client 是网易云上游的调用器。
//
// 无全局状态：每次调用自带 cookie，可并发；不共享 cookie jar（有状态 jar 在
// 多用户后端里会串味——A 用户的 MUSIC_U 被 B 用户请求带上）。
type Client struct {
	HTTP *http.Client
	// DeviceID 是 eapi 的 deviceId 兜底值（cookie 里没有时使用）。
	DeviceID string
}

// NewClient 构造调用器。
//
// 不设 Timeout：单次请求时长交给调用方 context（音频解析本来就可能跑几十秒，
// 固定超时会误杀）。但连接与响应头必须有上限，否则上游黑洞会堆住 goroutine。
func NewClient() *Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.MaxIdleConnsPerHost = 8
	transport.ResponseHeaderTimeout = 20 * time.Second
	transport.TLSHandshakeTimeout = 10 * time.Second
	return &Client{
		HTTP:     &http.Client{Transport: transport},
		DeviceID: newDeviceID(),
	}
}

// Call 是一次上游调用的入参。
type Call struct {
	// Path 是网易云真实路径，形如 /api/song/detail。
	Path string
	// Crypto 是通道；空串按 api（明文）处理。
	Crypto crypto
	// Data 是业务参数（值保留原始类型：bool/数字/字符串）。
	Data map[string]any
	// Cookie 是入站请求的 cookie 原文（不含 os/appver 等补全项）。
	Cookie string
}

// Result 是一次上游调用的结果。
type upstreamResult struct {
	// Status 是上游 HTTP 状态码（网易云业务错误用 body.code 表达，通常是 200）。
	Status int
	// Body 是原始响应字节（正常是 JSON）。
	Body []byte
	// Cookies 是原始 Set-Cookie 头列表，供上层合并落库。
	Cookies []string
}

// Do 执行一次上游调用。
func (c *Client) Do(ctx context.Context, call Call) (*upstreamResult, error) {
	mode := call.Crypto
	if mode == "" {
		mode = cryptoAPI
	}
	profile := profileFor(mode)
	cookies := parseCookieHeader(call.Cookie)
	fillProfile(cookies, profile)

	apiURL := call.Path
	// eapi 的登录态在 params.header 里，必须先注入再加密（摘要含参数原文）。
	if mode == cryptoEapi {
		header := eapiHeader(cookies, profile, c.DeviceID)
		call.Data["header"] = header
		cookies = header
	}
	form, err := encrypt(mode, apiURL, call.Data, cookies["__csrf"])
	if err != nil {
		return nil, err
	}

	target, headers := c.target(mode, apiURL, cookies, profile)
	body := strings.NewReader(encodeForm(form))
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, target, body)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	// api/weapi/linuxapi 用原始 cookie 串 + 补全项；eapi 的 cookie 必须与
	// params 里的 header 完全一致，由 target() 单独组装。
	if mode != cryptoEapi {
		request.Header.Set("Cookie", cookieHeader(cookies))
	}

	response, err := c.HTTP.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(response.Body, 16<<20))
	if err != nil {
		return nil, err
	}
	if decoded, ok := inflate(raw); ok {
		raw = decoded
	}
	return &upstreamResult{
		Status:  response.StatusCode,
		Body:    raw,
		Cookies: response.Header.Values("Set-Cookie"),
	}, nil
}

// target 计算最终 URL 与附加请求头。
func (c *Client) target(mode crypto, apiPath string, cookies map[string]string, profile osProfile) (string, map[string]string) {
	headers := map[string]string{"User-Agent": uaWeapi}
	switch mode {
	case cryptoWeapi:
		headers["User-Agent"] = uaWeapi
		headers["Referer"] = referer
		return domainWeapi + "/weapi/" + stripAPIPrefix(apiPath), headers

	case cryptoEapi:
		// eapi 把登录态搬进 params.header，同时要求 Cookie 头里是**同一份**
		// 标识（不含用户浏览器带来的无关 cookie），否则服务端以 Cookie 为准。
		headers["User-Agent"] = uaEapi
		headers["Cookie"] = cookieHeader(cookies)
		return domainEapi + "/eapi/" + stripAPIPrefix(apiPath), headers

	case cryptoLinuxapi:
		headers["User-Agent"] = uaLinuxapi
		return domainWeapi + "/api/linux/forward", headers

	default:
		headers["User-Agent"] = uaAPI
		return domainAPI + apiPath, headers
	}
}

// stripAPIPrefix 把 /api/xxx 转成 xxx（拼 /weapi/ 或 /eapi/ 用）。
func stripAPIPrefix(apiPath string) string {
	trimmed := strings.TrimPrefix(apiPath, "/api/")
	if trimmed == apiPath {
		return strings.TrimPrefix(apiPath, "/")
	}
	return trimmed
}

// eapiHeader 组装 eapi 的 header 参数（它同时是 params.header 和 Cookie 头）。
//
// 这份字段集是客户端登录态的核心：MUSIC_U 缺了就是匿名，__csrf 缺了写操作会被
// 拒，deviceId 决定风控画像。缺失项统一用 profile 兜底，保证形状完整。
func eapiHeader(cookies map[string]string, profile osProfile, deviceID string) map[string]string {
	buildver := cookies["buildver"]
	if buildver == "" {
		buildver = fmt.Sprintf("%d", time.Now().Unix())
	}
	header := map[string]string{
		"osver":       valueOr(cookies["osver"], profile.OSVer),
		"deviceId":    valueOr(cookies["deviceId"], deviceID),
		"os":          valueOr(cookies["os"], profile.OS),
		"appver":      valueOr(cookies["appver"], profile.AppVer),
		"versioncode": valueOr(cookies["versioncode"], profile.VersionC),
		"mobilename":  cookies["mobilename"],
		"buildver":    buildver,
		"resolution":  valueOr(cookies["resolution"], "1920x1080"),
		"__csrf":      cookies["__csrf"],
		"channel":     valueOr(cookies["channel"], profile.Channel),
		"requestId":   fmt.Sprintf("%d%d", time.Now().UnixMilli(), randomInt(1000)),
	}
	if musicU := cookies["MUSIC_U"]; musicU != "" {
		header["MUSIC_U"] = musicU
	}
	if musicA := cookies["MUSIC_A"]; musicA != "" {
		header["MUSIC_A"] = musicA
	}
	return header
}

// parseCookieHeader 把 Cookie 头拆成键值表（同名后者覆盖前者）。
func parseCookieHeader(raw string) map[string]string {
	out := make(map[string]string)
	for _, part := range strings.Split(raw, ";") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		key, value, found := strings.Cut(part, "=")
		if !found {
			continue
		}
		key = strings.TrimSpace(key)
		if key == "" {
			continue
		}
		out[key] = strings.TrimSpace(value)
	}
	return out
}

// fillProfile 补齐缺省的客户端标识（不覆盖已有值）。
func fillProfile(cookies map[string]string, profile osProfile) {
	setIfEmpty(cookies, "os", profile.OS)
	setIfEmpty(cookies, "appver", profile.AppVer)
	setIfEmpty(cookies, "osver", profile.OSVer)
	setIfEmpty(cookies, "channel", profile.Channel)
	setIfEmpty(cookies, "versioncode", profile.VersionC)
}

// cookieHeader 按键排序拼回 Cookie 头（排序只为可复现）。
func cookieHeader(cookies map[string]string) string {
	keys := make([]string, 0, len(cookies))
	for key := range cookies {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, key := range keys {
		parts = append(parts, key+"="+cookies[key])
	}
	return strings.Join(parts, "; ")
}

// inflate 兜底解压：eapi 有时回裸 zlib 流而不是标准 gzip。
//
// Go 的 Transport 会自动解 Content-Encoding: gzip，但裸 zlib 没有头信息，
// 只能靠「首字节不是 { 或 [」判断后手动解。
func inflate(raw []byte) ([]byte, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] == '{' || trimmed[0] == '[' {
		return nil, false
	}
	reader, err := zlib.NewReader(bytes.NewReader(trimmed))
	if err != nil {
		return nil, false
	}
	defer reader.Close()
	decoded, err := io.ReadAll(io.LimitReader(reader, 16<<20))
	if err != nil || len(decoded) == 0 {
		return nil, false
	}
	return decoded, true
}

// newDeviceID 生成一个 32 位 HEX 设备号（eapi 首次调用时的兜底）。
func newDeviceID() string {
	buffer := make([]byte, 16)
	if _, err := rand.Read(buffer); err != nil {
		return strings.Repeat("0", 32)
	}
	return hex.EncodeToString(buffer)
}

// randomInt 返回 [0,max) 的随机整数（拼 requestId 用）。
func randomInt(max int) int {
	buffer := make([]byte, 4)
	if _, err := rand.Read(buffer); err != nil {
		return 0
	}
	value := int(buffer[0])<<24 | int(buffer[1])<<16 | int(buffer[2])<<8 | int(buffer[3])
	if value < 0 {
		value = -value
	}
	return value % max
}

// valueOr 返回值或兜底。
func valueOr(value, fallback string) string {
	if value != "" {
		return value
	}
	return fallback
}

// setIfEmpty 仅在缺失时赋值。
func setIfEmpty(target map[string]string, key, value string) {
	if target[key] == "" {
		target[key] = value
	}
}

// values 把 query 转成 url.Values（测试与调用方复用）。
func values(raw string) url.Values {
	parsed, err := url.ParseQuery(raw)
	if err != nil {
		return url.Values{}
	}
	return parsed
}
