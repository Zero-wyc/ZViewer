package forwarding

import (
	"context"
	"net"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/livekit/livekit-server/pkg/sfu"
	"github.com/livekit/livekit-server/pkg/sfu/bwe"
	"github.com/livekit/livekit-server/pkg/sfu/ccutils"
	"github.com/livekit/livekit-server/pkg/sfu/pacer"
	packetpacer "github.com/livekit/mediatransportutil/pkg/pacer"
	"github.com/livekit/protocol/logger"
	"github.com/pion/interceptor"
	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/rtp/codecs"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
)

func TestTransportVideoFeedbackAudioAndClose(t *testing.T) {
	for _, repair := range []bool{true, false} {
		name := "RTX"
		if !repair {
			name = "primary-only"
		}
		t.Run(name, func(t *testing.T) { testTransportVideoFeedbackAudioAndClose(t, repair, false) })
	}
	t.Run("withdrawn-demand", func(t *testing.T) { testTransportVideoFeedbackAudioAndClose(t, true, true) })
}

func testTransportVideoFeedbackAudioAndClose(t *testing.T, repair, withdrawDemand bool) {
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
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
	keyFrames := make(chan struct{}, 8)
	source, err := NewSource(SourceOptions{ID: "screen", StreamID: "fixture", Codec: codec,
		Formats: []LayerFormat{{Width: 8, Height: 8, Bitrate: 300_000}, {Width: 16, Height: 16, Bitrate: 3_000_000}}, OnRTCP: func(_ int, packets []rtcp.Packet) {
			for _, packet := range packets {
				if _, ok := packet.(*rtcp.PictureLossIndication); ok {
					select {
					case keyFrames <- struct{}{}:
					default:
					}
				}
			}
		}})
	check(err)
	defer source.Close()
	check(source.BindLayer(0, 1000, webrtc.RTPParameters{Codecs: []webrtc.RTPCodecParameters{codec}}))
	// This checks feedback routing independently of the buffer's bootstrap-PLI throttle.
	source.buffers[0].SetPLIThrottle(0)
	settings := webrtc.SettingEngine{}
	settings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	settings.SetIncludeLoopbackCandidate(true)
	settings.SetIPFilter(func(ip net.IP) bool { return ip.IsLoopback() })
	audio, err := webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{
		MimeType: webrtc.MimeTypeOpus, ClockRate: 48_000, Channels: 2,
	}, "audio", "fixture")
	check(err)
	demandWake := make(chan struct{}, 1)
	transport, err := NewTransport(TransportOptions{Source: source, Settings: settings,
		ConnectionID: "child", InitialBitrate: 1_000_000, Audio: audio, OnDemandChanged: func() {
			select {
			case demandWake <- struct{}{}:
			default:
			}
		}})
	check(err)
	defer transport.Close()
	transport.Output.SetMaxSpatialLayer(0)
	if state := transport.Output.State(); state.VideoBudget != 1_000_000 {
		t.Fatalf("audio changed the video capacity estimate: %+v", state)
	}
	if len(source.GetDownTracks()) != 0 {
		t.Fatal("unconnected transport claimed source output")
	}
	if transport.RequiredActiveCount() != 1 {
		t.Fatal("initial configured acquisition demand was lost")
	}
	mediaEngine := &webrtc.MediaEngine{}
	if repair {
		check(mediaEngine.RegisterDefaultCodecs())
	} else {
		check(mediaEngine.RegisterCodec(codec, webrtc.RTPCodecTypeVideo))
		check(mediaEngine.RegisterCodec(webrtc.RTPCodecParameters{
			RTPCodecCapability: audio.Codec(), PayloadType: 111,
		}, webrtc.RTPCodecTypeAudio))
	}
	registry := &interceptor.Registry{}
	reports := &receiverReportGate{}
	// Inner writer also gates NACKs emitted by the default generator itself.
	registry.Add(reports)
	check(webrtc.RegisterDefaultInterceptors(mediaEngine, registry))
	receiver, err := webrtc.NewAPI(webrtc.WithMediaEngine(mediaEngine), webrtc.WithInterceptorRegistry(registry),
		webrtc.WithSettingEngine(settings)).NewPeerConnection(webrtc.Configuration{})
	check(err)
	defer receiver.Close()
	var videoPackets, audioPackets atomic.Uint32
	firstVideo := make(chan *rtp.Packet, 1)
	paddingPackets := make(chan *rtp.Packet, 8)
	var recoveryTimestamp atomic.Uint32
	var missingSequence uint16
	var videoSSRC uint32
	recovered := make(chan bool, 1)
	var readers sync.WaitGroup
	receiver.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		readers.Add(1)
		defer readers.Done()
		for {
			packet, attributes, readErr := track.ReadRTP()
			if readErr != nil {
				return
			}
			if packet.Padding {
				select {
				case paddingPackets <- packet:
				default:
				}
			}
			if len(packet.Payload) == 0 {
				continue
			}
			if track.Kind() == webrtc.RTPCodecTypeVideo {
				videoPackets.Add(1)
				select {
				case firstVideo <- packet:
				default:
				}
				if packet.Timestamp == recoveryTimestamp.Load() {
					select {
					case recovered <- attributes.Get(webrtc.AttributeRtxPayloadType) != nil:
					default:
					}
				}
			} else {
				audioPackets.Add(1)
			}
		}
	})
	offer, err := transport.PC.CreateOffer(nil)
	check(err)
	gather := webrtc.GatheringCompletePromise(transport.PC)
	check(transport.PC.SetLocalDescription(offer))
	select {
	case <-gather:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	check(receiver.SetRemoteDescription(*transport.PC.LocalDescription()))
	answer, err := receiver.CreateAnswer(nil)
	check(err)
	gather = webrtc.GatheringCompletePromise(receiver)
	check(receiver.SetLocalDescription(answer))
	select {
	case <-gather:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	check(transport.PC.SetRemoteDescription(*receiver.LocalDescription()))
	for transport.PC.ConnectionState() != webrtc.PeerConnectionStateConnected {
		select {
		case <-time.After(5 * time.Millisecond):
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	check(transport.SetConnected())
	check(transport.SetConnected())
	if len(source.GetDownTracks()) != 1 {
		t.Fatal("connected transport attached twice")
	}
	packetizer := rtp.NewPacketizer(1200, 96, 1000, &codecs.VP8Payloader{EnablePictureID: true}, rtp.NewRandomSequencer(), 90_000)
	for _, packet := range packetizer.Packetize(sfu.VP8KeyFrame8x8, 3000) {
		check(source.WriteRTP(0, packet))
	}
	firstFrame := false
	for !firstFrame {
		select {
		case packet := <-firstVideo:
			firstFrame = true
			recoveryTimestamp.Store(packet.Timestamp + 3000)
			missingSequence, videoSSRC = packet.SequenceNumber+1, packet.SSRC
			for len(keyFrames) > 0 {
				<-keyFrames
			}
			check(receiver.WriteRTCP([]rtcp.Packet{&rtcp.PictureLossIndication{MediaSSRC: packet.SSRC}}))
		case <-time.After(time.Second / 30):
			for _, packet := range packetizer.Packetize(sfu.VP8KeyFrame8x8, 3000) {
				check(source.WriteRTP(0, packet))
			}
		case <-ctx.Done():
			t.Fatalf("missing first frame: %+v", transport.Output.State())
		}
	}
	select {
	case <-keyFrames:
	case <-time.After(time.Second):
		t.Fatalf("first-frame PLI never reached source; output=%+v statsPLI=%d", transport.Output.State(), transport.Output.GetTrackStats().Plis)
	}
	// Force one local loss, then delay its feedback beyond the receiver's stock
	// SRTP replay window. Repair must use its negotiated RTX sequence space.
	// A peer declining RTX still supports ordinary NACK within that window.
	transport.pacer.mu.Lock()
	transport.pacer.limit = 0
	transport.pacer.mu.Unlock()
	for _, packet := range packetizer.Packetize(sfu.VP8KeyFrame8x8, 3000) {
		check(source.WriteRTP(0, packet))
	}
	for transport.Egress().DroppedPackets == 0 {
		select {
		case <-time.After(5 * time.Millisecond):
		case <-ctx.Done():
			t.Fatal("local admission loss was not exercised")
		}
	}
	transport.pacer.mu.Lock()
	transport.pacer.limit = source.maxPackets
	transport.pacer.mu.Unlock()
	deltaFrame := append([]byte(nil), sfu.VP8KeyFrame8x8...)
	deltaFrame[0] |= 1
	laterPackets := 96
	if !repair {
		laterPackets = 16
	}
	for range laterPackets {
		before := videoPackets.Load()
		for _, packet := range packetizer.Packetize(deltaFrame, 3000) {
			check(source.WriteRTP(0, packet))
		}
		for videoPackets.Load() == before {
			select {
			case <-time.After(time.Millisecond):
			case <-ctx.Done():
				t.Fatal("media stopped while delaying loss feedback")
			}
		}
	}
	reports.allowNACK.Store(true)
	check(receiver.WriteRTCP([]rtcp.Packet{&rtcp.TransportLayerNack{
		MediaSSRC: videoSSRC, Nacks: []rtcp.NackPair{{PacketID: missingSequence}},
	}}))
	ticker := time.NewTicker(time.Second / 30)
	defer ticker.Stop()
	for repaired := false; !repaired; {
		select {
		case usedRTX := <-recovered:
			if usedRTX != repair {
				t.Fatalf("repair path disagrees with negotiation: RTX=%v", usedRTX)
			}
			repaired = true
		case <-ticker.C:
			// Pion checks its repair queue between primary reads. Keep the
			// live delta stream flowing without superseding the missing keyframe.
			for _, packet := range packetizer.Packetize(deltaFrame, 3000) {
				check(source.WriteRTP(0, packet))
			}
		case <-ctx.Done():
			t.Fatal("delayed local admission loss did not recover through library NACK")
		}
	}
	for {
		_, observed := transport.TargetBitrate()
		if videoPackets.Load() >= 15 && audioPackets.Load() >= 15 && observed {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatalf("media or feedback missing: video=%d audio=%d observed=%v", videoPackets.Load(), audioPackets.Load(), observed)
		case <-ticker.C:
		}
		for _, packet := range packetizer.Packetize(sfu.VP8KeyFrame8x8, 3000) {
			check(source.WriteRTP(0, packet))
		}
		check(audio.WriteSample(media.Sample{Data: []byte{0xf8, 0xff, 0xfe}, Duration: 20 * time.Millisecond}))
	}
	if egress := transport.Egress(); egress.Packets < 15 || egress.RTPBytes == 0 || egress.DroppedPackets != 1 {
		t.Fatalf("paced local egress disagrees with receiving media: %+v", egress)
	}
	if len(demandWake) == 0 || transport.RequiredActiveCount() != 1 {
		t.Fatal("typed direct-child demand was not signaled")
	}
	// Raise subscribed demand without inventing an available layer. TWCC alone
	// cannot establish the RR readiness required by the library padding sender.
	transport.Output.DownTrack.SetMaxSpatialLayer(1)
	if delta, _ := transport.Output.probeDemand(); delta <= 0 {
		t.Fatal("no-RR fixture did not establish dormant upper demand")
	}
	transport.mediaActivity()
	transport.mu.Lock()
	ready := transport.paddingReady
	transport.mu.Unlock()
	if ready || transport.prober.IsRunning() {
		t.Fatal("transport probed before a receiver report")
	}
	// Exercise the library's real padding packet through Pion SRTP. Probe bytes
	// must be stripped by RTP decoding, not exposed to the video decoder as media.
	if transport.Output.WritePaddingRTP(255, true, false) == 0 {
		t.Fatal("padding fixture did not emit a probe")
	}
	select {
	case packet := <-paddingPackets:
		if len(packet.Payload) != 0 || packet.Header.PaddingSize == 0 {
			t.Fatalf("padding reached the receiver as video: payload=%d padding=%d", len(packet.Payload), packet.Header.PaddingSize)
		}
	case <-ctx.Done():
		t.Fatal("padding packet did not arrive")
	}
	// A stopped library writer returns zero padding bytes despite a connected PC
	// and valid RR. Its probe must finish, and inconclusive feedback must not
	// promote the BWE's internal initial-capacity sentinel into a codec budget.
	if !withdrawDemand {
		transport.Output.StopWriteAndGetState()
	}
	before, _ := transport.TargetBitrate()
	reports.allow.Store(true)
	seenProbe := false
	withdrawn := false
	for {
		transport.mediaActivity()
		transport.mu.Lock()
		active := transport.probe.Id != ccutils.ProbeClusterIdInvalid
		seenProbe = seenProbe || active
		if withdrawDemand && !withdrawn && active && transport.probe.Result.EndTime == 0 {
			// A live profile change can remove the unmet source demand without
			// replacing this transport or its current allocation.
			err := source.UpdateFormats([]LayerFormat{
				{Width: 8, Height: 8, Bitrate: 300_000}, {Width: 16, Height: 16, Bitrate: 600_000},
			})
			delta, _ := transport.Output.probeDemand()
			transport.driveProbeLocked()
			// Feedback may finalize the stopped probe in this same call, clearing
			// its identity and EndTime. Both retired states must stop sending.
			ended := !transport.prober.IsRunning() && (transport.probe.Id == ccutils.ProbeClusterIdInvalid ||
				transport.probe.Result.EndTime != 0)
			transport.mu.Unlock()
			check(err)
			if delta != 0 || !ended {
				t.Fatalf("withdrawn source demand retained a probe: demand=%d ended=%v", delta, ended)
			}
			withdrawn = true
			continue
		}
		transport.mu.Unlock()
		if seenProbe && !active && !transport.prober.IsRunning() {
			break
		}
		select {
		case <-time.After(5 * time.Millisecond):
		case <-ctx.Done():
			t.Fatal("probe did not retire within its library duration/settle bound")
		}
	}
	if after, _ := transport.TargetBitrate(); !withdrawDemand && after != before {
		t.Fatalf("zero-write probe manufactured a budget: before=%d after=%d", before, after)
	}
	if withdrawDemand && !withdrawn {
		t.Fatal("profile change did not exercise an active probe")
	}
	if withdrawn {
		beforePackets := videoPackets.Load()
		for videoPackets.Load() == beforePackets {
			for _, packet := range packetizer.Packetize(sfu.VP8KeyFrame8x8, 3000) {
				check(source.WriteRTP(0, packet))
			}
			select {
			case <-ticker.C:
			case <-ctx.Done():
				t.Fatal("withdrawing probe demand interrupted existing video")
			}
		}
	}
	check(transport.Close())
	check(transport.Close())
	check(receiver.Close())
	readers.Wait()
	if len(source.GetDownTracks()) != 0 || transport.SetConnected() == nil || transport.RequiredActiveCount() != 0 {
		t.Fatal("closed transport retained a source subscription")
	}
}

type receiverReportGate struct {
	interceptor.NoOp
	allow       atomic.Bool
	allowNACK   atomic.Bool
	reportDelay time.Duration
}

func (gate *receiverReportGate) NewInterceptor(string) (interceptor.Interceptor, error) {
	return gate, nil
}

func (gate *receiverReportGate) BindRTCPWriter(writer interceptor.RTCPWriter) interceptor.RTCPWriter {
	return interceptor.RTCPWriterFunc(func(packets []rtcp.Packet, attributes interceptor.Attributes) (int, error) {
		if gate.allow.Load() {
			for _, packet := range packets {
				if _, report := packet.(*rtcp.ReceiverReport); report {
					time.Sleep(gate.reportDelay)
					break
				}
			}
			return writer.Write(packets, attributes)
		}
		var filtered []rtcp.Packet
		for _, packet := range packets {
			if _, nack := packet.(*rtcp.TransportLayerNack); nack && !gate.allowNACK.Load() {
				continue
			}
			if _, report := packet.(*rtcp.ReceiverReport); !report {
				filtered = append(filtered, packet)
			}
		}
		if len(filtered) == 0 {
			return 0, nil
		}
		return writer.Write(filtered, attributes)
	})
}

type heldPacketPacer struct {
	packetpacer.Pacer
	packets []*packetpacer.Packet
}

func (held *heldPacketPacer) Enqueue(packet *packetpacer.Packet) {
	held.packets = append(held.packets, packet)
}

type countingPacketWriter struct{ bytes int }

func (writer *countingPacketWriter) WriteRTP(header *rtp.Header, payload []byte) (int, error) {
	written := header.MarshalSize() + len(payload) + int(header.PaddingSize)
	writer.bytes += written
	return written, nil
}

func (*countingPacketWriter) Write([]byte) (int, error) { panic("unexpected byte write") }

func TestTransportDoesNotPromoteUnverifiedCongestionCapacity(t *testing.T) {
	transport := &Transport{}
	transport.target.Store(1_200_000)
	// A pending probe can leave the framework's initial 100 Mbps estimate in
	// state-change callbacks. It is not proof that the connection can send it.
	transport.OnCongestionStateChange(bwe.CongestionStateNone, bwe.CongestionStateEarlyWarning, 100_000_000)
	transport.OnCongestionStateChange(bwe.CongestionStateEarlyWarning, bwe.CongestionStateCongested, 100_000_000)
	if bitrate, _ := transport.TargetBitrate(); bitrate != 1_200_000 {
		t.Fatalf("congestion promoted an unverified capacity: %d", bitrate)
	}
	transport.OnCongestionStateChange(bwe.CongestionStateCongested, bwe.CongestionStateCongested, 500_000)
	transport.OnCongestionStateChange(bwe.CongestionStateCongested, bwe.CongestionStateNone, 800_000)
	if bitrate, _ := transport.TargetBitrate(); bitrate != 500_000 {
		t.Fatalf("clearing congestion replaced the committed reduction without a probe: %d", bitrate)
	}
	// A recovery probe deliberately exceeds the current media allocation. Its
	// congestion, including late feedback while settling, cancels exploration
	// without cutting the already committed capacity (LiveKit's allocator rule).
	transport.probe = ccutils.ProbeClusterInfo{Id: 1}
	for _, ended := range []bool{false, true} {
		if ended {
			transport.probe.Result.EndTime = 1
		}
		transport.OnCongestionStateChange(bwe.CongestionStateNone, bwe.CongestionStateCongested, 250_000)
		if bitrate, _ := transport.TargetBitrate(); bitrate != 500_000 {
			t.Fatalf("probe congestion cut committed media capacity (settling=%v): %d", ended, bitrate)
		}
	}
	transport.probe = ccutils.ProbeClusterInfoInvalid
	transport.OnCongestionStateChange(bwe.CongestionStateCongested, bwe.CongestionStateCongested, 250_000)
	if bitrate, _ := transport.TargetBitrate(); bitrate != 250_000 {
		t.Fatalf("post-probe media congestion did not reduce capacity: %d", bitrate)
	}
}

type stalledPacketWriter struct {
	ready, release chan struct{}
	written        chan struct{}
	once           sync.Once
}

func (writer *stalledPacketWriter) WriteRTP(header *rtp.Header, payload []byte) (int, error) {
	writer.once.Do(func() { close(writer.ready); <-writer.release })
	writer.written <- struct{}{}
	return header.MarshalSize() + len(payload), nil
}

func (*stalledPacketWriter) Write([]byte) (int, error) { panic("unexpected byte write") }

func TestSendQueuesDrainAfterBandwidthReduction(t *testing.T) {
	for _, kind := range []string{"transport", "publication"} {
		t.Run(kind, func(t *testing.T) {
			codec := webrtc.RTPCodecParameters{RTPCodecCapability: webrtc.RTPCodecCapability{
				MimeType: webrtc.MimeTypeVP8, ClockRate: 90_000,
			}, PayloadType: 96}
			source, err := NewSource(SourceOptions{ID: "queue", StreamID: "queue", Codec: codec,
				Formats: []LayerFormat{{Width: 320, Height: 180, Bitrate: 500_000}}, MaxPackets: 500})
			if err != nil {
				t.Fatal(err)
			}
			defer source.Close()
			options := TransportOptions{Source: source, ConnectionID: "queue", InitialBitrate: 500_000}
			var queue *boundedPacer
			if kind == "publication" {
				publication, err := NewPublication(options)
				if err != nil {
					t.Fatal(err)
				}
				defer publication.Close()
				queue = publication.pacer.boundedPacer
			} else {
				transport, err := NewTransport(options)
				if err != nil {
					t.Fatal(err)
				}
				defer transport.Close()
				queue = transport.pacer
			}
			writer := &stalledPacketWriter{ready: make(chan struct{}), release: make(chan struct{}), written: make(chan struct{}, 32)}
			release := sync.OnceFunc(func() { close(writer.release) })
			defer release()
			for index := range 32 {
				header := &rtp.Header{Version: 2, SSRC: 1, SequenceNumber: uint16(index)}
				queue.Enqueue(&pacer.Packet{Header: header, HeaderSize: header.MarshalSize(),
					Payload: make([]byte, 1200), WriteStream: writer})
			}
			select {
			case <-writer.ready:
			case <-time.After(2 * time.Second):
				t.Fatal("transport did not reach the stalled writer")
			}
			// A short outage reduces the bandwidth estimate after these packets were
			// encoded. The recovered writer must not spend tens of seconds sending old
			// video before it can deliver a new frame.
			queue.SetBitrate(8_000)
			release()
			deadline := time.NewTimer(2 * time.Second)
			defer deadline.Stop()
			for range 32 {
				select {
				case <-writer.written:
				case <-deadline.C:
					t.Fatalf("writable transport retained old video: pending=%d sent=%d", queue.pendingCount(), queue.stats().Packets)
				}
			}
		})
	}
}

func TestBoundedPacerReleasesPacketsAndIsolatesBlockedQueue(t *testing.T) {
	log := logger.GetDiscardLogger()
	sender := packetpacer.NewPassThrough(log)
	held := &heldPacketPacer{Pacer: sender}
	queue := newBoundedPacer(held, log, 2)
	defer queue.Stop()
	healthy := newBoundedPacer(sender, log, 2)
	defer healthy.Stop()
	writer := &countingPacketWriter{}
	var originals []*pacer.Packet
	packet := func() *pacer.Packet {
		header := &rtp.Header{Version: 2, SSRC: 1}
		payload := make([]byte, 100)
		original := &pacer.Packet{Header: header, HeaderSize: header.MarshalSize(),
			HeaderPool: &sync.Pool{}, Pool: &sync.Pool{}, PoolEntity: &payload,
			Payload: payload, WriteStream: writer}
		originals = append(originals, original)
		return original
	}
	queue.Enqueue(packet())
	queue.Enqueue(packet())
	queue.Enqueue(packet())
	if len(queue.pending) != 2 || queue.stats().DroppedPackets != 1 || len(held.packets) != 2 {
		t.Fatalf("queue exceeded its bound: pending=%d stats=%+v", len(queue.pending), queue.stats())
	}
	healthy.Enqueue(packet())
	if healthy.stats().Packets != 1 || queue.stats().Packets != 0 {
		t.Fatal("held sibling blocked a ready packet")
	}
	sender.Enqueue(held.packets[0])
	queue.Enqueue(packet())
	queue.Stop()
	queue.Stop()
	queue.Enqueue(packet())
	// Upstream may still hold scheduling tickets when it stops. Visiting one
	// after cancellation must neither send nor return the original a second time.
	for _, proxy := range held.packets[1:] {
		sender.Enqueue(proxy)
	}
	if stats := queue.stats(); stats != (EgressStats{Packets: 1, RTPBytes: 112, DroppedPackets: 4}) {
		t.Fatalf("incorrect sent/drop accounting: %+v", stats)
	}
	for _, original := range originals {
		if original.Header != nil || original.Payload != nil || original.WriteStream != nil || original.PoolEntity != nil {
			t.Fatalf("send/Stop retained pooled packet ownership: %+v", original)
		}
	}
	if writer.bytes != 224 {
		t.Fatalf("canceled packets reached the writer: %d bytes", writer.bytes)
	}
}

func TestBoundedPacerCanceledProbesRetainAdmission(t *testing.T) {
	log := logger.GetDiscardLogger()
	sender := packetpacer.NewPassThrough(log)
	held := &heldPacketPacer{Pacer: sender}
	queue := newBoundedPacer(held, log, 2)
	defer queue.Stop()
	packet := func() *pacer.Packet {
		return &pacer.Packet{Header: &rtp.Header{Version: 2}, HeaderSize: 12,
			Payload: make([]byte, 100), WriteStream: &countingPacketWriter{}, IsProbe: true, ProbeClusterId: 1}
	}
	queue.Enqueue(packet())
	queue.Enqueue(packet())
	for range 10 {
		queue.cancelProbes(1)
		queue.Enqueue(packet())
	}
	if len(queue.pending) != 2 || len(held.packets) != 2 || queue.stats().DroppedPackets != 12 {
		t.Fatalf("canceled proxies freed admission before dequeue: pending=%d queued=%d stats=%+v",
			len(queue.pending), len(held.packets), queue.stats())
	}
	sender.Enqueue(held.packets[0])
	queue.Enqueue(packet())
	if len(queue.pending) != 2 || len(held.packets) != 3 {
		t.Fatal("actual dequeue did not return its admission slot")
	}
	queue.Stop()
	for _, proxy := range held.packets[1:] {
		sender.Enqueue(proxy)
	}
	if stats := queue.stats(); stats.Packets != 0 || stats.DroppedPackets != 13 {
		t.Fatalf("canceled ownership was sent or retired twice: %+v", stats)
	}
}

func TestBoundedPacerAccountsForPaddingExactlyOnce(t *testing.T) {
	for _, sizes := range []struct{ payload, padding int }{{100, 0}, {0, 255}, {20, 16}} {
		log := logger.GetDiscardLogger()
		sender := packetpacer.NewPassThrough(log)
		held := &heldPacketPacer{Pacer: sender}
		queue := newBoundedPacer(held, log, 1)
		defer queue.Stop()
		header := &rtp.Header{Version: 2, SSRC: 1, Padding: sizes.padding > 0, PaddingSize: byte(sizes.padding)}
		writer := &countingPacketWriter{}
		want := header.MarshalSize() + sizes.payload + sizes.padding
		queue.Enqueue(&pacer.Packet{Header: header, HeaderSize: header.MarshalSize(),
			Payload: make([]byte, sizes.payload), WriteStream: writer})
		proxy := held.packets[0]
		if scheduled := proxy.Header.MarshalSize() + len(proxy.Payload); scheduled != want {
			t.Fatalf("scheduled %d bytes for a %d-byte RTP packet: %+v", scheduled, want, sizes)
		}
		sender.Enqueue(proxy)
		queue.Stop()
		if writer.bytes != want || queue.stats().RTPBytes != uint64(want) || queue.pendingCount() != 0 {
			t.Fatalf("padding was serialized or counted twice: written=%d stats=%+v want=%d", writer.bytes, queue.stats(), want)
		}
	}
}

func BenchmarkBoundedPacerAdmission(b *testing.B) {
	log := logger.GetDiscardLogger()
	for _, bounded := range []bool{false, true} {
		name := "pass-through"
		if bounded {
			name = "bounded-admission"
		}
		b.Run(name, func(b *testing.B) {
			var queue pacer.Pacer = pacer.NewPassThrough(log, nil)
			if bounded {
				queue = newBoundedPacer(packetpacer.NewPassThrough(log), log, 500)
			}
			defer queue.Stop()
			writer := &countingPacketWriter{}
			header := &rtp.Header{Version: 2, SSRC: 1}
			payload := make([]byte, 1200)
			b.ReportAllocs()
			b.ResetTimer()
			for b.Loop() {
				packet := pacer.PacketFactory.Get().(*pacer.Packet)
				*packet = pacer.Packet{Header: header, HeaderSize: header.MarshalSize(), Payload: payload, WriteStream: writer}
				queue.Enqueue(packet)
			}
		})
	}
}
