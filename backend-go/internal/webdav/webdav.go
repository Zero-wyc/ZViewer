// Package webdav 是 WebDAV 协议的极简客户端。
//
// 只实现本项目用到的四件事：PROPFIND 取单文件属性、PROPFIND Depth:1 列目录、
// 带 Range 的 GET 取字节流、以及 serverUrl+path 的直链拼接。刻意不引第三方
// WebDAV 库：Node 版依赖的 webdav-client 会在每段路径上二次编码，并且默认
// 打开证书校验（NAS 自签名证书必然握手失败，Node 侧靠 patch
// wrapRequestOptions 注入 strictSSL:false 绕过），这些行为在 Go 里
// 用 net/http 直接写反而更清楚、更可控。
//
// 错误语义与 Node 版逐字对齐（见 services/webdav.ts#wrapWebDAVError）：
// 上层靠 code 决定 HTTP 状态码，靠 message 直接给用户看，两者都不能随性改。
package webdav

import (
	"context"
	"crypto/tls"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"zviewer/backend/internal/proxy"
)

// 错误码（与 Node 版一致）。
const (
	CodeTimeout     = "TIMEOUT"
	CodeTLSFailed   = "TLS_FAILED"
	CodeAuthFailed  = "AUTH_FAILED"
	CodeNotFound    = "NOT_FOUND"
	CodeUnreachable = "UNREACHABLE"
)

const (
	statTimeout = 20 * time.Second
	listTimeout = 30 * time.Second
)

// Error 是可预期的 WebDAV 业务失败。
type Error struct {
	Message string
	Code    string
}

// Error 实现 error。
func (e *Error) Error() string { return e.Message }

func newError(message, code string) *Error { return &Error{Message: message, Code: code} }

// StatusForCode 把错误码映射为 HTTP 状态码。
//
// 与 utils/stream-response.ts#mapMountErrorCodeToStatus（notFound=true）一致：
// AUTH_FAILED 一律 401，NOT_FOUND 404，其余回落 fallback。
func StatusForCode(code string, fallback int) int {
	switch code {
	case CodeAuthFailed:
		return http.StatusUnauthorized
	case CodeNotFound:
		return http.StatusNotFound
	}
	return fallback
}

// Params 描述一次 WebDAV 访问。
type Params struct {
	ServerURL string
	Path      string
	Username  string
	Password  string
}

// FileInfo 是 PROPFIND 单文件的结果。
type FileInfo struct {
	Name         string
	Path         string
	Size         int64
	LastModified time.Time
}

// Entry 是目录列表里的一项。
type Entry struct {
	Name         string
	Path         string
	Type         string // "file" | "directory"
	Size         *int64
	LastModified time.Time
}

// Stream 是一次已打开的字节流。
type Stream struct {
	Body     io.ReadCloser
	FileSize int64
	Start    int64
	End      int64
	// ContentType 是上游 GET 响应自带的 Content-Type（可能为空）。
	//
	// 这个字段存在的唯一原因是复刻 Node 的行为：webdav-client 底层用的是
	// request 库，`request.pipe(res)` 时它会调用 pipeDest **把上游响应头整份
	// 写到下游**，于是 Content-Type 实际由源站决定，而不是路由里按扩展名
	// 算出来的那个。实测（对拍脚本 webdav-parity.sh 第 11~14 步）Node 下发的
	// 是上游的 application/octet-stream，而不是 video/x-matroska。
	ContentType string
	// Ranged 表示本次是否按 Range 语义输出（决定 206 与 Content-Range）。
	Ranged bool
}

// ==================== URL / 路径工具 ====================

// normalizeServerURL 去掉首尾空白与末尾斜杠。
func normalizeServerURL(raw string) string {
	normalized := strings.TrimSpace(raw)
	for strings.HasSuffix(normalized, "/") {
		normalized = normalized[:len(normalized)-1]
	}
	return normalized
}

// serverPathPrefix 返回 serverURL 的 path 前缀（如 http://h/dav → /dav）。
func serverPathPrefix(serverURL string) string {
	u, err := url.Parse(normalizeServerURL(serverURL))
	if err != nil {
		return ""
	}
	path := u.Path
	for strings.HasSuffix(path, "/") {
		path = path[:len(path)-1]
	}
	return path
}

// jsUnreserved 是 encodeURIComponent 不转义的字符集。
const jsUnreserved = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()"

