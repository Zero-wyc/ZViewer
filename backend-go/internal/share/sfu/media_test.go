package sfu

import (
	"context"
	"net"
	"sync"
	"testing"
	"time"

	"zviewer/backend/internal/share/forwarding"

	"github.com/pion/webrtc/v4"
	pionmedia "github.com/pion/webrtc/v4/pkg/media"
)

// eventSink 收集 Media 回调，并把它当成「信令服务器」：候选要原样喂回对端。
type eventSink struct {
	mu     sync.Mutex
	events []MediaEvent
}

func (sink *eventSink) push(event MediaEvent) {
	sink.mu.Lock()
	defer sink.mu.Unlock()
	sink.events = append(sink.events, event)
}

// candidates 返回某个连接上收到的候选（空 ConnectionID 表示发布端）。
func (sink *eventSink) candidates(viewerPeerID, connectionID string) []webrtc.ICECandidateInit {
	sink.mu.Lock()
	defer sink.mu.Unlock()
	var out []webrtc.ICECandidateInit
	for _, event := range sink.events {
		if event.Candidate == nil || event.ViewerPeerID != viewerPeerID || event.ConnectionID != connectionID {
			continue
		}
		out = append(out, *event.Candidate)
	}
	return out
}

func (sink *eventSink) count() int {
	sink.mu.Lock()
	defer sink.mu.Unlock()
	return len(sink.events)
}

// newTestEngine 起一个临时代媒体引擎（内核分配端口，TCP 关掉）。
//
// 监听地址必须留空（所有接口）：只绑 127.0.0.1 时，测试里的「浏览器」收集到
// 的是网卡地址，往 127.0.0.1 发包在 Windows 上根本不成立，ICE 会永远停在
// connecting——那是测试环境问题，不是中继问题。
func newTestEngine(t *testing.T) *Engine {
	t.Helper()
	engine, err := NewEngine(EngineOptions{
		Port: 0, IncludeLoopback: true, DisableTCP: true,
	})
	if err != nil {
		t.Fatalf("绑定媒体端口失败: %v", err)
	}
	t.Cleanup(func() { _ = engine.Close() })
	if engine.Port() == 0 {
		t.Fatal("Port() 应返回内核分配的实际端口")
	}
	return engine
}

func testFence() PublicationFence {
	return PublicationFence{
		RoomID:                "ROOM1234",
		ShareGeneration:       "share_0123456789abcdef",
		PublicationGeneration: NewPublicationGeneration(),
	}
}

func testMetadata() PublicationMedia {
	return PublicationMedia{
		Codec:   "vp8",
		RIDs:    []string{""},
		Formats: []forwarding.LayerFormat{{Width: 1280, Height: 720, Bitrate: 2_000_000}},
	}
}

// fakeBrowser 是测试里的「浏览器」：一条 sender 或 receiver PC。
type fakeBrowser struct {
	pc    *webrtc.PeerConnection
	onICE func(*webrtc.ICECandidate)
}

func newFakeBrowser(t *testing.T) *fakeBrowser {
	t.Helper()
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatalf("建 PC 失败: %v", err)
	}
	t.Cleanup(func() { _ = pc.Close() })
	browser := &fakeBrowser{pc: pc}
	pc.OnICECandidate(func(candidate *webrtc.ICECandidate) {
		if candidate != nil && browser.onICE != nil {
			browser.onICE(candidate)
		}
	})
	return browser
}

// waitGatheringDone 等本端候选收集完，这样 LocalDescription 里就带着候选，
// 不必在测试里实现完整的 trickle 往返。
func (browser *fakeBrowser) waitGatheringDone(t *testing.T) webrtc.SessionDescription {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if browser.pc.ICEGatheringState() == webrtc.ICEGatheringStateComplete {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if description := browser.pc.LocalDescription(); description != nil {
		return *description
	}
	t.Fatal("本端还没有 LocalDescription")
	return webrtc.SessionDescription{}
}

// pumpCandidates 把 SFU 侧收集到的候选持续补喂给对端。
//
// 生产里这些候选走 share.sfu-signal{kind:candidate}，测试里没有信令通道，
// 直接用事件缓冲区代替。返回的 stop 必须在测试结束前调用。
func pumpCandidates(sink *eventSink, viewerPeerID, connectionID string, pc *webrtc.PeerConnection) func() {
	stop := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		seen := 0
		ticker := time.NewTicker(10 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				candidates := sink.candidates(viewerPeerID, connectionID)
				for ; seen < len(candidates); seen++ {
					_ = pc.AddICECandidate(candidates[seen])
				}
			}
		}
	}()
	return func() {
		close(stop)
		wg.Wait()
	}
}

