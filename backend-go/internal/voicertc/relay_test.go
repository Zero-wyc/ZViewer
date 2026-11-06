package voicertc

// 语音链路的端到端验证：真实建 PC、真实收发 RTP。
//
// 假客户端严格照前端 `useSfuVoice` 的流程走：
//  1. 先 addTrack 再应用 offer（反过来那条 m-line 会留成 recvonly，没声音）；
//  2. **每一个** offer 都要应答——成员进出会让服务端发 re-offer，
//     只答第一次的话后来加入的人的声音就再也到不了；
//  3. answer 原样带回 revision，tracks 只列自己真正发的那一条。

import (
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"

	"zviewer/backend/internal/share/sfu"
)

// voiceClient 是一个假浏览器。
type voiceClient struct {
	peerID       string
	connectionID string
	pc           *webrtc.PeerConnection
	track        *webrtc.TrackLocalStaticRTP
	received     chan *rtp.Packet
	answered     chan struct{}
}

// voiceRTP 造一个像样的 Opus 包（内容不重要，能被转发就行）。
func voiceRTP(sequence uint16, timestamp uint32) *rtp.Packet {
	return &rtp.Packet{
		Header: rtp.Header{
			Version:        2,
			PayloadType:    111,
			SequenceNumber: sequence,
			Timestamp:      timestamp,
			SSRC:           0x1234,
		},
		Payload: []byte{0x78, 0x01, 0x02, 0x03, 0x04},
	}
}

// connectVoiceClient 让一个成员完整加进语音并建好 PC。
func connectVoiceClient(
	t *testing.T,
	service *Service,
	sink *sink,
	peerID string,
) *voiceClient {
	t.Helper()
	conn := memberConn(peerID, "r1")
	send(t, service, conn, `{"t":"voice.join","roomId":"r1","name":"`+peerID+`"}`)

	sink.waitFor(t, "拿到 connectionId", func() bool {
		return sink.lastState(t, peerID).Self.ConnectionID != ""
	})
	state := sink.lastState(t, peerID)

	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatalf("%s 建 PC 失败: %v", peerID, err)
	}
	t.Cleanup(func() { _ = pc.Close() })

	track, err := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{
		MimeType: webrtc.MimeTypeOpus, ClockRate: 48_000, Channels: 2,
	}, "audio", "voice_"+peerID)
	if err != nil {
		t.Fatalf("%s 建音轨失败: %v", peerID, err)
	}
	if _, err := pc.AddTrack(track); err != nil {
		t.Fatalf("%s 挂音轨失败: %v", peerID, err)
	}

	client := &voiceClient{
		peerID: peerID, connectionID: state.Self.ConnectionID,
		pc: pc, track: track,
		received: make(chan *rtp.Packet, 512),
		answered: make(chan struct{}),
	}

	pc.OnTrack(func(remote *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		for {
			packet, _, readErr := remote.ReadRTP()
			if readErr != nil {
				return
			}
			select {
			case client.received <- packet:
			default:
			}
		}
	})

	// 自己的候选要回给服务端，否则服务端收不到我们的媒体。
	pc.OnICECandidate(func(candidate *webrtc.ICECandidate) {
		if candidate == nil {
			return
		}
		payload, marshalErr := json.Marshal(candidate.ToJSON())
		if marshalErr != nil {
			return
		}
		sendSignalFrame(t, service, conn, state.Self.ConnectionID, "candidate", payload)
	})

	go client.pump(t, service, sink, conn)
	return client
}

