package route

// Test harness ported one-to-one from tests/room-route-controller.test.ts
// (lines 14-356 and preparePeer at 5017). TS resources were plain strings;
// here every resource is a distinct *Resource carrying the TS string as
// Label, and released slices are compared by label in order.

import (
	"fmt"
	"reflect"
	"slices"
	"strings"
	"testing"

	"zviewer/backend/internal/piik/server/protocol"
)

const (
	HOST = "host_12345678"
	A    = "viewer_a_12345678"
	B    = "viewer_b_12345678"
	C    = "viewer_c_12345678"
	D    = "viewer_d_12345678"
	E    = "viewer_e_12345678"
	F    = "viewer_f_12345678"
)

// ms is the optional nowMs argument (TS: an omitted parameter is nil here).
func ms(v int64) *int64 { return &v }

func optInt(v int64) *protocol.Int {
	value := protocol.Int(v)
	return &value
}

func optNum(v float64) *protocol.Num {
	value := protocol.Num(v)
	return &value
}

// resourceLabels names the resources these tests create. The label lives here,
// not on Resource, because the controller compares resources by pointer
// identity only (TS: the tests instantiated the type parameter with a string).
// No test in this package calls t.Parallel(), so the map needs no lock.
var resourceLabels = map[*Resource]string{}

// res makes a fresh labelled resource (TS: a plain string).
func res(label string) *Resource {
	resource := &Resource{}
	resourceLabels[resource] = label
	return resource
}

func labels(resources []*Resource) []string {
	out := make([]string, 0, len(resources))
	for _, resource := range resources {
		out = append(out, resourceLabels[resource])
	}
	return out
}

func sessionOf(peerID string) string { return peerID + "_session" }

func parentSession(parentPeerID string) string {
	if parentPeerID == HOST {
		return "host_session"
	}
	return sessionOf(parentPeerID)
}

// newController ports controller(capacity, options): OperationTimeoutMs
// defaults to 10_000 and the Host is upserted at the same capacity.
func newController(capacity int, options Options) *Controller {
	options.HostPeerID = HOST
	options.EndpointMediaCopyCapacity = capacity
	if options.OperationTimeoutMs == 0 {
		options.OperationTimeoutMs = 10_000
	}
	routes := New(options)
	routes.UpsertParticipant(ParticipantInput{
		PeerID:                      HOST,
		Role:                        protocol.RoleHost,
		SessionID:                   "host_session",
		EffectiveDownstreamCapacity: capacity,
	}, nil)
	return routes
}

func addViewer(routes *Controller, peerID string, capacity int, nowMs *int64) {
	routes.UpsertParticipant(ParticipantInput{
		PeerID:                      peerID,
		Role:                        protocol.RoleViewer,
		SessionID:                   sessionOf(peerID),
		EffectiveDownstreamCapacity: capacity,
	}, nowMs)
}

func viewerInput(peerID, sessionID string, capacity int) ParticipantInput {
	return ParticipantInput{
		PeerID:                      peerID,
		Role:                        protocol.RoleViewer,
		SessionID:                   sessionID,
		EffectiveDownstreamCapacity: capacity,
	}
}

func hostInput(sessionID string, capacity int) ParticipantInput {
	return ParticipantInput{
		PeerID:                      HOST,
		Role:                        protocol.RoleHost,
		SessionID:                   sessionID,
		EffectiveDownstreamCapacity: capacity,
	}
}

func cursorGuard(operation *OperationSnapshot) CandidateCursorGuard {
	return CandidateCursorGuard{
		ChildPeerID:    operation.ChildPeerID,
		ChildSessionID: operation.ChildSessionID,
		BaseRevision:   operation.BaseRevision,
		FactVersion:    operation.FactVersion,
		Cursor:         operation.Cursor,
		Plan:           operation.Candidates[operation.Cursor],
	}
}

// must ports the TS non-null assertion `operation!`.
func must(t *testing.T, operation *OperationSnapshot) *OperationSnapshot {
	t.Helper()
	if operation == nil {
		t.Fatal("expected an operation")
	}
	return operation
}

