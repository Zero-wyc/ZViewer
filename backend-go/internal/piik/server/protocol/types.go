package protocol

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
)

// Role mirrors roleSchema.
type Role = string

// Roles.
const (
	RoleHost   Role = "host"
	RoleViewer Role = "viewer"
)

// CodeEntryPolicy mirrors codeEntryPolicySchema.
type CodeEntryPolicy = string

// Code entry policies.
const (
	CodeEntryOpen    CodeEntryPolicy = "open"
	CodeEntryPrivate CodeEntryPolicy = "private"
)

// Codec evidence patterns from viewerQualityEvidenceMetricsSchema.
var (
	codecProfilePattern    = regexp.MustCompile(`^[a-z0-9-]+=[a-z0-9]+$`)
	codecParametersPattern = regexp.MustCompile(
		`^[a-z0-9-]+=[a-z0-9]+(?:; [a-z0-9-]+=[a-z0-9]+)*$`)
	audioMimeTypePattern = regexp.MustCompile(`(?i)^audio/[A-Za-z0-9.+-]{1,32}$`)
)

// Enumerations mirrored from src/shared/protocol.ts.
var (
	degradationPreferences       = []string{"maintain-resolution", "balanced", "maintain-framerate"}
	mediaRoutePhases             = []string{"prepare", "active"}
	routeDemandReasons           = []string{"join", "edge-unavailable", "parent-departed", "capacity-reduction", "sfu-bootstrap", "direct-convergence", "quality-convergence", "root-convergence", "publication-attach"}
	routeDiagnosticFinalRoutes   = []string{"direct", "sfu", "waiting", "failed"}
	routeDiagnosticBuckets       = []string{"none", "stale", "endpoint-capacity", "sfu-admission", "candidate-failed", "first-frame-timeout", "operation-deadline", "aborted"}
	routeDiagnosticStages        = []string{"admission", "first-frame", "quality-proof"}
	senderQualityStates          = []string{"unknown", "healthy", "degraded"}
	senderQualityDegradedReasons = []string{"none", "bandwidth", "cpu"}
	errorCodes                   = []string{"AUTH_REQUIRED", "INVALID_MESSAGE", "INVALID_TOKEN", "ROOM_ACCESS_DENIED", "ROOM_NOT_FOUND", "ROOM_FULL", "HOST_ALREADY_CONNECTED", "PEER_NOT_FOUND", "FORBIDDEN", "SERVER_ERROR"}
)

func validRevision(revision Int) bool {
	return inRangeInt(revision, 0, MaxMediaRouteRevision)
}

// ---------------------------------------------------------------------------
// mediaRouteUpstreamSchema
// ---------------------------------------------------------------------------

// MediaRouteUpstream mirrors mediaRouteUpstreamSchema.
type MediaRouteUpstream struct {
	Kind   string `json:"kind"`
	PeerID string `json:"peerId,omitempty"`
}

// NoUpstream builds { kind: "none" }.
func NoUpstream() MediaRouteUpstream { return MediaRouteUpstream{Kind: "none"} }

// PeerUpstream builds { kind: "peer", peerId }.
func PeerUpstream(peerID string) MediaRouteUpstream {
	return MediaRouteUpstream{Kind: "peer", PeerID: peerID}
}

// SfuUpstream builds { kind: "sfu" }.
func SfuUpstream() MediaRouteUpstream { return MediaRouteUpstream{Kind: "sfu"} }

// UnmarshalJSON implements json.Unmarshaler.
func (v *MediaRouteUpstream) UnmarshalJSON(data []byte) error {
	*v = MediaRouteUpstream{}
	type raw MediaRouteUpstream
	present, err := decodeObject(data, (*raw)(v))
	if err != nil {
		return err
	}
	if err := present.require("kind"); err != nil {
		return err
	}
	switch v.Kind {
	case "none", "sfu":
		if present.has("peerId") {
			return fmt.Errorf("upstream %q must not carry peerId", v.Kind)
		}
	case "peer":
		if err := present.require("peerId"); err != nil {
			return err
		}
		if !ValidOpaqueID(v.PeerID) {
			return errors.New("upstream peerId is not an opaque id")
		}
	default:
		return fmt.Errorf("unknown upstream kind %q", v.Kind)
	}
	return nil
}

// ---------------------------------------------------------------------------
// qualitySettingsSchema / routePolicySchema / runtimeCapabilitiesSchema
// ---------------------------------------------------------------------------

// QualityResolution is a requested ceiling, not encoder availability or an allocation.
type QualityResolution struct {
	Width  Int `json:"width"`
	Height Int `json:"height"`
}

func (v *QualityResolution) UnmarshalJSON(data []byte) error {
	*v = QualityResolution{}
	type raw QualityResolution
	present, err := decodeObject(data, (*raw)(v))
	if err != nil {
		return err
	}
	if err := present.require("width", "height"); err != nil {
		return err
	}
	if !inRangeInt(v.Width, 1, 0xffff_ffff) || !inRangeInt(v.Height, 1, 0xffff_ffff) {
		return errors.New("resolution is out of range")
	}
	return nil
}

// QualitySettings mirrors qualitySettingsSchema.
type QualitySettings struct {
	Resolution            QualityResolution `json:"resolution"`
	MaxFramerate          Num               `json:"maxFramerate"`
	MaxBitrate            Int               `json:"maxBitrate"`
	DegradationPreference string            `json:"degradationPreference"`
	MaxAudioBitrate       Int               `json:"maxAudioBitrate,omitempty"`
}

// UnmarshalJSON implements json.Unmarshaler.
func (v *QualitySettings) UnmarshalJSON(data []byte) error {
	*v = QualitySettings{}
	type raw QualitySettings
	present, err := decodeObject(data, (*raw)(v))
	if err != nil {
		return err
	}
	if err := present.require(
		"resolution", "maxFramerate", "maxBitrate", "degradationPreference"); err != nil {
		return err
	}
	if err := present.optional("maxAudioBitrate"); err != nil {
		return err
	}
	if v.MaxFramerate <= 0 || !inRangeNum(v.MaxFramerate, 0, MaxSafeInteger) {
		return errors.New("maxFramerate is out of range")
	}
	if !inRangeInt(v.MaxBitrate, 1, 0xffff_ffff) {
		return errors.New("maxBitrate is out of range")
	}
	if !enumOf(v.DegradationPreference, degradationPreferences...) {
		return fmt.Errorf("unknown degradationPreference %q", v.DegradationPreference)
	}
	if present.has("maxAudioBitrate") && !inRangeInt(v.MaxAudioBitrate, MinAudioBitrate, MaxAudioBitrate) {
		return errors.New("maxAudioBitrate is out of range")
	}
	return nil
}

