// Package proxy 是统一的 HTTP 上游媒体代理与 Range 输出实现。
//
// 对应 Node 版 services/proxy/（http-proxy.ts + range-stream.ts）。
// 历史上 B 站 CDN、图片、动画源等 5 个以上端点各自复制了一份
// 「构造上游头 → 转发 → 透传 Range/Content-* → 管道输出」，CORS 处理还不一致；
// 这里收敛为单一实现，各端点只声明差异项。
package proxy

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"zviewer/backend/internal/netutil"
)

// DefaultProxyUA 是上游请求的默认 UA（桌面 Chrome）。
//
// 防盗链场景必须给一个像浏览器的 UA：源站会按 UA 拒绝 curl/空 UA。
const DefaultProxyUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

// defaultUpstreamTimeout 只覆盖「连接 + 等待响应头」这一段。
const defaultUpstreamTimeout = 30 * time.Second

// passthroughHeaders 是需要回传给客户端的上游响应头（白名单）。
//
// 白名单而非全透传：上游的 Set-Cookie / CSP 之类透给浏览器会打乱本站语义。
var passthroughHeaders = []string{
	"Content-Length",
	"Accept-Ranges",
	"Content-Range",
	"ETag",
	"Last-Modified",
}

// SetWildcardCORS 设置通配 CORS 头。
//
// video.src 跨源加载媒体时必须有 ACAO:*，否则会被 ORB 阻止。
// 携带凭证（credentials: include）的请求不能用通配 CORS——那类端点应传
// CORSGlobal 交给全局 cors 中间件反射 Origin。
func SetWildcardCORS(w http.ResponseWriter) {
	h := w.Header()
	h.Set("Access-Control-Allow-Origin", "*")
	h.Set("Access-Control-Allow-Headers", "Authorization, Content-Type, Range")
	h.Set("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length")
}

// CORS 模式。
const (
	CORSWildcard = "wildcard"
	CORSGlobal   = "global"
)

// UpstreamHeaders 是透传给上游的客户端头。
type UpstreamHeaders struct {
	Referer   string
	Origin    string
	UserAgent string
	Cookie    string
	// Extra 追加或覆盖上游请求头
	Extra map[string]string
}

// HTTPOptions 是单次代理的差异项声明。
type HTTPOptions struct {
	// URL 上游地址（调用方需已完成校验）
	URL string
	// Headers 透传给上游的客户端头
	Headers UpstreamHeaders
	// CORS 见 CORSWildcard / CORSGlobal，默认 wildcard
	CORS string
	// DefaultContentType 上游未返回 Content-Type 时的兜底，默认 application/octet-stream
	DefaultContentType string
	// CacheControl 追加到响应的缓存策略（会自动补 no-transform）
	CacheControl string
	// TimeoutMs 上游请求超时（毫秒），默认 30000；只覆盖等响应头阶段
	TimeoutMs int
	// LogTag 日志前缀，如 "kazumi"
	LogTag string
	// ErrorMessage 502 时的 message 文案
	ErrorMessage string
	// PublicOnly 为 true 时拒绝内网目标和内网重定向（公网数据源必开）
	PublicOnly bool
	// OnUpstreamStatus 可选：上游返回非 2xx 时回调。
	// 用于「签名直链过期」这类自愈场景——调用方在这里失效自己的直链缓存，
	// 下一次请求就会重新换链，而不是在 TTL 窗口内拿着死 URL 反复 403。
	OnUpstreamStatus func(status int)
	// RewriteHLSUri 可选：改写 m3u8 里的每一条 URI
	RewriteHLSUri func(uri, playlistURL string) string
	// Client 可选：注入自定义 client（测试用）
	Client *http.Client
}

