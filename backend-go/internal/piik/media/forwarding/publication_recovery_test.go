package forwarding

import (
	"encoding/binary"
	"encoding/json"
	"os"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/livekit/livekit-server/pkg/sfu"
	"github.com/pion/ice/v4"
	"github.com/pion/interceptor"
	"github.com/pion/logging"
	"github.com/pion/transport/v5/vnet"
	"github.com/pion/webrtc/v4"
	"zviewer/backend/internal/piik/media/encoded"
)

// Like the direct-transport recovery gate, this uses real ICE/DTLS/RTP/TWCC
// with synthetic video payload. Frame arrival is not decoded FPS or picture
// quality. The link changes in place; reconnecting must not hide recovery loss.
func TestPublicationConstrainedRecovery(t *testing.T) {
	if os.Getenv("PIIK_TRANSPORT_RECOVERY") == "" {
		t.Skip("set PIIK_TRANSPORT_RECOVERY=1 for the bounded virtual-network gate")
	}
	for _, scenario := range []string{"healthy", "brief", "periodic", "sustained", "pause-resume", "source-replacement"} {
		t.Run(scenario, func(t *testing.T) { checkPublicationRecovery(t, scenario) })
	}
}

type publicationRecoverySample struct {
	At, ReceivedBps, FrameArrivalsPerSecond, FrameAgeP95Ms float64
	LinkBps, BudgetBps                                     int64
}