// RoutePolicy mirrors routePolicySchema.
type RoutePolicy struct {
	PeerOnly             bool `json:"peerOnly"`
	TopologyOptimization bool `json:"topologyOptimization"`
	NatPrediction        bool `json:"natPrediction"`
}

// UnmarshalJSON implements json.Unmarshaler.
func (v *RoutePolicy) UnmarshalJSON(data []byte) error {
	*v = RoutePolicy{}
	type raw RoutePolicy
	present, err := decodeObject(data, (*raw)(v))
	if err != nil {
		return err
	}
	return present.require("peerOnly", "topologyOptimization", "natPrediction")
}

// RuntimeCapabilities mirrors runtimeCapabilitiesSchema.
type RuntimeCapabilities struct {
	Sfu                        bool     `json:"sfu"`
	SfuOnly                    bool     `json:"sfuOnly,omitempty"`
	NatPrediction              bool     `json:"natPrediction"`
	RoomInteractions           bool     `json:"roomInteractions,omitempty"`
	RoomVoice                  bool     `json:"roomVoice,omitempty"`
	RoomVoiceListeningPresence bool     `json:"roomVoiceListeningPresence,omitempty"`
	RoomVoiceBitrate           bool     `json:"roomVoiceBitrate,omitempty"`
	RelayVolunteer             bool     `json:"relayVolunteer,omitempty"`
	HostRoomSession            bool     `json:"hostRoomSession,omitempty"`
	RemoteInput                bool     `json:"remoteInput,omitempty"`
	ViewerRouteSelection       bool     `json:"viewerRouteSelection,omitempty"`
	AudioPresence              bool     `json:"audioPresence,omitempty"`
	CoPlayPresence             bool     `json:"coPlayPresence,omitempty"`
	RoomReactionIDs            []string `json:"roomReactionIds,omitempty"`
}

// UnmarshalJSON implements json.Unmarshaler.
func (v *RuntimeCapabilities) UnmarshalJSON(data []byte) error {
	*v = RuntimeCapabilities{}
	var present fields
	if err := json.Unmarshal(data, &present); err != nil {
		return err
	}
	if present == nil {
		return errors.New("runtime capabilities must be an object")
	}
	if err := present.optional("sfu", "sfuOnly", "roomInteractions", "roomVoice", "roomVoiceListeningPresence", "roomVoiceBitrate", "relayVolunteer", "hostRoomSession", "natPrediction", "remoteInput", "viewerRouteSelection", "audioPresence", "coPlayPresence", "roomReactionIds"); err != nil {

		return err
	}
	for key, target := range map[string]*bool{
		"sfu": &v.Sfu, "sfuOnly": &v.SfuOnly, "natPrediction": &v.NatPrediction,
		"roomInteractions": &v.RoomInteractions, "hostRoomSession": &v.HostRoomSession,
		"roomVoice":                  &v.RoomVoice,
		"roomVoiceListeningPresence": &v.RoomVoiceListeningPresence,
		"roomVoiceBitrate":           &v.RoomVoiceBitrate,
		"relayVolunteer":             &v.RelayVolunteer,
		"remoteInput":                &v.RemoteInput,
		"viewerRouteSelection":       &v.ViewerRouteSelection,
		"audioPresence":              &v.AudioPresence,
		"coPlayPresence":             &v.CoPlayPresence,
	} {
		if value, ok := present[key]; ok {
			if err := json.Unmarshal(value, target); err != nil {
				return err
			}
		}
	}
	if value, ok := present["roomReactionIds"]; ok {
		if err := json.Unmarshal(value, &v.RoomReactionIDs); err != nil {
			return err
		}
		if len(v.RoomReactionIDs) > 64 {
			return errors.New("too many room reaction identifiers")
		}
		for _, id := range v.RoomReactionIDs {
			if !reactionIDPattern.MatchString(id) {
				return errors.New("invalid room reaction identifier")
			}
		}
	}
	return nil
}

// ---------------------------------------------------------------------------
// iceConfigSchema
// ---------------------------------------------------------------------------

// IceServerURLs mirrors z.union([stunUrlSchema, z.array(stunUrlSchema)]).
type IceServerURLs struct {
	Single string
	List   []string
}

// IceServerURLList builds the array form.
func IceServerURLList(urls ...string) IceServerURLs {
	if urls == nil {
		urls = []string{}
	}
	return IceServerURLs{List: urls}
}

// MarshalJSON implements json.Marshaler.
func (v IceServerURLs) MarshalJSON() ([]byte, error) {
	if v.List != nil {
		return marshalJSON(v.List)
	}
	return marshalJSON(v.Single)
}

// UnmarshalJSON implements json.Unmarshaler.
func (v *IceServerURLs) UnmarshalJSON(data []byte) error {
	*v = IceServerURLs{}
	if len(data) > 0 && data[0] == '[' {
		var list []string
		if err := json.Unmarshal(data, &list); err != nil {
			return err
		}
		if len(list) < 1 || len(list) > MaxIceServerURLs {
			return errors.New("iceServers[].urls length is out of range")
		}
		for _, url := range list {
			if !ValidStunURLValue(url) {
				return errors.New("Invalid STUN URL")
			}
		}
		v.List = list
		return nil
	}
	var single string
	if err := json.Unmarshal(data, &single); err != nil {
		return err
	}
	if !ValidStunURLValue(single) {
		return errors.New("Invalid STUN URL")
	}
	v.Single = single
	return nil
}