// noOperation ports `expect(operation).toBeUndefined()`.
func noOperation(t *testing.T, operation *OperationSnapshot) {
	t.Helper()
	if operation != nil {
		t.Fatalf("expected no operation, got child %q reason %q", operation.ChildPeerID, operation.Reason)
	}
}

// beginCandidate ports beginCandidate(routes, input): the guard is derived
// from the current operation and non-direct reservations default the Host
// session to "host_session".
func beginCandidate(t *testing.T, routes *Controller, input BeginInput) BeginResult {
	t.Helper()
	input.Guard = cursorGuard(must(t, routes.Snapshot().Operation))
	if input.Reservation.Kind != ReservationDirect && input.HostSessionID == "" {
		input.HostSessionID = "host_session"
	}
	return routes.BeginCurrentCandidate(input)
}

// beginOperation ports `beginCandidate(...).operation!`.
func beginOperation(t *testing.T, routes *Controller, input BeginInput) *OperationSnapshot {
	t.Helper()
	return must(t, beginCandidate(t, routes, input).Operation)
}

func skipCandidate(t *testing.T, routes *Controller, nowMs int64) BeginResult {
	t.Helper()
	return routes.SkipCurrentCandidate(cursorGuard(must(t, routes.Snapshot().Operation)), nowMs, RejectionStale)
}

func commitCurrent(t *testing.T, routes *Controller, nowMs int64, connectionID string) CandidateGuard {
	t.Helper()
	prepared := beginOperation(t, routes, BeginInput{NowMs: nowMs, ConnectionID: connectionID, Reservation: direct()})
	guard := CandidateGuard{
		ChildPeerID:    prepared.ChildPeerID,
		ChildSessionID: prepared.ChildSessionID,
		Revision:       prepared.Current.Revision,
		ConnectionID:   connectionID,
	}
	eq(t, routes.CandidateReady(guard, nowMs+1, nil, CandidateProof{}).Accepted, true)
	return guard
}

// guardFor is the literal `{childPeerId, childSessionId: `${id}_session`, revision, connectionId}` the tests build.
func guardFor(peerID string, revision int64, connectionID string) CandidateGuard {
	return CandidateGuard{ChildPeerID: peerID, ChildSessionID: sessionOf(peerID), Revision: revision, ConnectionID: connectionID}
}

func edgeGuard(childPeerID, parentSessionID string, revision int64, connectionID string) EdgeGuard {
	return EdgeGuard{
		ChildPeerID:     childPeerID,
		ChildSessionID:  sessionOf(childPeerID),
		ParentSessionID: parentSessionID,
		RouteRevision:   revision,
		ConnectionID:    connectionID,
	}
}

func direct() CandidateReservation { return CandidateReservation{Kind: ReservationDirect} }

func directOverlap(overlap string) CandidateReservation {
	return CandidateReservation{Kind: ReservationDirect, Overlap: res(overlap)}
}

func sfuReuse(edge string) CandidateReservation {
	return CandidateReservation{Kind: ReservationSfuReuse, Edge: res(edge)}
}

func sfuCreate(edge, publication string) CandidateReservation {
	return CandidateReservation{Kind: ReservationSfuCreate, Edge: res(edge), Publication: res(publication)}
}

func sfuCreateOverlap(edge, publication, overlap string) CandidateReservation {
	reservation := sfuCreate(edge, publication)
	reservation.Overlap = res(overlap)
	return reservation
}

type committedEdgeSeed struct {
	Kind                  UpstreamKind
	ParentPeerID          string
	PublicationGeneration string
	Transport             Transport
	ConnectionID          string
	Usable                bool
	PhysicalActive        bool
	Resource              *Resource
}

