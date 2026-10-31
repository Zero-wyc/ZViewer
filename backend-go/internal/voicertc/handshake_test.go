package voicertc

import (
	"context"
	"encoding/json"
	"log"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"

	"zviewer/backend/internal/share/sfu"
)

// logCapture 收集控制面的日志，用来断言「服务端有没有拒绝这次信令」。
//
// 信令被拒在线上是**静默**的（不回报错误，避免替攻击者确认 id 存在），
// 所以测试只能从日志判断——这也正是排查现场问题时唯一能看的地方。
type logCapture struct {
	mu      sync.Mutex
	entries []string
}

func (c *logCapture) Write(p []byte) (int, error) {
	c.mu.Lock()
	c.entries = append(c.entries, string(p))
	c.mu.Unlock()
	return len(p), nil
}

func (c *logCapture) contains(fragment string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, entry := range c.entries {
		if strings.Contains(entry, fragment) {
			return true
		}
	}
	return false
}

func (c *logCapture) waitFor(t *testing.T, what, fragment string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if c.contains(fragment) {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	c.mu.Lock()
	joined := strings.Join(c.entries, "")
	c.mu.Unlock()
	t.Fatalf("等待日志「%s」超时（%s）：\n%s", fragment, what, joined)
}

// newHandshakeService 构造一个带日志捕获的控制面。
func newHandshakeService(t *testing.T) (*Service, *sink, *logCapture) {
	t.Helper()
	capture := &logCapture{}
	recorder := newSink()
	service := New(Deps{
		Media: sfu.NewMedia(sfu.MediaOptions{}),
		Emit:  recorder.emit,
		IsHost: func(_ context.Context, socketID, _ string) (bool, error) {
			return socketID == "host", nil
		},
		Logger: log.New(capture, "", 0),
	})
	t.Cleanup(func() { _ = service.media.Close() })
	return service, recorder, capture
}

// fakeBrowser 是一个最小客户端：解析服务端的 offer，造一个合法的 answer。
type fakeBrowser struct {
	pc *webrtc.PeerConnection
}

func newFakeBrowser(t *testing.T) *fakeBrowser {
	t.Helper()
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatalf("建客户端 PC 失败: %v", err)
	}
	t.Cleanup(func() { _ = pc.Close() })
	return &fakeBrowser{pc: pc}
}

// answer 对服务端 offer 造一个合法应答，并返回线上载荷。
//
// 这里刻意按前端 useSfuVoice 的逻辑走：按 publicationId 找自己那条 m-line，
// 把麦克风挂上去，answer 的 tracks 只列这一条。
func (b *fakeBrowser) answer(
	t *testing.T,
	offer sfu.VoiceDescription,
	selfPeerID string,
	includeTrack bool,
) map[string]any {
	t.Helper()
	if includeTrack {
		// 与前端一致：**先** addTrack，再应用远端 offer。反过来做（先 setRemote
		// 再 replaceTrack）在浏览器里会把那条 m-line 留成 recvonly，服务端永远
		// 收不到声音——pion 更直接，recvonly 的 transceiver 连 sender 都没有。
		track, err := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{
			MimeType: webrtc.MimeTypeOpus, ClockRate: 48_000, Channels: 2,
		}, "audio", "voice_"+selfPeerID)
		if err != nil {
			t.Fatalf("建本地音轨失败: %v", err)
		}
		if _, err := b.pc.AddTrack(track); err != nil {
			t.Fatalf("挂载音轨失败: %v", err)
		}
	}
	if err := b.pc.SetRemoteDescription(offer.SDP); err != nil {
		t.Fatalf("客户端 setRemote 失败: %v", err)
	}
	own := "voice_" + selfPeerID
	sendMid := ""
	for _, track := range offer.Tracks {
		if track.PublicationID == own {
			sendMid = track.MID
			break
		}
	}
	answer, err := b.pc.CreateAnswer(nil)
	if err != nil {
		t.Fatalf("客户端 createAnswer 失败: %v", err)
	}
	if err := b.pc.SetLocalDescription(answer); err != nil {
		t.Fatalf("客户端 setLocal 失败: %v", err)
	}
	tracks := []map[string]any{}
	if includeTrack && sendMid != "" {
		tracks = append(tracks, map[string]any{"mid": sendMid, "publicationId": own})
	}
	return map[string]any{
		"revision": offer.Revision,
		"sdp":      map[string]any{"type": "answer", "sdp": b.pc.LocalDescription().SDP},
		"tracks":   tracks,
	}
}

// waitOffer 等一份发给某条连接的 offer。
func (s *sink) waitOffer(t *testing.T, socketID string) sfu.VoiceDescription {
	t.Helper()
	s.waitFor(t, "收到 offer", func() bool {
		for _, record := range s.all() {
			signal, ok := record.message.(SignalOutMessage)
			if ok && record.target == socketID && signal.Kind == "description" {
				return true
			}
		}
		return false
	})
	return s.lastDescription(t, socketID)
}