// ValidStunURLValue mirrors stunUrlSchema: 1..512 UTF-16 code units plus
// isValidStunUrl. It is the single owner of that bound; config validates
// STUN_URLS and the Client's local STUN list through it.
func ValidStunURLValue(value string) bool {
	length := UTF16Length(value)
	return length >= 1 && length <= MaxStunURLLength && ValidStunURL(value)
}

// IceServer mirrors iceServerSchema.
type IceServer struct {
	URLs IceServerURLs `json:"urls"`
}

// UnmarshalJSON implements json.Unmarshaler.
func (v *IceServer) UnmarshalJSON(data []byte) error {
	*v = IceServer{}
	type raw IceServer
	present, err := decodeObject(data, (*raw)(v))
	if err != nil {
		return err
	}
	return present.require("urls")
}

// IceConfig mirrors iceConfigSchema.
type IceConfig struct {
	IceServers            []IceServer `json:"iceServers"`
	NatPredictionStunURLs []string    `json:"natPredictionStunUrls"`
}

// MarshalJSON implements json.Marshaler.
func (v IceConfig) MarshalJSON() ([]byte, error) {
	type raw IceConfig
	value := raw(v)
	if value.IceServers == nil {
		value.IceServers = []IceServer{}
	}
	if value.NatPredictionStunURLs == nil {
		value.NatPredictionStunURLs = []string{}
	}
	return marshalJSON(value)
}

// UnmarshalJSON implements json.Unmarshaler.
func (v *IceConfig) UnmarshalJSON(data []byte) error {
	*v = IceConfig{}
	type raw IceConfig
	present, err := decodeObject(data, (*raw)(v))
	if err != nil {
		return err
	}
	if err := present.require("iceServers", "natPredictionStunUrls"); err != nil {
		return err
	}
	if len(v.IceServers) > 8 {
		return errors.New("iceServers holds too many entries")
	}
	if len(v.NatPredictionStunURLs) > MaxNatPredictionAuxiliaryStunURLs {
		return errors.New("natPredictionStunUrls holds too many entries")
	}
	for _, url := range v.NatPredictionStunURLs {
		if !ValidStunURLValue(url) {
			return errors.New("Invalid STUN URL")
		}
	}
	return nil
}

// ---------------------------------------------------------------------------
// signalPayloadSchema
// ---------------------------------------------------------------------------

// SessionDescription mirrors sessionDescriptionSchema.
type SessionDescription struct {
	Type string `json:"type"`
	SDP  string `json:"sdp"`
}

// UnmarshalJSON implements json.Unmarshaler.
func (v *SessionDescription) UnmarshalJSON(data []byte) error {
	*v = SessionDescription{}
	type raw SessionDescription
	present, err := decodeObject(data, (*raw)(v))
	if err != nil {
		return err
	}
	if err := present.require("type", "sdp"); err != nil {
		return err
	}
	if !enumOf(v.Type, "offer", "answer") {
		return fmt.Errorf("unknown description type %q", v.Type)
	}
	if length := UTF16Length(v.SDP); length < 1 || length > 48*1024 {
		return errors.New("sdp length is out of range")
	}
	return nil
}

// IceCandidate mirrors iceCandidateSchema.
type IceCandidate struct {
	Candidate        string           `json:"candidate"`
	SDPMid           Nullable[string] `json:"sdpMid,omitzero"`
	SDPMLineIndex    Nullable[Int]    `json:"sdpMLineIndex,omitzero"`
	UsernameFragment Nullable[string] `json:"usernameFragment,omitzero"`
}

// UnmarshalJSON implements json.Unmarshaler.
func (v *IceCandidate) UnmarshalJSON(data []byte) error {
	*v = IceCandidate{}
	type raw IceCandidate
	present, err := decodeObject(data, (*raw)(v))
	if err != nil {
		return err
	}
	if err := present.require("candidate"); err != nil {
		return err
	}
	if UTF16Length(v.Candidate) > 4096 {
		return errors.New("candidate is too long")
	}
	if v.SDPMid.Value != nil && UTF16Length(*v.SDPMid.Value) > 128 {
		return errors.New("sdpMid is too long")
	}
	if v.SDPMLineIndex.Value != nil && !inRangeInt(*v.SDPMLineIndex.Value, 0, 255) {
		return errors.New("sdpMLineIndex is out of range")
	}
	if v.UsernameFragment.Value != nil && UTF16Length(*v.UsernameFragment.Value) > 256 {
		return errors.New("usernameFragment is too long")
	}
	return nil
}

// SignalPayload mirrors signalPayloadSchema. Candidate is nil for the JSON
// null the "candidate" variant requires.
type SignalPayload struct {
	Kind         string
	ConnectionID string
	Description  *SessionDescription
	Candidate    *IceCandidate
	Punch        *PunchSignal
	Punched      bool
}

// MarshalJSON implements json.Marshaler.
func (v SignalPayload) MarshalJSON() ([]byte, error) {
	if v.Kind == "punch" {
		return marshalJSON(struct {
			Kind         string       `json:"kind"`
			ConnectionID string       `json:"connectionId"`
			Punch        *PunchSignal `json:"punch"`
		}{v.Kind, v.ConnectionID, v.Punch})
	}
	if v.Kind == "description" {
		return marshalJSON(struct {
			Kind         string              `json:"kind"`
			ConnectionID string              `json:"connectionId"`
			Description  *SessionDescription `json:"description"`
			Punched      bool                `json:"punched,omitempty"`
		}{v.Kind, v.ConnectionID, v.Description, v.Punched})
	}
	return marshalJSON(struct {
		Kind         string        `json:"kind"`
		ConnectionID string        `json:"connectionId"`
		Candidate    *IceCandidate `json:"candidate"`
	}{v.Kind, v.ConnectionID, v.Candidate})
}

