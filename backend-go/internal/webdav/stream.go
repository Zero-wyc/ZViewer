package webdav

import (
	"context"
	"io"
	"net/http"
	"strconv"
	"strings"
)

// RawStream 是「不先 PROPFIND」的直通字节流。
//
// 播放路径的边界条件全部由上游响应决定：206 自带 Content-Range（含文件总长），
// 200 自带 Content-Length。这样首播只需要一次上游往返，而不是
// PROPFIND（拿 fileSize）+ GET（拿数据）两次。
//
// 为什么可以省掉 PROPFIND：PROPFIND 唯一的产物是 fileSize，而 fileSize 只用于
// 「把开放式 Range 收敛成分片」和「写 Content-Range/Content-Length」。前者可以
// 用「起始偏移 + 分片上限」直接构造（不需要总长），后者上游 206 已经给了。
type RawStream struct {
	Body        io.ReadCloser
	ContentType string
	// Header 保留需要透传给客户端的校验头（ETag / Last-Modified /
	// Content-Disposition）。整份转发不安全：会带上 Content-Encoding 等
	// 与本次字节流不匹配的头。
	Header http.Header
	// Total 是文件总大小（0 表示未知：上游 206 用了 `*` 通配）。
	Total int64
	// Start/End 是本次响应的字节区间（含端点），Ranged 为 true 时有效。
	Start int64
	End   int64
	// Ranged 表示上游确实按 Range 返回了 206。
	//
	// 必须与「我们请求了 Range」区分开：源站忽略 Range 直接回 200 时，
	// 硬写 206 + Content-Range 会让客户端从错误的偏移解码。
	Ranged bool
}

// OpenStream 直接打开字节流，跳过 stat。
//
// rangeHeader 原样传入客户端请求头；maxChunk > 0 时把开放式/过长的区间
// 收敛为不超过 maxChunk 字节（避免探测请求把整个文件拉走）。
//
// 返回的 RawStream 一定与上游真实响应一致：
//   - 上游 206 → Ranged=true，Start/End/Total 取自 Content-Range；
//   - 上游 200 → Ranged=false，Total 取自 Content-Length（可能为 0）。
//
// 416（请求偏移越界）退化为一次无 Range 的全量请求：与 OpenRangeStream
// 的既有语义一致——越界 Range 不阻断播放，让客户端自己重新定位。
func OpenStream(
	ctx context.Context,
	params Params,
	rangeHeader string,
	maxChunk int64,
) (*RawStream, error) {
	upstreamRange := clampClientRange(rangeHeader, maxChunk)

	resp, err := openRangeGet(ctx, params, upstreamRange)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode == http.StatusRequestedRangeNotSatisfiable && upstreamRange != "" {
		resp.Body.Close()
		resp, err = openRangeGet(ctx, params, "")
		if err != nil {
			return nil, err
		}
	}

	out := &RawStream{
		Body:        resp.Body,
		ContentType: resp.Header.Get("Content-Type"),
		Header:      keepStreamHeaders(resp.Header),
	}
	switch resp.StatusCode {
	case http.StatusPartialContent:
		start, end, total, ok := parseContentRange(resp.Header.Get("Content-Range"))
		if !ok {
			// 206 却没有可解析的 Content-Range：无法声明区间，退化为
			// 不带头部的 200 语义（宁可丢 seek，也不能给出错位的边界）。
			resp.Body.Close()
			return nil, newError("WebDAV 服务器返回了不完整的 Content-Range", CodeUnreachable)
		}
		out.Ranged = true
		out.Start, out.End, out.Total = start, end, total
		if total > 0 && end > total-1 {
			out.End = total - 1
		}
	case http.StatusOK:
		// 源站不支持 Range（或客户端本来就没要）：全量转发。
		if resp.ContentLength > 0 {
			out.Total = resp.ContentLength
			out.End = resp.ContentLength - 1
		}
	default:
		resp.Body.Close()
		return nil, statusError(resp.StatusCode)
	}
	return out, nil
}

// openRangeGet 发起一次 GET（可带 Range），仅负责非 2xx/416 以外的传输错误。
func openRangeGet(ctx context.Context, params Params, rangeHeader string) (*http.Response, error) {
	base := normalizeServerURL(params.ServerURL)
	full := base + NormalizePath(params.Path)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, full, nil)
	if err != nil {
		return nil, newError("WebDAV 请求地址无效: "+err.Error(), CodeUnreachable)
	}
	if rangeHeader != "" {
		req.Header.Set("Range", rangeHeader)
	}
	// 禁用传输压缩：媒体必须是源文件字节。某些 WebDAV 网关会对任意
	// 文件开 gzip，压缩后的字节区间与 Range 语义完全对不上。
	req.Header.Set("Accept-Encoding", "identity")
	if params.Username != "" || params.Password != "" {
		req.SetBasicAuth(params.Username, params.Password)
	}
	resp, err := insecureClient.Do(req)
	if err != nil {
		return nil, classify(err, full)
	}
	if resp.StatusCode >= 400 && resp.StatusCode != http.StatusRequestedRangeNotSatisfiable {
		resp.Body.Close()
		return nil, statusError(resp.StatusCode)
	}
	return resp, nil
}