// ProxyHTTPUpstream 代理一个 HTTP 上游资源。
//
// 行为约定（与 Node 版一致，逐条都是踩过坑的）：
//   - 透传 Range，回传 Content-Range / Accept-Ranges / Content-Length；
//   - 开放式 Range 收敛为 8MiB 分片，避免探测请求拉走整个文件；
//   - 上游非 2xx 透传状态码，且正文不转发（GET 的 Content-Length 置零）；
//   - 超时 504、网络异常 502，均在未发头时给出 JSON；
//   - 客户端断连时立刻中断上游，避免「人已下线、流量还在跑」。
func ProxyHTTPUpstream(w http.ResponseWriter, r *http.Request, opts HTTPOptions) {
	if opts.CORS == "" {
		opts.CORS = CORSWildcard
	}
	if opts.DefaultContentType == "" {
		opts.DefaultContentType = "application/octet-stream"
	}
	timeout := defaultUpstreamTimeout
	if opts.TimeoutMs > 0 {
		timeout = time.Duration(opts.TimeoutMs) * time.Millisecond
	}
	client := opts.Client
	if client == nil {
		client = defaultClient()
	}

	startTime := time.Now()
	var bytesSent int64
	rangeHeader := r.Header.Get("Range")
	requestURL := opts.URL

	logf := func(format string, args ...any) {
		log.Printf("["+opts.LogTag+"] "+format, args...)
	}
	// 流量日志：URL / 字节数 / 耗时，用于定位带宽来源。
	// 正常完成记状态码，异常路径用 ABORTED / ERR 标记（与 Node 版口径一致）。
	traffic := func(label string) {
		logf("proxy %s %s %dms range=%s %s", label, formatBytes(bytesSent),
			time.Since(startTime).Milliseconds(), orDash(rangeHeader), truncateURL(requestURL))
	}
	okLabel := func(status int) string { return strconv.Itoa(status) }

	state := newAttemptState(r.Context(), timeout)
	defer func() {
		state.stopTimer()
		state.cancel()
	}()

	resp, finalURL, err := state.fetch(client, r, opts)
	// 内网目标配错 scheme 的兜底：https 连不上就降级 http 重试一次。
	// 覆盖两类症状：快速失败（ECONNREFUSED / 证书错误）与 TLS 握手挂到超时。
	if err != nil && shouldDowngradeToHTTP(requestURL) {
		if clientGone(r) {
			return
		}
		state.stopTimer()
		state.cancel()
		requestURL = "http://" + strings.TrimPrefix(requestURL, "https://")
		logf("https 上游失败（%v），降级 http 重试: %s", err, truncateURL(requestURL))
		state = newAttemptState(r.Context(), timeout)
		resp, finalURL, err = state.fetch(client, r, opts)
	}
	if err != nil {
		switch {
		case clientGone(r):
			traffic("ABORTED")
			return
		case state.timedOut.Load():
			logf("proxy TIMEOUT %s %dms range=%s %s", formatBytes(bytesSent),
				time.Since(startTime).Milliseconds(), orDash(rangeHeader), truncateURL(requestURL))
			writeJSON(w, http.StatusGatewayTimeout, `{"success":false,"message":"上游请求超时"}`)
			return
		default:
			logf("proxy error: %v", err)
			traffic("ERR")
			writeJSON(w, http.StatusBadGateway, fmt.Sprintf(`{"success":false,"message":%s}`, jsonString(opts.ErrorMessage)))
			return
		}
	}
	// 响应头已到，取消连接阶段的超时；body 传输由客户端断连检测兜底。
	state.stopTimer()
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		traffic(okLabel(resp.StatusCode))
		if opts.OnUpstreamStatus != nil {
			opts.OnUpstreamStatus(resp.StatusCode)
		}
		if opts.CORS == CORSWildcard {
			SetWildcardCORS(w)
		}
		copyPassthroughHeaders(w.Header(), resp)
		// 错误响应不转发正文：GET 的长度必须为零，否则客户端会一直等缺失的字节；
		// HEAD 保留上游的表示长度。
		if r.Method != http.MethodHead {
			w.Header().Set("Content-Length", "0")
		}
		w.WriteHeader(resp.StatusCode)
		return
	}

	// 转发上游状态码：Range 请求上游返回 206 时必须转发 206，
	// 否则前端看到 200 会当成完整响应，Content-Range 语义全丢。
	if opts.CORS == CORSWildcard {
		SetWildcardCORS(w)
	}

	if opts.RewriteHLSUri != nil && r.Method != http.MethodHead && isHLS(resp, finalURL) {
		body, readErr := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
		if readErr != nil {
			traffic("ERR")
			writeJSON(w, http.StatusBadGateway, fmt.Sprintf(`{"success":false,"message":%s}`, jsonString(opts.ErrorMessage)))
			return
		}
		h := w.Header()
		// 必须带 charset：Node 用的是 express 的 res.send(string)，
		// 它会给任何字符串响应体补 `; charset=utf-8`。少了这半句，
		// 两端 Content-Type 不一，播放器对 HLS 的嗅探策略也可能不同。
		h.Set("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8")
		h.Set("Cache-Control", "private, no-store")
		w.WriteHeader(resp.StatusCode)
		_, _ = io.WriteString(w, rewritePlaylist(string(body), finalURL, opts.RewriteHLSUri))
		return
	}

	applyResponseHeaders(w.Header(), resp, r, opts.DefaultContentType, opts.CacheControl)

	w.WriteHeader(resp.StatusCode)

	if r.Method == http.MethodHead || resp.Body == nil {
		traffic(okLabel(resp.StatusCode))
		return
	}

	copied, copyErr := streamBody(w, resp.Body, &bytesSent)
	if copyErr != nil {
		if clientGone(r) {
			traffic("ABORTED")
			return
		}
		logf("proxy upstream stream error: %v (已发送 %s)", copyErr, formatBytes(copied))
		traffic("ERROR")
		return
	}
	traffic(okLabel(resp.StatusCode))
}