// UnmarshalJSON implements json.Unmarshaler.
func (v *SignalPayload) UnmarshalJSON(data []byte) error {
	*v = SignalPayload{}
	kind, err := typeOf(data, "kind")
	if err != nil {
		return err
	}
	switch kind {
	case "punch":
		var body struct {
			Kind         string       `json:"kind"`
			ConnectionID string       `json:"connectionId"`
			Punch        *PunchSignal `json:"punch"`
		}
		present, err := decodeObject(data, &body)
		if err != nil {
			return err
		}
		if err = present.require("kind", "connectionId", "punch"); err != nil {
			return err
		}
		if !ValidOpaqueID(body.ConnectionID) || body.Punch == nil {
			return errors.New("invalid connection preparation signal")
		}
		*v = SignalPayload{Kind: kind, ConnectionID: body.ConnectionID, Punch: body.Punch}
		return nil
	case "description":
		var body struct {
			Kind         string              `json:"kind"`
			ConnectionID string              `json:"connectionId"`
			Description  *SessionDescription `json:"description"`
			Punched      bool                `json:"punched,omitempty"`
		}
		present, err := decodeObject(data, &body)
		if err != nil {
			return err
		}
		if err := present.require("kind", "connectionId", "description"); err != nil {
			return err
		}
		if !ValidOpaqueID(body.ConnectionID) {
			return errors.New("connectionId is not an opaque id")
		}
		if _, exists := present["punched"]; exists && !body.Punched {
			return errors.New("punched must be true when present")
		}
		*v = SignalPayload{Kind: kind, ConnectionID: body.ConnectionID, Description: body.Description, Punched: body.Punched}
		return nil
	case "candidate":
		var body struct {
			Kind         string        `json:"kind"`
			ConnectionID string        `json:"connectionId"`
			Candidate    *IceCandidate `json:"candidate"`
		}
		present, err := decodeObject(data, &body)
		if err != nil {
			return err
		}
		if err := present.require("kind", "connectionId"); err != nil {
			return err
		}
		if err := present.requireNullable("candidate"); err != nil {
			return err
		}
		if !ValidOpaqueID(body.ConnectionID) {
			return errors.New("connectionId is not an opaque id")
		}
		*v = SignalPayload{Kind: kind, ConnectionID: body.ConnectionID, Candidate: body.Candidate}
		return nil
	}
	return fmt.Errorf("unknown signal payload kind %q", kind)
}

// ---------------------------------------------------------------------------
// preparedRouteCandidateSchema / participantRouteAssignmentSchema
// ---------------------------------------------------------------------------

// ConnectionAttempt mirrors preparedRouteCandidateSchema.connectionAttempt.
type ConnectionAttempt struct {
	Current Int `json:"current"`
	Total   Int `json:"total"`
}

// UnmarshalJSON implements json.Unmarshaler.
func (v *ConnectionAttempt) UnmarshalJSON(data []byte) error {
	*v = ConnectionAttempt{}
	type raw ConnectionAttempt
	present, err := decodeObject(data, (*raw)(v))
	if err != nil {
		return err
	}
	if err := present.require("current", "total"); err != nil {
		return err
	}
	if !inRangeInt(v.Current, 1, int64(v.Total)) {
		return errors.New("connectionAttempt.current is out of range")
	}
	if !inRangeInt(v.Total, 1, MaxSafeInteger) {
		return errors.New("connectionAttempt.total is out of range")
	}
	return nil
}

// PreparedRouteCandidate mirrors preparedRouteCandidateSchema.
type PreparedRouteCandidate struct {
	ChildPeerID       string             `json:"childPeerId"`
	ConnectionID      string             `json:"connectionId"`
	Transport         string             `json:"transport"`
	QualityProbe      bool               `json:"qualityProbe"`
	ConnectionAttempt *ConnectionAttempt `json:"connectionAttempt,omitempty"`
}

// UnmarshalJSON implements json.Unmarshaler.
func (v *PreparedRouteCandidate) UnmarshalJSON(data []byte) error {
	*v = PreparedRouteCandidate{}
	type raw PreparedRouteCandidate
	present, err := decodeObject(data, (*raw)(v))
	if err != nil {
		return err
	}
	if err := present.require(
		"childPeerId", "connectionId", "transport", "qualityProbe"); err != nil {
		return err
	}
	if err := present.optional("connectionAttempt"); err != nil {
		return err
	}
	if !ValidOpaqueID(v.ChildPeerID) || !ValidOpaqueID(v.ConnectionID) {
		return errors.New("prepared route candidate ids are not opaque ids")
	}
	if !enumOf(v.Transport, "direct", "sfu") {
		return fmt.Errorf("unknown transport %q", v.Transport)
	}
	return nil
}

// ParticipantRouteAssignment mirrors participantRouteAssignmentSchema.
type ParticipantRouteAssignment struct {
	Upstream                 MediaRouteUpstream `json:"upstream"`
	ChildPeerIDs             []string           `json:"childPeerIds"`
	SfuPublicationGeneration *string            `json:"sfuPublicationGeneration"`
}

// MarshalJSON implements json.Marshaler.
func (v ParticipantRouteAssignment) MarshalJSON() ([]byte, error) {
	type raw ParticipantRouteAssignment
	value := raw(v)
	if value.ChildPeerIDs == nil {
		value.ChildPeerIDs = []string{}
	}
	return marshalJSON(value)
}

// UnmarshalJSON implements json.Unmarshaler.
func (v *ParticipantRouteAssignment) UnmarshalJSON(data []byte) error {
	*v = ParticipantRouteAssignment{}
	type raw ParticipantRouteAssignment
	present, err := decodeObject(data, (*raw)(v))
	if err != nil {
		return err
	}
	if err := present.require("upstream", "childPeerIds"); err != nil {
		return err
	}
	if err := present.requireNullable("sfuPublicationGeneration"); err != nil {
		return err
	}
	if len(v.ChildPeerIDs) > MaxViewersPerRoomLimit {
		return errors.New("childPeerIds holds too many entries")
	}
	seen := make(map[string]struct{}, len(v.ChildPeerIDs))
	for _, peerID := range v.ChildPeerIDs {
		if !ValidOpaqueID(peerID) {
			return errors.New("childPeerIds holds a non-opaque id")
		}
		if _, duplicate := seen[peerID]; duplicate {
			return errors.New("childPeerIds must be unique")
		}
		seen[peerID] = struct{}{}
	}
	if v.SfuPublicationGeneration != nil && !ValidOpaqueID(*v.SfuPublicationGeneration) {
		return errors.New("sfuPublicationGeneration is not an opaque id")
	}
	// superRefine: an SFU upstream requires its publication generation and a
	// peer upstream cannot own one.
	if v.Upstream.Kind == "sfu" && v.SfuPublicationGeneration == nil {
		return errors.New("An SFU upstream requires its publication generation")
	}
	if v.Upstream.Kind == "peer" && v.SfuPublicationGeneration != nil {
		return errors.New("A peer upstream cannot own an SFU publication generation")
	}
	return nil
}

