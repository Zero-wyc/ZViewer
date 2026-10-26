package nms

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/url"
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
type embeddedServer struct {
	cfg            Config
	hub            *streamHub
	logf           func(string, ...any)
	publishAllowed func(context.Context, string) bool
	watchAllowed   func(context.Context, string, string) bool

	rtmpLn  net.Listener
	httpLn  net.Listener
	httpSrv *http.Server

	mu          sync.RWMutex
	ready       bool
	connections map[net.Conn]struct{}
}

func newEmbeddedServer(cfg Config, logf func(string, ...any)) *embeddedServer {
	if logf == nil {
		logf = func(string, ...any) {}
	}
	return &embeddedServer{cfg: cfg, hub: newStreamHub(), logf: logf, connections: make(map[net.Conn]struct{})}
}

func (s *embeddedServer) start() error {
	bind := s.cfg.BindHost
	if bind == "" {
		// 与 Node 的 node-media-server 一致：默认全网卡。
		// HTTP-FLV 侧只给本进程反代用，不对外暴露（Dockerfile 也不 EXPOSE 3335）。
		bind = "0.0.0.0"
	}

	rtmpAddr := net.JoinHostPort(bind, strconv.Itoa(s.cfg.RtmpPort))
	rtmpLn, err := net.Listen("tcp", rtmpAddr)
	if err != nil {
		return fmt.Errorf("RTMP 端口 %d 监听失败: %w", s.cfg.RtmpPort, err)
	}

	httpPort, err := flvPortFromBase(s.cfg.HTTPFLVBase)
	if err != nil {
		_ = rtmpLn.Close()
		return err
	}
	httpAddr := net.JoinHostPort("127.0.0.1", strconv.Itoa(httpPort))
	httpLn, err := net.Listen("tcp", httpAddr)
	if err != nil {
		_ = rtmpLn.Close()
		return fmt.Errorf("HTTP-FLV 端口 %d 监听失败: %w", httpPort, err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/live", s.handleFLV)
	mux.HandleFunc("/live/", s.handleFLV)

	s.mu.Lock()
	s.rtmpLn = rtmpLn
	s.httpLn = httpLn
	s.httpSrv = &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 15 * time.Second,
	}
	s.ready = true
	s.mu.Unlock()

	go s.acceptRTMP(rtmpLn)
	go func() {
		if err := s.httpSrv.Serve(httpLn); err != nil && err != http.ErrServerClosed {
			s.logf("[nms] HTTP-FLV 服务退出: %v", err)
			s.mu.Lock()
			s.ready = false
			s.mu.Unlock()
		}
	}()

	s.logf("[nms] 内置媒体服务已启动：RTMP :%d（OBS 推流）、HTTP-FLV :%d（/live 反代）",
		s.cfg.RtmpPort, httpPort)
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
	httpSrv := s.httpSrv
	rtmpLn := s.rtmpLn
	for conn := range s.connections {
		_ = conn.Close()
	}
	s.mu.Unlock()
	for _, key := range s.hub.streamKeys() {
		s.hub.stop(key)
	}

	if httpSrv != nil {
		_ = httpSrv.Shutdown(ctx)
	}
	if rtmpLn != nil {
		_ = rtmpLn.Close()
	}
	return nil
}

// handleFLV 处理 HTTP-FLV 拉流。路径与 Node 版一致：/live/{streamKey}.flv。
func (s *embeddedServer) handleFLV(w http.ResponseWriter, r *http.Request) {
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

// flvPortFromBase 从 NMS_HTTP_FLV_URL 里取端口（内嵌模式下它一定是回环地址）。
func flvPortFromBase(base string) (int, error) {
	u, err := url.Parse(strings.TrimSpace(base))
	if err != nil {
		return 0, fmt.Errorf("NMS_HTTP_FLV_URL 无法解析: %w", err)
	}
	if p := u.Port(); p != "" {
		n, err := strconv.Atoi(p)
		if err == nil && n > 0 && n <= 65535 {
			return n, nil
		}
	}
	return DefaultHTTPFLVPort, nil
}
