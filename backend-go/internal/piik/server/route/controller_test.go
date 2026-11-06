package route

// Oracle port of tests/room-route-controller.test.ts. Each test keeps the TS
// title and line as a comment; every nowMs is the explicit literal the TS
// used, so nothing here needs a clock.

import (
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"testing"

	"zviewer/backend/internal/piik/server/protocol"
)

// TS 359: keeps one diagnostic label until a departed relay is finally pruned
func TestKeepsOneDiagnosticLabelUntilDepartedRelayIsPruned(t *testing.T) {
	routes := newController(2, Options{})
	addViewer(routes, A, 1, nil)
	addViewer(routes, B, 0, nil)
	routes.hydrateEdge(A, peerEdge(HOST, "a_from_host"))
	routes.hydrateEdge(B, peerEdge(A, "b_from_a"))
	label := routes.DiagnosticParticipantLabel(A)
	if !regexp.MustCompile(`^viewer-\d+$`).MatchString(label) {
		t.Fatalf("label %q is not viewer-<n>", label)
	}

	routes.UpsertParticipant(viewerInput(A, "a_replacement_session", 1), nil)
	eq(t, routes.DiagnosticParticipantLabel(A), label)
	eq(t, routes.DisconnectSession(A, "a_replacement_session"), true)
	eq(t, routes.DiagnosticParticipantLabel(A), label)
	eq(t, routes.ConfirmDeparture(A, ms(0)), true)
	eq(t, routes.DiagnosticParticipantLabel(A), label)

	repair := must(t, routes.Reconcile(1).Operation)
	eq(t, repair.ChildPeerID, B)
	eq(t, repair.Reason, DemandParentDeparted)
	commitCurrent(t, routes, 2, "b_from_host")
	pruned := routes.Reconcile(4)
	if !slices.Contains(pruned.RemovedPeerIDs, A) {
		t.Fatalf("removedPeerIds %v does not contain A", pruned.RemovedPeerIDs)
	}
	eq(t, routes.DiagnosticParticipantLabel(A), "viewer-unknown")

	addViewer(routes, C, 0, nil)
	if routes.DiagnosticParticipantLabel(C) == label {
		t.Fatalf("C reused label %q", label)
	}
}

// TS 394: clears an unknown sender run without rearming its healthy baseline
func TestClearsUnknownSenderRunWithoutRearmingHealthyBaseline(t *testing.T) {
	routes := newController(2, Options{QualityConvergenceEnabled: true})
	addViewer(routes, A, 2, nil)
	addViewer(routes, B, 2, nil)
	routes.hydrateEdge(A, peerEdge(HOST, "a_from_host"))
	routes.hydrateEdge(B, peerEdge(HOST, "b_from_host"))
	for _, seed := range [][2]string{{A, "a_from_host"}, {B, "b_from_host"}} {
		eq(t, observeSenderState(routes, senderState{
			childPeerID: seed[0], connectionID: seed[1], state: SenderQualityHealthy, acceptedAtMs: 0,
		}).Accepted, true)
	}
	eq(t, observeSenderState(routes, senderState{
		childPeerID: A, connectionID: "a_from_host", state: SenderQualityDegraded, acceptedAtMs: 1,
	}).Accepted, true)
	eq(t, routes.ObserveSenderQualityEvidence(unknownSample(HOST, A, routes.Snapshot().Revision, "a_from_host", 2), nil).Accepted, true)

	for _, acceptedAtMs := range []int64{3, 4, 5} {
		eq(t, observeSenderState(routes, senderState{
			childPeerID: A, connectionID: "a_from_host", state: SenderQualityDegraded, acceptedAtMs: acceptedAtMs,
		}).Accepted, true)
	}
	operation := must(t, routes.Reconcile(6).Operation)
	eq(t, operation.ChildPeerID, A)
	eq(t, operation.Reason, DemandQualityConvergence)
}

// TS 448: consumes a quality candidate rejected at preparation instead of rebuilding it
func TestConsumesQualityCandidateRejectedAtPreparation(t *testing.T) {
	routes := newController(2, Options{QualityConvergenceEnabled: true})
	addViewer(routes, A, 2, nil)
	addViewer(routes, B, 2, nil)
	routes.hydrateEdge(A, peerEdge(HOST, "a_from_host"))
	routes.hydrateEdge(B, peerEdge(HOST, "b_from_host"))
	observePersistentDegraded(t, routes, A, "a_from_host", 0)
	first := must(t, routes.Reconcile(10).Operation)
	eq(t, first.ChildPeerID, A)
	eq(t, first.Reason, DemandQualityConvergence)
	rejected := first.Candidates[first.Cursor].Tuple

	operation := first
	for round := 0; operation != nil && round < 4; round++ {
		if round > 0 && slices.Contains(tuplesFrom(operation, operation.Cursor), rejected) {
			t.Fatalf("round %d rebuilt the rejected tuple %+v", round, rejected)
		}
		eq(t, routes.SkipCurrentCandidate(cursorGuard(operation), int64(11+round), RejectionStale).Accepted, true)
		operation = routes.Reconcile(int64(12 + round)).Operation
	}
	noOperation(t, operation)
}

// TS 480: lets a newly committed availability edge report persistent degradation before healthy
func TestNewlyCommittedEdgeReportsPersistentDegradationBeforeHealthy(t *testing.T) {
	routes := newController(2, Options{QualityConvergenceEnabled: true})
	addViewer(routes, B, 2, nil)
	routes.hydrateEdge(B, peerEdge(HOST, "b_from_host"))
	addViewer(routes, A, 2, ms(0))
	joined := must(t, routes.Reconcile(0).Operation)
	eq(t, joined.ChildPeerID, A)
	commitCurrent(t, routes, 1, "a_from_host")

	for _, acceptedAtMs := range []int64{2, 3, 4} {
		eq(t, observeSenderState(routes, senderState{
			childPeerID: A, connectionID: "a_from_host", state: SenderQualityDegraded, acceptedAtMs: acceptedAtMs,
		}).Accepted, true)
	}

	operation := must(t, routes.Reconcile(5).Operation)
	eq(t, operation.ChildPeerID, A)
	eq(t, operation.Reason, DemandQualityConvergence)
}

// TS 506: starts a fresh degradation run when an availability sender identity changes
func TestStartsFreshDegradationRunWhenSenderIdentityChanges(t *testing.T) {
	routes := newController(2, Options{QualityConvergenceEnabled: true})
	addViewer(routes, B, 2, nil)
	routes.hydrateEdge(B, peerEdge(HOST, "b_from_host"))
	addViewer(routes, A, 2, ms(0))
	routes.Reconcile(0)
	commitCurrent(t, routes, 1, "a_from_host")

	observe := func(identity string, at int64) {
		t.Helper()
		eq(t, observeSenderState(routes, senderState{
			childPeerID: A, connectionID: "a_from_host", senderIdentity: identity, state: SenderQualityDegraded, acceptedAtMs: at,
		}).Accepted, true)
	}
	observe("old-rtp\x00track", 2)
	observe("old-rtp\x00track", 3)
	observe("new-rtp\x00track", 4)
	noOperation(t, routes.Reconcile(4).Operation)
	observe("new-rtp\x00track", 5)
	observe("new-rtp\x00track", 6)
	operation := must(t, routes.Reconcile(7).Operation)
	eq(t, operation.ChildPeerID, A)
	eq(t, operation.Reason, DemandQualityConvergence)
}

// TS 566: lets a reset sender begin a new degradation run without a healthy sample
func TestResetSenderBeginsNewDegradationRunWithoutHealthySample(t *testing.T) {
	routes := newController(2, Options{QualityConvergenceEnabled: true})
	addViewer(routes, B, 2, nil)
	routes.hydrateEdge(B, peerEdge(HOST, "b_from_host"))
	addViewer(routes, A, 2, ms(0))
	routes.Reconcile(0)
	commitCurrent(t, routes, 1, "a_from_host")
	eq(t, observeSenderState(routes, senderState{
		childPeerID: A, connectionID: "a_from_host", state: SenderQualityHealthy, acceptedAtMs: 2,
	}).Accepted, true)

	routes.ResetSenderQuality(HOST, "host_session", 3)
	for _, acceptedAtMs := range []int64{4, 5, 6} {
		eq(t, observeSenderState(routes, senderState{
			childPeerID: A, connectionID: "a_from_host", state: SenderQualityDegraded, acceptedAtMs: acceptedAtMs,
		}).Accepted, true)
	}
	operation := must(t, routes.Reconcile(7).Operation)
	eq(t, operation.ChildPeerID, A)
	eq(t, operation.Reason, DemandQualityConvergence)
}

// TS 599: regenerates a persistently degraded edge on the same parent
func TestRegeneratesPersistentlyDegradedEdgeOnSameParent(t *testing.T) {
	routes := newController(2, Options{QualityConvergenceEnabled: true})
	addViewer(routes, A, 2, nil)
	routes.hydrateEdge(A, peerEdge(HOST, "a_from_host"))
	observePersistentDegraded(t, routes, A, "a_from_host", 10)

	operation := must(t, routes.Reconcile(14).Operation)
	eq(t, len(operation.Candidates), 1)
	eq(t, operation.Candidates[0].Tuple, regenerateTuple(HOST))
	expectTransition(t, operation.Candidates[0].EndpointTransition, TransitionNone, HOST)

	begin := beginOperation(t, routes, BeginInput{NowMs: 15, ConnectionID: "a_regenerated", Reservation: direct()})
	edge := edgeOf(t, routes, A)
	eq(t, edge.ParentPeerID, HOST)
	eq(t, edge.ConnectionID, "a_from_host")
	eq(t, edge.Usable, true)
	eq(t, edge.PhysicalActive, true)
	guard := guardFor(A, begin.Current.Revision, "a_regenerated")
	ready := routes.CandidateReady(guard, 16, nil, CandidateProof{RelativeQualityApproved: true})
	eq(t, ready.Accepted, true)
	eq(t, ready.Committed, false)

	eq(t, routes.ObserveSenderQualityEvidence(senderSample(
		HOST, A, begin.Current.Revision, "a_regenerated", "a-regenerated-rtp\x00track", SenderQualityHealthy, 17), nil).Committed, true)
	edge = edgeOf(t, routes, A)
	eq(t, edge.Kind, UpstreamPeer)
	eq(t, edge.ParentPeerID, HOST)
	eq(t, edge.ConnectionID, "a_regenerated")
	eq(t, observeSenderState(routes, senderState{
		childPeerID: A, connectionID: "a_regenerated", senderIdentity: "a-regenerated-rtp\x00track",
		state: SenderQualityHealthy, acceptedAtMs: 18,
	}).Accepted, true)
	for _, acceptedAtMs := range []int64{19, 20, 21} {
		eq(t, observeSenderState(routes, senderState{
			childPeerID: A, connectionID: "a_regenerated", senderIdentity: "a-regenerated-rtp\x00track",
			state: SenderQualityDegraded, acceptedAtMs: acceptedAtMs,
		}).Accepted, true)
	}
	eq(t, must(t, routes.Reconcile(22).Operation).Candidates[0].Tuple, regenerateTuple(HOST))
}

// TS 686: keeps same-edge regeneration damped while allowing a different parent
func TestKeepsSameEdgeRegenerationDampedWhileAllowingDifferentParent(t *testing.T) {
	routes := newController(2, Options{QualityConvergenceEnabled: true})
	addViewer(routes, A, 2, nil)
	routes.hydrateEdge(A, peerEdge(HOST, "a_from_host"))
	observePersistentDegraded(t, routes, A, "a_from_host", 10)

	routes.Reconcile(14)
	begin := beginOperation(t, routes, BeginInput{NowMs: 15, ConnectionID: "a_regenerated", Reservation: direct()})
	guard := guardFor(A, begin.Current.Revision, "a_regenerated")
	routes.CandidateReady(guard, 16, nil, CandidateProof{RelativeQualityApproved: true})
	eq(t, routes.ObserveSenderQualityEvidence(senderSample(
		HOST, A, begin.Current.Revision, "a_regenerated", "a-regenerated-rtp\x00track", SenderQualityHealthy, 17), nil).Committed, true)

	for _, acceptedAtMs := range []int64{18, 19, 20} {
		eq(t, observeSenderState(routes, senderState{
			childPeerID: A, connectionID: "a_regenerated", senderIdentity: "a-regenerated-rtp\x00track",
			state: SenderQualityDegraded, acceptedAtMs: acceptedAtMs,
		}).Accepted, true)
	}
	noOperation(t, routes.Reconcile(21).Operation)

	addViewer(routes, B, 2, nil)
	routes.hydrateEdge(B, peerEdge(HOST, "b_from_host"))
	eq(t, observeSenderState(routes, senderState{
		childPeerID: B, connectionID: "b_from_host", state: SenderQualityHealthy, acceptedAtMs: 22,
	}).Accepted, true)
	withAlternate := must(t, routes.Reconcile(23).Operation)
	eq(t, withAlternate.ChildPeerID, A)
	eq(t, withAlternate.Reason, DemandQualityConvergence)
	eqSlice(t, tuples(withAlternate), []CandidateTuple{peerTuple(B)})
}

// TS 754: uses the existing one-slot overlap for same-parent regeneration
func TestUsesExistingOneSlotOverlapForSameParentRegeneration(t *testing.T) {
	routes := newController(1, Options{QualityConvergenceEnabled: true})
	addViewer(routes, A, 1, nil)
	routes.hydrateEdge(A, peerEdge(HOST, "a_from_host"))
	observePersistentDegraded(t, routes, A, "a_from_host", 10)

	operation := must(t, routes.Reconcile(14).Operation)
	expectTransition(t, operation.Candidates[0].EndpointTransition, TransitionOverlap, HOST)
	begin := beginOperation(t, routes, BeginInput{NowMs: 15, ConnectionID: "a_regenerated", Reservation: directOverlap("a_overlap")})
	guard := guardFor(A, begin.Current.Revision, "a_regenerated")
	routes.CandidateReady(guard, 16, nil, CandidateProof{RelativeQualityApproved: true})
	committed := routes.ObserveSenderQualityEvidence(senderSample(
		HOST, A, begin.Current.Revision, "a_regenerated", "a-regenerated-rtp\x00track", SenderQualityHealthy, 17), nil)
	eq(t, committed.Committed, true)
	containsLabels(t, committed.Released, "a_overlap")
}

// TS 794: keeps one quality experiment through inconclusive current windows
func TestKeepsOneQualityExperimentThroughInconclusiveWindows(t *testing.T) {
	routes := newController(2, Options{QualityConvergenceEnabled: true})
	addViewer(routes, A, 2, nil)
	addViewer(routes, B, 2, nil)
	routes.hydrateEdge(A, peerEdge(HOST, "a_from_host"))
	routes.hydrateEdge(B, peerEdge(HOST, "b_from_host"))
	observeSenderState(routes, senderState{childPeerID: B, connectionID: "b_from_host", state: SenderQualityHealthy, acceptedAtMs: 9})
	observePersistentDegraded(t, routes, A, "a_from_host", 10)

	operation := must(t, routes.Reconcile(14).Operation)
	eqSlice(t, tuples(operation), []CandidateTuple{peerTuple(B), regenerateTuple(HOST)})
	beginCandidate(t, routes, BeginInput{NowMs: 15, ConnectionID: "a_from_b_failed", Reservation: direct()})

	currentRevision := routes.Snapshot().Revision
	eq(t, routes.ObserveSenderQualityEvidence(unknownSample(HOST, A, currentRevision, "a_from_host", 16), nil).Accepted, true)
	pending := must(t, routes.Snapshot().Operation)
	eq(t, pending.Reason, DemandQualityConvergence)
	eq(t, pending.Cursor, 0)

	afterFirst := routes.OperationExpired(must(t, routes.Snapshot().Operation).WakeAtMs)
	eq(t, afterFirst.Accepted, true)
	pending = must(t, routes.Snapshot().Operation)
	eq(t, pending.Reason, DemandQualityConvergence)
	eq(t, pending.Cursor, 1)
	regeneration := beginOperation(t, routes, BeginInput{
		NowMs: 20, ConnectionID: "a_regeneration_failed", Reservation: directOverlap("a_regeneration_overlap"),
	})
	eq(t, routes.CandidateFailed(guardFor(A, regeneration.Current.Revision, "a_regeneration_failed"), 21).Accepted, true)
	noOperation(t, routes.Snapshot().Operation)

	for _, acceptedAtMs := range []int64{22, 23, 24} {
		eq(t, observeSenderState(routes, senderState{
			childPeerID: A, connectionID: "a_from_host", state: SenderQualityDegraded, acceptedAtMs: acceptedAtMs,
		}).Accepted, true)
	}
	noOperation(t, routes.Reconcile(25).Operation)
	routes.TouchExternalFacts()
	noOperation(t, routes.Reconcile(26).Operation)

	addViewer(routes, C, 2, nil)
	routes.hydrateEdge(C, peerEdge(B, "c_from_b"))
	observeSenderState(routes, senderState{
		childPeerID: C, connectionID: "c_from_b", parentPeerID: B, state: SenderQualityHealthy, acceptedAtMs: 27,
	})
	newOpportunity := must(t, routes.Reconcile(28).Operation)
	eq(t, newOpportunity.ChildPeerID, A)
	eq(t, newOpportunity.Reason, DemandQualityConvergence)
	eqSlice(t, tuples(newOpportunity), []CandidateTuple{peerTuple(C)})
}

// TS 902: does not restart a quality candidate set after its total deadline
func TestDoesNotRestartQualityCandidateSetAfterTotalDeadline(t *testing.T) {
	routes := newController(2, Options{QualityConvergenceEnabled: true})
	addViewer(routes, A, 2, nil)
	addViewer(routes, B, 2, nil)
	routes.hydrateEdge(A, peerEdge(HOST, "a_from_host"))
	routes.hydrateEdge(B, peerEdge(HOST, "b_from_host"))
	observeSenderState(routes, senderState{childPeerID: B, connectionID: "b_from_host", state: SenderQualityHealthy, acceptedAtMs: 9})
	observePersistentDegraded(t, routes, A, "a_from_host", 10)

	operation := must(t, routes.Reconcile(14).Operation)
	beginCandidate(t, routes, BeginInput{NowMs: 15, ConnectionID: "a_from_b_pending", Reservation: direct()})
	eq(t, routes.OperationExpired(operation.DeadlineAtMs).Accepted, true)
	noOperation(t, routes.Snapshot().Operation)
	noOperation(t, routes.Reconcile(operation.DeadlineAtMs+1).Operation)
	routes.TouchExternalFacts()
	noOperation(t, routes.Reconcile(operation.DeadlineAtMs+2).Operation)

	observeSenderState(routes, senderState{
		childPeerID: A, connectionID: "a_from_host", state: SenderQualityHealthy, acceptedAtMs: operation.DeadlineAtMs + 3,
	})
	for _, acceptedAtMs := range []int64{operation.DeadlineAtMs + 4, operation.DeadlineAtMs + 5, operation.DeadlineAtMs + 6} {
		observeSenderState(routes, senderState{
			childPeerID: A, connectionID: "a_from_host", state: SenderQualityDegraded, acceptedAtMs: acceptedAtMs,
		})
	}
	eq(t, must(t, routes.Reconcile(operation.DeadlineAtMs+7).Operation).Reason, DemandQualityConvergence)
}

// TS 951: keeps isolated limitation windows diagnostic
func TestKeepsIsolatedLimitationWindowsDiagnostic(t *testing.T) {
	routes := newController(2, Options{QualityConvergenceEnabled: true})
	addViewer(routes, A, 2, nil)
	addViewer(routes, B, 2, nil)
	routes.hydrateEdge(A, peerEdge(HOST, "a_from_host"))
	routes.hydrateEdge(B, peerEdge(HOST, "b_from_host"))
	observeSenderState(routes, senderState{childPeerID: B, connectionID: "b_from_host", state: SenderQualityHealthy, acceptedAtMs: 99})
	observeSenderState(routes, senderState{childPeerID: A, connectionID: "a_from_host", state: SenderQualityHealthy, acceptedAtMs: 99})
	observeSenderState(routes, senderState{childPeerID: A, connectionID: "a_from_host", state: SenderQualityDegraded, acceptedAtMs: 100})
	repeated := senderSample(HOST, A, routes.Snapshot().Revision, "a_from_host", "a_from_host-rtp\x00track", SenderQualityDegraded, 101)
	repeated.SampleTimestampMs = ms(100) // TS: sampleTimestampMs 100 with acceptedAtMs 101
	eq(t, routes.ObserveSenderQualityEvidence(repeated, nil).Accepted, true)
	noOperation(t, routes.Reconcile(101).Operation)
	for _, acceptedAtMs := range []int64{102} {
		observeSenderState(routes, senderState{childPeerID: A, connectionID: "a_from_host", state: SenderQualityDegraded, acceptedAtMs: acceptedAtMs})
		noOperation(t, routes.Reconcile(acceptedAtMs).Operation)
	}
	observeSenderState(routes, senderState{childPeerID: A, connectionID: "a_from_host", state: SenderQualityDegraded, acceptedAtMs: 103})
	operation := must(t, routes.Reconcile(104).Operation)
	eq(t, operation.ChildPeerID, A)
	eq(t, operation.Reason, DemandQualityConvergence)
}

