package protocol

import (
	"errors"
	"fmt"
)

// CreateRoomRequest mirrors createRoomRequestSchema.
type CreateRoomRequest struct {
	CodeEntryPolicy CodeEntryPolicy  `json:"codeEntryPolicy"`
	RoomPassword    Nullable[string] `json:"roomPassword,omitzero"`
	PreferredRoomID string           `json:"preferredRoomId,omitempty"`
}

// DecodeCreateRoomRequest parses createRoomRequestSchema.
func DecodeCreateRoomRequest(data []byte) (CreateRoomRequest, error) {
	var request CreateRoomRequest
	present, err := decodeObject(data, &request)
	if err != nil {
		return CreateRoomRequest{}, err
	}
	if err := present.require("codeEntryPolicy"); err != nil {
		return CreateRoomRequest{}, err
	}
	if err := present.optional("preferredRoomId"); err != nil {
		return CreateRoomRequest{}, err
	}
	if !enumOf(request.CodeEntryPolicy, CodeEntryOpen, CodeEntryPrivate) {
		return CreateRoomRequest{}, fmt.Errorf(
			"unknown codeEntryPolicy %q", request.CodeEntryPolicy)
	}
	if request.RoomPassword.Value != nil && !ValidViewerPassword(*request.RoomPassword.Value) {
		return CreateRoomRequest{}, errors.New("roomPassword is malformed")
	}
	if present.has("preferredRoomId") && !ValidRoomCode(request.PreferredRoomID) {
		return CreateRoomRequest{}, errors.New("preferredRoomId is not a room code")
	}
	return request, nil
}

// ReplaceRoomRequest mirrors replaceRoomRequestSchema.
type ReplaceRoomRequest struct {
	CodeEntryPolicy CodeEntryPolicy  `json:"codeEntryPolicy"`
	RoomPassword    Nullable[string] `json:"roomPassword,omitzero"`
}

// DecodeReplaceRoomRequest parses replaceRoomRequestSchema.
func DecodeReplaceRoomRequest(data []byte) (ReplaceRoomRequest, error) {
	var request ReplaceRoomRequest
	present, err := decodeObject(data, &request)
	if err != nil {
		return ReplaceRoomRequest{}, err
	}
	if err := present.require("codeEntryPolicy"); err != nil {
		return ReplaceRoomRequest{}, err
	}
	if !enumOf(request.CodeEntryPolicy, CodeEntryOpen, CodeEntryPrivate) {
		return ReplaceRoomRequest{}, fmt.Errorf(
			"unknown codeEntryPolicy %q", request.CodeEntryPolicy)
	}
	if request.RoomPassword.Value != nil && !ValidViewerPassword(*request.RoomPassword.Value) {
		return ReplaceRoomRequest{}, errors.New("roomPassword is malformed")
	}
	return request, nil
}

// RoomAccessUpdateRequest is one member of roomAccessUpdateRequestSchema.
type RoomAccessUpdateRequest interface {
	isRoomAccessUpdateRequest()
}

// SetCodeEntryPolicyRequest is action "set-code-entry-policy".
type SetCodeEntryPolicyRequest struct {
	Action string          `json:"action"`
	Policy CodeEntryPolicy `json:"policy"`
}

// RotateViewerGrantRequest is action "rotate-viewer-grant".
type RotateViewerGrantRequest struct {
	Action string `json:"action"`
}

// RevokeViewerGrantRequest is action "revoke-viewer-grant".
type RevokeViewerGrantRequest struct {
	Action string `json:"action"`
}

// SetViewerPasswordRequest is action "set-viewer-password".
type SetViewerPasswordRequest struct {
	Action   string  `json:"action"`
	Password *string `json:"password"`
}

func (SetCodeEntryPolicyRequest) isRoomAccessUpdateRequest() {}
func (RotateViewerGrantRequest) isRoomAccessUpdateRequest()  {}
func (RevokeViewerGrantRequest) isRoomAccessUpdateRequest()  {}
func (SetViewerPasswordRequest) isRoomAccessUpdateRequest()  {}

// DecodeRoomAccessUpdateRequest parses roomAccessUpdateRequestSchema.
func DecodeRoomAccessUpdateRequest(data []byte) (RoomAccessUpdateRequest, error) {
	action, err := typeOf(data, "action")
	if err != nil {
		return nil, err
	}
	switch action {
	case "set-code-entry-policy":
		var request SetCodeEntryPolicyRequest
		present, err := decodeObject(data, &request)
		if err != nil {
			return nil, err
		}
		if err := present.require("action", "policy"); err != nil {
			return nil, err
		}
		if !enumOf(request.Policy, CodeEntryOpen, CodeEntryPrivate) {
			return nil, fmt.Errorf("unknown policy %q", request.Policy)
		}
		return request, nil
	case "rotate-viewer-grant":
		var request RotateViewerGrantRequest
		present, err := decodeObject(data, &request)
		if err != nil {
			return nil, err
		}
		if err := present.require("action"); err != nil {
			return nil, err
		}
		return request, nil
	case "revoke-viewer-grant":
		var request RevokeViewerGrantRequest
		present, err := decodeObject(data, &request)
		if err != nil {
			return nil, err
		}
		if err := present.require("action"); err != nil {
			return nil, err
		}
		return request, nil
	case "set-viewer-password":
		var request SetViewerPasswordRequest
		present, err := decodeObject(data, &request)
		if err != nil {
			return nil, err
		}
		if err := present.require("action"); err != nil {
			return nil, err
		}
		if err := present.requireNullable("password"); err != nil {
			return nil, err
		}
		if request.Password != nil && !ValidViewerPassword(*request.Password) {
			return nil, errors.New("password is malformed")
		}
		return request, nil
	}
	return nil, fmt.Errorf("unknown room access action %q", action)
}

// CreateRoomResponse mirrors createRoomResponseSchema.
type CreateRoomResponse struct {
	RoomID          string          `json:"roomId"`
	HostToken       string          `json:"hostToken"`
	InviteURL       string          `json:"inviteUrl"`
	CodeEntryPolicy CodeEntryPolicy `json:"codeEntryPolicy"`
}

// RoomAccessUpdateResponse is one member of roomAccessUpdateResponseSchema.
type RoomAccessUpdateResponse interface {
	isRoomAccessUpdateResponse()
}

// CodeEntryPolicyUpdatedResponse is type "code-entry-policy-updated".
type CodeEntryPolicyUpdatedResponse struct {
	Type                  string          `json:"type"`
	CodeEntryPolicy       CodeEntryPolicy `json:"codeEntryPolicy"`
	ViewerPasswordEnabled bool            `json:"viewerPasswordEnabled"`
}

// ViewerGrantUpdatedResponse is type "viewer-grant-updated". InviteURL is nil
// for the explicit null a revoke returns.
type ViewerGrantUpdatedResponse struct {
	Type                          string  `json:"type"`
	ViewerAuthorizationGeneration string  `json:"viewerAuthorizationGeneration"`
	InviteURL                     *string `json:"inviteUrl"`
}

// ViewerPasswordUpdatedResponse is type "viewer-password-updated".
type ViewerPasswordUpdatedResponse struct {
	Type    string `json:"type"`
	Enabled bool   `json:"enabled"`
}

func (CodeEntryPolicyUpdatedResponse) isRoomAccessUpdateResponse() {}
func (ViewerGrantUpdatedResponse) isRoomAccessUpdateResponse()     {}
func (ViewerPasswordUpdatedResponse) isRoomAccessUpdateResponse()  {}