func (c *Controller) hydrateEdge(childPeerID string, edge committedEdgeSeed) {
	if c.operation != nil {
		panic("Cannot hydrate while an operation is active")
	}
	c.assertViewer(childPeerID)
	child, _ := c.participants.Get(childPeerID)
	if child.sessionID == "" {
		panic("Route child has no current session")
	}
	committed := &CommittedEdge{
		Kind:                  edge.Kind,
		ChildSessionID:        child.sessionID,
		ParentPeerID:          edge.ParentPeerID,
		PublicationGeneration: edge.PublicationGeneration,
		Transport:             edge.Transport,
		ConnectionID:          edge.ConnectionID,
		Usable:                edge.Usable,
		PhysicalActive:        edge.PhysicalActive,
		Resource:              edge.Resource,
		opportunityKey: c.candidateOpportunityBase(childPeerID, CandidatePlan{
			Tuple: CandidateTuple{Kind: edge.Kind, ParentPeerID: edge.ParentPeerID},
		}),
	}
	if edge.Kind == UpstreamPeer {
		if parent, ok := c.participants.Get(edge.ParentPeerID); ok {
			committed.ParentSessionID = parent.sessionID
		}
	}
	c.upstreamByViewer.Set(childPeerID, committed)
	c.requireSenderQualityBaseline(childPeerID, false)
	c.assertGraph()
}

func (c *Controller) hydrateHostPublication(generation string, resource *Resource, connectionID string) {
	if c.operation != nil {
		panic("Cannot hydrate while an operation is active")
	}
	host, _ := c.participants.Get(c.hostPeerID)
	if host == nil || host.sessionID == "" {
		panic("Route Host has no current session")
	}
	if connectionID == "" {
		connectionID = "publication:" + generation
	}
	c.hostPublication = &HostPublication{
		Generation:     generation,
		HostSessionID:  host.sessionID,
		ConnectionID:   connectionID,
		Usable:         true,
		PhysicalActive: true,
		Resource:       resource,
	}
	c.assertGraph()
}

func peerEdge(parentPeerID, connectionID string) committedEdgeSeed {
	return committedEdgeSeed{
		Kind:           UpstreamPeer,
		ParentPeerID:   parentPeerID,
		Transport:      TransportDirect,
		ConnectionID:   connectionID,
		Usable:         true,
		PhysicalActive: true,
	}
}

func sfuEdge(generation, connectionID, resource string) committedEdgeSeed {
	return committedEdgeSeed{
		Kind:                  UpstreamSfu,
		PublicationGeneration: generation,
		Transport:             TransportSfu,
		ConnectionID:          connectionID,
		Usable:                true,
		PhysicalActive:        true,
		Resource:              res(resource),
	}
}

func peerTuple(parentPeerID string) CandidateTuple {
	return CandidateTuple{Kind: UpstreamPeer, ParentPeerID: parentPeerID, Transport: TransportDirect}
}

func regenerateTuple(parentPeerID string) CandidateTuple {
	tuple := peerTuple(parentPeerID)
	tuple.Regenerate = true
	return tuple
}

func sfuTuple(publication PublicationPlan) CandidateTuple {
	return CandidateTuple{Kind: UpstreamSfu, Publication: publication}
}

func tuples(operation *OperationSnapshot) []CandidateTuple {
	return tuplesFrom(operation, 0)
}

func tuplesFrom(operation *OperationSnapshot, from int) []CandidateTuple {
	out := make([]CandidateTuple, 0, len(operation.Candidates))
	for _, candidate := range operation.Candidates[from:] {
		out = append(out, candidate.Tuple)
	}
	return out
}

// tupleKinds ports `operation.candidates.map((candidate) => candidate.tuple.kind)`.
func tupleKinds(operation *OperationSnapshot) []UpstreamKind {
	out := make([]UpstreamKind, 0, len(operation.Candidates))
	for _, candidate := range operation.Candidates {
		out = append(out, candidate.Tuple.Kind)
	}
	return out
}

func hasTuple(operation *OperationSnapshot, match func(CandidateTuple) bool) bool {
	return slices.ContainsFunc(tuples(operation), match)
}

func isSfu(tuple CandidateTuple) bool  { return tuple.Kind == UpstreamSfu }
func isPeer(tuple CandidateTuple) bool { return tuple.Kind == UpstreamPeer }

