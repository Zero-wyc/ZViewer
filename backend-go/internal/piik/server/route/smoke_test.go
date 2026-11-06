package route

import (
	"testing"

	"zviewer/backend/internal/piik/server/protocol"
)

// TestSmokeCommitsOneDirectCandidate wires the controller end to end: a
// Host and two Viewers join, reconcile starts one join operation for the
// first Viewer with the Host as its first direct candidate, and begin +
// candidateReady commit that edge at the attempt's revision.
func TestSmokeCommitsOneDirectCandidate(t *testing.T) {
	const host = "smoke_host_1234"
	const first = "smoke_viewer_a_1"
	const second = "smoke_viewer_b_1"
	routes := New(Options{HostPeerID: host, EndpointMediaCopyCapacity: 2, OperationTimeoutMs: 10_000})
	routes.UpsertParticipant(ParticipantInput{PeerID: host, Role: protocol.RoleHost, SessionID: "host_s", EffectiveDownstreamCapacity: 2}, nil)
	now := int64(1_000)
	for _, viewer := range []string{first, second} {
		routes.UpsertParticipant(ParticipantInput{PeerID: viewer, Role: protocol.RoleViewer, SessionID: viewer + "_s", EffectiveDownstreamCapacity: 2}, &now)
	}

	result := routes.Reconcile(now)
	if result.Operation == nil {
		t.Fatal("expected reconcile to start an operation")
	}
	operation := result.Operation
	if operation.ChildPeerID != first || operation.Reason != DemandJoin {
		t.Fatalf("operation = %+v, want a join for the first viewer", operation)
	}
	if len(operation.Candidates) == 0 || operation.Candidates[0].Tuple != (CandidateTuple{Kind: UpstreamPeer, ParentPeerID: host, Transport: TransportDirect}) {
		t.Fatalf("candidates = %+v, want the Host first", operation.Candidates)
	}
	if operation.WakeAtMs != operation.DeadlineAtMs || operation.DeadlineAtMs != now+10_000 {
		t.Fatalf("deadline %d wake %d, want both at %d", operation.DeadlineAtMs, operation.WakeAtMs, now+10_000)
	}

	begin := routes.BeginCurrentCandidate(BeginInput{
		Guard: CandidateCursorGuard{
			ChildPeerID:    operation.ChildPeerID,
			ChildSessionID: operation.ChildSessionID,
			BaseRevision:   operation.BaseRevision,
			FactVersion:    operation.FactVersion,
			Cursor:         operation.Cursor,
			Plan:           operation.Candidates[operation.Cursor],
		},
		NowMs:        now + 1,
		ConnectionID: "conn_a",
		Reservation:  CandidateReservation{Kind: ReservationDirect},
	})
	if !begin.Accepted || begin.Operation == nil || begin.Operation.Current == nil {
		t.Fatalf("begin = %+v, want an accepted live attempt", begin)
	}
	if routes.Snapshot().Revision != operation.BaseRevision {
		t.Fatal("beginCurrentCandidate must not advance the advertised revision")
	}

	settled := routes.CandidateReady(CandidateGuard{
		ChildPeerID:    operation.ChildPeerID,
		ChildSessionID: operation.ChildSessionID,
		Revision:       begin.Operation.Current.Revision,
		ConnectionID:   "conn_a",
	}, now+2, nil, CandidateProof{})
	if !settled.Accepted || !settled.Committed || len(settled.Released) != 0 {
		t.Fatalf("candidateReady = %+v, want a clean commit", settled)
	}
	snapshot := routes.Snapshot()
	if snapshot.Revision != begin.Operation.Current.Revision || snapshot.Operation != nil {
		t.Fatalf("snapshot revision %d operation %v, want %d and idle", snapshot.Revision, snapshot.Operation, begin.Operation.Current.Revision)
	}
	edge, ok := snapshot.UpstreamByViewer.Get(first)
	if !ok || edge.Kind != UpstreamPeer || edge.ParentPeerID != host || edge.ConnectionID != "conn_a" || !edge.Usable || !edge.PhysicalActive {
		t.Fatalf("edge = %+v, want a usable direct edge from the Host", edge)
	}
	if next := routes.Reconcile(now + 3).Operation; next == nil || next.ChildPeerID != second {
		t.Fatalf("next operation = %+v, want the second viewer", next)
	}
	diagnostic := routes.RouteDiagnosticSnapshot(now + 3)
	if len(diagnostic.Children) != 2 || diagnostic.Children[0].Parent.Kind != "host" || diagnostic.Children[0].FinalRoute != "direct" {
		t.Fatalf("diagnostic = %+v, want the first child routed through the Host", diagnostic)
	}
}
