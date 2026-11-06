package protocol

import "testing"

func TestEndpointMediaCopyLimits(t *testing.T) {
	for _, sample := range []struct {
		capacity, steady, transition int
	}{{1, 1, 2}, {2, 2, 3}, {3, 3, 3}} {
		if got := EndpointMediaCopyLimit(sample.capacity, EndpointMediaCopySteady); got != sample.steady {
			t.Errorf("steady limit for %d = %d, want %d", sample.capacity, got, sample.steady)
		}
		if got := EndpointMediaCopyLimit(sample.capacity, EndpointMediaCopyTransition); got != sample.transition {
			t.Errorf("transition limit for %d = %d, want %d", sample.capacity, got, sample.transition)
		}
		if !EndpointMediaCopyCountFits(sample.transition, sample.capacity, EndpointMediaCopyTransition) {
			t.Errorf("%d copies must fit capacity %d in transition", sample.transition, sample.capacity)
		}
		if EndpointMediaCopyCountFits(sample.transition+1, sample.capacity, EndpointMediaCopyTransition) {
			t.Errorf("%d copies must not fit capacity %d in transition",
				sample.transition+1, sample.capacity)
		}
	}
}

func TestEndpointMediaCopyCapacityGuards(t *testing.T) {
	for _, capacity := range []int{0, 4, -1} {
		if err := AssertEndpointMediaCopyCapacity(capacity); err == nil {
			t.Errorf("capacity %d must be rejected", capacity)
		}
	}
	// An unavailable runtime capacity returns false instead of throwing.
	if EndpointMediaCopyCountFits(0, 0, EndpointMediaCopySteady) {
		t.Error("a zero capacity must never fit")
	}
}

// Ported from tests/nat-candidate.test.ts.
func TestNatCandidateDiagnostics(t *testing.T) {
	for _, sample := range []struct {
		candidate string
		want      CandidateSignalOrigin
	}{
		{"", CandidateOriginEnd},
		{" ", CandidateOriginEnd},
		{"candidate:sp2 1 udp 1 203.0.113.1 50000 typ srflx", CandidateOriginPredicted},
		{"candidate:base 1 udp 1 203.0.113.1 50000 typ srflx", CandidateOriginOrdinary},
	} {
		if got := CandidateSignalOriginOf(sample.candidate); got != sample.want {
			t.Errorf("CandidateSignalOriginOf(%q) = %q, want %q",
				sample.candidate, got, sample.want)
		}
	}
}

// Ported from tests/packet-loss.test.ts ("keeps receive-side delta validation").
func TestPacketLossPercentFromDeltas(t *testing.T) {
	number := func(value float64) *float64 { return &value }
	for _, sample := range []struct {
		name           string
		received, lost *float64
		want           float64
		ok             bool
	}{
		{"ninety received and ten lost", number(90), number(10), 10, true},
		{"no packets at all", number(0), number(0), 0, false},
		{"missing received delta", nil, number(1), 0, false},
		{"negative lost delta", number(10), number(-1), 0, false},
	} {
		t.Run(sample.name, func(t *testing.T) {
			got, ok := PacketLossPercentFromDeltas(sample.received, sample.lost)
			if ok != sample.ok || (ok && got != sample.want) {
				t.Fatalf("PacketLossPercentFromDeltas = (%v, %v), want (%v, %v)",
					got, ok, sample.want, sample.ok)
			}
		})
	}
}

// Ported from the codec cases in tests/protocol.test.ts.
func TestIsCanonicalVideoCodecEvidence(t *testing.T) {
	for _, sample := range []struct {
		codec, profile, parameters string
		want                       bool
	}{
		{"video/H264", "profile-level-id=42e01f",
			"packetization-mode=1; level-asymmetry-allowed=1", true},
		{"video/VP8", "", "max-fr=60; max-fs=8160", true},
		{"video/VP9", "profile-id=2", "max-fs=8160", true},
		{"video/AV1", "profile=1", "level-idx=31; tier=0", true},
		{"video/unknown", "", "", true},
		{"", "", "", true},
		{"video/unknown", "profile=1", "", false},
		{"video/H264", "device-id=deadbeef", "", false},
		{"video/H264", "", "sprop-parameter-sets=deadbeef", false},
		// Order is part of the canonical form.
		{"video/H264", "", "level-asymmetry-allowed=1; packetization-mode=1", false},
		// A duplicate key exceeds the ordered key budget.
		{"video/VP8", "", "max-fr=60; max-fr=60", false},
		{"video/AV1", "profile=3", "", false},
	} {
		t.Run(sample.codec+"|"+sample.profile+"|"+sample.parameters, func(t *testing.T) {
			got := IsCanonicalVideoCodecEvidence(sample.codec, sample.profile, sample.parameters)
			if got != sample.want {
				t.Fatalf("IsCanonicalVideoCodecEvidence = %v, want %v", got, sample.want)
			}
		})
	}
}