func waitConnected(t *testing.T, pc *webrtc.PeerConnection, what string) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		switch pc.ConnectionState() {
		case webrtc.PeerConnectionStateConnected:
			return
		case webrtc.PeerConnectionStateFailed, webrtc.PeerConnectionStateClosed:
			t.Fatalf("%s 连接状态 %s", what, pc.ConnectionState())
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("%s 15s 内没有连上（当前 %s）", what, pc.ConnectionState())
}

// TestRelayForwardsPublisherTrackToSubscriber 是全链路的证明：
// 房主推流 → SFU 收下 → 观众订阅 → 观众真的收到 RTP。
func TestRelayForwardsPublisherTrackToSubscriber(t *testing.T) {
	engine := newTestEngine(t)
	sink := &eventSink{}
	media := NewMedia(MediaOptions{Settings: engine.Settings(), Events: sink.push})
	t.Cleanup(func() { _ = media.Close() })

	fence := testFence()
	if err := media.PreparePublication(fence, fence.PublicationGeneration, testMetadata()); err != nil {
		t.Fatalf("准备发布失败: %v", err)
	}
	if !media.HasPublication(fence, fence.PublicationGeneration) {
		t.Fatal("准备后应能查到发布")
	}

	publisher := newFakeBrowser(t)
	track, err := webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{
		MimeType: webrtc.MimeTypeVP8, ClockRate: 90_000,
	}, "video", "publisher")
	if err != nil {
		t.Fatalf("建本地轨失败: %v", err)
	}
	if _, err = publisher.pc.AddTrack(track); err != nil {
		t.Fatalf("加轨失败: %v", err)
	}
	offer, err := publisher.pc.CreateOffer(nil)
	if err != nil {
		t.Fatalf("发布端建 offer 失败: %v", err)
	}
	if err = publisher.pc.SetLocalDescription(offer); err != nil {
		t.Fatalf("发布端 setLocal 失败: %v", err)
	}
	answer, err := media.AcceptPublisherOffer(fence, fence.PublicationGeneration, publisher.waitGatheringDone(t))
	if err != nil {
		t.Fatalf("接受发布端 offer 失败: %v", err)
	}
	if answer.Type != webrtc.SDPTypeAnswer {
		t.Fatalf("应回 answer，实际 %s", answer.Type)
	}
	if err = publisher.pc.SetRemoteDescription(answer); err != nil {
		t.Fatalf("发布端 setRemote 失败: %v", err)
	}
	stopPublisherCandidates := pumpCandidates(sink, "", fence.PublicationGeneration, publisher.pc)
	defer stopPublisherCandidates()

	// 推流：直到 SFU 侧的 OnTrack 触发（PrepareSubscriber 会等它）。
	stop := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		ticker := time.NewTicker(20 * time.Millisecond)
		defer ticker.Stop()
		// 一帧 VP8 关键帧的最小心跳负载（S=1, PID=0 + 键帧头 + 起始码）。
		sample := []byte{0x10, 0x00, 0x00, 0x9d, 0x01, 0x2a, 0x80, 0x02, 0xe0, 0x01}
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				_ = track.WriteSample(pionmedia.Sample{Data: sample, Duration: 33 * time.Millisecond})
			}
		}
	}()
	defer func() {
		close(stop)
		wg.Wait()
	}()

	subscriberFence := SubscriptionFence{
		PublicationFence: fence, ViewerPeerID: "viewer-1", ConnectionID: "route_sub_1",
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	subscriberOffer, err := media.PrepareSubscriber(ctx, subscriberFence, subscriberFence.ConnectionID)
	if err != nil {
		t.Fatalf("准备订阅失败（发布端可能没把轨送到）: %v", err)
	}
	if subscriberOffer.Type != webrtc.SDPTypeOffer {
		t.Fatalf("订阅端应收到 offer，实际 %s", subscriberOffer.Type)
	}

	subscriber := newFakeBrowser(t)
	received := make(chan struct{}, 1)
	subscriber.pc.OnTrack(func(remote *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		go func() {
			if _, _, readErr := remote.ReadRTP(); readErr == nil {
				select {
				case received <- struct{}{}:
				default:
				}
			}
		}()
	})
	subscriber.onICE = func(candidate *webrtc.ICECandidate) {
		init := candidate.ToJSON()
		_ = media.AddSubscriberICE(subscriberFence, subscriberFence.ConnectionID, init)
	}
	if err = subscriber.pc.SetRemoteDescription(subscriberOffer); err != nil {
		t.Fatalf("订阅端 setRemote 失败: %v", err)
	}
	stopSubscriberCandidates := pumpCandidates(sink, "viewer-1", subscriberFence.ConnectionID, subscriber.pc)
	defer stopSubscriberCandidates()
	subscriberAnswer, err := subscriber.pc.CreateAnswer(nil)
	if err != nil {
		t.Fatalf("订阅端建 answer 失败: %v", err)
	}
	if err = subscriber.pc.SetLocalDescription(subscriberAnswer); err != nil {
		t.Fatalf("订阅端 setLocal 失败: %v", err)
	}
	if err = media.ApplySubscriberAnswer(subscriberFence, subscriberFence.ConnectionID, subscriber.waitGatheringDone(t)); err != nil {
		t.Fatalf("应用订阅端 answer 失败: %v", err)
	}

	waitConnected(t, subscriber.pc, "订阅端")

	select {
	case <-received:
		if sink.count() == 0 {
			t.Fatal("收到 RTP 却没有任何媒体事件")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("观众 10s 内没收到任何 RTP")
	}
}

// TestRelayRejectsUnknownPublication 证明身份栅栏生效：没准备的发布不能订阅。
func TestRelayRejectsUnknownPublication(t *testing.T) {
	engine := newTestEngine(t)
	media := NewMedia(MediaOptions{Settings: engine.Settings()})
	t.Cleanup(func() { _ = media.Close() })

	fence := testFence()
	if err := media.PreparePublication(fence, fence.PublicationGeneration, testMetadata()); err != nil {
		t.Fatalf("准备发布失败: %v", err)
	}
	// 换一个发布代际 → 不是同一路发布。
	other := testFence()
	other.PublicationGeneration = NewPublicationGeneration()
	if media.HasPublication(other, other.PublicationGeneration) {
		t.Fatal("不同代际不应命中同一发布")
	}
	// 同代际但 connectionId 不匹配 → 也不认。
	if media.HasPublication(fence, "route_other") {
		t.Fatal("connectionId 不匹配不应命中发布")
	}
}

// TestPublicationRejectsInvalidMetadata 守住准入边界（非法元数据直接拒）。
func TestPublicationRejectsInvalidMetadata(t *testing.T) {
	engine := newTestEngine(t)
	media := NewMedia(MediaOptions{Settings: engine.Settings()})
	t.Cleanup(func() { _ = media.Close() })

	fence := testFence()
	cases := map[string]PublicationMedia{
		"未知编码":     {Codec: "av1", RIDs: []string{""}, Formats: testMetadata().Formats},
		"没有分层":     {Codec: "vp8"},
		"RID 数量不符": {Codec: "vp8", RIDs: []string{}, Formats: testMetadata().Formats},
		"码率为零":     {Codec: "vp8", RIDs: []string{""}, Formats: []forwarding.LayerFormat{{Width: 1280, Height: 720}}},
		"尺寸超界":     {Codec: "vp8", RIDs: []string{""}, Formats: []forwarding.LayerFormat{{Width: 9000, Height: 720, Bitrate: 1_000}}},
	}
	for name, metadata := range cases {
		if err := media.PreparePublication(fence, fence.PublicationGeneration, metadata); err == nil {
			t.Fatalf("%s 应被拒绝", name)
		}
	}
}

// TestEngineBindsSamePortForUDPAndTCP 守「同号端口」这条部署要求。
func TestEngineBindsSamePortForUDPAndTCP(t *testing.T) {
	engine, err := NewEngine(EngineOptions{Port: 0, ListenHost: "127.0.0.1", IncludeLoopback: true})
	if err != nil {
		t.Fatalf("绑定媒体端口失败: %v", err)
	}
	defer func() { _ = engine.Close() }()
	if !engine.TCPEnabled() {
		t.Skip("当前环境无法绑定 TCP，跳过同号校验")
	}
	if engine.udpConn.LocalAddr().(*net.UDPAddr).Port != engine.tcpLister.Addr().(*net.TCPAddr).Port {
		t.Fatal("UDP 与 TCP 必须是同一个端口号")
	}
}
