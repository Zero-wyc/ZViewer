package forwarding

import (
	"context"
	"net"
	"sync/atomic"
	"testing"
	"time"

	"github.com/livekit/livekit-server/pkg/sfu"
	"github.com/pion/interceptor"
	"github.com/pion/webrtc/v4"
	"zviewer/backend/internal/piik/media/encoded"
)

// A late child must establish real video/TWCC even when its initial estimate
// is below the source's measured rate. Payloads exercise RTP, not decoding.
func TestTransportBootstrapsWarmRawSource(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	check := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	wait := func(done <-chan struct{}) {
		t.Helper()
		select {
		case <-done:
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	codec := webrtc.RTPCodecParameters{RTPCodecCapability: webrtc.RTPCodecCapability{
		MimeType: webrtc.MimeTypeVP8, ClockRate: 90_000,
		RTCPFeedback: []webrtc.RTCPFeedback{{Type: "nack"}, {Type: "nack", Parameter: "pli"}, {Type: webrtc.TypeRTCPFBTransportCC}},
	}, PayloadType: 96}
	source, err := NewEncodedSource(SourceOptions{ID: "warm", StreamID: "fixture", Codec: codec,
		Formats: []LayerFormat{{Width: 8, Height: 8, Bitrate: 5_000_000}}})
	check(err)
	done, producerError := make(chan struct{}), make(chan error, 1)
	go func() {
		defer close(done)
		ticker := time.NewTicker(time.Second / 30)
		defer ticker.Stop()
		data := make([]byte, 20_000)
		copy(data, sfu.VP8KeyFrame8x8)
		for frame := 0; ; frame++ {
			select {
			case <-ctx.Done():
				return
			case now := <-ticker.C:
				pts := time.Duration(frame) * (time.Second / 30)
				if err := source.BeginFrame(pts, now); err != nil {
					producerError <- err
					return
				}
				if err := source.WriteFrame(0, encoded.Frame{Data: data, PTS: pts, Duration: time.Second / 30, Recovery: true}); err != nil {
					producerError <- err
					return
				}
			}
		}
	}()
	defer func() { cancel(); <-done; source.Close() }()
	for {
		available, rates := source.GetLayeredBitrate()
		if len(available) > 0 && rates[0][0] > 4_000_000 {
			break
		}
		select {
		case err := <-producerError:
			t.Fatal(err)
		case <-ctx.Done():
			t.Fatal("source did not establish its measured bitrate")
		case <-time.After(20 * time.Millisecond):
		}
	}
	settings := webrtc.SettingEngine{}
	settings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	settings.SetIncludeLoopbackCandidate(true)
	settings.SetIPFilter(func(ip net.IP) bool { return ip.IsLoopback() })
	transport, err := NewTransport(TransportOptions{Source: source.Source, Settings: settings,
		ConnectionID: "late-child", InitialBitrate: 3_000_000})
	check(err)
	defer transport.Close()
	media := &webrtc.MediaEngine{}
	check(media.RegisterDefaultCodecs())
	registry := &interceptor.Registry{}
	check(webrtc.RegisterDefaultInterceptors(media, registry))
	receiver, err := webrtc.NewAPI(webrtc.WithMediaEngine(media), webrtc.WithInterceptorRegistry(registry),
		webrtc.WithSettingEngine(settings)).NewPeerConnection(webrtc.Configuration{})
	check(err)
	defer receiver.Close()
	var packets atomic.Uint32
	receiver.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		for {
			packet, _, err := track.ReadRTP()
			if err != nil {
				return
			}
			if len(packet.Payload) > 0 {
				packets.Add(1)
			}
		}
	})
	offer, err := transport.PC.CreateOffer(nil)
	check(err)
	gathered := webrtc.GatheringCompletePromise(transport.PC)
	check(transport.PC.SetLocalDescription(offer))
	wait(gathered)
	check(receiver.SetRemoteDescription(*transport.PC.LocalDescription()))
	answer, err := receiver.CreateAnswer(nil)
	check(err)
	gathered = webrtc.GatheringCompletePromise(receiver)
	check(receiver.SetLocalDescription(answer))
	wait(gathered)
	check(transport.PC.SetRemoteDescription(*receiver.LocalDescription()))
	for transport.PC.ConnectionState() != webrtc.PeerConnectionStateConnected {
		select {
		case <-time.After(5 * time.Millisecond):
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	check(transport.SetConnected())
	for packets.Load() == 0 || !transport.observed.Load() {
		select {
		case err := <-producerError:
			t.Fatal(err)
		case <-ctx.Done():
			t.Fatalf("warm source could not establish video/feedback: packets=%d state=%+v", packets.Load(), transport.Output.State())
		case <-time.After(10 * time.Millisecond):
		}
	}
}
