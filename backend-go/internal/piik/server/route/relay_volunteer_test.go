package route

import (
	"fmt"
	"testing"
)

func TestRelayVolunteerUsesReportedCapabilityAndExactSession(t *testing.T) {
	routes := newController(2, Options{})
	addViewer(routes, A, 20, nil)
	peer, _ := routes.participants.Get(A)
	eq(t, peer.effectiveDownstreamCapacity, 2)
	eq(t, routes.SetRelayVolunteer(A, "stale", true, nil), false)
	eq(t, routes.SetRelayVolunteer(A, sessionOf(A), true, nil), true)
	eq(t, peer.effectiveDownstreamCapacity, 20)
	routes.UpsertParticipant(viewerInput(A, sessionOf(A), 100), nil)
	eq(t, peer.effectiveDownstreamCapacity, 20)
	eq(t, routes.SetEffectiveCapacity(A, sessionOf(A), 3, nil), true)
	eq(t, peer.effectiveDownstreamCapacity, 3)
	eq(t, routes.transitionCopyLimit(peer), 3) // Older App cannot reserve a fourth copy.
	routes.SetEffectiveCapacity(A, sessionOf(A), 20, nil)
	eq(t, routes.transitionCopyLimit(peer), 21)
	routes.UpsertParticipant(viewerInput(A, "new-session", 20), nil)
	eq(t, peer.relayVolunteer, false)
	eq(t, peer.effectiveDownstreamCapacity, 2)
	eq(t, routes.SetRelayVolunteer(A, sessionOf(A), true, nil), false)
}

func TestRoomDefaultCapacityKeepsPersonalAndPhysicalBounds(t *testing.T) {
	routes := newController(2, Options{})
	addViewer(routes, A, 20, nil)
	addViewer(routes, B, 3, nil)
	addViewer(routes, C, 0, nil)
	routes.SetRelayVolunteer(C, sessionOf(C), true, nil)
	routes.SetDefaultCapacity(20, ms(1))
	a, _ := routes.participants.Get(A)
	b, _ := routes.participants.Get(B)
	c, _ := routes.participants.Get(C)
	eq(t, a.effectiveDownstreamCapacity, 20)
	eq(t, routes.transitionCopyLimit(a), 21)
	eq(t, b.effectiveDownstreamCapacity, 3)
	eq(t, routes.transitionCopyLimit(b), 3)
	eq(t, c.effectiveDownstreamCapacity, 0)
	routes.SetDefaultCapacity(1, ms(2))
	eq(t, a.effectiveDownstreamCapacity, 1)
	eq(t, b.effectiveDownstreamCapacity, 1)
	eq(t, c.effectiveDownstreamCapacity, 0)
}

func TestRelayVolunteerFanoutAndWithdrawalKeepSingleRouteOperation(t *testing.T) {
	routes := newController(1, Options{})
	routes.SetVideoPublication("", false, 0)
	addViewer(routes, A, 20, ms(0))
	routes.Reconcile(0)
	commitRoomPeer(t, routes, 0, "host-to-relay")
	routes.SetRelayVolunteer(A, sessionOf(A), true, ms(1))
	// A relay is itself one of the twenty Viewers, so nineteen children is
	// the full room through an ordinary volunteering Viewer.
	for index := range 19 {
		child := fmt.Sprintf("child_%02d", index)
		addViewer(routes, child, 1, ms(int64(index+2)))
		op := must(t, routes.Reconcile(int64(index+2)).Operation)
		eq(t, op.Candidates[0].Tuple.ParentPeerID, A)
		commitRoomPeer(t, routes, int64(index+2), child+"-edge")
	}
	eq(t, routes.physicalCopies(A), 19)
	routes.SetRelayVolunteer(A, sessionOf(A), false, ms(100))
	eq(t, len(routes.overflowPeerChildren(A)), 18)
	// Each handoff preserves the incoming relay and remaining physical media;
	// no second planner or bulk teardown is needed to reduce its fanout.
	for index := range 18 {
		op := must(t, routes.Reconcile(int64(101+index)).Operation)
		eq(t, op.Reason, DemandCapacityReduction)
		if op.Candidates[0].Tuple.ParentPeerID == A {
			t.Fatal("withdrawn relay admitted a new child")
		}
		commitRoomPeer(t, routes, int64(101+index), fmt.Sprintf("handoff-%d", index))
	}
	eq(t, routes.physicalCopies(A), 1)
	eq(t, edgeOf(t, routes, A).ConnectionID, "host-to-relay")
}

