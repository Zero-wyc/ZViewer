package protocol

import (
	"encoding/hex"
	"errors"
)

// Grants identify the authenticated input endpoint, not a name or user-chosen
// participant ID. The server resolves the room identity for presentation.
type CoPlayGrant struct {
	EndpointID string `json:"endpointId"`
}

type CoPlayParticipant struct {
	PeerID string `json:"peerId"`
}

func (v *CoPlayGrant) UnmarshalJSON(data []byte) error {
	type wire CoPlayGrant
	var value wire
	fields, err := decodeObject(data, &value)
	if err != nil {
		return err
	}
	if err = fields.require("endpointId"); err != nil {
		return err
	}
	*v = CoPlayGrant(value)
	return nil
}

func (v *CoPlayParticipant) UnmarshalJSON(data []byte) error {
	type wire CoPlayParticipant
	var value wire
	fields, err := decodeObject(data, &value)
	if err != nil {
		return err
	}
	if err = fields.require("peerId"); err != nil {
		return err
	}
	*v = CoPlayParticipant(value)
	return nil
}

type SubscribeCoPlayPresenceMessage struct {
	Type string `json:"type"`
}

func (SubscribeCoPlayPresenceMessage) isClientMessage() {}

type SetCoPlayPresenceMessage struct {
	Type            string        `json:"type"`
	ShareGeneration string        `json:"shareGeneration"`
	Grants          []CoPlayGrant `json:"grants"`
}

func (SetCoPlayPresenceMessage) isClientMessage() {}

type CoPlayPresenceMessage struct {
	Type         string              `json:"type"`
	Participants []CoPlayParticipant `json:"participants"`
}

func (CoPlayPresenceMessage) isServerMessage() {}

func decodeSetCoPlayPresence(data []byte) (ClientMessage, error) {
	var value SetCoPlayPresenceMessage
	fields, err := decodeObject(data, &value)
	if err != nil {
		return nil, err
	}
	if err = fields.require("type", "shareGeneration", "grants"); err != nil {
		return nil, err
	}
	if !ValidOpaqueID(value.ShareGeneration) || len(value.Grants) > MaxViewersPerRoomLimit {
		return nil, errors.New("invalid co-play presence")
	}
	seen := make(map[string]bool, len(value.Grants))
	for _, grant := range value.Grants {
		id, err := hex.DecodeString(grant.EndpointID)
		if err != nil || len(id) != 16 || hex.EncodeToString(id) != grant.EndpointID ||
			seen[grant.EndpointID] {
			return nil, errors.New("invalid co-play endpoint")
		}
		seen[grant.EndpointID] = true
	}
	return value, nil
}

func decodeCoPlayPresence(data []byte) (ServerMessage, error) {
	var value CoPlayPresenceMessage
	fields, err := decodeObject(data, &value)
	if err != nil {
		return nil, err
	}
	if err = fields.require("type", "participants"); err != nil {
		return nil, err
	}
	if len(value.Participants) > MaxViewersPerRoomLimit {
		return nil, errors.New("invalid co-play participants")
	}
	seen := make(map[string]bool, len(value.Participants))
	for _, participant := range value.Participants {
		if !ValidOpaqueID(participant.PeerID) || seen[participant.PeerID] {
			return nil, errors.New("invalid co-play participant")
		}
		seen[participant.PeerID] = true
	}
	return value, nil
}
