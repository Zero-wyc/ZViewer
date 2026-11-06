package protocol

import (
	"errors"
	"fmt"
)

// ClientMessage is one member of clientMessageSchema. The interface is sealed:
// only the message structs in this file implement it.
type ClientMessage interface {
	isClientMessage()
}

// AuthenticateHostMessage is the host member of authenticateMessageSchema.
type AuthenticateHostMessage struct {
	Type            string           `json:"type"`
	Protocol        string           `json:"protocol"`
	RoomID          string           `json:"roomId"`
	Role            Role             `json:"role"`
	Token           string           `json:"token"`
	ClientID        string           `json:"clientId"`
	ShareGeneration string           `json:"shareGeneration,omitempty"`
	SharingPaused   *bool            `json:"sharingPaused,omitempty"`
	QualitySettings *QualitySettings `json:"qualitySettings,omitempty"`
	RoutePolicy     RoutePolicy      `json:"routePolicy"`
	ViewerPresence  bool             `json:"viewerPresence,omitempty"`
	DisplayName     *DisplayName     `json:"displayName,omitempty"`
	RoomOnly        bool             `json:"roomOnly,omitempty"`
	RoomSession     bool             `json:"roomSession,omitempty"`
}

// AuthenticateViewerMessage is the viewer member of authenticateMessageSchema.
type AuthenticateViewerMessage struct {
	Type            string                 `json:"type"`
	Protocol        string                 `json:"protocol"`
	RoomID          string                 `json:"roomId"`
	Role            Role                   `json:"role"`
	ClientID        string                 `json:"clientId"`
	ViewerGrant     string                 `json:"viewerGrant,omitempty"`
	ViewerPassword  string                 `json:"viewerPassword,omitempty"`
	DisplayName     *DisplayName           `json:"displayName,omitempty"`
	ViewerPresence  bool                   `json:"viewerPresence,omitempty"`
	RoutePreference *ViewerRoutePreference `json:"routePreference,omitempty"`
}

// SignalingChallengeMessage is { type: "signaling-challenge", sequence }.
type SignalingChallengeMessage struct {
	Type     string `json:"type"`
	Sequence Int    `json:"sequence"`
}

// ClientSignalMessage is the client "signal" message.
type ClientSignalMessage struct {
	Type         string        `json:"type"`
	TargetPeerID string        `json:"targetPeerId,omitempty"`
	Payload      SignalPayload `json:"payload"`
}

// ClientRestartRequestMessage is the client "restart-request" message.
type ClientRestartRequestMessage struct {
	Type         string `json:"type"`
	TargetPeerID string `json:"targetPeerId,omitempty"`
	ConnectionID string `json:"connectionId"`
	Rebuild      bool   `json:"rebuild"`
}

// SetQualitySettingsMessage is { type: "set-quality-settings", qualitySettings }.
type SetQualitySettingsMessage struct {
	Type            string          `json:"type"`
	QualitySettings QualitySettings `json:"qualitySettings"`
}

// RelayCapacityMessage is { type: "relay-capacity", downstreamEdges }.
type RelayCapacityMessage struct {
	Type            string `json:"type"`
	DownstreamEdges Int    `json:"downstreamEdges"`
}

// RouteReadyMessage is { type: "route-ready", revision, phase, qualityApproved? }.
type RouteReadyMessage struct {
	Type            string `json:"type"`
	Revision        Int    `json:"revision"`
	Phase           string `json:"phase"`
	QualityApproved bool   `json:"qualityApproved,omitempty"`
}

// RouteTransportConnectedMessage is the "route-transport-connected" message.
type RouteTransportConnectedMessage struct {
	Type         string `json:"type"`
	Revision     Int    `json:"revision"`
	ConnectionID string `json:"connectionId"`
}

// RouteMediaUnavailableMessage is the "route-media-unavailable" message.
type RouteMediaUnavailableMessage struct {
	Type     string `json:"type"`
	Revision Int    `json:"revision"`
}