func TestRelayVolunteerTwentyChildPhysicalOverlapRequiresOptIn(t *testing.T) {
	routes := newController(2, Options{})
	routes.SetVideoPublication("", false, 0)
	routes.SetEffectiveCapacity(HOST, "host_session", 20, nil)
	routes.SetRelayVolunteer(HOST, "host_session", true, nil)
	for index := range 20 {
		child := fmt.Sprintf("viewer_%02d", index)
		addViewer(routes, child, 0, ms(int64(index)))
		commitRoomPeer(t, routes, int64(index), child+"-edge")
	}
	plan := routes.planCandidate("viewer_00", regenerateTuple(HOST))
	if plan == nil || plan.EndpointTransition.Kind != TransitionOverlap {
		t.Fatalf("full volunteer replacement = %+v", plan)
	}
	routes.SetRelayVolunteer(HOST, "host_session", false, ms(100))
	if plan := routes.planCandidate("viewer_00", regenerateTuple(HOST)); plan != nil {
		t.Fatalf("withdrawn volunteer offered another physical copy: %+v", plan)
	}
}

func TestCapacityReductionMovesFeasibleLeafBeforeRetiringRelaySubtree(t *testing.T) {
	join := func(t *testing.T, routes *Controller, id string, capacity int) {
		t.Helper()
		addViewer(routes, id, capacity, ms(1))
		must(t, routes.Reconcile(2).Operation)
		commitCurrent(t, routes, 3, id+"-connection")
	}
	for _, outcome := range []string{"commit", "failed-candidate", "exhausted-candidates", "all-unavailable", "multi-parent"} {
		t.Run(outcome, func(t *testing.T) {
			routes := newController(3, Options{QualityConvergenceEnabled: true,
				NatPredictionEnabled: outcome == "multi-parent"})
			if outcome == "multi-parent" {
				routes.SetEffectiveCapacity(HOST, "host_session", 1, nil)
				join(t, routes, A, 1)
				join(t, routes, C, 0)
				routes.SetEffectiveCapacity(HOST, "host_session", 2, nil)
				join(t, routes, B, 2)
				join(t, routes, D, 0)
				addViewer(routes, E, 1, ms(1))
				eq(t, must(t, routes.Reconcile(2).Operation).ChildPeerID, E)
				prepared := beginOperation(t, routes, BeginInput{NowMs: 3,
					ConnectionID: "first-nat-attempt", Reservation: direct()})
				eq(t, routes.CandidateFailed(guardFor(E, prepared.Current.Revision, "first-nat-attempt"), 4).Accepted, true)
				must(t, routes.Reconcile(5).Operation)
				commitCurrent(t, routes, 6, E+"-connection")
				routes.SetEffectiveCapacity(C, sessionOf(C), 1, nil)
				eq(t, edgeOf(t, routes, C).ParentPeerID, A)
				eq(t, edgeOf(t, routes, D).ParentPeerID, B)
				eq(t, edgeOf(t, routes, E).ParentPeerID, B)
				// A spent C->E opportunity cannot justify retiring C before
				// another overloaded parent's live child can move under it.
				routes.consumeCandidateOpportunity(C, *routes.planCandidate(C, peerTuple(E)))
				for _, parent := range []string{C, E} {
					routes.consumeCandidateOpportunity(D, *routes.planCandidate(D, peerTuple(parent)))
				}
				routes.SetEffectiveCapacity(A, sessionOf(A), 0, ms(10))
				routes.SetEffectiveCapacity(B, sessionOf(B), 1, ms(10))
				eq(t, len(routes.buildCandidates(C, false)), 0)
				// The feasible child has more past attempts: the existing NAT
				// sort must not promote another parent's unavailable fallback.
				eq(t, routes.viewerAttemptsStarted(E) > routes.viewerAttemptsStarted(C), true)
				result := routes.Reconcile(11)
				eq(t, len(result.FailedPeerIDs), 0)
				op := must(t, result.Operation)
				eq(t, op.ChildPeerID, E)
				eq(t, op.Candidates[0].Tuple.ParentPeerID, C)
				deadline := op.DeadlineAtMs
				eq(t, must(t, routes.Reconcile(12).Operation).DeadlineAtMs, deadline)
				for _, child := range []string{A, B, C, D, E} {
					eq(t, edgeOf(t, routes, child).PhysicalActive, true)
				}
				commitCurrent(t, routes, 13, "other-parent-to-live-subtree")
				eq(t, edgeOf(t, routes, E).ParentPeerID, C)
				eq(t, routes.physicalCopies(B), 1)
				eq(t, edgeOf(t, routes, C).PhysicalActive, true)
				return
			}
			// The ordinary join path reaches Host->{A,B,C}, C->D. Only D has
			// a spare slot; C cannot move under its own descendant.
			for _, viewer := range []struct {
				id       string
				capacity int
			}{{A, 0}, {B, 0}, {C, 1}, {D, 1}} {
				join(t, routes, viewer.id, viewer.capacity)
			}
			eq(t, edgeOf(t, routes, D).ParentPeerID, C)
			if outcome == "all-unavailable" {
				routes.SetEffectiveCapacity(D, sessionOf(D), 0, ms(9))
			}
			routes.SetEffectiveCapacity(HOST, "host_session", 2, ms(10))
			result := routes.Reconcile(11)
			if outcome == "all-unavailable" {
				noOperation(t, result.Operation)
				eq(t, len(result.FailedPeerIDs), 2)
				eq(t, result.FailedPeerIDs[0], C)
				eq(t, result.FailedPeerIDs[1], D)
				eq(t, edgeOf(t, routes, C).PhysicalActive, false)
				eq(t, edgeOf(t, routes, D).PhysicalActive, false)
				return
			}
			op := must(t, result.Operation)
			eq(t, op.Reason, DemandCapacityReduction)
			eq(t, op.ChildPeerID, B) // Newest feasible leaf still leads.
			eq(t, op.Candidates[0].Tuple.ParentPeerID, D)
			deadline := op.DeadlineAtMs
			if outcome == "failed-candidate" || outcome == "exhausted-candidates" {
				prepared := beginOperation(t, routes, BeginInput{NowMs: 12,
					ConnectionID: "failed-leaf", Reservation: direct()})
				eq(t, routes.CandidateFailed(guardFor(B, prepared.Current.Revision, "failed-leaf"), 13).Accepted, true)
				op = must(t, routes.Reconcile(14).Operation)
				eq(t, op.ChildPeerID, A)
				eq(t, op.Reason, DemandCapacityReduction)
				eq(t, op.Candidates[0].Tuple.ParentPeerID, D)
				// Another reconciliation keeps this operation's original deadline.
				deadline = op.DeadlineAtMs
				eq(t, must(t, routes.Reconcile(15).Operation).DeadlineAtMs, deadline)
			}
			if outcome == "exhausted-candidates" {
				prepared := beginOperation(t, routes, BeginInput{NowMs: 16,
					ConnectionID: "last-leaf", Reservation: direct()})
				eq(t, routes.CandidateFailed(guardFor(A, prepared.Current.Revision, "last-leaf"), 17).Accepted, true)
				noOperation(t, routes.Reconcile(18).Operation)
				eq(t, edgeOf(t, routes, C).PhysicalActive, false)
				eq(t, edgeOf(t, routes, D).PhysicalActive, false)
				eq(t, routes.physicalCopies(HOST), 2)
				for now := deadline; now <= deadline+2; now++ {
					noOperation(t, routes.Reconcile(now).Operation)
				}
				return
			}
			for _, child := range []string{A, B, C, D} {
				eq(t, edgeOf(t, routes, child).PhysicalActive, true)
			}
			moved := op.ChildPeerID
			commitCurrent(t, routes, 16, "leaf-to-descendant")
			eq(t, edgeOf(t, routes, moved).ParentPeerID, D)
			eq(t, routes.physicalCopies(HOST), 2)
			eq(t, edgeOf(t, routes, C).ParentPeerID, HOST)
			eq(t, edgeOf(t, routes, D).ParentPeerID, C)
			for now := deadline; now <= deadline+2; now++ {
				noOperation(t, routes.Reconcile(now).Operation)
			}
			routes.assertGraph()
		})
	}
}

func TestHostVideoConnectionIdentityPreservesRoomPublication(t *testing.T) {
	routes := newController(2, Options{})
	routes.hydrateHostPublication("logical-publication", res("publication"), "old-video")
	eq(t, routes.SetHostVideoConnectionID("new-video"), false)
	routes.SetVideoPublication("share", false, 0)
	publication := *routes.hostPublication
	eq(t, routes.SetHostVideoConnectionID(""), false)
	eq(t, routes.SetHostVideoConnectionID("new-video"), true)
	eq(t, routes.hostPublication.Generation, publication.Generation)
	eq(t, routes.hostPublication.Resource, publication.Resource)
	eq(t, routes.hostPublication.Usable, publication.Usable)
	eq(t, routes.hostPublication.PhysicalActive, publication.PhysicalActive)
	eq(t, routes.hostPublication.ConnectionID, "new-video")
}
