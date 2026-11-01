package protocol

import (
	"errors"
	"regexp"
	"slices"
	"strings"
)

// ---------------------------------------------------------------------------
// src/shared/media-copy-accounting.ts
// ---------------------------------------------------------------------------

// EndpointMediaCopyPhase is EndpointMediaCopyPhase.
type EndpointMediaCopyPhase string

// Endpoint media copy phases.
const (
	EndpointMediaCopySteady     EndpointMediaCopyPhase = "steady"
	EndpointMediaCopyTransition EndpointMediaCopyPhase = "transition"
)

// ErrEndpointMediaCopyCapacity is the assertEndpointMediaCopyCapacity throw.
var ErrEndpointMediaCopyCapacity = errors.New(
	"Endpoint media copy capacity must be 1, 2, or 3")

// EndpointMediaCopyLimit panics on an invalid capacity, where TypeScript throws.
func EndpointMediaCopyLimit(capacity int, phase EndpointMediaCopyPhase) int {
	if err := AssertEndpointMediaCopyCapacity(capacity); err != nil {
		panic(err)
	}
	if phase == EndpointMediaCopySteady {
		return capacity
	}
	return min(capacity+1, MaxEndpointMediaCopyCapacity)
}

func EndpointMediaCopyCountFits(count, capacity int, phase EndpointMediaCopyPhase) bool {
	return count >= 0 &&
		IsEndpointMediaCopyCapacity(capacity) &&
		count <= EndpointMediaCopyLimit(capacity, phase)
}

// Go's int makes the fractional-value part of Number.isSafeInteger implicit.
func IsEndpointMediaCopyCapacity(capacity int) bool {
	return capacity >= 1 && capacity <= MaxEndpointMediaCopyCapacity
}

func AssertEndpointMediaCopyCapacity(capacity int) error {
	if !IsEndpointMediaCopyCapacity(capacity) {
		return ErrEndpointMediaCopyCapacity
	}
	return nil
}

// ---------------------------------------------------------------------------
// src/shared/nat-candidate.ts
// ---------------------------------------------------------------------------

// CandidateSignalOrigin is CandidateSignalOrigin.
type CandidateSignalOrigin string

// Candidate signal origins.
const (
	CandidateOriginEnd       CandidateSignalOrigin = "end"
	CandidateOriginOrdinary  CandidateSignalOrigin = "ordinary"
	CandidateOriginPredicted CandidateSignalOrigin = "predicted"
)

// The JavaScript \s class, spelled out because Go's \s is ASCII only.
var predictedCandidatePattern = regexp.MustCompile(
	`(?i)^candidate:s[pm][0-9]+[\t\n\v\f\r \x{00a0}\x{1680}\x{2000}-\x{200a}` +
		`\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]`)

// CandidateSignalOriginOf treats an empty string as TypeScript null (both yield "end").
func CandidateSignalOriginOf(candidate string) CandidateSignalOrigin {
	if strings.TrimFunc(candidate, IsJSWhitespace) == "" {
		return CandidateOriginEnd
	}
	if predictedCandidatePattern.MatchString(candidate) {
		return CandidateOriginPredicted
	}
	return CandidateOriginOrdinary
}

// ---------------------------------------------------------------------------
// src/shared/packet-loss.ts
// ---------------------------------------------------------------------------

// PacketLossPercentFromDeltas maps nil arguments to TypeScript null;
// ok is false where the shared calculation returns null.
func PacketLossPercentFromDeltas(packetsReceivedDelta, packetsLostDelta *float64) (float64, bool) {
	if packetsReceivedDelta == nil || packetsLostDelta == nil ||
		*packetsReceivedDelta < 0 || *packetsLostDelta < 0 {
		return 0, false
	}
	packetDelta := *packetsReceivedDelta + *packetsLostDelta
	if packetDelta <= 0 {
		return 0, false
	}
	return (*packetsLostDelta / packetDelta) * 100, true
}

// ---------------------------------------------------------------------------
// src/shared/video-codec-evidence.ts
// ---------------------------------------------------------------------------

type codecParameterRule struct {
	profileKey    string
	parameterKeys []string
	validators    map[string]*regexp.Regexp
}

var videoCodecParameterRules = map[string]codecParameterRule{
	"video/h264": {
		profileKey:    "profile-level-id",
		parameterKeys: []string{"packetization-mode", "level-asymmetry-allowed"},
		validators: map[string]*regexp.Regexp{
			"profile-level-id":        regexp.MustCompile(`^[0-9a-f]{6}$`),
			"packetization-mode":      regexp.MustCompile(`^[0-2]$`),
			"level-asymmetry-allowed": regexp.MustCompile(`^[01]$`),
		},
	},
	"video/vp9": {
		profileKey:    "profile-id",
		parameterKeys: []string{"max-fr", "max-fs"},
		validators: map[string]*regexp.Regexp{
			"profile-id": regexp.MustCompile(`^[0-3]$`),
			"max-fr":     regexp.MustCompile(`^[1-9][0-9]{0,9}$`),
			"max-fs":     regexp.MustCompile(`^[1-9][0-9]{0,9}$`),
		},
	},
	"video/vp8": {
		profileKey:    "",
		parameterKeys: []string{"max-fr", "max-fs"},
		validators: map[string]*regexp.Regexp{
			"max-fr": regexp.MustCompile(`^[1-9][0-9]{0,9}$`),
			"max-fs": regexp.MustCompile(`^[1-9][0-9]{0,9}$`),
		},
	},
	"video/av1": {
		profileKey:    "profile",
		parameterKeys: []string{"level-idx", "tier"},
		validators: map[string]*regexp.Regexp{
			"profile":   regexp.MustCompile(`^[0-2]$`),
			"level-idx": regexp.MustCompile(`^(?:[0-9]|[12][0-9]|3[01])$`),
			"tier":      regexp.MustCompile(`^[01]$`),
		},
	},
}

var videoMimeTypePattern = regexp.MustCompile(`(?i)^video/[A-Za-z0-9.+-]{1,32}$`)

// IsCanonicalVideoCodecEvidence uses empty strings for TypeScript nulls;
// the schema rejects an empty codec string before this refinement runs.
func IsCanonicalVideoCodecEvidence(codec, codecProfile, codecParameters string) bool {
	rule, ok := videoCodecParameterRules[strings.ToLower(codec)]
	if codec == "" || !ok {
		return codecProfile == "" && codecParameters == ""
	}
	profileKeys := []string{}
	if rule.profileKey != "" {
		profileKeys = append(profileKeys, rule.profileKey)
	}
	return canonicalValuesMatch(codecProfile, profileKeys, rule.validators) &&
		canonicalValuesMatch(codecParameters, rule.parameterKeys, rule.validators)
}

func canonicalValuesMatch(
	encoded string, orderedKeys []string, validators map[string]*regexp.Regexp,
) bool {
	if encoded == "" {
		return true
	}
	segments := strings.Split(encoded, "; ")
	if len(segments) > len(orderedKeys) {
		return false
	}
	previousKeyIndex := -1
	for _, segment := range segments {
		separator := strings.Index(segment, "=")
		key, candidate := "", ""
		if separator >= 1 {
			key, candidate = segment[:separator], segment[separator+1:]
		}
		keyIndex := slices.Index(orderedKeys, key)
		validator, known := validators[key]
		if keyIndex <= previousKeyIndex || keyIndex < 0 ||
			!known || !validator.MatchString(candidate) {
			return false
		}
		previousKeyIndex = keyIndex
	}
	return true
}
