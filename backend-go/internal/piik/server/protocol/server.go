package protocol

import (
	"errors"
	"fmt"
)

// ServerMessage is one member of serverMessageSchema. The interface is sealed:
// only the message structs in this file implement it.
type ServerMessage interface {
	isServerMessage()
}

// AuthenticatedHostMessage returns the Host's current room and transport facts.
type AuthenticatedHostMessage struct {
	Type                          string                     `json:"type"`
	Protocol                      string                     `json:"protocol"`
	PeerID                        string                     `json:"peerId"`
	MaxViewers                    Int                        `json:"maxViewers"`
	EndpointMediaCopyCapacity     Int                        `json:"endpointMediaCopyCapacity"`
	HostOnline                    bool                       `json:"hostOnline"`
	HostPaused                    *bool                      `json:"hostPaused,omitempty"`
	ConnectionID                  *string                    `json:"connectionId"`
	IceConfig                     IceConfig                  `json:"iceConfig"`
	RoutePolicy                   RoutePolicy                `json:"routePolicy"`
	CodeEntryPolicy               CodeEntryPolicy            `json:"codeEntryPolicy"`
	ViewerAuthorizationGeneration string                     `json:"viewerAuthorizationGeneration"`
	MediaMode                     string                     `json:"mediaMode"`
	ShareGeneration               *string                    `json:"shareGeneration"`
	RouteRevision                 Int                        `json:"routeRevision"`
	RouteAssignment               ParticipantRouteAssignment `json:"routeAssignment"`
	QualitySettings               QualitySettings            `json:"qualitySettings"`
	Role                          Role                       `json:"role"`
	ViewerPasswordEnabled         bool                       `json:"viewerPasswordEnabled"`
}

// AuthenticatedViewerMessage is the viewer member of
// authenticatedMessageSchema.
type AuthenticatedViewerMessage struct {
	Type                          string                     `json:"type"`
	Protocol                      string                     `json:"protocol"`
	PeerID                        string                     `json:"peerId"`
	MaxViewers                    Int                        `json:"maxViewers"`
	EndpointMediaCopyCapacity     Int                        `json:"endpointMediaCopyCapacity"`
	HostOnline                    bool                       `json:"hostOnline"`
	HostPaused                    *bool                      `json:"hostPaused,omitempty"`
	ConnectionID                  *string                    `json:"connectionId"`
	IceConfig                     IceConfig                  `json:"iceConfig"`
	RoutePolicy                   RoutePolicy                `json:"routePolicy"`
	CodeEntryPolicy               CodeEntryPolicy            `json:"codeEntryPolicy"`
	ViewerAuthorizationGeneration string                     `json:"viewerAuthorizationGeneration"`
	MediaMode                     string                     `json:"mediaMode"`
	ShareGeneration               *string                    `json:"shareGeneration"`
	RouteRevision                 Int                        `json:"routeRevision"`
	RouteAssignment               ParticipantRouteAssignment `json:"routeAssignment"`
	QualitySettings               QualitySettings            `json:"qualitySettings"`
	Role                          Role                       `json:"role"`
}

// SharingStartedMessage acknowledges a new media publication on an existing Host session.
type SharingStartedMessage struct {
	Type            string                     `json:"type"`
	ShareGeneration string                     `json:"shareGeneration"`
	RoutePolicy     RoutePolicy                `json:"routePolicy"`
	RouteRevision   Int                        `json:"routeRevision"`
	RouteAssignment ParticipantRouteAssignment `json:"routeAssignment"`
	QualitySettings QualitySettings            `json:"qualitySettings"`
	Paused          bool                       `json:"paused"`
}

type SharingStartFailedMessage struct {
	Type            string `json:"type"`
	ShareGeneration string `json:"shareGeneration"`
	Code            string `json:"code"`
}

// SignalingChallengeResponseMessage is the challenge echo.
type SignalingChallengeResponseMessage struct {
	Type     string `json:"type"`
	Sequence Int    `json:"sequence"`
}

