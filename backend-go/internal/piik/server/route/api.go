package route

import (
	"zviewer/backend/internal/piik/server/ordered"
	"zviewer/backend/internal/piik/server/protocol"
)

// Resource is the caller-owned SFU/overlap allocation the controller stores,
// moves between collections and compares by pointer identity. The controller
// never reads its fields; the router owns their meaning and release.
type Resource struct {
	Kind ResourceKind
	// EndpointPeerID is set for ResourceOverlap.
	EndpointPeerID string
	// Fence fields (RoomID, ShareGeneration, PublicationGeneration) are set
	// for sfu-publication and sfu-subscription; ViewerPeerID only for the
	// subscription. All are opaque IDs.
	RoomID                string
	ShareGeneration       string
	PublicationGeneration string
	ViewerPeerID          string
	ConnectionID          string
	// Released is flipped by the router once the allocation is freed.
	Released bool
}

// ResourceKind identifies the allocation owned by the router.
type ResourceKind string

// Resource kinds.
const (
	ResourceOverlap         ResourceKind = "overlap"
	ResourceSfuSubscription ResourceKind = "sfu-subscription"
	ResourceSfuPublication  ResourceKind = "sfu-publication"
)

// UpstreamKind discriminates CandidateTuple, CommittedEdge, committedEdgeSeed
// and QualityUpstream.
type UpstreamKind string

// Upstream kinds.
const (
	UpstreamPeer UpstreamKind = "peer"
	UpstreamSfu  UpstreamKind = "sfu"
)

// Transport is the edge transport.
type Transport string

// Transports.
const (
	TransportDirect Transport = "direct"
	TransportSfu    Transport = "sfu"
)

// PublicationPlan is the SFU tuple action.
type PublicationPlan string

// Publication plans.
const (
	PublicationReuse   PublicationPlan = "reuse"
	PublicationCreate  PublicationPlan = "create"
	PublicationReplace PublicationPlan = "replace"
)

// ReservationKind discriminates CandidateReservation.
type ReservationKind string

// Reservation kinds.
const (
	ReservationDirect    ReservationKind = "direct"
	ReservationSfuReuse  ReservationKind = "sfu-reuse"
	ReservationSfuCreate ReservationKind = "sfu-create"
)

// RetirementKind discriminates EndpointRetirement.
type RetirementKind string

// Retirement kinds.
const (
	RetireEdge        RetirementKind = "edge"
	RetirePublication RetirementKind = "publication"
)

// TransitionKind discriminates EndpointTransition.
type TransitionKind string

// Transition kinds.
const (
	TransitionNone       TransitionKind = "none"
	TransitionOverlap    TransitionKind = "overlap"
	TransitionBoundedGap TransitionKind = "bounded-gap"
)

// SenderQualityState is the sender-side health sample state.
type SenderQualityState string

// Sender quality states.
const (
	SenderQualityUnknown  SenderQualityState = "unknown"
	SenderQualityHealthy  SenderQualityState = "healthy"
	SenderQualityDegraded SenderQualityState = "degraded"
)

// DemandReason mirrors protocol RouteDemandReason.
type DemandReason string

// Demand reasons.
const (
	DemandJoin               DemandReason = "join"
	DemandEdgeUnavailable    DemandReason = "edge-unavailable"
	DemandParentDeparted     DemandReason = "parent-departed"
	DemandCapacityReduction  DemandReason = "capacity-reduction"
	DemandSfuBootstrap       DemandReason = "sfu-bootstrap"
	DemandDirectConvergence  DemandReason = "direct-convergence"
	DemandQualityConvergence DemandReason = "quality-convergence"
	DemandRootConvergence    DemandReason = "root-convergence"
	DemandPublicationAttach  DemandReason = "publication-attach"
)

// FinalRoute mirrors protocol RouteDiagnosticFinalRoute.
type FinalRoute string

// Final routes.
const (
	FinalRouteDirect  FinalRoute = "direct"
	FinalRouteSfu     FinalRoute = "sfu"
	FinalRouteWaiting FinalRoute = "waiting"
	FinalRouteFailed  FinalRoute = "failed"
)

// RejectionBucket mirrors protocol RouteDiagnosticRejectionBucket.
type RejectionBucket string