// encodePathSegment 复刻 JS 的 encodeURIComponent。
//
// 不能用 url.PathEscape：它把 `!*'()` 也转义、却把 `$&+,;=:@` 原样留下，
// 与 Node 侧发出去的 URL 就不是同一串了。文件名里带这些字符时，
// 两端对不上会导致「Node 能播、Go 404」这种最难查的差异。
func encodePathSegment(seg string) string {
	var b strings.Builder
	b.Grow(len(seg) + 8)
	for i := 0; i < len(seg); i++ {
		c := seg[i]
		if strings.IndexByte(jsUnreserved, c) >= 0 {
			b.WriteByte(c)
			continue
		}
		fmt.Fprintf(&b, "%%%02X", c)
	}
	return b.String()
}

// NormalizePath 复刻 normalizePath：补前导斜杠、按段解码再编码。
//
// 先尝试解码是为了「前端已经编码过的路径」不被二次编码（%20 → %2520）；
// 解码失败（含裸 % ）则按原样编码。刻意不做任何「乱码修复」——
// 部分网盘的文件名本身就是 Latin-1 乱码形态，字符一旦变换就 404。
func NormalizePath(p string) string {
	normalized := strings.TrimSpace(p)
	if !strings.HasPrefix(normalized, "/") {
		normalized = "/" + normalized
	}
	segs := strings.Split(normalized, "/")
	for i, seg := range segs {
		if seg == "" {
			continue
		}
		if decoded, err := url.PathUnescape(seg); err == nil {
			segs[i] = encodePathSegment(decoded)
		} else {
			segs[i] = encodePathSegment(seg)
		}
	}
	return strings.Join(segs, "/")
}

// extractPathname 从 href 里取 pathname。
//
// 不用 url.Parse：WHATWG 规范化会把路径里的非 ASCII 字符重新编码，
// 造成二次编码；这里只要「scheme://host 之后、? 或 # 之前」的原文。
func extractPathname(href string) string {
	lower := strings.ToLower(href)
	idx := strings.Index(lower, "://")
	if idx < 0 {
		return href
	}
	rest := href[idx+3:]
	slash := strings.IndexByte(rest, '/')
	if slash < 0 {
		return "/"
	}
	pathname := rest[slash:]
	if end := strings.IndexAny(pathname, "?#"); end >= 0 {
		pathname = pathname[:end]
	}
	return pathname
}

// hrefToPath 把 DAV 返回的 href 转成相对 webdav 根的路径。
//
// 例：href="/dav/folder1"，serverURL="http://host/dav" → "/folder1"。
// 前端会把 path 回传给后端，带前缀会变成 /dav/dav/folder1 而 404。
func hrefToPath(href, serverURL string) string {
	if href == "" {
		return "/"
	}
	pathname := extractPathname(href)
	if decoded, err := url.PathUnescape(pathname); err == nil {
		pathname = decoded
	}
	prefix := serverPathPrefix(serverURL)
	if prefix != "" && prefix != "/" && strings.HasPrefix(pathname, prefix) {
		pathname = pathname[len(prefix):]
	}
	if !strings.HasPrefix(pathname, "/") {
		pathname = "/" + pathname
	}
	for len(pathname) > 1 && strings.HasSuffix(pathname, "/") {
		pathname = pathname[:len(pathname)-1]
	}
	return pathname
}

// Latin1RoundTrip 生成「历史乱码修复」的逆变换候选路径。
//
// 旧版本曾把服务器真名（Latin-1 乱码形态，如 ï¼\x81）"修复"成理想字符（！）
// 存进影片表；该形态与服务器真名不匹配会 404，这里按 UTF-8→Latin-1 逆转，
// 只在结果与原串不同且有 Latin-1 区字符时才值得重试。
func Latin1RoundTrip(s string) (string, bool) {
	if s == "" {
		return "", false
	}
	// 与 Node 的 Buffer.from(str,'utf8').toString('latin1') 等价：
	// 取每个 UTF-8 字节当 Latin-1 码点。
	latin := make([]rune, 0, len(s))
	for _, b := range []byte(s) {
		latin = append(latin, rune(b))
	}
	candidate := string(latin)
	if candidate == s {
		return "", false
	}
	hasHighByte := false
	for _, r := range candidate {
		if r >= 0x80 && r <= 0xFF {
			hasHighByte = true
			break
		}
	}
	if !hasHighByte {
		return "", false
	}
	return candidate, true
}

