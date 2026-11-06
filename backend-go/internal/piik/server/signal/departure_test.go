package signal

import (
	"slices"
	"testing"

	"zviewer/backend/internal/piik/server/protocol"
	"zviewer/backend/internal/piik/server/room"
	"zviewer/backend/internal/piik/server/sfu"
	"zviewer/backend/internal/piik/server/sfu/sfutest"
)

func TestPausedGrantRevocationRetiresCommittedMedia(t *testing.T) {
	for _, transport := range []string{"peer", "sfu"} {
		t.Run(transport, func(t *testing.T) {
			media := sfutest.New()
			admission := sfu.NewAdmission(sfu.AdmissionOptions{IngressCapacity: 1, EgressCapacity: 2})
			h := startHarness(t, harnessOptions{sfu: &SfuFallback{Media: media, Admission: admission}})
			host, viewer := openClient(t, h), openClient(t, h)
			hostAuth := authenticate(t, host, h.room, protocol.RoleHost, "departure_host_12345678", 1, "", presenceOptions{})
			authenticate(t, viewer, h.room, protocol.RoleViewer, "departure_viewer_12345678", 1, "", presenceOptions{})
			if transport == "sfu" {
				direct := nextPreparedRoute(t, viewer)
				viewer.sendJSON(map[string]any{"type": "route-failed", "revision": direct.Revision, "phase": "prepare", "connectionId": direct.Candidate.ConnectionID})
			}
			active := commitPreparedRoute(t, viewer)
			setSharingPaused(host, *hostAuth.ShareGeneration, true)
			if !waitFor(t, defaultWait, func() bool {
				paused := false
				h.locked(func() {
					rm, _ := h.server.router.rooms.Get(h.room.RoomID)
					paused = rm.controller.Snapshot().Paused
				})
				return paused
			}) {
				t.Fatal("sharing did not pause")
			}

			h.updateRoomAccess(protocol.RevokeViewerGrantRequest{Action: "revoke-viewer-grant"})
			viewer.next("viewer-grant-revoked")
			expectCloseCode(t, viewer, 4004)
			if !waitFor(t, defaultWait, func() bool {
				retired := false
				h.locked(func() {
					rm, _ := h.server.router.rooms.Get(h.room.RoomID)
					snapshot := rm.controller.Snapshot()
					retired = snapshot.UpstreamByViewer.Len() == 0 && snapshot.Revision > int64(active.Revision) && admission.Usage() == (sfu.Usage{})
				})
				return retired
			}) {
				t.Fatal("revoked viewer retained media authority while sharing was paused")
			}
			if transport == "sfu" && len(media.Deleted()) != 1 {
				t.Fatal("orphaned publication and its subscriptions were not physically closed")
			}
		})
	}
}

func TestRevokedRelayRetiresMediaBeforeChildRecovery(t *testing.T) {
	for _, mode := range []string{"active", "paused", "host-offline"} {
		t.Run(mode, func(t *testing.T) {
			h := newRouterHarness(t, routerHarnessOptions{capacity: 1, withSfu: true})
			created := h.createRoom()
			host, first, _ := h.establishSfuRoom(created)
			h.settle()
			var child authenticatedRouteParticipant
			var fence sfu.SubscriptionFence
			h.locked(func() {
				admitted, err := h.store.ConnectParticipant(room.ConnectParticipantInput{
					RoomID: created.RoomID, Role: protocol.RoleViewer,
					ClientID: "code_child_12345678", SessionID: "code_session_12345678",
				})
				if err != nil {
					t.Fatal(err)
				}
				child = authenticatedRouteParticipant{roomID: created.RoomID, role: protocol.RoleViewer, peerID: admitted.PeerID, sessionID: "code_session_12345678"}
				h.doRelay(first, 1)
				h.doComplete(child)
				rm, _ := h.router.rooms.Get(created.RoomID)
				edge, _ := rm.controller.Snapshot().UpstreamByViewer.Get(first.peerID)
				fence = subscriptionFence(edge.Resource)
			})
			prepared := h.waitPreparedTransport(child.sessionID, "direct")
			h.routeReady(child, int64(prepared.Revision))
			h.settle()
			h.locked(func() {
				if h.doMustEdge(created.RoomID, child.peerID).upstream.PeerID != first.peerID {
					t.Fatal("child must initially attach to the grant-admitted relay")
				}
				if mode == "paused" {
					h.router.setPaused(created.RoomID, true)
				}
				if mode == "host-offline" {
					h.doDisconnect(host)
				}
				update, err := h.store.SetViewerGrant(created.RoomID, "revoke", created.HostToken)
				if err != nil {
					t.Fatal(err)
				}
				for _, viewer := range update.RevokedViewers {
					h.router.removeViewer(created.RoomID, viewer.PeerID)
				}
			})
			h.settle()
			h.locked(func() {
				if h.admission.HasSubscription(fence) {
					t.Fatal("revoked relay still holds an admitted subscription")
				}
				if _, ok := h.store.GetConnectedViewer(created.RoomID, child.peerID); !ok {
					t.Fatal("grant revocation must preserve the code-admitted child")
				}
			})
			if !slices.Contains(h.media.DrainedSubscriptions(), fence) && !slices.Contains(h.media.Deleted(), fence.ResourceFence) {
				t.Fatal("neither the exact subscription nor its publication was physically closed")
			}
		})
	}
}