// Rejection buckets.
const (
	RejectionNone              RejectionBucket = "none"
	RejectionStale             RejectionBucket = "stale"
	RejectionEndpointCapacity  RejectionBucket = "endpoint-capacity"
	RejectionSfuAdmission      RejectionBucket = "sfu-admission"
	RejectionCandidateFailed   RejectionBucket = "candidate-failed"
	RejectionFirstFrameTimeout RejectionBucket = "first-frame-timeout"
	RejectionOperationDeadline RejectionBucket = "operation-deadline"
	RejectionAborted           RejectionBucket = "aborted"
)

// RouteQualityEvidenceResult is the ObserveQualityEvidence outcome.
type RouteQualityEvidenceResult string

// Quality evidence outcomes.
const (
	QualityEvidenceRejected RouteQualityEvidenceResult = "rejected"
	QualityEvidenceAccepted RouteQualityEvidenceResult = "accepted"
	QualityEvidenceObserved RouteQualityEvidenceResult = "observed"
)

// CandidateTuple is one route candidate: a direct edge from ParentPeerID
// (Kind UpstreamPeer, Transport always TransportDirect, Regenerate = rebuild
// the same edge with a fresh connection) or an SFU edge (Kind UpstreamSfu,
// Publication set).
type CandidateTuple struct {
	Kind         UpstreamKind
	ParentPeerID string
	Transport    Transport
	Regenerate   bool
	Publication  PublicationPlan
}

// CandidateReservation is what the caller allocated before
// BeginCurrentCandidate. Edge/Publication are set per Kind
// (direct: neither; sfu-reuse: Edge, Borrowed when it is another holder's
// live subscription and must not be released; sfu-create: Edge and
// Publication). Overlap is optional for every kind.
type CandidateReservation struct {
	Kind        ReservationKind
	Edge        *Resource
	Publication *Resource
	Borrowed    bool
	Overlap     *Resource
}

// EndpointRetirement is the producer retirement a bounded-gap transition
// requires: an existing direct edge (RetireEdge: Child*/Parent*/Transport/
// ConnectionID) or the Host publication (RetirePublication: HostSessionID/
// Generation/ConnectionID).
type EndpointRetirement struct {
	Kind            RetirementKind
	ChildPeerID     string
	ChildSessionID  string
	ParentPeerID    string
	ParentSessionID string
	Transport       Transport
	ConnectionID    string
	HostSessionID   string
	Generation      string
}

// EndpointTransition says how the producer's copy budget absorbs the
// candidate. ProducerPeerID is nil only for TransitionNone on an sfu/reuse
// plan. Retire is set only for TransitionBoundedGap.
type EndpointTransition struct {
	Kind           TransitionKind
	ProducerPeerID *string
	Retire         *EndpointRetirement
}

// CandidatePlan is a tuple with its endpoint transition.
type CandidatePlan struct {
	Tuple              CandidateTuple
	EndpointTransition EndpointTransition
}

// CommittedEdge is a child's one upstream edge in the committed graph.
// Peer edges (Kind UpstreamPeer) set ParentPeerID/ParentSessionID and leave
// Resource nil; SFU edges (Kind UpstreamSfu) set PublicationGeneration and
// Resource.
type CommittedEdge struct {
	Kind                  UpstreamKind
	ChildSessionID        string
	ParentPeerID          string
	ParentSessionID       string
	PublicationGeneration string
	Transport             Transport
	ConnectionID          string
	Usable                bool
	PhysicalActive        bool
	// Video attachment belongs to a publication, independently of room transport.
	VideoGeneration   string
	VideoConnectionID string
	VideoReady        bool
	Resource          *Resource
	// The acquisition's session key stays fixed when signaling ownership rebinds.
	opportunityKey string
}

// HostPublication is the single live SFU ingress.
type HostPublication struct {
	Generation     string
	HostSessionID  string
	ConnectionID   string
	Usable         bool
	PhysicalActive bool
	Resource       *Resource
}

// ConnectionAttemptProgress is the NAT-prediction attempt counter
// (initial attempt plus retries; the controller owns Total).
type ConnectionAttemptProgress struct {
	Current int
	Total   int
}

// CurrentAttempt describes the operation's live candidate attempt.
// ConnectionAttempt is nil when the attempt has no NAT opportunity.
type CurrentAttempt struct {
	Tuple             CandidateTuple
	Revision          int64
	ConnectionID      string
	ConnectionAttempt *ConnectionAttemptProgress
}

