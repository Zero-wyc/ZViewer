package forwarding

import (
	"errors"
	"testing"

	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/rtcerr"
)

func TestCandidateContentErrorsRemainSeparateFromConnectionLifecycle(t *testing.T) {
	connection, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = connection.Close() })
	invalid := webrtc.ICECandidateInit{Candidate: "malformed"}
	var invalidState *rtcerr.InvalidStateError
	if err := AddICECandidate(connection, invalid); !errors.As(err, &invalidState) {
		t.Fatalf("missing description lost its lifecycle error: %v", err)
	}
	remote, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = remote.Close() })
	if _, err = remote.AddTransceiverFromKind(webrtc.RTPCodecTypeVideo); err != nil {
		t.Fatal(err)
	}
	offer, err := remote.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = connection.SetRemoteDescription(offer); err != nil {
		t.Fatal(err)
	}
	const valid = "candidate:probe 1 udp 2122260223 127.0.0.1 49152 typ host"
	fragment := "not a token"
	for _, candidate := range []webrtc.ICECandidateInit{
		invalid,
		{Candidate: "malformed", UsernameFragment: new("current")},
		{Candidate: valid, UsernameFragment: &fragment},
	} {
		var operation *rtcerr.OperationError
		if err := AddICECandidate(connection, candidate); !errors.As(err, &operation) {
			t.Fatalf("candidate content did not retain a disposable operation error: %v", err)
		}
	}
	// Invalid input cannot poison a later valid candidate or gathering completion.
	for _, candidate := range []webrtc.ICECandidateInit{{Candidate: valid}, {}} {
		if err := AddICECandidate(connection, candidate); err != nil {
			t.Fatalf("valid candidate following rejection: %v", err)
		}
	}
	if err := connection.Close(); err != nil {
		t.Fatal(err)
	}
	var operation *rtcerr.OperationError
	if err := AddICECandidate(connection, webrtc.ICECandidateInit{Candidate: valid}); err == nil || errors.As(err, &operation) {
		t.Fatalf("closed transport was classified as disposable content: %v", err)
	}
}
