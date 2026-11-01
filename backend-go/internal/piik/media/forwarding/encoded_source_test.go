package forwarding

import (
	"math"
	"testing"
	"time"

	"github.com/livekit/livekit-server/pkg/sfu"
	"github.com/pion/webrtc/v4"
	"google.golang.org/protobuf/proto"
	"zviewer/backend/internal/piik/media/encoded"
)

func TestCodecBudgetUsesActualSourceFraming(t *testing.T) {
	codec := webrtc.RTPCodecParameters{RTPCodecCapability: webrtc.RTPCodecCapability{
		MimeType: webrtc.MimeTypeVP8, ClockRate: 90_000,
	}, PayloadType: 96}
	input, err := NewEncodedSource(SourceOptions{ID: "framing", StreamID: "framing", Codec: codec,
		Formats: []LayerFormat{{Width: 8, Height: 8, Bitrate: 100_000}, {Width: 16, Height: 16, Bitrate: 1_000_000}}})
	if err != nil {
		t.Fatal(err)
	}
	defer input.Close()
	if input.CodecBudget(0, 120_000) != 120_000 {
		t.Fatal("cold source invented packet overhead")
	}
	period := time.Second / 30
	ticker := time.NewTicker(period)
	defer ticker.Stop()
	deadline := time.NewTimer(6 * time.Second)
	defer deadline.Stop()
	var rates sfu.Bitrates
	for frame := 0; rates[0][0] == 0 || rates[1][0] == 0; frame++ {
		select {
		case <-ticker.C:
		case <-deadline.C:
			t.Fatal("existing screen-share measurement window produced no bitrate")
		}
		pts := time.Duration(frame) * period
		if err = input.BeginFrame(pts, time.Now()); err != nil {
			t.Fatal(err)
		}
		for layer, size := range []int{80, 4000} {
			data := make([]byte, size)
			copy(data, sfu.VP8KeyFrame8x8)
			if err = input.WriteFrame(layer, encoded.Frame{Data: data, PTS: pts, Duration: period, Recovery: true}); err != nil {
				t.Fatal(err)
			}
		}
		_, rates = input.GetLayeredBitrate()
	}
	for layer := range input.rtpBytes {
		if input.rtpBytes[layer]-input.codecBytes[layer] <= uint64(input.packets[layer])*12 {
			t.Fatal("codec descriptors were omitted from framing cost")
		}
		overhead := int64(math.Ceil(float64(rates[layer][0]) * float64(input.rtpBytes[layer]-input.codecBytes[layer]) / float64(input.rtpBytes[layer])))
		if got := input.CodecBudget(layer, 120_000); got != max(120_000-overhead, 0) || got >= 120_000 {
			t.Fatalf("layer %d codec budget=%d overhead=%d", layer, got, overhead)
		}
	}
	input.codecBytes[0] = input.rtpBytes[0] + 1 // Annex-B delimiters can be removed by packetization.
	if input.CodecBudget(0, 120_000) != 120_000 {
		t.Fatal("removed codec framing increased the supplied budget")
	}
	input.BeginGeneration()
	if input.CodecBudget(1, 120_000) != 120_000 || input.codecBytes[1] != 0 || input.rtpBytes[1] != 0 {
		t.Fatal("replacement source inherited stale framing ratios")
	}
}

