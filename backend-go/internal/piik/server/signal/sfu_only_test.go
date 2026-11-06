package signal

import (
	"testing"

	"zviewer/backend/internal/piik/server/protocol"
	"zviewer/backend/internal/piik/server/sfu"
	"zviewer/backend/internal/piik/server/sfu/sfutest"
)

func TestSFUOnlyRejectsPeerOnlyBeforeAcquiringShareAuthority(t *testing.T) {
	h := startHarness(t, harnessOptions{sfuOnly: true, natPredictionEnabled: true,
		sfu: &SfuFallback{Media: sfutest.New(), Admission: sfu.NewAdmission(sfu.AdmissionOptions{IngressCapacity: 2, EgressCapacity: 20})}})
	policy := protocol.RoutePolicy{PeerOnly: true, TopologyOptimization: true, NatPrediction: true}
	rejected := openClient(t, h)
	rejected.sendJSON(map[string]any{"type": "authenticate", "protocol": protocol.SignalingProtocol,
		"roomId": h.room.RoomID, "role": "host", "clientId": "old-peer-only-host",
		"token": h.room.HostToken, "routePolicy": policy})
	expectMatch(t, rejected.next("error").raw, `{"code":"FORBIDDEN"}`)
	expectCloseCode(t, rejected, int(protocol.SignalCloseAuthenticationFailed))

	// An idle room remains available. Refusing a conflicting share preserves it.
	host := openClient(t, h)
	authenticate(t, host, h.room, protocol.RoleHost, "idle-host", -1, "",
		presenceOptions{roomSession: true, roomOnly: true, routePolicy: &policy})
	host.sendJSON(map[string]any{"type": "start-sharing", "shareGeneration": "sfu_only_share_generation",
		"routePolicy": policy})
	expectMatch(t, host.next("sharing-start-failed").raw, `{"code":"FORBIDDEN"}`)
	policy.PeerOnly = false
	host.sendJSON(map[string]any{"type": "start-sharing", "shareGeneration": "sfu_only_share_generation",
		"routePolicy": policy})
	expectMatch(t, host.next("sharing-started").raw,
		`{"routePolicy":{"peerOnly":false,"topologyOptimization":false,"natPrediction":false}}`)
}