// RouteFailedMessage is { type: "route-failed", revision, phase, connectionId }.
type RouteFailedMessage struct {
	Type         string  `json:"type"`
	Revision     Int     `json:"revision"`
	Phase        string  `json:"phase"`
	ConnectionID *string `json:"connectionId"`
}

// RefreshSfuMessage is { type: "refresh-sfu", revision }.
type RefreshSfuMessage struct {
	Type     string `json:"type"`
	Revision Int    `json:"revision"`
}

// RequestRouteDiagnosticMessage is { type: "request-route-diagnostic" }.
type RequestRouteDiagnosticMessage struct {
	Type string `json:"type"`
}

// ViewerQualityEvidenceMessage is viewerQualityEvidenceMessageSchema.
type ViewerQualityEvidenceMessage struct {
	Type     string                       `json:"type"`
	Guard    ViewerQualityEvidenceGuard   `json:"guard"`
	Sequence Int                          `json:"sequence"`
	WindowMs Int                          `json:"windowMs"`
	Metrics  ViewerQualityEvidenceMetrics `json:"metrics"`
}

// SenderQualityEvidenceMessage is senderQualityEvidenceMessageSchema.
type SenderQualityEvidenceMessage struct {
	Type              string                   `json:"type"`
	ChildPeerID       string                   `json:"childPeerId"`
	ConnectionID      string                   `json:"connectionId"`
	RtpStatsID        *string                  `json:"rtpStatsId"`
	TrackIdentifier   *string                  `json:"trackIdentifier"`
	SampleTimestampMs *Num                     `json:"sampleTimestampMs"`
	RouteRevision     Int                      `json:"routeRevision"`
	State             string                   `json:"state"`
	Diagnostics       SenderQualityDiagnostics `json:"diagnostics"`
}

// SfuPublisherQualityEvidenceMessage is
// sfuPublisherQualityEvidenceMessageSchema.
type SfuPublisherQualityEvidenceMessage struct {
	Type                  string                   `json:"type"`
	PublicationGeneration string                   `json:"publicationGeneration"`
	RouteRevision         Int                      `json:"routeRevision"`
	State                 string                   `json:"state"`
	SampleTimestampMs     *Num                     `json:"sampleTimestampMs"`
	Diagnostics           SenderQualityDiagnostics `json:"diagnostics"`
}

// ResetSenderQualityMessage is { type: "reset-sender-quality" }.
type ResetSenderQualityMessage struct {
	Type string `json:"type"`
}

// SetDisplayNameMessage is { type: "set-display-name", displayName }.
type SetDisplayNameMessage struct {
	Type        string      `json:"type"`
	DisplayName DisplayName `json:"displayName"`
}

// SetSharingPausedMessage is { type: "set-sharing-paused", shareGeneration, paused }.
type SetSharingPausedMessage struct {
	Type            string `json:"type"`
	ShareGeneration string `json:"shareGeneration"`
	Paused          bool   `json:"paused"`
}

// StopSharingMessage is { type: "stop-sharing", shareGeneration? }.
type StopSharingMessage struct {
	Type            string `json:"type"`
	ShareGeneration string `json:"shareGeneration,omitempty"`
}

// StartSharingMessage begins a new media publication on an existing Host room session.
type StartSharingMessage struct {
	Type            string           `json:"type"`
	ShareGeneration string           `json:"shareGeneration"`
	SharingPaused   bool             `json:"sharingPaused,omitempty"`
	QualitySettings *QualitySettings `json:"qualitySettings,omitempty"`
	RoutePolicy     RoutePolicy      `json:"routePolicy"`
}

// AbandonRoomMessage is { type: "abandon-room" }.
type AbandonRoomMessage struct {
	Type string `json:"type"`
}

