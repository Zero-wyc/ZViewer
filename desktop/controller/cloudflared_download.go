package controller

import (
	"context"
	"errors"
	"io"
	"sync"
	"time"
)

const cloudflaredDownloadIdleTimeout = time.Minute
const cloudflaredDownloadIdleCode = "cloudflared_download_idle_timeout"

var errCloudflaredDownloadIdle = errors.New("cloudflared 下载超时：连续 1 分钟未收到响应或下载数据，已中断。请检查网络或切换获取源后重试。")

// The deadline follows network progress, rather than the total download time.
// Recheck it in the callback: an already queued timer may race with activity.
type cloudflaredDownloadWatchdog struct {
	mu       sync.Mutex
	timer    *time.Timer
	deadline time.Time
	stopped  bool
	cancel   context.CancelCauseFunc
}

func newCloudflaredDownloadWatchdog(parent context.Context) (context.Context, *cloudflaredDownloadWatchdog) {
	ctx, cancel := context.WithCancelCause(parent)
	w := &cloudflaredDownloadWatchdog{cancel: cancel, deadline: time.Now().Add(cloudflaredDownloadIdleTimeout)}
	w.mu.Lock()
	w.timer = time.AfterFunc(cloudflaredDownloadIdleTimeout, w.expire)
	w.mu.Unlock()
	return ctx, w
}

func (w *cloudflaredDownloadWatchdog) expire() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.stopped {
		return
	}
	if remaining := time.Until(w.deadline); remaining > 0 {
		w.timer.Reset(remaining)
		return
	}
	w.stopped = true
	w.cancel(errCloudflaredDownloadIdle)
}

func (w *cloudflaredDownloadWatchdog) activity() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if !w.stopped {
		w.deadline = time.Now().Add(cloudflaredDownloadIdleTimeout)
		w.timer.Reset(cloudflaredDownloadIdleTimeout)
	}
}

func (w *cloudflaredDownloadWatchdog) stop() {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.stopped = true
	w.timer.Stop()
}

type cloudflaredProgressReader struct {
	io.Reader
	watchdog *cloudflaredDownloadWatchdog
}

func (r cloudflaredProgressReader) Read(p []byte) (int, error) {
	n, err := r.Reader.Read(p)
	if n > 0 {
		r.watchdog.activity()
	}
	return n, err
}