// DirectURL 拼接 serverUrl+path。
//
// WebDAV 协议本身没有「带签名的下载直链」，所有访问都要 BasicAuth；
// 这个函数只是与 OpenList 直链模式保持接口一致。浏览器 <video> 直连
// 时会因为缺少 Authorization 而加载失败（除非服务器允许匿名）。
func DirectURL(serverURL, path string) string {
	return normalizeServerURL(serverURL) + NormalizePath(path)
}

// ==================== XML 解析 ====================

type multistatus struct {
	Responses []davResponse `xml:"response"`
}

type davResponse struct {
	Href      string      `xml:"href"`
	Propstats []davPropst `xml:"propstat"`
}

type davPropst struct {
	Prop davProp `xml:"prop"`
}

type davProp struct {
	ContentLength string `xml:"getcontentlength"`
	DisplayName   string `xml:"displayname"`
	LastModified  string `xml:"getlastmodified"`
	ResourceType  struct {
		Collection *struct{} `xml:"collection"`
	} `xml:"resourcetype"`
}

// ==================== HTTP ====================

// insecureClient 放开证书校验。
//
// 群晖/威联通等 NAS 与大量自建服务器用自签名或主机名不匹配的证书，
// 严格校验必然握手失败——Node 版同样通过 strictSSL:false 关掉了校验。
// 影响面仅限本客户端的出站请求，且目标地址完全由用户自己的挂载配置决定。
var insecureClient = &http.Client{
	Transport: &http.Transport{
		TLSClientConfig:     &tls.Config{InsecureSkipVerify: true}, //nolint:gosec
		MaxIdleConnsPerHost: 8,
		IdleConnTimeout:     60 * time.Second,
		DialContext: (&net.Dialer{
			Timeout:   15 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
	},
	// 不跟随重定向到别的 host 也无所谓：WebDAV 服务器很少重定向，
	// 跟随 5 次与 net/http 默认一致即可。
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return errors.New("重定向次数过多")
		}
		return nil
	},
}

// classify 把底层错误包装成 WebDAV 业务错误。
//
// 顺序有意义：先超时、再 TLS、再连接类错误，最后才是兜底。
// Node 版靠匹配错误文案做这件事，Go 有结构化错误，直接判类型更准。
func classify(err error, rawURL string) *Error {
	var davErr *Error
	if errors.As(err, &davErr) {
		return davErr
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return newError("WebDAV 请求超时", CodeTimeout)
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return newError("WebDAV 请求超时", CodeTimeout)
	}
	var certErr *tls.CertificateVerificationError
	if errors.As(err, &certErr) {
		return newError("WebDAV HTTPS 证书验证失败（自签名证书或主机名不匹配）", CodeTLSFailed)
	}
	var recordErr tls.RecordHeaderError
	if errors.As(err, &recordErr) {
		return newError("WebDAV HTTPS 证书验证失败（自签名证书或主机名不匹配）", CodeTLSFailed)
	}
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		return newError("WebDAV 服务器不可达，请检查地址与端口", CodeUnreachable)
	}
	var opErr *net.OpError
	if errors.As(err, &opErr) {
		return newError("WebDAV 服务器不可达，请检查地址与端口", CodeUnreachable)
	}
	msg := err.Error()
	lower := strings.ToLower(msg)
	if strings.Contains(lower, "certificate") || strings.Contains(lower, "tls") {
		return newError("WebDAV HTTPS 证书验证失败（自签名证书或主机名不匹配）", CodeTLSFailed)
	}
	if strings.Contains(lower, "timeout") {
		return newError("WebDAV 请求超时", CodeTimeout)
	}
	_ = rawURL
	return newError(msg, CodeUnreachable)
}

// statusError 把非 2xx 响应映射成业务错误。
func statusError(status int) *Error {
	switch {
	case status == http.StatusUnauthorized || status == http.StatusForbidden:
		return newError("WebDAV 认证/权限失败，请检查用户名和密码（部分服务器仅支持 Digest 认证或对 Basic 认证限制写入源）", CodeAuthFailed)
	case status == http.StatusNotFound:
		return newError("文件不存在或路径错误", CodeNotFound)
	}
	return newError("WebDAV 请求失败（HTTP "+strconv.Itoa(status)+"）", CodeUnreachable)
}

