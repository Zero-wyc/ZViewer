package sio

import (
	"bufio"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
)

// RFC 6455 服务端最小实现。
//
// 只覆盖 Engine.IO 需要的部分：文本帧、分片重组、ping/pong、close。
// 不实现的（本场景用不到）：扩展协商（permessage-deflate）、二进制消息、
// 客户端角色。engine.io 的 websocket 传输只用文本帧。

// wsAcceptGUID 是 RFC 6455 规定的固定拼接串，参与 Sec-WebSocket-Accept 计算。
const wsAcceptGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

const (
	wsOpContinuation = 0x0
	wsOpText         = 0x1
	wsOpBinary       = 0x2
	wsOpClose        = 0x8
	wsOpPing         = 0x9
	wsOpPong         = 0xA
)

// errWSClosed 表示对端发了 close 帧或连接已断。
var errWSClosed = errors.New("sio: websocket 连接已关闭")

// wsConn 是一条已完成握手的 WebSocket 连接。
//
// 读写各自加锁：读由单个 goroutine 驱动，写可能来自广播（任意 goroutine）。
// net.Conn 的 Write 不保证并发安全，缺少这把锁会出现帧交错、
// 表现为客户端 JSON 解析失败然后直接断开。
type wsConn struct {
	conn       net.Conn
	br         *bufio.Reader
	writeMu    sync.Mutex
	maxPayload int64
	closeOnce  sync.Once
}

// headerHasToken 判断以逗号分隔的头里是否含某个 token（大小写不敏感）。
func headerHasToken(h http.Header, name, token string) bool {
	for _, v := range h.Values(name) {
		for _, part := range strings.Split(v, ",") {
			if strings.EqualFold(strings.TrimSpace(part), token) {
				return true
			}
		}
	}
	return false
}

// upgradeWebSocket 完成握手并把底层连接从 http.Server 手里接管过来。
//
// 必须用 Hijacker：握手之后这条连接不再走 net/http 的读写路径，
// 继续由 ResponseWriter 管理会把 WebSocket 帧当作非法 HTTP 报文。
func upgradeWebSocket(w http.ResponseWriter, r *http.Request, maxPayload int64) (*wsConn, error) {
	if !headerHasToken(r.Header, "Connection", "upgrade") {
		return nil, errors.New("websocket: Connection 头缺少 upgrade")
	}
	if !strings.EqualFold(strings.TrimSpace(r.Header.Get("Upgrade")), "websocket") {
		return nil, errors.New("websocket: Upgrade 头不是 websocket")
	}
	key := strings.TrimSpace(r.Header.Get("Sec-WebSocket-Key"))
	if key == "" {
		return nil, errors.New("websocket: 缺少 Sec-WebSocket-Key")
	}
	if v := strings.TrimSpace(r.Header.Get("Sec-WebSocket-Version")); v != "13" {
		return nil, fmt.Errorf("websocket: 不支持的版本 %q", v)
	}
	// 用 ResponseController 而不是直接 `w.(http.Hijacker)`：主服务会把
	// ResponseWriter 包成 statusRecorder（记录状态码与字节数），那层包装
	// 不实现 Hijacker，直接断言必然失败——表现是「HTTP 接口一切正常，
	// 但 WebSocket 永远连不上，只报 websocket error」。ResponseController
	// 会顺着 Unwrap 找到真正的写入器。
	conn, brw, err := http.NewResponseController(w).Hijack()
	if err != nil {
		return nil, fmt.Errorf("websocket: Hijack 失败: %w", err)
	}
	sum := sha1.Sum([]byte(key + wsAcceptGUID))
	accept := base64.StdEncoding.EncodeToString(sum[:])
	resp := "HTTP/1.1 101 Switching Protocols\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Accept: " + accept + "\r\n\r\n"
	if _, err := conn.Write([]byte(resp)); err != nil {
		_ = conn.Close()
		return nil, err
	}
	return &wsConn{conn: conn, br: brw.Reader, maxPayload: maxPayload}, nil
}

