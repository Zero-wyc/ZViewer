package sio

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// 升级流程的关键在于：服务端收到 `2probe` 时必须在**轮询通道**上补一个 noop，
// 否则客户端要等满 pingInterval 才能停下长轮询，页面表现为「开了好几秒才转成 WebSocket」。
//
// 这里把 PingInterval 设成 30s：如果 noop 没发出去，这个测试会超时失败，
// 而不是靠掐时间碰运气。
func TestProbeFlushesPendingPoll(t *testing.T) {
	srv := NewServer(Options{PingInterval: 30 * time.Second, PingTimeout: 30 * time.Second})
	mux := http.NewServeMux()
	mux.Handle("/socket.io/", srv)
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)

	// 1. 握手拿 sid
	resp, err := http.Get(ts.URL + "/socket.io/?EIO=4&transport=polling")
	if err != nil {
		t.Fatalf("握手失败: %v", err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	var hs struct {
		Sid string `json:"sid"`
	}
	if err := json.Unmarshal(body[1:], &hs); err != nil {
		t.Fatalf("open 载荷解析失败: %v (%q)", err, body)
	}
	pollURL := ts.URL + "/socket.io/?EIO=4&transport=polling&sid=" + hs.Sid

	// 2. 发起一个长轮询（此时队列为空，应当挂住）
	polled := make(chan string, 1)
	go func() {
		r, err := http.Get(pollURL)
		if err != nil {
			polled <- "ERR:" + err.Error()
			return
		}
		defer r.Body.Close()
		b, _ := io.ReadAll(r.Body)
		polled <- string(b)
	}()

	// 给它一点时间真正挂起
	time.Sleep(100 * time.Millisecond)

	// 3. 用裸 TCP 完成 WebSocket 握手（带 sid = 升级模式）
	addr := ts.Listener.Addr().String()
	conn, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatalf("拨号失败: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })

	req := fmt.Sprintf(
		"GET /socket.io/?EIO=4&transport=websocket&sid=%s HTTP/1.1\r\n"+
			"Host: %s\r\n"+
			"Upgrade: websocket\r\n"+
			"Connection: Upgrade\r\n"+
			"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"+
			"Sec-WebSocket-Version: 13\r\n\r\n",
		hs.Sid, addr,
	)
	if _, err := conn.Write([]byte(req)); err != nil {
		t.Fatalf("写握手请求失败: %v", err)
	}
	br := bufio.NewReader(conn)
	status, err := br.ReadString('\n')
	if err != nil {
		t.Fatalf("读握手响应失败: %v", err)
	}
	if !strings.Contains(status, "101") {
		t.Fatalf("握手状态 = %q, want 101", strings.TrimSpace(status))
	}
	// 吃掉剩余响应头
	for {
		line, err := br.ReadString('\n')
		if err != nil {
			t.Fatalf("读响应头失败: %v", err)
		}
		if line == "\r\n" {
			break
		}
	}

	// 4. 发 probe，必须立刻收到 3probe
	if _, err := conn.Write(clientFrame(wsOpText, true, []byte("2probe"))); err != nil {
		t.Fatalf("写 probe 失败: %v", err)
	}
	probeReply, err := readClientMessage(br)
	if err != nil {
		t.Fatalf("读 probe 应答失败: %v", err)
	}
	if probeReply != "3probe" {
		t.Fatalf("probe 应答 = %q, want 3probe", probeReply)
	}

	// 5. 关键断言：挂起的轮询必须立刻返回 noop
	select {
	case got := <-polled:
		if got != string(eioNoop) {
			t.Fatalf("挂起的轮询返回 %q, want noop(%q)", got, string(eioNoop))
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("probe 之后 2s 内轮询没有返回，noop 冲刷缺失")
	}

	// 6. 升级前塞一个包进队列，升级后它必须从 WebSocket 出来
	postResp, err := http.Post(pollURL, "text/plain;charset=UTF-8", strings.NewReader("40"))
	if err != nil {
		t.Fatalf("POST CONNECT 失败: %v", err)
	}
	postResp.Body.Close()

	if _, err := conn.Write(clientFrame(wsOpText, true, []byte("5"))); err != nil {
		t.Fatalf("写 upgrade 失败: %v", err)
	}
	flushed, err := readClientMessage(br)
	if err != nil {
		t.Fatalf("读升级后冲刷的包失败: %v", err)
	}
	if !strings.HasPrefix(flushed, "40{") {
		t.Fatalf("升级后首个包 = %q, want CONNECT 应答", flushed)
	}
}
