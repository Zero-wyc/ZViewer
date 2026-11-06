package protocol

import "errors"

type SubscribeAudioPresenceMessage struct {
	Type string `json:"type"`
}

func (SubscribeAudioPresenceMessage) isClientMessage() {}

type SetAudioPresenceMessage struct {
	Type            string `json:"type"`
	ShareGeneration string `json:"shareGeneration"`
	Available       bool   `json:"available"`
}

func (SetAudioPresenceMessage) isClientMessage() {}

// Nil means an older Host has not supplied input availability.
type AudioPresenceMessage struct {
	Type      string `json:"type"`
	Available *bool  `json:"available"`
}

func (AudioPresenceMessage) isServerMessage() {}

func decodeSetAudioPresence(data []byte) (ClientMessage, error) {
	var value SetAudioPresenceMessage
	fields, err := decodeObject(data, &value)
	if err != nil {
		return nil, err
	}
	if err = fields.require("type", "shareGeneration", "available"); err != nil {
		return nil, err
	}
	if !ValidOpaqueID(value.ShareGeneration) {
		return nil, errors.New("invalid share generation")
	}
	return value, nil
}

func decodeAudioPresence(data []byte) (ServerMessage, error) {
	var value AudioPresenceMessage
	fields, err := decodeObject(data, &value)
	if err != nil {
		return nil, err
	}
	if err = fields.require("type"); err != nil {
		return nil, err
	}
	if err = fields.requireNullable("available"); err != nil {
		return nil, err
	}
	return value, nil
}