// ---------------------------------------------------------------------------
// routeDiagnosticSnapshotSchema
// ---------------------------------------------------------------------------

// RouteDiagnosticParent mirrors routeDiagnosticParentSchema.
type RouteDiagnosticParent struct {
	Kind    string `json:"kind"`
	Ordinal Int    `json:"ordinal,omitempty"`
}

// UnmarshalJSON implements json.Unmarshaler.
func (v *RouteDiagnosticParent) UnmarshalJSON(data []byte) error {
	*v = RouteDiagnosticParent{}
	type raw RouteDiagnosticParent
	present, err := decodeObject(data, (*raw)(v))
	if err != nil {
		return err
	}
	if err := present.require("kind"); err != nil {
		return err
	}
	switch v.Kind {
	case "none", "host", "sfu":
		if present.has("ordinal") {
			return fmt.Errorf("route diagnostic parent %q must not carry ordinal", v.Kind)
		}
	case "viewer":
		if err := present.require("ordinal"); err != nil {
			return err
		}
		if !inRangeInt(v.Ordinal, 1, MaxViewersPerRoomLimit) {
			return errors.New("route diagnostic parent ordinal is out of range")
		}
	default:
		return fmt.Errorf("unknown route diagnostic parent kind %q", v.Kind)
	}
	return nil
}

// RouteDiagnosticQuality mirrors routeDiagnosticQualitySchema.
type RouteDiagnosticQuality struct {
	EligibleWindows    Int `json:"eligibleWindows"`
	EligibleDurationMs Int `json:"eligibleDurationMs"`
	FreezeWindows      Int `json:"freezeWindows"`
	FreezeCount        Int `json:"freezeCount"`
	FreezeDurationMs   Int `json:"freezeDurationMs"`
	PauseCount         Int `json:"pauseCount"`
	PauseDurationMs    Int `json:"pauseDurationMs"`
}

// UnmarshalJSON implements json.Unmarshaler.
func (v *RouteDiagnosticQuality) UnmarshalJSON(data []byte) error {
	*v = RouteDiagnosticQuality{}
	type raw RouteDiagnosticQuality
	present, err := decodeObject(data, (*raw)(v))
	if err != nil {
		return err
	}
	if err := present.require("eligibleWindows", "eligibleDurationMs", "freezeWindows",
		"freezeCount", "freezeDurationMs", "pauseCount", "pauseDurationMs"); err != nil {
		return err
	}
	for _, value := range []Int{v.EligibleWindows, v.EligibleDurationMs, v.FreezeWindows,
		v.FreezeCount, v.FreezeDurationMs, v.PauseCount, v.PauseDurationMs} {
		if !inRangeInt(value, 0, MaxSafeInteger) {
			return errors.New("route diagnostic quality value is out of range")
		}
	}
	return nil
}

// RouteDiagnosticChild mirrors routeDiagnosticChildSchema.
type RouteDiagnosticChild struct {
	Ordinal             Int                     `json:"ordinal"`
	Parent              RouteDiagnosticParent   `json:"parent"`
	EffectiveCapacity   Int                     `json:"effectiveCapacity"`
	ChildCount          Int                     `json:"childCount"`
	DemandAgeMs         *Int                    `json:"demandAgeMs"`
	QueueWaitMs         *Int                    `json:"queueWaitMs"`
	CandidateStartMs    *Int                    `json:"candidateStartMs"`
	FirstDecodedFrameMs *Int                    `json:"firstDecodedFrameMs"`
	FinalMs             *Int                    `json:"finalMs"`
	FinalRoute          string                  `json:"finalRoute"`
	RejectionBucket     string                  `json:"rejectionBucket"`
	Quality             *RouteDiagnosticQuality `json:"quality"`
}

// UnmarshalJSON implements json.Unmarshaler.
func (v *RouteDiagnosticChild) UnmarshalJSON(data []byte) error {
	*v = RouteDiagnosticChild{}
	type raw RouteDiagnosticChild
	present, err := decodeObject(data, (*raw)(v))
	if err != nil {
		return err
	}
	if err := present.require("ordinal", "parent", "effectiveCapacity", "childCount",
		"finalRoute", "rejectionBucket"); err != nil {
		return err
	}
	if err := present.requireNullable("demandAgeMs", "queueWaitMs", "candidateStartMs",
		"firstDecodedFrameMs", "finalMs", "quality"); err != nil {
		return err
	}
	if !inRangeInt(v.Ordinal, 1, MaxViewersPerRoomLimit) {
		return errors.New("route diagnostic ordinal is out of range")
	}
	if !inRangeInt(v.EffectiveCapacity, 0, MaxViewersPerRoomLimit) ||
		!inRangeInt(v.ChildCount, 0, MaxViewersPerRoomLimit) {
		return errors.New("route diagnostic capacity is out of range")
	}
	for _, duration := range []*Int{v.DemandAgeMs, v.QueueWaitMs, v.CandidateStartMs,
		v.FirstDecodedFrameMs, v.FinalMs} {
		if duration != nil && !inRangeInt(*duration, 0, MaxSafeInteger) {
			return errors.New("route diagnostic duration is out of range")
		}
	}
	if !enumOf(v.FinalRoute, routeDiagnosticFinalRoutes...) {
		return fmt.Errorf("unknown finalRoute %q", v.FinalRoute)
	}
	if !enumOf(v.RejectionBucket, routeDiagnosticBuckets...) {
		return fmt.Errorf("unknown rejectionBucket %q", v.RejectionBucket)
	}
	return nil
}