// attemptState 管理一次上游尝试的超时与取消。
//
// 超时只覆盖到"收到响应头"为止：开放式 Range 下载（bytes=0-）的 body
// 可能持续数分钟，把整个请求套上超时会把正常的长传输切断。
type attemptState struct {
	ctx      context.Context
	cancel   context.CancelFunc
	timer    *time.Timer
	timedOut atomic.Bool
}

func newAttemptState(parent context.Context, timeout time.Duration) *attemptState {
	ctx, cancel := context.WithCancel(parent)
	s := &attemptState{ctx: ctx, cancel: cancel}
	s.timer = time.AfterFunc(timeout, func() {
		s.timedOut.Store(true)
		cancel()
	})
	return s
}

func (s *attemptState) stopTimer() {
	if s.timer != nil {
		s.timer.Stop()
	}
}

// fetch 发起请求并按需手动跟随重定向（publicOnly 时逐跳做 SSRF 校验）。
func (s *attemptState) fetch(client *http.Client, r *http.Request, opts HTTPOptions) (*http.Response, string, error) {
	maxRedirects := 20
	if opts.PublicOnly {
		// 公网代理固定 5 跳：每一跳都要过 SSRF 检查，跳数越多越难审计
		maxRedirects = 5
	}

	target := opts.URL
	for hops := 0; hops <= maxRedirects; hops++ {
		if opts.PublicOnly {
			if err := assertPublicTarget(target); err != nil {
				return nil, target, err
			}
		}
		req, err := http.NewRequestWithContext(s.ctx, r.Method, target, nil)
		if err != nil {
			return nil, target, err
		}
		applyUpstreamHeaders(req, r, opts.Headers)

		resp, err := client.Do(req)
		if err != nil {
			return nil, target, err
		}

		if !opts.PublicOnly || !isRedirect(resp.StatusCode) {
			return resp, target, nil
		}
		location := resp.Header.Get("Location")
		if location == "" {
			return resp, target, nil
		}
		// 丢弃重定向响应体，避免连接泄漏
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
		resp.Body.Close()

		next, err := resp.Location()
		if err != nil {
			return nil, target, err
		}
		target = next.String()
	}
	return nil, target, errors.New("上游重定向过多")
}

