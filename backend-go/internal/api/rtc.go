package api

import (
	"bufio"
	"bytes"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"zviewer/backend/internal/proxy"
)

// registerRTCRoutes 挂载 LiveKit 的同端口入口。
//
// 浏览器必须与页面同源访问 LiveKit 的信令：
//   - WebSocket `/rtc*` 的升级请求原样隧道到 LiveKit（升级后是不透明字节流，
//     纯 TCP 双向管道即可）；
//   - HTTP `/rtc/v1/validate` 也要代理——livekit-client 连接前会先探一次，
//     少了它 HTTPS 页面会被混合内容策略拦下。
//
// 上游地址每次请求现读 LIVEKIT_API_HOST：桌面壳会在启动后注入这个变量，
// 启动时缓存住就会一直连默认端口。
func (s *Server) registerRTCRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/rtc", s.handleLivekitRTC)
	mux.HandleFunc("/rtc/", s.handleLivekitRTC)
}

func (s *Server) handleLivekitRTC(w http.ResponseWriter, r *http.Request) {
	if strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		s.tunnelLivekitWebSocket(w, r)
		return
	}

	host, port := livekitUpstream()
	options := proxy.HTTPOptions{
		URL:          "http://" + net.JoinHostPort(host, port) + r.URL.RequestURI(),
		LogTag:       "rtc",
		ErrorMessage: "LiveKit 信令代理失败",
		// 全局 CORS 中间件已经写过跨域头，这里别再叠一层。
		CORS: proxy.CORSGlobal,
	}
	// Authorization 是 livekit-client 的 validate 凭证，必须显式透传：
	// 通用代理只认 Referer/Origin/Cookie 那一套白名单，不会自动带上它。
	if authorization := r.Header.Get("Authorization"); authorization != "" {
		options.Headers.Extra = map[string]string{"Authorization": authorization}
	}
	proxy.ProxyHTTPUpstream(w, r, options)
}

// tunnelLivekitWebSocket 把 `/rtc` 的升级请求接到 LiveKit 的 TCP 端口上。
func (s *Server) tunnelLivekitWebSocket(w http.ResponseWriter, r *http.Request) {
	host, port := livekitUpstream()
	upstream, err := net.DialTimeout("tcp", net.JoinHostPort(host, port), 5*time.Second)
	if err != nil {
		log.Printf("[rtc] 连接 LiveKit %s:%s 失败: %v", host, port, err)
		http.Error(w, "LiveKit 信令不可达", http.StatusBadGateway)
		return
	}

	// 必须走 ResponseController：外层 statusRecorder 包了一层 ResponseWriter，
	// 直接类型断言 http.Hijacker 会失败（它只透传了 Flush）。
	conn, rw, err := http.NewResponseController(w).Hijack()
	if err != nil {
		upstream.Close()
		log.Printf("[rtc] Hijack 失败: %v", err)
		return
	}

	if err := writeLivekitHandshake(upstream, r, rw); err != nil {
		conn.Close()
		upstream.Close()
		return
	}

	done := make(chan struct{}, 2)
	go func() {
		_, _ = io.Copy(upstream, conn)
		closeWrite(upstream)
		done <- struct{}{}
	}()
	go func() {
		_, _ = io.Copy(conn, upstream)
		closeWrite(conn)
		done <- struct{}{}
	}()
	// 任一方向结束就收摊：WebSocket 是长连接，只有断开才会 EOF。
	<-done
	conn.Close()
	upstream.Close()
}

// writeLivekitHandshake 把原始请求行与请求头重写给 LiveKit。
//
// upgrade 事件在 Node 里只给剩余字节，请求头要按 rawHeaders 重建；
// Go 的 Hijack 同样只拿到连接，请求头必须自己拼。Host 单独补——
// net/http 把 Host 从 Header 里摘出去了，不补上游会拿到空 Host。
func writeLivekitHandshake(upstream net.Conn, r *http.Request, rw *bufio.ReadWriter) error {
	var buf bytes.Buffer
	fmt.Fprintf(&buf, "%s %s HTTP/1.1\r\n", r.Method, r.URL.RequestURI())
	fmt.Fprintf(&buf, "Host: %s\r\n", r.Host)
	for key, values := range r.Header {
		if strings.EqualFold(key, "Host") {
			continue
		}
		for _, value := range values {
			fmt.Fprintf(&buf, "%s: %s\r\n", key, value)
		}
	}
	buf.WriteString("\r\n")
	if _, err := upstream.Write(buf.Bytes()); err != nil {
		return err
	}

	// Hijack 之前 bufio.Reader 可能已经吞下了客户端提前发来的字节
	// （握手后紧跟的第一帧），丢掉它会让连接建立后「第一句话丢失」。
	if buffered := rw.Reader.Buffered(); buffered > 0 {
		pending, err := rw.Reader.Peek(buffered)
		if err != nil {
			return err
		}
		if _, err := upstream.Write(pending); err != nil {
			return err
		}
		_, _ = rw.Reader.Discard(buffered)
	}
	return nil
}

func closeWrite(conn net.Conn) {
	type closeWriter interface{ CloseWrite() error }
	if cw, ok := conn.(closeWriter); ok {
		_ = cw.CloseWrite()
	}
}

// livekitUpstream 解析 LiveKit 的管理地址。
//
// 默认 3336 是内嵌 livekit 的 http_port（同时承载信令 WS 与 Twirp）。
// 端口缺失时也回落 3336 而不是按协议补 80/443——线上没有「http 默认端口
// 跑 LiveKit」这种部署。
func livekitUpstream() (string, string) {
	raw := strings.TrimSpace(os.Getenv("LIVEKIT_API_HOST"))
	if raw == "" {
		raw = "http://127.0.0.1:3336"
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Hostname() == "" {
		return "127.0.0.1", "3336"
	}
	port := parsed.Port()
	if port == "" {
		port = "3336"
	}
	return parsed.Hostname(), port
}
