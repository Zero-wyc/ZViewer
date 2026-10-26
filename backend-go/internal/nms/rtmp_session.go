package nms

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"strings"
	"time"
)

// RTMP 握手固定长度（规范 5.2）：C0/S0 各 1 字节，C1/S1/C2/S2 各 1536 字节。
const (
	handshakeVersion byte = 3
	handshakeSize         = 1536
	handshakeTimeout      = 10 * time.Second
)

var errRTMPHandshake = errors.New("rtmp: 握手失败")

// rtmpConn 是一条 RTMP 连接（推流端，通常是 OBS）。
type rtmpConn struct {
	srv  *embeddedServer
	conn net.Conn
	cr   *chunkReader
	cw   *chunkWriter

	app             string
	key             string
	publishing      bool
	publishStreamID uint32
	publishCancel   context.CancelFunc
	lease           *liveStream
}

func newRTMPConn(srv *embeddedServer, conn net.Conn) *rtmpConn {
	return &rtmpConn{srv: srv, conn: conn}
}

func (c *rtmpConn) serve() {
	defer c.conn.Close()
	defer c.unpublish()
	_ = c.conn.SetDeadline(time.Now().Add(handshakeTimeout))
	if err := c.handshake(); err != nil {
		c.srv.logf("[nms] RTMP 握手失败 %s: %v", c.conn.RemoteAddr(), err)
		return
	}
	_ = c.conn.SetDeadline(time.Time{})

	c.cr = newChunkReader(c.conn)
	c.cw = newChunkWriter(c.conn)

	for {
		if c.publishing && !c.srv.publishAllowed(context.Background(), c.key) {
			return
		}
		msg, err := c.cr.readMessage()
		if err != nil {
			if !errors.Is(err, io.EOF) && !errors.Is(err, net.ErrClosed) {
				c.srv.logf("[nms] 连接中断 %s: %v", c.conn.RemoteAddr(), err)
			}
			return
		}
		if err := c.handle(msg); err != nil {
			c.srv.logf("[nms] 消息处理失败 %s: %v", c.conn.RemoteAddr(), err)
			return
		}
	}
}

// handshake 走「简单握手」（明文，不带 digest）。
//
// S1 的版本字段为零，协商 OBS / FFmpeg 支持的简单握手。
// 必须回传 S2：客户端收到 S2 后才能开始发送 RTMP 命令。
func (c *rtmpConn) handshake() error {
	var c0 [1]byte
	if _, err := io.ReadFull(c.conn, c0[:]); err != nil {
		return err
	}
	if c0[0] != handshakeVersion {
		return errRTMPHandshake
	}
	c1 := make([]byte, handshakeSize)
	if _, err := io.ReadFull(c.conn, c1); err != nil {
		return err
	}

	// 一次返回 S0/S1/S2，避免等待 C2 的客户端与服务端互相等待。
	response := make([]byte, 1+2*handshakeSize)
	response[0] = handshakeVersion
	s1 := response[1 : 1+handshakeSize]
	if _, err := rand.Read(s1[8:]); err != nil {
		return err
	}
	// 简单握手的 S2 回显 C1 的时间及随机数据。
	copy(response[1+handshakeSize:], c1)
	if _, err := io.Copy(c.conn, bytes.NewReader(response)); err != nil {
		return err
	}

	// C2 是客户端对 S1 的回显，内容不校验（简单握手下没有鉴别能力）。
	c2 := make([]byte, handshakeSize)
	if _, err := io.ReadFull(c.conn, c2); err != nil {
		return err
	}
	return nil
}

