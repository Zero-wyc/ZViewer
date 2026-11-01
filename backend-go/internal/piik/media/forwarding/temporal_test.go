package forwarding

import (
	"context"
	"net"
	"sync/atomic"
	"testing"
	"time"

	"github.com/livekit/livekit-server/pkg/sfu"
	"github.com/livekit/livekit-server/pkg/sfu/buffer"
	"github.com/livekit/mediatransportutil/pkg/codec"
	"github.com/livekit/protocol/livekit"
	"github.com/livekit/protocol/logger"
	"github.com/pion/rtp"
	"github.com/pion/rtp/codecs"
	"github.com/pion/webrtc/v4"
)

// A recovered budget must not admit VP8 frames referencing discarded temporal
// layers. Exercise the same library forwarder used by Native and SFU DownTracks.
func TestVP8TemporalRecoveryRequiresDecodableFrames(t *testing.T) {
	forwarder := sfu.NewForwarder(webrtc.RTPCodecTypeVideo, logger.GetLogger(), true, true, true, nil)
	forwarder.DetermineCodec(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90_000}, nil,
		livekit.VideoLayer_MODE_UNUSED)
	forwarder.SetMaxSpatialLayer(0)
	forwarder.SetMaxPublishedLayer(0)
	forwarder.SetMaxTemporalLayerSeen(2)
	for index, step := range []struct {
		name              string
		target, tid, want int32
		key, sync         bool
	}{
		{"start at base layer", 0, 0, 0, true, false},
		{"dependent frame cannot raise layer", 2, 1, 0, false, false},
		{"sync cannot skip an intermediate layer", 2, 2, 0, false, true},
		{"first sync restores middle layer", 2, 1, 1, false, true},
		{"highest dependent frame still waits", 2, 2, 1, false, false},
		{"next sync restores highest layer", 2, 2, 2, false, true},
		{"reduce at frame boundary", 0, 2, 0, false, false},
		{"keyframe restores all layers without sync bit", 2, 0, 2, true, false},
	} {
		forwarder.SetMaxTemporalLayer(step.target)
		forwarder.AllocateOptimal([]int32{0}, sfu.Bitrates{{100_000, 200_000, 300_000}}, false, false)
		sequence := uint64(index + 1)
		packet := &buffer.ExtPacket{
			VideoLayer:        buffer.VideoLayer{Spatial: 0, Temporal: step.tid},
			ExtSequenceNumber: sequence, ExtTimestamp: sequence * 3000, IsKeyFrame: step.key,
			Packet: &rtp.Packet{Header: rtp.Header{Version: 2, Marker: true, SSRC: 1000,
				SequenceNumber: uint16(sequence), Timestamp: uint32(sequence * 3000)}, Payload: []byte{0x10, 0}},
			VP8: &codec.VP8{S: true, T: true, TID: uint8(step.tid), Y: step.sync, IsKeyFrame: step.key},
		}
		if _, err := forwarder.GetTranslationParams(packet, 0); err != nil {
			t.Fatalf("%s: %v", step.name, err)
		}
		if got := forwarder.CurrentLayer().Temporal; got != step.want {
			t.Fatalf("%s: temporal layer %d, want %d", step.name, got, step.want)
		}
	}
}

// Browser VP8 can produce L1T3 even with only one spatial encoding. Both
// forwarding owners must retain its enhancement frames, not silently cap T0.
// This exercises RTP forwarding; the Browser gate separately checks decoding.
func TestForwardingPreservesVP8TemporalLayers(t *testing.T) {
	for _, name := range []string{"transport", "publication"} {
		t.Run(name, func(t *testing.T) {
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
			}, PayloadType: 96}
			source, err := NewSource(SourceOptions{ID: "screen", StreamID: "temporal", Codec: codec,
				Formats: []LayerFormat{{Width: 8, Height: 8, Bitrate: 300_000}}})
			check(err)
			defer source.Close()
			check(source.BindLayer(0, 1000, webrtc.RTPParameters{Codecs: []webrtc.RTPCodecParameters{codec}}))
			settings := webrtc.SettingEngine{}
			settings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
			settings.SetIncludeLoopbackCandidate(true)
			settings.SetIPFilter(func(ip net.IP) bool { return ip.IsLoopback() })
			options := TransportOptions{Source: source, Settings: settings, ConnectionID: name, InitialBitrate: 1_000_000}
			var pc *webrtc.PeerConnection
			var connect func() error
			if name == "publication" {
				publication, err := NewPublication(options)
				check(err)
				defer publication.Close()
				pc, connect = publication.PC, publication.SetConnected
			} else {
				transport, err := NewTransport(options)
				check(err)
				defer transport.Close()
				pc, connect = transport.PC, transport.SetConnected
			}
			receiver, err := webrtc.NewAPI(webrtc.WithSettingEngine(settings)).NewPeerConnection(webrtc.Configuration{})
			check(err)
			defer receiver.Close()
			var received [3]atomic.Uint32
			receiver.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
				for {
					packet, _, err := track.ReadRTP()
					if err != nil {
						return
					}
					var vp8 codecs.VP8Packet
					if _, err := vp8.Unmarshal(packet.Payload); err == nil && vp8.T == 1 && vp8.TID < 3 {
						received[vp8.TID].Add(1)
					}
				}
			})
			offer, err := pc.CreateOffer(nil)
			check(err)
			gather := webrtc.GatheringCompletePromise(pc)
			check(pc.SetLocalDescription(offer))
			select {
			case <-gather:
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			check(receiver.SetRemoteDescription(*pc.LocalDescription()))
			answer, err := receiver.CreateAnswer(nil)
			check(err)
			gather = webrtc.GatheringCompletePromise(receiver)
			check(receiver.SetLocalDescription(answer))
			select {
			case <-gather:
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			check(pc.SetRemoteDescription(*receiver.LocalDescription()))
			for pc.ConnectionState() != webrtc.PeerConnectionStateConnected {
				select {
				case <-time.After(5 * time.Millisecond):
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}
			}
			check(connect())
			for frame := uint16(0); received[0].Load() < 4 || received[1].Load() < 4 || received[2].Load() < 4; frame++ {
				tid := []byte{0, 2, 1, 2}[frame%4]
				// RFC 7741: I/L/T descriptor, PictureID, TL0PICIDX, TID/Y.
				payload := append([]byte{0x90, 0xe0, byte(frame & 0x7f), byte(frame / 4), tid<<6 | 0x20}, sfu.VP8KeyFrame8x8...)
				if frame%20 != 0 {
					payload[5] |= 1 // Delta-frame header; only T0 carries keyframes.
				}
				check(source.WriteRTP(0, &rtp.Packet{Header: rtp.Header{Version: 2, Marker: true,
					PayloadType: 96, SSRC: 1000, SequenceNumber: frame + 1, Timestamp: uint32(frame+1) * 3000}, Payload: payload}))
				select {
				case <-time.After(time.Second / 30):
				case <-ctx.Done():
					t.Fatalf("forwarding discarded temporal layers: T0=%d T1=%d T2=%d", received[0].Load(), received[1].Load(), received[2].Load())
				}
			}
		})
	}
}
