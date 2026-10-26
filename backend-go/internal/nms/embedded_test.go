package nms

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"
)

// ---- 测试用的假推流客户端 ----

func freePort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("取空闲端口失败: %v", err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	_ = ln.Close()
	return port
}

func startTestServer(t *testing.T) (*embeddedServer, int, int) {
	t.Helper()
	rtmpPort := freePort(t)
	httpPort := freePort(t)
	srv := newEmbeddedServer(Config{
		RtmpPort:    rtmpPort,
		HTTPFLVBase: fmt.Sprintf("http://127.0.0.1:%d", httpPort),
		Embedded:    true,
		BindHost:    "127.0.0.1",
	}, t.Logf)
	srv.publishAllowed = func(context.Context, string) bool { return true }
	srv.watchAllowed = func(context.Context, string, string) bool { return true }
	if err := srv.start(); err != nil {
		t.Fatalf("启动内置媒体服务失败: %v", err)
	}
	t.Cleanup(func() { _ = srv.close(context.Background()) })
	return srv, rtmpPort, httpPort
}

type fakePublisher struct {
	t    *testing.T
	conn net.Conn
	cr   *chunkReader
	cw   *chunkWriter
}

func dialPublisher(t *testing.T, port int) *fakePublisher {
	t.Helper()
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 3*time.Second)
	if err != nil {
		t.Fatalf("连接 RTMP 端口失败: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })

	p := &fakePublisher{t: t, conn: conn}
	p.handshake()
	p.cr = newChunkReader(conn)
	p.cw = newChunkWriter(conn)
	p.cw.setChunkSize(defaultChunkSize) // 客户端未协商前也是 128
	return p
}

func (p *fakePublisher) handshake() {
	p.t.Helper()
	_ = p.conn.SetDeadline(time.Now().Add(3 * time.Second))
	defer p.conn.SetDeadline(time.Time{})
	c1 := make([]byte, handshakeSize)
	if _, err := rand.Read(c1); err != nil {
		p.t.Fatalf("生成 C1 失败: %v", err)
	}
	if _, err := p.conn.Write(append([]byte{handshakeVersion}, c1...)); err != nil {
		p.t.Fatalf("写 C0/C1 失败: %v", err)
	}
	var s0 [1]byte
	if _, err := io.ReadFull(p.conn, s0[:]); err != nil {
		p.t.Fatalf("读 S0 失败: %v", err)
	}
	if s0[0] != handshakeVersion {
		p.t.Fatalf("S0 版本 = %d, want 3", s0[0])
	}
	s1 := make([]byte, handshakeSize)
	if _, err := io.ReadFull(p.conn, s1); err != nil {
		p.t.Fatalf("读 S1 失败: %v", err)
	}
	// 与 OBS 一样，在发送任何 RTMP 命令前必须收到 S2。
	s2 := make([]byte, handshakeSize)
	if _, err := io.ReadFull(p.conn, s2); err != nil {
		p.t.Fatalf("读 S2 失败: %v", err)
	}
	if !bytes.Equal(s2[:4], c1[:4]) || !bytes.Equal(s2[8:], c1[8:]) {
		p.t.Fatal("S2 未回显 C1 的时间和随机数据")
	}
	if _, err := p.conn.Write(s1); err != nil {
		p.t.Fatalf("写 C2 失败: %v", err)
	}
}

func (p *fakePublisher) sendCommand(name string, txn float64, args ...any) {
	p.t.Helper()
	var buf bytes.Buffer
	writeAMF0String(&buf, name)
	writeAMF0Value(&buf, txn)
	for _, a := range args {
		writeAMF0Value(&buf, a)
	}
	if err := p.cw.writeMessage(msgCommandAMF0, 0, 0, buf.Bytes()); err != nil {
		p.t.Fatalf("写命令 %s 失败: %v", name, err)
	}
}

// readCommandName 读下一条命令消息并返回命令名（跳过音频/视频等非命令消息）。
func (p *fakePublisher) readCommandName(timeout time.Duration) string {
	p.t.Helper()
	_ = p.conn.SetReadDeadline(time.Now().Add(timeout))
	defer func() { _ = p.conn.SetReadDeadline(time.Time{}) }()

	for {
		msg, err := p.cr.readMessage()
		if err != nil {
			p.t.Fatalf("读服务端消息失败: %v", err)
		}
		// 服务端第一条就是把出方向块大小改成 4096（OBS 也会照做），
		// 测试端要跟着改，否则会把后续大消息的续块当成新消息解析。
		if msg.TypeID == msgSetChunkSize && len(msg.Payload) >= 4 {
			p.cr.setChunkSize(binary.BigEndian.Uint32(msg.Payload[:4]))
			continue
		}
		if msg.TypeID != msgCommandAMF0 {
			continue
		}
		dec := newAMF0Decoder(msg.Payload)
		v, err := dec.decode()
		if err != nil {
			p.t.Fatalf("解析命令失败: %v", err)
		}
		name, _ := v.(string)
		return name
	}
}

func (p *fakePublisher) connect(app string) {
	p.t.Helper()
	p.sendCommand("connect", 1,
		map[string]any{
			"app":            app,
			"flashVer":       "FMLE/3.0 (compatible; FMSc/1.0)",
			"tcUrl":          "rtmp://127.0.0.1/live",
			"objectEncoding": float64(0),
		},
	)
	if name := p.readCommandName(3 * time.Second); name != "_result" {
		p.t.Fatalf("connect 应答 = %q, want _result", name)
	}
}

func (p *fakePublisher) publish(key string) {
	p.t.Helper()
	p.sendCommand("releaseStream", 2, nil, key)
	if name := p.readCommandName(2 * time.Second); name != "_result" {
		p.t.Fatalf("releaseStream 应答 = %q", name)
	}
	p.sendCommand("FCPublish", 3, nil, key)
	if name := p.readCommandName(2 * time.Second); name != "_result" {
		p.t.Fatalf("FCPublish 应答 = %q", name)
	}
	p.sendCommand("createStream", 4, nil)
	if name := p.readCommandName(2 * time.Second); name != "_result" {
		p.t.Fatalf("createStream 应答 = %q", name)
	}
	// publish 走 streamID=1（服务端固定分配的那个）
	var buf bytes.Buffer
	writeAMF0String(&buf, "publish")
	writeAMF0Value(&buf, float64(5))
	writeAMF0Value(&buf, nil)
	writeAMF0String(&buf, key)
	writeAMF0String(&buf, "live")
	if err := p.cw.writeMessage(msgCommandAMF0, 1, 0, buf.Bytes()); err != nil {
		p.t.Fatalf("写 publish 失败: %v", err)
	}
	if name := p.readCommandName(3 * time.Second); name != "onStatus" {
		p.t.Fatalf("publish 应答 = %q, want onStatus", name)
	}
}

func (p *fakePublisher) sendMetadata() {
	p.t.Helper()
	var buf bytes.Buffer
	writeAMF0String(&buf, "@setDataFrame")
	writeAMF0String(&buf, "onMetaData")
	writeAMF0EcmaArray(&buf, map[string]any{
		"width":        float64(1920),
		"height":       float64(1080),
		"framerate":    float64(30),
		"videocodecid": float64(7),
		"audiocodecid": float64(10),
	})
	if err := p.cw.writeMessage(msgDataAMF0, 1, 0, buf.Bytes()); err != nil {
		p.t.Fatalf("写 onMetaData 失败: %v", err)
	}
}

func (p *fakePublisher) send(tag flvTag) {
	p.t.Helper()
	typ := msgVideo
	if tag.typ == msgAudio {
		typ = msgAudio
	}
	if err := p.cw.writeMessage(typ, 1, tag.ts, tag.data); err != nil {
		p.t.Fatalf("写媒体帧失败: %v", err)
	}
}

// ---- 用例 ----

func TestAMF0RoundTrip(t *testing.T) {
	values := []any{
		float64(42),
		true,
		"hello",
		nil,
		map[string]any{"a": float64(1), "b": "x", "c": map[string]any{"d": false}},
		[]any{float64(1), "two", nil},
	}
	for _, want := range values {
		var buf bytes.Buffer
		writeAMF0Value(&buf, want)
		got, err := newAMF0Decoder(buf.Bytes()).decode()
		if err != nil {
			t.Fatalf("解码失败（%v）: %v", want, err)
		}
		if fmt.Sprint(got) != fmt.Sprint(want) {
			t.Errorf("往返不一致: got %v, want %v", got, want)
		}
	}
}

func TestChunkWriterReaderReassembly(t *testing.T) {
	// 800 字节 > 128 默认块大小，强制走 fmt0 + fmt3 续块。
	payload := bytes.Repeat([]byte{0xAB}, 800)
	var buf bytes.Buffer
	cw := newChunkWriter(&buf)
	cw.setChunkSize(defaultChunkSize)
	if err := cw.writeMessage(msgVideo, 1, 1234, payload); err != nil {
		t.Fatalf("writeMessage: %v", err)
	}

	cr := newChunkReader(&buf)
	msg, err := cr.readMessage()
	if err != nil {
		t.Fatalf("readMessage: %v", err)
	}
	if msg.TypeID != msgVideo || msg.StreamID != 1 || msg.Timestamp != 1234 {
		t.Fatalf("头部不一致: %+v", msg)
	}
	if !bytes.Equal(msg.Payload, payload) {
		t.Fatalf("载荷不一致（%d vs %d 字节）", len(msg.Payload), len(payload))
	}
}

func TestEmbeddedRTMPToFLV(t *testing.T) {
	_, rtmpPort, httpPort := startTestServer(t)

	pub := dialPublisher(t, rtmpPort)
	pub.connect("live")
	pub.publish("ABCD2345")
	pub.sendMetadata()

	videoSeq := []byte{0x17, 0x00, 0x00, 0x00, 0x00, 0x01, 0x64, 0x00, 0x1F}
	audioSeq := []byte{0xAF, 0x00, 0x12, 0x10}
	keyframe := []byte{0x17, 0x01, 0x00, 0x00, 0x00, 0x02, 0x09, 0xF0}
	pframe := []byte{0x27, 0x01, 0x00, 0x00, 0x00, 0x03, 0x09, 0xF1}
	audioFrame := []byte{0xAF, 0x01, 0x21, 0x00, 0x05}

	pub.send(flvTag{typ: msgVideo, ts: 0, data: videoSeq})
	pub.send(flvTag{typ: msgAudio, ts: 0, data: audioSeq})
	pub.send(flvTag{typ: msgVideo, ts: 0, data: keyframe})
	pub.send(flvTag{typ: msgVideo, ts: 33, data: pframe})
	pub.send(flvTag{typ: msgAudio, ts: 40, data: audioFrame})

	// 给服务端一点时间把帧写进 hub（同一连接内的处理是同步的，
	// 这里只是避免与 HTTP 订阅建立竞争）。
	time.Sleep(100 * time.Millisecond)

	resp, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/live/ABCD2345.flv", httpPort))
	if err != nil {
		t.Fatalf("拉流失败: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("状态码 = %d, want 200", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.Contains(ct, "video/x-flv") {
		t.Errorf("Content-Type = %q", ct)
	}

	body := make([]byte, 13)
	if _, err := io.ReadFull(resp.Body, body); err != nil {
		t.Fatalf("读 FLV 头失败: %v", err)
	}
	if string(body[:3]) != "FLV" || body[3] != 1 {
		t.Fatalf("FLV 头不合法: % x", body)
	}
	if body[4]&0x01 == 0 || body[4]&0x04 == 0 {
		t.Errorf("FLV 头未标记音视频: 0x%02x", body[4])
	}
	if binary.BigEndian.Uint32(body[5:9]) != 9 {
		t.Errorf("DataOffset = %d, want 9", binary.BigEndian.Uint32(body[5:9]))
	}

	tags := readFLVTags(t, resp.Body, 4)
	if len(tags) < 4 {
		t.Fatalf("只收到 %d 个 tag，want >= 4", len(tags))
	}
	if tags[0].typ != msgDataAMF0 || !bytes.Contains(tags[0].data, []byte("onMetaData")) {
		t.Errorf("第一个 tag 应是 onMetaData 脚本标签: type=%d", tags[0].typ)
	}
	if tags[1].typ != msgVideo || !bytes.Equal(tags[1].data, videoSeq) {
		t.Errorf("第二个 tag 应是 AVC 序列头: type=%d len=%d", tags[1].typ, len(tags[1].data))
	}
	if tags[2].typ != msgAudio || !bytes.Equal(tags[2].data, audioSeq) {
		t.Errorf("第三个 tag 应是 AAC 序列头: type=%d len=%d", tags[2].typ, len(tags[2].data))
	}
	foundKey := false
	for _, tag := range tags {
		if tag.typ == msgVideo && bytes.Equal(tag.data, keyframe) {
			foundKey = true
		}
	}
	if !foundKey {
		t.Error("没有收到关键帧（GOP 缓存）")
	}
}

func TestEmbeddedFLVMissingStream(t *testing.T) {
	_, _, httpPort := startTestServer(t)
	resp, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/live/NOPE.flv", httpPort))
	if err != nil {
		t.Fatalf("请求失败: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("状态码 = %d, want 404", resp.StatusCode)
	}
}

func TestServiceEmbeddedAvailability(t *testing.T) {
	rtmpPort := freePort(t)
	httpPort := freePort(t)
	svc := New(Config{
		RtmpPort:    rtmpPort,
		HTTPFLVBase: fmt.Sprintf("http://127.0.0.1:%d", httpPort),
		Embedded:    true,
		BindHost:    "127.0.0.1",
	})
	svc.SetLogger(t.Logf)
	if svc.Available() {
		t.Error("未 Start 前不应报告可用")
	}
	if err := svc.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if !svc.Available() {
		t.Error("Start 后应报告可用")
	}
	if err := svc.Close(context.Background()); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if svc.Available() {
		t.Error("Close 后不应报告可用")
	}
}

func TestServiceFallsBackWhenPortBusy(t *testing.T) {
	// 端口被占（等价于运维自己跑了外部 NMS）时不致命，降级为探测模式。
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("占端口失败: %v", err)
	}
	defer ln.Close()
	busyPort := ln.Addr().(*net.TCPAddr).Port

	svc := New(Config{
		RtmpPort:    busyPort,
		HTTPFLVBase: fmt.Sprintf("http://127.0.0.1:%d", freePort(t)),
		Embedded:    true,
		BindHost:    "127.0.0.1",
	})
	svc.SetLogger(t.Logf)
	if err := svc.Start(); err == nil {
		t.Fatal("端口被占时应返回错误（由调用方记日志并降级）")
	}
	if svc.Config().Embedded {
		t.Error("降级后应切到外部探测模式")
	}
}

// readFLVTags 从 FLV 流里读最多 n 个 tag（跳过 prevTagSize）。
func readFLVTags(t *testing.T, r io.Reader, n int) []flvTag {
	t.Helper()
	tags := make([]flvTag, 0, n)
	for i := 0; i < n; i++ {
		head := make([]byte, 11)
		if _, err := io.ReadFull(r, head); err != nil {
			break
		}
		size := int(head[1])<<16 | int(head[2])<<8 | int(head[3])
		ts := uint32(head[7])<<24 | uint32(head[4])<<16 | uint32(head[5])<<8 | uint32(head[6])
		data := make([]byte, size)
		if _, err := io.ReadFull(r, data); err != nil {
			break
		}
		var prev [4]byte
		if _, err := io.ReadFull(r, prev[:]); err != nil {
			break
		}
		tags = append(tags, flvTag{typ: head[0], ts: ts, data: data})
	}
	return tags
}
