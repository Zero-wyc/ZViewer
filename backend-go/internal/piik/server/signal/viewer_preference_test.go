package signal

import (
	"testing"
	"time"

	"zviewer/backend/internal/piik/server/protocol"
	"zviewer/backend/internal/piik/server/sfu"
	"zviewer/backend/internal/piik/server/sfu/sfutest"
)

func TestViewerRoutePreferenceOptInPolicyAndReconnect(t *testing.T) {
	h := startHarness(t, harnessOptions{viewerDisconnectGraceMs: 500})
	legacy := openClient(t, h)
	authenticate(t, legacy, h.room, protocol.RoleViewer, "legacy-viewer", -1, "", presenceOptions{})
	if _, ok := legacy.tryNext("viewer-route-preference", 30*time.Millisecond); ok {
		t.Fatal("legacy Viewer received a new message without opting in")
	}
	viewer := openClient(t, h)
	preference := protocol.ViewerRoutePeer
	authenticate(t, viewer, h.room, protocol.RoleViewer, "choice-viewer", -1, "", presenceOptions{routePreference: &preference})
	expectMatch(t, viewer.next("viewer-route-preference").raw, `{"preference":"p2p","accepted":true}`)
	viewer.sendJSON(map[string]any{"type": "set-viewer-route-preference", "preference": "sfu"})
	expectMatch(t, viewer.next("viewer-route-preference").raw, `{"preference":"p2p","accepted":false}`)
	// The rejected choice does not terminate signaling or change the saved intent.
	viewer.sendJSON(map[string]any{"type": "signaling-challenge", "sequence": 1})
	viewer.next("signaling-challenge-response")
	replacement := openClient(t, h)
	authenticate(t, replacement, h.room, protocol.RoleViewer, "choice-viewer", -1, "", presenceOptions{routePreference: &preference})
	expectMatch(t, replacement.next("viewer-route-preference").raw, `{"preference":"p2p","accepted":true}`)
	if _, ok := legacy.tryNext("viewer-route-preference", 30*time.Millisecond); ok {
		t.Fatal("Viewer preference was broadcast to legacy peers")
	}
	host := openClient(t, h)
	authenticate(t, host, h.room, protocol.RoleHost, "choice-host", -1, "", presenceOptions{roomOnly: true, roomSession: true})
	host.sendJSON(map[string]any{"type": "set-viewer-route-preference", "preference": "p2p"})
	expectMatch(t, host.next("error").raw, `{"code":"FORBIDDEN"}`)
}

func TestViewerRoutePreferenceCannotOverrideHostOrSite(t *testing.T) {
	for _, sfuOnly := range []bool{false, true} {
		t.Run(map[bool]string{false: "host-private", true: "site-sfu-only"}[sfuOnly], func(t *testing.T) {
			h := startHarness(t, harnessOptions{sfuOnly: sfuOnly, sfu: &SfuFallback{
				Admission: sfu.NewAdmission(sfu.AdmissionOptions{IngressCapacity: 2, EgressCapacity: 20}),
				Media:     sfutest.New(), PrepareTimeoutMs: 300,
			}})
			viewer := openClient(t, h)
			preference := protocol.ViewerRouteSfu
			if sfuOnly {
				preference = protocol.ViewerRoutePeer
			}
			authenticate(t, viewer, h.room, protocol.RoleViewer, "policy-viewer", -1, "", presenceOptions{routePreference: &preference})
			if sfuOnly {
				expectMatch(t, viewer.next("viewer-route-preference").raw, `{"preference":"auto","accepted":true}`)
			} else {
				expectMatch(t, viewer.next("viewer-route-preference").raw, `{"preference":"sfu","accepted":true}`)
			}
			host := openClient(t, h)
			policy := protocol.DefaultRoutePolicy
			policy.PeerOnly = !sfuOnly
			authenticate(t, host, h.room, protocol.RoleHost, "policy-host", -1, "policy-share-generation", presenceOptions{routePolicy: &policy})
			if !sfuOnly {
				expectMatch(t, viewer.next("viewer-route-preference").raw, `{"preference":"auto","accepted":true}`)
			}
			viewer.sendJSON(map[string]any{"type": "set-viewer-route-preference", "preference": preference})
			expectMatch(t, viewer.next("viewer-route-preference").raw, `{"preference":"auto","accepted":false}`)
		})
	}
}