// defaultClient 是不自动跟随重定向的 client（重定向由 attemptState.fetch 处理）。
func defaultClient() *http.Client {
	return &http.Client{
		Transport: &http.Transport{
			Proxy: http.ProxyFromEnvironment,
			DialContext: (&net.Dialer{
				Timeout:   15 * time.Second,
				KeepAlive: 30 * time.Second,
			}).DialContext,
			ForceAttemptHTTP2:     true,
			MaxIdleConns:          64,
			IdleConnTimeout:       90 * time.Second,
			TLSHandshakeTimeout:   15 * time.Second,
			ExpectContinueTimeout: time.Second,
		},
		// 关掉自动重定向：需要逐跳检查 Location 是否指向内网
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

// applyUpstreamHeaders 构造上游请求头：UA / Referer / Origin / Cookie / Range。
func applyUpstreamHeaders(req *http.Request, client *http.Request, h UpstreamHeaders) {
	ua := strings.TrimSpace(h.UserAgent)
	if ua == "" {
		ua = DefaultProxyUA
	}
	req.Header.Set("User-Agent", ua)
	req.Header.Set("Accept", "*/*")
	for k, v := range h.Extra {
		req.Header.Set(k, v)
	}
	if v := strings.TrimSpace(h.Referer); v != "" {
		req.Header.Set("Referer", v)
	}
	if v := strings.TrimSpace(h.Origin); v != "" {
		req.Header.Set("Origin", v)
	}
	if v := strings.TrimSpace(h.Cookie); v != "" {
		req.Header.Set("Cookie", v)
	}
	if v := ClampRangeHeader(client.Header.Get("Range"), MaxRangeChunkBytes); v != "" {
		req.Header.Set("Range", v)
	}
	// 条件请求头：ETag/Last-Modified 已回传给客户端，补传协商头才能激活
	// 304 缓存，否则透传的 ETag 是个"死头"。
	if v := client.Header.Get("If-None-Match"); v != "" {
		req.Header.Set("If-None-Match", v)
	}
	if v := client.Header.Get("If-Range"); v != "" {
		req.Header.Set("If-Range", v)
	}
}

// ClampRangeHeader 把客户端的开放式 Range 收敛为有界分片。
//
// 只处理 `bytes=N-` 这种开放式请求：浏览器 <video> 的探测请求就是开放式，
// 直接透传会让上游一次性返回整个文件（数百 MB～数 GB），客户端拿到元数据
// 后往往立即断开——这是代理场景最大的无效流量来源。
//
// **显式 end 的 range（bytes=start-end）必须原样透传**：dash.js 的虚拟 MPD
// 按单个完整 segment 发起显式 Range，4K 下单个 m4s 常有 8–15MB，截断会让
// dash.js 拿到不完整 fragment、反复重试，表现为只有 4K 卡顿。
// 尾部 suffix（bytes=-N）与多段 Range 同样原样透传（长度天然有限）。
func ClampRangeHeader(rangeValue string, maxChunk int64) string {
	raw := strings.TrimSpace(rangeValue)
	if raw == "" || maxChunk <= 0 {
		return raw
	}
	if !strings.HasPrefix(strings.ToLower(raw), "bytes=") {
		return raw
	}
	rest := raw[len("bytes="):]
	// 多段 Range（含逗号）原样透传
	if strings.Contains(rest, ",") {
		return raw
	}
	dash := strings.Index(rest, "-")
	if dash < 0 {
		return raw
	}
	startPart, endPart := strings.TrimSpace(rest[:dash]), strings.TrimSpace(rest[dash+1:])
	// 尾部 suffix（start 为空）原样透传
	if startPart == "" {
		return raw
	}
	start, err := strconv.ParseInt(startPart, 10, 64)
	if err != nil || start < 0 {
		return raw
	}
	// 显式 end：客户端明确所需区间，不截断
	if endPart != "" {
		return raw
	}
	return fmt.Sprintf("bytes=%d-%d", start, start+maxChunk-1)
}

// applyResponseHeaders 写成功响应的头。
func applyResponseHeaders(h http.Header, resp *http.Response, client *http.Request, defaultContentType, cacheControl string) {
	// Content-Type：B 站 CDN 偶发把视频标成 application/json，
	// 此时用调用方的 defaultContentType 纠正，避免 MSE 引擎或浏览器拒收。
	upstreamType := resp.Header.Get("Content-Type")
	contentType := upstreamType
	switch {
	case contentType == "":
		contentType = defaultContentType
	case strings.Contains(strings.ToLower(upstreamType), "application/json") &&
		!strings.Contains(strings.ToLower(defaultContentType), "json"):
		contentType = defaultContentType
	}
	h.Set("Content-Type", contentType)

	for _, name := range passthroughHeaders {
		if name == "Content-Length" && client.Method != http.MethodHead && hasCompressedBody(resp) {
			// 传输层已解压，上游的 Content-Length 是压缩后长度，回传会让客户端等不到字节
			continue
		}
		if v := resp.Header.Get(name); v != "" {
			h.Set(name, v)
		}
	}
	// 上游没给 Accept-Ranges 时兜底声明：浏览器看不到它就不会发 Range 请求，
	// 结果变成整文件下载而非流式播放。
	if h.Get("Accept-Ranges") == "" {
		h.Set("Accept-Ranges", "bytes")
	}
	// 提示反向代理不要缓冲响应体（Nginx 默认会先落盘再转发，
	// 大体积长连接 Range 流会延迟、超时甚至耗尽内存/磁盘）。
	h.Set("X-Accel-Buffering", "no")
	h.Set("X-Proxy-Buffering", "no")
	// no-transform 禁止中间代理转换/压缩响应体（如把 video/mp4 当文本处理）
	if cacheControl != "" {
		h.Set("Cache-Control", cacheControl+", no-transform")
	} else {
		h.Set("Cache-Control", "no-transform")
	}
}

// copyPassthroughHeaders 透传语义头（错误响应也要给：416 的 Content-Range
// 是 RFC 9110 要求的，不透传客户端就不知道可用范围）。
func copyPassthroughHeaders(h http.Header, resp *http.Response) {
	for _, name := range passthroughHeaders {
		if v := resp.Header.Get(name); v != "" {
			h.Set(name, v)
		}
	}
}

// streamBody 把上游 body 写给客户端，边写边计数并立即 flush。
//
// flush 不能省：小分片（m3u8、短 segment）若留在缓冲里，播放端会等到
// 缓冲填满才收到数据，表现为起播慢、拖动后长时间转圈。
func streamBody(w http.ResponseWriter, body io.Reader, bytesSent *int64) (int64, error) {
	buf := make([]byte, 32<<10)
	var copied int64
	rc := http.NewResponseController(w)
	for {
		n, readErr := body.Read(buf)
		if n > 0 {
			written, writeErr := w.Write(buf[:n])
			copied += int64(written)
			atomic.AddInt64(bytesSent, int64(written))
			if writeErr != nil {
				return copied, writeErr
			}
			_ = rc.Flush()
		}
		if readErr == io.EOF {
			return copied, nil
		}
		if readErr != nil {
			return copied, readErr
		}
	}
}

// isHLS 判断是否需要改写播放列表。
func isHLS(resp *http.Response, finalURL string) bool {
	if strings.Contains(strings.ToLower(resp.Header.Get("Content-Type")), "mpegurl") {
		return true
	}
	lower := strings.ToLower(finalURL)
	return strings.Contains(lower, ".m3u8")
}

// rewritePlaylist 逐行改写 m3u8：注释行只改 URI="..." 属性，其余行整体替换。
func rewritePlaylist(playlist, baseURL string, rewrite func(uri, playlistURL string) string) string {
	lines := strings.Split(playlist, "\n")
	for i, line := range lines {
		trimmed := strings.TrimSpace(strings.TrimSuffix(line, "\r"))
		if trimmed == "" {
			continue
		}
		if strings.HasPrefix(trimmed, "#") {
			lines[i] = rewriteTagURIs(line, baseURL, rewrite)
			continue
		}
		lines[i] = rewrite(trimmed, baseURL)
	}
	return strings.Join(lines, "\n")
}

// rewriteTagURIs 处理 #EXT-X-KEY / #EXT-X-MAP 这类带 URI="..." 的标签。
func rewriteTagURIs(line, baseURL string, rewrite func(uri, playlistURL string) string) string {
	const marker = `URI="`
	var out strings.Builder
	rest := line
	for {
		idx := strings.Index(rest, marker)
		if idx < 0 {
			out.WriteString(rest)
			return out.String()
		}
		out.WriteString(rest[:idx+len(marker)])
		rest = rest[idx+len(marker):]
		end := strings.IndexByte(rest, '"')
		if end < 0 {
			out.WriteString(rest)
			return out.String()
		}
		out.WriteString(rewrite(rest[:end], baseURL))
		out.WriteByte('"')
		rest = rest[end+1:]
	}
}

// resolveAddresses 是 DNS 解析钩子，单测里替换掉以免依赖真实网络。
var resolveAddresses = netutil.ResolveInternalAddresses

// assertPublicTarget 校验目标既不是内网字面量、也不解析到内网。
//
// 只看 URL 里的主机名不够：攻击者可以用一个解析到 127.0.0.1 的公网域名。
func assertPublicTarget(target string) error {
	parsed, err := url.Parse(target)
	if err != nil {
		return err
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return errors.New("不允许代理内网地址")
	}
	if parsed.User != nil {
		return errors.New("不允许代理内网地址")
	}
	if netutil.IsInternalNetworkHost(parsed.Hostname()) {
		return errors.New("不允许代理内网地址")
	}
	internal, err := resolveAddresses(parsed.Hostname())
	if err != nil {
		// 解析失败不当作内网：DNS 抖动不该把正常请求判成攻击
		return nil
	}
	if len(internal) > 0 {
		return errors.New("不允许代理内网地址")
	}
	return nil
}

// shouldDowngradeToHTTP 判断 https 上游是否值得降级 http 重试（仅内网目标）。
func shouldDowngradeToHTTP(raw string) bool {
	parsed, err := url.Parse(raw)
	if err != nil {
		return false
	}
	return parsed.Scheme == "https" && netutil.IsInternalNetworkHost(parsed.Hostname())
}

func isRedirect(status int) bool {
	switch status {
	case http.StatusMovedPermanently, http.StatusFound, http.StatusSeeOther,
		http.StatusTemporaryRedirect, http.StatusPermanentRedirect:
		return true
	}
	return false
}

// clientGone 判断是不是客户端主动断开（此时不该再写任何响应）。
func clientGone(r *http.Request) bool {
	return r.Context().Err() != nil
}

func hasCompressedBody(resp *http.Response) bool {
	return resp.Uncompressed || resp.Header.Get("Content-Encoding") != ""
}

// writeJSON 写一个已序列化好的 JSON 响应体。
//
// 这里不引 httpx：proxy 包要能独立被非 HTTP 层引用（后续 stream-movie 也会用），
// 且响应体形状极简，多一层依赖只会绕。
func writeJSON(w http.ResponseWriter, status int, body string) {
	h := w.Header()
	h.Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = io.WriteString(w, body)
}

// jsonString 把 Go 字符串转成 JSON 字面量（只处理引号与反斜杠，够用且不引依赖）。
func jsonString(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\n':
			b.WriteString(`\n`)
		default:
			b.WriteRune(r)
		}
	}
	b.WriteByte('"')
	return b.String()
}

func formatBytes(bytes int64) string {
	switch {
	case bytes < 1024:
		return strconv.FormatInt(bytes, 10) + "B"
	case bytes < 1024*1024:
		return fmt.Sprintf("%.1fKB", float64(bytes)/1024)
	case bytes < 1024*1024*1024:
		return fmt.Sprintf("%.2fMB", float64(bytes)/(1024*1024))
	default:
		return fmt.Sprintf("%.2fGB", float64(bytes)/(1024*1024*1024))
	}
}

func orDash(v string) string {
	if v == "" {
		return "-"
	}
	return v
}

func truncateURL(raw string) string {
	if len(raw) <= 100 {
		return raw
	}
	return raw[:100]
}