// request 发起一次 WebDAV 请求，正确设置 Basic Auth。
func request(ctx context.Context, params Params, method, targetPath, depth, body string) (*http.Response, error) {
	base := normalizeServerURL(params.ServerURL)
	full := base + NormalizePath(targetPath)
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, full, reader)
	if err != nil {
		return nil, newError("WebDAV 请求地址无效: "+err.Error(), CodeUnreachable)
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/xml; charset=utf-8")
	}
	if depth != "" {
		req.Header.Set("Depth", depth)
	}
	// 有凭证才发 Basic Auth：匿名服务器带空 Authorization 反而会被拒。
	if params.Username != "" || params.Password != "" {
		req.SetBasicAuth(params.Username, params.Password)
	}
	resp, err := insecureClient.Do(req)
	if err != nil {
		return nil, classify(err, full)
	}
	return resp, nil
}

const propfindAllBody = `<?xml version="1.0" encoding="utf-8"?>` +
	`<d:propfind xmlns:d="DAV:"><d:prop>` +
	`<d:resourcetype/><d:creationdate/><d:getlastmodified/><d:getcontentlength/>` +
	`</d:prop></d:propfind>`

// parseMultiStatus 解析 207 响应体。
func parseMultiStatus(resp *http.Response) (*multistatus, error) {
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if err != nil {
		return nil, classify(err, resp.Request.URL.String())
	}
	var ms multistatus
	if err := xml.Unmarshal(raw, &ms); err != nil {
		return nil, newError("WebDAV 响应格式异常: "+err.Error(), CodeUnreachable)
	}
	return &ms, nil
}

// mergeProps 合并多个 propstat 的属性（后面的覆盖前面的）。
//
// allprop 响应里常用一个 200 propstat 加一个 404 propstat（表示不支持的属性），
// 只看第一个 propstat 会漏掉 displayname 之类的字段。
func mergeProps(resp davResponse) davProp {
	var merged davProp
	for _, ps := range resp.Propstats {
		if ps.Prop.ContentLength != "" {
			merged.ContentLength = ps.Prop.ContentLength
		}
		if ps.Prop.DisplayName != "" {
			merged.DisplayName = ps.Prop.DisplayName
		}
		if ps.Prop.LastModified != "" {
			merged.LastModified = ps.Prop.LastModified
		}
		if ps.Prop.ResourceType.Collection != nil {
			merged.ResourceType.Collection = ps.Prop.ResourceType.Collection
		}
	}
	return merged
}

// ==================== 对外操作 ====================

// Stat 读取单个文件/目录的属性（PROPFIND Depth:0）。
func Stat(ctx context.Context, params Params) (*FileInfo, error) {
	ctx, cancel := context.WithTimeout(ctx, statTimeout)
	defer cancel()

	info, err := statOnce(ctx, params, params.Path)
	if err == nil {
		return info, nil
	}
	// 历史数据兼容：影片表里的 path 若是旧版「乱码修复」形态（！），
	// 与服务器真名（ï¼\x81）不匹配会 404，用逆变换候选路径重试一次。
	if fallback, ok := Latin1RoundTrip(params.Path); ok {
		if retried, retryErr := statOnce(ctx, params, fallback); retryErr == nil {
			return retried, nil
		}
	}
	return nil, err
}

func statOnce(ctx context.Context, params Params, targetPath string) (*FileInfo, error) {
	// 空 body = allprop（与 webdav-client#getProperties 默认行为一致）
	resp, err := request(ctx, params, "PROPFIND", targetPath, "0", "")
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 400 {
		resp.Body.Close()
		return nil, statusError(resp.StatusCode)
	}
	ms, err := parseMultiStatus(resp)
	if err != nil {
		return nil, err
	}
	if len(ms.Responses) == 0 {
		return nil, newError("文件不存在或路径错误", CodeNotFound)
	}
	props := mergeProps(ms.Responses[0])
	size := int64(0)
	if props.ContentLength != "" {
		size, _ = strconv.ParseInt(strings.TrimSpace(props.ContentLength), 10, 64)
	}
	name := strings.TrimSpace(props.DisplayName)
	if name == "" {
		parts := strings.Split(targetPath, "/")
		for i := len(parts) - 1; i >= 0; i-- {
			if parts[i] != "" {
				name = parts[i]
				break
			}
		}
	}
	var lastModified time.Time
	if props.LastModified != "" {
		if t, err := http.ParseTime(props.LastModified); err == nil {
			lastModified = t
		}
	}
	return &FileInfo{Name: name, Path: targetPath, Size: size, LastModified: lastModified}, nil
}

