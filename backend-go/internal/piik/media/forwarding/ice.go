package forwarding

import (
	"errors"
	"strings"

	"github.com/pion/ice/v4"
	"github.com/pion/transport/v5"
	"github.com/pion/transport/v5/stdnet"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/rtcerr"
)

// AddICECandidate preserves the standard JSON generation at Pion's boundary.
// Pion checks the SDP-line ufrag extension, but ignores UsernameFragment itself.
func AddICECandidate(connection *webrtc.PeerConnection, candidate webrtc.ICECandidateInit) error {
	// Keep Pion's missing-description and end-of-gathering lifecycle handling.
	if connection.RemoteDescription() == nil || candidate.Candidate == "" {
		return connection.AddICECandidate(candidate)
	}
	parsed, err := ice.UnmarshalCandidate(strings.TrimPrefix(candidate.Candidate, "candidate:"))
	if err != nil {
		if errors.Is(err, ice.ErrUnknownCandidateTyp) || errors.Is(err, ice.ErrDetermineNetworkType) {
			return connection.AddICECandidate(candidate)
		}
		return &rtcerr.OperationError{Err: err}
	}
	if candidate.UsernameFragment != nil {
		fragment := *candidate.UsernameFragment
		if fields := strings.Fields(fragment); len(fields) != 1 || fields[0] != fragment {
			return &rtcerr.OperationError{Err: errors.New("ICE username fragment is not an SDP token")}
		}
		if err = parsed.AddExtension(ice.CandidateExtension{Key: "ufrag", Value: fragment}); err != nil {
			return &rtcerr.OperationError{Err: err}
		}
		candidate.Candidate = "candidate:" + parsed.Marshal()
	}
	return connection.AddICECandidate(candidate)
}

// NewUDPMux retains Pion's socket and candidate policy, but reads current local
// addresses at each gathering. Its default stdnet snapshot otherwise survives
// ICE restart (and every new SFU connection sharing that mux).
func NewUDPMux(params ice.UDPMuxParams) *ice.UDPMuxDefault {
	if params.Net == nil {
		params.Net = &muxNetwork{}
	}
	return ice.NewUDPMuxDefault(params)
}

// UDPMux uses Net only to enumerate interfaces. Take a fresh, private snapshot
// per read instead of mutating a shared stdnet.Net during concurrent gatherings.
type muxNetwork struct{ stdnet.Net }

func (*muxNetwork) Interfaces() ([]*transport.Interface, error) {
	network, err := stdnet.NewNet()
	if err != nil {
		return nil, err
	}
	return network.Interfaces()
}