// edgeOf ports `routes.snapshot().upstreamByViewer.get(peerId)` where the
// test dereferences the edge.
func edgeOf(t *testing.T, routes *Controller, peerID string) CommittedEdge {
	t.Helper()
	edge, ok := routes.Snapshot().UpstreamByViewer.Get(peerID)
	if !ok {
		t.Fatalf("expected an upstream edge for %q", peerID)
	}
	return edge
}

func hasEdge(routes *Controller, peerID string) bool {
	return routes.Snapshot().UpstreamByViewer.Has(peerID)
}

func retireLastSfuPublicationAfterReuseDeadline(t *testing.T) (*Controller, int64) {
	t.Helper()
	routes := newController(2, Options{SfuEnabled: true})
	for _, seed := range [][2]string{{B, "b_from_host"}, {C, "c_from_host"}} {
		addViewer(routes, seed[0], 0, nil)
		routes.hydrateEdge(seed[0], peerEdge(HOST, seed[1]))
	}
	addViewer(routes, A, 0, ms(0))

	bootstrap := must(t, routes.Reconcile(0).Operation)
	eq(t, bootstrap.DemandPeerID, A)
	eq(t, bootstrap.Reason, DemandSfuBootstrap)
	eqSlice(t, tuples(bootstrap), []CandidateTuple{sfuTuple(PublicationCreate)})
	carrierPeerID := bootstrap.ChildPeerID
	carrier := beginOperation(t, routes, BeginInput{
		NowMs:                   1,
		ConnectionID:            "carrier_sfu",
		PublicationGeneration:   "publication_generation",
		PublicationConnectionID: "publication_connection",
		Reservation:             sfuCreateOverlap("carrier_subscription", "publication_resource", "publication_overlap"),
	})
	eq(t, routes.CandidateReady(CandidateGuard{
		ChildPeerID:    carrier.ChildPeerID,
		ChildSessionID: carrier.ChildSessionID,
		Revision:       carrier.Current.Revision,
		ConnectionID:   "carrier_sfu",
	}, 2, nil, CandidateProof{}).Accepted, true)

	demand := must(t, routes.Reconcile(3).Operation)
	eq(t, demand.ChildPeerID, A)
	eq(t, demand.DemandPeerID, A)
	eqSlice(t, tuples(demand), []CandidateTuple{sfuTuple(PublicationReuse)})
	beginCandidate(t, routes, BeginInput{NowMs: 4, ConnectionID: "demand_sfu_reuse", Reservation: sfuReuse("demand_subscription")})
	eqSlice(t, routes.OperationExpired(demand.DeadlineAtMs).FailedPeerIDs, []string{A})

	convergence := must(t, routes.Reconcile(demand.DeadlineAtMs+1).Operation)
	eq(t, convergence.ChildPeerID, carrierPeerID)
	eq(t, convergence.Reason, DemandDirectConvergence)
	eqSlice(t, tuples(convergence), []CandidateTuple{peerTuple(HOST)})
	directOp := beginOperation(t, routes, BeginInput{
		NowMs:        demand.DeadlineAtMs + 2,
		ConnectionID: "carrier_direct",
		Reservation:  directOverlap("carrier_direct_overlap"),
	})
	committed := routes.CandidateReady(CandidateGuard{
		ChildPeerID:    directOp.ChildPeerID,
		ChildSessionID: directOp.ChildSessionID,
		Revision:       directOp.Current.Revision,
		ConnectionID:   "carrier_direct",
	}, demand.DeadlineAtMs+3, nil, CandidateProof{})
	eq(t, committed.Accepted, true)
	containsLabels(t, committed.Released, "carrier_subscription", "publication_resource")
	if routes.Snapshot().HostPublication != nil {
		t.Fatal("expected no host publication")
	}
	return routes, demand.DeadlineAtMs + 4
}

func invalidateActiveSfuEdge(t *testing.T) *Controller {
	t.Helper()
	routes := newController(1, Options{SfuEnabled: true})
	addViewer(routes, A, 0, nil)
	routes.hydrateHostPublication("active_publication", res("publication_resource"), "")
	routes.hydrateEdge(A, sfuEdge("active_publication", "active_sfu_edge", "active_subscription"))
	eq(t, routes.InvalidateEdge(edgeGuard(A, "", routes.Snapshot().Revision, "active_sfu_edge"), nil), true)
	return routes
}