// ServerSignalMessage is the forwarded "signal" message.
type ServerSignalMessage struct {
	Type       string        `json:"type"`
	FromPeerID string        `json:"fromPeerId"`
	Payload    SignalPayload `json:"payload"`
}

// ServerRestartRequestMessage is the forwarded "restart-request" message.
type ServerRestartRequestMessage struct {
	Type         string `json:"type"`
	FromPeerID   string `json:"fromPeerId"`
	ConnectionID string `json:"connectionId"`
	Rebuild      bool   `json:"rebuild"`
}

// RouteUpdatePrepareMessage is the phase "prepare" member of route-update.
type RouteUpdatePrepareMessage struct {
	Type       string                     `json:"type"`
	Revision   Int                        `json:"revision"`
	Phase      string                     `json:"phase"`
	Assignment ParticipantRouteAssignment `json:"assignment"`
	Candidate  PreparedRouteCandidate     `json:"candidate"`
}

// RouteUpdateActiveMessage is the phase "active" member of route-update.
type RouteUpdateActiveMessage struct {
	Type       string                     `json:"type"`
	Revision   Int                        `json:"revision"`
	Phase      string                     `json:"phase"`
	Assignment ParticipantRouteAssignment `json:"assignment"`
}

// RouteStatusMessage is the crossed (state, reason) union: "waiting" pairs
// with "sfu-admission" and "failed" pairs with "route-exhausted".
type RouteStatusMessage struct {
	Type     string `json:"type"`
	Revision Int    `json:"revision"`
	State    string `json:"state"`
	Reason   string `json:"reason"`
}

// RouteDiagnosticSnapshotMessage carries the privacy-safe route snapshot.
type RouteDiagnosticSnapshotMessage struct {
	Type     string                  `json:"type"`
	Snapshot RouteDiagnosticSnapshot `json:"snapshot"`
}

// SfuConfigMessage authorizes one embedded media connection.
type SfuConfigMessage struct {
	Type                  string `json:"type"`
	Revision              Int    `json:"revision"`
	PublicationGeneration string `json:"publicationGeneration"`
	ConnectionID          string `json:"connectionId"`
}

// QualitySettingsMessage broadcasts the host's quality settings.
type QualitySettingsMessage struct {
	Type            string          `json:"type"`
	QualitySettings QualitySettings `json:"qualitySettings"`
}

// RoutePolicyMessage broadcasts the host's route policy.
type RoutePolicyMessage struct {
	Type            string      `json:"type"`
	ShareGeneration string      `json:"shareGeneration"`
	RoutePolicy     RoutePolicy `json:"routePolicy"`
}

// PauseSharingSourceMessage asks the host to pause its capture source.
type PauseSharingSourceMessage struct {
	Type            string `json:"type"`
	ShareGeneration string `json:"shareGeneration"`
}

// ServerViewerQualityEvidenceMessage is the forwarded evidence envelope.
type ServerViewerQualityEvidenceMessage struct {
	Type         string                       `json:"type"`
	ViewerPeerID string                       `json:"viewerPeerId"`
	Upstream     MediaRouteUpstream           `json:"upstream"`
	Guard        ViewerQualityEvidenceGuard   `json:"guard"`
	Sequence     Int                          `json:"sequence"`
	WindowMs     Int                          `json:"windowMs"`
	Metrics      ViewerQualityEvidenceMetrics `json:"metrics"`
}

// HostStatusMessage reports host presence and pause state.
type HostStatusMessage struct {
	Type   string `json:"type"`
	Online bool   `json:"online"`
	Paused bool   `json:"paused"`
}

// ViewerPresenceMessage carries the ordered participant roster.
type ViewerPresenceMessage struct {
	Type    string                     `json:"type"`
	Viewers []ParticipantPresenceEntry `json:"viewers"`
}