// TS 1010: never treats one degraded Host edge as SFU fanout pressure
func TestNeverTreatsOneDegradedHostEdgeAsSfuFanoutPressure(t *testing.T) {
	routes := newController(2, Options{SfuEnabled: true, QualityConvergenceEnabled: true})
	addViewer(routes, A, 1, nil)
	addViewer(routes, B, 0, nil)
	routes.hydrateEdge(A, peerEdge(HOST, "a_from_host"))
	routes.hydrateHostPublication("publication_generation_12345678", res("publication_resource"), "")
	routes.hydrateEdge(B, sfuEdge("publication_generation_12345678", "b_from_sfu", "b_subscription"))
	// Isolate quality convergence: this established SFU relay has already tried
	// its own Peer opportunities, while remaining eligible to supply A.
	for _, plan := range routes.buildCandidates(B, false) {
		if plan.Tuple.Kind == UpstreamPeer {
			routes.consumeCandidateOpportunity(B, plan)
		}
	}

	observePersistentDegraded(t, routes, A, "a_from_host", 99)
	observePersistentSfuHealthy(t, routes, "publication_generation_12345678", routes.Snapshot().Revision, 103)
	operation := must(t, routes.Reconcile(104).Operation)
	eq(t, operation.Reason, DemandQualityConvergence)
	eq(t, len(operation.Candidates), 1)
	eq(t, operation.Candidates[0].Tuple, regenerateTuple(HOST))
	edge := edgeOf(t, routes, A)
	eq(t, edge.Kind, UpstreamPeer)
	eq(t, edge.ParentPeerID, HOST)
}

// TS 1052: commits only after the Viewer approves a P2P receive improvement
func TestCommitsOnlyAfterViewerApprovesP2PReceiveImprovement(t *testing.T) {
	routes := newController(2, Options{QualityConvergenceEnabled: true})
	addViewer(routes, A, 2, nil)
	addViewer(routes, B, 2, nil)
	routes.hydrateEdge(A, peerEdge(HOST, "a_from_host"))
	routes.hydrateEdge(B, peerEdge(HOST, "b_from_host"))
	eq(t, observeSenderState(routes, senderState{
		childPeerID: B, connectionID: "b_from_host", state: SenderQualityHealthy, acceptedAtMs: 100,
	}).Accepted, true)
	observePersistentDegraded(t, routes, A, "a_from_host", 99)

	operation := must(t, routes.Reconcile(103).Operation)
	eq(t, operation.Reason, DemandQualityConvergence)
	eq(t, operation.Candidates[0].Tuple, peerTuple(B))
	begin := beginCandidate(t, routes, BeginInput{NowMs: 104, ConnectionID: "a_from_b", Reservation: direct()})
	current := must(t, begin.Operation).Current
	guard := guardFor(A, current.Revision, "a_from_b")
	edge := edgeOf(t, routes, A)
	eq(t, edge.Kind, UpstreamPeer)
	eq(t, edge.ParentPeerID, HOST)
	eq(t, edge.ConnectionID, "a_from_host")
	ready := routes.CandidateReady(guard, 105, nil, CandidateProof{RelativeQualityApproved: true})
	eq(t, ready.Accepted, true)
	eq(t, ready.Committed, false)
	eq(t, routes.ObserveSenderQualityEvidence(senderSample(
		B, A, current.Revision, "a_from_b", "a-from-b-rtp\x00a-track", SenderQualityHealthy, 106), nil).Committed, true)
	edge = edgeOf(t, routes, A)
	eq(t, edge.Kind, UpstreamPeer)
	eq(t, edge.ParentPeerID, B)
	eq(t, edge.ConnectionID, "a_from_b")

	migratedRevision := routes.Snapshot().Revision
	observeMigrated := func(state SenderQualityState, at int64) SenderQualityEvidenceResult {
		return routes.ObserveSenderQualityEvidence(senderSample(
			B, A, migratedRevision, "a_from_b", "a-from-b-rtp\x00a-track", state, at), nil)
	}
	for _, acceptedAtMs := range []int64{107, 108, 109} {
		eq(t, observeMigrated(SenderQualityDegraded, acceptedAtMs).Accepted, true)
	}
	noOperation(t, routes.Reconcile(110).Operation)
	routes.TouchExternalFacts()
	noOperation(t, routes.Reconcile(110).Operation)
	eq(t, observeMigrated(SenderQualityHealthy, 111).Accepted, true)
	eq(t, observeMigrated(SenderQualityDegraded, 112).Accepted, true)
	eq(t, observeMigrated(SenderQualityDegraded, 113).Accepted, true)
	eq(t, observeMigrated(SenderQualityDegraded, 114).Accepted, true)
	eq(t, must(t, routes.Reconcile(115).Operation).Reason, DemandQualityConvergence)
}

// TS 1147: uses one healthy serial operation to distribute a newly committed Host root
func TestUsesOneHealthySerialOperationToDistributeNewHostRoot(t *testing.T) {
	routes := newController(2, Options{QualityConvergenceEnabled: true})
	addViewer(routes, B, 2, nil)
	addViewer(routes, C, 0, nil)
	addViewer(routes, D, 0, nil)
	routes.hydrateEdge(B, peerEdge(HOST, "b_from_host"))
	routes.hydrateEdge(C, peerEdge(B, "c_from_b"))
	routes.hydrateEdge(D, peerEdge(B, "d_from_b"))
	addViewer(routes, A, 2, ms(10))

	joined := must(t, routes.Reconcile(10).Operation)
	eq(t, joined.Candidates[0].Tuple, peerTuple(HOST))
	commitCurrent(t, routes, 11, "a_from_host")

	convergence := must(t, routes.Reconcile(13).Operation)
	eq(t, convergence.Reason, DemandRootConvergence)
	eq(t, len(convergence.Candidates), 1)
	eq(t, convergence.Candidates[0].Tuple, peerTuple(A))
	eq(t, edgeOf(t, routes, convergence.ChildPeerID).ParentPeerID, B)

	prepared := beginOperation(t, routes, BeginInput{NowMs: 14, ConnectionID: "root_convergence_candidate", Reservation: direct()})
	guard := CandidateGuard{
		ChildPeerID:    convergence.ChildPeerID,
		ChildSessionID: convergence.ChildSessionID,
		Revision:       prepared.Current.Revision,
		ConnectionID:   "root_convergence_candidate",
	}
	ready := routes.CandidateReady(guard, 15, nil, CandidateProof{})
	eq(t, ready.Accepted, true)
	eq(t, ready.Committed, false)
	eq(t, routes.ObserveSenderQualityEvidence(senderSample(
		A, convergence.ChildPeerID, prepared.Current.Revision, "root_convergence_candidate", "root-rtp\x00track",
		SenderQualityHealthy, 16), nil).Committed, true)
	eq(t, edgeOf(t, routes, convergence.ChildPeerID).ParentPeerID, A)
	migratedChildPeerID := convergence.ChildPeerID
	for _, acceptedAtMs := range []int64{17, 18, 19} {
		eq(t, observeSenderState(routes, senderState{
			childPeerID: migratedChildPeerID, connectionID: "root_convergence_candidate", parentPeerID: A,
			state: SenderQualityDegraded, acceptedAtMs: acceptedAtMs,
		}).Accepted, true)
	}
	noOperation(t, routes.Reconcile(20).Operation)
	eq(t, observeSenderState(routes, senderState{
		childPeerID: migratedChildPeerID, connectionID: "root_convergence_candidate", parentPeerID: A,
		state: SenderQualityHealthy, acceptedAtMs: 21,
	}).Accepted, true)
	for _, acceptedAtMs := range []int64{22, 23, 24} {
		eq(t, observeSenderState(routes, senderState{
			childPeerID: migratedChildPeerID, connectionID: "root_convergence_candidate", parentPeerID: A,
			state: SenderQualityDegraded, acceptedAtMs: acceptedAtMs,
		}).Accepted, true)
	}
	eq(t, must(t, routes.Reconcile(25).Operation).Reason, DemandQualityConvergence)
}

// TS 1247: advances a silent Peer only when another bounded candidate remains
func TestAdvancesSilentPeerOnlyWhenAnotherBoundedCandidateRemains(t *testing.T) {
	routes := newController(2, Options{OperationTimeoutMs: 20_000})
	addViewer(routes, B, 2, nil)
	addViewer(routes, C, 2, nil)
	routes.hydrateEdge(B, peerEdge(HOST, "b_from_host"))
	routes.hydrateEdge(C, peerEdge(HOST, "c_from_host"))
	addViewer(routes, A, 0, ms(0))

	operation := must(t, routes.Reconcile(0).Operation)
	beginCandidate(t, routes, BeginInput{NowMs: 100, ConnectionID: "first_silent_candidate", Reservation: direct()})
	eq(t, must(t, routes.Snapshot().Operation).WakeAtMs, 5_100)
	eq(t, routes.OperationExpired(5_100).Accepted, true)

	beginCandidate(t, routes, BeginInput{NowMs: 5_200, ConnectionID: "second_silent_candidate", Reservation: direct()})
	eq(t, must(t, routes.Snapshot().Operation).WakeAtMs, operation.DeadlineAtMs)
	eq(t, must(t, routes.Snapshot().Operation).DeadlineAtMs, operation.DeadlineAtMs)
	eq(t, routes.OperationExpired(10_200).Accepted, false)
	eq(t, must(t, routes.Snapshot().Operation).Current.ConnectionID, "second_silent_candidate")
}

// TS 1281: retains a peer-only direct attempt through the total operation deadline
func TestRetainsPeerOnlyDirectAttemptThroughTotalDeadline(t *testing.T) {
	routes := newController(1, Options{OperationTimeoutMs: 20_000})
	addViewer(routes, A, 0, ms(0))

	operation := must(t, routes.Reconcile(0).Operation)
	beginCandidate(t, routes, BeginInput{NowMs: 100, ConnectionID: "only_direct_candidate", Reservation: direct()})

	eq(t, must(t, routes.Snapshot().Operation).WakeAtMs, operation.DeadlineAtMs)
	eq(t, routes.OperationExpired(5_100).Accepted, false)
	eq(t, must(t, routes.Snapshot().Operation).Current.ConnectionID, "only_direct_candidate")
	expired := routes.OperationExpired(operation.DeadlineAtMs)
	eq(t, expired.Accepted, true)
	eqSlice(t, expired.FailedPeerIDs, []string{A})
}

// TS 1305: keeps only fresh exact-edge quality shadow aggregates
func TestKeepsOnlyFreshExactEdgeQualityShadowAggregates(t *testing.T) {
	routes := newController(2, Options{})
	addViewer(routes, A, 1, ms(0))
	routes.Reconcile(10)
	commitCurrent(t, routes, 20, "a_quality_connection")
	active := routes.Snapshot()

	eq(t, routes.ObserveQualityEvidence(qualityWindow(
		A, active.Revision, "a_quality_connection", peerUpstream(HOST), 1, 1_000, qualityMetrics())), QualityEvidenceObserved)
	eq(t, routes.Snapshot().Revision, active.Revision)
	eq(t, routes.Snapshot().FactVersion, active.FactVersion)
	addViewer(routes, B, 0, ms(1_100))
	routes.Reconcile(1_200)
	commitCurrent(t, routes, 1_210, "b_quality_connection")
	quality := routes.RouteDiagnosticSnapshot(1_300).Children[0].Quality
	if quality == nil {
		t.Fatal("expected quality aggregates")
	}
	eq(t, *quality, protocol.RouteDiagnosticQuality{
		EligibleWindows:    1,
		EligibleDurationMs: 2_000,
		FreezeWindows:      1,
		FreezeCount:        1,
		FreezeDurationMs:   250,
		PauseCount:         0,
		PauseDurationMs:    0,
	})
	if routes.RouteDiagnosticSnapshot(5_999).Children[0].Quality == nil {
		t.Fatal("quality expired before 6_000")
	}
	if routes.RouteDiagnosticSnapshot(6_000).Children[0].Quality != nil {
		t.Fatal("quality did not expire at 6_000")
	}

	nextRevision := routes.Snapshot().Revision
	nullDecoded := qualityMetrics()
	nullDecoded.FramesDecodedDelta = nil
	eq(t, routes.ObserveQualityEvidence(qualityWindow(
		A, nextRevision, "a_quality_connection", peerUpstream(HOST), 2, 7_000, nullDecoded)), QualityEvidenceAccepted)
	if routes.RouteDiagnosticSnapshot(7_100).Children[0].Quality != nil {
		t.Fatal("expected no quality after an accepted-only window")
	}
	eq(t, routes.ObserveQualityEvidence(qualityWindow(
		A, nextRevision, "a_quality_connection", peerUpstream(HOST), 2, 7_100, qualityMetrics())), QualityEvidenceObserved)
	eq(t, routes.ObserveQualityEvidence(qualityWindow(
		A, nextRevision, "a_quality_connection", peerUpstream(HOST), 1, 7_200, qualityMetrics())), QualityEvidenceRejected)

	routes.SetPaused(true, ms(7_300))
	if routes.RouteDiagnosticSnapshot(7_301).Children[0].Quality != nil {
		t.Fatal("expected no quality while paused")
	}
}

// TS 1390: waits for a fresh healthy candidate sender after relative proof
func TestWaitsForFreshHealthyCandidateSenderAfterRelativeProof(t *testing.T) {
	routes := newController(2, Options{QualityConvergenceEnabled: true})
	addViewer(routes, A, 2, nil)
	addViewer(routes, B, 2, nil)
	routes.hydrateEdge(A, peerEdge(HOST, "a_from_host"))
	routes.hydrateEdge(B, peerEdge(HOST, "b_from_host"))
	eq(t, observeSenderState(routes, senderState{
		childPeerID: B, connectionID: "b_from_host", state: SenderQualityHealthy, acceptedAtMs: 100,
	}).Accepted, true)
	observePersistentDegraded(t, routes, A, "a_from_host", 99)
	routes.Reconcile(103)
	begin := beginCandidate(t, routes, BeginInput{NowMs: 104, ConnectionID: "a_from_b", Reservation: direct()})
	current := must(t, begin.Operation).Current
	eq(t, routes.CandidateTransportConnected(guardFor(A, current.Revision, "a_from_b"), 105).Accepted, true)
	eq(t, routes.ObserveSenderQualityEvidence(senderSample(
		B, A, current.Revision, "a_from_b", "a-from-b-rtp\x00track", SenderQualityDegraded, 105), nil).Accepted, true)
	eq(t, routes.CandidateReady(guardFor(A, current.Revision, "a_from_b"), 106, nil, CandidateProof{RelativeQualityApproved: true}).Committed, false)
	eq(t, routes.ObserveSenderQualityEvidence(senderSample(
		B, A, current.Revision, "a_from_b", "a-from-b-rtp\x00track", SenderQualityHealthy, 107), nil).Committed, true)
}

// TS 1464: does not commit a relative proof after its freshness window expires
func TestDoesNotCommitRelativeProofAfterFreshnessWindowExpires(t *testing.T) {
	routes := newController(2, Options{QualityConvergenceEnabled: true})
	addViewer(routes, A, 2, nil)
	addViewer(routes, B, 2, nil)
	routes.hydrateEdge(A, peerEdge(HOST, "a_from_host"))
	routes.hydrateEdge(B, peerEdge(HOST, "b_from_host"))
	observePersistentDegraded(t, routes, A, "a_from_host", 99)
	routes.Reconcile(103)
	begin := beginCandidate(t, routes, BeginInput{NowMs: 104, ConnectionID: "a_from_b_stale_proof", Reservation: direct()})
	current := must(t, begin.Operation).Current
	guard := guardFor(A, current.Revision, "a_from_b_stale_proof")
	eq(t, routes.CandidateTransportConnected(guard, 105).Accepted, true)

	eq(t, routes.CandidateReady(guard, 105, nil, CandidateProof{RelativeQualityApproved: true}).Committed, false)
	eq(t, routes.CandidateReady(guard, 109, nil, CandidateProof{RelativeQualityApproved: true}).Committed, false)
	for _, acceptedAtMs := range []int64{5_105, 5_106, 5_107} {
		eq(t, observeSenderState(routes, senderState{
			childPeerID: A, connectionID: "a_from_host", state: SenderQualityDegraded, acceptedAtMs: acceptedAtMs,
		}).Accepted, true)
	}
	settled := routes.ObserveSenderQualityEvidence(senderSample(
		B, A, current.Revision, guard.ConnectionID, "stale-proof-rtp\x00track", SenderQualityHealthy, 5_111), nil)
	eq(t, settled.Accepted, true)
	eq(t, settled.Committed, false)
	operation := must(t, routes.Snapshot().Operation)
	eq(t, operation.Reason, DemandQualityConvergence)
	eq(t, operation.Cursor, 1)
	edge := edgeOf(t, routes, A)
	eq(t, edge.ParentPeerID, HOST)
	eq(t, edge.ConnectionID, "a_from_host")
}

// TS 1528: abandons a pending quality move when the incumbent recovers
func TestAbandonsPendingQualityMoveWhenIncumbentRecovers(t *testing.T) {
	routes := newController(2, Options{QualityConvergenceEnabled: true})
	addViewer(routes, A, 2, nil)
	addViewer(routes, B, 2, nil)
	routes.hydrateEdge(A, peerEdge(HOST, "a_from_host"))
	routes.hydrateEdge(B, peerEdge(HOST, "b_from_host"))
	observePersistentDegraded(t, routes, A, "a_from_host", 99)
	routes.Reconcile(103)
	begin := beginCandidate(t, routes, BeginInput{NowMs: 104, ConnectionID: "a_from_b_incumbent_recovery", Reservation: direct()})
	current := must(t, begin.Operation).Current
	guard := guardFor(A, current.Revision, "a_from_b_incumbent_recovery")
	eq(t, routes.CandidateReady(guard, 105, nil, CandidateProof{RelativeQualityApproved: true}).Committed, false)

	eq(t, observeSenderState(routes, senderState{
		childPeerID: A, connectionID: "a_from_host", state: SenderQualityHealthy, acceptedAtMs: 106,
	}).Accepted, true)
	noOperation(t, routes.Snapshot().Operation)
	eq(t, routes.ObserveSenderQualityEvidence(senderSample(
		B, A, current.Revision, guard.ConnectionID, "late-healthy-rtp\x00track", SenderQualityHealthy, 107), nil).Accepted, false)
	edge := edgeOf(t, routes, A)
	eq(t, edge.ParentPeerID, HOST)
	eq(t, edge.ConnectionID, "a_from_host")
}

func TestQualityReadinessKeepsInconclusiveIncumbentWithinTheSameOperation(t *testing.T) {
	for _, unknownFirst := range []bool{true, false} {
		t.Run(fmt.Sprintf("unknown before readiness=%v", unknownFirst), func(t *testing.T) {
			routes := newController(2, Options{QualityConvergenceEnabled: true})
			addViewer(routes, A, 2, nil)
			addViewer(routes, B, 2, nil)
			routes.hydrateEdge(A, peerEdge(HOST, "a_from_host"))
			routes.hydrateEdge(B, peerEdge(HOST, "b_from_host"))
			observePersistentDegraded(t, routes, A, "a_from_host", 99)
			operation := must(t, routes.Reconcile(103).Operation)
			begin := beginOperation(t, routes, BeginInput{NowMs: 104, ConnectionID: "a_from_b", Reservation: direct()})
			guard := guardFor(A, begin.Current.Revision, "a_from_b")
			unknown := func(at int64) {
				eq(t, routes.ObserveSenderQualityEvidence(unknownSample(HOST, A, routes.Snapshot().Revision, "a_from_host", at), nil).Accepted, true)
			}
			ready := func(at int64) {
				settled := routes.CandidateReady(guard, at, nil, CandidateProof{RelativeQualityApproved: true})
				eq(t, settled.Accepted, true)
				eq(t, settled.Committed, false)
			}
			if unknownFirst {
				unknown(105)
				ready(106)
			} else {
				ready(105)
				unknown(106)
			}
			pending := must(t, routes.Snapshot().Operation)
			eq(t, pending.Current.Revision, guard.Revision)
			eq(t, pending.DeadlineAtMs, operation.DeadlineAtMs)
			eq(t, edgeOf(t, routes, A).ConnectionID, "a_from_host")
			settled := routes.ObserveSenderQualityEvidence(senderSample(
				B, A, guard.Revision, guard.ConnectionID, "candidate-rtp\x00track", SenderQualityHealthy, 107), nil)
			eq(t, settled.Committed, true)
			noOperation(t, routes.Snapshot().Operation)
			eq(t, edgeOf(t, routes, A).ConnectionID, "a_from_b")
		})
	}
}

func TestInconclusiveQualityOperationStillRequiresCurrentAuthority(t *testing.T) {
	for _, cause := range []string{"healthy", "reset", "sender-replaced", "pause", "deadline"} {
		t.Run(cause, func(t *testing.T) {
			routes := newController(2, Options{QualityConvergenceEnabled: true})
			addViewer(routes, A, 2, nil)
			addViewer(routes, B, 2, nil)
			routes.hydrateEdge(A, peerEdge(HOST, "a_from_host"))
			routes.hydrateEdge(B, peerEdge(HOST, "b_from_host"))
			observePersistentDegraded(t, routes, A, "a_from_host", 99)
			operation := must(t, routes.Reconcile(103).Operation)
			begin := beginOperation(t, routes, BeginInput{NowMs: 104, ConnectionID: "a_from_b", Reservation: direct()})
			guard := guardFor(A, begin.Current.Revision, "a_from_b")
			eq(t, routes.ObserveSenderQualityEvidence(unknownSample(HOST, A, routes.Snapshot().Revision, "a_from_host", 105), nil).Accepted, true)
			eq(t, routes.CandidateReady(guard, 106, nil, CandidateProof{RelativeQualityApproved: true}).Accepted, true)
			at := int64(107)
			switch cause {
			case "healthy":
				observeSenderState(routes, senderState{childPeerID: A, connectionID: "a_from_host", state: SenderQualityHealthy, acceptedAtMs: at})
			case "reset":
				routes.ResetSenderQuality(HOST, "host_session", at)
			case "sender-replaced":
				observeSenderState(routes, senderState{childPeerID: A, connectionID: "a_from_host", senderIdentity: "replacement-rtp\x00track", state: SenderQualityDegraded, acceptedAtMs: at})
			case "pause":
				routes.SetPaused(true, &at)
			case "deadline":
				at = operation.DeadlineAtMs
			}
			eq(t, routes.CandidateReady(guard, at, nil, CandidateProof{RelativeQualityApproved: true}).Accepted, false)
			noOperation(t, routes.Snapshot().Operation)
			eq(t, edgeOf(t, routes, A).ConnectionID, "a_from_host")
		})
	}
}

