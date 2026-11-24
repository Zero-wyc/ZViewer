package protocol

import "errors"

type RelayVolunteerMessage struct {
	Type         string `json:"type"`
	Enabled      bool   `json:"enabled"`
	Capacity     Int    `json:"capacity"`
	RoomCapacity *Int   `json:"roomCapacity,omitempty"`
}

func (RelayVolunteerMessage) isServerMessage() {}

type SetRelayVolunteerMessage struct {
	Type             string `json:"type"`
	Enabled          bool   `json:"enabled"`
	Capacity         Int    `json:"capacity"`
	Settings         bool   `json:"settings,omitempty"`
	PhysicalCapacity *Int   `json:"physicalCapacity,omitempty"`
}

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
	if err = f.optional("roomCapacity"); err != nil {
		return value, err
	}
	if value.RoomCapacity != nil && !inRangeInt(*value.RoomCapacity, 1, MaxViewersPerRoomLimit) {
		return value, errors.New("invalid room relay capacity")
	}
	return value, nil
}
func decodeRelayVolunteer(data []byte) (ServerMessage, error) {
	return decodeRelayVolunteerFields(data)
}
func decodeSetRelayVolunteer(data []byte) (ClientMessage, error) {
	var value SetRelayVolunteerMessage
	f, err := decodeObject(data, &value)
	if err != nil {
		return nil, err
	}
	if err = f.require("type", "enabled", "capacity"); err != nil {
		return nil, err
	}
	if err = f.optional("settings", "physicalCapacity"); err != nil {
		return nil, err
	}
	if !inRangeInt(value.Capacity, 0, MaxViewersPerRoomLimit) {
		return nil, errors.New("invalid relay capacity")
	}
	if value.Settings != (value.PhysicalCapacity != nil) {
		return nil, errors.New("relay settings require physical capacity")
	}
	if value.PhysicalCapacity != nil && !inRangeInt(*value.PhysicalCapacity, 0, MaxViewersPerRoomLimit) {
		return nil, errors.New("invalid physical relay capacity")
	}
	return value, nil
}
