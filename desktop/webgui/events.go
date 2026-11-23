package webgui

// 事件推送：SSE 广播 + 一次性下载令牌。
//
// 网页端没有 Wails 的 runtime.EventsEmit，改用 Server-Sent Events：
// 浏览器打开 /api/events 后保持一条长连接，服务端把「快照更新 / 页面跳转 /
// 爬虫验证提醒 / 打开外链 / 文件下载」等事件按 event 名分发。
//
// 为什么是 SSE 而不是 WebSocket：这里只需要服务端 → 浏览器的单向推送，
// SSE 自带断线重连（EventSource 行为）、走普通 HTTP、实现只有几十行；
// 双向命令本来就走 POST /api/command。
//
// 慢客户端处理：每个连接一个带缓冲的 channel（32 条），塞满就丢弃这条事件，
// 绝不阻塞广播方——桌面壳的 emitUpdate 可能在 controller 的锁里被调用，
// 卡住它等于把后端状态机拖死。

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"sync"
	"time"
)

// sseMessage 是一条待推送事件。
type sseMessage struct {
	event string
	data  any
}

// hub 维护所有 SSE 连接。
type hub struct {
	mu      sync.Mutex
	clients map[chan sseMessage]struct{}
}

func newHub() *hub {
	return &hub{clients: map[chan sseMessage]struct{}{}}
}

// subscribe 注册一个连接，返回事件通道与注销函数。
func (h *hub) subscribe() (<-chan sseMessage, func()) {
	channel := make(chan sseMessage, 32)
	h.mu.Lock()
	h.clients[channel] = struct{}{}
	h.mu.Unlock()
	cancel := func() {
		h.mu.Lock()
		if _, ok := h.clients[channel]; ok {
			delete(h.clients, channel)
			close(channel)
		}
		h.mu.Unlock()
	}
	return channel, cancel
}

// broadcast 向所有连接推送；任何慢连接只会丢自己的事件。
func (h *hub) broadcast(event string, data any) {
	h.mu.Lock()
	targets := make([]chan sseMessage, 0, len(h.clients))
	for channel := range h.clients {
		targets = append(targets, channel)
	}
	h.mu.Unlock()
	for _, channel := range targets {
		select {
		case channel <- sseMessage{event: event, data: data}:
		default:
			// 客户端读得太慢：丢这一条，保证广播不阻塞。
		}
	}
}

// closeAll 在服务关闭时断开所有 SSE 连接。
func (h *hub) closeAll() {
	h.mu.Lock()
	for channel := range h.clients {
		close(channel)
		delete(h.clients, channel)
	}
	h.mu.Unlock()
}

// ---------------------------------------------------------------- 下载令牌

// downloadEntry 是一次性的文件下载内容。
type downloadEntry struct {
	name      string
	data      []byte
	createdAt time.Time
}

// deliverFile 登记一份待下载内容，返回令牌；浏览器收到 download 事件后
// 用 /api/download?token=... 取一次，取完即焚。
func (s *Server) deliverFile(name string, data []byte) (string, error) {
	raw := make([]byte, 24)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	token := base64.RawURLEncoding.EncodeToString(raw)
	s.downloadMu.Lock()
	s.downloads[token] = downloadEntry{name: name, data: data, createdAt: time.Now()}
	s.downloadMu.Unlock()
	return token, nil
}

// takeDownload 取出并删除下载内容。令牌是一次性的，重复拿只会 404。
func (s *Server) takeDownload(token string) (downloadEntry, bool) {
	s.downloadMu.Lock()
	defer s.downloadMu.Unlock()
	entry, ok := s.downloads[token]
	if !ok {
		return downloadEntry{}, false
	}
	delete(s.downloads, token)
	return entry, true
}

// pruneDownloads 清掉十分钟内没被取走的令牌，避免内存堆积。
func (s *Server) pruneDownloads() {
	cutoff := time.Now().Add(-10 * time.Minute)
	s.downloadMu.Lock()
	defer s.downloadMu.Unlock()
	for token, entry := range s.downloads {
		if entry.createdAt.Before(cutoff) {
			delete(s.downloads, token)
		}
	}
}

// encodeEvent 按 SSE 线格式编码一条事件。
func encodeEvent(event string, data any) ([]byte, error) {
	payload, err := json.Marshal(data)
	if err != nil {
		return nil, err
	}
	// data 可能被浏览器按行拆包：JSON 里不会有裸换行，安全。
	return []byte(fmt.Sprintf("event: %s\ndata: %s\n\n", event, payload)), nil
}
