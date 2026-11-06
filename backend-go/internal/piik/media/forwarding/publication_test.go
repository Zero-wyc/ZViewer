package forwarding

import (
	"bytes"
	"context"
	"net"
	"sync/atomic"
	"testing"
	"time"

	"github.com/livekit/livekit-server/pkg/sfu"
	"github.com/livekit/livekit-server/pkg/sfu/bwe"
	"github.com/livekit/livekit-server/pkg/sfu/ccutils"
	packetpacer "github.com/livekit/mediatransportutil/pkg/pacer"
	"github.com/livekit/protocol/logger"
	"github.com/pion/interceptor"
	"github.com/pion/interceptor/pkg/twcc"
	"github.com/pion/rtcp"
	"github.com/pion/rtp/codecs"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
	"zviewer/backend/internal/piik/media/encoded"
	"zviewer/backend/internal/thirdparty/livekit/sendsidebwe"
)

func TestPublicationEncoderDemandFollowsCurrentSourceAndLifetime(t *testing.T) {
	codec := webrtc.RTPCodecParameters{RTPCodecCapability: webrtc.RTPCodecCapability{
		MimeType: webrtc.MimeTypeVP8, ClockRate: 90_000,
	}, PayloadType: 96}
	newSource := func(ceiling uint32) *Source {
		t.Helper()
		source, err := NewSource(SourceOptions{ID: "demand", StreamID: "demand", Codec: codec,
			Formats: []LayerFormat{{Width: 640, Height: 360, Bitrate: ceiling}}, MaxPackets: 500})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { source.Close() })
		return source
	}
	source := newSource(300_000)
	publication, err := NewPublication(TransportOptions{
		Source: source, ConnectionID: "demand-child", InitialBitrate: 100_000,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { publication.Close() })
	checkDemand := func(want int64) {
		t.Helper()
		if got := publication.encoderProbeDemand(); got != want {
			t.Fatalf("encoder demand = %d, want %d", got, want)
		}
		if publication.VideoBudget() != 100_000 {
			t.Fatal("desired encoder output replaced measured capacity")
		}
	}
	source.SetLowestLayerRateControlled(true)
	checkDemand(0) // The source is not attached yet.
	if err := publication.SetConnected(); err != nil {
		t.Fatal(err)
	}
	checkDemand(300_000) // No measured allocation: demand is not ceiling minus capacity.
	source.SetLowestLayerRateControlled(false)
	checkDemand(0) // A raw forwarder cannot spend capacity inside this layer.
	source.SetLowestLayerRateControlled(true)
	if err := publication.SetActiveCount(0); err != nil {
		t.Fatal(err)
	}
	checkDemand(0)
	if err := publication.SetActiveCount(1); err != nil {
		t.Fatal(err)
	}
	checkDemand(300_000)
	next := newSource(600_000)
	next.SetLowestLayerRateControlled(true)
	if err := publication.ReplaceSource(next); err != nil {
		t.Fatal(err)
	}
	source.SetLowestLayerRateControlled(false)
	checkDemand(600_000) // Retirement of the old encoder cannot erase new demand.
	publication.bandwidth.target.Store(600_000)
	if got := publication.encoderProbeDemand(); got != 0 {
		t.Fatalf("satisfied encoder kept probing: %d", got)
	}
	publication.bandwidth.target.Store(100_000)
	checkDemand(600_000)
	next.SetLowestLayerRateControlled(false)
	checkDemand(0)
	next.SetLowestLayerRateControlled(true)
	if err := publication.Close(); err != nil {
		t.Fatal(err)
	}
	checkDemand(0)
}

