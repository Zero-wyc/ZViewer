package route

import "testing"

func TestSFUOnlyUsesOnePublicationWithoutPeerConvergence(t *testing.T) {
	routes := newController(1, Options{SfuEnabled: true, SfuOnly: true,
		QualityConvergenceEnabled: true, NatPredictionEnabled: true})
	for index, viewer := range []string{A, B, C} {
		now := int64(index * 10)
		addViewer(routes, viewer, 1, &now)
		op := must(t, routes.Reconcile(now).Operation)
		eq(t, len(op.Candidates), 1)
		publication := PublicationReuse
		input := BeginInput{NowMs: now + 1, ConnectionID: viewer + "_sfu",
			Reservation: sfuReuse(viewer)}
		if index == 0 {
			publication = PublicationCreate
			input.PublicationGeneration = "publication"
			input.PublicationConnectionID = "publication_connection"
			input.Reservation = sfuCreate(viewer, "publication_resource")
		}
		eq(t, op.Candidates[0].Tuple, sfuTuple(publication))
		prepared := beginOperation(t, routes, input)
		// Availability still commits only on the exact child's media-ready proof.
		eq(t, hasEdge(routes, viewer), false)
		eq(t, routes.CandidateReady(guardFor(viewer, prepared.Current.Revision, input.ConnectionID),
			now+2, nil, CandidateProof{}).Accepted, true)
		eq(t, edgeOf(t, routes, viewer).Kind, UpstreamSfu)
		noOperation(t, routes.Reconcile(now+3).Operation)
	}
	eq(t, routes.physicalCopies(HOST), 1)
	eq(t, routes.directContinuations.Len(), 0)
	// A failed publication is replaced through the same bounded operation.
	publication := routes.Publication()
	eq(t, routes.InvalidateHostPublication(PublicationGuard{HostSessionID: "host_session",
		RouteRevision: routes.Revision(), Generation: publication.Generation,
		ConnectionID: publication.ConnectionID}, ms(40)), true)
	op := must(t, routes.Reconcile(41).Operation)
	eq(t, len(op.Candidates), 1)
	eq(t, op.Candidates[0].Tuple, sfuTuple(PublicationReplace))
}

func TestSFUOnlyFailureDoesNotEscapeToPeers(t *testing.T) {
	for _, admissionDenied := range []bool{false, true} {
		routes := newController(2, Options{SfuEnabled: true, SfuOnly: true})
		addViewer(routes, A, 2, nil)
		op := must(t, routes.Reconcile(0).Operation)
		if admissionDenied {
			routes.SkipCurrentCandidate(cursorGuard(op), 1, RejectionSfuAdmission)
		} else {
			prepared := beginOperation(t, routes, BeginInput{NowMs: 1,
				ConnectionID: "sfu_connection", PublicationGeneration: "publication",
				PublicationConnectionID: "publication_connection", Reservation: sfuCreate("edge", "publication")})
			routes.CandidateFailed(guardFor(A, prepared.Current.Revision, "sfu_connection"), 2)
		}
		noOperation(t, routes.Reconcile(3).Operation)
		eq(t, hasEdge(routes, A), false)
		// Resource release may retry SFU; it must not reopen a Peer opportunity.
		routes.TouchExternalFacts()
		retry := must(t, routes.Reconcile(4).Operation)
		eq(t, len(retry.Candidates), 1)
		eq(t, retry.Candidates[0].Tuple.Kind, UpstreamSfu)
	}
}