func (AuthenticateHostMessage) isClientMessage()            {}
func (AuthenticateViewerMessage) isClientMessage()          {}
func (SignalingChallengeMessage) isClientMessage()          {}
func (ClientSignalMessage) isClientMessage()                {}
func (ClientRestartRequestMessage) isClientMessage()        {}
func (SetQualitySettingsMessage) isClientMessage()          {}
func (RelayCapacityMessage) isClientMessage()               {}
func (RouteReadyMessage) isClientMessage()                  {}
func (RouteTransportConnectedMessage) isClientMessage()     {}
func (RouteMediaUnavailableMessage) isClientMessage()       {}
func (RouteFailedMessage) isClientMessage()                 {}
func (RefreshSfuMessage) isClientMessage()                  {}
func (RequestRouteDiagnosticMessage) isClientMessage()      {}
func (ViewerQualityEvidenceMessage) isClientMessage()       {}
func (SenderQualityEvidenceMessage) isClientMessage()       {}
func (SfuPublisherQualityEvidenceMessage) isClientMessage() {}
func (ResetSenderQualityMessage) isClientMessage()          {}
func (SetDisplayNameMessage) isClientMessage()              {}
func (SetSharingPausedMessage) isClientMessage()            {}
func (StopSharingMessage) isClientMessage()                 {}
func (StartSharingMessage) isClientMessage()                {}
func (AbandonRoomMessage) isClientMessage()                 {}

// DecodeClientMessage parses JSON and validates the message schema.
// Every member carries a distinct `type` literal, so that key resolves the union.
func DecodeClientMessage(data []byte) (ClientMessage, error) {
	messageType, err := typeOf(data, "type")
	if err != nil {
		return nil, err
	}
	switch messageType {
	case "set-relay-volunteer":
		return decodeSetRelayVolunteer(data)
	case "subscribe-room-voice":
		var v SubscribeRoomVoiceMessage
		f, err := decodeObject(data, &v)
		if err != nil {
			return nil, err
		}
		if err = f.require("type"); err != nil {
			return nil, err
		}
		if err = f.optional("deafened", "bitrate"); err != nil {
			return nil, err
		}
		if f.has("bitrate") && !v.Bitrate {
			return nil, errors.New("invalid voice subscription")
		}
		return v, nil
	case "room-voice-command":
		return decodeRoomVoiceCommand(data)
	case "room-voice-signal":
		return decodeRoomVoiceSignal(data)
	case "room-voice-transport":
		return decodeRoomVoiceTransport(data)
	case "set-viewer-route-preference":
		return decodeSetViewerRoutePreference(data)
	case "subscribe-audio-presence":
		return decodeEmptyClientMessage(data, SubscribeAudioPresenceMessage{Type: messageType})
	case "subscribe-co-play-presence":
		return decodeEmptyClientMessage(data, SubscribeCoPlayPresenceMessage{Type: messageType})
	case "set-co-play-presence":
		return decodeSetCoPlayPresence(data)
	case "set-audio-presence":
		return decodeSetAudioPresence(data)
	case "subscribe-remote-input":
		return decodeSubscribeRemoteInput(data)
	case "subscribe-room-interactions":
		return decodeEmptyClientMessage(data, SubscribeRoomInteractionsMessage{Type: messageType})
	case "send-room-interaction":
		return decodeSendRoomInteraction(data)
	case "authenticate":
		return decodeAuthenticate(data)
	case "signaling-challenge":
		return decodeSignalingChallenge(data)
	case "signal":
		return decodeClientSignal(data)
	case "restart-request":
		return decodeClientRestartRequest(data)
	case "set-quality-settings":
		return decodeSetQualitySettings(data)
	case "relay-capacity":
		return decodeRelayCapacity(data)
	case "route-ready":
		return decodeRouteReady(data)
	case "route-transport-connected":
		return decodeRouteTransportConnected(data)
	case "route-media-unavailable":
		return decodeRouteMediaUnavailable(data)
	case "route-failed":
		return decodeRouteFailed(data)
	case "refresh-sfu":
		return decodeRefreshSfu(data)
	case "sfu-signal":
		return decodeSfuSignal(data)
	case "request-route-diagnostic":
		return decodeEmptyClientMessage(data, RequestRouteDiagnosticMessage{Type: messageType})
	case "viewer-quality-evidence":
		return decodeViewerQualityEvidence(data)
	case "sender-quality-evidence":
		return decodeSenderQualityEvidence(data)
	case "sfu-publisher-quality-evidence":
		return decodeSfuPublisherQualityEvidence(data)
	case "reset-sender-quality":
		return decodeEmptyClientMessage(data, ResetSenderQualityMessage{Type: messageType})
	case "set-display-name":
		return decodeSetDisplayName(data)
	case "set-sharing-paused":
		return decodeSetSharingPaused(data)
	case "stop-sharing":
		return decodeStopSharing(data)
	case "start-sharing":
		return decodeStartSharing(data)
	case "abandon-room":
		return decodeEmptyClientMessage(data, AbandonRoomMessage{Type: messageType})
	}
	return nil, fmt.Errorf("unknown client message type %q", messageType)
}