// RouteDiagnosticOperation mirrors routeDiagnosticOperationSchema.
type RouteDiagnosticOperation struct {
	ChildOrdinal   Int    `json:"childOrdinal"`
	Reason         string `json:"reason"`
	Stage          string `json:"stage"`
	Cursor         Int    `json:"cursor"`
	CandidateCount Int    `json:"candidateCount"`
}

// UnmarshalJSON implements json.Unmarshaler.
func (v *RouteDiagnosticOperation) UnmarshalJSON(data []byte) error {
	*v = RouteDiagnosticOperation{}
	type raw RouteDiagnosticOperation
	present, err := decodeObject(data, (*raw)(v))
	if err != nil {
		return err
	}
	if err := present.require(
		"childOrdinal", "reason", "stage", "cursor", "candidateCount"); err != nil {
		return err
	}
	if !inRangeInt(v.ChildOrdinal, 1, MaxViewersPerRoomLimit) {
		return errors.New("route diagnostic childOrdinal is out of range")
	}
	if !enumOf(v.Reason, routeDemandReasons...) {
		return fmt.Errorf("unknown route demand reason %q", v.Reason)
	}
	if !enumOf(v.Stage, routeDiagnosticStages...) {
		return fmt.Errorf("unknown route diagnostic stage %q", v.Stage)
	}
	if !inRangeInt(v.Cursor, 0, MaxViewersPerRoomLimit) {
		return errors.New("route diagnostic cursor is out of range")
	}
	if !inRangeInt(v.CandidateCount, 1, MaxViewersPerRoomLimit+1) {
		return errors.New("route diagnostic candidateCount is out of range")
	}
	return nil
}

// RouteDiagnosticSnapshot mirrors routeDiagnosticSnapshotSchema.
type RouteDiagnosticSnapshot struct {
	Children  []RouteDiagnosticChild    `json:"children"`
	Operation *RouteDiagnosticOperation `json:"operation"`
}

// MarshalJSON implements json.Marshaler.
func (v RouteDiagnosticSnapshot) MarshalJSON() ([]byte, error) {
	type raw RouteDiagnosticSnapshot
	value := raw(v)
	if value.Children == nil {
		value.Children = []RouteDiagnosticChild{}
	}
	return marshalJSON(value)
}

// UnmarshalJSON implements json.Unmarshaler.
func (v *RouteDiagnosticSnapshot) UnmarshalJSON(data []byte) error {
	*v = RouteDiagnosticSnapshot{}
	type raw RouteDiagnosticSnapshot
	present, err := decodeObject(data, (*raw)(v))
	if err != nil {
		return err
	}
	if err := present.require("children"); err != nil {
		return err
	}
	if err := present.requireNullable("operation"); err != nil {
		return err
	}
	if len(v.Children) > MaxViewersPerRoomLimit {
		return errors.New("route diagnostic snapshot holds too many children")
	}
	// superRefine: unique ordinals, resolvable viewer parents, and an
	// operation that names a present child with a cursor inside its candidates.
	ordinals := make(map[Int]struct{}, len(v.Children))
	for _, child := range v.Children {
		ordinals[child.Ordinal] = struct{}{}
	}
	if len(ordinals) != len(v.Children) {
		return errors.New("Route diagnostic ordinals must be unique")
	}
	for _, child := range v.Children {
		if child.Parent.Kind != "viewer" {
			continue
		}
		if _, ok := ordinals[child.Parent.Ordinal]; !ok || child.Parent.Ordinal == child.Ordinal {
			return errors.New("Route diagnostic parent ordinal is invalid")
		}
	}
	if v.Operation != nil {
		if _, ok := ordinals[v.Operation.ChildOrdinal]; !ok ||
			v.Operation.Cursor >= v.Operation.CandidateCount {
			return errors.New("Route diagnostic operation is invalid")
		}
	}
	return nil
}

// ---------------------------------------------------------------------------
// participantPresenceEntrySchema
// ---------------------------------------------------------------------------

// ParticipantPresenceEntry mirrors participantPresenceEntrySchema. The viewer
// variant is viewerPresenceEntrySchema.
type ParticipantPresenceEntry struct {
	Role        Role               `json:"role"`
	PeerID      string             `json:"peerId"`
	DisplayName DisplayName        `json:"displayName"`
	Upstream    MediaRouteUpstream `json:"upstream"`
	MediaReady  bool               `json:"mediaReady,omitempty"`
}

// HostPresenceEntry builds the host entry, whose upstream is always
// { kind: "none" } and which never carries mediaReady.
func HostPresenceEntry(peerID string, displayName DisplayName) ParticipantPresenceEntry {
	return ParticipantPresenceEntry{
		Role: RoleHost, PeerID: peerID, DisplayName: displayName, Upstream: NoUpstream(),
	}
}

// NewViewerPresenceEntry builds a viewer entry; mediaReady is emitted only
// when true, matching `...(mediaReady ? { mediaReady: true } : {})`.
func NewViewerPresenceEntry(
	peerID string, displayName DisplayName, upstream MediaRouteUpstream, mediaReady bool,
) ParticipantPresenceEntry {
	return ParticipantPresenceEntry{
		Role: RoleViewer, PeerID: peerID, DisplayName: displayName,
		Upstream: upstream, MediaReady: mediaReady,
	}
}

// UnmarshalJSON implements json.Unmarshaler.
func (v *ParticipantPresenceEntry) UnmarshalJSON(data []byte) error {
	*v = ParticipantPresenceEntry{}
	type raw ParticipantPresenceEntry
	present, err := decodeObject(data, (*raw)(v))
	if err != nil {
		return err
	}
	if err := present.require("role", "peerId", "displayName", "upstream"); err != nil {
		return err
	}
	if !ValidOpaqueID(v.PeerID) {
		return errors.New("presence peerId is not an opaque id")
	}
	switch v.Role {
	case RoleHost:
		if present.has("mediaReady") {
			return errors.New("host presence must not carry mediaReady")
		}
		if v.Upstream.Kind != "none" {
			return errors.New("host presence upstream must be none")
		}
	case RoleViewer:
		if err := present.optional("mediaReady"); err != nil {
			return err
		}
		if present.has("mediaReady") && !v.MediaReady {
			return errors.New("mediaReady must be true when present")
		}
	default:
		return fmt.Errorf("unknown presence role %q", v.Role)
	}
	return nil
}

