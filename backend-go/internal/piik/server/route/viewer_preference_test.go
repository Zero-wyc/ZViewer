package route

import (
	"fmt"
	"testing"

	"zviewer/backend/internal/piik/server/protocol"
)

func TestViewerRoutePreferenceAutoRestoresDirectContinuation(t *testing.T) {
	routes := newController(2, Options{SfuEnabled: true})
	addViewer(routes, A, 2, nil)
	routes.hydrateHostPublication("publication", res("publication"), "publication_connection")
	routes.hydrateEdge(A, sfuEdge("publication", "sfu_connection", "subscription"))
	routes.SetViewerRoutePreference(A, sessionOf(A), protocol.ViewerRouteSfu, ms(0))
	noOperation(t, routes.Reconcile(1).Operation)
	routes.SetViewerRoutePreference(A, sessionOf(A), protocol.ViewerRouteAuto, ms(2))
	op := must(t, routes.Reconcile(3).Operation)
	eq(t, op.Reason, DemandDirectConvergence)
	eq(t, op.Candidates[0].Tuple, peerTuple(HOST))
	eq(t, edgeOf(t, routes, A).ConnectionID, "sfu_connection")
	prepared := beginOperation(t, routes, BeginInput{NowMs: 4, ConnectionID: "peer_connection", Reservation: direct()})
	late := guardFor(A, prepared.Current.Revision, "peer_connection")
	// Selecting SFU again aborts preparation without disturbing playback.
	routes.SetViewerRoutePreference(A, sessionOf(A), protocol.ViewerRouteSfu, ms(5))
	eq(t, routes.CandidateReady(late, 6, nil, CandidateProof{}).Accepted, false)
	eq(t, edgeOf(t, routes, A).ConnectionID, "sfu_connection")
	noOperation(t, routes.Reconcile(7).Operation)
	routes.SetViewerRoutePreference(A, sessionOf(A), protocol.ViewerRouteAuto, ms(8))
	eq(t, must(t, routes.Reconcile(9).Operation).Reason, DemandDirectConvergence)
	commitCurrent(t, routes, 10, "restored_peer")
	eq(t, edgeOf(t, routes, A).Kind, UpstreamPeer)
	noOperation(t, routes.Reconcile(12).Operation)
}

func TestViewerRoutePreferenceExhaustionRepairsRelayChildren(t *testing.T) {
	routes := newController(2, Options{SfuEnabled: true})
	for _, peer := range []string{A, B, C} {
		addViewer(routes, peer, 2, nil)
	}
	routes.hydrateEdge(A, peerEdge(HOST, "host_a"))
	routes.hydrateEdge(B, peerEdge(A, "a_b"))
	routes.hydrateEdge(C, peerEdge(B, "b_c"))
	routes.SetViewerRoutePreference(A, sessionOf(A), protocol.ViewerRouteSfu, ms(0))
	op := must(t, routes.Reconcile(1).Operation)
	eq(t, op.ChildPeerID, A)
	eqSlice(t, tupleKinds(op), []UpstreamKind{UpstreamSfu})
	eq(t, routes.sourceUsable(C), true)
	// The retained ingress and entire subtree survive candidate preparation.
	prepared := beginOperation(t, routes, BeginInput{NowMs: 2, ConnectionID: "a_sfu",
		PublicationGeneration: "publication", PublicationConnectionID: "publisher",
		Reservation: sfuCreate("subscription", "publication")})
	eq(t, routes.sourceUsable(C), true)
	routes.CandidateFailed(guardFor(A, prepared.Current.Revision, "a_sfu"), 3)
	eq(t, edgeOf(t, routes, A).PhysicalActive, false)
	eq(t, edgeOf(t, routes, B).Usable, true)
	op = must(t, routes.Reconcile(4).Operation)
	eq(t, op.ChildPeerID, B)
	eq(t, op.Candidates[0].Tuple, peerTuple(HOST))
	commitCurrent(t, routes, 5, "host_b")
	eq(t, routes.sourceUsable(C), true)
	eq(t, edgeOf(t, routes, C).ConnectionID, "b_c")
	// The exhausted strict choice cannot spin when another branch commits.
	noOperation(t, routes.Reconcile(7).Operation)
	noOperation(t, routes.Reconcile(8).Operation)
}

