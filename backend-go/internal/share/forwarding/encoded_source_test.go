package forwarding

import (
	"math"
	"testing"
	"time"

	"github.com/livekit/livekit-server/pkg/sfu"
	"github.com/pion/webrtc/v4"
	"zviewer/backend/internal/share/encoded"
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
			if err = input.WriteFrame(layer, encoded.Frame{Data: data, PTS: pts, Duration: period}); err != nil {
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