type senderState struct {
	childPeerID    string
	connectionID   string
	state          SenderQualityState
	acceptedAtMs   int64
	parentPeerID   string // default HOST
	senderIdentity string // default "<connectionId>-rtp\x00track"
}

func observeSenderState(routes *Controller, input senderState) SenderQualityEvidenceResult {
	parentPeerID := input.parentPeerID
	if parentPeerID == "" {
		parentPeerID = HOST
	}
	identity := input.senderIdentity
	if identity == "" {
		identity = input.connectionID + "-rtp\x00track"
	}
	return routes.ObserveSenderQualityEvidence(senderSample(
		parentPeerID, input.childPeerID, routes.Snapshot().Revision,
		input.connectionID, identity, input.state, input.acceptedAtMs), nil)
}

// senderSample is the explicit observeSenderQualityEvidence literal the tests
// build (sampleTimestampMs == acceptedAtMs).
func senderSample(parentPeerID, childPeerID string, revision int64, connectionID, identity string, state SenderQualityState, at int64) SenderQualityEvidenceInput {
	return SenderQualityEvidenceInput{
		ParentPeerID:      parentPeerID,
		ParentSessionID:   parentSession(parentPeerID),
		ChildPeerID:       childPeerID,
		RouteRevision:     revision,
		ConnectionID:      connectionID,
		SenderIdentity:    &identity,
		SampleTimestampMs: ms(at),
		State:             state,
		AcceptedAtMs:      at,
	}
}

// unknownSample is the `state: "unknown", senderIdentity: null, sampleTimestampMs: null` literal.
func unknownSample(parentPeerID, childPeerID string, revision int64, connectionID string, at int64) SenderQualityEvidenceInput {
	return SenderQualityEvidenceInput{
		ParentPeerID:    parentPeerID,
		ParentSessionID: parentSession(parentPeerID),
		ChildPeerID:     childPeerID,
		RouteRevision:   revision,
		ConnectionID:    connectionID,
		State:           SenderQualityUnknown,
		AcceptedAtMs:    at,
	}
}

func observePersistentDegraded(t *testing.T, routes *Controller, childPeerID, connectionID string, acceptedAtMs int64) {
	t.Helper()
	eq(t, observeSenderState(routes, senderState{
		childPeerID: childPeerID, connectionID: connectionID, state: SenderQualityHealthy, acceptedAtMs: acceptedAtMs,
	}).Accepted, true)
	for offset := int64(1); offset <= 3; offset++ {
		eq(t, observeSenderState(routes, senderState{
			childPeerID: childPeerID, connectionID: connectionID, state: SenderQualityDegraded, acceptedAtMs: acceptedAtMs + offset,
		}).Accepted, true)
	}
}

func publisherSample(generation string, revision int64, state SenderQualityState, at int64) SfuPublisherQualityEvidenceInput {
	return SfuPublisherQualityEvidenceInput{
		HostPeerID:            HOST,
		HostSessionID:         "host_session",
		PublicationGeneration: generation,
		RouteRevision:         revision,
		State:                 state,
		SampleTimestampMs:     ms(at),
		AcceptedAtMs:          at,
	}
}

func observePersistentSfuHealthy(t *testing.T, routes *Controller, generation string, revision, acceptedAtMs int64) SenderQualityEvidenceResult {
	t.Helper()
	var result SenderQualityEvidenceResult
	for offset := int64(0); offset < 3; offset++ {
		result = routes.ObserveSfuPublisherQualityEvidence(publisherSample(generation, revision, SenderQualityHealthy, acceptedAtMs+offset), nil)
		eq(t, result.Accepted, true)
	}
	return result
}

func qualityMetrics() protocol.ViewerQualityEvidenceMetrics {
	return protocol.ViewerQualityEvidenceMetrics{
		FramesDecodedDelta:    optInt(120),
		FreezeCountDelta:      optInt(1),
		FreezeDurationMsDelta: optNum(250),
		PauseCountDelta:       optInt(0),
		PauseDurationMsDelta:  optNum(0),
	}
}