// TS 1582: persists relative proof while candidate sender evidence is unknown
func TestPersistsRelativeProofWhileCandidateSenderEvidenceIsUnknown(t *testing.T) {
	routes := newController(2, Options{QualityConvergenceEnabled: true})
	addViewer(routes, A, 2, nil)
	addViewer(routes, B, 2, nil)
	routes.hydrateEdge(A, peerEdge(HOST, "a_from_host"))
	routes.hydrateEdge(B, peerEdge(HOST, "b_from_host"))
	observeSenderState(routes, senderState{childPeerID: B, connectionID: "b_from_host", state: SenderQualityHealthy, acceptedAtMs: 99})
	observePersistentDegraded(t, routes, A, "a_from_host", 99)
	routes.Reconcile(103)
	begin := beginCandidate(t, routes, BeginInput{NowMs: 104, ConnectionID: "a_from_b", Reservation: direct()})
	current := must(t, begin.Operation).Current
	eq(t, routes.ObserveSenderQualityEvidence(unknownSample(B, A, current.Revision, "a_from_b", 105), nil).Accepted, true)
	eq(t, routes.CandidateReady(guardFor(A, current.Revision, "a_from_b"), 106, nil, CandidateProof{RelativeQualityApproved: true}).Committed, false)
	eq(t, routes.ObserveSenderQualityEvidence(senderSample(
		B, A, current.Revision, "a_from_b", "a-from-b-rtp\x00track", SenderQualityHealthy, 107), nil).Committed, true)
	edge := edgeOf(t, routes, A)
	eq(t, edge.Kind, UpstreamPeer)
	eq(t, edge.ParentPeerID, B)
	eq(t, edge.ConnectionID, "a_from_b")
}

// TS 1648: advances past a persistently limited quality candidate
func TestAdvancesPastPersistentlyLimitedQualityCandidate(t *testing.T) {
	routes := newController(3, Options{QualityConvergenceEnabled: true})
	for _, seed := range [][2]string{{A, "a_from_host"}, {B, "b_from_host"}, {C, "c_from_host"}} {
		addViewer(routes, seed[0], 3, nil)
		routes.hydrateEdge(seed[0], peerEdge(HOST, seed[1]))
	}
	observeSenderState(routes, senderState{childPeerID: B, connectionID: "b_from_host", state: SenderQualityHealthy, acceptedAtMs: 99})
	observeSenderState(routes, senderState{childPeerID: C, connectionID: "c_from_host", state: SenderQualityHealthy, acceptedAtMs: 99})
	observePersistentDegraded(t, routes, A, "a_from_host", 99)

	operation := must(t, routes.Reconcile(103).Operation)
	deadlineAtMs := operation.DeadlineAtMs
	eq(t, operation.Candidates[0].Tuple.Kind, UpstreamPeer)
	firstParent := operation.Candidates[0].Tuple.ParentPeerID
	first := beginOperation(t, routes, BeginInput{NowMs: 104, ConnectionID: "first_quality_candidate", Reservation: direct()})
	var lastResult SenderQualityEvidenceResult
	for _, acceptedAtMs := range []int64{105, 106, 107} {
		lastResult = routes.ObserveSenderQualityEvidence(senderSample(
			firstParent, A, first.Current.Revision, "first_quality_candidate", "first-quality-rtp\x00track",
			SenderQualityDegraded, acceptedAtMs), nil)
		eq(t, lastResult.Accepted, true)
	}
	eq(t, lastResult.Committed, false)
	edge := edgeOf(t, routes, A)
	eq(t, edge.ParentPeerID, HOST)
	eq(t, edge.ConnectionID, "a_from_host")
	pending := must(t, routes.Snapshot().Operation)
	eq(t, pending.Cursor, 1)
	eq(t, pending.DeadlineAtMs, deadlineAtMs)
	if pending.Current != nil {
		t.Fatal("expected no live attempt")
	}

	secondParent := pending.Candidates[1].Tuple.ParentPeerID
	if secondParent == firstParent {
		t.Fatalf("second parent %q repeats the first", secondParent)
	}
	second := beginOperation(t, routes, BeginInput{NowMs: 108, ConnectionID: "second_quality_candidate", Reservation: direct()})
	eq(t, routes.ObserveSenderQualityEvidence(unknownSample(
		secondParent, A, second.Current.Revision, "second_quality_candidate", 109), nil).Accepted, true)
	eq(t, routes.CandidateReady(guardFor(A, second.Current.Revision, "second_quality_candidate"), 110, nil,
		CandidateProof{RelativeQualityApproved: true}).Committed, false)
	eq(t, routes.ObserveSenderQualityEvidence(senderSample(
		secondParent, A, second.Current.Revision, "second_quality_candidate", "second-quality-rtp\x00track",
		SenderQualityHealthy, 111), nil).Committed, true)
	edge = edgeOf(t, routes, A)
	eq(t, edge.ParentPeerID, secondParent)
	eq(t, edge.ConnectionID, "second_quality_candidate")
}

// TS 1768: preempts quality work for a Viewer without media
func TestPreemptsQualityWorkForViewerWithoutMedia(t *testing.T) {
	routes := newController(2, Options{QualityConvergenceEnabled: true})
	addViewer(routes, A, 2, nil)
	addViewer(routes, B, 2, nil)
	routes.hydrateEdge(A, peerEdge(HOST, "a_from_host"))
	routes.hydrateEdge(B, peerEdge(HOST, "b_from_host"))
	observeSenderState(routes, senderState{childPeerID: B, connectionID: "b_from_host", state: SenderQualityHealthy, acceptedAtMs: 100})
	observePersistentDegraded(t, routes, A, "a_from_host", 99)
	eq(t, must(t, routes.Reconcile(103).Operation).Reason, DemandQualityConvergence)
	addViewer(routes, C, 0, ms(104))
	join := must(t, routes.Reconcile(105).Operation)
	eq(t, join.ChildPeerID, C)
	eq(t, join.Reason, DemandJoin)
	commitCurrent(t, routes, 106, "c_join_connection")
	observeSenderState(routes, senderState{childPeerID: B, connectionID: "b_from_host", state: SenderQualityHealthy, acceptedAtMs: 107})
	observePersistentDegraded(t, routes, A, "a_from_host", 107)
	eq(t, must(t, routes.Reconcile(111).Operation).Reason, DemandQualityConvergence)
	edge := edgeOf(t, routes, A)
	eq(t, edge.ParentPeerID, HOST)
	eq(t, edge.ConnectionID, "a_from_host")
}

// TS 1806: keeps a quality operation reason immutable until availability preempts it
func TestKeepsQualityOperationReasonImmutableUntilAvailabilityPreempts(t *testing.T) {
	routes := newController(2, Options{QualityConvergenceEnabled: true})
	addViewer(routes, A, 2, nil)
	addViewer(routes, B, 2, nil)
	routes.hydrateEdge(A, peerEdge(HOST, "a_from_host"))
	routes.hydrateEdge(B, peerEdge(HOST, "b_from_host"))
	observeSenderState(routes, senderState{childPeerID: B, connectionID: "b_from_host", state: SenderQualityHealthy, acceptedAtMs: 99})
	observePersistentDegraded(t, routes, A, "a_from_host", 99)
	eq(t, must(t, routes.Reconcile(103).Operation).Reason, DemandQualityConvergence)

	eq(t, routes.InvalidateEdge(edgeGuard(A, "host_session", routes.Snapshot().Revision, "a_from_host"), ms(104)), true)
	eq(t, must(t, routes.Snapshot().Operation).Reason, DemandQualityConvergence)
	preempted := must(t, routes.Reconcile(105).Operation)
	eq(t, preempted.ChildPeerID, A)
	eq(t, preempted.Reason, DemandEdgeUnavailable)
}

// TS 1842: keeps a direct convergence reason immutable until availability preempts it
func TestKeepsDirectConvergenceReasonImmutableUntilAvailabilityPreempts(t *testing.T) {
	routes := newController(2, Options{SfuEnabled: true})
	addViewer(routes, B, 2, nil)
	routes.hydrateEdge(B, peerEdge(HOST, "b_from_host"))
	routes.hydrateHostPublication("publication", res("publication_resource"), "")
	addViewer(routes, A, 0, ms(0))
	acquisition := must(t, routes.Reconcile(0).Operation)
	beginCandidate(t, routes, BeginInput{NowMs: 1, ConnectionID: "a_head_start", Reservation: direct()})
	routes.OperationExpired(acquisition.WakeAtMs)
	sfu := beginOperation(t, routes, BeginInput{NowMs: acquisition.WakeAtMs + 1, ConnectionID: "a_sfu", Reservation: sfuReuse("a_subscription")})
	eq(t, routes.CandidateReady(guardFor(A, sfu.Current.Revision, "a_sfu"), acquisition.WakeAtMs+2, nil, CandidateProof{}).Committed, true)
	eq(t, must(t, routes.Reconcile(acquisition.WakeAtMs+3).Operation).Reason, DemandDirectConvergence)

	eq(t, routes.InvalidateEdge(edgeGuard(A, "", routes.Snapshot().Revision, "a_sfu"), ms(acquisition.WakeAtMs+4)), true)
	eq(t, must(t, routes.Snapshot().Operation).Reason, DemandDirectConvergence)
	preempted := must(t, routes.Reconcile(acquisition.WakeAtMs+5).Operation)
	eq(t, preempted.ChildPeerID, A)
	eq(t, preempted.Reason, DemandEdgeUnavailable)
}

// TS 1893: keeps a root convergence reason immutable until availability preempts it
func TestKeepsRootConvergenceReasonImmutableUntilAvailabilityPreempts(t *testing.T) {
	routes := newController(2, Options{QualityConvergenceEnabled: true})
	addViewer(routes, B, 2, nil)
	addViewer(routes, C, 0, nil)
	addViewer(routes, D, 0, nil)
	routes.hydrateEdge(B, peerEdge(HOST, "b_from_host"))
	routes.hydrateEdge(C, peerEdge(B, "c_from_b"))
	routes.hydrateEdge(D, peerEdge(B, "d_from_b"))
	addViewer(routes, A, 2, ms(10))
	routes.Reconcile(10)
	commitCurrent(t, routes, 11, "a_from_host")
	convergence := must(t, routes.Reconcile(13).Operation)
	eq(t, convergence.Reason, DemandRootConvergence)
	oldEdge := edgeOf(t, routes, convergence.ChildPeerID)
	eq(t, oldEdge.Kind, UpstreamPeer)

	eq(t, routes.InvalidateEdge(EdgeGuard{
		ChildPeerID:     convergence.ChildPeerID,
		ChildSessionID:  convergence.ChildSessionID,
		ParentSessionID: oldEdge.ParentSessionID,
		RouteRevision:   routes.Snapshot().Revision,
		ConnectionID:    oldEdge.ConnectionID,
	}, ms(14)), true)
	eq(t, must(t, routes.Snapshot().Operation).Reason, DemandRootConvergence)
	preempted := must(t, routes.Reconcile(15).Operation)
	eq(t, preempted.ChildPeerID, convergence.ChildPeerID)
	eq(t, preempted.Reason, DemandEdgeUnavailable)
}

// TS 1931: keeps a usable parent eligible before native state becomes clear
func TestKeepsUsableParentEligibleBeforeNativeStateBecomesClear(t *testing.T) {
	routes := newController(2, Options{QualityConvergenceEnabled: true})
	addViewer(routes, A, 2, nil)
	addViewer(routes, B, 2, nil)
	routes.hydrateEdge(A, peerEdge(HOST, "a_from_host"))
	routes.hydrateEdge(B, peerEdge(HOST, "b_from_host"))
	observePersistentDegraded(t, routes, A, "a_from_host", 99)
	operation := must(t, routes.Reconcile(103).Operation)
	eq(t, operation.ChildPeerID, A)
	eq(t, operation.Reason, DemandQualityConvergence)
	eqSlice(t, tuples(operation), []CandidateTuple{peerTuple(B), regenerateTuple(HOST)})
}

// TS 1957: waits for a fresh candidate sender after prior evidence expires
func TestWaitsForFreshCandidateSenderAfterPriorEvidenceExpires(t *testing.T) {
	routes := newController(2, Options{QualityConvergenceEnabled: true})
	addViewer(routes, A, 2, nil)
	addViewer(routes, B, 2, nil)
	routes.hydrateEdge(A, peerEdge(HOST, "a_from_host"))
	routes.hydrateEdge(B, peerEdge(HOST, "b_from_host"))
	observeCurrent := func(childPeerID, connectionID string, state SenderQualityState, acceptedAtMs int64) SenderQualityEvidenceResult {
		return routes.ObserveSenderQualityEvidence(senderSample(
			HOST, childPeerID, routes.Snapshot().Revision, connectionID, connectionID+"-rtp\x00track", state, acceptedAtMs), nil)
	}
	eq(t, observeCurrent(B, "b_from_host", SenderQualityHealthy, 100).Accepted, true)
	eq(t, observeCurrent(A, "a_from_host", SenderQualityHealthy, 99).Accepted, true)
	eq(t, observeCurrent(A, "a_from_host", SenderQualityDegraded, 100).Accepted, true)
	eq(t, observeCurrent(A, "a_from_host", SenderQualityDegraded, 101).Accepted, true)
	eq(t, observeCurrent(A, "a_from_host", SenderQualityDegraded, 102).Accepted, true)
	routes.Reconcile(103)
	begin := beginCandidate(t, routes, BeginInput{NowMs: 104, ConnectionID: "a_from_b_stale", Reservation: direct()})
	current := must(t, begin.Operation).Current
	eq(t, routes.CandidateTransportConnected(guardFor(A, current.Revision, "a_from_b_stale"), 105).Accepted, true)
	eq(t, routes.ObserveSenderQualityEvidence(senderSample(
		B, A, current.Revision, "a_from_b_stale", "a-stale-rtp\x00a-track", SenderQualityHealthy, 104), nil).Accepted, true)
	for _, acceptedAtMs := range []int64{5_101, 5_102, 5_103} {
		eq(t, observeCurrent(A, "a_from_host", SenderQualityDegraded, acceptedAtMs).Accepted, true)
	}
	eq(t, routes.CandidateReady(guardFor(A, current.Revision, "a_from_b_stale"), 5_104, nil,
		CandidateProof{RelativeQualityApproved: true}).Committed, false)
	eq(t, routes.ObserveSenderQualityEvidence(senderSample(
		B, A, current.Revision, "a_from_b_stale", "a-stale-rtp\x00a-track", SenderQualityHealthy, 5_105), nil).Committed, true)
	edge := edgeOf(t, routes, A)
	eq(t, edge.ParentPeerID, B)
	eq(t, edge.ConnectionID, "a_from_b_stale")
}

// TS 2063: keeps a usable candidate when its native source category expires
func TestKeepsUsableCandidateWhenNativeSourceCategoryExpires(t *testing.T) {
	routes := newController(2, Options{QualityConvergenceEnabled: true})
	addViewer(routes, A, 2, nil)
	addViewer(routes, B, 2, nil)
	routes.hydrateEdge(A, peerEdge(HOST, "a_from_host"))
	routes.hydrateEdge(B, peerEdge(HOST, "b_from_host"))
	observeSenderState(routes, senderState{childPeerID: B, connectionID: "b_from_host", state: SenderQualityHealthy, acceptedAtMs: 0})
	observePersistentDegraded(t, routes, A, "a_from_host", 0)
	eq(t, must(t, routes.Reconcile(4).Operation).Reason, DemandQualityConvergence)
	begin := beginCandidate(t, routes, BeginInput{NowMs: 5_001, ConnectionID: "expired_candidate", Reservation: direct()})
	eq(t, begin.Accepted, true)
	eq(t, must(t, begin.Operation).Current.ConnectionID, "expired_candidate")
}

// TS 2086: keeps bounded SFU after direct candidates when every Host root is degraded
func TestKeepsBoundedSfuAfterDirectCandidatesWhenEveryHostRootIsDegraded(t *testing.T) {
	routes := newController(2, Options{SfuEnabled: true, QualityConvergenceEnabled: true})
	addViewer(routes, A, 1, nil)
	addViewer(routes, B, 0, nil)
	routes.hydrateEdge(A, peerEdge(HOST, "a_from_host"))
	routes.hydrateEdge(B, peerEdge(HOST, "b_from_host"))
	observePersistentDegraded(t, routes, A, "a_from_host", 99)
	firstRegeneration := must(t, routes.Reconcile(103).Operation)
	eq(t, firstRegeneration.Candidates[0].Tuple, regenerateTuple(HOST))
	firstAttempt := beginOperation(t, routes, BeginInput{
		NowMs: 104, ConnectionID: "a_regeneration_failed", Reservation: directOverlap("a_regeneration_overlap"),
	})
	eq(t, routes.CandidateFailed(guardFor(A, firstAttempt.Current.Revision, "a_regeneration_failed"), 105).Accepted, true)
	eq(t, routes.SetEffectiveCapacity(B, sessionOf(B), 1, nil), true)
	observePersistentDegraded(t, routes, B, "b_from_host", 104)
	operation := must(t, routes.Reconcile(108).Operation)
	childPeerID := operation.ChildPeerID
	eq(t, childPeerID, A)
	eqSlice(t, tuples(operation), []CandidateTuple{peerTuple(B), sfuTuple(PublicationCreate)})
	directAttempt := beginOperation(t, routes, BeginInput{NowMs: 109, ConnectionID: "quality_peer_candidate", Reservation: direct()})
	failed := routes.CandidateFailed(guardFor(childPeerID, directAttempt.Current.Revision, "quality_peer_candidate"), 110)
	eq(t, failed.Accepted, true)
	eqSlice(t, failed.FailedPeerIDs, []string{})

	begin := beginCandidate(t, routes, BeginInput{
		NowMs:                   111,
		ConnectionID:            "quality_sfu_candidate",
		Reservation:             sfuCreateOverlap("sfu-edge", "sfu-publication", "host-overlap"),
		PublicationGeneration:   "publication_generation_12345678",
		PublicationConnectionID: "publication_connection_12345678",
		HostSessionID:           "host_session",
	})
	current := must(t, begin.Operation).Current
	guard := guardFor(childPeerID, current.Revision, "quality_sfu_candidate")
	ready := routes.CandidateReady(guard, 112, nil, CandidateProof{})
	eq(t, ready.Accepted, true)
	eq(t, ready.Committed, false)
	for _, acceptedAtMs := range []int64{113, 114} {
		observed := routes.ObserveSfuPublisherQualityEvidence(publisherSample(
			"publication_generation_12345678", current.Revision, SenderQualityHealthy, acceptedAtMs), nil)
		eq(t, observed.Accepted, true)
		eq(t, observed.Committed, false)
		ready = routes.CandidateReady(guard, acceptedAtMs, nil, CandidateProof{})
		eq(t, ready.Accepted, true)
		eq(t, ready.Committed, false)
	}
	eq(t, routes.ObserveSfuPublisherQualityEvidence(publisherSample(
		"publication_generation_12345678", current.Revision, SenderQualityHealthy, 115), nil).Committed, true)
	edge := edgeOf(t, routes, childPeerID)
	eq(t, edge.Kind, UpstreamSfu)
	eq(t, edge.ConnectionID, "quality_sfu_candidate")
}

// TS 2201: rejects an SFU quality candidate on degraded publisher evidence
func TestRejectsSfuQualityCandidateOnDegradedPublisherEvidence(t *testing.T) {
	routes := newController(2, Options{SfuEnabled: true, QualityConvergenceEnabled: true})
	addViewer(routes, A, 1, nil)
	addViewer(routes, B, 0, nil)
	routes.hydrateEdge(A, peerEdge(HOST, "a_from_host"))
	routes.hydrateEdge(B, peerEdge(HOST, "b_from_host"))
	observePersistentDegraded(t, routes, A, "a_from_host", 99)
	firstRegeneration := must(t, routes.Reconcile(103).Operation)
	eq(t, firstRegeneration.Candidates[0].Tuple, regenerateTuple(HOST))
	firstAttempt := beginOperation(t, routes, BeginInput{
		NowMs: 104, ConnectionID: "a_regeneration_failed", Reservation: directOverlap("a_regeneration_overlap"),
	})
	eq(t, routes.CandidateFailed(guardFor(A, firstAttempt.Current.Revision, "a_regeneration_failed"), 105).Accepted, true)
	eq(t, routes.SetEffectiveCapacity(B, sessionOf(B), 1, nil), true)
	observePersistentDegraded(t, routes, B, "b_from_host", 104)
	operation := must(t, routes.Reconcile(108).Operation)
	childPeerID := operation.ChildPeerID
	eq(t, childPeerID, A)
	peerAttempt := beginOperation(t, routes, BeginInput{NowMs: 109, ConnectionID: "quality_peer_candidate", Reservation: direct()})
	eq(t, routes.CandidateFailed(guardFor(childPeerID, peerAttempt.Current.Revision, "quality_peer_candidate"), 110).Accepted, true)
	sfuAttempt := beginOperation(t, routes, BeginInput{
		NowMs:                   111,
		ConnectionID:            "quality_sfu_degraded",
		Reservation:             sfuCreateOverlap("sfu-edge", "sfu-publication", "host-overlap"),
		PublicationGeneration:   "publication_generation_degraded",
		PublicationConnectionID: "publication_connection_degraded",
		HostSessionID:           "host_session",
	})
	current := sfuAttempt.Current
	ready := routes.CandidateReady(guardFor(childPeerID, current.Revision, current.ConnectionID), 112, nil, CandidateProof{})
	eq(t, ready.Accepted, true)
	eq(t, ready.Committed, false)
	degraded := routes.ObserveSfuPublisherQualityEvidence(publisherSample(
		"publication_generation_degraded", current.Revision, SenderQualityDegraded, 113), nil)
	eq(t, degraded.Accepted, true)
	eq(t, degraded.Committed, false)
	noOperation(t, routes.Reconcile(114).Operation)
	edge := edgeOf(t, routes, childPeerID)
	eq(t, edge.Kind, UpstreamPeer)
	eq(t, edge.ParentPeerID, HOST)
}

