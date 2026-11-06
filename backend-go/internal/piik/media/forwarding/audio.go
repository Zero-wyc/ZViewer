package forwarding

import (
	"errors"
	"strconv"
	"strings"

	"github.com/pion/sdp/v3"
)

// CheckAudioReceiveLimit admits unchanged Opus forwarding. A receiver may not
// lower the shared source or its siblings. Piik receivers declare the full Opus
// range; an omitted preference uses codec defaults, not an unrestricted rate.
func CheckAudioReceiveLimit(description string, sourceCeiling int) error {
	var session sdp.SessionDescription
	if err := session.Unmarshal([]byte(description)); err != nil {
		return err
	}
	for _, media := range session.MediaDescriptions {
		if media.MediaName.Media != "audio" || media.MediaName.Port.Value == 0 {
			continue
		}
		for _, format := range media.MediaName.Formats {
			payload, err := strconv.ParseUint(format, 10, 8)
			if err != nil {
				continue
			}
			codec, err := session.GetCodecForPayloadType(uint8(payload))
			if err != nil || !strings.EqualFold(codec.Name, "opus") {
				continue
			}
			receiveLimit := 0
			for _, parameter := range strings.Split(codec.Fmtp, ";") {
				name, value, found := strings.Cut(parameter, "=")
				if !strings.EqualFold(strings.TrimSpace(name), "maxaveragebitrate") {
					continue
				}
				limit, err := strconv.Atoi(strings.TrimSpace(value))
				if !found || err != nil || limit < 6_000 || limit > 510_000 {
					continue // RFC 7587: ignore invalid preferences.
				}
				if receiveLimit == 0 || limit < receiveLimit {
					receiveLimit = limit
				}
			}
			if receiveLimit < sourceCeiling {
				return errors.New("receiver audio bitrate limit cannot carry the shared Opus source")
			}
		}
	}
	return nil
}
