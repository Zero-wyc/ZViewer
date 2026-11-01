package protocol

import "errors"

// Voice is an opted-in room capability; it does not change the video messages.
type SubscribeRoomVoiceMessage struct {
	Type     string `json:"type"`
	Deafened *bool  `json:"deafened,omitempty"`
	Bitrate  bool   `json:"bitrate,omitempty"`
}

func (SubscribeRoomVoiceMessage) isClientMessage() {}

type RoomVoiceCommand struct {
	Action        string `json:"action"`
	PublicationID string `json:"publicationId,omitempty"`
	Deafened      *bool  `json:"deafened,omitempty"`
	Bitrate       Int    `json:"bitrate,omitempty"`
}

func (v RoomVoiceCommand) MarshalJSON() ([]byte, error) {
	value := map[string]any{"action": v.Action}
	if v.Action == "unpublish" {
		value["publicationId"] = v.PublicationID
	}
	if v.Action == "deafen" {
		value["deafened"] = v.Deafened
	}
	if v.Action == "bitrate" {
		value["bitrate"] = v.Bitrate
	}
	return marshalJSON(value)
}

func (v *RoomVoiceCommand) UnmarshalJSON(data []byte) error {
	type plain RoomVoiceCommand
	f, err := decodeObject(data, (*plain)(v))
	if err != nil {
		return err
	}
	if err = f.require("action"); err != nil {
		return err
	}
	switch v.Action {
	case "bitrate":
		if len(f) != 2 || !f.has("bitrate") || v.Bitrate < MinAudioBitrate || v.Bitrate > MaxAudioBitrate {
			return errors.New("invalid voice bitrate")
		}
	case "deafen":
		if err = f.require("deafened"); err != nil {
			return err
		}
		if len(f) != 2 || v.Deafened == nil {
			return errors.New("invalid voice listening state")
		}
	case "join", "leave", "publish":
		if len(f) != 1 {
			return errors.New("unexpected voice command fields")
		}
	case "unpublish":
		if err = f.require("publicationId"); err != nil {
			return err
		}
		if len(f) != 2 || !ValidOpaqueID(v.PublicationID) {
			return errors.New("invalid voice publication")
		}
	default:
		return errors.New("unknown voice command")
	}
	return nil
}

type RoomVoiceCommandMessage struct {
	Type    string           `json:"type"`
	Command RoomVoiceCommand `json:"command"`
}

func (RoomVoiceCommandMessage) isClientMessage() {}

type VoiceTrack struct {
	MID           string `json:"mid"`
	PublicationID string `json:"publicationId"`
}

func (v *VoiceTrack) UnmarshalJSON(data []byte) error {
	type plain VoiceTrack
	f, err := decodeObject(data, (*plain)(v))
	if err != nil {
		return err
	}
	if err = f.require("mid", "publicationId"); err != nil {
		return err
	}
	if len(v.MID) < 1 || len(v.MID) > 128 || !ValidOpaqueID(v.PublicationID) {
		return errors.New("invalid voice track")
	}
	return nil
}

type VoiceDescription struct {
	Revision Int                `json:"revision"`
	SDP      SessionDescription `json:"sdp"`
	Tracks   []VoiceTrack       `json:"tracks"`
}

func (v *VoiceDescription) UnmarshalJSON(data []byte) error {
	type plain VoiceDescription
	f, err := decodeObject(data, (*plain)(v))
	if err != nil {
		return err
	}
	if err = f.require("revision", "sdp", "tracks"); err != nil {
		return err
	}
	if v.Revision < 1 || len(v.Tracks) > MaxParticipantsPerRoomLimit*2 {
		return errors.New("invalid voice description")
	}
	return nil
}

type RoomVoiceSignalMessage struct {
	Type         string            `json:"type"`
	ConnectionID string            `json:"connectionId"`
	Description  *VoiceDescription `json:"description,omitempty"`
	Candidate    *IceCandidate     `json:"candidate,omitempty"`
	Renegotiate  bool              `json:"renegotiate,omitempty"`
}

func (RoomVoiceSignalMessage) isClientMessage() {}
func (RoomVoiceSignalMessage) isServerMessage() {}

type RoomVoiceTransportMessage struct {
	Type         string `json:"type"`
	ConnectionID string `json:"connectionId"`
	State        string `json:"state"`
}

func (RoomVoiceTransportMessage) isClientMessage() {}