// OperationSnapshot is a deep copy of the in-flight operation plus the
// derived WakeAtMs. Current is nil without a live attempt.
type OperationSnapshot struct {
	// VideoGeneration fences decoded-frame proof. AttachConnectionID names
	// the retained room edge only for DemandPublicationAttach.
	VideoGeneration    string
	AttachConnectionID string
	ChildPeerID        string
	ChildSessionID     string
	DemandPeerID       string
	Reason             DemandReason
	BaseRevision       int64
	FactVersion        int64
	Candidates         []CandidatePlan
	Cursor             int
	DeadlineAtMs       int64
	WakeAtMs           int64
	Current            *CurrentAttempt
}

// RouteSnapshot is the committed graph as the router reads it.
// UpstreamByViewer is a fresh insertion-ordered copy (child peerId -> edge);
// HostPublication is a shallow copy or nil; Operation is nil when idle.
type RouteSnapshot struct {
	RoomMedia        bool
	VideoGeneration  string
	VideoPaused      bool
	Revision         int64
	Paused           bool
	FactVersion      int64
	UpstreamByViewer *ordered.Map[string, CommittedEdge]
	HostPublication  *HostPublication
	Operation        *OperationSnapshot
}

// ReconcileResult is the scheduler outcome.
type ReconcileResult struct {
	Operation      *OperationSnapshot
	RemovedPeerIDs []string
	FailedPeerIDs  []string
	Released       []*Resource
}

// SettleResult is the outcome of candidate settlement or active replacement.
// Committed is true only when CandidateReady committed the attempt.
type SettleResult struct {
	Accepted       bool
	Committed      bool
	FailedPeerIDs  []string
	ActiveRevision int64
	Released       []*Resource
}

// SenderQualityEvidenceResult is the settlement outcome of sender-side evidence.
type SenderQualityEvidenceResult = SettleResult

// BeginResult is the outcome of the cursor-guarded candidate calls.
type BeginResult struct {
	Accepted      bool
	Operation     *OperationSnapshot
	FailedPeerIDs []string
	Released      []*Resource
}

// ParticipantInput describes a connected participant.
type ParticipantInput struct {
	PeerID                      string
	Role                        protocol.Role
	SessionID                   string
	EffectiveDownstreamCapacity int
	RoutePreference             protocol.ViewerRoutePreference
}

// EdgeGuard identifies one committed edge exactly. ParentSessionID is only
// compared for peer edges; callers pass the edge's own ParentSessionID for
// those and leave it empty for SFU edges.
type EdgeGuard struct {
	ChildPeerID     string
	ChildSessionID  string
	RouteRevision   int64
	ConnectionID    string
	ParentSessionID string
}

// ParentEdgeGuard identifies a direct edge from the parent's side.
type ParentEdgeGuard struct {
	ParentPeerID    string
	ParentSessionID string
	RouteRevision   int64
	ConnectionID    string
}

// PublicationGuard identifies the Host publication exactly.
type PublicationGuard struct {
	HostSessionID string
	RouteRevision int64
	Generation    string
	ConnectionID  string
}

// AdoptDirectConnectionInput is an EdgeGuard plus the replacement
// connection.
type AdoptDirectConnectionInput struct {
	EdgeGuard
	NewConnectionID string
}

// CandidateGuard identifies the live attempt exactly.
type CandidateGuard struct {
	ChildPeerID    string
	ChildSessionID string
	Revision       int64
	ConnectionID   string
}

// CandidateCursorGuard identifies one candidate slot of the current
// operation: it must still be at Cursor with an equal Plan, built at
// FactVersion on BaseRevision.
type CandidateCursorGuard struct {
	ChildPeerID    string
	ChildSessionID string
	BaseRevision   int64
	FactVersion    int64
	Cursor         int
	Plan           CandidatePlan
}

// BeginInput is the BeginCurrentCandidate input. PublicationGeneration and
// PublicationConnectionID are required for sfu create/replace tuples;
// HostSessionID is required for every SFU tuple.
type BeginInput struct {
	Guard                   CandidateCursorGuard
	NowMs                   int64
	ConnectionID            string
	Reservation             CandidateReservation
	PublicationGeneration   string
	PublicationConnectionID string
	HostSessionID           string
}

// CandidateProof carries the decoded publication identity in room-media mode
// and the Viewer's one-shot relative quality approval when required.
type CandidateProof struct {
	RelativeQualityApproved bool
	VideoGeneration         string
}

