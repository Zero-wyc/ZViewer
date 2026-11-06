package signal

import (
	"strings"
	"testing"
	"time"

	"zviewer/backend/internal/piik/server/protocol"
)

func TestInputKeysBelongToAuthenticatedRoomEndpoints(t *testing.T) {
	h := startHarness(t, harnessOptions{})
	host, viewer, other := openClient(t, h), openClient(t, h), openClient(t, h)
	authenticate(t, host, h.room, protocol.RoleHost, "host_input_test", -1, "", presenceOptions{})
	actor := authenticate(t, viewer, h.room, protocol.RoleViewer, "viewer_input_test", -1, "", presenceOptions{})
	authenticate(t, other, h.room, protocol.RoleViewer, "other_input_test", -1, "", presenceOptions{})
	key := protocol.SubscribeRemoteInputMessage{Type: "subscribe-remote-input", EndpointID: strings.Repeat("1", 32), Secret: strings.Repeat("2", 64)}
	message := map[string]any{"type": key.Type, "endpointId": key.EndpointID, "secret": key.Secret}
	viewer.sendJSON(message)
	if _, ok := host.tryNext("remote-input-peers", 30*time.Millisecond); ok {
		t.Fatal("unopted Host received a new event")
	}
	host.sendJSON(map[string]any{"type": "subscribe-remote-input"})
	event, err := protocol.DecodeServerMessage(host.next("remote-input-peers").raw)
	if err != nil {
		t.Fatal(err)
	}
	peers := event.(protocol.RemoteInputPeersMessage).Peers
	if len(peers) != 1 || peers[0].PeerID != actor.PeerID || peers[0].Secret != key.Secret {
		t.Fatal("key is not bound to authenticated Viewer")
	}
	other.sendJSON(message)
	if _, ok := other.tryNext("remote-input-peers", 30*time.Millisecond); ok {
		t.Fatal("Viewer received another participant's keys")
	}
	if _, ok := host.tryNext("remote-input-peers", 30*time.Millisecond); ok {
		t.Fatal("second Viewer replaced an occupied endpoint")
	}
	h.closeClient(viewer)
	event, err = protocol.DecodeServerMessage(host.next("remote-input-peers").raw)
	if err != nil || len(event.(protocol.RemoteInputPeersMessage).Peers) != 0 {
		t.Fatal("departure retained input authority")
	}
}

func TestInvitationRevocationRemovesOnlyGrantAdmittedInputKeys(t *testing.T) {
	for name, request := range map[string]protocol.RoomAccessUpdateRequest{
		"rotate": protocol.RotateViewerGrantRequest{Action: "rotate-viewer-grant"},
		"revoke": protocol.RevokeViewerGrantRequest{Action: "revoke-viewer-grant"},
	} {
		t.Run(name, func(t *testing.T) {
			h := startHarness(t, harnessOptions{})
			host, invited, codeViewer := openClient(t, h), openClient(t, h), openClient(t, h)
			authenticate(t, host, h.room, protocol.RoleHost, "host_input_revoke", -1, "", presenceOptions{})
			authenticate(t, invited, h.room, protocol.RoleViewer, "invited_input_revoke", -1, "", presenceOptions{})
			remaining := authenticate(t, codeViewer, h.room, protocol.RoleViewer, "code_input_revoke", -1, "", presenceOptions{codeOnly: true})
			host.sendJSON(map[string]any{"type": "subscribe-remote-input"})
			host.next("remote-input-peers")
			invited.sendJSON(map[string]any{"type": "subscribe-remote-input", "endpointId": strings.Repeat("1", 32), "secret": strings.Repeat("2", 64)})
			host.next("remote-input-peers")
			codeViewer.sendJSON(map[string]any{"type": "subscribe-remote-input", "endpointId": strings.Repeat("3", 32), "secret": strings.Repeat("4", 64)})
			host.next("remote-input-peers")

			h.updateRoomAccess(request)
			invited.next("viewer-grant-revoked")
			event, err := protocol.DecodeServerMessage(host.next("remote-input-peers").raw)
			if err != nil {
				t.Fatal(err)
			}
			peers := event.(protocol.RemoteInputPeersMessage).Peers
			if len(peers) != 1 || peers[0].PeerID != remaining.PeerID || peers[0].Secret != strings.Repeat("4", 64) {
				t.Fatalf("input keys did not follow current room authority: %+v", peers)
			}
		})
	}
}

func TestReplacedViewerCannotRetainInputKeysWithoutSubscribing(t *testing.T) {
	h := startHarness(t, harnessOptions{})
	host, oldViewer := openClient(t, h), openClient(t, h)
	authenticate(t, host, h.room, protocol.RoleHost, "host_input_replace", -1, "", presenceOptions{})
	authenticate(t, oldViewer, h.room, protocol.RoleViewer, "viewer_input_replace", -1, "", presenceOptions{})
	host.sendJSON(map[string]any{"type": "subscribe-remote-input"})
	host.next("remote-input-peers")
	oldViewer.sendJSON(map[string]any{"type": "subscribe-remote-input", "endpointId": strings.Repeat("1", 32), "secret": strings.Repeat("2", 64)})
	host.next("remote-input-peers")

	replacement := openClient(t, h)
	authenticate(t, replacement, h.room, protocol.RoleViewer, "viewer_input_replace", -1, "", presenceOptions{})
	event, err := protocol.DecodeServerMessage(host.next("remote-input-peers").raw)
	if err != nil || len(event.(protocol.RemoteInputPeersMessage).Peers) != 0 {
		t.Fatal("replaced session retained input authority")
	}
}