type VoiceMember struct {
	PeerID        string             `json:"peerId"`
	Connected     bool               `json:"connected"`
	Joined        bool               `json:"joined"`
	Upstream      MediaRouteUpstream `json:"upstream"`
	PublicationID string             `json:"publicationId,omitempty"`
	Deafened      *bool              `json:"deafened,omitempty"`
}
type VoicePublication struct {
	ID     string `json:"id"`
	PeerID string `json:"peerId"`
}
type VoiceConnection struct {
	ConnectionID string   `json:"connectionId"`
	ParentPeerID string   `json:"parentPeerId,omitempty"`
	ChildPeerID  string   `json:"childPeerId"`
	Transport    string   `json:"transport"`
	Pending      bool     `json:"pending"`
	Revision     Int      `json:"revision"`
	Send         []string `json:"send"`
	Receive      []string `json:"receive"`
}
type RoomVoiceStateMessage struct {
	Type         string             `json:"type"`
	Bitrate      Int                `json:"bitrate,omitempty"`
	Revision     Int                `json:"revision"`
	Enabled      bool               `json:"enabled"`
	HostPeerID   *string            `json:"hostPeerId"`
	Members      []VoiceMember      `json:"members"`
	Publications []VoicePublication `json:"publications"`
	Connections  []VoiceConnection  `json:"connections"`
	Unavailable  []string           `json:"unavailable"`
}

func (RoomVoiceStateMessage) isServerMessage() {}

type RoomVoiceErrorMessage struct {
	Type string `json:"type"`
	Code string `json:"code"`
}

func (RoomVoiceErrorMessage) isServerMessage() {}

func decodeRoomVoiceCommand(data []byte) (ClientMessage, error) {
	var v RoomVoiceCommandMessage
	f, err := decodeObject(data, &v)
	if err != nil {
		return nil, err
	}
	if err = f.require("type", "command"); err != nil {
		return nil, err
	}
	return v, nil
}
func decodeRoomVoiceSignal(data []byte) (RoomVoiceSignalMessage, error) {
	var v RoomVoiceSignalMessage
	f, err := decodeObject(data, &v)
	if err != nil {
		return v, err
	}
	if err = f.require("type", "connectionId"); err != nil {
		return v, err
	}
	if err = f.optional("description", "candidate", "renegotiate"); err != nil {
		return v, err
	}
	n := 0
	if v.Description != nil {
		n++
	}
	if v.Candidate != nil {
		n++
	}
	if v.Renegotiate {
		n++
	}
	if !ValidOpaqueID(v.ConnectionID) || n != 1 || f.has("renegotiate") && !v.Renegotiate {
		return v, errors.New("invalid voice signal")
	}
	return v, nil
}
func decodeRoomVoiceTransport(data []byte) (ClientMessage, error) {
	var v RoomVoiceTransportMessage
	f, err := decodeObject(data, &v)
	if err != nil {
		return nil, err
	}
	if err = f.require("type", "connectionId", "state"); err != nil {
		return nil, err
	}
	if !ValidOpaqueID(v.ConnectionID) || !enumOf(v.State, "connected", "failed") {
		return nil, errors.New("invalid voice transport")
	}
	return v, nil
}
func decodeRoomVoiceState(data []byte) (ServerMessage, error) {
	var v RoomVoiceStateMessage
	f, err := decodeObject(data, &v)
	if err != nil {
		return nil, err
	}
	if err = f.require("type", "revision", "enabled", "members", "publications", "connections", "unavailable"); err != nil {
		return nil, err
	}
	if err = f.requireNullable("hostPeerId"); err != nil {
		return nil, err
	}
	if f.has("bitrate") && (v.Bitrate < MinAudioBitrate || v.Bitrate > MaxAudioBitrate) {
		return nil, errors.New("invalid voice bitrate")
	}
	if !validRevision(v.Revision) || v.HostPeerID != nil && !ValidOpaqueID(*v.HostPeerID) || len(v.Members) > MaxParticipantsPerRoomLimit ||
		len(v.Publications) > MaxParticipantsPerRoomLimit || len(v.Connections) > MaxParticipantsPerRoomLimit+1 || len(v.Unavailable) > MaxParticipantsPerRoomLimit {
		return nil, errors.New("invalid voice state")
	}
	return v, nil
}
func decodeRoomVoiceError(data []byte) (ServerMessage, error) {
	var v RoomVoiceErrorMessage
	f, err := decodeObject(data, &v)
	if err != nil {
		return nil, err
	}
	if err = f.require("type", "code"); err != nil {
		return nil, err
	}
	if !enumOf(v.Code, "not-allowed", "not-enabled", "connection-unavailable") {
		return nil, errors.New("invalid voice error")
	}
	return v, nil
}
