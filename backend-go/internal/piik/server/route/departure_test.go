package route

import "testing"

func TestConfirmedDepartureRetiresMediaWhilePaused(t *testing.T) {
	for _, transport := range []string{"peer", "sfu"} {
		for _, relay := range []bool{false, true} {
			name := transport + "/leaf"
			if relay {
				name = transport + "/relay"
			}
			t.Run(name, func(t *testing.T) {
				routes := newController(2, Options{})
				addViewer(routes, A, 1, nil)
				if transport == "sfu" {
					routes.hydrateHostPublication("publication", res("publication"), "publisher")
					routes.hydrateEdge(A, sfuEdge("publication", "a_sfu", "subscription"))
				} else {
					routes.hydrateEdge(A, peerEdge(HOST, "a_peer"))
				}
				if relay {
					addViewer(routes, B, 0, nil)
					routes.hydrateEdge(B, peerEdge(A, "b_peer"))
				}
				routes.SetPaused(true, ms(1))
				routes.DisconnectSession(A, sessionOf(A))
				// Transient signaling loss retains media during membership grace.
				eqLabels(t, routes.Reconcile(2).Released)
				eq(t, edgeOf(t, routes, A).PhysicalActive, true)

				routes.ConfirmDeparture(A, ms(3))
				before := routes.Revision()
				result := routes.Reconcile(4)
				noOperation(t, result.Operation)
				if routes.Revision() <= before {
					t.Fatal("departure must publish a new active assignment")
				}
				if transport == "sfu" {
					eqLabels(t, result.Released, "subscription", "publication")
				} else {
					eqLabels(t, result.Released)
				}
				if relay {
					edge := edgeOf(t, routes, A)
					eq(t, edge.PhysicalActive, false)
					eq(t, edge.Usable, false)
					eq(t, edgeOf(t, routes, B).ConnectionID, "b_peer")
				} else {
					eq(t, hasEdge(routes, A), false)
				}
				routes.assertGraph()
				eqLabels(t, routes.Reconcile(5).Released)
			})
		}
	}
}

func TestDepartureRetiresMediaBeforePendingCandidateCanCommit(t *testing.T) {
	routes := newController(2, Options{})
	addViewer(routes, A, 0, nil)
	routes.hydrateEdge(A, peerEdge(HOST, "a_peer"))
	addViewer(routes, B, 0, nil)
	routes.Reconcile(0)
	pending := beginOperation(t, routes, BeginInput{NowMs: 1, ConnectionID: "b_old", Reservation: directOverlap("overlap")})
	stale := guardFor(B, pending.Current.Revision, "b_old")

	routes.ConfirmDeparture(A, ms(2))
	result := routes.Reconcile(3)
	eqLabels(t, result.Released, "overlap")
	eq(t, hasEdge(routes, A), false)
	if routes.Revision() <= stale.Revision {
		t.Fatal("retirement must supersede the pending candidate revision")
	}
	eq(t, routes.CandidateReady(stale, 4, nil, CandidateProof{}).Accepted, false)
	revision := routes.Revision()
	commitCurrent(t, routes, 5, "b_new")
	if routes.Revision() <= revision {
		t.Fatal("replacement commit must not roll back the retirement revision")
	}
	eq(t, edgeOf(t, routes, B).ConnectionID, "b_new")
}

func TestDeparturePreservesSharedPublicationAndHealthySibling(t *testing.T) {
	routes := newController(1, Options{SfuEnabled: true})
	routes.hydrateHostPublication("publication", res("publication"), "publisher")
	for _, peerID := range []string{A, B} {
		addViewer(routes, peerID, 0, nil)
		routes.hydrateEdge(peerID, sfuEdge("publication", peerID+"_sfu", peerID))
	}
	addViewer(routes, C, 0, nil)
	routes.Reconcile(0)
	beginOperation(t, routes, BeginInput{NowMs: 1, ConnectionID: "c_pending", Reservation: sfuReuse("pending")})
	routes.ConfirmDeparture(A, ms(2))
	result := routes.Reconcile(3)
	eqLabels(t, result.Released, "pending", A)
	eq(t, routes.Snapshot().HostPublication.ConnectionID, "publisher")
	eq(t, edgeOf(t, routes, B).ConnectionID, B+"_sfu")
	eq(t, edgeOf(t, routes, B).PhysicalActive, true)
	routes.assertGraph()
}
