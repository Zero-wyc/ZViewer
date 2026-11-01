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
