package forwarding

import (
	"context"
	"net"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/livekit/livekit-server/pkg/sfu"
	"github.com/livekit/livekit-server/pkg/sfu/buffer"
	"github.com/livekit/protocol/livekit"
	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v4"
	"zviewer/backend/internal/share/encoded"
)

type heldSourceClose struct {
	buffer.BufferProvider
	entered chan struct{}
	release chan struct{}
}

func (input *heldSourceClose) CloseWithReason(reason string) (*livekit.RTPStats, error) {
	close(input.entered)
	<-input.release
	return input.BufferProvider.CloseWithReason(reason)
}

func TestSourceRetargetPreservesTransportAndPublication(t *testing.T) {
	for _, simulcast := range []bool{false, true} {
		name := "transport"
		if simulcast {
			name = "publication"
		}
		t.Run(name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 8*time.Second)
			defer cancel()
			check := func(err error) {
				t.Helper()
				if err != nil {
					t.Fatal(err)
				}
			}
			codec := webrtc.RTPCodecParameters{RTPCodecCapability: webrtc.RTPCodecCapability{
				MimeType: webrtc.MimeTypeVP8, ClockRate: 90_000,
				RTCPFeedback: []webrtc.RTCPFeedback{{Type: "nack"}, {Type: "nack", Parameter: "pli"}},
			}, PayloadType: 96}
			var keyframes atomic.Uint32
			makeSource := func(streamID string) *EncodedSource {
				input, err := NewEncodedSource(SourceOptions{ID: "screen", StreamID: streamID, Codec: codec,
					Formats: []LayerFormat{{Width: 8, Height: 8, Bitrate: 90_000}, {Width: 8, Height: 8, Bitrate: 300_000}},
					OnRTCP:  func(_ int, packets []rtcp.Packet) { keyframes.Add(uint32(len(packets))) },
				})
				check(err)
				t.Cleanup(input.Close)
				return input
			}
			old, next := makeSource("retarget"), makeSource("retarget")
			closed, foreign := makeSource("retarget"), makeSource("different-stream")
			closed.Close()
			settings := webrtc.SettingEngine{}
			settings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
			settings.SetIncludeLoopbackCandidate(true)
			settings.SetIPFilter(func(ip net.IP) bool { return ip.IsLoopback() })
			options := TransportOptions{Source: old.Source, Settings: settings, ConnectionID: name, InitialBitrate: 1_000_000}
			var pc *webrtc.PeerConnection
			var replace func(*Source) error
			var current func() *Source
			var connect func() error
			var closeTransport func() error
			var transport *Transport
			var publication *Publication
			if simulcast {
				var err error
				publication, err = NewPublication(options)
				check(err)
				pc, replace, current, connect, closeTransport = publication.PC, publication.ReplaceSource,
					publication.CurrentSource, publication.SetConnected, publication.Close
			} else {
				var err error
				transport, err = NewTransport(options)
				check(err)
				pc, replace, current, connect, closeTransport = transport.PC, transport.ReplaceSource,
					transport.CurrentSource, transport.SetConnected, transport.Close
			}
			defer closeTransport()
			check(replace(next.Source))
			if len(next.GetDownTracks()) != 0 {
				t.Fatal("retarget attached an unconnected consumer")
			}
			check(replace(old.Source))
			mediaEngine := &webrtc.MediaEngine{}
			check(mediaEngine.RegisterDefaultCodecs())
			if simulcast {
				check(mediaEngine.RegisterHeaderExtension(webrtc.RTPHeaderExtensionCapability{URI: publicationRIDExtension}, webrtc.RTPCodecTypeVideo))
				check(mediaEngine.RegisterHeaderExtension(webrtc.RTPHeaderExtensionCapability{URI: "urn:ietf:params:rtp-hdrext:sdes:mid"}, webrtc.RTPCodecTypeVideo))
			}
			receiver, err := webrtc.NewAPI(webrtc.WithMediaEngine(mediaEngine), webrtc.WithSettingEngine(settings)).NewPeerConnection(webrtc.Configuration{})
			check(err)
			defer receiver.Close()
			var received [2]atomic.Uint32
			var badTimeline atomic.Bool
			receiver.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
				index := 0
				if track.RID() == "h" {
					index = 1
				}
				var previous uint32
				for {
					packet, _, err := track.ReadRTP()
					if err != nil {
						return
					}
					if packet.Marker && len(packet.Payload) > 0 {
						if previous != 0 && int32(packet.Timestamp-previous) <= 0 {
							badTimeline.Store(true)
							t.Logf("RID=%s RTP timestamp=%d previous=%d seq=%d", track.RID(), packet.Timestamp, previous, packet.SequenceNumber)
						}
						previous = packet.Timestamp
						received[index].Add(1)
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
			frame := 0
			write := func(input *EncodedSource) {
				frame++
				pts := time.Duration(frame) * time.Second / 30
				check(input.BeginFrame(pts, time.Now()))
				for layer := 0; layer < 2; layer++ {
					check(input.WriteFrame(layer, encoded.Frame{Data: sfu.VP8KeyFrame8x8, PTS: pts, Duration: time.Second / 30, Recovery: true}))
				}
			}
			await := func(input *EncodedSource, first, second uint32) {
				for received[0].Load() < first || simulcast && received[1].Load() < second {
					write(input)
					select {
					case <-time.After(time.Second / 30):
					case <-ctx.Done():
						t.Fatalf("retarget media stalled: first=%d second=%d", received[0].Load(), received[1].Load())
					}
				}
			}
			await(old, 3, 3)
			for _, rejected := range []*Source{nil, closed.Source, foreign.Source} {
				if replace(rejected) == nil || current() != old.Source {
					t.Fatal("invalid replacement changed the active source")
				}
			}
			oldSenders := old.GetDownTracks()
			first, second := received[0].Load(), received[1].Load()
			beforePLI := keyframes.Load()
			write(next)
			check(replace(next.Source))
			if current() != next.Source || len(old.GetDownTracks()) != 0 || len(next.GetDownTracks()) != len(oldSenders) {
				t.Fatal("receiver membership did not move once")
			}
			for _, stale := range oldSenders {
				if stale.WriteRTP(nil, 0) != 0 {
					t.Fatal("detached source forwarded a late packet")
				}
				stale.Close()
				stale.ReceiverRestart(old.Source)
				check(stale.HandleRTCPSenderReportData(codec.PayloadType, 0, nil))
				stale.UpTrackMaxPublishedLayerChange(-1)
				stale.UpTrackMaxTemporalLayerSeenChange(-1)
			}
			old.Close()
			await(next, first+6, second+6)
			if pc.ConnectionState() != webrtc.PeerConnectionStateConnected || badTimeline.Load() || keyframes.Load() <= beforePLI {
				t.Fatalf("retarget lost connection, timeline or recovery: state=%v timeline=%v PLI=%d->%d", pc.ConnectionState(), badTimeline.Load(), beforePLI, keyframes.Load())
			}
			if transport != nil && (transport.PC != pc || transport.Output.State().Current < 0 || transport.Egress().Packets == 0) {
				t.Fatal("retarget bypassed the output wrapper or counters")
			}
			if publication != nil {
				counters := publication.Counters()
				if publication.PC != pc || counters.Frames[0] < 6 || counters.Frames[1] < 6 {
					t.Fatal("retarget lost per-RID forwarding or counters")
				}
			}
			queued := next.GetDownTracks()
			var snapshots [2]*livekit.RTCPSenderReportState
			for layer := range snapshots {
				snapshots[layer] = next.GetAllBuffers()[layer].GetSenderReportData()
			}
			blocked := &heldSourceClose{BufferProvider: next.GetAllBuffers()[0],
				entered: make(chan struct{}), release: make(chan struct{})}
			next.ReceiverBase.AddBuffer(blocked, 0)
			var release sync.Once
			unblock := func() { release.Do(func() { close(blocked.release) }) }
			defer unblock()
			retired := make(chan struct{})
			go func() { next.Close(); close(retired) }()
			select {
			case <-blocked.entered:
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			// ClearAllBuffers runs before DownTrack retirement. A queued SR still
			// has the same receiver, but its current clock has already disappeared.
			for _, sender := range queued {
				for layer, snapshot := range snapshots {
					check(sender.HandleRTCPSenderReportData(codec.PayloadType, int32(layer), snapshot))
				}
			}
			unblock()
			select {
			case <-retired:
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			check(closeTransport())
			if len(next.GetDownTracks()) != 0 || replace(old.Source) == nil {
				t.Fatal("retarget retained membership after closure")
			}
		})
	}
}