func TestAbandonsHostReliefWhenAnotherHostRootIsNoLongerDegraded(t *testing.T) {
	for _, state := range []SenderQualityState{SenderQualityHealthy, SenderQualityUnknown} {
		t.Run(string(state), func(t *testing.T) {
			routes := newController(2, Options{SfuEnabled: true, QualityConvergenceEnabled: true})
			addViewer(routes, A, 1, nil)
			addViewer(routes, B, 0, nil)
			routes.hydrateEdge(A, peerEdge(HOST, "a_from_host"))
			routes.hydrateEdge(B, peerEdge(HOST, "b_from_host"))
			observePersistentDegraded(t, routes, A, "a_from_host", 99)
			observePersistentDegraded(t, routes, B, "b_from_host", 99)
			routes.Reconcile(103)
			begin := beginCandidate(t, routes, BeginInput{
				NowMs:                   104,
				ConnectionID:            "a_from_sfu",
				Reservation:             sfuCreateOverlap("sfu-edge", "sfu-publication", "host-overlap"),
				PublicationGeneration:   "publication_generation_12345678",
				PublicationConnectionID: "publication_connection_12345678",
				HostSessionID:           "host_session",
			})
			current := must(t, begin.Operation).Current
			eq(t, observeSenderState(routes, senderState{
				childPeerID: B, connectionID: "b_from_host", state: state, acceptedAtMs: 105,
			}).Accepted, true)
			eq(t, routes.CandidateReady(guardFor(A, current.Revision, "a_from_sfu"), 106, nil, CandidateProof{}).Committed, false)
			noOperation(t, routes.Snapshot().Operation)
			edge := edgeOf(t, routes, A)
			eq(t, edge.Kind, UpstreamPeer)
			eq(t, edge.ParentPeerID, HOST)
			eq(t, edge.ConnectionID, "a_from_host")
		})
	}
}

// TS 2350: uses SFU reuse only for multi-edge Host relief with healthy ingress
func TestUsesSfuReuseOnlyForMultiEdgeHostReliefWithHealthyIngress(t *testing.T) {
	routes := newController(3, Options{SfuEnabled: true, QualityConvergenceEnabled: true})
	addViewer(routes, A, 0, nil)
	addViewer(routes, B, 0, nil)
	routes.hydrateEdge(A, peerEdge(HOST, "a_from_host"))
	routes.hydrateEdge(B, peerEdge(HOST, "b_from_host"))
	routes.hydrateHostPublication("publication_generation_12345678", res("publication_resource"), "")
	revision := routes.Snapshot().Revision
	observePersistentDegraded(t, routes, A, "a_from_host", 99)
	observePersistentDegraded(t, routes, B, "b_from_host", 99)
	noOperation(t, routes.Reconcile(103).Operation)
	observePersistentSfuHealthy(t, routes, "publication_generation_12345678", revision, 104)
	eq(t, must(t, routes.Reconcile(105).Operation).Candidates[0].Tuple, sfuTuple(PublicationReuse))
	begin := beginCandidate(t, routes, BeginInput{NowMs: 106, ConnectionID: "a_from_sfu_reuse", Reservation: sfuReuse("a_subscription")})
	current := must(t, begin.Operation).Current
	unknown := publisherSample("publication_generation_12345678", revision, SenderQualityUnknown, 107)
	unknown.SampleTimestampMs = nil
	eq(t, routes.ObserveSfuPublisherQualityEvidence(unknown, nil).Accepted, true)
	eq(t, routes.CandidateReady(guardFor(A, current.Revision, "a_from_sfu_reuse"), 108, nil, CandidateProof{}).Committed, false)
	for _, acceptedAtMs := range []int64{2_100, 4_100, 6_100} {
		observeSenderState(routes, senderState{childPeerID: A, connectionID: "a_from_host", state: SenderQualityDegraded, acceptedAtMs: acceptedAtMs})
		observeSenderState(routes, senderState{childPeerID: B, connectionID: "b_from_host", state: SenderQualityDegraded, acceptedAtMs: acceptedAtMs})
		settled := routes.ObserveSfuPublisherQualityEvidence(publisherSample(
			"publication_generation_12345678", revision, SenderQualityHealthy, acceptedAtMs), nil)
		eq(t, settled.Committed, acceptedAtMs == 6_100)
	}
	edge := edgeOf(t, routes, A)
	eq(t, edge.Kind, UpstreamSfu)
	eq(t, edge.ConnectionID, "a_from_sfu_reuse")
}

// TS 2435: accepts an SFU-fed Peer parent from decoded progress without freeze stats
func TestAcceptsSfuFedPeerParentFromDecodedProgressWithoutFreezeStats(t *testing.T) {
	routes := newController(2, Options{SfuEnabled: true, QualityConvergenceEnabled: true})
	addViewer(routes, A, 1, nil)
	addViewer(routes, B, 2, nil)
	routes.hydrateEdge(A, peerEdge(HOST, "a_from_host"))
	routes.hydrateHostPublication("publication_generation_12345678", res("publication_resource"), "")
	routes.hydrateEdge(B, sfuEdge("publication_generation_12345678", "b_from_sfu", "b_subscription"))
	// Isolate quality convergence: this established SFU relay has already tried
	// its own Peer opportunities, while remaining eligible to supply A.
	for _, plan := range routes.buildCandidates(B, false) {
		if plan.Tuple.Kind == UpstreamPeer {
			routes.consumeCandidateOpportunity(B, plan)
		}
	}

	revision := routes.Snapshot().Revision
	observePersistentSfuHealthy(t, routes, "publication_generation_12345678", revision, 100)
	metrics := qualityMetrics()
	metrics.FreezeCountDelta = nil
	metrics.FreezeDurationMsDelta = nil
	metrics.PauseCountDelta = nil
	metrics.PauseDurationMsDelta = nil
	eq(t, routes.ObserveQualityEvidence(qualityWindow(B, revision, "b_from_sfu", sfuUpstream(), 1, 100, metrics)), QualityEvidenceAccepted)
	observePersistentDegraded(t, routes, A, "a_from_host", 99)
	eq(t, must(t, routes.Reconcile(103).Operation).Candidates[0].Tuple, peerTuple(B))
}

// TS 2489: clears quality shadow for a relay subtree when its source changes
func TestClearsQualityShadowForRelaySubtreeWhenSourceChanges(t *testing.T) {
	routes := newController(2, Options{})
	addViewer(routes, A, 2, nil)
	addViewer(routes, B, 2, nil)
	addViewer(routes, C, 0, nil)
	routes.hydrateEdge(A, peerEdge(HOST, "a_from_host"))
	routes.hydrateEdge(B, peerEdge(A, "b_from_a"))
	routes.hydrateEdge(C, peerEdge(B, "c_from_b"))
	revision := routes.Snapshot().Revision

	relays := [][3]string{{B, A, "b_from_a"}, {C, B, "c_from_b"}}
	for _, relay := range relays {
		eq(t, routes.ObserveQualityEvidence(qualityWindow(
			relay[0], revision, relay[2], peerUpstream(relay[1]), 1, 1_000, qualityMetrics())), QualityEvidenceObserved)
	}
	withQuality := func(nowMs int64) int {
		count := 0
		for _, child := range routes.RouteDiagnosticSnapshot(nowMs).Children {
			if child.Quality != nil {
				count++
			}
		}
		return count
	}
	eq(t, withQuality(1_001), 2)

	eq(t, routes.AdoptDirectConnection(AdoptDirectConnectionInput{
		EdgeGuard:       edgeGuard(A, "host_session", revision, "a_from_host"),
		NewConnectionID: "a_from_host_recovered",
	}, 1_002).Accepted, true)
	eq(t, withQuality(1_002), 0)

	for _, step := range []struct {
		at       int64
		expected RouteQualityEvidenceResult
	}{{1_100, QualityEvidenceAccepted}, {3_100, QualityEvidenceObserved}} {
		for _, relay := range relays {
			eq(t, routes.ObserveQualityEvidence(qualityWindow(
				relay[0], revision, relay[2], peerUpstream(relay[1]), 1, step.at, qualityMetrics())), step.expected)
		}
	}
	eq(t, withQuality(3_101), 2)
}

func TestActiveRebuildRetiresBootstrapReservationWithoutLosingWaitingDemand(t *testing.T) {
	routes := newController(2, Options{SfuEnabled: true})
	for _, child := range []string{B, C} {
		addViewer(routes, child, 0, nil)
		routes.hydrateEdge(child, peerEdge(HOST, child+"_from_host"))
	}
	addViewer(routes, A, 0, ms(0))
	bootstrap := must(t, routes.Reconcile(0).Operation)
	eq(t, bootstrap.Reason, DemandSfuBootstrap)
	retained := edgeOf(t, routes, bootstrap.ChildPeerID)
	attempt := beginOperation(t, routes, BeginInput{
		NowMs: 1, ConnectionID: "carrier_sfu", PublicationGeneration: "publication",
		PublicationConnectionID: "publication_connection",
		Reservation:             sfuCreateOverlap("subscription", "publication", "overlap"),
	})
	replaced := routes.AdoptDirectConnection(AdoptDirectConnectionInput{
		EdgeGuard:       edgeGuard(bootstrap.ChildPeerID, "host_session", routes.Revision(), retained.ConnectionID),
		NewConnectionID: "recovered_connection",
	}, 2)
	eq(t, replaced.Accepted, true)
	eqLabels(t, replaced.Released, "subscription", "publication", "overlap")
	noOperation(t, routes.Snapshot().Operation)
	eq(t, edgeOf(t, routes, bootstrap.ChildPeerID).ConnectionID, "recovered_connection")
	eq(t, routes.CandidateReady(guardFor(bootstrap.ChildPeerID, attempt.Current.Revision, "carrier_sfu"), 3, nil, CandidateProof{}).Accepted, false)
	next := must(t, routes.Reconcile(4).Operation)
	eq(t, next.Reason, DemandSfuBootstrap)
	eq(t, next.DemandPeerID, A)
}

// TS 2569: retains one latest timing sample for a 20-Viewer burst
func TestRetainsOneLatestTimingSampleForTwentyViewerBurst(t *testing.T) {
	routes := newController(2, Options{})
	viewerPeerIDs := make([]string, 20)
	for index := range viewerPeerIDs {
		viewerPeerIDs[index] = fmt.Sprintf("burst_%02d_12345678", index)
	}
	for _, peerID := range viewerPeerIDs {
		addViewer(routes, peerID, 2, ms(0))
	}

	for index, peerID := range viewerPeerIDs {
		operationStartedAtMs := int64(index+1) * 10
		eq(t, must(t, routes.Reconcile(operationStartedAtMs).Operation).ChildPeerID, peerID)
		commitCurrent(t, routes, operationStartedAtMs+1, peerID+"_connection")
	}

	snapshot := routes.RouteDiagnosticSnapshot(250)
	eq(t, len(snapshot.Children), 20)
	for index, child := range snapshot.Children {
		eqDeep(t, child.QueueWaitMs, optInt(int64(index+1)*10))
		eq(t, child.FinalRoute, string(FinalRouteDirect))
	}
}

// TS 2598: projects latest route timing through snapshot-local ordinals
func TestProjectsLatestRouteTimingThroughSnapshotLocalOrdinals(t *testing.T) {
	routes := newController(2, Options{})
	addViewer(routes, A, 1, ms(100))

	eqDeep(t, routes.RouteDiagnosticSnapshot(150), protocol.RouteDiagnosticSnapshot{
		Children: []protocol.RouteDiagnosticChild{{
			Ordinal:             1,
			Parent:              protocol.RouteDiagnosticParent{Kind: "none"},
			EffectiveCapacity:   1,
			ChildCount:          0,
			DemandAgeMs:         optInt(50),
			QueueWaitMs:         nil,
			CandidateStartMs:    nil,
			FirstDecodedFrameMs: nil,
			FinalMs:             nil,
			FinalRoute:          "waiting",
			RejectionBucket:     "none",
			Quality:             nil,
		}},
		Operation: nil,
	})

	operation := must(t, routes.Reconcile(160).Operation)
	eqDeep(t, routes.RouteDiagnosticSnapshot(165).Operation, &protocol.RouteDiagnosticOperation{
		ChildOrdinal:   1,
		Reason:         "join",
		Stage:          "admission",
		Cursor:         0,
		CandidateCount: protocol.Int(len(operation.Candidates)),
	})
	prepared := beginOperation(t, routes, BeginInput{NowMs: 170, ConnectionID: "a_connection", Reservation: direct()})
	pending := routes.RouteDiagnosticSnapshot(180)
	eq(t, len(pending.Children), 1)
	eqDeep(t, pending.Children[0].QueueWaitMs, optInt(60))
	eqDeep(t, pending.Children[0].CandidateStartMs, optInt(70))
	eqDeep(t, pending.Children[0].FirstDecodedFrameMs, (*protocol.Int)(nil))
	eqDeep(t, pending.Children[0].FinalMs, (*protocol.Int)(nil))
	if pending.Operation == nil {
		t.Fatal("expected a diagnostic operation")
	}
	eq(t, pending.Operation.ChildOrdinal, 1)
	eq(t, pending.Operation.Stage, "first-frame")
	eq(t, routes.CandidateReady(guardFor(A, prepared.Current.Revision, "a_connection"), 230, nil, CandidateProof{}).Accepted, true)
	settled := routes.RouteDiagnosticSnapshot(240)
	eq(t, len(settled.Children), 1)
	eq(t, settled.Children[0].Parent, protocol.RouteDiagnosticParent{Kind: "host"})
	eqDeep(t, settled.Children[0].QueueWaitMs, optInt(60))
	eqDeep(t, settled.Children[0].CandidateStartMs, optInt(70))
	eqDeep(t, settled.Children[0].FirstDecodedFrameMs, optInt(130))
	eqDeep(t, settled.Children[0].FinalMs, optInt(130))
	eq(t, settled.Children[0].FinalRoute, "direct")
	eq(t, settled.Children[0].RejectionBucket, "none")
	if settled.Operation != nil {
		t.Fatal("expected no diagnostic operation")
	}
	serialized, err := json.Marshal(settled)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(serialized), A) {
		t.Fatalf("diagnostic snapshot leaks the peer ID: %s", serialized)
	}
	if strings.Contains(string(serialized), "a_connection") {
		t.Fatalf("diagnostic snapshot leaks the connection ID: %s", serialized)
	}

	eq(t, routes.InvalidateEdge(edgeGuard(A, "host_session", routes.Snapshot().Revision, "a_connection"), ms(300)), true)
	waiting := routes.RouteDiagnosticSnapshot(320).Children[0]
	eqDeep(t, waiting.DemandAgeMs, optInt(20))
	eqDeep(t, waiting.QueueWaitMs, (*protocol.Int)(nil))
	eqDeep(t, waiting.CandidateStartMs, (*protocol.Int)(nil))
	eqDeep(t, waiting.FirstDecodedFrameMs, (*protocol.Int)(nil))
	eqDeep(t, waiting.FinalMs, (*protocol.Int)(nil))
	eq(t, waiting.FinalRoute, "waiting")
	eq(t, waiting.RejectionBucket, "none")

	eq(t, routes.ConfirmDeparture(A, ms(330)), true)
	departed := routes.RouteDiagnosticSnapshot(330)
	eq(t, len(departed.Children), 0)
	if departed.Operation != nil {
		t.Fatal("expected no diagnostic operation")
	}
}

// TS 2704: records a bounded candidate failure without retaining route identity
func TestRecordsBoundedCandidateFailureWithoutRetainingRouteIdentity(t *testing.T) {
	routes := newController(1, Options{})
	addViewer(routes, A, 0, ms(0))
	routes.Reconcile(10)
	prepared := beginOperation(t, routes, BeginInput{NowMs: 20, ConnectionID: "failed_candidate", Reservation: direct()})
	failed := routes.CandidateFailed(guardFor(A, prepared.Current.Revision, "failed_candidate"), 30)
	eq(t, failed.Accepted, true)
	eqSlice(t, failed.FailedPeerIDs, []string{A})
	child := routes.RouteDiagnosticSnapshot(30).Children[0]
	eqDeep(t, child.FinalMs, optInt(30))
	eq(t, child.FinalRoute, "failed")
	eq(t, child.RejectionBucket, "candidate-failed")

	routes.Dispose()
	disposed := routes.RouteDiagnosticSnapshot(40)
	eq(t, len(disposed.Children), 0)
	if disposed.Operation != nil {
		t.Fatal("expected no diagnostic operation after dispose")
	}
}

// TS 2737: reports a current child that has no usable candidate
func TestReportsCurrentChildThatHasNoUsableCandidate(t *testing.T) {
	routes := newController(1, Options{})
	addViewer(routes, A, 0, nil)
	routes.hydrateEdge(A, peerEdge(HOST, "a_connection"))
	addViewer(routes, B, 0, ms(0))

	result := routes.Reconcile(10)
	noOperation(t, result.Operation)
	eqSlice(t, result.FailedPeerIDs, []string{B})
	child := routes.RouteDiagnosticSnapshot(10).Children[1]
	eqDeep(t, child.FinalMs, optInt(10))
	eq(t, child.FinalRoute, "failed")
	eq(t, child.RejectionBucket, "candidate-failed")
}

// TS 2753: records SFU admission waiting without advancing the route cursor
func TestRecordsSfuAdmissionWaitingWithoutAdvancingRouteCursor(t *testing.T) {
	routes := newController(1, Options{SfuEnabled: true})
	addViewer(routes, A, 0, ms(0))
	directOp := must(t, routes.Reconcile(10).Operation)
	eqSlice(t, tupleKinds(directOp), []UpstreamKind{UpstreamPeer, UpstreamSfu})
	eq(t, routes.SkipCurrentCandidate(cursorGuard(directOp), 20, RejectionCandidateFailed).Accepted, true)
	sfu := must(t, routes.Snapshot().Operation)
	eq(t, routes.NoteCurrentCandidateRejection(cursorGuard(sfu), RejectionSfuAdmission), true)
	snapshot := routes.RouteDiagnosticSnapshot(30)
	eq(t, len(snapshot.Children), 1)
	eq(t, snapshot.Children[0].FinalRoute, "waiting")
	eq(t, snapshot.Children[0].RejectionBucket, "sfu-admission")
	if snapshot.Operation == nil {
		t.Fatal("expected a diagnostic operation")
	}
	eq(t, *snapshot.Operation, protocol.RouteDiagnosticOperation{
		ChildOrdinal: 1, Reason: "join", Stage: "admission", Cursor: 1, CandidateCount: 2,
	})
}

// TS 2791: distinguishes first-frame timeout from the total operation deadline
func TestDistinguishesFirstFrameTimeoutFromTotalOperationDeadline(t *testing.T) {
	routes := newController(1, Options{SfuEnabled: true})
	addViewer(routes, A, 0, ms(0))
	directOp := must(t, routes.Reconcile(10).Operation)
	beginCandidate(t, routes, BeginInput{NowMs: 20, ConnectionID: "silent_direct", Reservation: direct()})

	eq(t, routes.OperationExpired(directOp.WakeAtMs).Accepted, true)
	snapshot := routes.RouteDiagnosticSnapshot(directOp.WakeAtMs)
	eq(t, len(snapshot.Children), 1)
	eqDeep(t, snapshot.Children[0].CandidateStartMs, (*protocol.Int)(nil))
	eqDeep(t, snapshot.Children[0].FinalMs, (*protocol.Int)(nil))
	eq(t, snapshot.Children[0].FinalRoute, "waiting")
	eq(t, snapshot.Children[0].RejectionBucket, "first-frame-timeout")
	if snapshot.Operation == nil {
		t.Fatal("expected a diagnostic operation")
	}
	eq(t, snapshot.Operation.Cursor, 1)
	eq(t, snapshot.Operation.Stage, "admission")

	deadline := must(t, routes.Snapshot().Operation).DeadlineAtMs
	expired := routes.OperationExpired(deadline)
	eq(t, expired.Accepted, true)
	eqSlice(t, expired.FailedPeerIDs, []string{A})
	child := routes.RouteDiagnosticSnapshot(deadline).Children[0]
	eqDeep(t, child.FinalMs, optInt(deadline))
	eq(t, child.FinalRoute, "failed")
	eq(t, child.RejectionBucket, "operation-deadline")
}

// TS 2828: admits 20 Viewers through one bounded event-driven graph at C=%i
func TestAdmitsTwentyViewersThroughOneBoundedGraph(t *testing.T) {
	for _, capacity := range []int{1, 2, 3} {
		t.Run(fmt.Sprintf("C=%d", capacity), func(t *testing.T) {
			routes := newController(capacity, Options{})
			viewerPeerIDs := make([]string, 20)
			for index := range viewerPeerIDs {
				viewerPeerIDs[index] = fmt.Sprintf("viewer_%02d_12345678", index)
			}
			for index, peerID := range viewerPeerIDs {
				addViewer(routes, peerID, capacity, nil)
				operation := must(t, routes.Reconcile(int64(index*2)).Operation)
				eq(t, operation.ChildPeerID, peerID)
				commitCurrent(t, routes, int64(index*2+1), peerID+"_connection")
			}
			snapshot := routes.Snapshot()
			eq(t, snapshot.UpstreamByViewer.Len(), 20)
			for _, parentPeerID := range append([]string{HOST}, viewerPeerIDs...) {
				childCount := 0
				for _, edge := range snapshot.UpstreamByViewer.Values() {
					if edge.Kind == UpstreamPeer && edge.PhysicalActive && edge.ParentPeerID == parentPeerID {
						childCount++
					}
				}
				if childCount > capacity {
					t.Fatalf("parent %q has %d children, capacity %d", parentPeerID, childCount, capacity)
				}
			}
		})
	}
}

