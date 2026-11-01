package signal

import (
	"strings"
	"testing"

	"zviewer/backend/internal/piik/server/protocol"
)

func TestSignalRebuildSupersedesOverlappingQualityPreparation(t *testing.T) {
	for _, order := range []string{"prepare-before-restart", "restart-before-prepare"} {
		t.Run(order, func(t *testing.T) {
			h := startHarness(t, harnessOptions{endpointMediaCopyCapacity: 2})
			host := openClient(t, h)
			hostAuth := authenticate(t, host, h.room, protocol.RoleHost, "recovery-host", 1,
				testShareGeneration, presenceOptions{routePolicy: qualityPolicy})
			viewer := openClient(t, h)
			viewerAuth := authenticate(t, viewer, h.room, protocol.RoleViewer, "recovery-viewer", 0, "", presenceOptions{})
			commitPreparedRoute(t, viewer)
			var active activeViewerMediaEdge
			var hostSession, viewerSession string
			h.locked(func() {
				parent, _ := h.store.GetConnectedHost(h.room.RoomID)
				child, _ := h.store.GetConnectedViewer(h.room.RoomID, viewerAuth.PeerID)
				hostSession, viewerSession = parent.SessionID, child.SessionID
				active, _ = h.server.router.resolveActiveViewerMediaEdge(h.room.RoomID, viewerAuth.PeerID)
			})
			restart := func() {
				viewer.sendJSON(map[string]any{"type": "restart-request", "targetPeerId": hostAuth.PeerID,
					"connectionId": active.connectionID, "rebuild": true})
				expectMatch(t, host.next("restart-request").raw, `{"rebuild":true}`)
			}
			if order == "restart-before-prepare" {
				restart()
			}
			h.locked(func() {
				participant := authenticatedRouteParticipant{roomID: h.room.RoomID, role: protocol.RoleHost,
					peerID: hostAuth.PeerID, sessionID: hostSession, routePolicy: qualityPolicy}
				for index, state := range []string{"healthy", "degraded", "degraded", "degraded"} {
					h.server.router.observeSenderQualityEvidence(participant, senderEvidenceMessage(
						viewerAuth.PeerID, active.connectionID, "recovery-sender", "recovery-track",
						float64(100+index), active.revision, state))
				}
			})
			pending := nextPreparedRoute(t, viewer)
			if !pending.Candidate.QualityProbe || pending.Assignment.Upstream != protocol.PeerUpstream(hostAuth.PeerID) {
				t.Fatal("expected a same-parent quality preparation")
			}
			if !strings.HasPrefix(active.connectionID, candidateConnectionIDPrefix) ||
				!strings.HasPrefix(pending.Candidate.ConnectionID, candidateConnectionIDPrefix) {
				t.Fatal("prepared connections must remain distinguishable after retirement")
			}
			if order == "prepare-before-restart" {
				restart()
			}

			// A same-parent probe must not intercept the retained connection's
			// offer, answer or ICE. The probe's own signaling also stays valid.
			host.sendJSON(signalDescription(viewerAuth.PeerID, active.connectionID, "offer"))
			expectMatch(t, viewer.next("signal").raw, `{"payload":{"connectionId":"`+active.connectionID+`"}}`)
			viewer.sendJSON(signalDescription(hostAuth.PeerID, active.connectionID, "answer"))
			host.next("signal")
			viewer.sendJSON(signalCandidate(hostAuth.PeerID, active.connectionID))
			host.next("signal")
			host.sendJSON(signalDescription(viewerAuth.PeerID, pending.Candidate.ConnectionID, "offer"))
			expectMatch(t, viewer.next("signal").raw, `{"payload":{"connectionId":"`+pending.Candidate.ConnectionID+`"}}`)

			const replacement = "manual_replacement_connection"
			host.sendJSON(signalDescription(viewerAuth.PeerID, replacement, "offer"))
			expectMatch(t, viewer.next("signal").raw, `{"payload":{"connectionId":"`+replacement+`"}}`)
			settled := nextActiveRouteAfter(t, viewer, pending.Revision)
			if settled.Assignment.Upstream != active.upstream {
				t.Fatal("manual recovery must keep the committed parent")
			}
			viewer.sendJSON(signalDescription(hostAuth.PeerID, replacement, "answer"))
			host.next("signal")

			h.locked(func() {
				rm, _ := h.server.router.rooms.Get(h.room.RoomID)
				if rm.controller.Snapshot().Operation != nil {
					t.Fatal("superseded preparation must release the serial operation")
				}
				for _, retired := range []string{pending.Candidate.ConnectionID, active.connectionID} {
					authorization := h.server.router.peerSignalAuthorization(peerSignalInput{
						roomID: h.room.RoomID, sourcePeerID: hostAuth.PeerID, sourceSessionID: hostSession,
						targetPeerID: viewerAuth.PeerID, targetSessionID: viewerSession,
						connectionID: retired, signalKind: "description", descriptionType: "offer",
					})
					if authorization != signalAuthorizationDenied {
						t.Fatal("a late retired offer must not replace the recovered connection")
					}
				}
				current, _ := h.server.router.resolveActiveViewerMediaEdge(h.room.RoomID, viewerAuth.PeerID)
				if current.connectionID != replacement || current.revision != settled.Revision {
					t.Fatalf("recovered edge = %+v", current)
				}
			})
		})
	}
}
