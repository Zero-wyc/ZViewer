package route

import (
	"fmt"
	"testing"
)

func TestConnectedPeerDeadlinePreservesUntriedFallback(t *testing.T) {
	for _, prediction := range []bool{false, true} {
		t.Run(fmt.Sprintf("nat=%t", prediction), func(t *testing.T) {
			routes := newController(2, Options{SfuEnabled: true, NatPredictionEnabled: prediction, OperationTimeoutMs: 20_000})
			addViewer(routes, A, 0, nil)
			operation := must(t, routes.Reconcile(0).Operation)
			prepared := beginOperation(t, routes, BeginInput{NowMs: 1, ConnectionID: "connected_without_picture", Reservation: direct()})
			guard := guardFor(A, prepared.Current.Revision, "connected_without_picture")
			eq(t, routes.CandidateTransportConnected(guard, 100).Accepted, true)
			eq(t, routes.OperationExpired(operation.WakeAtMs).Accepted, false)
			result := routes.OperationExpired(operation.DeadlineAtMs)
			eq(t, result.Accepted, true)
			eqSlice(t, result.FailedPeerIDs, []string{})
			noOperation(t, routes.Snapshot().Operation)
			// Roll back before a fresh bounded operation. An attempted Peer must
			// not consume or repeatedly jump ahead of an untried SFU route.
			next := must(t, routes.Reconcile(operation.DeadlineAtMs+1).Operation)
			eq(t, next.Candidates[next.Cursor].Tuple.Kind, UpstreamSfu)
			eq(t, routes.CandidateReady(guard, operation.DeadlineAtMs+2, nil, CandidateProof{}).Accepted, false)
			fallback := beginOperation(t, routes, BeginInput{NowMs: operation.DeadlineAtMs + 3,
				ConnectionID: "fallback", PublicationGeneration: "publication", PublicationConnectionID: "publisher",
				Reservation: sfuCreate("subscription", "publication")})
			eq(t, routes.CandidateReady(guardFor(A, fallback.Current.Revision, "fallback"), operation.DeadlineAtMs+4, nil, CandidateProof{}).Committed, true)
			eq(t, edgeOf(t, routes, A).Kind, UpstreamSfu)
		})
	}
}

func TestAvailabilityDeadlinesExhaustOnlyTheirBoundedOpportunities(t *testing.T) {
	for _, prediction := range []bool{false, true} {
		t.Run(fmt.Sprintf("nat=%t", prediction), func(t *testing.T) {
			routes := newController(2, Options{SfuEnabled: true, NatPredictionEnabled: prediction, OperationTimeoutMs: 20_000})
			addViewer(routes, A, 0, nil)
			peerAttempts, sfuAttempts, now := 0, 0, int64(0)
			for count := 0; count < 6; count++ {
				op := routes.Reconcile(now).Operation
				if op == nil {
					break
				}
				input := BeginInput{NowMs: now + 1, ConnectionID: fmt.Sprintf("attempt_%d", count), Reservation: direct()}
				kind := op.Candidates[op.Cursor].Tuple.Kind
				if kind == UpstreamSfu {
					sfuAttempts++
					input.PublicationGeneration, input.PublicationConnectionID = "publication", "publisher"
					input.Reservation = sfuCreate("subscription", "publication")
				} else {
					peerAttempts++
				}
				prepared := beginOperation(t, routes, input)
				if kind == UpstreamPeer {
					routes.CandidateTransportConnected(guardFor(A, prepared.Current.Revision, input.ConnectionID), now+2)
				}
				result := routes.OperationExpired(op.DeadlineAtMs)
				if kind == UpstreamSfu {
					eqLabels(t, result.Released, "subscription", "publication")
				}
				now = op.DeadlineAtMs + 1
			}
			wantPeerAttempts := 1
			if prediction {
				wantPeerAttempts = 4
			}
			eq(t, peerAttempts, wantPeerAttempts)
			eq(t, sfuAttempts, 1)
			noOperation(t, routes.Reconcile(now).Operation)
		})
	}
}