// TS 2856: admits waiting Viewers through existing SFU before direct convergence
func TestAdmitsWaitingViewersThroughExistingSfuBeforeDirectConvergence(t *testing.T) {
	routes := newController(2, Options{SfuEnabled: true})
	addViewer(routes, B, 2, nil)
	routes.hydrateHostPublication("publication_generation", res("publication_resource"), "")
	routes.hydrateEdge(B, sfuEdge("publication_generation", "b_sfu", "b_subscription"))
	addViewer(routes, C, 0, nil)
	routes.hydrateEdge(C, peerEdge(HOST, "c_from_host"))
	waiting := make([]string, 18)
	for index := range waiting {
		waiting[index] = fmt.Sprintf("silent_%02d_12345678", index)
	}
	for _, peerID := range waiting {
		addViewer(routes, peerID, 0, nil)
	}

	nowMs := int64(0)
	for index, peerID := range waiting {
		directOperation := must(t, routes.Reconcile(nowMs).Operation)
		eq(t, directOperation.ChildPeerID, peerID)
		eq(t, directOperation.Candidates[0].Tuple.Kind, UpstreamPeer)
		beginCandidate(t, routes, BeginInput{NowMs: nowMs + 1, ConnectionID: peerID + "_direct", Reservation: direct()})
		routes.OperationExpired(directOperation.WakeAtMs)
		sfuOperation := must(t, routes.Snapshot().Operation)
		eq(t, sfuOperation.Candidates[sfuOperation.Cursor].Tuple, sfuTuple(PublicationReuse))
		prepared := beginOperation(t, routes, BeginInput{
			NowMs: directOperation.WakeAtMs + 1, ConnectionID: peerID + "_sfu", Reservation: sfuReuse(peerID + "_subscription"),
		})
		eq(t, routes.CandidateReady(guardFor(peerID, prepared.Current.Revision, peerID+"_sfu"),
			directOperation.WakeAtMs+2, nil, CandidateProof{}).Accepted, true)
		nowMs = directOperation.WakeAtMs + 3

		bEdge := edgeOf(t, routes, B)
		eq(t, bEdge.Kind, UpstreamSfu)
		eq(t, bEdge.ConnectionID, "b_sfu")
		cEdge := edgeOf(t, routes, C)
		eq(t, cEdge.Kind, UpstreamPeer)
		eq(t, cEdge.ParentPeerID, HOST)
		eq(t, cEdge.ConnectionID, "c_from_host")
		admitted := edgeOf(t, routes, peerID)
		eq(t, admitted.Kind, UpstreamSfu)
		eq(t, admitted.Usable, true)
		eq(t, routes.Snapshot().UpstreamByViewer.Len(), index+3)
	}

	eq(t, routes.Snapshot().UpstreamByViewer.Len(), 20)
	publication := routes.Snapshot().HostPublication
	if publication == nil {
		t.Fatal("expected a host publication")
	}
	eq(t, publication.Generation, "publication_generation")
	eq(t, publication.Usable, true)
	eq(t, must(t, routes.Reconcile(nowMs).Operation).Reason, DemandDirectConvergence)
}

// TS 2943: builds a deterministic acyclic route without a depth cap at C=%i
func TestBuildsDeterministicAcyclicRouteWithoutDepthCap(t *testing.T) {
	for _, capacity := range []int{1, 2, 3} {
		t.Run(fmt.Sprintf("C=%d", capacity), func(t *testing.T) {
			routes := newController(capacity, Options{})
			for _, peerID := range []string{A, B, C, D} {
				addViewer(routes, peerID, capacity, nil)
				result := routes.Reconcile(0)
				eq(t, must(t, result.Operation).ChildPeerID, peerID)
				commitCurrent(t, routes, 1, peerID+"_connection")
			}

			snapshot := routes.Snapshot()
			eq(t, snapshot.UpstreamByViewer.Len(), 4)
			for childPeerID, edge := range snapshot.UpstreamByViewer.All() {
				eq(t, edge.Kind, UpstreamPeer)
				if edge.ParentPeerID == childPeerID {
					t.Fatalf("%q is its own parent", childPeerID)
				}
			}
			if capacity == 1 {
				// Pins the stablePairRank/depth ordering: at C=1 D hangs below C.
				dEdge := edgeOf(t, routes, D)
				eq(t, dEdge.Kind, UpstreamPeer)
				eq(t, dEdge.ParentPeerID, C)
			}
		})
	}
}

// TS 2969: keeps the old edge until exact candidate first-frame ready
func TestKeepsOldEdgeUntilExactCandidateFirstFrameReady(t *testing.T) {
	routes := newController(2, Options{})
	addViewer(routes, A, 2, nil)
	addViewer(routes, B, 2, nil)
	routes.Reconcile(0)
	commitCurrent(t, routes, 1, "old_connection")
	routes.Reconcile(2)
	commitCurrent(t, routes, 3, "b_connection")
	revision := routes.Snapshot().Revision
	eq(t, routes.InvalidateEdge(edgeGuard(A, "host_session", revision, "old_connection"), nil), true)

	routes.Reconcile(100)
	prepared := beginOperation(t, routes, BeginInput{NowMs: 101, ConnectionID: "new_connection", Reservation: direct()})
	eq(t, edgeOf(t, routes, A).ConnectionID, "old_connection")
	eq(t, routes.CandidateReady(guardFor(A, prepared.Current.Revision-1, "new_connection"), 102, nil, CandidateProof{}).Accepted, false)
	eq(t, routes.CandidateReady(guardFor(A, prepared.Current.Revision, "new_connection"), 102, nil, CandidateProof{}).Accepted, true)
	edge := edgeOf(t, routes, A)
	eq(t, edge.ConnectionID, "new_connection")
	eq(t, edge.ParentPeerID, B)
	eq(t, edge.Usable, true)
}

// TS 3020: invalidates one exact active Peer edge from its parent idempotently
func TestInvalidatesOneExactActivePeerEdgeFromParentIdempotently(t *testing.T) {
	routes := newController(2, Options{})
	addViewer(routes, A, 0, nil)
	addViewer(routes, B, 1, nil)
	routes.hydrateEdge(A, peerEdge(HOST, "a_from_host"))
	routes.hydrateEdge(B, peerEdge(HOST, "b_from_host"))
	report := ParentEdgeGuard{
		ParentPeerID:    HOST,
		ParentSessionID: "host_session",
		RouteRevision:   routes.Snapshot().Revision,
		ConnectionID:    "a_from_host",
	}

	eq(t, routes.InvalidateDirectEdgeFromParent(report, ms(10)), true)
	afterFirst := routes.Snapshot()
	aEdge, _ := afterFirst.UpstreamByViewer.Get(A)
	eq(t, aEdge.Usable, false)
	eq(t, aEdge.ConnectionID, "a_from_host")
	bEdge, _ := afterFirst.UpstreamByViewer.Get(B)
	eq(t, bEdge.Usable, true)
	eq(t, bEdge.ConnectionID, "b_from_host")
	eq(t, routes.InvalidateDirectEdgeFromParent(report, ms(11)), true)
	eq(t, routes.Snapshot().FactVersion, afterFirst.FactVersion)
	unknown := report
	unknown.ConnectionID = "unknown_connection"
	eq(t, routes.InvalidateDirectEdgeFromParent(unknown, nil), false)
	operation := must(t, routes.Reconcile(12).Operation)
	eq(t, operation.ChildPeerID, A)
	eq(t, operation.Reason, DemandEdgeUnavailable)
	eqSlice(t, tuples(operation), []CandidateTuple{peerTuple(B)})
}

// TS 3062: advances one candidate cursor without resetting the operation deadline
func TestAdvancesOneCandidateCursorWithoutResettingOperationDeadline(t *testing.T) {
	routes := newController(2, Options{SfuEnabled: true})
	addViewer(routes, A, 2, nil)
	operation := must(t, routes.Reconcile(1_000).Operation)
	deadline := operation.DeadlineAtMs
	first := beginOperation(t, routes, BeginInput{NowMs: 1_001, ConnectionID: "candidate_1", Reservation: direct()})
	failed := routes.CandidateFailed(guardFor(A, first.Current.Revision, "candidate_1"), 1_001)
	eq(t, failed.Accepted, true)
	if failed.ActiveRevision <= first.Current.Revision {
		t.Fatalf("activeRevision %d did not advance past %d", failed.ActiveRevision, first.Current.Revision)
	}
	eqSlice(t, failed.FailedPeerIDs, []string{})
	eqLabels(t, failed.Released)
	pending := must(t, routes.Snapshot().Operation)
	eq(t, pending.Cursor, 1)
	eq(t, pending.DeadlineAtMs, deadline)

	second := beginOperation(t, routes, BeginInput{
		NowMs:                   1_002,
		ConnectionID:            "candidate_2",
		PublicationGeneration:   "publication_2",
		PublicationConnectionID: "publication_connection_2",
		Reservation:             sfuCreate("candidate_2_edge", "candidate_2_publication"),
	})
	lateReady := routes.CandidateReady(guardFor(A, second.Current.Revision, "candidate_2"), deadline, nil, CandidateProof{})
	eq(t, lateReady.Accepted, false)
	eqSlice(t, lateReady.FailedPeerIDs, []string{A})
	eqLabels(t, lateReady.Released, "candidate_2_edge", "candidate_2_publication")
	noOperation(t, routes.Snapshot().Operation)
	eq(t, routes.CandidateReady(guardFor(A, second.Current.Revision, "candidate_2"), deadline+1, nil, CandidateProof{}).Accepted, false)
	noOperation(t, routes.Reconcile(deadline+1).Operation)
	routes.TouchExternalFacts()
	eq(t, must(t, routes.Reconcile(deadline+2).Operation).ChildPeerID, A)
}

// TS 3123: reserves one derived deadline stage for direct and SFU
func TestReservesOneDerivedDeadlineStageForDirectAndSfu(t *testing.T) {
	routes := newController(2, Options{SfuEnabled: true})
	addViewer(routes, B, 2, nil)
	routes.hydrateEdge(B, peerEdge(HOST, "b_from_host"))
	addViewer(routes, A, 0, nil)

	operation := must(t, routes.Reconcile(0).Operation)
	eq(t, operation.DeadlineAtMs, 10_000)
	eq(t, operation.WakeAtMs, 5_000)
	for _, want := range []CandidateTuple{peerTuple(B), sfuTuple(PublicationCreate)} {
		if !slices.Contains(tuples(operation), want) {
			t.Fatalf("candidates %+v do not contain %+v", tuples(operation), want)
		}
	}

	beginCandidate(t, routes, BeginInput{NowMs: 1, ConnectionID: "silent_direct", Reservation: direct()})
	directExpired := routes.OperationExpired(operation.WakeAtMs)
	eq(t, directExpired.Accepted, true)
	eqSlice(t, directExpired.FailedPeerIDs, []string{})
	pending := must(t, routes.Snapshot().Operation)
	eq(t, pending.DeadlineAtMs, 10_000)
	eq(t, pending.WakeAtMs, 10_000)
	if pending.Current != nil {
		t.Fatal("expected no live attempt")
	}
	eq(t, pending.Candidates[pending.Cursor].Tuple.Kind, UpstreamSfu)

	prepared := beginOperation(t, routes, BeginInput{
		NowMs:                   7_000,
		ConnectionID:            "sfu_subscription",
		PublicationGeneration:   "publication_generation",
		PublicationConnectionID: "publication_connection",
		Reservation:             sfuCreate("sfu_edge", "sfu_publication"),
	})
	eq(t, routes.CandidateReady(guardFor(A, prepared.Current.Revision, "sfu_subscription"), 9_000, nil, CandidateProof{}).Accepted, true)
	edge := edgeOf(t, routes, A)
	eq(t, edge.Kind, UpstreamSfu)
	eq(t, edge.Usable, true)
}

// TS 3186: uses the same direct head-start after an early hard failure
func TestUsesSameDirectHeadStartAfterEarlyHardFailure(t *testing.T) {
	routes := newController(2, Options{SfuEnabled: true})
	addViewer(routes, D, 0, nil)
	routes.hydrateEdge(D, peerEdge(HOST, "host_full"))
	routes.hydrateHostPublication("publication_1", res("publication_resource"), "")
	for _, peerID := range []string{B, C} {
		addViewer(routes, peerID, 1, nil)
		routes.hydrateEdge(peerID, sfuEdge("publication_1", peerID+"_sfu", peerID+"_subscription"))
	}
	addViewer(routes, A, 0, nil)

	operation := must(t, routes.Reconcile(0).Operation)
	eqSlice(t, tupleKinds(operation), []UpstreamKind{UpstreamPeer, UpstreamSfu, UpstreamPeer})
	first := beginOperation(t, routes, BeginInput{NowMs: 1, ConnectionID: "first_direct", Reservation: direct()})
	eq(t, routes.CandidateFailed(guardFor(A, first.Current.Revision, "first_direct"), 2).Accepted, true)
	pending := must(t, routes.Snapshot().Operation)
	eq(t, pending.Cursor, 1)
	eq(t, pending.WakeAtMs, operation.WakeAtMs)
	eq(t, pending.Candidates[1].Tuple.Kind, UpstreamPeer)
}

// TS 3231: keeps a transport-connected direct candidate until the total deadline
func TestKeepsTransportConnectedDirectCandidateUntilTotalDeadline(t *testing.T) {
	routes := newController(2, Options{SfuEnabled: true})
	addViewer(routes, D, 0, nil)
	routes.hydrateEdge(D, peerEdge(HOST, "host_full"))
	routes.hydrateHostPublication("publication", res("publication_resource"), "")
	addViewer(routes, B, 1, nil)
	routes.hydrateEdge(B, sfuEdge("publication", "b_sfu", "b_subscription"))
	addViewer(routes, A, 0, nil)

	operation := must(t, routes.Reconcile(0).Operation)
	directOp := beginOperation(t, routes, BeginInput{NowMs: 1, ConnectionID: "a_direct", Reservation: direct()})
	eq(t, routes.CandidateTransportConnected(guardFor(A, directOp.Current.Revision, "a_direct"), 1_000).Accepted, true)
	eq(t, routes.CandidateTransportConnected(guardFor(A, directOp.Current.Revision, "a_direct"), 1_001).Accepted, true)
	eq(t, routes.CandidateTransportConnected(guardFor(A, directOp.Current.Revision, "stale_direct"), 1_002).Accepted, false)
	eq(t, routes.Snapshot().Revision, directOp.Current.Revision-1)
	eq(t, must(t, routes.Snapshot().Operation).WakeAtMs, operation.DeadlineAtMs)
	eq(t, routes.OperationExpired(operation.WakeAtMs).Accepted, false)
	eq(t, must(t, routes.Snapshot().Operation).Current.ConnectionID, "a_direct")
	eq(t, routes.CandidateReady(guardFor(A, directOp.Current.Revision, "a_direct"), operation.WakeAtMs+1, nil, CandidateProof{}).Accepted, true)
	edge := edgeOf(t, routes, A)
	eq(t, edge.Kind, UpstreamPeer)
	eq(t, edge.ConnectionID, "a_direct")
}

// TS 3288: keeps SFU active while converging through an SFU-fed parent
func TestKeepsSfuActiveWhileConvergingThroughSfuFedParent(t *testing.T) {
	routes := newController(2, Options{SfuEnabled: true})
	addViewer(routes, B, 2, nil)
	routes.hydrateHostPublication("publication_generation", res("publication_resource"), "")
	routes.hydrateEdge(B, sfuEdge("publication_generation", "b_sfu", "b_subscription"))
	addViewer(routes, C, 0, nil)
	routes.hydrateEdge(C, peerEdge(HOST, "c_from_host"))
	addViewer(routes, A, 0, nil)

	acquisition := must(t, routes.Reconcile(0).Operation)
	eq(t, acquisition.Candidates[0].Tuple, peerTuple(B))
	beginCandidate(t, routes, BeginInput{NowMs: 1, ConnectionID: "a_direct_head_start", Reservation: direct()})
	routes.OperationExpired(acquisition.WakeAtMs)
	prepared := beginOperation(t, routes, BeginInput{
		NowMs: acquisition.WakeAtMs + 1, ConnectionID: "a_sfu_reuse", Reservation: sfuReuse("a_subscription"),
	})
	eq(t, routes.CandidateReady(guardFor(A, prepared.Current.Revision, "a_sfu_reuse"), acquisition.WakeAtMs+2, nil, CandidateProof{}).Accepted, true)
	publication := routes.Snapshot().HostPublication
	if publication == nil {
		t.Fatal("expected a host publication")
	}
	eq(t, publication.Generation, "publication_generation")
	eq(t, publication.Usable, true)
	edge := edgeOf(t, routes, A)
	eq(t, edge.Kind, UpstreamSfu)
	eq(t, edge.PublicationGeneration, "publication_generation")
	eq(t, edge.Usable, true)
	convergence := must(t, routes.Reconcile(acquisition.WakeAtMs+3).Operation)
	eq(t, convergence.ChildPeerID, A)
	eq(t, convergence.Reason, DemandDirectConvergence)
	eq(t, convergence.Candidates[0].Tuple, peerTuple(B))
	directOp := beginOperation(t, routes, BeginInput{NowMs: acquisition.WakeAtMs + 4, ConnectionID: "a_from_b", Reservation: direct()})
	eq(t, must(t, routes.Snapshot().Operation).WakeAtMs, convergence.DeadlineAtMs)
	edge = edgeOf(t, routes, A)
	eq(t, edge.Kind, UpstreamSfu)
	eq(t, edge.ConnectionID, "a_sfu_reuse")
	eq(t, routes.CandidateReady(guardFor(A, directOp.Current.Revision, "a_from_b"), acquisition.WakeAtMs+5, nil, CandidateProof{}).Accepted, true)
	edge = edgeOf(t, routes, A)
	eq(t, edge.Kind, UpstreamPeer)
	eq(t, edge.ParentPeerID, B)
	eq(t, edge.ConnectionID, "a_from_b")
}

// TS 3380: advances exact direct convergence failures without failing SFU
func TestAdvancesExactDirectConvergenceFailuresWithoutFailingSfu(t *testing.T) {
	routes := newController(2, Options{SfuEnabled: true})
	addViewer(routes, D, 0, nil)
	routes.hydrateEdge(D, peerEdge(HOST, "host_full"))
	routes.hydrateHostPublication("publication_1", res("publication_resource"), "")
	for _, peerID := range []string{B, C} {
		addViewer(routes, peerID, 1, nil)
		routes.hydrateEdge(peerID, sfuEdge("publication_1", peerID+"_sfu", peerID+"_subscription"))
	}
	// These fixture SFU relays already exhausted their own upstream opportunities.
	for _, peerID := range []string{B, C} {
		for _, plan := range routes.buildCandidates(peerID, false) {
			if plan.Tuple.Kind == UpstreamPeer {
				routes.consumeCandidateOpportunity(peerID, plan)
			}
		}
	}

	addViewer(routes, A, 0, ms(0))
	acquisition := must(t, routes.Reconcile(0).Operation)
	headStartTuple := acquisition.Candidates[0].Tuple
	eq(t, headStartTuple.Kind, UpstreamPeer)
	headStartParent := headStartTuple.ParentPeerID
	otherParent := B
	if headStartParent == B {
		otherParent = C
	}
	beginCandidate(t, routes, BeginInput{NowMs: 1, ConnectionID: "a_direct_head_start", Reservation: direct()})
	routes.OperationExpired(acquisition.WakeAtMs)
	sfu := beginOperation(t, routes, BeginInput{NowMs: acquisition.WakeAtMs + 1, ConnectionID: "a_sfu", Reservation: sfuReuse("a_subscription")})
	eq(t, routes.CandidateReady(guardFor(A, sfu.Current.Revision, "a_sfu"), acquisition.WakeAtMs+2, nil, CandidateProof{}).Accepted, true)

	first := must(t, routes.Reconcile(acquisition.WakeAtMs+3).Operation)
	eq(t, first.Candidates[0].Tuple.Kind, UpstreamPeer)
	eq(t, first.Candidates[0].Tuple.ParentPeerID, otherParent)
	failed := beginOperation(t, routes, BeginInput{NowMs: acquisition.WakeAtMs + 4, ConnectionID: "a_direct_followup", Reservation: direct()})
	eqSlice(t, routes.CandidateFailed(guardFor(A, failed.Current.Revision, "a_direct_followup"), acquisition.WakeAtMs+5).FailedPeerIDs, []string{})
	edge := edgeOf(t, routes, A)
	eq(t, edge.Kind, UpstreamSfu)
	eq(t, edge.ConnectionID, "a_sfu")
	retry := must(t, routes.Reconcile(acquisition.WakeAtMs+6).Operation)
	eq(t, retry.Candidates[0].Tuple.Kind, UpstreamPeer)
	eq(t, retry.Candidates[0].Tuple.ParentPeerID, headStartParent)
}