func TestPublicationEmptyProbeCannotIncreaseCapacity(t *testing.T) {
	const target = int64(1_000_000)
	log := logger.GetDiscardLogger()
	bandwidth := &publicationBWE{SendSideBWE: sendsidebwe.NewSendSideBWE(sendsidebwe.SendSideBWEParams{
		Config: sendsidebwe.DefaultSendSideBWEConfig, Logger: log,
	})}
	bandwidth.target.Store(target)
	queue := &publicationPacer{boundedPacer: newBoundedPacer(
		packetpacer.NewNoQueue(log), log, 500,
	)}
	defer queue.Stop()
	info := ccutils.ProbeClusterInfo{Id: 1, CreatedAt: time.Now(), Goal: ccutils.ProbeClusterGoal{
		AvailableBandwidthBps: int(target), ExpectedUsageBps: int(target),
		DesiredBps: int(target * 2), Duration: bandwidth.ProbeDuration(),
	}}
	info.Goal.DesiredBytes = int(float64(info.Goal.DesiredBps) * info.Goal.Duration.Seconds() / 8)
	bandwidth.ProbeClusterStarting(info)
	queue.StartProbeCluster(info)
	time.Sleep(info.Goal.Duration)
	info = queue.EndProbeCluster(info.Id)
	if info.Result.Bytes() != 0 || sendsidebwe.DefaultSendSideBWEConfig.CongestionDetector.ProbeSignal.IsValid(info) {
		t.Fatal("fixture did not complete an empty invalid probe")
	}
	bandwidth.ProbeClusterDone(info)
	deadline := time.Now().Add(sendsidebwe.DefaultSendSideBWEConfig.CongestionDetector.ProbePacketGroup.SettleWaitMax + time.Second)
	for {
		signal, capacity, done := bandwidth.ProbeClusterFinalize()
		if done {
			if signal != ccutils.ProbeSignalInconclusive || capacity > target || bandwidth.target.Load() != target {
				t.Fatalf("empty probe raised publication capacity: signal=%v capacity=%d target=%d", signal, capacity, bandwidth.target.Load())
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("empty probe did not finalize within the library settle bound")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestPublicationProbeUsesAcknowledgedCapacity(t *testing.T) {
	for _, received := range []bool{true, false} {
		t.Run(map[bool]string{true: "received", false: "no-feedback"}[received], func(t *testing.T) {
			checkPublicationProbeCapacity(t, received)
		})
	}
}

func checkPublicationProbeCapacity(t *testing.T, received bool) {
	t.Helper()
	const target = int64(100_000)
	bandwidth := &publicationBWE{SendSideBWE: sendsidebwe.NewSendSideBWE(sendsidebwe.SendSideBWEParams{
		Config: sendsidebwe.DefaultSendSideBWEConfig, Logger: logger.GetDiscardLogger(),
	})}
	bandwidth.target.Store(target)
	bandwidth.SetBWEListener(&publicationCapacityRecorder{})
	// A real non-congesting probe after reset still carries the library's
	// initial capacity. A successful 800 kbps probe cannot prove 100 Mbps.
	start := time.Now().Add(-time.Second)
	recorder := twcc.NewRecorder(42)
	// Establish transport history before the idle interval. The initial packet
	// has relative time zero, so include a subsequent packet as in a live stream.
	for _, age := range []time.Duration{6 * time.Second, 5 * time.Second} {
		previous := start.Add(-age).UnixMicro()
		sequence := bandwidth.RecordPacketSendAndGetSequenceNumber(previous, 200, false, ccutils.ProbeClusterIdInvalid, false)
		recorder.Record(42, sequence, previous+10_000)
	}
	for _, packet := range recorder.BuildFeedbackPacket() {
		bandwidth.HandleTWCCFeedback(packet.(*rtcp.TransportLayerCC))
	}
	bandwidth.Reset()
	info := ccutils.ProbeClusterInfo{Id: 1, CreatedAt: start, Goal: ccutils.ProbeClusterGoal{
		AvailableBandwidthBps: int(target), DesiredBps: 800_000,
		Duration: 200 * time.Millisecond, DesiredBytes: 20_000,
	}}
	if !received {
		// A delayed completion must back off from now, not an expired start time.
		info.CreatedAt = start.Add(-time.Minute)
	}
	bandwidth.ProbeClusterStarting(info)
	for index := range 100 {
		at := start.Add(time.Duration(index) * 2 * time.Millisecond).UnixMicro()
		sequence := bandwidth.RecordPacketSendAndGetSequenceNumber(at, 200, false, info.Id, true)
		recorder.Record(42, sequence, at+10_000)
	}
	info.Result = ccutils.ProbeClusterResult{StartTime: start.UnixNano(),
		EndTime: start.Add(info.Goal.Duration).UnixNano(), PacketsProbe: 100, BytesProbe: 20_000, IsCompleted: true}
	bandwidth.ProbeClusterDone(info)
	if received {
		for _, packet := range recorder.BuildFeedbackPacket() {
			bandwidth.HandleTWCCFeedback(packet.(*rtcp.TransportLayerCC))
		}
	}
	deadline := time.Now().Add(sendsidebwe.DefaultSendSideBWEConfig.CongestionDetector.ProbePacketGroup.SettleWaitMax + time.Second)
	for {
		signal, capacity, done := bandwidth.ProbeClusterFinalize()
		if done {
			if received {
				// Allow the first-packet/time-window difference in the library's
				// acknowledged rate, but never its untouched 100 Mbps initial value.
				if signal != ccutils.ProbeSignalNotCongesting || capacity <= target || capacity > 1_000_000 {
					t.Fatalf("unexpected acknowledged probe capacity: signal=%v committed=%d sent=%.0f", signal, capacity, info.Result.Bitrate())
				}
			} else if signal != ccutils.ProbeSignalInconclusive || capacity != target {
				t.Fatalf("unacknowledged probe changed capacity: signal=%v committed=%d", signal, capacity)
			}
			if !received && (bandwidth.ProbeDuration() > info.Goal.Duration || bandwidth.CanProbe()) {
				t.Fatalf("unacknowledged probe did not back off: duration=%v ready=%v", bandwidth.ProbeDuration(), bandwidth.CanProbe())
			}
			bandwidth.OnCongestionStateChange(bwe.CongestionStateNone, bwe.CongestionStateCongested, target/2)
			if bandwidth.target.Load() != target/2 {
				t.Fatal("finalized probe suppressed ordinary media congestion")
			}
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("probe did not finalize within the library settle bound")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

type publicationCapacityRecorder struct{ capacity int64 }

func (recorder *publicationCapacityRecorder) OnCongestionStateChange(_, _ bwe.CongestionState, capacity int64) {
	recorder.capacity = capacity
}

func TestPublicationCongestionUsesCommittedCapacity(t *testing.T) {
	recorder := &publicationCapacityRecorder{}
	bandwidth := &publicationBWE{listener: recorder, SendSideBWE: sendsidebwe.NewSendSideBWE(sendsidebwe.SendSideBWEParams{
		Config: sendsidebwe.DefaultSendSideBWEConfig, Logger: logger.GetDiscardLogger(),
	})}
	bandwidth.target.Store(1_200_000)
	bandwidth.OnCongestionStateChange(bwe.CongestionStateNone, bwe.CongestionStateEarlyWarning, 100_000_000)
	bandwidth.OnCongestionStateChange(bwe.CongestionStateEarlyWarning, bwe.CongestionStateCongested, 100_000_000)
	if bandwidth.target.Load() != 1_200_000 || recorder.capacity != 1_200_000 {
		t.Fatalf("publication promoted an unverified capacity: target=%d allocation=%d", bandwidth.target.Load(), recorder.capacity)
	}
	bandwidth.OnCongestionStateChange(bwe.CongestionStateCongested, bwe.CongestionStateCongested, 500_000)
	bandwidth.OnCongestionStateChange(bwe.CongestionStateCongested, bwe.CongestionStateNone, 800_000)
	if bandwidth.target.Load() != 500_000 || recorder.capacity != 500_000 {
		t.Fatalf("publication disagrees with its committed video budget: target=%d allocation=%d", bandwidth.target.Load(), recorder.capacity)
	}
	info := ccutils.ProbeClusterInfo{Id: 1, CreatedAt: time.Now()}
	bandwidth.ProbeClusterStarting(info)
	for _, ended := range []bool{false, true} {
		if ended {
			info.Result.EndTime = time.Now().UnixNano()
			bandwidth.ProbeClusterDone(info)
		}
		bandwidth.OnCongestionStateChange(bwe.CongestionStateNone, bwe.CongestionStateCongested, 250_000)
		if bandwidth.target.Load() != 500_000 || recorder.capacity != 500_000 {
			t.Fatalf("probe congestion reached encoder/allocation budget (settling=%v): target=%d allocation=%d",
				ended, bandwidth.target.Load(), recorder.capacity)
		}
	}
	bandwidth.Reset()
	bandwidth.OnCongestionStateChange(bwe.CongestionStateCongested, bwe.CongestionStateCongested, 250_000)
	if bandwidth.target.Load() != 250_000 || recorder.capacity != 250_000 {
		t.Fatal("retired publication probe suppressed ordinary congestion")
	}
}

func TestPublicationSimulcastReuseAudioDemandAndClose(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 12*time.Second)
	defer cancel()
	check := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	codec := webrtc.RTPCodecParameters{RTPCodecCapability: webrtc.RTPCodecCapability{
		MimeType: webrtc.MimeTypeVP8, ClockRate: 90_000,
		RTCPFeedback: []webrtc.RTCPFeedback{{Type: "nack"}, {Type: "nack", Parameter: "pli"}, {Type: webrtc.TypeRTCPFBTransportCC}},
	}, PayloadType: 96}
	source, err := NewEncodedSource(SourceOptions{ID: "screen", StreamID: "publication-fixture", Codec: codec,
		Formats: []LayerFormat{{Width: 8, Height: 8, Bitrate: 90_000}, {Width: 8, Height: 8, Bitrate: 300_000}}})
	check(err)
	defer source.Close()
	settings := webrtc.SettingEngine{}
	settings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	settings.SetIncludeLoopbackCandidate(true)
	settings.SetIPFilter(func(ip net.IP) bool { return ip.IsLoopback() })
	audio, err := webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48_000, Channels: 2}, "audio", "publication-fixture")
	check(err)
	publication, err := NewPublication(TransportOptions{Source: source.Source, Settings: settings, ConnectionID: "publication", InitialBitrate: 1_000_000, Audio: audio})
	check(err)
	defer publication.Close()
	if publication.VideoBudget() != 1_000_000 {
		t.Fatal("audio changed the video capacity estimate")
	}
	if len(publication.PC.GetSenders()) != 2 || len(publication.PC.GetSenders()[0].GetParameters().Encodings) != 2 {
		t.Fatal("publication must use one simulcast video sender and one audio sender")
	}
	mediaEngine := &webrtc.MediaEngine{}
	check(mediaEngine.RegisterDefaultCodecs())
	check(mediaEngine.RegisterHeaderExtension(webrtc.RTPHeaderExtensionCapability{URI: publicationRIDExtension}, webrtc.RTPCodecTypeVideo))
	check(mediaEngine.RegisterHeaderExtension(webrtc.RTPHeaderExtensionCapability{URI: "urn:ietf:params:rtp-hdrext:sdes:mid"}, webrtc.RTPCodecTypeVideo))
	registry := &interceptor.Registry{}
	reports := &receiverReportGate{reportDelay: 20 * time.Millisecond}
	registry.Add(reports)
	check(webrtc.RegisterDefaultInterceptors(mediaEngine, registry))
	receiver, err := webrtc.NewAPI(webrtc.WithMediaEngine(mediaEngine), webrtc.WithInterceptorRegistry(registry), webrtc.WithSettingEngine(settings)).NewPeerConnection(webrtc.Configuration{})
	check(err)
	defer receiver.Close()
	var received [3]atomic.Uint32
	var invalid atomic.Bool
	var lastSequence, lowSSRC, missingSequence atomic.Uint32
	var lowTimestamp atomic.Uint32
	lowReports := make(chan *rtcp.SenderReport, 4)
	var repaired atomic.Bool
	deltaFrame := append([]byte(nil), sfu.VP8KeyFrame8x8...)
	deltaFrame[0] |= 1
	receiver.OnTrack(func(track *webrtc.TrackRemote, rtpReceiver *webrtc.RTPReceiver) {
		index := 2
		if track.Kind() == webrtc.RTPCodecTypeVideo {
			if track.RID() == "q" {
				index = 0
			} else if track.RID() == "h" {
				index = 1
			} else {
				invalid.Store(true)
				return
			}
		}
		if index == 0 {
			go func() {
				for {
					packets, _, err := rtpReceiver.ReadSimulcastRTCP(track.RID())
					if err != nil {
						return
					}
					for _, packet := range packets {
						if report, ok := packet.(*rtcp.SenderReport); ok && report.SSRC == uint32(track.SSRC()) {
							select {
							case lowReports <- report:
							default:
							}
						}
					}
				}
			}()
		}
		for {
			packet, attributes, readErr := ReadRTP(track)
			if readErr != nil {
				return
			}
			if len(packet.Payload) == 0 {
				continue
			}
			if index < 2 {
				var vp8 codecs.VP8Packet
				payload, decodeErr := vp8.Unmarshal(packet.Payload)
				if decodeErr != nil || !(bytes.Equal(payload, sfu.VP8KeyFrame8x8) || bytes.Equal(payload, deltaFrame)) {
					invalid.Store(true)
					return
				}
			}
			if index == 0 {
				lastSequence.Store(uint32(packet.SequenceNumber))
				lowTimestamp.Store(packet.Timestamp)
				lowSSRC.Store(packet.SSRC)
				if uint32(packet.SequenceNumber) == missingSequence.Load() && attributes.Get(webrtc.AttributeRtxPayloadType) != nil {
					repaired.Store(true)
				}
			}
			received[index].Add(1)
		}
	})
	offer, err := publication.PC.CreateOffer(nil)
	check(err)
	gather := webrtc.GatheringCompletePromise(publication.PC)
	check(publication.PC.SetLocalDescription(offer))
	select {
	case <-gather:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	check(receiver.SetRemoteDescription(*publication.PC.LocalDescription()))
	answer, err := receiver.CreateAnswer(nil)
	check(err)
	gather = webrtc.GatheringCompletePromise(receiver)
	check(receiver.SetLocalDescription(answer))
	select {
	case <-gather:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	check(publication.PC.SetRemoteDescription(*receiver.LocalDescription()))
	for publication.PC.ConnectionState() != webrtc.PeerConnectionStateConnected {
		select {
		case <-time.After(5 * time.Millisecond):
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	check(publication.SetConnected())
	check(publication.SetConnected())
	if len(source.GetDownTracks()) != 2 {
		t.Fatal("publication did not attach exactly one output per encoding")
	}
	started := time.Now()
	frameData := sfu.VP8KeyFrame8x8
	write := func() {
		pts := max(time.Since(started), source.inputPTS+time.Microsecond)
		check(source.BeginFrame(pts, time.Now()))
		for layer := 0; layer < 2; layer++ {
			check(source.WriteFrame(layer, encoded.Frame{Data: frameData, PTS: pts, Duration: time.Second / 30, Recovery: bytes.Equal(frameData, sfu.VP8KeyFrame8x8)}))
		}
		check(audio.WriteSample(media.Sample{Data: []byte{0xf8, 0xff, 0xfe}, Duration: 20 * time.Millisecond}))
	}
	for received[0].Load() < 3 || received[1].Load() < 3 || received[2].Load() < 3 {
		write()
		select {
		case <-time.After(time.Second / 30):
		case <-ctx.Done():
			t.Fatalf("publication RTP missing: low=%d high=%d audio=%d invalid=%t", received[0].Load(), received[1].Load(), received[2].Load(), invalid.Load())
		}
	}
	if invalid.Load() {
		t.Fatal("publication changed encoded frame payloads")
	}
	if counters := publication.Counters(); counters.Frames[0] == 0 || counters.Frames[1] == 0 || counters.AudioBytes == 0 {
		t.Fatalf("successful RTP writes were not accounted per encoding: %+v", counters)
	}
	// Lose a real simulcast packet, then delay its NACK beyond SRTP's replay
	// window. The publishing path needs the same negotiated repair as P2P.
	missingSequence.Store(uint32(uint16(lastSequence.Load() + 1)))
	publication.pacer.mu.Lock()
	publication.pacer.limit = 0
	publication.pacer.mu.Unlock()
	write()
	for publication.pacer.stats().DroppedPackets < 2 {
		select {
		case <-time.After(time.Millisecond):
		case <-ctx.Done():
			t.Fatal("publication loss was not exercised")
		}
	}
	publication.pacer.mu.Lock()
	publication.pacer.limit = source.maxPackets
	publication.pacer.mu.Unlock()
	frameData = deltaFrame
	for range 96 {
		before := received[0].Load()
		write()
		for received[0].Load() == before {
			select {
			case <-time.After(time.Millisecond):
			case <-ctx.Done():
				t.Fatal("publication stopped before delayed feedback")
			}
		}
	}
	reports.allow.Store(true)
	check(receiver.WriteRTCP([]rtcp.Packet{&rtcp.TransportLayerNack{
		MediaSSRC: lowSSRC.Load(), Nacks: []rtcp.NackPair{{PacketID: uint16(missingSequence.Load())}},
	}}))
	for !repaired.Load() {
		write()
		select {
		case <-time.After(10 * time.Millisecond):
		case <-ctx.Done():
			t.Fatal("publication did not recover delayed loss through negotiated RTX")
		}
	}
	frameData = sfu.VP8KeyFrame8x8
	// Once real bitrate measurements exist, one shared capacity update must
	// constrain the sum of both video RID allocations.
	for {
		_, rates := source.GetLayeredBitrate()
		if rates[0][0] > 0 && rates[1][0] > 0 {
			break
		}
		write()
		select {
		case <-time.After(time.Second / 30):
		case <-ctx.Done():
			t.Fatal("publication did not measure both available encodings")
		}
	}
	// The sender-report owner must also receive its matching receiver feedback.
	// Delayed real RTCP distinguishes an observed RTT from loopback's zero ms.
	for publication.tracks[0].GetTrackStats().RttMax < 10 {
		write()
		select {
		case <-time.After(time.Second / 30):
		case <-ctx.Done():
			t.Fatal("receiver reports never reached the publication RTT owner")
		}
	}
	publication.bandwidth.OnCongestionStateChange(bwe.CongestionStateNone, bwe.CongestionStateCongested, 1_000)
	// Empty allocations also request zero while the allocator's event is queued.
	// Wait for the committed deficit as well as its shared capacity bound.
	for publication.tracks[0].BandwidthRequested()+publication.tracks[1].BandwidthRequested() > 1_000 || !publication.Counters().Limited {
		select {
		case <-time.After(5 * time.Millisecond):
		case <-ctx.Done():
			t.Fatal("simulcast allocation did not commit its shared capacity limit")
		}
	}
	if publication.LowestLayerBudget() != 1_000 {
		t.Fatal("paused higher output retained the lowest encoder's budget")
	}
	if publication.bandwidth.CongestionState() != bwe.CongestionStateNone || !publication.Counters().Limited {
		t.Fatalf("clear transport feedback hid the committed publication allocation deficit: state=%v counters=%+v low=%v high=%v", publication.bandwidth.CongestionState(), publication.Counters(), publication.tracks[0].IsDeficient(), publication.tracks[1].IsDeficient())
	}
	// Retire high output while allocation is paused, before the low-cache
	// rollover below can queue frames for it.
	check(publication.SetActiveCount(1))
	if publication.RequiredActiveCount() != 1 {
		t.Fatal("publication did not reduce its direct demand")
	}
	// A paused sender's recent packets can age out while capture continues.
	// Recovery must still send a probe when those RTX payloads are unavailable.
	if publication.tracks[0].WriteProbePackets(300, true) == 0 {
		t.Fatal("publication has no receiver-report authority for padding probes")
	}
	for range source.maxPackets + 8 {
		pts := max(time.Since(started), source.inputPTS+time.Microsecond)
		check(source.BeginFrame(pts, time.Now()))
		for layer := range 2 {
			check(source.WriteFrame(layer, encoded.Frame{Data: frameData, PTS: pts, Duration: time.Second / 30}))
		}
	}
	if publication.tracks[0].WriteProbePackets(300, false) == 0 {
		t.Fatal("publication probe stalled after its forwarded packets left the source cache")
	}
	// Restore this allocation fixture's capacity explicitly. A congestion event
	// cannot prove an increase; this test covers RID reuse, not bandwidth probing.
	publication.bandwidth.target.Store(1_000_000)
	publication.pacer.SetBitrate(1_000_000)
	publication.allocator.SetChannelCapacity(1_000_000)
	// Drain packets already admitted by the pacer before observing inactive output.
	for range 6 {
		write()
		time.Sleep(time.Second / 30)
	}
	high, low := received[1].Load(), received[0].Load()
	for range 6 {
		write()
		time.Sleep(time.Second / 30)
	}
	if received[1].Load() != high || received[0].Load() <= low {
		t.Fatalf("inactive high RID affected low or continued sending: high=%d->%d low=%d->%d limited=%t lowtrack=%+v hightrack=%+v", high, received[1].Load(), low, received[0].Load(), publication.Counters().Limited, publication.tracks[0].DebugInfo(), publication.tracks[1].DebugInfo())
	}
	if publication.Counters().Limited {
		t.Fatal("publication stayed limited after requested low output recovered and high was deactivated")
	}
	// The report after paused RTX probing must still match the primary clock.
	// DownTrack omits reports while no layer is selected, then resumes normally.
	for len(lowReports) > 0 {
		<-lowReports
	}
	select {
	case report := <-lowReports:
		if delta := int32(report.RTPTime - lowTimestamp.Load()); delta < 0 || delta > 3*90_000 {
			t.Fatalf("publication lost its primary clock after RTX probing: delta=%d", delta)
		}
	case <-ctx.Done():
		t.Fatal("resumed publication did not report its media clock")
	}
	// A live encoder can be constrained inside its sole requested RID. The
	// inactive high RID and a fitting measured rate must not hide that demand.
	source.SetLowestLayerRateControlled(true)
	publication.bandwidth.target.Store(80_000)
	if !publication.Counters().Limited {
		t.Fatal("publication hid the current encoder's unmet 90 kbps ceiling")
	}
	publication.bandwidth.target.Store(1_000_000)
	if publication.Counters().Limited {
		t.Fatal("publication kept a limitation after the encoder ceiling was satisfied")
	}
	check(publication.SetActiveCount(2))
	for received[1].Load() <= high {
		write()
		select {
		case <-time.After(time.Second / 30):
		case <-ctx.Done():
			t.Fatal("requested high RID did not resume after publisher activation")
		}
	}
	check(publication.Close())
	if len(source.GetDownTracks()) != 0 {
		t.Fatal("publication retained source outputs")
	}
}