// pump 持续消费服务端下发的 offer 与候选。
//
// 单 goroutine 自然串行化：应答是有状态的（先 setRemote 再 createAnswer），
// 两条并发应答会撞在一起。
func (c *voiceClient) pump(t *testing.T, service *Service, sink *sink, conn Conn) {
	seen := 0
	var lastRevision uint64
	for {
		all := sink.all()
		for ; seen < len(all); seen++ {
			record := all[seen]
			if record.target != c.peerID {
				continue
			}
			signal, ok := record.message.(SignalOutMessage)
			if !ok {
				continue
			}
			switch signal.Kind {
			case "description":
				var description sfu.VoiceDescription
				if err := json.Unmarshal(signal.Payload, &description); err != nil {
					continue
				}
				if description.SDP.Type != webrtc.SDPTypeOffer || description.Revision <= lastRevision {
					continue
				}
				lastRevision = description.Revision
				c.answer(t, service, conn, description)
			case "candidate":
				var candidate webrtc.ICECandidateInit
				if err := json.Unmarshal(signal.Payload, &candidate); err != nil {
					continue
				}
				_ = c.pc.AddICECandidate(candidate)
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// answer 应答一份 offer，与前端逐条对齐。
func (c *voiceClient) answer(
	t *testing.T,
	service *Service,
	conn Conn,
	description sfu.VoiceDescription,
) {
	if err := c.pc.SetRemoteDescription(description.SDP); err != nil {
		t.Logf("%s setRemote 失败（revision=%d）: %v", c.peerID, description.Revision, err)
		return
	}
	own := "voice_" + c.peerID
	sendMid := ""
	for _, ref := range description.Tracks {
		if ref.PublicationID == own {
			sendMid = ref.MID
			break
		}
	}
	answer, err := c.pc.CreateAnswer(nil)
	if err != nil {
		t.Logf("%s createAnswer 失败: %v", c.peerID, err)
		return
	}
	if err := c.pc.SetLocalDescription(answer); err != nil {
		t.Logf("%s setLocal 失败: %v", c.peerID, err)
		return
	}
	tracks := []map[string]any{}
	if sendMid != "" {
		tracks = append(tracks, map[string]any{"mid": sendMid, "publicationId": own})
	}
	payload, err := json.Marshal(map[string]any{
		"revision": description.Revision,
		"sdp":      map[string]any{"type": "answer", "sdp": c.pc.LocalDescription().SDP},
		"tracks":   tracks,
	})
	if err != nil {
		t.Logf("%s 应答编码失败: %v", c.peerID, err)
		return
	}
	sendSignalFrame(t, service, conn, c.connectionID, "description", payload)

	select {
	case <-c.answered:
	default:
		close(c.answered)
	}
}

// sendSignalFrame 把一条信令塞回控制面。
func sendSignalFrame(
	t *testing.T,
	service *Service,
	conn Conn,
	connectionID, kind string,
	payload []byte,
) {
	t.Helper()
	frame, err := json.Marshal(map[string]any{
		"t": "voice.signal", "roomId": "r1",
		"connectionId": connectionID, "kind": kind,
		"payload": json.RawMessage(payload),
	})
	if err != nil {
		return
	}
	service.Handle(conn, []json.RawMessage{frame})
}

// waitConnected 等第一份 offer 被应答并且 ICE 连上。
func (c *voiceClient) waitConnected(t *testing.T) {
	t.Helper()
	select {
	case <-c.answered:
	case <-time.After(10 * time.Second):
		t.Fatalf("%s 10s 内没收到 offer", c.peerID)
	}
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		if c.pc.ICEConnectionState() == webrtc.ICEConnectionStateConnected ||
			c.pc.ICEConnectionState() == webrtc.ICEConnectionStateCompleted {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("%s 20s 内没连上，ICE=%s", c.peerID, c.pc.ICEConnectionState())
}

// speak 持续说话，直到返回的函数被调用。
func (c *voiceClient) speak() func() {
	stop := make(chan struct{})
	var once sync.Once
	go func() {
		var sequence uint16
		var timestamp uint32
		ticker := time.NewTicker(20 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				sequence++
				timestamp += 960 // 20ms @ 48kHz
				_ = c.track.WriteRTP(voiceRTP(sequence, timestamp))
			}
		}
	}()
	return func() { once.Do(func() { close(stop) }) }
}

func TestVoiceRelayForwardsAudioBetweenMembers(t *testing.T) {
	service, sink, capture := newHandshakeService(t)

	alice := connectVoiceClient(t, service, sink, "alice")
	bob := connectVoiceClient(t, service, sink, "bob")
	alice.waitConnected(t)
	bob.waitConnected(t)
	// bob 加入会让 alice 收到 re-offer；等两边都稳定再推流。
	time.Sleep(400 * time.Millisecond)

	stopSpeaking := alice.speak()
	defer stopSpeaking()

	select {
	case packet := <-bob.received:
		if packet == nil || len(packet.Payload) == 0 {
			t.Fatal("收到的 RTP 是空的")
		}
	case <-time.After(20 * time.Second):
		t.Fatalf("bob 没收到 alice 的 RTP（握手过了但没声音），日志：%s", joinLog(capture))
	}
}

func TestVoiceRelayStopsForwardingAfterLeave(t *testing.T) {
	service, sink, capture := newHandshakeService(t)

	alice := connectVoiceClient(t, service, sink, "alice")
	bob := connectVoiceClient(t, service, sink, "bob")
	alice.waitConnected(t)
	bob.waitConnected(t)
	time.Sleep(400 * time.Millisecond)

	stopSpeaking := alice.speak()
	defer stopSpeaking()
	select {
	case <-bob.received:
	case <-time.After(20 * time.Second):
		t.Fatalf("前置条件失败：bob 没收到 alice 的 RTP，日志：%s", joinLog(capture))
	}

	send(t, service, memberConn("alice", "r1"), `{"t":"voice.leave","roomId":"r1"}`)
	sink.waitFor(t, "bob 的成员表只剩自己", func() bool {
		members := sink.lastState(t, "bob").Members
		return len(members) == 1 && members[0].PeerID == "bob"
	})

	// 清掉退出瞬间还在管道里的包，再看后续是否还有新的。
	deadline := time.Now().Add(700 * time.Millisecond)
	for time.Now().Before(deadline) {
		select {
		case <-bob.received:
		default:
			time.Sleep(10 * time.Millisecond)
		}
	}
	time.Sleep(1500 * time.Millisecond)
	if remaining := len(bob.received); remaining > 0 {
		t.Fatalf("alice 退出后 bob 仍收到 %d 个包", remaining)
	}
}

// 三人房：每个人都要听到别人。
//
// 两人测试覆盖不到两件事：
//   - fan-out：发布者自己那条连接**不参与**转发（它只有 recvonly 槽）；
//   - re-offer：第三个人加入时前两人的订阅集合变了，服务端必须再协商一次，
//     客户端只答第一次就会「后来的人听不见」。
func TestVoiceRelayFansOutToEveryMember(t *testing.T) {
	service, sink, capture := newHandshakeService(t)

	clients := []*voiceClient{
		connectVoiceClient(t, service, sink, "alice"),
		connectVoiceClient(t, service, sink, "bob"),
		connectVoiceClient(t, service, sink, "carol"),
	}
	for _, client := range clients {
		client.waitConnected(t)
	}
	// 再协商是异步的，等三方链路都稳定。
	time.Sleep(1000 * time.Millisecond)

	stops := make([]func(), 0, len(clients))
	for _, client := range clients {
		stops = append(stops, client.speak())
	}
	defer func() {
		for _, stop := range stops {
			stop()
		}
	}()

	for _, listener := range clients {
		// 每人要收到「另外两个人」的声音：来自两条不同远端流的包。
		sources := make(map[uint32]struct{})
		deadline := time.Now().Add(20 * time.Second)
		for len(sources) < 2 && time.Now().Before(deadline) {
			select {
			case packet := <-listener.received:
				if packet != nil {
					sources[packet.SSRC] = struct{}{}
				}
			case <-time.After(500 * time.Millisecond):
			}
		}
		if len(sources) < 2 {
			t.Fatalf("%s 只听到 %d 路（应有两路），日志：%s",
				listener.peerID, len(sources), joinLog(capture))
		}
	}
}

func joinLog(capture *logCapture) string {
	capture.mu.Lock()
	defer capture.mu.Unlock()
	out := ""
	for _, entry := range capture.entries {
		out += entry
	}
	return out
}
