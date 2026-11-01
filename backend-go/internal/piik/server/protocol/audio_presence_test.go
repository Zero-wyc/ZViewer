package protocol

import "testing"

func TestAudioPresenceWire(t *testing.T) {
	for _, raw := range []string{
		`{"type":"audio-presence","available":null}`,
		`{"type":"audio-presence","available":false}`,
		`{"type":"audio-presence","available":true}`,
	} {
		message, err := DecodeServerMessage([]byte(raw))
		if err != nil {
			t.Fatal(err)
		}
		encoded, err := EncodeServerMessage(message)
		if err != nil || string(encoded) != raw {
			t.Fatalf("round trip %s: %s, %v", raw, encoded, err)
		}
	}
	for _, raw := range []string{
		`{"type":"audio-presence"}`, `{"type":"audio-presence","available":"true"}`,
	} {
		if _, err := DecodeServerMessage([]byte(raw)); err == nil {
			t.Fatalf("accepted %s", raw)
		}
	}
	for _, raw := range []string{
		`{"type":"set-audio-presence","shareGeneration":"audio_share_generation","available":null}`,
		`{"type":"set-audio-presence","shareGeneration":"bad","available":true}`,
	} {
		if _, err := DecodeClientMessage([]byte(raw)); err == nil {
			t.Fatalf("accepted %s", raw)
		}
	}
}
