package protocol

import "errors"

type RelayVolunteerMessage struct {
	Type     string `json:"type"`
	Enabled  bool   `json:"enabled"`
	Capacity Int    `json:"capacity"`
}

func (RelayVolunteerMessage) isServerMessage() {}

type SetRelayVolunteerMessage RelayVolunteerMessage

func (SetRelayVolunteerMessage) isClientMessage() {}

func decodeRelayVolunteerFields(data []byte) (RelayVolunteerMessage, error) {
	var value RelayVolunteerMessage
	f, err := decodeObject(data, &value)
	if err != nil {
		return value, err
	}
	if err = f.require("type", "enabled", "capacity"); err != nil {
		return value, err
	}
	if !inRangeInt(value.Capacity, 0, MaxViewersPerRoomLimit) {
		return value, errors.New("invalid relay capacity")
	}
	return value, nil
}
func decodeRelayVolunteer(data []byte) (ServerMessage, error) {
	return decodeRelayVolunteerFields(data)
}
func decodeSetRelayVolunteer(data []byte) (ClientMessage, error) {
	value, err := decodeRelayVolunteerFields(data)
	return SetRelayVolunteerMessage(value), err
}