func decodeEmptyClientMessage(data []byte, message ClientMessage) (ClientMessage, error) {
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

func decodeAuthenticate(data []byte) (ClientMessage, error) {
	role, err := typeOf(data, "role")
	if err != nil {
		return nil, err
	}
	switch role {
	case RoleHost:
		var message AuthenticateHostMessage
		present, err := decodeObject(data, &message)
		if err != nil {
			return nil, err
		}
		if err := present.require("type", "protocol", "roomId", "role", "token", "clientId"); err != nil {
			return nil, err
		}
		if err := present.optional("shareGeneration", "roomOnly", "roomSession", "sharingPaused", "qualitySettings",
			"routePolicy", "viewerPresence", "displayName"); err != nil {

			return nil, err
		}
		if message.Protocol != SignalingProtocol {
			return nil, errors.New("protocol is not the current signaling generation")
		}
		if !ValidRoomCode(message.RoomID) {
			return nil, errors.New("roomId is not a room code")
		}
		if !ValidToken(message.Token) {
			return nil, errors.New("token is malformed")
		}
		if !ValidOpaqueID(message.ClientID) {
			return nil, errors.New("clientId is not an opaque id")
		}
		if present.has("shareGeneration") && !ValidOpaqueID(message.ShareGeneration) {
			return nil, errors.New("shareGeneration is not an opaque id")
		}
		if present.has("roomOnly") && !message.RoomOnly {
			return nil, errors.New("roomOnly must be true when present")
		}
		if present.has("roomSession") && !message.RoomSession {
			return nil, errors.New("roomSession must be true when present")
		}
		if message.RoomOnly && !message.RoomSession {
			return nil, errors.New("roomOnly requires roomSession")
		}
		if present.has("viewerPresence") && !message.ViewerPresence {
			return nil, errors.New("viewerPresence must be true when present")
		}
		if !present.has("routePolicy") {
			message.RoutePolicy = DefaultRoutePolicy
		}
		return message, nil
	case RoleViewer:
		var message AuthenticateViewerMessage
		present, err := decodeObject(data, &message)
		if err != nil {
			return nil, err
		}
		if err := present.require("type", "protocol", "roomId", "role", "clientId"); err != nil {
			return nil, err
		}
		if err := present.optional(
			"viewerGrant", "viewerPassword", "displayName", "viewerPresence", "routePreference"); err != nil {
			return nil, err
		}
		if message.Protocol != SignalingProtocol {
			return nil, errors.New("protocol is not the current signaling generation")
		}
		if !ValidRoomCode(message.RoomID) {
			return nil, errors.New("roomId is not a room code")
		}
		if !ValidOpaqueID(message.ClientID) {
			return nil, errors.New("clientId is not an opaque id")
		}
		if present.has("viewerGrant") && !ValidViewerGrant(message.ViewerGrant) {
			return nil, errors.New("viewerGrant is malformed")
		}
		if present.has("viewerPassword") && !ValidViewerPassword(message.ViewerPassword) {
			return nil, errors.New("viewerPassword is malformed")
		}
		if present.has("viewerPresence") && !message.ViewerPresence {
			return nil, errors.New("viewerPresence must be true when present")
		}
		return message, nil
	}
	return nil, fmt.Errorf("unknown authenticate role %q", role)
}

func decodeSignalingChallenge(data []byte) (ClientMessage, error) {
	var message SignalingChallengeMessage
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

func decodeClientSignal(data []byte) (ClientMessage, error) {
	var message ClientSignalMessage
	present, err := decodeObject(data, &message)
	if err != nil {
		return nil, err
	}
	if err := present.require("type", "payload"); err != nil {
		return nil, err
	}
	if err := present.optional("targetPeerId"); err != nil {
		return nil, err
	}
	if present.has("targetPeerId") && !ValidOpaqueID(message.TargetPeerID) {
		return nil, errors.New("targetPeerId is not an opaque id")
	}
	return message, nil
}

func decodeClientRestartRequest(data []byte) (ClientMessage, error) {
	var message ClientRestartRequestMessage
	present, err := decodeObject(data, &message)
	if err != nil {
		return nil, err
	}
	if err := present.require("type", "connectionId", "rebuild"); err != nil {
		return nil, err
	}
	if err := present.optional("targetPeerId"); err != nil {
		return nil, err
	}
	if present.has("targetPeerId") && !ValidOpaqueID(message.TargetPeerID) {
		return nil, errors.New("targetPeerId is not an opaque id")
	}
	if !ValidOpaqueID(message.ConnectionID) {
		return nil, errors.New("connectionId is not an opaque id")
	}
	return message, nil
}

func decodeSetQualitySettings(data []byte) (ClientMessage, error) {
	var message SetQualitySettingsMessage
	present, err := decodeObject(data, &message)
	if err != nil {
		return nil, err
	}
	if err := present.require("type", "qualitySettings"); err != nil {
		return nil, err
	}
	return message, nil
}

func decodeRelayCapacity(data []byte) (ClientMessage, error) {
	var message RelayCapacityMessage
	present, err := decodeObject(data, &message)
	if err != nil {
		return nil, err
	}
	if err := present.require("type", "downstreamEdges"); err != nil {
		return nil, err
	}
	if !inRangeInt(message.DownstreamEdges, 0, MaxEndpointMediaCopyCapacity) {
		return nil, errors.New("downstreamEdges is out of range")
	}
	return message, nil
}

func decodeRouteReady(data []byte) (ClientMessage, error) {
	var message RouteReadyMessage
	present, err := decodeObject(data, &message)
	if err != nil {
		return nil, err
	}
	if err := present.require("type", "revision", "phase"); err != nil {
		return nil, err
	}
	if err := present.optional("qualityApproved"); err != nil {
		return nil, err
	}
	if !validRevision(message.Revision) {
		return nil, errors.New("revision is out of range")
	}
	if !enumOf(message.Phase, mediaRoutePhases...) {
		return nil, fmt.Errorf("unknown phase %q", message.Phase)
	}
	if present.has("qualityApproved") && !message.QualityApproved {
		return nil, errors.New("qualityApproved must be true when present")
	}
	return message, nil
}

func decodeRouteTransportConnected(data []byte) (ClientMessage, error) {
	var message RouteTransportConnectedMessage
	present, err := decodeObject(data, &message)
	if err != nil {
		return nil, err
	}
	if err := present.require("type", "revision", "connectionId"); err != nil {
		return nil, err
	}
	if !validRevision(message.Revision) {
		return nil, errors.New("revision is out of range")
	}
	if !ValidOpaqueID(message.ConnectionID) {
		return nil, errors.New("connectionId is not an opaque id")
	}
	return message, nil
}

func decodeRouteMediaUnavailable(data []byte) (ClientMessage, error) {
	var message RouteMediaUnavailableMessage
	present, err := decodeObject(data, &message)
	if err != nil {
		return nil, err
	}
	if err := present.require("type", "revision"); err != nil {
		return nil, err
	}
	if !validRevision(message.Revision) {
		return nil, errors.New("revision is out of range")
	}
	return message, nil
}

func decodeRouteFailed(data []byte) (ClientMessage, error) {
	var message RouteFailedMessage
	present, err := decodeObject(data, &message)
	if err != nil {
		return nil, err
	}
	if err := present.require("type", "revision", "phase"); err != nil {
		return nil, err
	}
	if err := present.requireNullable("connectionId"); err != nil {
		return nil, err
	}
	if !validRevision(message.Revision) {
		return nil, errors.New("revision is out of range")
	}
	if !enumOf(message.Phase, mediaRoutePhases...) {
		return nil, fmt.Errorf("unknown phase %q", message.Phase)
	}
	if message.ConnectionID != nil && !ValidOpaqueID(*message.ConnectionID) {
		return nil, errors.New("connectionId is not an opaque id")
	}
	return message, nil
}

func decodeRefreshSfu(data []byte) (ClientMessage, error) {
	var message RefreshSfuMessage
	present, err := decodeObject(data, &message)
	if err != nil {
		return nil, err
	}
	if err := present.require("type", "revision"); err != nil {
		return nil, err
	}
	if !validRevision(message.Revision) {
		return nil, errors.New("revision is out of range")
	}
	return message, nil
}

func decodeViewerQualityEvidence(data []byte) (ClientMessage, error) {
	var message ViewerQualityEvidenceMessage
	present, err := decodeObject(data, &message)
	if err != nil {
		return nil, err
	}
	if err := present.require("type", "guard", "sequence", "windowMs", "metrics"); err != nil {
		return nil, err
	}
	if err := validateEvidenceWindow(message.Sequence, message.WindowMs); err != nil {
		return nil, err
	}
	return message, nil
}

func validateEvidenceWindow(sequence, windowMs Int) error {
	if !inRangeInt(sequence, 0, MaxSafeInteger) {
		return errors.New("sequence is out of range")
	}
	if !inRangeInt(windowMs, 1_000, 5_000) {
		return errors.New("windowMs is out of range")
	}
	return nil
}

func decodeSenderQualityEvidence(data []byte) (ClientMessage, error) {
	var message SenderQualityEvidenceMessage
	present, err := decodeObject(data, &message)
	if err != nil {
		return nil, err
	}
	if err := present.require("type", "childPeerId", "connectionId", "routeRevision",
		"state", "diagnostics"); err != nil {
		return nil, err
	}
	if err := present.requireNullable(
		"rtpStatsId", "trackIdentifier", "sampleTimestampMs"); err != nil {
		return nil, err
	}
	if !ValidOpaqueID(message.ChildPeerID) || !ValidOpaqueID(message.ConnectionID) {
		return nil, errors.New("sender quality evidence ids are not opaque ids")
	}
	if err := boundedIdentity(message.RtpStatsID, "rtpStatsId"); err != nil {
		return nil, err
	}
	if err := boundedIdentity(message.TrackIdentifier, "trackIdentifier"); err != nil {
		return nil, err
	}
	if message.SampleTimestampMs != nil &&
		!inRangeNum(*message.SampleTimestampMs, 0, MaxSafeInteger) {
		return nil, errors.New("sampleTimestampMs is out of range")
	}
	if !validRevision(message.RouteRevision) {
		return nil, errors.New("routeRevision is out of range")
	}
	if !enumOf(message.State, senderQualityStates...) {
		return nil, fmt.Errorf("unknown sender quality state %q", message.State)
	}
	// superRefine: known sender quality needs exact RTP identity.
	if message.State != "unknown" &&
		(message.RtpStatsID == nil || message.TrackIdentifier == nil ||
			message.SampleTimestampMs == nil) {
		return nil, errors.New("Known sender quality needs exact RTP identity")
	}
	if err := senderQualityReasonMatchesState(
		message.State, message.Diagnostics.Reason,
		"Sender quality reason must match its native state"); err != nil {
		return nil, err
	}
	return message, nil
}

func decodeSfuPublisherQualityEvidence(data []byte) (ClientMessage, error) {
	var message SfuPublisherQualityEvidenceMessage
	present, err := decodeObject(data, &message)
	if err != nil {
		return nil, err
	}
	if err := present.require(
		"type", "publicationGeneration", "routeRevision", "state", "diagnostics"); err != nil {
		return nil, err
	}
	if err := present.requireNullable("sampleTimestampMs"); err != nil {
		return nil, err
	}
	if !ValidOpaqueID(message.PublicationGeneration) {
		return nil, errors.New("publicationGeneration is not an opaque id")
	}
	if !validRevision(message.RouteRevision) {
		return nil, errors.New("routeRevision is out of range")
	}
	if !enumOf(message.State, senderQualityStates...) {
		return nil, fmt.Errorf("unknown sfu publisher quality state %q", message.State)
	}
	if message.SampleTimestampMs != nil &&
		!inRangeNum(*message.SampleTimestampMs, 0, MaxSafeInteger) {
		return nil, errors.New("sampleTimestampMs is out of range")
	}
	// superRefine: known SFU publisher quality needs an exact sample.
	if message.State != "unknown" && message.SampleTimestampMs == nil {
		return nil, errors.New("Known SFU publisher quality needs an exact sample")
	}
	if err := senderQualityReasonMatchesState(
		message.State, message.Diagnostics.Reason,
		"SFU publisher reason must match its native state"); err != nil {
		return nil, err
	}
	return message, nil
}

func senderQualityReasonMatchesState(state string, reason *string, message string) error {
	value := ""
	if reason != nil {
		value = *reason
	}
	invalid := (state == "healthy" && value != "none") ||
		(state == "degraded" && value != "bandwidth" && value != "cpu") ||
		(state == "unknown" && reason != nil)
	if invalid {
		return errors.New(message)
	}
	return nil
}

func boundedIdentity(value *string, key string) error {
	if value == nil {
		return nil
	}
	if length := UTF16Length(*value); length < 1 || length > 256 {
		return fmt.Errorf("%s length is out of range", key)
	}
	return nil
}

func decodeSetDisplayName(data []byte) (ClientMessage, error) {
	var message SetDisplayNameMessage
	present, err := decodeObject(data, &message)
	if err != nil {
		return nil, err
	}
	if err := present.require("type", "displayName"); err != nil {
		return nil, err
	}
	return message, nil
}

func decodeSetSharingPaused(data []byte) (ClientMessage, error) {
	var message SetSharingPausedMessage
	present, err := decodeObject(data, &message)
	if err != nil {
		return nil, err
	}
	if err := present.require("type", "shareGeneration", "paused"); err != nil {
		return nil, err
	}
	if !ValidOpaqueID(message.ShareGeneration) {
		return nil, errors.New("shareGeneration is not an opaque id")
	}
	return message, nil
}

func decodeStopSharing(data []byte) (ClientMessage, error) {
	var message StopSharingMessage
	present, err := decodeObject(data, &message)
	if err != nil {
		return nil, err
	}
	if err := present.require("type"); err != nil {
		return nil, err
	}
	if err := present.optional("shareGeneration"); err != nil {
		return nil, err
	}
	if present.has("shareGeneration") && !ValidOpaqueID(message.ShareGeneration) {
		return nil, errors.New("shareGeneration is not an opaque id")
	}
	return message, nil
}

func decodeStartSharing(data []byte) (ClientMessage, error) {
	var message StartSharingMessage
	present, err := decodeObject(data, &message)
	if err != nil {
		return nil, err
	}
	if err := present.require("type", "shareGeneration", "routePolicy"); err != nil {
		return nil, err
	}
	if err := present.optional("sharingPaused", "qualitySettings"); err != nil {
		return nil, err
	}
	if !ValidOpaqueID(message.ShareGeneration) {
		return nil, errors.New("shareGeneration is not an opaque id")
	}
	return message, nil
}