// ---------------------------------------------------------------------------
// viewerQualityEvidenceMetricsSchema / senderQualityDiagnosticsSchema
// ---------------------------------------------------------------------------

// ViewerQualityEvidenceGuard mirrors viewerQualityEvidenceGuardSchema.
type ViewerQualityEvidenceGuard struct {
	ConnectionID      string `json:"connectionId"`
	RouteRevision     Int    `json:"routeRevision"`
	PresentationEpoch Int    `json:"presentationEpoch"`
}

// UnmarshalJSON implements json.Unmarshaler.
func (v *ViewerQualityEvidenceGuard) UnmarshalJSON(data []byte) error {
	*v = ViewerQualityEvidenceGuard{}
	type raw ViewerQualityEvidenceGuard
	present, err := decodeObject(data, (*raw)(v))
	if err != nil {
		return err
	}
	if err := present.require("connectionId", "routeRevision", "presentationEpoch"); err != nil {
		return err
	}
	if !ValidOpaqueID(v.ConnectionID) {
		return errors.New("guard connectionId is not an opaque id")
	}
	if !validRevision(v.RouteRevision) {
		return errors.New("guard routeRevision is out of range")
	}
	if !inRangeInt(v.PresentationEpoch, 0, MaxSafeInteger) {
		return errors.New("guard presentationEpoch is out of range")
	}
	return nil
}

// ViewerQualityEvidenceMetrics mirrors viewerQualityEvidenceMetricsSchema.
type ViewerQualityEvidenceMetrics struct {
	NatTraversalPath             string  `json:"natTraversalPath"`
	Width                        *Int    `json:"width"`
	Height                       *Int    `json:"height"`
	FramesPerSecond              *Num    `json:"framesPerSecond"`
	BitrateKbps                  *Num    `json:"bitrateKbps"`
	PacketsReceivedDelta         *Int    `json:"packetsReceivedDelta"`
	PacketsLostDelta             *Int    `json:"packetsLostDelta"`
	RttMs                        *Num    `json:"rttMs"`
	JitterMs                     *Num    `json:"jitterMs"`
	FramesDecodedDelta           *Int    `json:"framesDecodedDelta"`
	FramesDroppedDelta           *Int    `json:"framesDroppedDelta"`
	DecodeMsPerFrame             *Num    `json:"decodeMsPerFrame"`
	FreezeCountDelta             *Int    `json:"freezeCountDelta"`
	FreezeDurationMsDelta        *Num    `json:"freezeDurationMsDelta"`
	PauseCountDelta              *Int    `json:"pauseCountDelta"`
	PauseDurationMsDelta         *Num    `json:"pauseDurationMsDelta"`
	Codec                        *string `json:"codec"`
	CodecProfile                 *string `json:"codecProfile"`
	CodecParameters              *string `json:"codecParameters"`
	AudioBitrateKbps             *Num    `json:"audioBitrateKbps"`
	AudioPacketLossPercent       *Num    `json:"audioPacketLossPercent"`
	AudioJitterMs                *Num    `json:"audioJitterMs"`
	AudioVideoPlayoutDeltaMs     *Num    `json:"audioVideoPlayoutDeltaMs"`
	VideoJitterBufferDelayMs     *Num    `json:"videoJitterBufferDelayMs"`
	AudioJitterBufferDelayMs     *Num    `json:"audioJitterBufferDelayMs"`
	AudioConcealedSamplesPercent *Num    `json:"audioConcealedSamplesPercent"`
	AudioConcealmentEventsDelta  *Int    `json:"audioConcealmentEventsDelta"`
	AudioCodec                   *string `json:"audioCodec"`
}

var viewerQualityEvidenceMetricKeys = []string{
	"natTraversalPath", "width", "height", "framesPerSecond", "bitrateKbps",
	"packetsReceivedDelta", "packetsLostDelta", "rttMs", "jitterMs",
	"framesDecodedDelta", "framesDroppedDelta", "decodeMsPerFrame",
	"freezeCountDelta", "freezeDurationMsDelta", "pauseCountDelta",
	"pauseDurationMsDelta", "codec", "codecProfile", "codecParameters",
	"audioBitrateKbps", "audioPacketLossPercent", "audioJitterMs",
	"audioVideoPlayoutDeltaMs", "videoJitterBufferDelayMs",
	"audioJitterBufferDelayMs", "audioConcealedSamplesPercent",
	"audioConcealmentEventsDelta", "audioCodec",
}