func peerUpstream(peerID string) QualityUpstream {
	return QualityUpstream{Kind: UpstreamPeer, PeerID: peerID}
}

func sfuUpstream() QualityUpstream { return QualityUpstream{Kind: UpstreamSfu} }

func qualityWindow(childPeerID string, revision int64, connectionID string, upstream QualityUpstream, epoch, at int64, metrics protocol.ViewerQualityEvidenceMetrics) RouteQualityEvidenceInput {
	return RouteQualityEvidenceInput{
		ChildPeerID:       childPeerID,
		ChildSessionID:    sessionOf(childPeerID),
		RouteRevision:     revision,
		ConnectionID:      connectionID,
		Upstream:          upstream,
		PresentationEpoch: epoch,
		WindowMs:          2_000,
		Metrics:           metrics,
		AcceptedAtMs:      at,
	}
}

// preparePeer ports the describe("bounded NAT candidate acquisition") helper.
func preparePeer(t *testing.T, routes *Controller, nowMs int64, id string) (operation, prepared *OperationSnapshot, guard CandidateGuard) {
	t.Helper()
	operation = must(t, routes.Reconcile(nowMs).Operation)
	prepared = beginOperation(t, routes, BeginInput{NowMs: nowMs, ConnectionID: id, Reservation: direct()})
	guard = CandidateGuard{
		ChildPeerID:    prepared.ChildPeerID,
		ChildSessionID: prepared.ChildSessionID,
		Revision:       prepared.Current.Revision,
		ConnectionID:   id,
	}
	return operation, prepared, guard
}

func attemptCurrent(t *testing.T, operation *OperationSnapshot) int {
	t.Helper()
	if operation.Current == nil || operation.Current.ConnectionAttempt == nil {
		t.Fatal("expected a connection attempt")
	}
	return operation.Current.ConnectionAttempt.Current
}

// --- assertions -----------------------------------------------------------

func eq[T comparable](t *testing.T, got, want T) {
	t.Helper()
	if got != want {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func eqSlice[T comparable](t *testing.T, got, want []T) {
	t.Helper()
	if !slices.Equal(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func eqDeep(t *testing.T, got, want any) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

// eqLabels ports `expect(released).toEqual([...])`: exact labels in order.
func eqLabels(t *testing.T, got []*Resource, want ...string) {
	t.Helper()
	eqSlice(t, labels(got), want)
}

// containsLabels ports `expect(released).toEqual(expect.arrayContaining([...]))`.
func containsLabels(t *testing.T, got []*Resource, want ...string) {
	t.Helper()
	have := labels(got)
	for _, label := range want {
		if !slices.Contains(have, label) {
			t.Fatalf("released %v does not contain %q", have, label)
		}
	}
}

// expectTransition ports toEqual on an endpoint transition without retire;
// producer "" means the TS object omitted producerPeerId.
func expectTransition(t *testing.T, got EndpointTransition, kind TransitionKind, producer string) {
	t.Helper()
	eq(t, got.Kind, kind)
	switch {
	case producer == "" && got.ProducerPeerID != nil:
		t.Fatalf("expected no producer, got %q", *got.ProducerPeerID)
	case producer != "" && (got.ProducerPeerID == nil || *got.ProducerPeerID != producer):
		t.Fatalf("expected producer %q, got %v", producer, got.ProducerPeerID)
	}
	if kind != TransitionBoundedGap && got.Retire != nil {
		t.Fatalf("expected no retirement for %q transition", kind)
	}
}

func expectPanic(t *testing.T, want string, fn func()) {
	t.Helper()
	defer func() {
		t.Helper()
		recovered := recover()
		if recovered == nil {
			t.Fatalf("expected a panic containing %q", want)
		}
		if !strings.Contains(fmt.Sprint(recovered), want) {
			t.Fatalf("panic %v does not contain %q", recovered, want)
		}
	}()
	fn()
}