// ListDir 列出目录内容（PROPFIND Depth:1，不含被请求目录自身）。
func ListDir(ctx context.Context, params Params, targetPath string) ([]Entry, error) {
	ctx, cancel := context.WithTimeout(ctx, listTimeout)
	defer cancel()

	listPath := targetPath
	if listPath == "" {
		// 不能对 params.Path 取父目录：mount.path 是目录且不带尾斜杠，
		// 取父目录会让「挂载根目录」设置失效，永远列到服务器根。
		listPath = params.Path
	}
	if listPath == "" {
		listPath = "/"
	}

	resp, err := request(ctx, params, "PROPFIND", listPath, "1", propfindAllBody)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 400 {
		resp.Body.Close()
		return nil, statusError(resp.StatusCode)
	}
	ms, err := parseMultiStatus(resp)
	if err != nil {
		return nil, err
	}

	selfEncoded := NormalizePath(listPath)
	self, decodeErr := url.PathUnescape(selfEncoded)
	if decodeErr != nil {
		self = listPath
	}
	self = strings.TrimSuffix(self, "/")
	if self == "" {
		self = "/"
	}

	entries := make([]Entry, 0, len(ms.Responses))
	for _, r := range ms.Responses {
		entryPath := hrefToPath(r.Href, params.ServerURL)
		trimmed := strings.TrimSuffix(entryPath, "/")
		if trimmed == "" {
			trimmed = "/"
		}
		if trimmed == self || trimmed == self+"/" || entryPath == self {
			continue
		}
		props := mergeProps(r)
		entry := Entry{
			Name: lastSegment(entryPath),
			Path: entryPath,
			Type: "file",
		}
		if props.ResourceType.Collection != nil {
			entry.Type = "directory"
		}
		// 目录也要给 size（Node 的 readdir 在缺 getcontentlength 时填 0），
		// 少一个字段前端排序/展示会出现 undefined 参与比较。
		size := int64(0)
		if props.ContentLength != "" {
			if parsed, err := strconv.ParseInt(strings.TrimSpace(props.ContentLength), 10, 64); err == nil {
				size = parsed
			}
		}
		entry.Size = &size
		if props.LastModified != "" {
			if t, err := http.ParseTime(props.LastModified); err == nil {
				entry.LastModified = t
			}
		}
		entries = append(entries, entry)
	}
	return entries, nil
}

// lastSegment 取路径最后一段（服务器真名，不做任何字符修复）。
func lastSegment(p string) string {
	trimmed := strings.TrimSuffix(p, "/")
	idx := strings.LastIndex(trimmed, "/")
	if idx < 0 {
		return trimmed
	}
	return trimmed[idx+1:]
}

// OpenRangeStream 打开一段字节流。
//
// 与 Node 版 createWebDAVReadStreamWithRange 对齐：
//   - 先 stat 拿 fileSize（缓存 30s，seek 期间不重复 PROPFIND）；
//   - 无 Range / fileSize 未知 / Range 非法 → 退化全量 GET（200）；
//   - 合法 Range → 带上 Range 头，开放式请求由 proxy.ParseRangeHeader
//     收敛到 8MiB 分片。
func OpenRangeStream(ctx context.Context, params Params, rangeHeader string, cache *StatCache) (*Stream, error) {
	info, err := statCached(ctx, params, cache)
	if err != nil {
		return nil, err
	}
	fileSize := info.Size
	streamPath := info.Path
	if streamPath == "" {
		streamPath = params.Path
	}

	var parsed *proxy.Range
	if strings.TrimSpace(rangeHeader) != "" && fileSize > 0 {
		// 非法 Range 不报 416：退化成全量 GET，让浏览器自己重试（与 Node 一致）。
		if r, err := proxy.ParseRangeHeader(rangeHeader, fileSize, proxy.MaxRangeChunkBytes); err == nil {
			parsed = r
		}
	}
	if parsed == nil {
		body, contentType, err := openGET(ctx, params, streamPath, "")
		if err != nil {
			return nil, err
		}
		return &Stream{
			Body:        body,
			FileSize:    fileSize,
			Start:       0,
			End:         fileSize - 1,
			Ranged:      false,
			ContentType: contentType,
		}, nil
	}
	body, contentType, err := openGET(ctx, params, streamPath, "bytes="+
		strconv.FormatInt(parsed.Start, 10)+"-"+strconv.FormatInt(parsed.End, 10))
	if err != nil {
		return nil, err
	}
	return &Stream{
		Body:        body,
		FileSize:    fileSize,
		Start:       parsed.Start,
		End:         parsed.End,
		Ranged:      true,
		ContentType: contentType,
	}, nil
}

