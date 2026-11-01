package signal

import (
	"testing"

	"zviewer/backend/internal/piik/server/protocol"
	"zviewer/backend/internal/piik/server/route"
	"zviewer/backend/internal/piik/server/sfu"
	"zviewer/backend/internal/piik/server/sfu/sfutest"
)

func TestRoomVoicePolicyFollowsNewShareOnStartAndHostAuthentication(t *testing.T) {
	for _, transition := range []string{"start", "authenticate"} {
		t.Run(transition, func(t *testing.T) {
			h := startHarness(t, harnessOptions{
				sfu: &SfuFallback{Media: sfutest.New(), Admission: sfu.NewAdmission(sfu.AdmissionOptions{
					IngressCapacity: 1, EgressCapacity: 2,
				})},
			})
			host, viewer := openClient(t, h), openClient(t, h)
			authenticate(t, host, h.room, protocol.RoleHost, "policy_owner_host_123456", -1, "",
				presenceOptions{roomSession: true, roomOnly: true})
			preference := protocol.ViewerRouteSfu
			viewerID := authenticate(t, viewer, h.room, protocol.RoleViewer, "policy_owner_viewer_123456", 0, "",
				presenceOptions{routePreference: &preference})
			host.sendJSON(map[string]any{"type": "subscribe-room-voice"})
			nextVoiceState(t, host, nil)
			voiceCommand(host, map[string]any{"action": "join"})
			nextVoiceState(t, host, func(state protocol.RoomVoiceStateMessage) bool {
				return len(state.Members) == 1 && state.Members[0].Joined
			})
			var previous *route.Controller
			h.locked(func() {
				rm, _ := h.server.router.rooms.Get(h.room.RoomID)
				previous = rm.controller
				if !previous.AllowsViewerRoutePreference(protocol.ViewerRouteSfu) {
					t.Fatal("voice room did not begin with available SFU")
				}
			})
			policy := protocol.RoutePolicy{PeerOnly: true}
			if transition == "start" {
				host.sendJSON(map[string]any{"type": "start-sharing", "shareGeneration": "policy_share_123456",
					"qualitySettings": protocol.DefaultQualitySettings, "routePolicy": policy, "sharingPaused": false})
				host.next("sharing-started")
			} else {
				replacement := openClient(t, h)
				authenticate(t, replacement, h.room, protocol.RoleHost, "policy_owner_host_123456", -1, "policy_share_123456",
					presenceOptions{roomSession: true, routePolicy: &policy})
			}
			h.locked(func() {
				rm, _ := h.server.router.rooms.Get(h.room.RoomID)
				if rm.controller != previous || rm.controller.AllowsViewerRoutePreference(protocol.ViewerRouteSfu) {
					t.Fatal("new share failed to update policy on retained room controller")
				}
				settings, _ := rm.viewerSettings.Get(viewerID.PeerID)
				if settings.preference != protocol.ViewerRouteAuto {
					t.Fatal("new peer-only policy retained incompatible Viewer SFU preference")
				}
			})
			for {
				message, err := protocol.DecodeServerMessage(viewer.next("viewer-route-preference").raw)
				if err != nil {
					t.Fatal(err)
				}
				if message.(protocol.ViewerRoutePreferenceMessage).Preference == protocol.ViewerRouteAuto {
					break
				}
			}
			prepared := nextPreparedRoute(t, viewer)
			if prepared.Candidate.Transport != "direct" {
				t.Fatal("peer-only publication prepared SFU video")
			}
		})
	}
}