func (c *rtmpConn) handle(msg rtmpMessage) error {
	switch msg.TypeID {
	case msgSetChunkSize:
		if len(msg.Payload) >= 4 {
			c.cr.setChunkSize(binary.BigEndian.Uint32(msg.Payload[:4]))
		}
	case msgAbort:
		// 中止某条消息的重组：丢掉半截载荷即可（下一条会重新开始）。
	case msgAcknowledgement, msgWindowAckSize, msgSetPeerBandwidth, msgUserControl:
		// 推送方向上的控制消息，对「收流 + 转 FLV」没有影响。
	case msgCommandAMF0:
		c.handleCommand(msg)
	case msgDataAMF0:
		c.handleData(msg)
	case msgAudio:
		if c.publishing {
			if !c.srv.hub.audio(c.key, msg.Timestamp, msg.Payload, c.lease) {
				return errRTMPProtocol
			}
		}
	case msgVideo:
		if c.publishing {
			if !c.srv.hub.video(c.key, msg.Timestamp, msg.Payload, c.lease) {
				return errRTMPProtocol
			}
		}
	case msgAggregate:
		// 聚合消息（类型 22）OBS 默认不发；真要支持得拆子消息，
		// 收益极低（老版 FMS 才用），这里按未识别的控制消息忽略。
	}
	return nil
}

func (c *rtmpConn) handleCommand(msg rtmpMessage) {
	dec := newAMF0Decoder(msg.Payload)
	nameVal, err := dec.decode()
	if err != nil {
		return
	}
	name, _ := nameVal.(string)

	txn := 0.0
	if v, err := dec.decode(); err == nil {
		if f, ok := v.(float64); ok {
			txn = f
		}
	}

	switch name {
	case "connect":
		cmdObj, _ := dec.decode()
		obj, _ := cmdObj.(map[string]any)
		c.onConnect(msg.StreamID, txn, obj)
	case "releaseStream", "FCPublish":
		// 老式「先预约再发布」的两步，回个空 _result 即可。
		c.sendResult(msg.StreamID, txn, nil, nil)
	case "createStream":
		// 固定分配 stream id 1：单连接单流，够用且与 OBS 的期望一致。
		c.sendResult(msg.StreamID, txn, nil, float64(1))
	case "publish":
		_, _ = dec.decode() // null
		streamName := ""
		if v, err := dec.decode(); err == nil {
			streamName, _ = v.(string)
		}
		c.onPublish(msg.StreamID, streamName)
	case "deleteStream", "closeStream", "FCUnpublish":
		c.unpublish()
	case "getStreamLength":
		c.sendResult(msg.StreamID, txn, nil, float64(0))
	case "checkBandwidth", "_checkbw":
		c.sendResult(msg.StreamID, txn, nil, nil, nil)
	}
}

func (c *rtmpConn) onConnect(streamID uint32, txn float64, obj map[string]any) {
	if v, ok := obj["app"].(string); ok {
		c.app = v
	}

	c.sendWindowAckSize(2500000)
	c.sendSetPeerBandwidth(2500000, 2)
	c.sendSetChunkSize(4096)

	encoding := 0.0
	if v, ok := obj["objectEncoding"].(float64); ok {
		encoding = v
	}
	c.sendCommand(streamID, "_result", txn,
		map[string]any{
			"fmsVer":       "FMS/3,0,1,123",
			"capabilities": float64(31),
			"mode":         float64(1),
		},
		map[string]any{
			"level":          "status",
			"code":           "NetStream.Connect.Success",
			"description":    "Connection succeeded.",
			"objectEncoding": encoding,
		},
	)
}

