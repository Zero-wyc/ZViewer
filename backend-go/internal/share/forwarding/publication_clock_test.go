package forwarding

import (
	"context"
	"net"
	"sync/atomic"
	"testing"
	"time"

	"github.com/livekit/livekit-server/pkg/sfu"
	"github.com/pion/webrtc/v4"
	"zviewer/backend/internal/share/encoded"
)

func TestPublicationDormantLayerRetainsClockAcrossGeneration(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	check := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	source, err := NewEncodedSource(clockSourceOptions("asymmetric-generation"))
	check(err)
	defer source.Close()
	settings := webrtc.SettingEngine{}
	settings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	settings.SetIncludeLoopbackCandidate(true)
	settings.SetIPFilter(func(ip net.IP) bool { return ip.IsLoopback() })
	publication, err := NewPublication(TransportOptions{Source: source.Source, Settings: settings, ConnectionID: "asymmetric-generation", InitialBitrate: 2_000_000})
	check(err)
	defer publication.Close()
	media := &webrtc.MediaEngine{}
	check(media.RegisterDefaultCodecs())
	check(media.RegisterHeaderExtension(webrtc.RTPHeaderExtensionCapability{URI: publicationRIDExtension}, webrtc.RTPCodecTypeVideo))
	check(media.RegisterHeaderExtension(webrtc.RTPHeaderExtensionCapability{URI: "urn:ietf:params:rtp-hdrext:sdes:mid"}, webrtc.RTPCodecTypeVideo))
	receiver, err := webrtc.NewAPI(webrtc.WithMediaEngine(media), webrtc.WithSettingEngine(settings)).NewPeerConnection(webrtc.Configuration{})
	check(err)
	defer receiver.Close()
	var packets [2]atomic.Uint32
	var timestamps [2]atomic.Uint32
	receiver.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		index := 0
		if track.RID() == "h" {
			index = 1
		}
		for {
			packet, _, err := track.ReadRTP()
			if err != nil {
				return
			}
			if packet.Marker && len(packet.Payload) > 0 {
				timestamps[index].Store(packet.Timestamp)
				packets[index].Add(1)
			}
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
		case <-time.After(time.Millisecond):
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	check(publication.SetConnected())
	origin := time.Now().Add(-2 * time.Second)
	// Stream trackers attach asynchronously; establish both actual wire outputs.
	for frame := 0; frame < 30; frame++ {
		pts := time.Duration(frame) * time.Second / 60
		check(source.BeginFrame(pts, origin.Add(pts)))
		for layer := 0; layer < 2; layer++ {
			check(source.WriteFrame(layer, encoded.Frame{Data: sfu.VP8KeyFrame8x8, PTS: pts, Duration: time.Second / 30, Recovery: true}))
		}
		time.Sleep(40 * time.Millisecond)
	}
	write := func(pts time.Duration, at time.Time, layers ...int) {
		t.Helper()
		check(source.BeginFrame(pts, at))
		for _, layer := range layers {
			before := packets[layer].Load()
			check(source.WriteFrame(layer, encoded.Frame{Data: sfu.VP8KeyFrame8x8, PTS: pts, Duration: time.Second / 30, Recovery: true}))
			for packets[layer].Load() == before {
				select {
				case <-time.After(time.Millisecond):
				case <-ctx.Done():
					t.Fatalf("layer %d did not forward: %v", layer, ctx.Err())
				}
			}
		}
	}
	write(time.Second, origin.Add(time.Second), 0)
	write(2*time.Second, origin.Add(2*time.Second), 1)
	previousHigh := timestamps[1].Load()
	for layer, track := range publication.tracks {
		sr := track.CreateSenderReport()
		if sr == nil {
			t.Fatalf("initial layer %d report absent", layer)
		}
	}
	source.BeginGeneration()
	replacementOrigin := time.Now()
	write(0, replacementOrigin, 0)
	time.Sleep(200 * time.Millisecond)
	highBefore := publication.tracks[1].CreateSenderReport()
	if highBefore == nil {
		t.Fatal("dormant high report absent before reentry")
	}
	// Wait until the new capture has advanced 5s while only the low rendition runs.
	timer := time.NewTimer(time.Until(replacementOrigin.Add(5 * time.Second)))
	defer timer.Stop()
	select {
	case <-timer.C:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	// The dormant high SR has advanced normally on its previous timestamp clock.
	highLatest := publication.tracks[1].CreateSenderReport()
	if highLatest == nil {
		t.Fatal("dormant high report absent at 5s")
	}
	write(5*time.Second, replacementOrigin.Add(5*time.Second), 0, 1)
	highAfter := publication.tracks[1].CreateSenderReport()
	if highAfter == nil {
		t.Fatal("dormant high rendition resumes with a backward clock; actual retained publication cannot emit its new sender report")
	}
	// A fixed initial RTP anchor is valid. Its elapsed clock must survive the
	// replacement even though the renditions last emitted different input PTS.
	expected := replacementOrigin.Add(5 * time.Second).Sub(origin.Add(2 * time.Second))
	actual := time.Duration(timestamps[1].Load()-previousHigh) * time.Second / 90_000
	if mismatch := actual - expected; mismatch.Abs() > time.Millisecond {
		t.Fatalf("replacement changed the wire capture clock by %v", mismatch)
	}
}