// MarshalJSON implements json.Marshaler.
func (v ViewerPresenceMessage) MarshalJSON() ([]byte, error) {
	type raw ViewerPresenceMessage
	value := raw(v)
	if value.Viewers == nil {
		value.Viewers = []ParticipantPresenceEntry{}
	}
	return marshalJSON(value)
}

// ViewerGrantRevokedMessage announces a superseded viewer authorization.
type ViewerGrantRevokedMessage struct {
	Type                          string `json:"type"`
	ViewerAuthorizationGeneration string `json:"viewerAuthorizationGeneration"`
}

// SharingStoppedMessage is { type: "sharing-stopped" }.
type SharingStoppedMessage struct {
	Type string `json:"type"`
}

// RoomClosedMessage is { type: "room-closed", reason }.
type RoomClosedMessage struct {
	Type   string `json:"type"`
	Reason string `json:"reason"`
}

// ErrorMessage is { type: "error", code, message }.
type ErrorMessage struct {
	Type    string `json:"type"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (AuthenticatedHostMessage) isServerMessage()           {}
func (AuthenticatedViewerMessage) isServerMessage()         {}
func (SharingStartedMessage) isServerMessage()              {}
func (SharingStartFailedMessage) isServerMessage()          {}
func (SignalingChallengeResponseMessage) isServerMessage()  {}
func (ServerSignalMessage) isServerMessage()                {}
func (ServerRestartRequestMessage) isServerMessage()        {}
func (RouteUpdatePrepareMessage) isServerMessage()          {}
func (RouteUpdateActiveMessage) isServerMessage()           {}
func (RouteStatusMessage) isServerMessage()                 {}
func (RouteDiagnosticSnapshotMessage) isServerMessage()     {}
func (SfuConfigMessage) isServerMessage()                   {}
func (QualitySettingsMessage) isServerMessage()             {}
func (RoutePolicyMessage) isServerMessage()                 {}
func (PauseSharingSourceMessage) isServerMessage()          {}
func (ServerViewerQualityEvidenceMessage) isServerMessage() {}
func (HostStatusMessage) isServerMessage()                  {}
func (ViewerPresenceMessage) isServerMessage()              {}
func (ViewerGrantRevokedMessage) isServerMessage()          {}
func (SharingStoppedMessage) isServerMessage()              {}
func (RoomClosedMessage) isServerMessage()                  {}
func (ErrorMessage) isServerMessage()                       {}

// EncodeServerMessage serializes one server message with the key order of the
// TypeScript object literal that produces it.
func EncodeServerMessage(message ServerMessage) ([]byte, error) {
	return marshalJSON(message)
}

// DecodeServerMessage supports replaying the shared wire fixture from Go.
// The server never reads its own messages in production.
func DecodeServerMessage(data []byte) (ServerMessage, error) {
	messageType, err := typeOf(data, "type")
	if err != nil {
		return nil, err
	}
	switch messageType {
	case "relay-volunteer":
		return decodeRelayVolunteer(data)
	case "room-voice-state":
		return decodeRoomVoiceState(data)
	case "room-voice-signal":
		return decodeRoomVoiceSignal(data)
	case "room-voice-error":
		return decodeRoomVoiceError(data)
	case "viewer-route-preference":
		return decodeViewerRoutePreference(data)
	case "audio-presence":
		return decodeAudioPresence(data)
	case "co-play-presence":
		return decodeCoPlayPresence(data)
	case "remote-input-peers":
		return decodeRemoteInputPeers(data)
	case "room-interactions-ready":
		return decodeRoomInteractionsReady(data)
	case "room-interaction":
		return decodeRoomInteraction(data)
	case "room-interaction-rejected":
		return decodeRoomInteractionRejected(data)
	case "authenticated":
		return decodeAuthenticated(data)
	case "sharing-started":
		return decodeSharingStarted(data)
	case "sharing-start-failed":
		return decodeSharingStartFailed(data)
	case "signaling-challenge-response":
		return decodeChallengeResponse(data)
	case "signal":
		return decodeServerSignal(data)
	case "restart-request":
		return decodeServerRestartRequest(data)
	case "route-update":
		return decodeRouteUpdate(data)
	case "route-status":
		return decodeRouteStatus(data)
	case "route-diagnostic-snapshot":
		return decodeRouteDiagnosticSnapshotMessage(data)
	case "sfu-config":
		return decodeSfuConfig(data)
	case "sfu-signal":
		return decodeSfuSignal(data)
	case "quality-settings":
		return decodeQualitySettingsMessage(data)
	case "route-policy":
		return decodeRoutePolicyMessage(data)
	case "pause-sharing-source":
		return decodePauseSharingSource(data)
	case "viewer-quality-evidence":
		return decodeServerViewerQualityEvidence(data)
	case "host-status":
		return decodeHostStatus(data)
	case "viewer-presence":
		return decodeViewerPresence(data)
	case "viewer-grant-revoked":
		return decodeViewerGrantRevoked(data)
	case "sharing-stopped":
		return decodeEmptyServerMessage(data, SharingStoppedMessage{Type: messageType})
	case "room-closed":
		return decodeRoomClosed(data)
	case "error":
		return decodeErrorMessage(data)
	}
	return nil, fmt.Errorf("unknown server message type %q", messageType)
}

func decodeEmptyServerMessage(data []byte, message ServerMessage) (ServerMessage, error) {
	var body struct {
		Type string `json:"type"`
	}
	present, err := decodeObject(data, &body)
	if err != nil {
		return nil, err
	}
	if err := present.require("type"); err != nil {
		return nil, err
	}
	return message, nil
}

func validateAuthenticatedBase(
	present fields,
	protocol string, peerID string,
	maxViewers, endpointCapacity Int, connectionID *string,
	codeEntryPolicy, viewerAuthorizationGeneration, mediaMode string,
	shareGeneration *string, routeRevision Int,
) error {
	if err := present.require("type", "protocol", "peerId", "maxViewers",
		"endpointMediaCopyCapacity", "hostOnline", "iceConfig", "codeEntryPolicy",
		"viewerAuthorizationGeneration", "mediaMode", "routeRevision",
		"routeAssignment", "qualitySettings", "role"); err != nil {
		return err
	}
	if err := present.requireNullable(
		"connectionId", "shareGeneration"); err != nil {
		return err
	}
	if err := present.optional("hostPaused", "routePolicy"); err != nil {
		return err
	}
	if protocol != SignalingProtocol {
		return errors.New("protocol is not the current signaling generation")
	}
	if !ValidOpaqueID(peerID) {
		return errors.New("peerId is not an opaque id")
	}
	if !inRangeInt(maxViewers, 1, MaxViewersPerRoomLimit) {
		return errors.New("maxViewers is out of range")
	}
	if !inRangeInt(endpointCapacity, 1, MaxEndpointMediaCopyCapacity) {
		return errors.New("endpointMediaCopyCapacity is out of range")
	}
	if connectionID != nil && !ValidOpaqueID(*connectionID) {
		return errors.New("connectionId is not an opaque id")
	}
	if !enumOf(codeEntryPolicy, CodeEntryOpen, CodeEntryPrivate) {
		return fmt.Errorf("unknown codeEntryPolicy %q", codeEntryPolicy)
	}
	if !ValidOpaqueID(viewerAuthorizationGeneration) {
		return errors.New("viewerAuthorizationGeneration is not an opaque id")
	}
	if mediaMode != "peer-assisted" {
		return errors.New("mediaMode must be peer-assisted")
	}
	if shareGeneration != nil && !ValidOpaqueID(*shareGeneration) {
		return errors.New("shareGeneration is not an opaque id")
	}
	if !validRevision(routeRevision) {
		return errors.New("routeRevision is out of range")
	}
	return nil
}

func decodeAuthenticated(data []byte) (ServerMessage, error) {
	role, err := typeOf(data, "role")
	if err != nil {
		return nil, err
	}
	switch role {
	case RoleHost:
		var message AuthenticatedHostMessage
		present, err := decodeObject(data, &message)
		if err != nil {
			return nil, err
		}
		if err := present.require("viewerPasswordEnabled"); err != nil {
			return nil, err
		}
		if err := validateAuthenticatedBase(present, message.Protocol, message.PeerID,
			message.MaxViewers, message.EndpointMediaCopyCapacity,
			message.ConnectionID, message.CodeEntryPolicy,
			message.ViewerAuthorizationGeneration, message.MediaMode,
			message.ShareGeneration, message.RouteRevision); err != nil {
			return nil, err
		}
		if !present.has("routePolicy") {
			message.RoutePolicy = DefaultRoutePolicy
		}
		return message, nil
	case RoleViewer:
		var message AuthenticatedViewerMessage
		present, err := decodeObject(data, &message)
		if err != nil {
			return nil, err
		}
		if err := validateAuthenticatedBase(present, message.Protocol, message.PeerID,
			message.MaxViewers, message.EndpointMediaCopyCapacity,
			message.ConnectionID, message.CodeEntryPolicy,
			message.ViewerAuthorizationGeneration, message.MediaMode,
			message.ShareGeneration, message.RouteRevision); err != nil {
			return nil, err
		}
		if !present.has("routePolicy") {
			message.RoutePolicy = DefaultRoutePolicy
		}
		return message, nil
	}
	return nil, fmt.Errorf("unknown authenticated role %q", role)
}

func decodeSharingStarted(data []byte) (ServerMessage, error) {
	var message SharingStartedMessage
	present, err := decodeObject(data, &message)
	if err != nil {
		return nil, err
	}
	if err := present.require("type", "shareGeneration", "routePolicy", "routeRevision",
		"routeAssignment", "qualitySettings", "paused"); err != nil {
		return nil, err
	}
	if !ValidOpaqueID(message.ShareGeneration) {
		return nil, errors.New("shareGeneration is not an opaque id")
	}
	if !validRevision(message.RouteRevision) {
		return nil, errors.New("routeRevision is out of range")
	}
	return message, nil
}

func decodeSharingStartFailed(data []byte) (ServerMessage, error) {
	var message SharingStartFailedMessage
	present, err := decodeObject(data, &message)
	if err != nil {
		return nil, err
	}
	if err := present.require("type", "shareGeneration", "code"); err != nil {
		return nil, err
	}
	if !ValidOpaqueID(message.ShareGeneration) || (message.Code != "FORBIDDEN" && message.Code != "SERVER_ERROR") {
		return nil, errors.New("invalid sharing-start-failed response")
	}
	return message, nil
}

func decodeChallengeResponse(data []byte) (ServerMessage, error) {
	var message SignalingChallengeResponseMessage
	present, err := decodeObject(data, &message)
	if err != nil {
		return nil, err
	}
	if err := present.require("type", "sequence"); err != nil {
		return nil, err
	}
	if !inRangeInt(message.Sequence, 0, MaxSafeInteger) {
		return nil, errors.New("sequence is out of range")
	}
	return message, nil
}

func decodeServerSignal(data []byte) (ServerMessage, error) {
	var message ServerSignalMessage
	present, err := decodeObject(data, &message)
	if err != nil {
		return nil, err
	}
	if err := present.require("type", "fromPeerId", "payload"); err != nil {
		return nil, err
	}
	if !ValidOpaqueID(message.FromPeerID) {
		return nil, errors.New("fromPeerId is not an opaque id")
	}
	return message, nil
}

func decodeServerRestartRequest(data []byte) (ServerMessage, error) {
	var message ServerRestartRequestMessage
	present, err := decodeObject(data, &message)
	if err != nil {
		return nil, err
	}
	if err := present.require("type", "fromPeerId", "connectionId", "rebuild"); err != nil {
		return nil, err
	}
	if !ValidOpaqueID(message.FromPeerID) || !ValidOpaqueID(message.ConnectionID) {
		return nil, errors.New("restart-request ids are not opaque ids")
	}
	return message, nil
}

func decodeRouteUpdate(data []byte) (ServerMessage, error) {
	phase, err := typeOf(data, "phase")
	if err != nil {
		return nil, err
	}
	switch phase {
	case "prepare":
		var message RouteUpdatePrepareMessage
		present, err := decodeObject(data, &message)
		if err != nil {
			return nil, err
		}
		if err := present.require(
			"type", "revision", "phase", "assignment", "candidate"); err != nil {
			return nil, err
		}
		if !validRevision(message.Revision) {
			return nil, errors.New("revision is out of range")
		}
		return message, nil
	case "active":
		var message RouteUpdateActiveMessage
		present, err := decodeObject(data, &message)
		if err != nil {
			return nil, err
		}
		if err := present.require("type", "revision", "phase", "assignment"); err != nil {
			return nil, err
		}
		if !validRevision(message.Revision) {
			return nil, errors.New("revision is out of range")
		}
		return message, nil
	}
	return nil, fmt.Errorf("unknown route-update phase %q", phase)
}

func decodeRouteStatus(data []byte) (ServerMessage, error) {
	var message RouteStatusMessage
	present, err := decodeObject(data, &message)
	if err != nil {
		return nil, err
	}
	if err := present.require("type", "revision", "state", "reason"); err != nil {
		return nil, err
	}
	if !validRevision(message.Revision) {
		return nil, errors.New("revision is out of range")
	}
	switch {
	case message.State == "waiting" && message.Reason == "sfu-admission":
	case message.State == "failed" && message.Reason == "route-exhausted":
	default:
		return nil, fmt.Errorf(
			"route-status pairs state %q with reason %q", message.State, message.Reason)
	}
	return message, nil
}

func decodeRouteDiagnosticSnapshotMessage(data []byte) (ServerMessage, error) {
	var message RouteDiagnosticSnapshotMessage
	present, err := decodeObject(data, &message)
	if err != nil {
		return nil, err
	}
	if err := present.require("type", "snapshot"); err != nil {
		return nil, err
	}
	return message, nil
}

func decodeSfuConfig(data []byte) (ServerMessage, error) {
	var message SfuConfigMessage
	present, err := decodeObject(data, &message)
	if err != nil {
		return nil, err
	}
	if err := present.require("type", "revision", "publicationGeneration", "connectionId"); err != nil {
		return nil, err
	}
	if !validRevision(message.Revision) {
		return nil, errors.New("revision is out of range")
	}
	if !ValidOpaqueID(message.PublicationGeneration) || !ValidOpaqueID(message.ConnectionID) {
		return nil, errors.New("invalid SFU connection fence")
	}
	return message, nil
}

func decodeQualitySettingsMessage(data []byte) (ServerMessage, error) {
	var message QualitySettingsMessage
	present, err := decodeObject(data, &message)
	if err != nil {
		return nil, err
	}
	if err := present.require("type", "qualitySettings"); err != nil {
		return nil, err
	}
	return message, nil
}

func decodeRoutePolicyMessage(data []byte) (ServerMessage, error) {
	var message RoutePolicyMessage
	present, err := decodeObject(data, &message)
	if err != nil {
		return nil, err
	}
	if err := present.require("type", "shareGeneration", "routePolicy"); err != nil {
		return nil, err
	}
	if !ValidOpaqueID(message.ShareGeneration) {
		return nil, errors.New("shareGeneration is not an opaque id")
	}
	return message, nil
}

func decodePauseSharingSource(data []byte) (ServerMessage, error) {
	var message PauseSharingSourceMessage
	present, err := decodeObject(data, &message)
	if err != nil {
		return nil, err
	}
	if err := present.require("type", "shareGeneration"); err != nil {
		return nil, err
	}
	if !ValidOpaqueID(message.ShareGeneration) {
		return nil, errors.New("shareGeneration is not an opaque id")
	}
	return message, nil
}

func decodeServerViewerQualityEvidence(data []byte) (ServerMessage, error) {
	var message ServerViewerQualityEvidenceMessage
	present, err := decodeObject(data, &message)
	if err != nil {
		return nil, err
	}
	if err := present.require("type", "viewerPeerId", "upstream", "guard",
		"sequence", "windowMs", "metrics"); err != nil {
		return nil, err
	}
	if !ValidOpaqueID(message.ViewerPeerID) {
		return nil, errors.New("viewerPeerId is not an opaque id")
	}
	// The forwarded envelope narrows the upstream to the active variants.
	if message.Upstream.Kind != "peer" && message.Upstream.Kind != "sfu" {
		return nil, errors.New("forwarded evidence upstream must be peer or sfu")
	}
	if err := validateEvidenceWindow(message.Sequence, message.WindowMs); err != nil {
		return nil, err
	}
	return message, nil
}

func decodeHostStatus(data []byte) (ServerMessage, error) {
	var message HostStatusMessage
	present, err := decodeObject(data, &message)
	if err != nil {
		return nil, err
	}
	if err := present.require("type", "online", "paused"); err != nil {
		return nil, err
	}
	return message, nil
}

func decodeViewerPresence(data []byte) (ServerMessage, error) {
	var message ViewerPresenceMessage
	present, err := decodeObject(data, &message)
	if err != nil {
		return nil, err
	}
	if err := present.require("type", "viewers"); err != nil {
		return nil, err
	}
	if len(message.Viewers) > MaxParticipantsPerRoomLimit {
		return nil, errors.New("viewer presence holds too many entries")
	}
	// superRefine: viewer presence peer IDs must be unique.
	seen := make(map[string]struct{}, len(message.Viewers))
	for _, viewer := range message.Viewers {
		if _, duplicate := seen[viewer.PeerID]; duplicate {
			return nil, errors.New("Viewer presence peer IDs must be unique")
		}
		seen[viewer.PeerID] = struct{}{}
	}
	return message, nil
}

func decodeViewerGrantRevoked(data []byte) (ServerMessage, error) {
	var message ViewerGrantRevokedMessage
	present, err := decodeObject(data, &message)
	if err != nil {
		return nil, err
	}
	if err := present.require("type", "viewerAuthorizationGeneration"); err != nil {
		return nil, err
	}
	if !ValidOpaqueID(message.ViewerAuthorizationGeneration) {
		return nil, errors.New("viewerAuthorizationGeneration is not an opaque id")
	}
	return message, nil
}

func decodeRoomClosed(data []byte) (ServerMessage, error) {
	var message RoomClosedMessage
	present, err := decodeObject(data, &message)
	if err != nil {
		return nil, err
	}
	if err := present.require("type", "reason"); err != nil {
		return nil, err
	}
	if message.Reason != "host-ended" {
		return nil, fmt.Errorf("unknown room-closed reason %q", message.Reason)
	}
	return message, nil
}

func decodeErrorMessage(data []byte) (ServerMessage, error) {
	var message ErrorMessage
	present, err := decodeObject(data, &message)
	if err != nil {
		return nil, err
	}
	if err := present.require("type", "code", "message"); err != nil {
		return nil, err
	}
	if !enumOf(message.Code, errorCodes...) {
		return nil, fmt.Errorf("unknown error code %q", message.Code)
	}
	if length := UTF16Length(message.Message); length < 1 || length > 256 {
		return nil, errors.New("error message length is out of range")
	}
	return message, nil
}
