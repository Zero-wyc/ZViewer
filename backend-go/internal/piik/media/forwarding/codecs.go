package forwarding

import (
	"strconv"
	"strings"

	"github.com/pion/interceptor"
	"github.com/pion/interceptor/pkg/nack"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

// RegisterIngressInterceptors leaves video NACK generation to the forwarding
// buffer, which sees primary sequence numbers after RTX repair. Pion's wire
// reader cannot observe those repairs; its reports, TWCC and responder remain.
func RegisterIngressInterceptors(media *webrtc.MediaEngine, registry *interceptor.Registry) error {
	return webrtc.RegisterDefaultInterceptorsWithOptions(media, registry,
		webrtc.WithNackGeneratorOptions(nack.GeneratorStreamsFilter(func(info *interceptor.StreamInfo) bool {
			if strings.HasPrefix(strings.ToLower(info.MimeType), "video/") {
				return false
			}
			for _, feedback := range info.RTCPFeedback {
				if feedback.Type == "nack" && feedback.Parameter == "" {
					return true
				}
			}
			return false
		})))
}

// Each outgoing connection offers one primary video codec and Opus (111).
// RTX keeps late repair outside the primary stream's SRTP replay window.
func registerVideoCodec(media *webrtc.MediaEngine, codec webrtc.RTPCodecParameters) error {
	if err := media.RegisterCodec(codec, webrtc.RTPCodecTypeVideo); err != nil {
		return err
	}
	repairPayload := webrtc.PayloadType(96)
	if repairPayload == codec.PayloadType {
		repairPayload++
	}
	return media.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeRTX,
			ClockRate: codec.ClockRate, SDPFmtpLine: "apt=" + strconv.Itoa(int(codec.PayloadType))},
		PayloadType: repairPayload,
	}, webrtc.RTPCodecTypeVideo)
}

// ReadRTP restores repaired packets to the admitted primary track. Pion can
// queue RTX before RID admission initializes SSRC or the first primary read
// initializes PayloadType. Ordinary packets retain their wire identity checks.
func ReadRTP(track *webrtc.TrackRemote) (*rtp.Packet, interceptor.Attributes, error) {
	packet, attributes, err := track.ReadRTP()
	if err == nil && attributes.Get(webrtc.AttributeRtxPayloadType) != nil {
		packet.PayloadType = uint8(track.Codec().PayloadType)
		packet.SSRC = uint32(track.SSRC())
	}
	return packet, attributes, err
}

// WithRTX restricts a negotiated offer to one primary codec and its associated
// repair stream. Selecting a media codec must not discard packet-loss recovery.
func WithRTX(primary webrtc.RTPCodecParameters, negotiated []webrtc.RTPCodecParameters) []webrtc.RTPCodecParameters {
	selected := []webrtc.RTPCodecParameters{primary}
	for _, repair := range negotiated {
		if !strings.EqualFold(repair.MimeType, webrtc.MimeTypeRTX) {
			continue
		}
		for _, field := range strings.Split(repair.SDPFmtpLine, ";") {
			key, value, _ := strings.Cut(strings.TrimSpace(field), "=")
			if key == "apt" && strings.TrimSpace(value) == strconv.Itoa(int(primary.PayloadType)) {
				selected = append(selected, repair)
				break
			}
		}
	}
	return selected
}