// TS 3451: round-robins background direct convergence between SFU Viewers
func TestRoundRobinsBackgroundDirectConvergenceBetweenSfuViewers(t *testing.T) {
	routes := newController(2, Options{SfuEnabled: true})
	routes.hydrateHostPublication("publication", res("publication_resource"), "")
	for _, peerID := range []string{B, C} {
		addViewer(routes, peerID, 2, nil)
		routes.hydrateEdge(peerID, sfuEdge("publication", peerID+"_sfu", peerID+"_subscription"))
	}

	// These fixture SFU relays already exhausted their own upstream opportunities.
	for _, peerID := range []string{B, C} {
		for _, plan := range routes.buildCandidates(peerID, false) {
			if plan.Tuple.Kind == UpstreamPeer {
				routes.consumeCandidateOpportunity(peerID, plan)
			}
		}
	}

	nowMs := int64(0)
	for _, peerID := range []string{A, D} {
		addViewer(routes, peerID, 0, ms(nowMs))
		acquisition := must(t, routes.Reconcile(nowMs).Operation)
		beginCandidate(t, routes, BeginInput{NowMs: nowMs + 1, ConnectionID: peerID + "_head_start", Reservation: direct()})
		routes.OperationExpired(acquisition.WakeAtMs)
		sfu := beginOperation(t, routes, BeginInput{
			NowMs: acquisition.WakeAtMs + 1, ConnectionID: peerID + "_sfu", Reservation: sfuReuse(peerID + "_subscription"),
		})
		eq(t, routes.CandidateReady(guardFor(peerID, sfu.Current.Revision, peerID+"_sfu"), acquisition.WakeAtMs+2, nil, CandidateProof{}).Accepted, true)
		nowMs = acquisition.WakeAtMs + 3
	}

	first := must(t, routes.Reconcile(nowMs).Operation)
	eq(t, first.ChildPeerID, A)
	eq(t, first.Reason, DemandDirectConvergence)
	firstAttempt := beginOperation(t, routes, BeginInput{NowMs: nowMs + 1, ConnectionID: "a_background_direct", Reservation: direct()})
	eq(t, routes.CandidateFailed(guardFor(A, firstAttempt.Current.Revision, "a_background_direct"), nowMs+2).Accepted, true)
	next := must(t, routes.Reconcile(nowMs+3).Operation)
	eq(t, next.ChildPeerID, D)
	eq(t, next.Reason, DemandDirectConvergence)
}

// TS 3516: preempts direct convergence when another Viewer needs a route
func TestPreemptsDirectConvergenceWhenAnotherViewerNeedsRoute(t *testing.T) {
	routes := newController(2, Options{SfuEnabled: true})
	addViewer(routes, B, 2, nil)
	routes.hydrateHostPublication("publication_1", res("publication_resource"), "")
	routes.hydrateEdge(B, sfuEdge("publication_1", "b_sfu", "b_subscription"))
	addViewer(routes, C, 0, nil)
	routes.hydrateEdge(C, peerEdge(HOST, "c_from_host"))
	addViewer(routes, A, 0, ms(0))
	acquisition := must(t, routes.Reconcile(0).Operation)
	beginCandidate(t, routes, BeginInput{NowMs: 1, ConnectionID: "a_direct_head_start", Reservation: direct()})
	routes.OperationExpired(acquisition.WakeAtMs)
	sfu := beginOperation(t, routes, BeginInput{NowMs: acquisition.WakeAtMs + 1, ConnectionID: "a_sfu", Reservation: sfuReuse("a_subscription")})
	routes.CandidateReady(guardFor(A, sfu.Current.Revision, "a_sfu"), acquisition.WakeAtMs+2, nil, CandidateProof{})
	eq(t, must(t, routes.Reconcile(acquisition.WakeAtMs+3).Operation).Reason, DemandDirectConvergence)
	beginCandidate(t, routes, BeginInput{NowMs: acquisition.WakeAtMs + 4, ConnectionID: "a_direct_pending", Reservation: directOverlap("a_overlap")})

	activeRevision := routes.Snapshot().Revision
	eq(t, routes.InvalidateEdge(edgeGuard(C, "host_session", activeRevision, "c_from_host"), ms(acquisition.WakeAtMs+5)), true)
	reconciled := routes.Reconcile(acquisition.WakeAtMs + 6)
	eqLabels(t, reconciled.Released, "a_overlap")
	edge := edgeOf(t, routes, A)
	eq(t, edge.Kind, UpstreamSfu)
	eq(t, edge.ConnectionID, "a_sfu")
	preempted := must(t, reconciled.Operation)
	eq(t, preempted.ChildPeerID, C)
	eq(t, preempted.Reason, DemandEdgeUnavailable)
}

// TS 3579: owns Host-full SFU bootstrap failure by the waiting demand
func TestOwnsHostFullSfuBootstrapFailureByWaitingDemand(t *testing.T) {
	routes := newController(2, Options{SfuEnabled: true})
	addViewer(routes, B, 2, nil)
	routes.hydrateEdge(B, peerEdge(HOST, "b_from_host"))
	addViewer(routes, C, 0, nil)
	routes.hydrateEdge(C, peerEdge(HOST, "c_from_host"))
	addViewer(routes, A, 0, nil)
	addViewer(routes, D, 0, nil)

	operation := must(t, routes.Reconcile(0).Operation)
	eq(t, hasTuple(operation, isSfu), false)
	eq(t, operation.WakeAtMs, 5_000)
	beginCandidate(t, routes, BeginInput{NowMs: 1, ConnectionID: "a_silent_direct", Reservation: direct()})
	blocked := routes.OperationExpired(operation.WakeAtMs)
	eq(t, blocked.Accepted, true)
	eqSlice(t, blocked.FailedPeerIDs, []string{})
	eqLabels(t, blocked.Released)
	noOperation(t, routes.Snapshot().Operation)

	bootstrap := must(t, routes.Reconcile(operation.WakeAtMs+1).Operation)
	eq(t, bootstrap.ChildPeerID, C)
	eq(t, bootstrap.DemandPeerID, A)
	eq(t, bootstrap.Candidates[0].Tuple, sfuTuple(PublicationCreate))
	eq(t, bootstrap.Candidates[0].EndpointTransition.Kind, TransitionOverlap)
	firstCarrier := beginOperation(t, routes, BeginInput{
		NowMs:                   operation.WakeAtMs + 2,
		ConnectionID:            "c_bootstrap_sfu",
		PublicationGeneration:   "c_bootstrap_publication",
		PublicationConnectionID: "c_bootstrap_ingress",
		Reservation:             sfuCreateOverlap("c_bootstrap_subscription", "c_bootstrap_publication_resource", "c_bootstrap_overlap"),
	})
	eqSlice(t, routes.CandidateFailed(guardFor(C, firstCarrier.Current.Revision, "c_bootstrap_sfu"), operation.WakeAtMs+3).FailedPeerIDs, []string{})
	cEdge := edgeOf(t, routes, C)
	eq(t, cEdge.ConnectionID, "c_from_host")
	eq(t, cEdge.Usable, true)
	eq(t, cEdge.PhysicalActive, true)

	secondBootstrap := must(t, routes.Reconcile(operation.WakeAtMs+4).Operation)
	eq(t, secondBootstrap.ChildPeerID, B)
	eq(t, secondBootstrap.DemandPeerID, A)
	eq(t, secondBootstrap.Reason, DemandSfuBootstrap)
	secondCarrier := beginOperation(t, routes, BeginInput{
		NowMs:                   operation.WakeAtMs + 5,
		ConnectionID:            "b_bootstrap_sfu",
		PublicationGeneration:   "b_bootstrap_publication",
		PublicationConnectionID: "b_bootstrap_ingress",
		Reservation:             sfuCreateOverlap("b_bootstrap_subscription", "b_bootstrap_publication_resource", "b_bootstrap_overlap"),
	})
	eqSlice(t, routes.CandidateFailed(guardFor(B, secondCarrier.Current.Revision, "b_bootstrap_sfu"), operation.WakeAtMs+6).FailedPeerIDs, []string{A})
	for _, seed := range [][2]string{{B, "b_from_host"}, {C, "c_from_host"}} {
		edge := edgeOf(t, routes, seed[0])
		eq(t, edge.ConnectionID, seed[1])
		eq(t, edge.Usable, true)
		eq(t, edge.PhysicalActive, true)
	}
	nextDemand := must(t, routes.Reconcile(operation.WakeAtMs+7).Operation)
	eq(t, nextDemand.ChildPeerID, D)
	eq(t, nextDemand.Reason, DemandJoin)
	beginCandidate(t, routes, BeginInput{NowMs: operation.WakeAtMs + 8, ConnectionID: "d_direct", Reservation: direct()})
	eqSlice(t, routes.OperationExpired(nextDemand.DeadlineAtMs).FailedPeerIDs, []string{D})
	noOperation(t, routes.Reconcile(nextDemand.DeadlineAtMs+1).Operation)
}

// TS 3680: abandons bootstrap when a Host slot becomes available
func TestAbandonsBootstrapWhenHostSlotBecomesAvailable(t *testing.T) {
	routes := newController(2, Options{SfuEnabled: true})
	eq(t, routes.SetEffectiveCapacity(HOST, "host_session", 1, nil), true)
	addViewer(routes, B, 0, nil)
	routes.hydrateEdge(B, peerEdge(HOST, "b_from_host"))
	addViewer(routes, A, 0, nil)

	bootstrap := must(t, routes.Reconcile(0).Operation)
	eq(t, bootstrap.ChildPeerID, B)
	eq(t, bootstrap.DemandPeerID, A)
	eq(t, bootstrap.Reason, DemandSfuBootstrap)
	prepared := beginOperation(t, routes, BeginInput{
		NowMs:                   1,
		ConnectionID:            "stale_bootstrap",
		PublicationGeneration:   "stale_publication",
		PublicationConnectionID: "stale_ingress",
		Reservation:             sfuCreateOverlap("stale_subscription", "stale_publication_resource", "stale_overlap"),
	})

	eq(t, routes.SetEffectiveCapacity(HOST, "host_session", 2, nil), true)
	stale := routes.CandidateReady(guardFor(B, prepared.Current.Revision, "stale_bootstrap"), 2, nil, CandidateProof{})
	eq(t, stale.Accepted, false)
	containsLabels(t, stale.Released, "stale_subscription", "stale_publication_resource", "stale_overlap")
	bEdge := edgeOf(t, routes, B)
	eq(t, bEdge.ConnectionID, "b_from_host")
	eq(t, bEdge.Usable, true)
	eq(t, bEdge.PhysicalActive, true)
	join := must(t, routes.Reconcile(3).Operation)
	eq(t, join.ChildPeerID, A)
	eq(t, join.DemandPeerID, A)
	eq(t, join.Reason, DemandJoin)
}

// TS 3731: tries SFU first after bootstrap and retains the direct suffix
func TestTriesSfuFirstAfterBootstrapAndRetainsDirectSuffix(t *testing.T) {
	routes := newController(2, Options{SfuEnabled: true})
	for _, seed := range [][2]string{{B, "b_from_host"}, {C, "c_from_host"}} {
		addViewer(routes, seed[0], 1, nil)
		routes.hydrateEdge(seed[0], peerEdge(HOST, seed[1]))
	}
	addViewer(routes, A, 0, nil)

	acquisition := must(t, routes.Reconcile(0).Operation)
	beginCandidate(t, routes, BeginInput{NowMs: 1, ConnectionID: "a_direct_head_start", Reservation: direct()})
	routes.OperationExpired(acquisition.WakeAtMs)
	bootstrap := must(t, routes.Reconcile(acquisition.WakeAtMs+1).Operation)
	carrier := beginOperation(t, routes, BeginInput{
		NowMs:                   acquisition.WakeAtMs + 2,
		ConnectionID:            "bootstrap_sfu",
		PublicationGeneration:   "bootstrap_publication",
		PublicationConnectionID: "bootstrap_ingress",
		Reservation:             sfuCreateOverlap("carrier_subscription", "bootstrap_publication_resource", "bootstrap_overlap"),
	})
	eq(t, routes.CandidateReady(CandidateGuard{
		ChildPeerID:    bootstrap.ChildPeerID,
		ChildSessionID: bootstrap.ChildSessionID,
		Revision:       carrier.Current.Revision,
		ConnectionID:   "bootstrap_sfu",
	}, acquisition.WakeAtMs+3, nil, CandidateProof{}).Accepted, true)

	demand := must(t, routes.Reconcile(acquisition.WakeAtMs+4).Operation)
	eq(t, demand.ChildPeerID, A)
	eq(t, demand.DemandPeerID, A)
	eq(t, demand.Reason, DemandJoin)
	eq(t, demand.Candidates[0].Tuple, sfuTuple(PublicationReuse))
	for _, tuple := range tuplesFrom(demand, 1) {
		eq(t, tuple.Kind, UpstreamPeer)
	}
	subscription := beginOperation(t, routes, BeginInput{NowMs: acquisition.WakeAtMs + 5, ConnectionID: "a_sfu", Reservation: sfuReuse("a_subscription")})
	eq(t, routes.CandidateFailed(guardFor(A, subscription.Current.Revision, "a_sfu"), acquisition.WakeAtMs+6).Accepted, true)
	pending := must(t, routes.Snapshot().Operation)
	eq(t, pending.Candidates[pending.Cursor].Tuple.Kind, UpstreamPeer)
	directOp := beginOperation(t, routes, BeginInput{NowMs: acquisition.WakeAtMs + 7, ConnectionID: "a_deferred_direct", Reservation: direct()})
	eq(t, routes.CandidateReady(guardFor(A, directOp.Current.Revision, "a_deferred_direct"), acquisition.WakeAtMs+8, nil, CandidateProof{}).Accepted, true)
	edge := edgeOf(t, routes, A)
	eq(t, edge.Kind, UpstreamPeer)
	eq(t, edge.ConnectionID, "a_deferred_direct")
	convergence := must(t, routes.Reconcile(acquisition.WakeAtMs+9).Operation)
	eq(t, convergence.ChildPeerID, bootstrap.ChildPeerID)
	eq(t, convergence.Reason, DemandDirectConvergence)
}

// TS 3819: replans when the current candidate parent fails
func TestReplansWhenCurrentCandidateParentFails(t *testing.T) {
	routes := newController(3, Options{})
	addViewer(routes, A, 1, nil)
	addViewer(routes, B, 1, nil)
	addViewer(routes, C, 1, nil)
	routes.hydrateEdge(A, peerEdge(HOST, "a_old"))
	routes.hydrateEdge(B, peerEdge(HOST, "b_old"))
	routes.hydrateEdge(C, peerEdge(HOST, "c_old"))
	revision := routes.Snapshot().Revision
	eq(t, routes.InvalidateEdge(edgeGuard(A, "host_session", revision, "a_old"), nil), true)
	routes.Reconcile(0)
	current := beginOperation(t, routes, BeginInput{NowMs: 1, ConnectionID: "a_new", Reservation: direct()})
	currentTuple := current.Current.Tuple
	eq(t, currentTuple.Kind, UpstreamPeer)
	failedParentPeerID := currentTuple.ParentPeerID
	failedParentConnectionID := "c_old"
	if failedParentPeerID == B {
		failedParentConnectionID = "b_old"
	}
	eq(t, routes.InvalidateEdge(edgeGuard(failedParentPeerID, "host_session", revision, failedParentConnectionID), nil), true)
	eq(t, routes.CandidateReady(guardFor(A, current.Current.Revision, "a_new"), 2, nil, CandidateProof{}).Accepted, false)
	replacement := beginOperation(t, routes, BeginInput{NowMs: 2, ConnectionID: "a_new_2", Reservation: direct()})
	eq(t, routes.CandidateReady(guardFor(A, replacement.Current.Revision, "a_new_2"), 3, nil, CandidateProof{}).Accepted, true)
	eq(t, must(t, routes.Reconcile(3).Operation).ChildPeerID, failedParentPeerID)
}

// TS 3886: keeps an active candidate when an unrelated session is replaced
func TestKeepsActiveCandidateWhenUnrelatedSessionIsReplaced(t *testing.T) {
	routes := newController(2, Options{})
	for _, seed := range [][2]string{{B, "b_from_host"}, {C, "c_from_host"}} {
		addViewer(routes, seed[0], 1, nil)
		routes.hydrateEdge(seed[0], peerEdge(HOST, seed[1]))
	}
	addViewer(routes, A, 0, nil)
	operation := must(t, routes.Reconcile(0).Operation)
	active := beginOperation(t, routes, BeginInput{NowMs: 1, ConnectionID: "a_active_candidate", Reservation: direct()})
	tuple := active.Current.Tuple
	eq(t, tuple.Kind, UpstreamPeer)
	unrelatedPeerID := B
	if tuple.ParentPeerID == B {
		unrelatedPeerID = C
	}

	eqLabels(t, routes.UpsertParticipant(viewerInput(unrelatedPeerID, unrelatedPeerID+"_replacement", 1), ms(2)))
	current := must(t, routes.Snapshot().Operation).Current
	if current == nil {
		t.Fatal("expected the live attempt to survive")
	}
	eq(t, current.Revision, operation.BaseRevision+1)
	eq(t, current.ConnectionID, "a_active_candidate")
}

func TestUsesDepartedRelaysFreedHostSlotWithoutMovingHealthyDescendants(t *testing.T) {
	routes := newController(2, Options{})
	addViewer(routes, A, 2, nil)
	addViewer(routes, B, 2, nil)
	addViewer(routes, C, 0, nil)
	addViewer(routes, D, 0, nil)
	routes.hydrateEdge(A, peerEdge(HOST, "a_root"))
	routes.hydrateEdge(B, peerEdge(HOST, "b_root"))
	routes.hydrateEdge(C, peerEdge(A, "c_from_a"))
	routes.hydrateEdge(D, peerEdge(B, "d_from_b"))

	eq(t, routes.ConfirmDeparture(B, nil), true)
	repair := must(t, routes.Reconcile(0).Operation)
	eq(t, repair.ChildPeerID, D)
	eq(t, repair.Candidates[0].Tuple, peerTuple(HOST))
	commitCurrent(t, routes, 1, "d_from_host")
	noOperation(t, routes.Reconcile(2).Operation)
	eq(t, hasEdge(routes, B), false)

	addViewer(routes, E, 0, nil)
	join := must(t, routes.Reconcile(3).Operation)
	eq(t, join.ChildPeerID, E)
	eq(t, join.Candidates[0].Tuple, peerTuple(A))
	commitCurrent(t, routes, 4, "e_from_a")

	cEdge := edgeOf(t, routes, C)
	eq(t, cEdge.ParentPeerID, A)
	eq(t, cEdge.ConnectionID, "c_from_a")
	dEdge := edgeOf(t, routes, D)
	eq(t, dEdge.ParentPeerID, HOST)
	eq(t, dEdge.ConnectionID, "d_from_host")
	eEdge := edgeOf(t, routes, E)
	eq(t, eEdge.ParentPeerID, A)
	eq(t, eEdge.ConnectionID, "e_from_a")
}

// TS 3967: keeps grace media, then reparents a confirmed relay departure
func TestKeepsGraceMediaThenReparentsConfirmedRelayDeparture(t *testing.T) {
	routes := newController(2, Options{})
	addViewer(routes, A, 2, nil)
	addViewer(routes, B, 1, nil)
	addViewer(routes, C, 0, nil)
	routes.hydrateEdge(A, peerEdge(HOST, "a_connection"))
	routes.hydrateEdge(B, peerEdge(A, "b_connection"))
	routes.hydrateEdge(C, peerEdge(B, "c_connection"))

	eq(t, routes.DisconnectSession(A, sessionOf(A)), true)
	noOperation(t, routes.Reconcile(0).Operation)
	eq(t, routes.ConfirmDeparture(A, nil), true)
	eq(t, must(t, routes.Reconcile(1).Operation).ChildPeerID, B)
	commitCurrent(t, routes, 2, "b_reparented")
	beforePrune := routes.Snapshot().Revision
	after := routes.Reconcile(3)
	if !slices.Contains(after.RemovedPeerIDs, A) {
		t.Fatalf("removedPeerIds %v does not contain A", after.RemovedPeerIDs)
	}
	if routes.Snapshot().Revision <= beforePrune {
		t.Fatalf("revision %d did not advance past %d", routes.Snapshot().Revision, beforePrune)
	}
	cEdge := edgeOf(t, routes, C)
	eq(t, cEdge.ParentPeerID, B)
	eq(t, cEdge.ConnectionID, "c_connection")
}

// TS 3991: moves newest overflow children and supports effective capacity zero
func TestMovesNewestOverflowChildrenAndSupportsEffectiveCapacityZero(t *testing.T) {
	routes := newController(3, Options{})
	addViewer(routes, A, 3, nil)
	routes.hydrateEdge(A, peerEdge(HOST, "a_connection"))
	for _, peerID := range []string{B, C, D} {
		addViewer(routes, peerID, 0, nil)
		routes.hydrateEdge(peerID, peerEdge(A, peerID+"_connection"))
	}
	eq(t, routes.SetEffectiveCapacity(A, sessionOf(A), 1, nil), true)
	eq(t, must(t, routes.Reconcile(0).Operation).ChildPeerID, D)
	eqLabels(t, routes.SetPaused(true, nil))
	eq(t, routes.SetEffectiveCapacity(A, sessionOf(A), 0, nil), true)
	eqLabels(t, routes.SetPaused(false, nil))
	eq(t, must(t, routes.Reconcile(1).Operation).ChildPeerID, D)

	blocked := newController(1, Options{})
	addViewer(blocked, A, 0, nil)
	addViewer(blocked, B, 0, nil)
	blocked.hydrateEdge(A, peerEdge(HOST, "blocked_a"))
	blocked.hydrateEdge(B, peerEdge(A, "blocked_b"))
	noOperation(t, blocked.Reconcile(0).Operation)
	noOperation(t, blocked.Reconcile(1).Operation)
}

