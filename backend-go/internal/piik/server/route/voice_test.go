package route

import "testing"

func videoTreeForVoice(t *testing.T, capacity int, options Options) *Controller {
	t.Helper()
	routes := newController(capacity, options)
	addViewer(routes, A, 1, nil)
	addViewer(routes, B, 1, nil)
	routes.hydrateEdge(A, peerEdge(HOST, "video-a"))
	routes.hydrateEdge(B, peerEdge(A, "video-b"))
	routes.SetVideoPublication("share", false, 1)
	return routes
}

func TestVoiceApprovalReparentsThroughTheExistingOperation(t *testing.T) {
	routes := videoTreeForVoice(t, 2, Options{})
	routes.SetVoiceListeners([]string{HOST, B}, 2)
	op := must(t, routes.Reconcile(3).Operation)
	eq(t, op.ChildPeerID, B)
	eq(t, op.Reason, DemandEdgeUnavailable)
	eq(t, op.Candidates[0].Tuple.ParentPeerID, HOST)
	eq(t, edgeOf(t, routes, B).ConnectionID, "video-b")
	eq(t, edgeOf(t, routes, B).VideoReady, true)
	prepared := beginOperation(t, routes, BeginInput{NowMs: 4, ConnectionID: "permitted-b", Reservation: direct()})
	guard := guardFor(B, prepared.Current.Revision, "permitted-b")
	eq(t, routes.CandidateReady(guard, 5, nil, CandidateProof{VideoGeneration: "share"}).Committed, true)
	eq(t, edgeOf(t, routes, B).ParentPeerID, HOST)
	eq(t, routes.voiceRouteMissing(B), false)
	noOperation(t, routes.Reconcile(6).Operation)
}

func TestVoiceReparentFailureRetainsVideoAndPermissionDeltaReopensOnlyDemand(t *testing.T) {
	routes := videoTreeForVoice(t, 2, Options{})
	routes.SetVoiceListeners([]string{HOST, A, B}, 2)
	noOperation(t, routes.Reconcile(3).Operation)
	routes.SetVoiceListeners([]string{HOST, B}, 4)
	must(t, routes.Reconcile(5).Operation)
	prepared := beginOperation(t, routes, BeginInput{NowMs: 5, ConnectionID: "failed-b", Reservation: direct()})
	eq(t, routes.CandidateFailed(guardFor(B, prepared.Current.Revision, "failed-b"), 6).Accepted, true)
	for _, now := range []int64{7, 20_000, 40_000} {
		noOperation(t, routes.Reconcile(now).Operation)
		eq(t, edgeOf(t, routes, B).ConnectionID, "video-b")
		eq(t, edgeOf(t, routes, B).Usable && edgeOf(t, routes, B).VideoReady, true)
	}
	eq(t, routes.SetVoiceListeners([]string{B, HOST}, 40_001), false)
	noOperation(t, routes.Reconcile(40_002).Operation)
	// A newly permitted relay is an actual new opportunity. Its existing
	// healthy route already restores the listener without any replacement.
	routes.SetVoiceListeners([]string{HOST, A, B}, 40_003)
	eq(t, routes.voiceRouteMissing(B), false)
	noOperation(t, routes.Reconcile(40_004).Operation)
	routes.SetVoiceListeners([]string{HOST, B}, 40_005)
	eq(t, must(t, routes.Reconcile(40_006).Operation).ChildPeerID, B)
}

func TestVoiceParentRequiresPermittedAncestorsAndLegacyRoutesRemainUnchanged(t *testing.T) {
	routes := videoTreeForVoice(t, 2, Options{})
	addViewer(routes, C, 0, nil)
	routes.hydrateEdge(C, peerEdge(B, "video-c"))
	// Hydrated test edge follows opt-in; mark its existing video evidence.
	edge, _ := routes.upstreamByViewer.Get(C)
	edge.VideoReady, edge.VideoGeneration, edge.VideoConnectionID = true, "share", "video-c"
	routes.SetVoiceListeners([]string{HOST, B, C}, 2)
	for _, plan := range routes.buildCandidates(C, false) {
		if plan.Tuple.Kind == UpstreamPeer && (plan.Tuple.ParentPeerID == A || plan.Tuple.ParentPeerID == B) {
			t.Fatal("candidate path traversed an unapproved listener")
		}
	}
	legacy := newController(1, Options{})
	addViewer(legacy, A, 1, nil)
	addViewer(legacy, B, 0, nil)
	legacy.hydrateEdge(A, peerEdge(HOST, "legacy-a"))
	legacy.hydrateEdge(B, peerEdge(A, "legacy-b"))
	eq(t, legacy.SetVoiceListeners([]string{HOST, B}, 2), false)
	noOperation(t, legacy.Reconcile(3).Operation)
}

func TestVoicePermissionRepairCanUseExistingSfuBootstrap(t *testing.T) {
	routes := videoTreeForVoice(t, 1, Options{SfuEnabled: true})
	routes.SetVoiceListeners([]string{HOST, B}, 2)
	// Host's only copy is occupied by video-only A. The ordinary bootstrap
	// operation moves A onto SFU while retaining its healthy video, opening
	// the admitted SFU junction for B's subsequent permission repair.
	op := must(t, routes.Reconcile(3).Operation)
	eq(t, op.Reason, DemandSfuBootstrap)
	eq(t, op.ChildPeerID, A)
	eq(t, op.DemandPeerID, B)
	eq(t, edgeOf(t, routes, A).Usable && edgeOf(t, routes, B).Usable, true)
}