func (c *rtmpConn) onPublish(streamID uint32, streamName string) {
	key := streamName
	// OBS 允许在「服务器」里带查询串（rtmp://host/live?token=x），
	// 推流码本身只取路径末段，与 Node 版的解析保持一致。
	if i := strings.IndexAny(key, "?"); i >= 0 {
		key = key[:i]
	}
	if i := strings.LastIndex(key, "/"); i >= 0 {
		key = key[i+1:]
	}
	if key == "" {
		c.srv.logf("[nms] 推流码为空，拒绝 %s", c.conn.RemoteAddr())
		return
	}

	if c.publishing || strings.Split(c.app, "?")[0] != "live" || c.srv.publishAllowed == nil || !c.srv.publishAllowed(context.Background(), key) {
		c.sendCommand(streamID, "onStatus", 0, nil, map[string]any{"level": "error", "code": "NetStream.Publish.BadName", "description": "发布未授权或已有发布者"})
		return
	}
	lease := c.srv.hub.start(key)
	if lease == nil {
		c.sendCommand(streamID, "onStatus", 0, nil, map[string]any{"level": "error", "code": "NetStream.Publish.BadName", "description": "已有发布者"})
		return
	}
	c.lease = lease

	c.key = key
	c.publishing = true
	c.publishStreamID = streamID
	ctx, cancel := context.WithCancel(context.Background())
	c.publishCancel = cancel
	go func(key string) {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if !c.srv.publishAllowed(ctx, key) {
					_ = c.conn.Close()
					return
				}
			}
		}
	}(key)
	c.srv.logf("[nms] 开始推流（来自 %s）", c.conn.RemoteAddr())

	// 先 StreamBegin 再 onStatus：部分客户端要靠 StreamBegin 才开始发帧。
	c.sendUserControl(0, streamID)
	c.sendCommand(streamID, "onStatus", 0, nil, map[string]any{
		"level":       "status",
		"code":        "NetStream.Publish.Start",
		"description": "Start publishing",
		"details":     key,
	})
}

func (c *rtmpConn) unpublish() {
	if !c.publishing {
		return
	}
	c.publishing = false
	if c.publishCancel != nil {
		c.publishCancel()
		c.publishCancel = nil
	}
	c.srv.hub.stop(c.key, c.lease)
	c.srv.logf("[nms] 推流结束")
}

func (c *rtmpConn) handleData(msg rtmpMessage) {
	if !c.publishing {
		return
	}
	dec := newAMF0Decoder(msg.Payload)
	nameVal, err := dec.decode()
	if err != nil {
		return
	}
	name, _ := nameVal.(string)

	switch name {
	case "@setDataFrame":
		v, err := dec.decode()
		if err != nil {
			return
		}
		if s, ok := v.(string); !ok || s != "onMetaData" {
			return
		}
	case "onMetaData":
		// 直接来的 onMetaData（少数实现不带 @setDataFrame 前缀）。
	default:
		return
	}

	obj, err := dec.decode()
	if err != nil {
		return
	}
	meta, ok := obj.(map[string]any)
	if !ok {
		return
	}
	c.srv.hub.setMetadata(c.key, meta, c.lease)
}

// ---- 发送侧 ----

func (c *rtmpConn) sendCommand(streamID uint32, name string, txn float64, args ...any) {
	var buf bytes.Buffer
	writeAMF0String(&buf, name)
	writeAMF0Value(&buf, txn)
	for _, a := range args {
		writeAMF0Value(&buf, a)
	}
	_ = c.cw.writeMessage(msgCommandAMF0, streamID, 0, buf.Bytes())
}

func (c *rtmpConn) sendResult(streamID uint32, txn float64, args ...any) {
	c.sendCommand(streamID, "_result", txn, args...)
}

func (c *rtmpConn) sendWindowAckSize(size uint32) {
	var payload [4]byte
	binary.BigEndian.PutUint32(payload[:], size)
	_ = c.cw.writeMessage(msgWindowAckSize, 0, 0, payload[:])
}

func (c *rtmpConn) sendSetPeerBandwidth(size uint32, limitType byte) {
	payload := make([]byte, 5)
	binary.BigEndian.PutUint32(payload[:4], size)
	payload[4] = limitType
	_ = c.cw.writeMessage(msgSetPeerBandwidth, 0, 0, payload)
}

func (c *rtmpConn) sendSetChunkSize(size uint32) {
	var payload [4]byte
	binary.BigEndian.PutUint32(payload[:], size)
	// 先用旧块大小写出去，再切换写侧块大小（规范要求收到/发出之后才生效）。
	_ = c.cw.writeMessage(msgSetChunkSize, 0, 0, payload[:])
	c.cw.setChunkSize(size)
}

func (c *rtmpConn) sendUserControl(event uint16, arg uint32) {
	payload := make([]byte, 6)
	binary.BigEndian.PutUint16(payload[:2], event)
	binary.BigEndian.PutUint32(payload[2:], arg)
	_ = c.cw.writeMessage(msgUserControl, 0, 0, payload)
}