// TS 4015: aborts pending SFU resources on pause and repairs publication
func TestAbortsPendingSfuResourcesOnPauseAndRepairsPublication(t *testing.T) {
	routes := newController(1, Options{SfuEnabled: true})
	addViewer(routes, A, 1, nil)
	addViewer(routes, B, 0, nil)
	routes.hydrateHostPublication("publication_1", res("publication_resource"), "")
	routes.hydrateEdge(A, sfuEdge("publication_1", "a_sfu", "a_subscription"))
	operation := must(t, routes.Reconcile(0).Operation)
	eq(t, operation.Candidates[0].Tuple, peerTuple(A))
	beginCandidate(t, routes, BeginInput{NowMs: 1, ConnectionID: "b_direct_head_start", Reservation: direct()})
	routes.OperationExpired(operation.WakeAtMs)
	beginCandidate(t, routes, BeginInput{NowMs: operation.WakeAtMs + 1, ConnectionID: "b_candidate", Reservation: sfuReuse("b_subscription")})
	eqLabels(t, routes.SetPaused(true, nil), "b_subscription")
	noOperation(t, routes.Snapshot().Operation)
	eq(t, edgeOf(t, routes, A).ConnectionID, "a_sfu")
	routes.SetPaused(false, nil)
	eq(t, routes.InvalidateHostPublication(PublicationGuard{
		HostSessionID: "host_session",
		RouteRevision: routes.Snapshot().Revision,
		Generation:    "publication_1",
		ConnectionID:  "publication:publication_1",
	}, nil), true)
	routes.TouchExternalFacts()
	repair := must(t, routes.Reconcile(2).Operation)
	eq(t, repair.ChildPeerID, A)
	eq(t, repair.Candidates[0].Tuple, peerTuple(HOST))
	skipCandidate(t, routes, 3)
	eq(t, must(t, routes.Snapshot().Operation).Candidates[1].Tuple, sfuTuple(PublicationReplace))
	expectPanic(t, "endpoint overlap reservation", func() {
		beginCandidate(t, routes, BeginInput{
			NowMs:                   3,
			ConnectionID:            "a_sfu_2",
			PublicationGeneration:   "publication_2",
			PublicationConnectionID: "publication_connection_2",
			Reservation:             sfuCreate("a_subscription_2", "publication_resource_2"),
		})
	})
	publicationRepair := beginOperation(t, routes, BeginInput{
		NowMs:                   3,
		ConnectionID:            "a_sfu_2",
		PublicationGeneration:   "publication_2",
		PublicationConnectionID: "publication_connection_2",
		Reservation:             sfuCreateOverlap("a_subscription_2", "publication_resource_2", "publication_overlap"),
	})
	repaired := routes.CandidateReady(guardFor(A, publicationRepair.Current.Revision, "a_sfu_2"), 4, nil, CandidateProof{})
	eq(t, repaired.Accepted, true)
	eq(t, len(repaired.Released), 3)
	containsLabels(t, repaired.Released, "publication_overlap", "a_subscription", "publication_resource")
	publication := routes.Snapshot().HostPublication
	if publication == nil {
		t.Fatal("expected a repaired publication")
	}
	eq(t, publication.Generation, "publication_2")
	eq(t, publication.Usable, true)
	eq(t, publication.PhysicalActive, true)

	bootstrap := newController(1, Options{SfuEnabled: true})
	addViewer(bootstrap, A, 0, nil)
	addViewer(bootstrap, B, 0, nil)
	bootstrap.hydrateEdge(A, peerEdge(HOST, "bootstrap_a"))
	bootstrapOperation := must(t, bootstrap.Reconcile(0).Operation)
	eq(t, bootstrapOperation.ChildPeerID, A)
	eq(t, bootstrapOperation.Candidates[0].Tuple, sfuTuple(PublicationCreate))
	expectPanic(t, "endpoint overlap reservation", func() {
		beginCandidate(t, bootstrap, BeginInput{
			NowMs:                   2,
			ConnectionID:            "bootstrap_sfu",
			PublicationGeneration:   "bootstrap_publication",
			PublicationConnectionID: "bootstrap_ingress_connection",
			Reservation:             sfuCreate("bootstrap_subscription", "bootstrap_ingress"),
		})
	})
	preparedBootstrap := beginOperation(t, bootstrap, BeginInput{
		NowMs:                   2,
		ConnectionID:            "bootstrap_sfu",
		PublicationGeneration:   "bootstrap_publication",
		PublicationConnectionID: "bootstrap_ingress_connection",
		Reservation:             sfuCreateOverlap("bootstrap_subscription", "bootstrap_ingress", "bootstrap_overlap"),
	})
	eq(t, bootstrap.CandidateReady(guardFor(A, preparedBootstrap.Current.Revision, "bootstrap_sfu"), 3, nil, CandidateProof{}).Accepted, true)
	eq(t, must(t, bootstrap.Reconcile(4).Operation).ChildPeerID, B)
}

// TS 4153: reopens SFU bootstrap after the physical publication retires
func TestReopensSfuBootstrapAfterPhysicalPublicationRetires(t *testing.T) {
	routes := newController(2, Options{SfuEnabled: true})
	addViewer(routes, A, 0, nil)
	routes.hydrateHostPublication("retired_publication", res("publication_resource"), "")
	routes.hydrateEdge(A, sfuEdge("retired_publication", "a_from_sfu", "a_subscription"))

	publication := routes.Snapshot().HostPublication
	if publication == nil {
		t.Fatal("expected a host publication")
	}
	containsLabels(t, routes.RetireHostPublication(PublicationGuard{
		HostSessionID: publication.HostSessionID,
		RouteRevision: routes.Snapshot().Revision,
		Generation:    publication.Generation,
		ConnectionID:  publication.ConnectionID,
	}), "a_subscription", "publication_resource")
	if routes.Snapshot().HostPublication != nil {
		t.Fatal("expected no host publication")
	}

	for _, seed := range [][2]string{{B, "b_from_host"}, {C, "c_from_host"}} {
		addViewer(routes, seed[0], 0, nil)
		routes.hydrateEdge(seed[0], peerEdge(HOST, seed[1]))
	}
	reconciled := routes.Reconcile(1)
	eqSlice(t, reconciled.FailedPeerIDs, []string{})
	operation := must(t, reconciled.Operation)
	eq(t, operation.DemandPeerID, A)
	eq(t, operation.Reason, DemandSfuBootstrap)
	eqSlice(t, tuples(operation), []CandidateTuple{sfuTuple(PublicationCreate)})
}

// TS 4199: binds reserve and skip results to the exact candidate cursor
func TestBindsReserveAndSkipResultsToExactCandidateCursor(t *testing.T) {
	reserve := newController(2, Options{})
	addViewer(reserve, A, 2, nil)
	reserve.hydrateEdge(A, peerEdge(HOST, "a_active"))
	addViewer(reserve, B, 0, nil)
	first := must(t, reserve.Reconcile(0).Operation)
	eq(t, first.Candidates[0].Tuple.Kind, UpstreamPeer)
	eq(t, first.Candidates[0].Tuple.ParentPeerID, HOST)
	reserve.SetEffectiveCapacity(HOST, "host_session", 0, nil)
	staleReserve := reserve.BeginCurrentCandidate(BeginInput{
		Guard:        cursorGuard(first),
		NowMs:        1,
		ConnectionID: "reserved_for_old_cursor",
		Reservation:  directOverlap("stale_reservation"),
	})
	eq(t, staleReserve.Accepted, false)
	eqLabels(t, staleReserve.Released, "stale_reservation")
	rebuilt := must(t, reserve.Snapshot().Operation)
	eq(t, rebuilt.Cursor, 0)
	eqSlice(t, tuples(rebuilt), []CandidateTuple{peerTuple(A)})
	if rebuilt.Current != nil {
		t.Fatal("expected no live attempt")
	}

	skip := newController(2, Options{})
	addViewer(skip, A, 2, nil)
	skip.hydrateEdge(A, peerEdge(HOST, "a_active"))
	addViewer(skip, B, 0, nil)
	staleCursor := must(t, skip.Reconcile(0).Operation)
	skip.SetEffectiveCapacity(HOST, "host_session", 0, nil)
	eq(t, skip.SkipCurrentCandidate(cursorGuard(staleCursor), 1, RejectionStale).Accepted, false)
	pending := must(t, skip.Snapshot().Operation)
	eq(t, pending.Cursor, 0)
	eq(t, pending.Candidates[0].Tuple.Kind, UpstreamPeer)
	eq(t, pending.Candidates[0].Tuple.ParentPeerID, A)
}

// TS 4243: keeps only old SFU roots that still anchor peer descendants
func TestKeepsOnlyOldSfuRootsThatStillAnchorPeerDescendants(t *testing.T) {
	routes := newController(1, Options{SfuEnabled: true})
	addViewer(routes, A, 0, nil)
	addViewer(routes, B, 1, nil)
	addViewer(routes, C, 0, nil)
	addViewer(routes, D, 0, nil)
	routes.hydrateHostPublication("publication_1", res("publication_resource_1"), "")
	for _, seed := range [][2]string{{A, "subscription_a"}, {B, "subscription_b"}, {D, "subscription_d"}} {
		routes.hydrateEdge(seed[0], sfuEdge("publication_1", seed[0]+"_sfu_1", seed[1]))
	}
	routes.hydrateEdge(C, peerEdge(B, "c_from_b"))
	eq(t, routes.InvalidateHostPublication(PublicationGuard{
		HostSessionID: "host_session",
		RouteRevision: 0,
		Generation:    "publication_1",
		ConnectionID:  "publication:publication_1",
	}, ms(10)), true)
	routes.TouchExternalFacts()
	operation := must(t, routes.Reconcile(20).Operation)
	eq(t, operation.Candidates[0].Tuple, sfuTuple(PublicationReplace))
	expectTransition(t, operation.Candidates[0].EndpointTransition, TransitionOverlap, HOST)
	prepared := beginOperation(t, routes, BeginInput{
		NowMs:                   21,
		ConnectionID:            "a_sfu_2",
		PublicationGeneration:   "publication_2",
		PublicationConnectionID: "publication_connection_2",
		Reservation:             sfuCreateOverlap("subscription_a_2", "publication_resource_2", "publication_overlap"),
	})
	settled := routes.CandidateReady(guardFor(A, prepared.Current.Revision, "a_sfu_2"), 22, nil, CandidateProof{})
	eq(t, settled.Accepted, true)
	containsLabels(t, settled.Released, "publication_overlap", "subscription_a", "subscription_b", "subscription_d", "publication_resource_1")
	eq(t, edgeOf(t, routes, A).PublicationGeneration, "publication_2")
	bEdge := edgeOf(t, routes, B)
	eq(t, bEdge.Kind, UpstreamSfu)
	eq(t, bEdge.PublicationGeneration, "publication_1")
	eq(t, bEdge.Usable, false)
	eq(t, bEdge.PhysicalActive, false)
	cEdge := edgeOf(t, routes, C)
	eq(t, cEdge.Kind, UpstreamPeer)
	eq(t, cEdge.ParentPeerID, B)
	eq(t, hasEdge(routes, D), false)
	child := routes.RouteDiagnosticSnapshot(22).Children[1]
	eqDeep(t, child.DemandAgeMs, optInt(12))
	eq(t, child.FinalRoute, "waiting")
	next := must(t, routes.Reconcile(23).Operation)
	eq(t, next.ChildPeerID, B)
	eq(t, next.Reason, DemandEdgeUnavailable)
}

// TS 4328: rebinds direct and SFU media to replacement sessions
func TestRebindsDirectAndSfuMediaToReplacementSessions(t *testing.T) {
	peerRoutes := newController(2, Options{})
	addViewer(peerRoutes, A, 1, nil)
	addViewer(peerRoutes, B, 0, nil)
	peerRoutes.hydrateEdge(A, peerEdge(HOST, "a_direct"))
	peerRoutes.hydrateEdge(B, peerEdge(A, "b_direct"))
	eqLabels(t, peerRoutes.UpsertParticipant(viewerInput(A, "a_replacement", 1), nil))
	aEdge := edgeOf(t, peerRoutes, A)
	eq(t, aEdge.ChildSessionID, "a_replacement")
	eq(t, aEdge.Usable, true)
	eq(t, aEdge.PhysicalActive, true)
	eq(t, edgeOf(t, peerRoutes, B).ParentSessionID, "a_replacement")
	eqLabels(t, peerRoutes.UpsertParticipant(viewerInput(B, "b_replacement", 0), nil))
	bEdge := edgeOf(t, peerRoutes, B)
	eq(t, bEdge.ChildSessionID, "b_replacement")
	eq(t, bEdge.Usable, true)
	eq(t, bEdge.PhysicalActive, true)

	sfuRoutes := newController(1, Options{SfuEnabled: true})
	addViewer(sfuRoutes, A, 0, nil)
	sfuRoutes.hydrateHostPublication("publication", res("publication_resource"), "publication_connection")
	sfuRoutes.hydrateEdge(A, sfuEdge("publication", "subscription_connection", "subscription_resource"))
	eqLabels(t, sfuRoutes.UpsertParticipant(hostInput("host_replacement", 1), nil))
	publication := sfuRoutes.Snapshot().HostPublication
	if publication == nil {
		t.Fatal("expected a host publication")
	}
	eq(t, publication.HostSessionID, "host_replacement")
	eq(t, publication.Usable, true)
	eq(t, publication.PhysicalActive, true)
	eqLabels(t, sfuRoutes.UpsertParticipant(viewerInput(A, "a_replacement", 0), nil))
	sfuEdgeA := edgeOf(t, sfuRoutes, A)
	eq(t, sfuEdgeA.ChildSessionID, "a_replacement")
	eq(t, sfuEdgeA.PhysicalActive, true)
}

// TS 4399: retries a bootstrap carrier only when its transition improves
func TestRetriesBootstrapCarrierOnlyWhenTransitionImproves(t *testing.T) {
	routes := newController(1, Options{SfuEnabled: true})
	addViewer(routes, A, 0, nil)
	routes.hydrateEdge(A, peerEdge(HOST, "failed_direct"))
	eq(t, routes.InvalidateEdge(edgeGuard(A, "host_session", 0, "failed_direct"), nil), true)
	operation := must(t, routes.Reconcile(0).Operation)
	prepared := beginOperation(t, routes, BeginInput{
		NowMs:                   1,
		ConnectionID:            "failed_sfu",
		PublicationGeneration:   "failed_publication",
		PublicationConnectionID: "failed_publication_connection",
		Reservation:             sfuCreateOverlap("failed_subscription_resource", "failed_publication_resource", "failed_overlap"),
	})
	failed := routes.CandidateFailed(CandidateGuard{
		ChildPeerID:    operation.ChildPeerID,
		ChildSessionID: operation.ChildSessionID,
		Revision:       prepared.Current.Revision,
		ConnectionID:   "failed_sfu",
	}, 2)
	eq(t, failed.Accepted, true)
	eqSlice(t, failed.FailedPeerIDs, []string{A})
	improved := must(t, routes.Reconcile(3).Operation)
	eq(t, improved.Candidates[0].Tuple, sfuTuple(PublicationCreate))
	expectTransition(t, improved.Candidates[0].EndpointTransition, TransitionNone, HOST)
	improvedAttempt := beginOperation(t, routes, BeginInput{
		NowMs:                   4,
		ConnectionID:            "improved_sfu",
		PublicationGeneration:   "improved_publication",
		PublicationConnectionID: "improved_publication_connection",
		Reservation:             sfuCreate("improved_subscription_resource", "improved_publication_resource"),
	})
	failedAgain := routes.CandidateFailed(CandidateGuard{
		ChildPeerID:    improved.ChildPeerID,
		ChildSessionID: improved.ChildSessionID,
		Revision:       improvedAttempt.Current.Revision,
		ConnectionID:   "improved_sfu",
	}, 5)
	eq(t, failedAgain.Accepted, true)
	eqSlice(t, failedAgain.FailedPeerIDs, []string{A})
	factVersion := routes.Snapshot().FactVersion
	noOperation(t, routes.Reconcile(6).Operation)
	eq(t, routes.SetEffectiveCapacity(A, sessionOf(A), 0, nil), true)
	eq(t, routes.Snapshot().FactVersion, factVersion)
	noOperation(t, routes.Reconcile(7).Operation)
	eq(t, routes.InvalidateEdge(edgeGuard(A, "host_session", routes.Snapshot().Revision, "failed_direct"), nil), true)
	eq(t, routes.Snapshot().FactVersion, factVersion)
	noOperation(t, routes.Reconcile(8).Operation)

	addViewer(routes, B, 0, ms(9))
	eq(t, must(t, routes.Reconcile(9).Operation).ChildPeerID, B)
	// TS: `while (routes.snapshot().operation) skipCandidate(routes, 10);` bounded here so a broken port cannot hang.
	for rounds := 0; routes.Snapshot().Operation != nil; rounds++ {
		if rounds > 100 {
			t.Fatal("skipping never exhausted the operation")
		}
		skipCandidate(t, routes, 10)
	}
	noOperation(t, routes.Reconcile(11).Operation)
}

// TS 4472: requires one overlap slot for an SFU-to-Host transition at C=%i
func TestRequiresOneOverlapSlotForSfuToHostTransition(t *testing.T) {
	for _, capacity := range []int{1, 2} {
		t.Run(fmt.Sprintf("C=%d", capacity), func(t *testing.T) {
			routes := newController(capacity, Options{SfuEnabled: true})
			addViewer(routes, A, 0, nil)
			if capacity == 2 {
				addViewer(routes, E, 0, nil)
				routes.hydrateEdge(E, peerEdge(HOST, "e_direct"))
			}
			routes.hydrateHostPublication("publication_1", res("publication_resource_1"), "")
			routes.hydrateEdge(A, sfuEdge("publication_1", "a_sfu", "a_subscription"))
			routes.InvalidateEdge(edgeGuard(A, "", 0, "a_sfu"), nil)
			operation := must(t, routes.Reconcile(0).Operation)
			eq(t, operation.Candidates[0].Tuple, peerTuple(HOST))
			expectTransition(t, operation.Candidates[0].EndpointTransition, TransitionOverlap, HOST)
			expectPanic(t, "endpoint overlap reservation", func() {
				beginCandidate(t, routes, BeginInput{NowMs: 1, ConnectionID: "a_host_direct", Reservation: direct()})
			})
		})
	}
}

// TS 4510: uses one bounded gap instead of a fourth Host copy at C=3
func TestUsesOneBoundedGapInsteadOfFourthHostCopyAtCapacityThree(t *testing.T) {
	routes := newController(3, Options{SfuEnabled: true})
	addViewer(routes, A, 0, nil)
	for _, peerID := range []string{E, F} {
		addViewer(routes, peerID, 0, nil)
		routes.hydrateEdge(peerID, peerEdge(HOST, peerID+"_direct"))
	}
	routes.hydrateHostPublication("publication_1", res("publication_resource_1"), "")
	routes.hydrateEdge(A, sfuEdge("publication_1", "a_sfu", "a_subscription"))
	routes.InvalidateEdge(edgeGuard(A, "", 0, "a_sfu"), nil)
	operation := must(t, routes.Reconcile(10).Operation)
	deadline := operation.DeadlineAtMs
	eq(t, operation.Candidates[0].Tuple, peerTuple(HOST))
	transition := operation.Candidates[0].EndpointTransition
	expectTransition(t, transition, TransitionBoundedGap, HOST)
	if transition.Retire == nil {
		t.Fatal("expected a retirement")
	}
	eq(t, transition.Retire.Kind, RetirePublication)
	eq(t, transition.Retire.Generation, "publication_1")
	gap := routes.RetireCurrentCandidateProducer(cursorGuard(operation), 11)
	eq(t, gap.Accepted, true)
	eqLabels(t, gap.Released, "a_subscription", "publication_resource_1")
	replanned := must(t, gap.Operation)
	eq(t, replanned.DeadlineAtMs, deadline)
	eq(t, len(replanned.Candidates), 1)
	expectTransition(t, replanned.Candidates[0].EndpointTransition, TransitionNone, HOST)
	prepared := beginOperation(t, routes, BeginInput{NowMs: 12, ConnectionID: "a_host_direct", Reservation: direct()})
	eq(t, routes.CandidateReady(guardFor(A, prepared.Current.Revision, "a_host_direct"), 13, nil, CandidateProof{}).Accepted, true)
	if routes.Snapshot().HostPublication != nil {
		t.Fatal("expected no host publication")
	}
}

// TS 4564: does not reopen consumed none transitions after capacity reduction
func TestDoesNotReopenConsumedNoneTransitionsAfterCapacityReduction(t *testing.T) {
	routes := newController(2, Options{SfuEnabled: true})
	addViewer(routes, A, 0, nil)
	routes.hydrateHostPublication("publication", res("publication_resource"), "")
	routes.hydrateEdge(A, sfuEdge("publication", "a_from_sfu", "a_subscription"))
	eq(t, routes.InvalidateEdge(edgeGuard(A, "", 0, "a_from_sfu"), nil), true)
	operation := must(t, routes.Reconcile(0).Operation)
	eq(t, operation.Candidates[0].Tuple, peerTuple(HOST))
	expectTransition(t, operation.Candidates[0].EndpointTransition, TransitionNone, HOST)

	eq(t, routes.SetEffectiveCapacity(HOST, "host_session", 1, nil), true)
	eqSlice(t, routes.OperationExpired(operation.DeadlineAtMs).FailedPeerIDs, []string{A})
	noOperation(t, routes.Reconcile(operation.DeadlineAtMs+1).Operation)
}