func checkPublicationRecovery(t *testing.T, scenario string) {
	t.Helper()
	check := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	log := logging.NewDefaultLoggerFactory()
	router, err := vnet.NewRouter(&vnet.RouterConfig{CIDR: "10.0.0.0/24", MinDelay: 20 * time.Millisecond, LoggerFactory: log})
	check(err)
	sendNet, err := vnet.NewNet(&vnet.NetConfig{StaticIPs: []string{"10.0.0.1"}})
	check(err)
	receiveNet, err := vnet.NewNet(&vnet.NetConfig{StaticIPs: []string{"10.0.0.2"}})
	check(err)
	link := vnet.NewTBFQueue(6_000_000, 2400, 7500)
	queue, err := vnet.NewQueue(receiveNet, link)
	check(err)
	defer queue.Close()
	check(router.AddNet(sendNet))
	check(router.AddNet(queue))
	check(router.Start())
	defer router.Stop()
	codec := webrtc.RTPCodecParameters{RTPCodecCapability: webrtc.RTPCodecCapability{
		MimeType: webrtc.MimeTypeVP8, ClockRate: 90_000,
		RTCPFeedback: []webrtc.RTCPFeedback{{Type: "nack"}, {Type: "nack", Parameter: "pli"}, {Type: webrtc.TypeRTCPFBTransportCC}},
	}, PayloadType: 96}
	newSource := func(bitrate uint32) *EncodedSource {
		t.Helper()
		source, err := NewEncodedSource(SourceOptions{ID: "recovery", StreamID: "recovery", Codec: codec,
			Formats: []LayerFormat{{Width: 8, Height: 8, Bitrate: bitrate}}, MaxPackets: 500})
		check(err)
		t.Cleanup(func() { source.Close() })
		source.SetLowestLayerRateControlled(true)
		return source
	}
	source := newSource(300_000)
	sendSettings, receiveSettings := webrtc.SettingEngine{}, webrtc.SettingEngine{}
	sendSettings.SetNet(sendNet)
	receiveSettings.SetNet(receiveNet)
	for _, settings := range []*webrtc.SettingEngine{&sendSettings, &receiveSettings} {
		settings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
		settings.SetICEMulticastDNSMode(ice.MulticastDNSModeDisabled)
	}
	publication, err := NewPublication(TransportOptions{Source: source.Source, Settings: sendSettings,
		ConnectionID: "recovery-child", InitialBitrate: 1_200_000})
	check(err)
	defer publication.Close()
	media, registry := &webrtc.MediaEngine{}, &interceptor.Registry{}
	check(media.RegisterDefaultCodecs())
	// Register TWCC exactly once. Duplicate feedback changes the experiment.
	check(webrtc.RegisterDefaultInterceptors(media, registry))
	receiver, err := webrtc.NewAPI(webrtc.WithMediaEngine(media), webrtc.WithInterceptorRegistry(registry),
		webrtc.WithSettingEngine(receiveSettings)).NewPeerConnection(webrtc.Configuration{})
	check(err)
	var readers sync.WaitGroup
	defer readers.Wait()
	defer receiver.Close()
	var metricMu sync.Mutex
	var received uint64
	var frameAges []float64
	receiver.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		readers.Add(1)
		defer readers.Done()
		var lastTimestamp uint32
		for {
			packet, _, err := track.ReadRTP()
			if err != nil {
				return
			}
			metricMu.Lock()
			received += uint64(len(packet.Payload))
			if packet.Marker && len(packet.Payload) >= 8 && lastTimestamp != packet.Timestamp {
				sentAt := time.Unix(0, int64(binary.BigEndian.Uint64(packet.Payload[len(packet.Payload)-8:])))
				if age := time.Since(sentAt); age >= 0 && age < 10*time.Second {
					lastTimestamp = packet.Timestamp
					frameAges = append(frameAges, float64(age)/float64(time.Millisecond))
				}
			}
			metricMu.Unlock()
		}
	})
	offer, err := publication.PC.CreateOffer(nil)
	check(err)
	gathered := webrtc.GatheringCompletePromise(publication.PC)
	check(publication.PC.SetLocalDescription(offer))
	select {
	case <-gathered:
	case <-time.After(5 * time.Second):
		t.Fatal("publisher gathering timed out")
	}
	check(receiver.SetRemoteDescription(*publication.PC.LocalDescription()))
	answer, err := receiver.CreateAnswer(nil)
	check(err)
	gathered = webrtc.GatheringCompletePromise(receiver)
	check(receiver.SetLocalDescription(answer))
	select {
	case <-gathered:
	case <-time.After(5 * time.Second):
		t.Fatal("receiver gathering timed out")
	}
	check(publication.PC.SetRemoteDescription(*receiver.LocalDescription()))
	deadline := time.Now().Add(5 * time.Second)
	for publication.PC.ConnectionState() != webrtc.PeerConnectionStateConnected {
		if time.Now().After(deadline) {
			t.Fatal("virtual network did not connect")
		}
		time.Sleep(5 * time.Millisecond)
	}
	check(publication.SetConnected())
	period := time.Second / 30
	ticker := time.NewTicker(period)
	defer ticker.Stop()
	start, lastSample := time.Now(), time.Now()
	var samples []publicationRecoverySample
	ceiling := int64(300_000)
	muted, resumed, replaced := false, false, false
	frame, finalRecoveryWindows, pausedWindows := 0, 0, 0
	for range ticker.C {
		now := time.Now()
		elapsed := now.Sub(start)
		if elapsed >= 60*time.Second {
			break
		}
		capacity := int64(6_000_000)
		constrained := scenario == "brief" && elapsed >= 12*time.Second && elapsed < 13*time.Second ||
			scenario == "periodic" && (elapsed >= 12*time.Second && elapsed < 13*time.Second ||
				elapsed >= 22*time.Second && elapsed < 23*time.Second || elapsed >= 32*time.Second && elapsed < 33*time.Second) ||
			(scenario == "sustained" || scenario == "pause-resume" || scenario == "source-replacement") &&
				elapsed >= 8*time.Second && elapsed < 30*time.Second
		if constrained {
			capacity = 120_000
		}
		link.SetRate(int(capacity))
		if scenario == "pause-resume" && elapsed >= 32*time.Second && !muted {
			check(publication.SetActiveCount(0))
			muted = true
		}
		if scenario == "pause-resume" && elapsed >= 38*time.Second && !resumed {
			check(publication.SetActiveCount(1))
			resumed = true
		}
		if scenario == "source-replacement" && elapsed >= 32*time.Second && !replaced {
			next := newSource(600_000)
			check(publication.ReplaceSource(next.Source))
			source.SetLowestLayerRateControlled(false)
			source, ceiling, replaced = next, 600_000, true
		}
		budget := publication.LowestLayerBudget()
		if budget > 6_000_000 {
			t.Fatalf("unmeasured capacity promoted beyond the link: %d", budget)
		}
		pts := time.Duration(frame) * period
		check(source.BeginFrame(pts, now))
		bitrate := source.CodecBudget(0, min(ceiling, max(budget, 1)))
		data := make([]byte, max(len(sfu.VP8KeyFrame8x8)+8, int(bitrate/8/30)))
		copy(data, sfu.VP8KeyFrame8x8)
		binary.BigEndian.PutUint64(data[len(data)-8:], uint64(time.Now().UnixNano()))
		check(source.WriteFrame(0, encoded.Frame{Data: data, PTS: pts, Duration: period, Recovery: true}))
		frame++
		if now.Sub(lastSample) < time.Second {
			continue
		}
		metricMu.Lock()
		bytes, ages := received, frameAges
		received, frameAges = 0, nil
		metricMu.Unlock()
		slices.Sort(ages)
		interval := now.Sub(lastSample).Seconds()
		sample := publicationRecoverySample{At: elapsed.Seconds(), LinkBps: capacity, BudgetBps: budget,
			ReceivedBps: float64(bytes*8) / interval, FrameArrivalsPerSecond: float64(len(ages)) / interval}
		if len(ages) > 0 {
			sample.FrameAgeP95Ms = ages[(len(ages)-1)*95/100]
		}
		samples = append(samples, sample)
		if muted && !resumed && elapsed >= 34*time.Second {
			if bytes != 0 || publication.bandwidth.probing.Load() {
				t.Fatal("paused publication kept sending/probing")
			}
			pausedWindows++
		}
		// Require sustained recent arrivals: a delayed packet burst cannot pass.
		if elapsed >= 50*time.Second && budget >= ceiling && sample.ReceivedBps > float64(ceiling)*0.9 &&
			sample.ReceivedBps < float64(ceiling)*1.2 && sample.FrameArrivalsPerSecond >= 27 && sample.FrameAgeP95Ms < 100 {
			finalRecoveryWindows++
		} else {
			finalRecoveryWindows = 0
		}
		lastSample = now
	}
	result, err := json.Marshal(samples)
	check(err)
	t.Logf("LAB_SAMPLES %s", result)
	if finalRecoveryWindows < 5 || scenario == "pause-resume" && pausedWindows < 2 {
		t.Fatalf("missing sustained recovery/pause: recovered=%d paused=%d", finalRecoveryWindows, pausedWindows)
	}
	check(publication.Close())
	if publication.encoderProbeDemand() != 0 || publication.pacer.pendingCount() != 0 {
		t.Fatal("closed publication retained demand or queued packets")
	}
}
