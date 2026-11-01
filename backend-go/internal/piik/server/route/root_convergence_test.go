package route

import (
	"fmt"
	"testing"
)

func TestRootConvergenceRetainsCommittedRoutesUntilExactProof(t *testing.T) {
	for _, capacity := range []int{2, 3} {
		for childCount := 2; childCount <= capacity; childCount++ {
			for _, outcome := range []string{"commit", "failure", "timeout", "session-replaced", "availability-preempts"} {
				t.Run(fmt.Sprintf("capacity=%d/children=%d/%s", capacity, childCount, outcome), func(t *testing.T) {
					routes := newController(capacity, Options{QualityConvergenceEnabled: true})
					addViewer(routes, B, capacity, nil)
					routes.hydrateEdge(B, peerEdge(HOST, "b_from_host"))
					children := []string{C, D, E}[:childCount]
					for _, child := range children {
						addViewer(routes, child, 0, nil)
						routes.hydrateEdge(child, peerEdge(B, child+"_from_b"))
					}
					addViewer(routes, A, capacity, ms(10))
					routes.Reconcile(10)
					commitCurrent(t, routes, 11, "a_from_host")
					op := must(t, routes.Reconcile(13).Operation)
					eq(t, op.Reason, DemandRootConvergence)
					prepared := beginOperation(t, routes, BeginInput{
						NowMs: 14, ConnectionID: "root_candidate", Reservation: direct(),
					})
					guard := CandidateGuard{ChildPeerID: op.ChildPeerID, ChildSessionID: op.ChildSessionID,
						Revision: prepared.Current.Revision, ConnectionID: "root_candidate"}

					// Another child's report cannot authorize the prepared child, even
					// when it names the candidate's revision and physical connection.
					other := children[0]
					if other == op.ChildPeerID {
						other = children[1]
					}
					eq(t, routes.ObserveSenderQualityEvidence(senderSample(A, other,
						prepared.Current.Revision, "root_candidate", "candidate-sender",
						SenderQualityHealthy, 15), nil).Accepted, false)
					ready := routes.CandidateReady(guard, 16, nil, CandidateProof{})
					eq(t, ready.Accepted, true)
					eq(t, ready.Committed, false)

					switch outcome {
					case "commit":
						eq(t, routes.ObserveSenderQualityEvidence(senderSample(A, op.ChildPeerID,
							prepared.Current.Revision, "root_candidate", "candidate-sender",
							SenderQualityHealthy, 17), nil).Committed, true)
					case "failure":
						eq(t, routes.CandidateFailed(guard, 17).Accepted, true)
					case "timeout":
						eq(t, routes.OperationExpired(op.DeadlineAtMs).Accepted, true)
					case "session-replaced":
						routes.UpsertParticipant(viewerInput(A, "replacement_session", capacity), ms(17))
						eq(t, routes.CandidateReady(guard, 18, nil, CandidateProof{}).Accepted, false)
					case "availability-preempts":
						addViewer(routes, F, 0, ms(17))
						next := must(t, routes.Reconcile(18).Operation)
						eq(t, next.ChildPeerID, F)
						eq(t, next.Reason, DemandJoin)
						eq(t, routes.CandidateReady(guard, 19, nil, CandidateProof{}).Accepted, false)
					}
					for _, child := range children {
						edge := edgeOf(t, routes, child)
						if child == op.ChildPeerID && outcome == "commit" {
							eq(t, edge.ParentPeerID, A)
							eq(t, edge.ConnectionID, "root_candidate")
						} else {
							eq(t, edge.ParentPeerID, B)
							eq(t, edge.ConnectionID, child+"_from_b")
						}
						eq(t, edge.Usable, true)
						eq(t, edge.PhysicalActive, true)
					}
					routes.assertGraph()
				})
			}
		}
	}
}
