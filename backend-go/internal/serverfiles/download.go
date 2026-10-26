package serverfiles

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"
)

// DownloadProgress 是下载进度回调参数。
type DownloadProgress struct {
	Received int64
	Total    int64
	Percent  int
}

// downloadClient 是下载远端直链用的 HTTP 客户端。
//
// 与全局代理客户端分开：下载是「长连接 + 大文件」，不应继承代理的短超时，
// 也不能被全局 Transport 的并发限制拖慢。
var downloadClient = &http.Client{Timeout: 0}

// DownloadToFile 把远端直链流式下载到本地文件。
//
// 行为对齐 services/server-files/download.service.ts：
//   - 失败时删除不完整文件（避免半截文件被当成可播放媒体）；
//   - 进度回调节流：每 2% 或（未知总长时）每 512KB 触发一次。
func DownloadToFile(
	ctx context.Context,
	url, filePath string,
	headers map[string]string,
	onProgress func(DownloadProgress),
	roots ...RootInfo,
) (int64, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return 0, err
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}

	resp, err := downloadClient.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 || resp.Body == nil {
		return 0, fmt.Errorf("下载失败：HTTP %d %s", resp.StatusCode, resp.Status)
	}

	total := resp.ContentLength
	if total < 0 {
		total = 0
	}

	var dst *os.File
	if len(roots) == 1 {
		dst, err = OpenFile(roots[0], filePath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	} else {
		dst, err = os.Create(filePath)
	}
	remove := func() {
		if len(roots) == 1 {
			_ = RemoveAll(roots[0], filePath)
		} else {
			_ = os.Remove(filePath)
		}
	}
	if err != nil {
		return 0, err
	}

	var (
		received    int64
		lastPercent = 0
		lastChunk   int64
	)
	buf := make([]byte, 256<<10)
	for {
		n, readErr := resp.Body.Read(buf)
		if n > 0 {
			if _, writeErr := dst.Write(buf[:n]); writeErr != nil {
				_ = dst.Close()
				remove()
				return received, writeErr
			}
			received += int64(n)
			percent := 0
			if total > 0 {
				percent = int(received * 100 / total)
			}
			if onProgress != nil {
				if total > 0 && percent >= lastPercent+2 {
					lastPercent = percent
					onProgress(DownloadProgress{Received: received, Total: total, Percent: percent})
				} else if total == 0 && received-lastChunk >= 512*1024 {
					lastChunk = received
					onProgress(DownloadProgress{Received: received, Total: total, Percent: 0})
				}
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			_ = dst.Close()
			remove()
			return received, readErr
		}
	}

	if err := dst.Close(); err != nil {
		remove()
		return received, err
	}
	return received, nil
}

// StatSize 返回路径的字节数（不存在时返回 0）。
func StatSize(path string) int64 {
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		return 0
	}
	return info.Size()
}

// NowMillis 返回当前毫秒时间戳（兜底文件名用）。
func NowMillis() int64 { return time.Now().UnixMilli() }