// QualityUpstream names the upstream a receiver-side window was measured
// on: PeerID is set only for UpstreamPeer.
type QualityUpstream struct {
	Kind   UpstreamKind
	PeerID string
}

// RouteQualityEvidenceInput is one receiver-side quality window. Only
// FramesDecodedDelta, FreezeCountDelta, FreezeDurationMsDelta,
// PauseCountDelta and PauseDurationMsDelta of Metrics are read.
type RouteQualityEvidenceInput struct {
	ChildPeerID       string
	ChildSessionID    string
	RouteRevision     int64
	ConnectionID      string
	Upstream          QualityUpstream
	PresentationEpoch int64
	WindowMs          int64
	Metrics           protocol.ViewerQualityEvidenceMetrics
	AcceptedAtMs      int64
}

// SenderQualityEvidenceInput is one sender-side health sample from a parent
// about one child. SenderIdentity and SampleTimestampMs are nullable.
type SenderQualityEvidenceInput struct {
	ParentPeerID      string
	ParentSessionID   string
	ChildPeerID       string
	RouteRevision     int64
	ConnectionID      string
	SenderIdentity    *string
	SampleTimestampMs *int64
	State             SenderQualityState
	AcceptedAtMs      int64
}

// SfuPublisherQualityEvidenceInput is one Host->SFU ingress health sample.
type SfuPublisherQualityEvidenceInput struct {
	HostPeerID            string
	HostSessionID         string
	PublicationGeneration string
	RouteRevision         int64
	State                 SenderQualityState
	SampleTimestampMs     *int64
	AcceptedAtMs          int64
}

// RevisionSequence belongs to the room, including across controller replacement.
// Its zero value is ready to use; the caller serializes access with controller calls.
type RevisionSequence struct {
	latest int64
}

// Options configures a Controller. DebugRoomID empty disables the sanitised
// route debug events.
type Options struct {
	HostPeerID  string
	DebugRoomID string
	// Revisions may be shared by successive controllers for the same room.
	// nil gives this controller its own sequence.
	Revisions *RevisionSequence
	// DebugLog receives sanitized route events. nil disables them; the effect
	// layer owns environment, logger and retention policy.
	DebugLog                  func(string, ...any)
	EndpointMediaCopyCapacity int
	OperationTimeoutMs        int64
	SfuEnabled                bool
	SfuOnly                   bool
	QualityConvergenceEnabled bool
	NatPredictionEnabled      bool
}

// Controller never locks: the caller holds signal.Server.mu around every call.
type Controller struct {
	// hostPeerID is its own mutable field because RebindHostIdentity
	// reassigns it; the other
	// options are copied once and never change.
	hostPeerID                string
	debugRoomID               string
	debugLog                  func(string, ...any)
	endpointMediaCopyCapacity int
	operationTimeoutMs        int64
	sfuEnabled                bool
	sfuOnly                   bool
	qualityConvergenceEnabled bool
	natPredictionEnabled      bool

	// Insertion order is load-bearing for participants, upstreamByViewer and
	// directContinuations; the opportunity ledgers and the
	// retiring set are ordered for the same delete-while-iterating semantics.
	participants                      ordered.Map[string, *participant]
	upstreamByViewer                  ordered.Map[string, *CommittedEdge]
	hostPublication                   *HostPublication
	operation                         *operation
	revision                          int64
	revisions                         *RevisionSequence
	factVersion                       int64
	nextJoinOrder                     int64
	paused                            bool
	roomMedia                         bool
	voiceListeners                    map[string]bool
	videoGeneration                   string
	videoPaused                       bool
	routeTimings                      map[string]*routeTimingRecord
	qualityObservations               map[string]*routeQualityObservation
	senderQualityObservations         map[string]*senderQualityObservation
	senderQualityBaselines            map[string]bool // tri-state: absent / false / true (read with comma-ok)
	senderQualityRegenerationBlocks   map[string]senderQualityIdentity
	sfuPublisherQualityObservation    *sfuPublisherQualityObservation
	qualityBaselinesPending           map[string]struct{}
	directContinuations               ordered.Map[string, *directContinuation]
	retiringPublicationGenerations    ordered.Map[string, struct{}]
	sfuBootstrapIntent                *sfuBootstrapIntent
	consumedSfuBootstrapOpportunities ordered.Map[string, int]
	rootConvergenceRootPeerID         string
}
