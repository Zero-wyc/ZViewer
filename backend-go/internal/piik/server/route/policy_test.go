package route

import (
	"testing"

	"zviewer/backend/internal/piik/server/protocol"
)

func TestRoomPolicyPeerOnlyRepairsRetainedSfuBeforeVideoAttachment(t *testing.T) {
	routes := newController(2, Options{SfuEnabled: true, QualityConvergenceEnabled: true})
	addViewer(routes, A, 0, nil)
	routes.hydrateHostPublication("room-publication", res("publication"), "old-publisher")
	routes.hydrateEdge(A, sfuEdge("room-publication", "room-a", "subscription"))
	routes.SetViewerRoutePreference(A, sessionOf(A), protocol.ViewerRouteSfu, ms(0))
	routes.SetVideoPublication("", false, 1)
	routes.SetVoiceListeners([]string{HOST, A}, 2)
	eq(t, len(routes.SetRoutePolicy(protocol.RoutePolicy{PeerOnly: true, NatPrediction: true}, 3)), 0)
	viewer, _ := routes.participants.Get(A)
	eq(t, viewer.routePreference, protocol.ViewerRouteAuto)
	eq(t, routes.qualityConvergenceEnabled, false)
	eq(t, routes.natPredictionEnabled, true)
	routes.SetVideoPublication("peer-only-share", false, 4)
	op := must(t, routes.Reconcile(5).Operation)
	eq(t, op.Reason, DemandEdgeUnavailable)
	eq(t, op.Candidates[0].Tuple.Kind, UpstreamPeer)
	eq(t, edgeOf(t, routes, A).ConnectionID, "room-a")
	eq(t, edgeOf(t, routes, A).Usable, true)
	prepared := beginOperation(t, routes, BeginInput{NowMs: 6, ConnectionID: "peer-a", Reservation: direct()})
	eq(t, prepared.Current.ConnectionAttempt.Current, 1)
	guard := guardFor(A, prepared.Current.Revision, "peer-a")
	settled := routes.CandidateReady(guard, 7, nil, CandidateProof{VideoGeneration: "peer-only-share"})
	eq(t, settled.Committed, true)
	eqSlice(t, labels(settled.Released), []string{"subscription", "publication"})
	eq(t, edgeOf(t, routes, A).Kind, UpstreamPeer)
	eq(t, edgeOf(t, routes, A).VideoGeneration, "peer-only-share")
	eq(t, routes.Snapshot().HostPublication == nil, true)
	noOperation(t, routes.Reconcile(8).Operation)
}

func TestRoomPolicyChangeCancelsOldAttachmentAndSamePolicyDoesNotCancelWork(t *testing.T) {
	routes := newController(2, Options{SfuEnabled: true})
	addViewer(routes, A, 0, nil)
	routes.hydrateHostPublication("publication", res("publication"), "publisher")
	routes.hydrateEdge(A, sfuEdge("publication", "room-a", "subscription"))
	routes.SetVideoPublication("", false, 1)
	routes.SetVideoPublication("share", false, 2)
	late := beginVideoAttach(t, routes, 3, A, "sfu-video-a")
	routes.SetRoutePolicy(protocol.RoutePolicy{PeerOnly: true}, 4)
	eq(t, routes.CandidateReady(late, 5, nil, CandidateProof{VideoGeneration: "share"}).Accepted, false)
	op := must(t, routes.Reconcile(6).Operation)
	eq(t, op.Candidates[0].Tuple.Kind, UpstreamPeer)
	prepared := beginOperation(t, routes, BeginInput{NowMs: 7, ConnectionID: "peer-a", Reservation: direct()})
	routes.SetRoutePolicy(protocol.RoutePolicy{PeerOnly: true}, 8)
	eq(t, must(t, routes.Operation()).Current.ConnectionID, prepared.Current.ConnectionID)
	eq(t, edgeOf(t, routes, A).ConnectionID, "room-a")
}

func TestRoomPolicyHybridReopensExistingAvailabilityAndSfuBootstrap(t *testing.T) {
	routes := newController(1, Options{})
	addViewer(routes, A, 0, nil)
	addViewer(routes, B, 0, nil)
	routes.hydrateEdge(A, peerEdge(HOST, "room-a"))
	routes.SetVideoPublication("", false, 1)
	routes.SetVoiceListeners([]string{HOST, A, B}, 2)
	noOperation(t, routes.Reconcile(3).Operation)
	b, _ := routes.participants.Get(B)
	eq(t, b.availabilityExhausted, true)
	routes.SetRoutePolicy(protocol.RoutePolicy{TopologyOptimization: true}, 4)
	eq(t, b.availabilityExhausted, false)
	eq(t, routes.qualityConvergenceEnabled, true)
	eq(t, routes.natPredictionEnabled, false)
	op := must(t, routes.Reconcile(5).Operation)
	eq(t, op.Reason, DemandSfuBootstrap)
	eq(t, op.ChildPeerID, A)
	eq(t, op.DemandPeerID, B)
	eq(t, edgeOf(t, routes, A).ConnectionID, "room-a")
}