// openGET 发起 GET（可带 Range），返回响应体。
//
// 上游 4xx 一律转成业务错误：416 说明 fileSize 是陈旧的，调用方下一轮
// 会重新 stat；其余按状态码映射。
func openGET(ctx context.Context, params Params, targetPath, rangeHeader string) (io.ReadCloser, string, error) {
	base := normalizeServerURL(params.ServerURL)
	full := base + NormalizePath(targetPath)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, full, nil)
	if err != nil {
		return nil, "", newError("WebDAV 请求地址无效: "+err.Error(), CodeUnreachable)
	}
	if rangeHeader != "" {
		req.Header.Set("Range", rangeHeader)
	}
	if params.Username != "" || params.Password != "" {
		req.SetBasicAuth(params.Username, params.Password)
	}
	resp, err := insecureClient.Do(req)
	if err != nil {
		return nil, "", classify(err, full)
	}
	if resp.StatusCode >= 400 {
		resp.Body.Close()
		return nil, "", statusError(resp.StatusCode)
	}
	return resp.Body, resp.Header.Get("Content-Type"), nil
}

// ==================== 缓存 ====================

// StatCache 是文件属性的短 TTL 缓存。
//
// 播放/seek 期间会产生大量 Range 请求，每次都 PROPFIND 取 fileSize 会多一次
// 上游往返（高延迟 WebDAV 下显著拖慢 seek）。文件大小在播放期间不会变，
// 30s 缓存足够；文件被替换时最多 30s 后自愈。
type StatCache struct {
	mu      sync.Mutex
	entries map[string]statEntry
	ttl     time.Duration
	max     int
}

type statEntry struct {
	info *FileInfo
	at   time.Time
}

// NewStatCache 构造属性缓存（ttl=30s，上限 200 条，与 Node 版一致）。
func NewStatCache() *StatCache {
	return &StatCache{entries: make(map[string]statEntry), ttl: 30 * time.Second, max: 200}
}

func statKey(p Params) string {
	return p.ServerURL + "|" + p.Username + "|" + p.Path
}

func statCached(ctx context.Context, params Params, cache *StatCache) (*FileInfo, error) {
	if cache != nil {
		key := statKey(params)
		cache.mu.Lock()
		if e, ok := cache.entries[key]; ok && time.Since(e.at) < cache.ttl {
			cache.mu.Unlock()
			return e.info, nil
		}
		cache.mu.Unlock()
	}
	info, err := Stat(ctx, params)
	if err != nil {
		return nil, err
	}
	if cache != nil {
		cache.mu.Lock()
		if len(cache.entries) >= cache.max {
			for k, v := range cache.entries {
				if time.Since(v.at) >= cache.ttl {
					delete(cache.entries, k)
				}
			}
			if len(cache.entries) >= cache.max {
				cache.entries = make(map[string]statEntry)
			}
		}
		cache.entries[statKey(params)] = statEntry{info: info, at: time.Now()}
		cache.mu.Unlock()
	}
	return info, nil
}

// DirCache 是目录列表的 60s 缓存（按 mountId+path）。
type DirCache struct {
	mu      sync.Mutex
	entries map[string]dirEntry
	ttl     time.Duration
	max     int
}

type dirEntry struct {
	list []Entry
	at   time.Time
}

// NewDirCache 构造目录缓存（ttl=60s，上限 300 条）。
func NewDirCache() *DirCache {
	return &DirCache{entries: make(map[string]dirEntry), ttl: time.Minute, max: 300}
}

// ListDirCached 优先读缓存，未命中时回源。
func ListDirCached(ctx context.Context, params Params, mountID int64, targetPath string, cache *DirCache) ([]Entry, error) {
	key := strconv.FormatInt(mountID, 10) + ":" + targetPath
	if targetPath == "" {
		key = strconv.FormatInt(mountID, 10) + ":" + params.Path
	}
	if cache != nil {
		cache.mu.Lock()
		if e, ok := cache.entries[key]; ok && time.Since(e.at) < cache.ttl {
			cache.mu.Unlock()
			return e.list, nil
		}
		cache.mu.Unlock()
	}
	list, err := ListDir(ctx, params, targetPath)
	if err != nil {
		return nil, err
	}
	if cache != nil {
		cache.mu.Lock()
		if len(cache.entries) >= cache.max {
			for k, v := range cache.entries {
				if time.Since(v.at) >= cache.ttl {
					delete(cache.entries, k)
				}
			}
			if len(cache.entries) >= cache.max {
				cache.entries = make(map[string]dirEntry)
			}
		}
		cache.entries[key] = dirEntry{list: list, at: time.Now()}
		cache.mu.Unlock()
	}
	return list, nil
}
