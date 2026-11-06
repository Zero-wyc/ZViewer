package protocol

import (
	"encoding/json"
	"errors"
)

// ViewerRoutePreference constrains only this Viewer's incoming media hop.
type ViewerRoutePreference string

const (
	ViewerRouteAuto ViewerRoutePreference = "auto"
	ViewerRoutePeer ViewerRoutePreference = "p2p"
	ViewerRouteSfu  ViewerRoutePreference = "sfu"
)

func (v *ViewerRoutePreference) UnmarshalJSON(data []byte) error {
	var value string
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	switch ViewerRoutePreference(value) {
	case ViewerRouteAuto, ViewerRoutePeer, ViewerRouteSfu:
		*v = ViewerRoutePreference(value)
		return nil
	default:
		return errors.New("invalid viewer route preference")
	}
}

type SetViewerRoutePreferenceMessage struct {
	Type       string                `json:"type"`
	Preference ViewerRoutePreference `json:"preference"`
}

func (SetViewerRoutePreferenceMessage) isClientMessage() {}

func decodeSetViewerRoutePreference(data []byte) (ClientMessage, error) {
	var message SetViewerRoutePreferenceMessage
	present, err := decodeObject(data, &message)
	if err != nil {
		return nil, err
	}
	return message, present.require("type", "preference")
}

// Only a Viewer that opts into route selection receives this reply.
type ViewerRoutePreferenceMessage struct {
	Type       string                `json:"type"`
	Preference ViewerRoutePreference `json:"preference"`
	Accepted   bool                  `json:"accepted"`
}

func (ViewerRoutePreferenceMessage) isServerMessage() {}

func decodeViewerRoutePreference(data []byte) (ServerMessage, error) {
	var message ViewerRoutePreferenceMessage
	present, err := decodeObject(data, &message)
	if err != nil {
		return nil, err
	}
	return message, present.require("type", "preference", "accepted")
}
