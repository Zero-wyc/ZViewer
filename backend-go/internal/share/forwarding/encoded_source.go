package forwarding

import (
	"errors"
	"math"
	"time"

	"github.com/livekit/mediatransportutil"
	"github.com/livekit/protocol/livekit"
	"github.com/livekit/protocol/utils/mono"
	"github.com/pion/rtp"
	"github.com/pion/rtp/codecs"
	"github.com/pion/webrtc/v4"
	"zviewer/backend/internal/share/encoded"
)

// EncodedSource feeds complete codec outputs into the same forwarding buffers
// used for received RTP. Its capture/decoder owner serializes calls and fences
// replacement input; no network, capture or wall-clock scheduler lives here.
type EncodedSource struct {
	*Source
	packetizers []*encoded.Packetizer
	packets     []uint32
	octets      []uint64
	codecBytes  []uint64
	rtpBytes    []uint64
	inputPTS    time.Duration
	anchorPTS   time.Duration
	anchorTime  time.Time
	originTime  time.Time
	hasInput    bool
	clockSource *Source
	clockLayer  int
}

func NewEncodedSource(options SourceOptions) (*EncodedSource, error) {
	source, err := NewSource(options)
	if err != nil {
		return nil, err
	}
	input := &EncodedSource{
		Source: source, packetizers: make([]*encoded.Packetizer, len(options.Formats)),
		packets: make([]uint32, len(options.Formats)), octets: make([]uint64, len(options.Formats)),
		codecBytes: make([]uint64, len(options.Formats)), rtpBytes: make([]uint64, len(options.Formats)),
	}
	for layer := range input.packetizers {
		var payloader rtp.Payloader = &codecs.H264Payloader{}
		if options.Codec.MimeType == webrtc.MimeTypeVP8 {
			payloader = &codecs.VP8Payloader{EnablePictureID: true}
		}
		input.packetizers[layer] = encoded.NewPacketizer(payloader, uint8(options.Codec.PayloadType), 1200)
		// These identities stay inside this source's private buffers. DownTrack
		// supplies the independently negotiated wire identity for every child.
		if err = source.BindLayer(layer, uint32(layer+1), webrtc.RTPParameters{
			Codecs: []webrtc.RTPCodecParameters{options.Codec}, HeaderExtensions: options.HeaderExtensions,
		}); err != nil {
			source.Close()
			return nil, err
		}
	}
	return input, nil
}

// UseSourceClock binds derived output to the original layer's current remote
// clock offset. The owner installs this before feeding any encoded frames.
func (input *EncodedSource) UseSourceClock(source *Source, layer int) {
	input.clockSource, input.clockLayer = source, layer
}

func (input *EncodedSource) BeginFrame(pts time.Duration, at time.Time) error {
	if input.IsClosed() {
		return errors.New("encoded forwarding source is closed")
	}
	if pts < 0 || at.IsZero() || input.hasInput && pts <= input.inputPTS {
		return encoded.ErrInvalidTimestamp
	}
	if !input.hasInput {
		input.anchorPTS, input.anchorTime = pts, at
	}
	if input.originTime.IsZero() {
		input.originTime = at
	}
	input.hasInput, input.inputPTS = true, pts
	return nil
}

func (input *EncodedSource) WriteFrame(layer int, frame encoded.Frame) error {
	if layer < 0 || layer >= len(input.packetizers) || !input.hasInput ||
		frame.PTS < input.anchorPTS || frame.PTS > input.inputPTS {
		return errors.New("encoded output has no matching source input")
	}
	sourceTime := input.anchorTime.Add(frame.PTS - input.anchorPTS)
	packets, err := input.packetizers[layer].Packetize(frame.Data, sourceTime.Sub(input.originTime), frame.Duration)
	if err != nil {
		return err
	}
	for _, packet := range packets {
		packet.SSRC = uint32(layer + 1)
		if err = input.Source.WriteRTP(layer, packet); err != nil {
			return err
		}
		input.packets[layer]++
		input.octets[layer] += uint64(len(packet.Payload))
		input.rtpBytes[layer] += uint64(packet.MarshalSize())
	}
	input.codecBytes[layer] += uint64(len(frame.Data))
	// Retain the capture instant's Go monotonic component when converting to
	// the media core's epoch-based monotonic clock, including after wall jumps.
	localTime := mono.FromTime(sourceTime)
	if input.clockSource != nil {
		var ok bool
		localTime, ok = input.clockSource.LocalTime(input.clockLayer, sourceTime)
		if !ok {
			return errors.New("encoded output has no source clock reference")
		}
	}
	// Correlate each layer with the actual input clock, not its encoder finish
	// time. This is internal correlation data, not a backdated wire sender report.
	return input.SetCorrelation(layer, &livekit.RTCPSenderReportState{
		RtpTimestamp: packets[0].Timestamp,
		NtpTimestamp: uint64(mediatransportutil.ToNtpTime(sourceTime)),
		Packets:      input.packets[layer], Octets: input.octets[layer], At: localTime.UnixNano(),
	})
}

// CodecBudget converts source-RTP allocation units to encoder AU-payload units.
// Actual packetization includes codec descriptors; bitrate comes from the
// existing tracker window so dormant time does not dilute the overhead rate.
// Downstream extensions and SRTP/UDP overhead are outside this source measure.
func (input *EncodedSource) CodecBudget(layer int, rtpBudget int64) int64 {
	if layer < 0 || layer >= len(input.rtpBytes) || input.rtpBytes[layer] <= input.codecBytes[layer] {
		return max(rtpBudget, 0)
	}
	_, rates := input.GetLayeredBitrate()
	overhead := float64(rates[layer][0]) * float64(input.rtpBytes[layer]-input.codecBytes[layer]) / float64(input.rtpBytes[layer])
	return max(rtpBudget-int64(math.Ceil(overhead)), 0)
}

func (input *EncodedSource) BeginGeneration() {
	// Replacement resets input PTS, but all renditions retain the elapsed
	// capture clock and RTP identities, including time spent dormant.
	input.hasInput = false
	clear(input.codecBytes)
	clear(input.rtpBytes)
}