func TestViewerRoutePreferenceP2PAcceptsSFUFedParent(t *testing.T) {
	routes := newController(1, Options{SfuEnabled: true, QualityConvergenceEnabled: true})
	addViewer(routes, A, 1, nil)
	addViewer(routes, B, 1, nil)
	routes.hydrateHostPublication("publication", res("publication"), "publisher")
	routes.hydrateEdge(A, sfuEdge("publication", "a_sfu", "subscription"))
	routes.SetViewerRoutePreference(A, sessionOf(A), protocol.ViewerRouteSfu, ms(0))
	routes.SetViewerRoutePreference(B, sessionOf(B), protocol.ViewerRoutePeer, ms(0))
	op := must(t, routes.Reconcile(1).Operation)
	eq(t, op.ChildPeerID, B)
	eqSlice(t, tuples(op), []CandidateTuple{peerTuple(A)})
	commitCurrent(t, routes, 2, "a_b")
	eq(t, routes.sourceUsable(B), true)
	noOperation(t, routes.Reconcile(4).Operation)
	// A fixed incoming kind still permits quality repair of the P2P child.
	for index, state := range []SenderQualityState{SenderQualityHealthy, SenderQualityDegraded, SenderQualityDegraded, SenderQualityDegraded} {
		eq(t, observeSenderState(routes, senderState{parentPeerID: A, childPeerID: B,
			connectionID: "a_b", state: state, acceptedAtMs: int64(10 + index)}).Accepted, true)
	}
	op = must(t, routes.Reconcile(14).Operation)
	eq(t, op.Reason, DemandQualityConvergence)
	eq(t, op.ChildPeerID, B)
	eqSlice(t, tuples(op), []CandidateTuple{regenerateTuple(A)})
	prepared := beginOperation(t, routes, BeginInput{NowMs: 15, ConnectionID: "a_b_regenerated",
		Reservation: directOverlap("regeneration_overlap")})
	guard := guardFor(B, prepared.Current.Revision, "a_b_regenerated")
	eq(t, routes.CandidateReady(guard, 16, nil, CandidateProof{RelativeQualityApproved: true}).Committed, false)
	eq(t, routes.ObserveSenderQualityEvidence(senderSample(A, B, prepared.Current.Revision,
		"a_b_regenerated", "regenerated-rtp\x00track", SenderQualityHealthy, 17), nil).Committed, true)
	eq(t, edgeOf(t, routes, B).ConnectionID, "a_b_regenerated")
	eq(t, edgeOf(t, routes, A).Kind, UpstreamSfu)
	eq(t, edgeOf(t, routes, A).ConnectionID, "a_sfu")
	noOperation(t, routes.Reconcile(18).Operation)
}

func TestViewerRoutePreferenceSFUBootstrapDoesNotQueuePeerContinuation(t *testing.T) {
	routes := newController(2, Options{SfuEnabled: true})
	for _, peer := range []string{B, C} {
		addViewer(routes, peer, 0, nil)
		routes.hydrateEdge(peer, peerEdge(HOST, peer+"_host"))
	}
	addViewer(routes, A, 0, nil)
	op := must(t, routes.Reconcile(0).Operation)
	eq(t, op.Reason, DemandSfuBootstrap)
	eq(t, op.ChildPeerID, C)
	// The carrier selects SFU while its existing bootstrap is being prepared.
	routes.SetViewerRoutePreference(C, sessionOf(C), protocol.ViewerRouteSfu, ms(1))
	op = must(t, routes.Reconcile(2).Operation)
	eq(t, op.Reason, DemandSfuBootstrap)
	eq(t, op.ChildPeerID, C)
	prepared := beginOperation(t, routes, BeginInput{NowMs: 3, ConnectionID: "carrier_sfu",
		PublicationGeneration: "publication", PublicationConnectionID: "publisher",
		Reservation: sfuCreateOverlap("carrier_subscription", "publication", "publication_overlap")})
	eq(t, routes.CandidateReady(guardFor(C, prepared.Current.Revision, "carrier_sfu"),
		4, nil, CandidateProof{}).Committed, true)
	eq(t, routes.directContinuations.Has(C), false)
	op = must(t, routes.Reconcile(5).Operation)
	eq(t, op.ChildPeerID, A)
	eqSlice(t, tuples(op), []CandidateTuple{sfuTuple(PublicationReuse)})
	prepared = beginOperation(t, routes, BeginInput{NowMs: 6, ConnectionID: "a_sfu", Reservation: sfuReuse("a_subscription")})
	eq(t, routes.CandidateReady(guardFor(A, prepared.Current.Revision, "a_sfu"), 7, nil, CandidateProof{}).Committed, true)
	noOperation(t, routes.Reconcile(8).Operation)
	noOperation(t, routes.Reconcile(9).Operation)
}

