package nms

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// embeddedServer 是进程内的媒体服务：RTMP 收流 + HTTP-FLV 分发。
//
// 为什么自己实现而不是外挂 SRS/mediamtx：Node 版用的是进程内 node-media-server，
// 「开箱就能推流」是既有产品行为。外部二进制要么只认 RTMP/RTSP（mediamtx 没有
// HTTP-FLV 输出），要么只有 Cygwin 版（SRS Windows），单文件分发与桌面壳都装不进去。
// 这里只做「转封装」——不做转码，音视频包原样从 RTMP 搬到 FLV——
// 因此实现量可控，且与 OBS 的默认输出（H.264/AAC）完全对齐。
//
// 拉流侧**不监听任何端口**：`/live` 由 api 层校验票据后直接调用 `ServeFLV`，
// 数据在同一进程内写回 HTTP 响应。RTMP 是唯一需要的监听（OBS 要从外面连进来）。
type embeddedServer struct {
	cfg            Config
	hub            *streamHub
	logf           func(string, ...any)
	publishAllowed func(context.Context, string) bool
	watchAllowed   func(context.Context, string, string) bool

	rtmpLn net.Listener

	mu          sync.RWMutex
	ready       bool
	connections map[net.Conn]struct{}
	// publishers 记录「推流码 → 发布连接」，用于切换模式时强制断开 OBS。
	publishers map[string]net.Conn
}

func newEmbeddedServer(cfg Config, logf func(string, ...any)) *embeddedServer {
	if logf == nil {
		logf = func(string, ...any) {}
	}
	cfg = Normalize(cfg)
	hub := newStreamHub()
	hub.offlineGrace = cfg.OfflineGrace
	return &embeddedServer{
		cfg:         cfg,
		hub:         hub,
		logf:        logf,
		connections: make(map[net.Conn]struct{}),
		publishers:  make(map[string]net.Conn),
	}
}

func (s *embeddedServer) start() error {
	bind := s.cfg.BindHost
	if bind == "" {
		// 与 Node 的 node-media-server 一致：默认全网卡。
		// 拉流侧不监听，只有 RTMP 需要对外（OBS 主动连过来）。
		bind = "0.0.0.0"
	}

	rtmpAddr := net.JoinHostPort(bind, strconv.Itoa(s.cfg.RtmpPort))
	rtmpLn, err := net.Listen("tcp", rtmpAddr)
	if err != nil {
		return fmt.Errorf("RTMP 端口 %d 监听失败: %w", s.cfg.RtmpPort, err)
	}

	s.mu.Lock()
	s.rtmpLn = rtmpLn
	s.ready = true
	s.mu.Unlock()

	go s.acceptRTMP(rtmpLn)

	s.logf("[nms] 内置媒体服务已启动：RTMP :%d（OBS 推流），HTTP-FLV 由 /live 进程内直出",
		s.cfg.RtmpPort)
	return nil
}

func (s *embeddedServer) acceptRTMP(ln net.Listener) {
	for {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		s.mu.Lock()
		if !s.ready {
			s.mu.Unlock()
			_ = conn.Close()
			return
		}
		s.connections[conn] = struct{}{}
		s.mu.Unlock()
		go func() {
			defer func() { s.mu.Lock(); delete(s.connections, conn); s.mu.Unlock() }()
			newRTMPConn(s, conn).serve()
		}()
	}
}

func (s *embeddedServer) isReady() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.ready
}

func (s *embeddedServer) close(ctx context.Context) error {
	s.mu.Lock()
	s.ready = false
	rtmpLn := s.rtmpLn
	for conn := range s.connections {
		_ = conn.Close()
	}
	s.mu.Unlock()
	for _, key := range s.hub.streamKeys() {
		s.hub.stop(key)
	}

	if rtmpLn != nil {
		_ = rtmpLn.Close()
	}
	return nil
}

// registerPublisher 记录某路推流的发布连接（onPublish 成功后调用）。
func (s *embeddedServer) registerPublisher(key string, conn net.Conn) {
	s.mu.Lock()
	s.publishers[key] = conn
	s.mu.Unlock()
}

// unregisterPublisher 在推流结束时清理记录（连接已关闭也安全）。
func (s *embeddedServer) unregisterPublisher(key string, conn net.Conn) {
	s.mu.Lock()
	if current, ok := s.publishers[key]; ok && current == conn {
		delete(s.publishers, key)
	}
	s.mu.Unlock()
}

// kickPublishing 强制断开指定推流码的发布端，并立即结束该路流。
//
// OBS 端会看到连接被服务器关闭，从而停止推流；观众侧的 FLV 订阅也会
// 随 hub.stop 一起结束。返回 false 表示当前没有这路推流。
func (s *embeddedServer) kickPublishing(key string) bool {
	s.mu.Lock()
	conn := s.publishers[key]
	if conn != nil {
		delete(s.publishers, key)
	}
	s.mu.Unlock()
	if conn == nil {
		return false
	}
	// 关闭连接会触发 serve 的 defer unpublish（hub.stop + 清理），
	// 这里再显式 stop 一次，保证订阅者立刻收到结束而不是等一个读超时。
	s.hub.stop(key)
	_ = conn.Close()
	return true
}

// ServeFLV 把 HTTP-FLV 流直接写进 w（不经过本地回环端口）。
// 路径与 Node 版一致：/live/{streamKey}.flv。
func (s *embeddedServer) ServeFLV(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodOptions:
		h := w.Header()
		h.Set("Access-Control-Allow-Origin", "*")
		h.Set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
		h.Set("Access-Control-Allow-Headers", "*")
		w.WriteHeader(http.StatusNoContent)
		return
	case http.MethodGet, http.MethodHead:
	default:
		w.Header().Set("Allow", "GET, HEAD, OPTIONS")
		http.Error(w, "方法不允许", http.StatusMethodNotAllowed)
		return
	}

	key := strings.TrimPrefix(r.URL.Path, "/live")
	key = strings.TrimPrefix(key, "/")
	key = strings.TrimSuffix(key, ".flv")
	if key == "" || strings.ContainsAny(key, `/\`) {
		http.Error(w, "推流码无效", http.StatusNotFound)
		return
	}

	if s.watchAllowed == nil || !s.watchAllowed(r.Context(), key, r.URL.Query().Get("ticket")) {
		http.Error(w, "观看权限已失效", http.StatusForbidden)
		return
	}
	// 容忍「页面先连、OBS 后推」的时序：最多等 2s 再判 404。
	sub, backlog := s.hub.subscribe(key, 2*time.Second)
	if sub == nil {
		http.Error(w, "该推流未开始", http.StatusNotFound)
		return
	}
	defer s.hub.unsubscribe(key, sub)

	h := w.Header()
	h.Set("Content-Type", "video/x-flv")
	h.Set("Cache-Control", "no-cache, no-store")
	h.Set("Access-Control-Allow-Origin", "*")
	w.WriteHeader(http.StatusOK)
	if r.Method == http.MethodHead {
		return
	}

	rc := http.NewResponseController(w)
	if err := writeFLVHeader(w); err != nil {
		return
	}
	for _, tag := range backlog {
		if err := writeFLVTag(w, tag); err != nil {
			return
		}
	}
	if err := rc.Flush(); err != nil {
		return
	}

	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			if !s.watchAllowed(r.Context(), key, r.URL.Query().Get("ticket")) {
				return
			}
		case tag, ok := <-sub.ch:
			if !ok {
				return
			}
			if err := writeFLVTag(w, tag); err != nil {
				return
			}
			if err := rc.Flush(); err != nil {
				return
			}
		case <-r.Context().Done():
			return
		}
	}
}
