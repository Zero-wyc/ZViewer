package protocol

import (
	"encoding/hex"
	"errors"
)

// Signaling establishes endpoint identity and the key. Input itself follows
// the media route and never enters room chat, storage or diagnostics.
type SubscribeRemoteInputMessage struct {
	Type       string `json:"type"`
	EndpointID string `json:"endpointId,omitempty"`
	Secret     string `json:"secret,omitempty"`
}

func (SubscribeRemoteInputMessage) isClientMessage() {}

type RemoteInputPeer struct {
	PeerID     string `json:"peerId"`
	EndpointID string `json:"endpointId"`
	Secret     string `json:"secret"`
}
type RemoteInputPeersMessage struct {
	Type  string            `json:"type"`
	Peers []RemoteInputPeer `json:"peers"`
}

func (RemoteInputPeersMessage) isServerMessage() {}

func ValidInputKey(endpoint, secret string) bool {
	id, idErr := hex.DecodeString(endpoint)
	key, keyErr := hex.DecodeString(secret)
	return idErr == nil && keyErr == nil && len(id) == 16 && len(key) == 32 && hex.EncodeToString(id) == endpoint && hex.EncodeToString(key) == secret
}

func decodeSubscribeRemoteInput(data []byte) (ClientMessage, error) {
	var value SubscribeRemoteInputMessage
	fields, err := decodeObject(data, &value)
	if err != nil {
		return nil, err
	}
	if err = fields.require("type"); err != nil {
		return nil, err
	}
	if fields.has("endpointId") || fields.has("secret") {
		if !ValidInputKey(value.EndpointID, value.Secret) {
			return nil, errors.New("invalid input endpoint")
		}
	}
	return value, nil
}

func decodeRemoteInputPeers(data []byte) (ServerMessage, error) {
	var value RemoteInputPeersMessage
	fields, err := decodeObject(data, &value)
	if err != nil {
		return nil, err
	}
	if err = fields.require("type", "peers"); err != nil {
		return nil, err
	}
	if len(value.Peers) > 20 {
		return nil, errors.New("too many input endpoints")
	}
	for _, peer := range value.Peers {
		if !ValidOpaqueID(peer.PeerID) || !ValidInputKey(peer.EndpointID, peer.Secret) {
			return nil, errors.New("invalid input endpoint")
		}
	}
	return value, nil
}
