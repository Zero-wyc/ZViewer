package sio

import (
	"bufio"
	"io"
	"net"
	"sync"
	"testing"
	"time"
)

// clientFrame 构造一个客户端→服务端的帧（必须带掩码）。
func clientFrame(opcode byte, fin bool, payload []byte) []byte {
	var hdr []byte
	b0 := opcode
	if fin {
		b0 |= 0x80
	}
	hdr = append(hdr, b0)

	n := len(payload)
	switch {
	case n < 126:
		hdr = append(hdr, byte(n)|0x80)
	case n <= 0xFFFF:
		hdr = append(hdr, 126|0x80, byte(n>>8), byte(n))
	default:
		hdr = append(hdr, 127|0x80)
		for i := 7; i >= 0; i-- {
			hdr = append(hdr, byte(uint64(n)>>(8*i)))
		}
	}
	mask := [4]byte{0xA1, 0xB2, 0xC3, 0xD4}
	hdr = append(hdr, mask[:]...)
	masked := make([]byte, n)
	for i := 0; i < n; i++ {
		masked[i] = payload[i] ^ mask[i&3]
	}
	return append(hdr, masked...)
}

// memConn 是带缓冲的内存连接。
//
// 不能用 net.Pipe：它是同步无缓冲的，服务端回 pong/close 时会一直阻塞到
// 对端读取，而测试里对端往往已经写完退出，于是整个测试挂死。
type memConn struct {
	peer   *memConn
	mu     sync.Mutex
	cond   *sync.Cond
	rbuf   []byte
	closed bool
}

func newMemPair() (*memConn, *memConn) {
	a, b := &memConn{}, &memConn{}
	a.cond = sync.NewCond(&a.mu)
	b.cond = sync.NewCond(&b.mu)
	a.peer, b.peer = b, a
	return a, b
}

func (c *memConn) Read(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for len(c.rbuf) == 0 && !c.closed {
		c.cond.Wait()
	}
	if len(c.rbuf) == 0 {
		return 0, io.EOF
	}
	n := copy(p, c.rbuf)
	c.rbuf = c.rbuf[n:]
	return n, nil
}

func (c *memConn) Write(p []byte) (int, error) {
	peer := c.peer
	peer.mu.Lock()
	defer peer.mu.Unlock()
	if peer.closed {
		return 0, io.ErrClosedPipe
	}
	peer.rbuf = append(peer.rbuf, p...)
	peer.cond.Broadcast()
	return len(p), nil
}

func (c *memConn) Close() error {
	c.mu.Lock()
	c.closed = true
	c.cond.Broadcast()
	c.mu.Unlock()
	return nil
}

func (c *memConn) LocalAddr() net.Addr              { return nil }
func (c *memConn) RemoteAddr() net.Addr             { return nil }
func (c *memConn) SetDeadline(time.Time) error      { return nil }
func (c *memConn) SetReadDeadline(time.Time) error  { return nil }
func (c *memConn) SetWriteDeadline(time.Time) error { return nil }

// newPipePair 返回 (服务端 wsConn, 客户端连接)。
func newPipePair(t *testing.T) (*wsConn, *memConn) {
	t.Helper()
	server, client := newMemPair()
	t.Cleanup(func() {
		_ = server.Close()
		_ = client.Close()
	})
	return &wsConn{conn: server, br: bufio.NewReader(server), maxPayload: DefaultMaxPayload}, client
}

func TestWSReadMessageText(t *testing.T) {
	ws, client := newPipePair(t)
	go func() {
		_, _ = client.Write(clientFrame(wsOpText, true, []byte("hello")))
	}()
	msg, err := ws.ReadMessage()
	if err != nil {
		t.Fatalf("ReadMessage: %v", err)
	}
	if msg != "hello" {
		t.Fatalf("msg = %q", msg)
	}
}

