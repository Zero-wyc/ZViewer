package forwarding

import (
	"strings"
	"testing"
)

func TestSharedAudioRejectsOnlyAnInsufficientReceiver(t *testing.T) {
	for _, test := range []struct {
		parameter string
		allowed   bool
	}{
		{"stereo=1", false},
		{"stereo=1;maxaveragebitrate=510000", true},
		{"stereo=1;maxaveragebitrate=192000", false},
		{"maxaveragebitrate=320000", false},
		{"maxaveragebitrate=invalid", false},
		{"maxaveragebitrate=510001", false},
		{"maxaveragebitrate=510000;maxaveragebitrate=510001", true},
		{"maxaveragebitrate=510000;maxaveragebitrate=96000", false},
	} {
		t.Run(test.parameter, func(t *testing.T) {
			answer := "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n" +
				"m=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\na=fmtp:111 " + test.parameter + "\r\n"
			if err := CheckAudioReceiveLimit(answer, 510_000); (err == nil) != test.allowed {
				t.Fatalf("receiver admitted=%v, err=%v", test.allowed, err)
			}
			// Rejected or unrelated media cannot impose an audio limit.
			if err := CheckAudioReceiveLimit(strings.Replace(answer, "m=audio 9", "m=audio 0", 1), 510_000); err != nil {
				t.Fatal(err)
			}
		})
	}
}