// TS 4596: does not unblock an exhausted demand for an unrelated join
func TestDoesNotUnblockExhaustedDemandForUnrelatedJoin(t *testing.T) {
	routes := newController(1, Options{})
	addViewer(routes, B, 0, nil)
	routes.hydrateEdge(B, peerEdge(HOST, "b_from_host"))
	addViewer(routes, A, 0, ms(0))
	eqSlice(t, routes.Reconcile(0).FailedPeerIDs, []string{A})

	eq(t, routes.SetEffectiveCapacity(A, sessionOf(A), 1, nil), true)
	noOperation(t, routes.Reconcile(1).Operation)

	addViewer(routes, C, 0, ms(2))
	eqSlice(t, routes.Reconcile(2).FailedPeerIDs, []string{C})
	noOperation(t, routes.Snapshot().Operation)

	eq(t, routes.SetEffectiveCapacity(B, sessionOf(B), 1, nil), true)
	operation := must(t, routes.Reconcile(3).Operation)
	eq(t, operation.ChildPeerID, A)
	eqSlice(t, tuples(operation), []CandidateTuple{peerTuple(B)})
}

// TS 4621: does not revive an exact failed Host tuple when a new parent joins
func TestDoesNotReviveExactFailedHostTupleWhenNewParentJoins(t *testing.T) {
	routes := newController(1, Options{})
	addViewer(routes, A, 0, nil)
	routes.hydrateEdge(A, peerEdge(HOST, "failed_direct"))
	eq(t, routes.InvalidateEdge(edgeGuard(A, "host_session", 0, "failed_direct"), nil), true)
	noOperation(t, routes.Reconcile(0).Operation)

	addViewer(routes, B, 1, ms(1))
	join := must(t, routes.Reconcile(2).Operation)
	eq(t, join.ChildPeerID, B)
	eq(t, join.Reason, DemandJoin)
	commitCurrent(t, routes, 2, "b_from_host")
	retry := must(t, routes.Reconcile(4).Operation)
	eq(t, retry.ChildPeerID, A)
	eqSlice(t, tuples(retry), []CandidateTuple{peerTuple(B)})
	eq(t, hasTuple(retry, func(tuple CandidateTuple) bool { return isPeer(tuple) && tuple.ParentPeerID == HOST }), false)
}

// TS 4660: does not unblock an exhausted Viewer when its candidate set shrinks
func TestDoesNotUnblockExhaustedViewerWhenCandidateSetShrinks(t *testing.T) {
	routes := newController(1, Options{})
	addViewer(routes, A, 0, nil)
	routes.hydrateEdge(A, peerEdge(HOST, "failed_host"))
	eq(t, routes.InvalidateEdge(edgeGuard(A, "host_session", 0, "failed_host"), nil), true)
	noOperation(t, routes.Reconcile(0).Operation)

	addViewer(routes, B, 1, ms(1))
	routes.Reconcile(1)
	commitCurrent(t, routes, 2, "b_from_host")
	candidate := must(t, routes.Reconcile(3).Operation)
	attempt := beginOperation(t, routes, BeginInput{NowMs: 4, ConnectionID: "a_from_b", Reservation: direct()})
	eqSlice(t, routes.CandidateFailed(guardFor(A, attempt.Current.Revision, "a_from_b"), 5).FailedPeerIDs, []string{A})
	eq(t, len(candidate.Candidates), 1)

	eq(t, routes.DisconnectSession(B, sessionOf(B)), true)
	noOperation(t, routes.Reconcile(6).Operation)
}

// TS 4694: treats a replacement child session as a new exact opportunity
func TestTreatsReplacementChildSessionAsNewExactOpportunity(t *testing.T) {
	routes := newController(1, Options{})
	addViewer(routes, A, 0, nil)
	routes.hydrateEdge(A, peerEdge(HOST, "failed_host"))
	eq(t, routes.InvalidateEdge(edgeGuard(A, "host_session", 0, "failed_host"), nil), true)
	noOperation(t, routes.Reconcile(0).Operation)

	routes.UpsertParticipant(viewerInput(A, "replacement_session", 0), nil)
	operation := must(t, routes.Reconcile(1).Operation)
	eq(t, operation.ChildPeerID, A)
	eq(t, operation.ChildSessionID, "replacement_session")
	eqSlice(t, tuples(operation), []CandidateTuple{peerTuple(HOST)})
}

// TS 4724: does not retry a failed bootstrap carrier when another carrier leaves
func TestDoesNotRetryFailedBootstrapCarrierWhenAnotherCarrierLeaves(t *testing.T) {
	routes := newController(2, Options{SfuEnabled: true})
	for _, seed := range [][2]string{{B, "b_from_host"}, {C, "c_from_host"}} {
		addViewer(routes, seed[0], 1, nil)
		routes.hydrateEdge(seed[0], peerEdge(HOST, seed[1]))
	}
	addViewer(routes, A, 0, ms(0))
	acquisition := must(t, routes.Reconcile(0).Operation)
	beginCandidate(t, routes, BeginInput{NowMs: 1, ConnectionID: "a_head_start", Reservation: direct()})
	routes.OperationExpired(acquisition.WakeAtMs)

	bootstrap := must(t, routes.Reconcile(acquisition.WakeAtMs+1).Operation)
	eq(t, bootstrap.Reason, DemandSfuBootstrap)
	failedCarrier := bootstrap.ChildPeerID
	otherCarrier := B
	if failedCarrier == B {
		otherCarrier = C
	}
	attempt := beginOperation(t, routes, BeginInput{
		NowMs:                   acquisition.WakeAtMs + 2,
		ConnectionID:            "failed_bootstrap",
		PublicationGeneration:   "failed_publication",
		PublicationConnectionID: "failed_publication_connection",
		Reservation:             sfuCreateOverlap("failed_subscription", "failed_publication_resource", "failed_overlap"),
	})
	eq(t, routes.CandidateFailed(guardFor(failedCarrier, attempt.Current.Revision, "failed_bootstrap"), acquisition.WakeAtMs+3).Accepted, true)

	eq(t, routes.DisconnectSession(otherCarrier, sessionOf(otherCarrier)), true)
	next := routes.Reconcile(acquisition.WakeAtMs + 4).Operation
	if next != nil && next.Reason == DemandSfuBootstrap && next.ChildPeerID == failedCarrier {
		t.Fatalf("retried the failed bootstrap carrier %q", failedCarrier)
	}
}

// TS 4775: does not bootstrap a new SFU generation after the last reuse opportunity expires
func TestDoesNotBootstrapNewSfuGenerationAfterLastReuseOpportunityExpires(t *testing.T) {
	routes, nowMs := retireLastSfuPublicationAfterReuseDeadline(t)

	reconciled := routes.Reconcile(nowMs)
	noOperation(t, reconciled.Operation)
	eqSlice(t, reconciled.FailedPeerIDs, []string{})
}

// TS 4783: reopens the exhausted SFU opportunity for a new %s authority
func TestReopensExhaustedSfuOpportunityForNewAuthority(t *testing.T) {
	for _, authority := range []string{"child-session", "host-session", "external-resource"} {
		t.Run(authority, func(t *testing.T) {
			routes, nowMs := retireLastSfuPublicationAfterReuseDeadline(t)
			switch authority {
			case "child-session":
				routes.UpsertParticipant(viewerInput(A, "replacement_child_session", 0), nil)
			case "host-session":
				routes.UpsertParticipant(hostInput("replacement_host_session", 2), nil)
			default:
				routes.TouchExternalFacts()
			}

			operation := must(t, routes.Reconcile(nowMs).Operation)
			eq(t, operation.DemandPeerID, A)
			eq(t, operation.Reason, DemandSfuBootstrap)
			eqSlice(t, tuples(operation), []CandidateTuple{sfuTuple(PublicationCreate)})
		})
	}
}

// TS 4817: consumes the canonical SFU opportunity when an active edge fails
func TestConsumesCanonicalSfuOpportunityWhenActiveEdgeFails(t *testing.T) {
	routes := invalidateActiveSfuEdge(t)

	// TS: `operation?.candidates.some(sfu)` toBe(false) needs an operation.
	operation := must(t, routes.Reconcile(0).Operation)
	eq(t, hasTuple(operation, isSfu), false)
}

// TS 4826: reopens an active-edge SFU opportunity for a new %s authority
func TestReopensActiveEdgeSfuOpportunityForNewAuthority(t *testing.T) {
	for _, authority := range []string{"child-session", "host-session", "external-resource"} {
		t.Run(authority, func(t *testing.T) {
			routes := invalidateActiveSfuEdge(t)
			switch authority {
			case "child-session":
				routes.UpsertParticipant(viewerInput(A, "active_edge_child_replacement", 0), nil)
			case "host-session":
				routes.UpsertParticipant(hostInput("active_edge_host_replacement", 1), nil)
			default:
				routes.TouchExternalFacts()
			}

			operation := must(t, routes.Reconcile(0).Operation)
			eq(t, hasTuple(operation, func(tuple CandidateTuple) bool {
				return isSfu(tuple) && tuple.Publication == PublicationReuse
			}), true)
		})
	}
}

// TS 4860: does not turn a failed same-rank SFU replace into a create retry
func TestDoesNotTurnFailedSameRankSfuReplaceIntoCreateRetry(t *testing.T) {
	routes := newController(2, Options{SfuEnabled: true})
	routes.hydrateHostPublication("failed_publication", res("failed_publication_resource"), "")
	eq(t, routes.InvalidateHostPublication(PublicationGuard{
		HostSessionID: "host_session",
		RouteRevision: routes.Snapshot().Revision,
		Generation:    "failed_publication",
		ConnectionID:  "publication:failed_publication",
	}, nil), true)
	addViewer(routes, A, 0, nil)
	operation := must(t, routes.Reconcile(0).Operation)
	eq(t, operation.Candidates[0].Tuple.Kind, UpstreamPeer)
	skipCandidate(t, routes, 1)
	replaceCandidate := must(t, routes.Snapshot().Operation).Candidates[1]
	eq(t, replaceCandidate.Tuple, sfuTuple(PublicationReplace))
	expectTransition(t, replaceCandidate.EndpointTransition, TransitionNone, HOST)
	replace := beginOperation(t, routes, BeginInput{
		NowMs:                   2,
		ConnectionID:            "failed_replace",
		PublicationGeneration:   "replacement_publication",
		PublicationConnectionID: "replacement_ingress",
		Reservation:             sfuCreate("replacement_subscription", "replacement_publication_resource"),
	})
	eqSlice(t, routes.CandidateFailed(guardFor(A, replace.Current.Revision, "failed_replace"), 3).FailedPeerIDs, []string{A})

	addViewer(routes, B, 0, nil)
	eq(t, routes.ConfirmDeparture(B, nil), true)
	reconciled := routes.Reconcile(4)
	if routes.Snapshot().HostPublication != nil {
		t.Fatal("expected no host publication")
	}
	noOperation(t, reconciled.Operation)
	eqSlice(t, reconciled.FailedPeerIDs, []string{})
}

// TS 4913: reopens only SFU opportunities for a new external fact
func TestReopensOnlySfuOpportunitiesForNewExternalFact(t *testing.T) {
	routes := newController(1, Options{SfuEnabled: true})
	addViewer(routes, A, 0, ms(0))
	routes.Reconcile(0)
	directAttempt := beginOperation(t, routes, BeginInput{NowMs: 1, ConnectionID: "failed_direct", Reservation: direct()})
	eq(t, routes.CandidateFailed(guardFor(A, directAttempt.Current.Revision, "failed_direct"), 2).Accepted, true)
	sfuAttempt := beginOperation(t, routes, BeginInput{
		NowMs:                   3,
		ConnectionID:            "failed_sfu",
		PublicationGeneration:   "failed_publication",
		PublicationConnectionID: "failed_publication_connection",
		Reservation:             sfuCreate("failed_subscription", "failed_publication_resource"),
	})
	eq(t, routes.CandidateFailed(guardFor(A, sfuAttempt.Current.Revision, "failed_sfu"), 4).Accepted, true)
	noOperation(t, routes.Snapshot().Operation)
	noOperation(t, routes.Reconcile(5).Operation)

	routes.TouchExternalFacts()
	retried := must(t, routes.Reconcile(6).Operation)
	eq(t, len(retried.Candidates), 1)
	eq(t, retried.Candidates[0].Tuple, sfuTuple(PublicationCreate))
	expectTransition(t, retried.Candidates[0].EndpointTransition, TransitionNone, HOST)
	eq(t, hasTuple(retried, isPeer), false)
}

// TS 4963: fails all waiting demands without cutting capacity-three Host children
func TestFailsAllWaitingDemandsWithoutCuttingCapacityThreeHostChildren(t *testing.T) {
	routes := newController(3, Options{SfuEnabled: true})
	seeds := [][2]string{{A, "a_direct"}, {B, "b_direct"}, {C, "c_direct"}}
	for _, seed := range seeds {
		addViewer(routes, seed[0], 0, nil)
		routes.hydrateEdge(seed[0], peerEdge(HOST, seed[1]))
	}
	addViewer(routes, D, 0, nil)
	addViewer(routes, E, 0, nil)
	reconciled := routes.Reconcile(0)
	noOperation(t, reconciled.Operation)
	eqSlice(t, reconciled.FailedPeerIDs, []string{D, E})
	for _, seed := range seeds {
		edge := edgeOf(t, routes, seed[0])
		eq(t, edge.ConnectionID, seed[1])
		eq(t, edge.Usable, true)
		eq(t, edge.PhysicalActive, true)
	}
}

// TS 4991: does not promote when synchronous admission commit fails
func TestDoesNotPromoteWhenSynchronousAdmissionCommitFails(t *testing.T) {
	routes := newController(1, Options{})
	addViewer(routes, A, 0, nil)
	operation := must(t, routes.Reconcile(0).Operation)
	prepared := beginOperation(t, routes, BeginInput{NowMs: 1, ConnectionID: "candidate_connection", Reservation: direct()})
	settled := routes.CandidateReady(CandidateGuard{
		ChildPeerID:    operation.ChildPeerID,
		ChildSessionID: operation.ChildSessionID,
		Revision:       prepared.Current.Revision,
		ConnectionID:   "candidate_connection",
	}, 2, func(CandidateReservation) bool { return false }, CandidateProof{})
	eq(t, settled.Accepted, false)
	if settled.ActiveRevision <= prepared.Current.Revision {
		t.Fatalf("activeRevision %d did not advance past %d", settled.ActiveRevision, prepared.Current.Revision)
	}
	eq(t, hasEdge(routes, A), false)
}

// --- describe("bounded NAT candidate acquisition") -------------------------

func TestRunsFourRealGenerationsThenExhaustsUntilNewSession(t *testing.T) {
	for _, failure := range []string{"failed", "timeout"} {
		t.Run(failure, func(t *testing.T) {
			routes := newController(2, Options{NatPredictionEnabled: true, OperationTimeoutMs: 20_000})
			addViewer(routes, A, 0, nil)
			nowMs := int64(0)
			var previous *CandidateGuard
			for attempt := 1; attempt <= 4; attempt++ {
				operation, prepared, guard := preparePeer(t, routes, nowMs, fmt.Sprintf("nat_%d", attempt))
				eqDeep(t, prepared.Current.ConnectionAttempt, &ConnectionAttemptProgress{Current: attempt, Total: 4})
				eq(t, operation.DeadlineAtMs-nowMs, 20_000)
				eq(t, prepared.WakeAtMs, operation.DeadlineAtMs)
				if previous != nil {
					eq(t, routes.CandidateFailed(*previous, nowMs).Accepted, false)
				}
				eq(t, must(t, routes.Snapshot().Operation).Current.ConnectionID, fmt.Sprintf("nat_%d", attempt))
				var result SettleResult
				if failure == "timeout" {
					nowMs = operation.DeadlineAtMs
					result = routes.OperationExpired(nowMs)
				} else {
					nowMs++
					result = routes.CandidateFailed(guard, nowMs)
				}
				if attempt == 4 {
					eqSlice(t, result.FailedPeerIDs, []string{A})
				} else {
					eqSlice(t, result.FailedPeerIDs, []string{})
				}
				eq(t, routes.CandidateFailed(guard, nowMs).Accepted, false)
				previous = &guard
				nowMs++
			}
			noOperation(t, routes.Reconcile(nowMs).Operation)
			routes.UpsertParticipant(viewerInput(A, "replacement_session", 0), ms(nowMs))
			_, prepared, guard := preparePeer(t, routes, nowMs+1, "new_session")
			eq(t, attemptCurrent(t, prepared), 1)
			eq(t, routes.CandidateReady(guard, nowMs+2, nil, CandidateProof{}).Committed, true)
		})
	}
}

// TS 5067: gives waiting viewers their first opportunity before another viewer retries
func TestGivesWaitingViewersFirstOpportunityBeforeAnotherViewerRetries(t *testing.T) {
	routes := newController(2, Options{NatPredictionEnabled: true})
	addViewer(routes, A, 0, nil)
	addViewer(routes, B, 0, nil)
	for index, childPeerID := range []string{A, B, A, B, A, B, A, B} {
		_, prepared, guard := preparePeer(t, routes, int64(index*2), fmt.Sprintf("fair_%d", index))
		eq(t, prepared.ChildPeerID, childPeerID)
		eq(t, attemptCurrent(t, prepared), index/2+1)
		routes.CandidateFailed(guard, int64(index*2+1))
	}
	noOperation(t, routes.Reconcile(20).Operation)
}

// TS 5080: tries a newly usable parent before spending another attempt on an old parent
func TestTriesNewlyUsableParentBeforeSpendingAnotherAttemptOnOldParent(t *testing.T) {
	routes := newController(2, Options{NatPredictionEnabled: true})
	addViewer(routes, B, 2, nil)
	routes.hydrateEdge(B, peerEdge(HOST, "existing_b"))
	addViewer(routes, A, 0, nil)
	_, firstPrepared, firstGuard := preparePeer(t, routes, 0, "first_host")
	eq(t, firstPrepared.Current.Tuple.ParentPeerID, HOST)
	routes.CandidateFailed(firstGuard, 1)
	_, secondPrepared, secondGuard := preparePeer(t, routes, 2, "first_b")
	eq(t, secondPrepared.Current.Tuple.ParentPeerID, B)
	routes.CandidateFailed(secondGuard, 3)
	addViewer(routes, C, 2, ms(4))
	routes.hydrateEdge(C, peerEdge(HOST, "existing_c"))
	_, thirdPrepared, _ := preparePeer(t, routes, 5, "first_c")
	eq(t, thirdPrepared.Current.Tuple.ParentPeerID, C)
	eq(t, attemptCurrent(t, thirdPrepared), 1)
}

// TS 5098: keeps SFU's foreground timing and shares the attempt budget with round-robin direct continuations
func TestKeepsSfuForegroundTimingAndSharesAttemptBudgetWithDirectContinuations(t *testing.T) {
	routes := newController(2, Options{NatPredictionEnabled: true, SfuEnabled: true, OperationTimeoutMs: 20_000})
	nowMs := int64(0)
	for _, childPeerID := range []string{A, B} {
		addViewer(routes, childPeerID, 0, ms(nowMs))
		_, directPrepared, _ := preparePeer(t, routes, nowMs, childPeerID+"_first")
		eq(t, directPrepared.WakeAtMs, nowMs+5_000)
		nowMs += 5_000
		eqSlice(t, routes.OperationExpired(nowMs).FailedPeerIDs, []string{})
		reservation := sfuReuse("subscription_b")
		if childPeerID == A {
			reservation = sfuCreate("subscription_a", "publication")
		}
		sfu := beginOperation(t, routes, BeginInput{
			NowMs:                   nowMs,
			ConnectionID:            childPeerID + "_sfu",
			PublicationGeneration:   "sfu_generation",
			PublicationConnectionID: "sfu_publisher",
			Reservation:             reservation,
		})
		if sfu.Current.ConnectionAttempt != nil {
			t.Fatal("SFU attempts carry no NAT connection attempt")
		}
		nowMs++
		routes.CandidateReady(CandidateGuard{
			ChildPeerID:    childPeerID,
			ChildSessionID: sfu.ChildSessionID,
			Revision:       sfu.Current.Revision,
			ConnectionID:   childPeerID + "_sfu",
		}, nowMs, nil, CandidateProof{})
		nowMs++
	}
	for index, childPeerID := range []string{A, B, A, B, A, B} {
		_, retry, guard := preparePeer(t, routes, nowMs, fmt.Sprintf("background_%d", index))
		eq(t, retry.ChildPeerID, childPeerID)
		eq(t, retry.Reason, DemandDirectConvergence)
		eqDeep(t, retry.Current.ConnectionAttempt, &ConnectionAttemptProgress{Current: index/2 + 2, Total: 4})
		eq(t, retry.WakeAtMs-nowMs, 20_000)
		nowMs++
		eqSlice(t, routes.CandidateFailed(guard, nowMs).FailedPeerIDs, []string{})
		edge := edgeOf(t, routes, childPeerID)
		eq(t, edge.Kind, UpstreamSfu)
		eq(t, edge.Usable, true)
		nowMs++
	}
	noOperation(t, routes.Reconcile(nowMs).Operation)
}

// TS 5139: does not retry without NAT policy or when no candidate was created
func TestDoesNotRetryWithoutNatPolicyOrWhenNoCandidateWasCreated(t *testing.T) {
	ordinary := newController(2, Options{})
	addViewer(ordinary, A, 0, nil)
	_, firstPrepared, firstGuard := preparePeer(t, ordinary, 0, "ordinary")
	if firstPrepared.Current.ConnectionAttempt != nil {
		t.Fatal("expected no connection attempt without NAT prediction")
	}
	eqSlice(t, ordinary.CandidateFailed(firstGuard, 1).FailedPeerIDs, []string{A})
	noOperation(t, ordinary.Reconcile(2).Operation)

	routes := newController(2, Options{NatPredictionEnabled: true})
	addViewer(routes, A, 0, nil)
	operation := must(t, routes.Reconcile(0).Operation)
	routes.SkipCurrentCandidate(cursorGuard(operation), 1, RejectionCandidateFailed)
	noOperation(t, routes.Reconcile(2).Operation)
}
