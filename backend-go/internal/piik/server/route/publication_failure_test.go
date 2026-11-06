package route

import "testing"

func TestFailedPublicationAttachmentReportsItsDependentViewers(t *testing.T) {
	for _, failure := range []string{"transport", "timeout", "rejected"} {
		t.Run(failure, func(t *testing.T) {
			routes := voiceTree(t)
			before := routes.Snapshot()
			routes.SetVideoPublication("share", false, 10)
			var failed []string
			if failure == "rejected" {
				op := must(t, routes.Reconcile(11).Operation)
				failed = routes.SkipCurrentCandidate(cursorGuard(op), 12, RejectionCandidateFailed).FailedPeerIDs
			} else {
				guard := beginVideoAttach(t, routes, 11, A, "video-a")
				if failure == "transport" {
					failed = routes.CandidateFailed(guard, 12).FailedPeerIDs
				} else {
					failed = routes.OperationExpired(routes.Operation().DeadlineAtMs).FailedPeerIDs
				}
			}
			eqSlice(t, failed, []string{A, B})
			for _, child := range []string{A, B} {
				previous, _ := before.UpstreamByViewer.Get(child)
				edge := edgeOf(t, routes, child)
				eq(t, edge.ConnectionID, previous.ConnectionID)
				eq(t, edge.Usable && edge.PhysicalActive, true)
				eq(t, edge.VideoReady, false)
			}
			settled := routes.Reconcile(40_000)
			noOperation(t, settled.Operation)
			eq(t, len(settled.FailedPeerIDs), 0)
			// A failed picture does not poison the voice graph or a later share.
			routes.SetVideoPublication("replacement", false, 40_001)
			a := beginVideoAttach(t, routes, 40_002, A, "replacement-video-a")
			eq(t, routes.CandidateReady(a, 40_003, nil, CandidateProof{VideoGeneration: "replacement"}).Committed, true)
			b := beginVideoAttach(t, routes, 40_004, B, "replacement-video-b")
			eq(t, routes.CandidateReady(b, 40_005, nil, CandidateProof{VideoGeneration: "replacement"}).Committed, true)
		})
	}
}

func TestPublicationAttachmentFailureDoesNotFailIndependentBranches(t *testing.T) {
	routes := newController(2, Options{})
	routes.SetVideoPublication("", false, 0)
	for _, peerID := range []string{A, B, C, D} {
		addViewer(routes, peerID, 1, nil)
	}
	routes.hydrateEdge(A, peerEdge(HOST, "voice-a"))
	routes.hydrateEdge(B, peerEdge(A, "voice-b"))
	routes.hydrateEdge(C, peerEdge(B, "voice-c"))
	routes.hydrateEdge(D, peerEdge(HOST, "voice-d"))
	routes.SetVideoPublication("share", false, 1)
	a := beginVideoAttach(t, routes, 2, A, "video-a")
	eqSlice(t, routes.CandidateFailed(a, 3).FailedPeerIDs, []string{A, B, C})
	d := beginVideoAttach(t, routes, 4, D, "video-d")
	eq(t, routes.CandidateReady(d, 5, nil, CandidateProof{VideoGeneration: "share"}).Committed, true)
	noOperation(t, routes.Reconcile(6).Operation)
	eq(t, edgeOf(t, routes, D).VideoReady, true)
}