// UnmarshalJSON implements json.Unmarshaler.
func (v *ViewerQualityEvidenceMetrics) UnmarshalJSON(data []byte) error {
	*v = ViewerQualityEvidenceMetrics{}
	type raw ViewerQualityEvidenceMetrics
	present, err := decodeObject(data, (*raw)(v))
	if err != nil {
		return err
	}
	if err := present.requireNullable(viewerQualityEvidenceMetricKeys...); err != nil {
		return err
	}
	if err := present.require("natTraversalPath"); err != nil {
		return err
	}
	if !enumOf(v.NatTraversalPath, NatTraversalPaths[:]...) {
		return fmt.Errorf("unknown natTraversalPath %q", v.NatTraversalPath)
	}
	for _, bound := range []struct {
		value            *Int
		minimum, maximum int64
	}{
		{v.Width, 1, MaxSafeInteger}, {v.Height, 1, MaxSafeInteger},
		{v.PacketsReceivedDelta, 0, MaxSafeInteger}, {v.PacketsLostDelta, 0, MaxSafeInteger},
		{v.FramesDecodedDelta, 0, MaxSafeInteger}, {v.FramesDroppedDelta, 0, MaxSafeInteger},
		{v.FreezeCountDelta, 0, MaxSafeInteger}, {v.PauseCountDelta, 0, MaxSafeInteger},
		{v.AudioConcealmentEventsDelta, 0, MaxSafeInteger},
	} {
		if bound.value != nil && !inRangeInt(*bound.value, bound.minimum, bound.maximum) {
			return errors.New("viewer quality evidence integer is out of range")
		}
	}
	for _, bound := range []struct {
		value            *Num
		minimum, maximum float64
	}{
		{v.FramesPerSecond, 0, MaxSafeInteger}, {v.BitrateKbps, 0, MaxSafeInteger},
		{v.RttMs, 0, MaxSafeInteger}, {v.JitterMs, 0, MaxSafeInteger},
		{v.DecodeMsPerFrame, 0, MaxSafeInteger},
		{v.FreezeDurationMsDelta, 0, MaxSafeInteger},
		{v.PauseDurationMsDelta, 0, MaxSafeInteger},
		{v.AudioBitrateKbps, 0, MaxSafeInteger}, {v.AudioPacketLossPercent, 0, 100},
		{v.AudioJitterMs, 0, MaxSafeInteger},
		{v.AudioVideoPlayoutDeltaMs, -MaxSafeInteger, MaxSafeInteger},
		{v.VideoJitterBufferDelayMs, 0, MaxSafeInteger}, {v.AudioJitterBufferDelayMs, 0, MaxSafeInteger},
		{v.AudioConcealedSamplesPercent, 0, 100},
	} {
		if bound.value != nil && !inRangeNum(*bound.value, bound.minimum, bound.maximum) {
			return errors.New("viewer quality evidence number is out of range")
		}
	}
	if v.Codec != nil && (UTF16Length(*v.Codec) > 64 || !videoMimeTypePattern.MatchString(*v.Codec)) {
		return errors.New("codec is not a video mime type")
	}
	if v.CodecProfile != nil &&
		(UTF16Length(*v.CodecProfile) > 64 || !codecProfilePattern.MatchString(*v.CodecProfile)) {
		return errors.New("codecProfile is malformed")
	}
	if v.CodecParameters != nil &&
		(UTF16Length(*v.CodecParameters) > 128 ||
			!codecParametersPattern.MatchString(*v.CodecParameters)) {
		return errors.New("codecParameters is malformed")
	}
	if v.AudioCodec != nil &&
		(UTF16Length(*v.AudioCodec) > 64 || !audioMimeTypePattern.MatchString(*v.AudioCodec)) {
		return errors.New("audioCodec is not an audio mime type")
	}
	// refine: dimensions travel together.
	if (v.Width == nil) != (v.Height == nil) {
		return errors.New("Viewer quality dimensions must be present together")
	}
	// refine: codec evidence must be canonical.
	if !IsCanonicalVideoCodecEvidence(
		derefString(v.Codec), derefString(v.CodecProfile), derefString(v.CodecParameters)) {
		return errors.New("Viewer codec evidence is not canonical")
	}
	return nil
}

func derefString(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

// SenderQualityDiagnostics mirrors senderQualityDiagnosticsSchema.
type SenderQualityDiagnostics struct {
	NatTraversalPath           string        `json:"natTraversalPath"`
	Reason                     *string       `json:"reason"`
	FramesPerSecond            *Num          `json:"framesPerSecond"`
	BitrateKbps                *Num          `json:"bitrateKbps"`
	CaptureFramesPerSecond     Nullable[Num] `json:"captureFramesPerSecond,omitzero"`
	MediaSourceFramesPerSecond Nullable[Num] `json:"mediaSourceFramesPerSecond,omitzero"`
	Width                      Nullable[Int] `json:"width,omitzero"`
	Height                     Nullable[Int] `json:"height,omitzero"`
	VideoEncodingCount         Nullable[Int] `json:"videoEncodingCount,omitzero"`
	ActiveVideoEncodingCount   Nullable[Int] `json:"activeVideoEncodingCount,omitzero"`
	AvailableOutgoingKbps      Nullable[Num] `json:"availableOutgoingKbps,omitzero"`
	RttMs                      Nullable[Num] `json:"rttMs,omitzero"`
	PacketLossPercent          Nullable[Num] `json:"packetLossPercent,omitzero"`
}

// UnmarshalJSON implements json.Unmarshaler.
func (v *SenderQualityDiagnostics) UnmarshalJSON(data []byte) error {
	*v = SenderQualityDiagnostics{}
	type raw SenderQualityDiagnostics
	present, err := decodeObject(data, (*raw)(v))
	if err != nil {
		return err
	}
	if err := present.require("natTraversalPath"); err != nil {
		return err
	}
	if err := present.requireNullable(
		"reason", "framesPerSecond", "bitrateKbps"); err != nil {
		return err
	}
	if !enumOf(v.NatTraversalPath, NatTraversalPaths[:]...) {
		return fmt.Errorf("unknown natTraversalPath %q", v.NatTraversalPath)
	}
	if v.Reason != nil && !enumOf(*v.Reason, senderQualityDegradedReasons...) {
		return fmt.Errorf("unknown sender quality reason %q", *v.Reason)
	}
	for _, bound := range []struct {
		value            *Num
		minimum, maximum float64
	}{
		{v.FramesPerSecond, 0, MaxSafeInteger}, {v.BitrateKbps, 0, MaxSafeInteger},
		{v.CaptureFramesPerSecond.Value, 0, MaxSafeInteger},
		{v.MediaSourceFramesPerSecond.Value, 0, MaxSafeInteger},
		{v.AvailableOutgoingKbps.Value, 0, MaxSafeInteger},
		{v.RttMs.Value, 0, MaxSafeInteger}, {v.PacketLossPercent.Value, 0, 100},
	} {
		if bound.value != nil && !inRangeNum(*bound.value, bound.minimum, bound.maximum) {
			return errors.New("sender quality diagnostic number is out of range")
		}
	}
	for _, bound := range []struct {
		value   *Int
		maximum int64
	}{
		{v.Width.Value, MaxSafeInteger}, {v.Height.Value, MaxSafeInteger},
		{v.VideoEncodingCount.Value, MaxSafeInteger},
		{v.ActiveVideoEncodingCount.Value, MaxSafeInteger},
	} {
		if bound.value != nil && !inRangeInt(*bound.value, 0, bound.maximum) {
			return errors.New("sender quality diagnostic integer is out of range")
		}
	}
	return nil
}
