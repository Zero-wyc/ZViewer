package forwarding

import (
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/livekit/livekit-server/pkg/sfu"
	"github.com/livekit/mediatransportutil"
	"github.com/livekit/protocol/livekit"
	"github.com/livekit/protocol/utils/mono"
	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

type subscribingSourceTrack struct {
	*Output
	publish func()
	spatial atomic.Int32
}

func (track *subscribingSourceTrack) UpTrackMaxPublishedLayerChange(layer int32) {
	if layer < 0 {
		track.publish()
	}
	track.Output.UpTrackMaxPublishedLayerChange(layer)
	track.spatial.Store(layer)
}

type observedSourceLayers struct {
	sfu.StreamTrackerManagerListener
	published chan struct{}
}

func (observer *observedSourceLayers) OnMaxPublishedLayerChanged(layer int32) {
	observer.StreamTrackerManagerListener.OnMaxPublishedLayerChanged(layer)
	observer.published <- struct{}{}
}

func TestSourceSubscriptionRetainsConcurrentLayerDiscovery(t *testing.T) {
	source, err := NewSource(SourceOptions{ID: "screen", StreamID: "subscription",
		Codec: webrtc.RTPCodecParameters{RTPCodecCapability: webrtc.RTPCodecCapability{
			MimeType: webrtc.MimeTypeVP8, ClockRate: 90_000,
		}, PayloadType: 96},
		Formats: []LayerFormat{{Width: 8, Height: 8, Bitrate: 300_000}},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(source.Close)
	transport, err := NewTransport(TransportOptions{Source: source, ConnectionID: "joining", InitialBitrate: 1_000_000})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = transport.Close() })
	observed := &observedSourceLayers{StreamTrackerManagerListener: source.ReceiverBase, published: make(chan struct{}, 1)}
	source.StreamTrackerManager().SetListener(observed)
	track := &subscribingSourceTrack{Output: transport.Output}
	track.publish = func() {
		// Discover a layer after reading the initial snapshot but before the
		// subscriber is registered. Complete its real notification in that gap.
		source.StreamTrackerManager().AddTracker(0)
		select {
		case <-observed.published:
		case <-time.After(time.Second):
			t.Fatal("source did not publish its discovered layer")
		}
	}
	if err = source.AddDownTrack(track); err != nil {
		t.Fatal(err)
	}
	if track.spatial.Load() != source.StreamTrackerManager().GetMaxPublishedLayer() {
		t.Fatalf("subscriber retained the pre-discovery snapshot: %d", track.spatial.Load())
	}
}

func TestSourceLayerBindingFeedbackAndClose(t *testing.T) {
	codec := webrtc.RTPCodecParameters{RTPCodecCapability: webrtc.RTPCodecCapability{
		MimeType: webrtc.MimeTypeVP8, ClockRate: 90_000,
		RTCPFeedback: []webrtc.RTCPFeedback{{Type: "nack", Parameter: "pli"}},
	}, PayloadType: 96}
	var source *Source
	feedbackLayer := -1
	var err error
	source, err = NewSource(SourceOptions{
		ID: "source", StreamID: "screen", Codec: codec,
		Formats: []LayerFormat{{}, {Width: 640, Height: 360, Bitrate: 1_200_000}},
		HeaderExtensions: []webrtc.RTPHeaderExtensionParameter{
			{ID: 1, URI: "urn:ietf:params:rtp-hdrext:sdes:mid"},
			{ID: 2, URI: "urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id"},
		},
		OnRTCP: func(layer int, packets []rtcp.Packet) {
			for _, packet := range packets {
				if _, ok := packet.(*rtcp.PictureLossIndication); ok {
					feedbackLayer = layer
					source.Close()
				}
			}
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(source.Close)
	source.SetLowestLayerRateControlled(true)
	if !source.RateControlled(0) || source.RateControlled(1) {
		t.Fatal("local codec ownership escaped its lowest output")
	}
	if info := source.TrackInfo(); info.Layers[0].Bitrate != 0 || info.Layers[0].Width != 0 {
		t.Fatal("unknown received metadata was replaced by a guessed value")
	}
	parameters := webrtc.RTPParameters{Codecs: []webrtc.RTPCodecParameters{codec},
		HeaderExtensions: []webrtc.RTPHeaderExtensionParameter{
			{ID: 2, URI: "urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id"},
			{ID: 1, URI: "urn:ietf:params:rtp-hdrext:sdes:mid"},
		}}
	if source.BindLayer(2, 1000, parameters) == nil || source.BindLayer(0, 1000, webrtc.RTPParameters{}) == nil {
		t.Fatal("invalid layer or codec parameters were accepted")
	}
	if err = source.BindLayer(0, 1000, parameters); err != nil {
		t.Fatal(err)
	}
	if !errors.Is(source.BindLayer(0, 1001, parameters), sfu.ErrDuplicateLayer) ||
		source.BindLayer(1, 1000, parameters) == nil {
		t.Fatal("duplicate source identity was accepted")
	}
	if err = source.BindLayer(1, 1001, parameters); err != nil {
		t.Fatal(err)
	}
	initialBuffer := source.GetAllBuffers()[0]
	if source.UpdateFormats([]LayerFormat{{Width: 320, Height: 180, Bitrate: 300_000}}) == nil {
		t.Fatal("live metadata changed the fixed layer count")
	}
	if err = source.UpdateFormats([]LayerFormat{
		{Width: 320, Height: 180, Bitrate: 300_000},
		{Width: 1280, Height: 720, Bitrate: 3_000_000},
	}); err != nil {
		t.Fatal(err)
	}
	if info := source.TrackInfo(); info.Width != 1280 || info.Layers[0].Bitrate != 300_000 ||
		source.GetAllBuffers()[0] != initialBuffer || source.Codec().PayloadType != codec.PayloadType {
		t.Fatal("live metadata did not preserve source buffer and codec ownership")
	}
	packet := &rtp.Packet{Header: rtp.Header{
		Version: 2, SSRC: 1000, PayloadType: 96, SequenceNumber: 100, Timestamp: 9000, Marker: true,
	}, Payload: []byte{0x10, 0, 0, 0, 0x9d, 0x01, 0x2a, 0xa0, 0, 0x5a, 0}}
	if source.WriteRTP(1, packet) == nil {
		t.Fatal("RTP crossed its layer identity")
	}
	if err = source.WriteRTP(0, packet); err != nil {
		t.Fatal(err)
	}
	report := &rtcp.SenderReport{SSRC: 1000, RTPTime: 9000,
		NTPTime: uint64(mediatransportutil.ToNtpTime(time.Now())), PacketCount: 1, OctetCount: 11}
	if err = source.SenderReport(0, report); err != nil {
		t.Fatal(err)
	}
	input := source.GetAllBuffers()[0]
	if stored := input.GetSenderReportData(); stored == nil || stored.NtpTimestamp != report.NTPTime || stored.RtpTimestamp != 9000 {
		t.Fatalf("original sender clock was changed: %+v", stored)
	}
	if err = source.SetCorrelation(0, &livekit.RTCPSenderReportState{
		RtpTimestamp: 99000, NtpTimestamp: report.NTPTime + 1<<32,
		Packets: 2, Octets: 22, At: mono.UnixNano(),
	}); err != nil {
		t.Fatal(err)
	}
	source.SendPLI(0, true)
	if feedbackLayer != 0 || !source.IsClosed() || !errors.Is(source.WriteRTP(0, packet), sfu.ErrReceiverClosed) {
		t.Fatal("feedback could not retire its source without retaining stale writes")
	}
	if source.RateControlled(0) {
		t.Fatal("closed source retained local codec ownership")
	}
	if err = source.BindLayer(0, 2000, parameters); !errors.Is(err, sfu.ErrReceiverClosed) {
		t.Fatal("closed source accepted another layer")
	}
	if err = source.UpdateFormats([]LayerFormat{{}, {}}); !errors.Is(err, sfu.ErrReceiverClosed) {
		t.Fatal("closed source accepted new metadata")
	}
}