// clampClientRange 把客户端的 Range 改写成「一定能一次拿到、且不超过上限」的形式。
//
// 不需要文件总长：开放式区间（bytes=0-）用「起始偏移 + maxChunk」封口，
// 上游 206 会回填真实结束位置与总长；尾部区间（bytes=-N）直接把 N 收敛到上限。
//
// 无法解析的 Range 返回空串（按全量处理），与既有「非法 Range 不报 416、
// 退化成全量 GET 让浏览器自己重试」的口径一致。
func clampClientRange(rangeHeader string, maxChunk int64) string {
	raw := strings.TrimSpace(rangeHeader)
	if raw == "" || !strings.HasPrefix(strings.ToLower(raw), "bytes=") {
		return ""
	}
	spec := strings.TrimSpace(raw[len("bytes="):])
	// 多段范围：视频播放器从不使用，退化成全量（拼 multipart 收益为零）。
	if strings.Contains(spec, ",") {
		return ""
	}
	dash := strings.Index(spec, "-")
	if dash < 0 {
		return ""
	}
	startPart := strings.TrimSpace(spec[:dash])
	endPart := strings.TrimSpace(spec[dash+1:])

	if startPart == "" {
		// 尾部区间 bytes=-N：只能原样交给上游，但把 N 收敛到分片上限，
		// 避免「最后 N 字节」变成整文件下载。
		n, err := strconv.ParseInt(endPart, 10, 64)
		if err != nil || n <= 0 {
			return ""
		}
		if maxChunk > 0 && n > maxChunk {
			n = maxChunk
		}
		return "bytes=-" + strconv.FormatInt(n, 10)
	}

	start, err := strconv.ParseInt(startPart, 10, 64)
	if err != nil || start < 0 {
		return ""
	}
	end := int64(-1)
	if endPart != "" {
		end, err = strconv.ParseInt(endPart, 10, 64)
		if err != nil || end < start {
			return ""
		}
	}
	if maxChunk > 0 {
		limit := start + maxChunk - 1
		if end < 0 || end > limit {
			end = limit
		}
	}
	if end < 0 {
		return "bytes=" + strconv.FormatInt(start, 10) + "-"
	}
	return "bytes=" + strconv.FormatInt(start, 10) + "-" + strconv.FormatInt(end, 10)
}

// parseContentRange 解析 `bytes 0-8388607/12345`（total 允许为 `*`）。
func parseContentRange(value string) (start, end, total int64, ok bool) {
	raw := strings.TrimSpace(value)
	if raw == "" || !strings.HasPrefix(strings.ToLower(raw), "bytes") {
		return 0, 0, 0, false
	}
	rest := strings.TrimSpace(raw[len("bytes"):])
	slash := strings.Index(rest, "/")
	if slash < 0 {
		return 0, 0, 0, false
	}
	rangePart := strings.TrimSpace(rest[:slash])
	totalPart := strings.TrimSpace(rest[slash+1:])
	dash := strings.Index(rangePart, "-")
	if dash < 0 {
		return 0, 0, 0, false
	}
	start, err := strconv.ParseInt(strings.TrimSpace(rangePart[:dash]), 10, 64)
	if err != nil || start < 0 {
		return 0, 0, 0, false
	}
	end, err = strconv.ParseInt(strings.TrimSpace(rangePart[dash+1:]), 10, 64)
	if err != nil || end < start {
		return 0, 0, 0, false
	}
	if totalPart != "*" {
		total, err = strconv.ParseInt(totalPart, 10, 64)
		if err != nil || total <= 0 {
			total = 0
		}
	}
	return start, end, total, true
}

// keepStreamHeaders 挑出可以与字节流一起透传给客户端的头。
//
// ETag/Last-Modified 让客户端能走条件请求；Content-Disposition 影响
// 「另存为」的文件名。Content-Encoding/Content-Length/Content-Range
// 由代理层按真实响应重写，不能照抄。
func keepStreamHeaders(src http.Header) http.Header {
	out := make(http.Header, 3)
	for _, key := range []string{"Etag", "Last-Modified", "Content-Disposition"} {
		if v := src.Get(key); v != "" {
			out.Set(key, v)
		}
	}
	return out
}
