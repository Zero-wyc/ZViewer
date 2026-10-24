package proxy

import (
	"errors"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// MaxRangeChunkBytes 是普通网页/代理请求的分片上限（8MiB）。
//
// 控制客户端中途取消时可能浪费的流量：开放式 Range 不设上限时，
// 上游会把整个文件推过来，而播放器拿到元数据就断开。
const MaxRangeChunkBytes int64 = 8 * 1024 * 1024

// Range 是一个已解析的字节区间（含端点）。
type Range struct {
	Start int64
	End   int64
}

// Length 返回区间字节数。
func (r Range) Length() int64 { return r.End - r.Start + 1 }

// ErrRangeInvalid 表示 Range 非法或不可满足，调用方应返回 416。
var ErrRangeInvalid = errors.New("请求的范围无效")

// ParseRangeHeader 解析单段字节范围。
//
// 语义与 range-stream.ts 一致：
//   - 无 Range → (nil, false, nil)：按完整响应处理；
//   - 非法/不可满足/多段 → ErrRangeInvalid：调用方返回 416；
//   - maxChunkBytes <= 0 表示不限制（AVPlayer 专用流要完整范围以通过
//     Content-Range 校验）。
//
// 只支持单段是刻意的：视频播放器从不发多段请求，支持多段意味着要做
// multipart/byteranges 拼装，收益为零风险很高。
func ParseRangeHeader(rangeHeader string, fileSize int64, maxChunkBytes int64) (*Range, error) {
	raw := strings.TrimSpace(rangeHeader)
	if raw == "" {
		return nil, nil
	}
	if fileSize <= 0 {
		return nil, ErrRangeInvalid
	}
	if !strings.HasPrefix(strings.ToLower(raw), "bytes=") {
		return nil, ErrRangeInvalid
	}
	rest := strings.TrimSpace(raw[len("bytes="):])
	if strings.Contains(rest, ",") {
		return nil, ErrRangeInvalid
	}
	dash := strings.Index(rest, "-")
	if dash < 0 {
		return nil, ErrRangeInvalid
	}
	startPart := strings.TrimSpace(rest[:dash])
	endPart := strings.TrimSpace(rest[dash+1:])
	if startPart == "" && endPart == "" {
		return nil, ErrRangeInvalid
	}

	if startPart == "" {
		// 尾部 suffix：bytes=-N，取最后 N 字节（有上限时再收缩）
		suffixLength, err := strconv.ParseInt(endPart, 10, 64)
		if err != nil || suffixLength <= 0 {
			return nil, ErrRangeInvalid
		}
		effective := suffixLength
		if maxChunkBytes > 0 && maxChunkBytes < effective {
			effective = maxChunkBytes
		}
		start := int64(0)
		if effective < fileSize {
			start = fileSize - effective
		}
		return &Range{Start: start, End: fileSize - 1}, nil
	}

	start, err := strconv.ParseInt(startPart, 10, 64)
	if err != nil || start < 0 {
		return nil, ErrRangeInvalid
	}
	requestedEnd := fileSize - 1
	if endPart != "" {
		requestedEnd, err = strconv.ParseInt(endPart, 10, 64)
		if err != nil || requestedEnd < start {
			return nil, ErrRangeInvalid
		}
	}
	if start >= fileSize {
		return nil, ErrRangeInvalid
	}
	end := requestedEnd
	if end > fileSize-1 {
		end = fileSize - 1
	}
	if maxChunkBytes > 0 && start+maxChunkBytes-1 < end {
		end = start + maxChunkBytes - 1
	}
	return &Range{Start: start, End: end}, nil
}

// SendRangeNotSatisfiable 输出 416 响应。
//
// 必须带 `Content-Range: bytes */size`（RFC 9110）：客户端据此知道真实
// 文件大小，否则会把 416 当成服务端故障而不是"这个位置没有数据"。
func SendRangeNotSatisfiable(w http.ResponseWriter, fileSize int64) {
	w.Header().Set("Content-Range", "bytes */"+strconv.FormatInt(fileSize, 10))
	writeJSON(w, http.StatusRequestedRangeNotSatisfiable, `{"success":false,"message":"请求的范围无效"}`)
}

// PipeRangeStreamOptions 描述一次字节流输出。
type PipeRangeStreamOptions struct {
	Stream      io.ReadCloser
	ContentType string
	// FileSize 文件总大小；Ranged 为 true 时必填
	FileSize *int64
	// Start/End 本次输出的字节区间（含端点）；无 Range 时省略
	Start *int64
	End   *int64
	// Ranged 是否响应 Range 请求（决定 206 与 Content-Range）
	Ranged bool
	// CORS "wildcard"（默认，video.src 跨源直连）/ "global"（交给全局 cors）
	CORS string
	// LogTag 日志前缀
	LogTag string
	// ErrorMessage 未发头时出错的 502 文案
	ErrorMessage string
	// ErrorCode 可选业务错误码
	ErrorCode string
	// MaxBytesPerSecond 传输速率上限（AVPlayer 专用流用）；0 表示不节流
	MaxBytesPerSecond int64
	// InitialBurstBytes 限速前允许立即发送的字节数
	InitialBurstBytes int64
}

// PipeRangeStream 以统一的响应头与错误处理输出一个字节流。
//
// 调用前若 Range 非法，应先用 SendRangeNotSatisfiable 返回 416。
func PipeRangeStream(w http.ResponseWriter, r *http.Request, opts PipeRangeStreamOptions) {
	defer opts.Stream.Close()

	cors := opts.CORS
	if cors == "" {
		cors = CORSWildcard
	}
	if cors == CORSWildcard {
		SetWildcardCORS(w)
	}
	h := w.Header()
	h.Set("Content-Type", opts.ContentType)
	h.Set("Accept-Ranges", "bytes")

	if opts.Ranged && opts.FileSize != nil && opts.Start != nil && opts.End != nil {
		length := *opts.End - *opts.Start + 1
		h.Set("Content-Range", "bytes "+strconv.FormatInt(*opts.Start, 10)+"-"+
			strconv.FormatInt(*opts.End, 10)+"/"+strconv.FormatInt(*opts.FileSize, 10))
		h.Set("Content-Length", strconv.FormatInt(length, 10))
		w.WriteHeader(http.StatusPartialContent)
	} else {
		if opts.FileSize != nil {
			h.Set("Content-Length", strconv.FormatInt(*opts.FileSize, 10))
		}
		w.WriteHeader(http.StatusOK)
	}

	// HEAD 只回头部：继续读流会让上游白传一遍（部分存储会因此计费）
	if r.Method == http.MethodHead {
		return
	}

	reader := io.Reader(opts.Stream)
	if opts.MaxBytesPerSecond > 0 {
		reader = newThrottledReader(reader, opts.MaxBytesPerSecond, opts.InitialBurstBytes)
	}

	buf := make([]byte, 32<<10)
	rc := http.NewResponseController(w)
	for {
		n, readErr := reader.Read(buf)
		if n > 0 {
			if _, writeErr := w.Write(buf[:n]); writeErr != nil {
				// 客户端断连：直接退出，defer 会关闭上游流，
				// 这是「用户下线后流量仍在跑」的关键防护
				return
			}
			_ = rc.Flush()
		}
		if readErr == io.EOF {
			return
		}
		if readErr != nil {
			// 头已发出，无法再改状态码，只能记日志并断流
			log.Printf("[%s] proxy stream error: %v", opts.LogTag, readErr)
			return
		}
	}
}

// throttledReader 是带令牌桶的读取器：边读边限速，但不改变
// Content-Length / Content-Range，客户端看到的是"慢一点的流"。
//
// 用途是 AVPlayer：它在拿到 AVPlayerItem 后会持续预读整个文件，
// 不限速会把带宽吃满。注意这里的限速发生在读侧，不缓冲额外数据。
type throttledReader struct {
	src        io.Reader
	rate       int64 // 字节/秒
	burst      int64
	available  float64
	lastRefill time.Time
}

func newThrottledReader(src io.Reader, rate, burst int64) io.Reader {
	if burst <= 0 {
		burst = rate / 10
	}
	return &throttledReader{
		src:        src,
		rate:       rate,
		burst:      burst,
		available:  float64(burst),
		lastRefill: time.Now(),
	}
}

func (t *throttledReader) Read(p []byte) (int, error) {
	now := time.Now()
	elapsed := now.Sub(t.lastRefill).Seconds()
	t.lastRefill = now
	t.available += elapsed * float64(t.rate)
	if t.available > float64(t.burst) {
		t.available = float64(t.burst)
	}

	if t.available < 1 {
		// 令牌耗尽：睡到够发一个字节，再重新计息
		need := (1 - t.available) / float64(t.rate)
		time.Sleep(time.Duration(need * float64(time.Second)))
		t.lastRefill = time.Now()
		t.available = 0
	}

	// 单次最多读 burst 大小，避免一次读走太多而绕过限速
	maxRead := len(p)
	if int64(maxRead) > t.burst {
		maxRead = int(t.burst)
	}
	n, err := t.src.Read(p[:maxRead])
	t.available -= float64(n)
	return n, err
}