// sendAnswer 把应答原样塞回控制面。
func sendAnswer(
	t *testing.T,
	service *Service,
	conn Conn,
	connectionID string,
	payload map[string]any,
) {
	t.Helper()
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("应答编码失败: %v", err)
	}
	frame, err := json.Marshal(map[string]any{
		"t": "voice.signal", "roomId": connRoom(conn), "connectionId": connectionID,
		"kind": "description", "payload": json.RawMessage(raw),
	})
	if err != nil {
		t.Fatalf("帧编码失败: %v", err)
	}
	service.Handle(conn, []json.RawMessage{frame})
}

// connRoom 取出测试连接所在的房间（测试里只 join 一个房间）。
func connRoom(Conn) string { return "r1" }

func TestVoiceHandshakeAcceptsBrowserAnswer(t *testing.T) {
	service, sink, capture := newHandshakeService(t)
	send(t, service, memberConn("host", "r1"), `{"t":"voice.join","roomId":"r1","name":"房主"}`)

	state := func() StateMessage {
		sink.waitFor(t, "拿到 connectionId", func() bool {
			return sink.lastState(t, "host").Self.ConnectionID != ""
		})
		return sink.lastState(t, "host")
	}()
	offer := sink.waitOffer(t, "host")
	if offer.Revision == 0 {
		t.Fatal("offer 必须带 revision，客户端要原样回给它")
	}

	browser := newFakeBrowser(t)
	payload := browser.answer(t, offer, "host", true)
	sendAnswer(t, service, memberConn("host", "r1"), state.Self.ConnectionID, payload)

	// 服务端接受后不会再拒绝；用「没有拒绝日志」判定成功。
	time.Sleep(300 * time.Millisecond)
	if capture.contains("信令被拒") {
		t.Fatalf("合法应答被拒了：\n%s", strings.Join(capture.entries, ""))
	}
}

func TestVoiceHandshakeRejectsStaleRevision(t *testing.T) {
	service, sink, capture := newHandshakeService(t)
	send(t, service, memberConn("host", "r1"), `{"t":"voice.join","roomId":"r1"}`)
	sink.waitFor(t, "拿到 connectionId", func() bool {
		return sink.lastState(t, "host").Self.ConnectionID != ""
	})
	state := sink.lastState(t, "host")
	offer := sink.waitOffer(t, "host")

	browser := newFakeBrowser(t)
	payload := browser.answer(t, offer, "host", true)
	// 改小 revision：服务端拿它跟 pending 比，不等即拒。
	payload["revision"] = float64(offer.Revision) - 1
	sendAnswer(t, service, memberConn("host", "r1"), state.Self.ConnectionID, payload)

	capture.waitFor(t, "过期应答被拒", "信令被拒")
}

func TestVoiceHandshakeRejectsUnauthorizedTrack(t *testing.T) {
	service, sink, capture := newHandshakeService(t)
	send(t, service, memberConn("host", "r1"), `{"t":"voice.join","roomId":"r1"}`)
	sink.waitFor(t, "拿到 connectionId", func() bool {
		return sink.lastState(t, "host").Self.ConnectionID != ""
	})
	state := sink.lastState(t, "host")
	offer := sink.waitOffer(t, "host")

	browser := newFakeBrowser(t)
	payload := browser.answer(t, offer, "host", true)
	// 把 pub 改成别人的：answer 只能声明「自己真正发」的那一条。
	tracks, _ := payload["tracks"].([]map[string]any)
	if len(tracks) == 0 {
		t.Fatal("测试前提：应答里应有自己那条轨道")
	}
	tracks[0]["publicationId"] = "voice_someone-else"
	sendAnswer(t, service, memberConn("host", "r1"), state.Self.ConnectionID, payload)

	capture.waitFor(t, "越权轨道被拒", "信令被拒")
}

func TestVoiceHandshakeRejectsForeignConnectionID(t *testing.T) {
	service, sink, capture := newHandshakeService(t)
	send(t, service, memberConn("host", "r1"), `{"t":"voice.join","roomId":"r1"}`)
	sink.waitFor(t, "拿到 connectionId", func() bool {
		return sink.lastState(t, "host").Self.ConnectionID != ""
	})
	offer := sink.waitOffer(t, "host")

	browser := newFakeBrowser(t)
	payload := browser.answer(t, offer, "host", true)
	// 拿一个不存在的 connectionId：连 SignalVoice 都不该进（更不会有拒绝日志）。
	sendAnswer(t, service, memberConn("host", "r1"), "vc_foreign", payload)

	time.Sleep(300 * time.Millisecond)
	if capture.contains("信令被拒") {
		t.Fatal("伪造 connectionId 应在路由层被静默丢弃，不该走到媒体层")
	}
}