func TestEncodedSourceH264MetadataPreservesCorrelation(t *testing.T) {
	input, err := NewEncodedSource(SourceOptions{ID: "h264-metadata", StreamID: "h264-metadata",
		Codec: webrtc.RTPCodecParameters{RTPCodecCapability: webrtc.RTPCodecCapability{
			MimeType: webrtc.MimeTypeH264, ClockRate: 90_000,
			SDPFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42c01f",
		}, PayloadType: 96}, Formats: []LayerFormat{{Width: 2, Height: 2, Bitrate: 100_000}}})
	if err != nil {
		t.Fatal(err)
	}
	defer input.Close()
	const period = 40 * time.Millisecond
	origin := time.Now()
	write := func(index int, data []byte) {
		t.Helper()
		pts := time.Duration(index) * period
		if err := input.BeginFrame(pts, origin.Add(pts)); err != nil {
			t.Fatal(err)
		}
		if err := input.WriteFrame(0, encoded.Frame{Data: data, PTS: pts, Duration: period, Recovery: index == 0}); err != nil {
			t.Fatal(err)
		}
	}
	var keyframe []byte
	for _, nalu := range sfu.H264KeyFrame2x2 {
		keyframe = append(keyframe, 0, 0, 0, 1)
		keyframe = append(keyframe, nalu...)
	}
	write(0, keyframe)
	buffer := input.GetAllBuffers()[0]
	first := buffer.GetSenderReportData()
	if first == nil || input.packets[0] == 0 {
		t.Fatal("first IDR did not establish RTP correlation")
	}
	correlation := proto.Clone(first)
	packets, octets, rtpBytes, codecBytes := input.packets[0], input.octets[0], input.rtpBytes[0], input.codecBytes[0]
	for index, metadata := range [][]byte{
		sfu.H264KeyFrame2x2SPS, sfu.H264KeyFrame2x2PPS,
		{0x09, 0xf0}, {0x0c, 0xff, 0x80}, // AUD and filler produce no RTP.
	} {
		write(index+1, metadata)
		codecBytes += uint64(len(metadata))
		if input.packets[0] != packets || input.octets[0] != octets || input.rtpBytes[0] != rtpBytes {
			t.Fatal("metadata invented RTP packets or cost")
		}
		if input.codecBytes[0] != codecBytes || !proto.Equal(correlation, buffer.GetSenderReportData()) {
			t.Fatal("accepted metadata lost codec bytes or advanced RTP correlation")
		}
	}
	write(5, sfu.H264KeyFrame2x2IDR)
	last := buffer.GetSenderReportData()
	if input.packets[0] != packets+2 || last.RtpTimestamp-first.RtpTimestamp != 18_000 {
		t.Fatal("cached SPS/PPS and the next IDR lost their source RTP timeline")
	}
	if captured, ok := input.ReferenceTime(0, last.RtpTimestamp); !ok || captured.Sub(origin.Add(5*period)).Abs() > time.Microsecond {
		t.Fatal("next IDR correlation used metadata or arrival time")
	}
	packets = input.packets[0]
	write(6, []byte{0x06, 0x05, 0x00, 0x80}) // SEI remains a normal RTP payload.
	if input.packets[0] != packets+1 {
		t.Fatal("SEI was incorrectly treated as packetless metadata")
	}
}

func TestEncodedSourceGenerationStartsEachLayerWithRecovery(t *testing.T) {
	input, err := NewEncodedSource(clockSourceOptions("generation-recovery"))
	if err != nil {
		t.Fatal(err)
	}
	defer input.Close()
	check := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	delta := append([]byte(nil), sfu.VP8KeyFrame8x8...)
	delta[0] |= 1
	const period = 40 * time.Millisecond
	origin := time.Now()
	for generation := range 2 {
		if generation != 0 {
			input.BeginGeneration()
		}
		at := origin.Add(time.Duration(generation) * 5 * time.Second)
		packets := append([]uint32(nil), input.packets...)
		reports := []proto.Message{input.GetAllBuffers()[0].GetSenderReportData(), input.GetAllBuffers()[1].GetSenderReportData()}
		write := func(layer int, pts time.Duration, recovery bool) {
			t.Helper()
			data := delta
			if recovery {
				data = sfu.VP8KeyFrame8x8
			}
			check(input.WriteFrame(layer, encoded.Frame{Data: data, PTS: pts, Duration: period, Recovery: recovery}))
		}
		check(input.BeginFrame(0, at))
		for layer := range 2 {
			write(layer, 0, false)
			if input.packets[layer] != packets[layer] || input.rtpBytes[layer] != 0 || input.codecBytes[layer] != 0 ||
				!proto.Equal(reports[layer], input.GetAllBuffers()[layer].GetSenderReportData()) {
				t.Fatal("delta crossed a fresh generation or advanced its clock/cost", generation, layer)
			}
		}
		check(input.BeginFrame(period, at.Add(period)))
		write(0, period, true)
		write(1, period, false)
		if input.packets[0] != packets[0]+1 || input.packets[1] != packets[1] {
			t.Fatal("one layer's recovery admitted another layer's delta")
		}
		check(input.BeginFrame(2*period, at.Add(2*period)))
		write(0, 2*period, false)
		write(1, 2*period, true)
		if input.packets[0] != packets[0]+2 || input.packets[1] != packets[1]+1 {
			t.Fatal("recovered layer did not resume normal frames")
		}
		for layer := range 2 {
			report := input.GetAllBuffers()[layer].GetSenderReportData()
			captured, ok := input.ReferenceTime(layer, report.RtpTimestamp)
			if !ok || captured.Sub(at.Add(2*period)).Abs() > time.Microsecond {
				t.Fatal("recovery changed the source clock")
			}
		}
	}
}