// readFrame 读一帧并解掩码。返回 (opcode, fin, payload)。
func (c *wsConn) readFrame() (byte, bool, []byte, error) {
	var hdr [2]byte
	if _, err := io.ReadFull(c.br, hdr[:]); err != nil {
		return 0, false, nil, err
	}
	fin := hdr[0]&0x80 != 0
	if hdr[0]&0x70 != 0 {
		// 没有协商任何扩展，RSV 位必须为 0
		return 0, false, nil, errors.New("websocket: RSV 位非零")
	}
	opcode := hdr[0] & 0x0f
	masked := hdr[1]&0x80 != 0
	length := int64(hdr[1] & 0x7f)

	switch length {
	case 126:
		var ext [2]byte
		if _, err := io.ReadFull(c.br, ext[:]); err != nil {
			return 0, false, nil, err
		}
		length = int64(binary.BigEndian.Uint16(ext[:]))
	case 127:
		var ext [8]byte
		if _, err := io.ReadFull(c.br, ext[:]); err != nil {
			return 0, false, nil, err
		}
		u := binary.BigEndian.Uint64(ext[:])
		// 超过 1 TiB 直接拒绝，避免 make([]byte, huge) 触发 OOM
		if u > 1<<40 {
			return 0, false, nil, errors.New("websocket: 帧长度非法")
		}
		length = int64(u)
	}
	if c.maxPayload > 0 && length > c.maxPayload {
		return 0, false, nil, fmt.Errorf("websocket: 帧 %d 字节超过上限 %d", length, c.maxPayload)
	}

	var mask [4]byte
	if masked {
		if _, err := io.ReadFull(c.br, mask[:]); err != nil {
			return 0, false, nil, err
		}
	}
	payload := make([]byte, length)
	if length > 0 {
		if _, err := io.ReadFull(c.br, payload); err != nil {
			return 0, false, nil, err
		}
	}
	if masked {
		for i := range payload {
			payload[i] ^= mask[i&3]
		}
	}
	return opcode, fin, payload, nil
}

// ReadMessage 读一条完整消息（自动重组分片、自动回 pong）。
func (c *wsConn) ReadMessage() (string, error) {
	var buf []byte
	inFragment := false
	for {
		op, fin, payload, err := c.readFrame()
		if err != nil {
			return "", err
		}
		switch op {
		case wsOpPing:
			if err := c.writeFrame(wsOpPong, payload); err != nil {
				return "", err
			}
			continue
		case wsOpPong:
			continue
		case wsOpClose:
			// 回一个 close 帧再退出，这是 RFC 要求的关闭握手
			_ = c.writeFrame(wsOpClose, payload)
			return "", errWSClosed
		case wsOpContinuation:
			if !inFragment {
				return "", errors.New("websocket: 意外的续帧")
			}
			buf = append(buf, payload...)
		case wsOpText, wsOpBinary:
			if inFragment {
				return "", errors.New("websocket: 上一帧分片未结束")
			}
			inFragment = true
			buf = append(buf, payload...)
		default:
			return "", fmt.Errorf("websocket: 未知操作码 %#x", op)
		}
		if fin {
			return string(buf), nil
		}
	}
}

// writeFrame 写一帧（服务端帧不带掩码，FIN 恒为 1）。
func (c *wsConn) writeFrame(opcode byte, payload []byte) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()

	var hdr [10]byte
	hdr[0] = 0x80 | opcode
	n := 2
	switch {
	case len(payload) < 126:
		hdr[1] = byte(len(payload))
	case len(payload) <= 0xFFFF:
		hdr[1] = 126
		binary.BigEndian.PutUint16(hdr[2:4], uint16(len(payload)))
		n = 4
	default:
		hdr[1] = 127
		binary.BigEndian.PutUint64(hdr[2:10], uint64(len(payload)))
		n = 10
	}
	if _, err := c.conn.Write(hdr[:n]); err != nil {
		return err
	}
	if len(payload) > 0 {
		if _, err := c.conn.Write(payload); err != nil {
			return err
		}
	}
	return nil
}

// WriteText 以文本帧发送一条消息。
func (c *wsConn) WriteText(s string) error {
	return c.writeFrame(wsOpText, []byte(s))
}

// Close 发送 close 帧并关闭底层连接（可重复调用）。
func (c *wsConn) Close() error {
	var err error
	c.closeOnce.Do(func() {
		_ = c.writeFrame(wsOpClose, nil)
		err = c.conn.Close()
	})
	return err
}
