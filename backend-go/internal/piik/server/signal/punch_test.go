package signal

import (
	"testing"

	"zviewer/backend/internal/piik/server/protocol"
)

func TestPunchAuthorizationBelongsOnlyToCurrentPeerRetry(t *testing.T) {
	h := newRouterHarness(t, routerHarnessOptions{capacity: 2})
	created := h.createRoom()
	host := h.connectHost(created, &protocol.RoutePolicy{PeerOnly: true, NatPrediction: true}, "", "")
	viewer := h.connectViewer(created, "punch-viewer")
	h.locked(func() { h.doComplete(host); h.doComplete(viewer) })
	for attempt := 1; attempt <= 2; attempt++ {
		prepared := h.waitPreparedMatching(viewer.sessionID, "peer retry", func(message protocol.RouteUpdatePrepareMessage) bool {
			return message.Candidate.ConnectionAttempt != nil && int(message.Candidate.ConnectionAttempt.Current) == attempt
		})
		h.locked(func() {
			base := peerSignalInput{roomID: created.RoomID, sourcePeerID: host.peerID, sourceSessionID: host.sessionID,
				targetPeerID: viewer.peerID, targetSessionID: viewer.sessionID, connectionID: prepared.Candidate.ConnectionID}
			for _, phase := range []string{"prepare", "start", "ready", "complete", "offer"} {
				input := base
				input.signalKind, input.punchPhase = "punch", phase
				if phase == "ready" || phase == "complete" {
					input.sourcePeerID, input.targetPeerID = input.targetPeerID, input.sourcePeerID
					input.sourceSessionID, input.targetSessionID = input.targetSessionID, input.sourceSessionID
				}
				if phase == "offer" {
					input.signalKind, input.punchPhase, input.descriptionType, input.punched = "description", "", "offer", true
				}
				want := signalAuthorizationDenied
				if attempt > 1 {
					want = signalAuthorizationProbe
				}
				if got := h.router.peerSignalAuthorization(input); got != want {
					t.Fatalf("attempt %d %s: got %d want %d", attempt, phase, got, want)
				}
				stale := input
				stale.connectionID = "retired_connection"
				if h.router.peerSignalAuthorization(stale) != signalAuthorizationDenied {
					t.Fatal("stale generation authorized")
				}
				stale = input
				stale.sourceSessionID = "retired_session"
				if h.router.peerSignalAuthorization(stale) != signalAuthorizationDenied {
					t.Fatal("stale session authorized")
				}
				input.sourcePeerID, input.targetPeerID = input.targetPeerID, input.sourcePeerID
				input.sourceSessionID, input.targetSessionID = input.targetSessionID, input.sourceSessionID
				if h.router.peerSignalAuthorization(input) != signalAuthorizationDenied {
					t.Fatalf("wrong phase direction authorized: %s", phase)
				}
			}
			if attempt == 1 {
				h.doFailed(viewer, routeFailedMessage(int64(prepared.Revision), "prepare", prepared.Candidate.ConnectionID))
			} else {
				h.doReady(viewer, int64(prepared.Revision))
				base.signalKind, base.punchPhase = "punch", "prepare"
				if h.router.peerSignalAuthorization(base) != signalAuthorizationDenied {
					t.Fatal("committed edge authorized another preparation")
				}
			}
		})
	}
}