// 分片消息必须重组：engine.io 发送大载荷时会分片，不重组会把一条消息切成多条。
func TestWSReadMessageFragmented(t *testing.T) {
	ws, client := newPipePair(t)
	go func() {
		_, _ = client.Write(clientFrame(wsOpText, false, []byte("he")))
		_, _ = client.Write(clientFrame(wsOpContinuation, false, []byte("ll")))
		_, _ = client.Write(clientFrame(wsOpContinuation, true, []byte("o")))
	}()
	msg, err := ws.ReadMessage()
	if err != nil {
		t.Fatalf("ReadMessage: %v", err)
	}
	if msg != "hello" {
		t.Fatalf("msg = %q, want hello", msg)
	}
}

// 收到 ping 必须自动回 pong，否则客户端会按 pingTimeout 断开。
func TestWSRespondsToPing(t *testing.T) {
	ws, client := newPipePair(t)
	go func() {
		_, _ = client.Write(clientFrame(wsOpPing, true, []byte("hb")))
		_, _ = client.Write(clientFrame(wsOpText, true, []byte("after")))
	}()
	msg, err := ws.ReadMessage()
	if err != nil {
		t.Fatalf("ReadMessage: %v", err)
	}
	if msg != "after" {
		t.Fatalf("msg = %q", msg)
	}
	// 读回 pong 帧
	var hdr [2]byte
	if _, err := io.ReadFull(client, hdr[:]); err != nil {
		t.Fatalf("读 pong 头: %v", err)
	}
	if hdr[0]&0x0F != wsOpPong {
		t.Fatalf("opcode = %#x, want pong", hdr[0]&0x0F)
	}
	payload := make([]byte, hdr[1]&0x7F)
	if _, err := io.ReadFull(client, payload); err != nil {
		t.Fatalf("读 pong 载荷: %v", err)
	}
	if string(payload) != "hb" {
		t.Fatalf("pong 载荷 = %q", payload)
	}
}

func TestWSCloseFrame(t *testing.T) {
	ws, client := newPipePair(t)
	go func() {
		_, _ = client.Write(clientFrame(wsOpClose, true, []byte{0x03, 0xe8}))
	}()
	if _, err := ws.ReadMessage(); err != errWSClosed {
		t.Fatalf("err = %v, want errWSClosed", err)
	}
}

// 帧长度跨越 125/126/65535 三个编码分支，写读都要一致。
func TestWSWriteReadLengthBoundaries(t *testing.T) {
	for _, n := range []int{0, 1, 125, 126, 65535, 65536} {
		ws, client := newPipePair(t)
		payload := make([]byte, n)
		for i := range payload {
			payload[i] = byte('a' + i%26)
		}
		go func() {
			_ = ws.WriteText(string(payload))
		}()
		br := bufio.NewReader(client)
		got, err := readClientMessage(br)
		if err != nil {
			t.Fatalf("n=%d 读回失败: %v", n, err)
		}
		if got != string(payload) {
			t.Fatalf("n=%d 内容不一致", n)
		}
	}
}

// readClientMessage 从客户端视角读一条消息（服务端帧不带掩码）。
func readClientMessage(br *bufio.Reader) (string, error) {
	var hdr [2]byte
	if _, err := io.ReadFull(br, hdr[:]); err != nil {
		return "", err
	}
	length := int64(hdr[1] & 0x7F)
	switch length {
	case 126:
		var ext [2]byte
		if _, err := io.ReadFull(br, ext[:]); err != nil {
			return "", err
		}
		length = int64(ext[0])<<8 | int64(ext[1])
	case 127:
		var ext [8]byte
		if _, err := io.ReadFull(br, ext[:]); err != nil {
			return "", err
		}
		length = 0
		for i := 0; i < 8; i++ {
			length = length<<8 | int64(ext[i])
		}
	}
	buf := make([]byte, length)
	if _, err := io.ReadFull(br, buf); err != nil {
		return "", err
	}
	return string(buf), nil
}