func TestViewerRoutePreferenceExhaustionRetainsSFUAnchorForChildRepair(t *testing.T) {
	routes := newController(1, Options{SfuEnabled: true})
	addViewer(routes, A, 1, nil)
	addViewer(routes, B, 1, nil)
	routes.hydrateHostPublication("publication", res("publication"), "publisher")
	routes.hydrateEdge(A, sfuEdge("publication", "a_sfu", "subscription"))
	routes.hydrateEdge(B, peerEdge(A, "a_b"))
	routes.SetViewerRoutePreference(A, sessionOf(A), protocol.ViewerRoutePeer, ms(0))
	op := must(t, routes.Reconcile(1).Operation)
	eqSlice(t, tuples(op), []CandidateTuple{peerTuple(HOST)})
	eq(t, routes.sourceUsable(B), true)
	routes.SkipCurrentCandidate(cursorGuard(op), 2, RejectionCandidateFailed)
	eq(t, edgeOf(t, routes, A).PhysicalActive, false)
	eq(t, routes.Publication() == nil, true)
	routes.assertGraph()
	op = must(t, routes.Reconcile(3).Operation)
	// Retiring the last subscription frees the Host's publication copy. The
	// existing ledger permits that less disruptive Peer opportunity once.
	eq(t, op.ChildPeerID, A)
	eq(t, op.Candidates[0].EndpointTransition.Kind, TransitionNone)
	routes.SkipCurrentCandidate(cursorGuard(op), 4, RejectionCandidateFailed)
	op = must(t, routes.Reconcile(5).Operation)
	eq(t, op.ChildPeerID, B)
	eq(t, op.Candidates[0].Tuple, peerTuple(HOST))
	commitCurrent(t, routes, 6, "host_b")
	eq(t, routes.sourceUsable(B), true)
	routes.assertGraph()
}

func TestViewerRoutePreferenceP2PExhaustionThenAuto(t *testing.T) {
	routes := newController(1, Options{SfuEnabled: true})
	addViewer(routes, A, 0, nil)
	addViewer(routes, B, 0, nil)
	routes.hydrateHostPublication("publication", res("publication"), "publisher")
	routes.hydrateEdge(A, sfuEdge("publication", "a_sfu", "a_subscription"))
	routes.hydrateEdge(B, sfuEdge("publication", "b_sfu", "b_subscription"))
	routes.SetViewerRoutePreference(B, sessionOf(B), protocol.ViewerRouteSfu, ms(0))
	routes.SetViewerRoutePreference(A, sessionOf(A), protocol.ViewerRoutePeer, ms(0))
	result := routes.Reconcile(1)
	noOperation(t, result.Operation)
	eqSlice(t, result.FailedPeerIDs, []string{A})
	eq(t, hasEdge(routes, A), false)
	noOperation(t, routes.Reconcile(2).Operation)
	routes.SetViewerRoutePreference(A, sessionOf(A), protocol.ViewerRouteAuto, ms(3))
	op := must(t, routes.Reconcile(4).Operation)
	eq(t, op.ChildPeerID, A)
	eqSlice(t, tuples(op), []CandidateTuple{sfuTuple(PublicationReuse)})
}

func TestFreshRelayRespectsSfuPolicy(t *testing.T) {
	for _, siteOnly := range []bool{false, true} {
		t.Run(fmt.Sprintf("siteOnly=%v", siteOnly), func(t *testing.T) {
			routes := newController(1, Options{SfuEnabled: true, SfuOnly: siteOnly})
			addViewer(routes, A, 0, nil)
			addViewer(routes, B, 0, nil)
			routes.hydrateHostPublication("publication", res("publication"), "publisher")
			routes.hydrateEdge(A, sfuEdge("publication", "a_sfu", "subscription_a"))
			routes.hydrateEdge(B, sfuEdge("publication", "b_sfu", "subscription_b"))
			if !siteOnly {
				routes.SetViewerRoutePreference(A, sessionOf(A), protocol.ViewerRouteSfu, ms(0))
			}
			routes.SetEffectiveCapacity(B, sessionOf(B), 1, ms(1))
			noOperation(t, routes.Reconcile(2).Operation)
			eq(t, edgeOf(t, routes, A).ConnectionID, "a_sfu")
		})
	}
}
