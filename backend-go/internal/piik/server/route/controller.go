package route

import (
	"crypto/sha256"
	"errors"
	"math"
	"sort"
	"strings"

	"zviewer/backend/internal/piik/server/ordered"
	"zviewer/backend/internal/piik/server/protocol"
)

const (
	maxDirectHeadStartMs      int64 = 5_000
	maxNatConnectionAttempts        = 4
	sfuOpportunityPrefix            = "sfu\x00"
	maxSafeInteger            int64 = protocol.MaxSafeInteger
	qualityEvidenceExpiryMs   int64 = protocol.ViewerQualityEvidenceExpiryMs
	persistentDegradedWindows       = int64(protocol.PersistentNativeEdgeDegradedWindows)
)

// candidateOpportunity records the attempts consumed at one candidate rank.
type candidateOpportunity struct {
	rank            int
	startedAttempts int
	exhausted       bool
}

// participant is a known peer. An empty sessionID means disconnected but in
// grace, or departed; validated wire IDs never name a live session with "".
type participant struct {
	peerID                         string
	role                           protocol.Role
	sessionID                      string
	departureConfirmed             bool
	joinOrder                      int64
	effectiveDownstreamCapacity    int
	reportedDownstreamCapacity     int
	relayVolunteer                 bool
	availabilityExhausted          bool
	consumedCandidateOpportunities ordered.Map[string, candidateOpportunity]
	bootstrapFailureReported       bool
	sfuFirstAtNextRoute            bool
	routePreference                protocol.ViewerRoutePreference
}

// sessionIs never matches a disconnected participant, including an empty id.
func (p *participant) sessionIs(id string) bool {
	return p.sessionID != "" && p.sessionID == id
}

// senderQualityIdentity scopes quality evidence to one physical sender.
type senderQualityIdentity struct {
	childSessionID  string
	parentPeerID    string
	parentSessionID string
	connectionID    string
	senderIdentity  string
}

// attempt is the live candidate. Optional identities use ""; optional
// timestamps use pointers because zero is a valid accepted/sample time.
type attempt struct {
	tuple                                   CandidateTuple
	revision                                int64
	connectionID                            string
	childSessionID                          string
	parentSessionID                         string
	hostSessionID                           string
	publicationGeneration                   string
	publicationConnectionID                 string
	reservation                             CandidateReservation
	startedAtMs                             int64
	transportConnected                      bool
	mediaReady                              bool
	connectionAttempt                       *ConnectionAttemptProgress
	senderQualityState                      SenderQualityState
	senderQualityAcceptedAtMs               *int64
	senderQualityConsecutiveHealthyWindows  int64
	senderQualityConsecutiveDegradedWindows int64
	senderQualitySampleTimestampMs          *int64
	senderQualityIdentity                   string
	relativeQualityApprovedAtMs             *int64
}

// operation is the single in-flight route operation.
type operation struct {
	videoGeneration       string
	attachConnectionID    string
	childPeerID           string
	childSessionID        string
	demandPeerID          string
	demandSessionID       string
	reason                DemandReason
	baseRevision          int64
	candidates            []CandidatePlan
	cursor                int
	deadlineAtMs          int64
	builtAtFactVersion    int64
	deferredParentPeerIDs []string
	peerAttemptStarted    bool
	qualitySource         *senderQualityIdentity
	current               *attempt
}

// planAt returns nil when out of range and otherwise copies the plan so callers
// do not retain a pointer into the candidate slice while it is reordered.
func (o *operation) planAt(index int) *CandidatePlan {
	if index < 0 || index >= len(o.candidates) {
		return nil
	}
	plan := o.candidates[index]
	return &plan
}

// planAtOrLast returns the cursor's plan, the final plan if exhausted, or nil
// when there are no candidates.
func (o *operation) planAtOrLast() *CandidatePlan {
	return o.planAt(min(o.cursor, len(o.candidates)-1))
}

// currentTuple prefers the live attempt over the next planned candidate.
func (o *operation) currentTuple() *CandidateTuple {
	if o.current != nil {
		tuple := o.current.tuple
		return &tuple
	}
	if plan := o.planAt(o.cursor); plan != nil {
		return &plan.Tuple
	}
	return nil
}

// directContinuation retains the remaining parent retry order behind an SFU edge.
type directContinuation struct {
	childSessionID        string
	sfuConnectionID       string
	publicationGeneration string
	parentPeerIDs         []string
}

type sfuBootstrapIntent struct {
	demandPeerID    string
	demandSessionID string
}

type sfuBootstrapCarrier struct {
	demandPeerID    string
	demandSessionID string
	carrierPeerID   string
}

// routeTimingRecord uses nil timestamps for events that have not happened;
// zero is a valid event time.
type routeTimingRecord struct {
	demandAtMs            int64
	reason                DemandReason
	operationStartedAtMs  *int64
	candidateStartedAtMs  *int64
	firstDecodedFrameAtMs *int64
	finalAtMs             *int64
	finalRoute            FinalRoute
	rejectionBucket       RejectionBucket
}

// routeQualityObservation belongs to one receiver edge and presentation epoch.
// upstreamPeerID is empty for SFU; nil lastDecodedProgressAtMs means no progress.
type routeQualityObservation struct {
	childSessionID          string
	upstreamKind            UpstreamKind
	upstreamPeerID          string
	connectionID            string
	presentationEpoch       int64
	eligibleWindows         int64
	eligibleDurationMs      int64
	freezeWindows           int64
	freezeCount             int64
	freezeDurationMs        int64
	pauseCount              int64
	pauseDurationMs         int64
	lastAcceptedAtMs        int64
	lastDecodedProgressAtMs *int64
}

// senderQualityObservation copies share the consumed-candidate ledger, so a new
// sample on the same physical sender cannot reopen an exhausted opportunity.
type senderQualityObservation struct {
	childSessionID             string
	parentPeerID               string
	parentSessionID            string
	connectionID               string
	senderIdentity             string
	state                      SenderQualityState
	consecutiveDegradedWindows int64
	lastSampleTimestampMs      int64
	lastAcceptedAtMs           int64
	consumedQualityCandidates  *ordered.Map[string, int]
}

type sfuPublisherQualityObservation struct {
	hostSessionID             string
	publicationGeneration     string
	state                     SenderQualityState
	consecutiveHealthyWindows int64
	lastSampleTimestampMs     int64
	lastAcceptedAtMs          int64
}

// resourceSet deduplicates by pointer identity and preserves insertion order.
type resourceSet struct {
	seen map[*Resource]struct{}
	list []*Resource
}

func (s *resourceSet) add(resources ...*Resource) {
	if s.seen == nil {
		s.seen = make(map[*Resource]struct{})
	}
	for _, resource := range resources {
		if _, ok := s.seen[resource]; ok {
			continue
		}
		s.seen[resource] = struct{}{}
		s.list = append(s.list, resource)
	}
}

func (s *resourceSet) has(resource *Resource) bool {
	_, ok := s.seen[resource]
	return ok
}

// resources returns a fresh slice in insertion order.
func (s *resourceSet) resources() []*Resource {
	return append([]*Resource{}, s.list...)
}

// concatResources concatenates into a fresh, never-nil slice.
func concatResources(parts ...[]*Resource) []*Resource {
	out := []*Resource{}
	for _, part := range parts {
		out = append(out, part...)
	}
	return out
}

// dedupeStrings retains each value's first occurrence.
func dedupeStrings(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	out := make([]string, 0, len(values))
	for _, value := range values {
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	return out
}

// New constructs a controller and panics on invalid capacity, timeout or SFU policy.
func New(options Options) *Controller {
	if err := protocol.AssertEndpointMediaCopyCapacity(options.EndpointMediaCopyCapacity); err != nil {
		panic(err)
	}
	if !isSafeInteger(options.OperationTimeoutMs) || options.OperationTimeoutMs <= 0 {
		panic(errors.New("Route operation timeout must be a positive integer"))
	}
	if options.SfuOnly && !options.SfuEnabled {
		panic(errors.New("SFU-only routing requires SFU availability"))
	}
	if options.Revisions == nil {
		options.Revisions = &RevisionSequence{}
	}
	c := &Controller{
		hostPeerID:                      options.HostPeerID,
		debugRoomID:                     options.DebugRoomID,
		debugLog:                        options.DebugLog,
		endpointMediaCopyCapacity:       options.EndpointMediaCopyCapacity,
		operationTimeoutMs:              options.OperationTimeoutMs,
		sfuEnabled:                      options.SfuEnabled,
		sfuOnly:                         options.SfuOnly,
		qualityConvergenceEnabled:       options.QualityConvergenceEnabled && !options.SfuOnly,
		natPredictionEnabled:            options.NatPredictionEnabled && !options.SfuOnly,
		revisions:                       options.Revisions,
		routeTimings:                    make(map[string]*routeTimingRecord),
		qualityObservations:             make(map[string]*routeQualityObservation),
		senderQualityObservations:       make(map[string]*senderQualityObservation),
		senderQualityBaselines:          make(map[string]bool),
		senderQualityRegenerationBlocks: make(map[string]senderQualityIdentity),
		qualityBaselinesPending:         make(map[string]struct{}),
	}
	c.debug("controller-created",
		"endpointCapacity", options.EndpointMediaCopyCapacity,
		"operationTimeoutMs", options.OperationTimeoutMs,
		"sfuEnabled", options.SfuEnabled,
		"sfuOnly", options.SfuOnly,
		"qualityConvergenceEnabled", options.QualityConvergenceEnabled)
	return c
}

// DiagnosticParticipantLabel returns "host", "viewer-<joinOrder>" or
// "viewer-unknown" for a peer ID without exposing the ID.
func (c *Controller) DiagnosticParticipantLabel(peerID string) string {
	return c.debugPeer(peerID)
}

// Revision is Snapshot().Revision without the graph copy, for the callers
// that only compare revisions before and after a mutation.
func (c *Controller) Revision() int64 { return c.revision }

// Operation is Snapshot().Operation without the graph copy: a deep copy of
// the in-flight operation, or nil when the controller is idle.
func (c *Controller) Operation() *OperationSnapshot { return c.operationSnapshot() }

// Publication is Snapshot().HostPublication without the graph copy: a copy
// of the single live SFU ingress, or nil when there is none.
func (c *Controller) Publication() *HostPublication {
	if c.hostPublication == nil {
		return nil
	}
	copied := *c.hostPublication
	return &copied
}

// Snapshot returns a copy of the committed graph, the publication and the
// operation snapshot; it mutates nothing.
func (c *Controller) Snapshot() RouteSnapshot {
	// The router iterates this map to build assignments.
	upstream := &ordered.Map[string, CommittedEdge]{}
	for id, edge := range c.upstreamByViewer.All() {
		upstream.Set(id, *edge)
	}
	var publication *HostPublication
	if c.hostPublication != nil {
		copied := *c.hostPublication
		publication = &copied
	}
	return RouteSnapshot{
		RoomMedia:        c.roomMedia,
		VideoGeneration:  c.videoGeneration,
		VideoPaused:      c.videoPaused,
		Revision:         c.revision,
		Paused:           c.paused,
		FactVersion:      c.factVersion,
		UpstreamByViewer: upstream,
		HostPublication:  publication,
		Operation:        c.operationSnapshot(),
	}
}

// RouteDiagnosticSnapshot returns the privacy-safe snapshot: connected
// viewers sorted by join order with snapshot-local ordinals and relative
// durations; operation is nil unless its demand peer has an ordinal.
func (c *Controller) RouteDiagnosticSnapshot(nowMs int64) protocol.RouteDiagnosticSnapshot {
	viewers := []*participant{}
	for _, current := range c.participants.Values() {
		if current.role == protocol.RoleViewer && current.sessionID != "" && !current.departureConfirmed {
			viewers = append(viewers, current)
		}
	}
	sort.SliceStable(viewers, func(i, j int) bool { return compareParticipant(viewers[i], viewers[j]) < 0 })
	ordinals := make(map[string]int, len(viewers))
	for index, viewer := range viewers {
		ordinals[viewer.peerID] = index + 1
	}
	children := make([]protocol.RouteDiagnosticChild, 0, len(viewers))
	for _, viewer := range viewers {
		edge, _ := c.upstreamByViewer.Get(viewer.peerID)
		record := c.routeTimings[viewer.peerID]
		finalRoute := c.currentFinalRoute(viewer.peerID)
		childCount := 0
		for _, childPeerID := range c.childrenOf(viewer.peerID) {
			if childEdge, ok := c.upstreamByViewer.Get(childPeerID); ok && childEdge.Kind == UpstreamPeer && childEdge.PhysicalActive {
				childCount++
			}
		}
		child := protocol.RouteDiagnosticChild{
			Ordinal:           protocol.Int(ordinals[viewer.peerID]),
			Parent:            c.diagnosticParent(edge, ordinals),
			EffectiveCapacity: protocol.Int(viewer.effectiveDownstreamCapacity),
			ChildCount:        protocol.Int(childCount),
			FinalRoute:        string(finalRoute),
			RejectionBucket:   string(RejectionNone),
			Quality:           c.diagnosticQuality(viewer.peerID, edge, nowMs),
		}
		if record != nil {
			child.DemandAgeMs = elapsedMs(record.demandAtMs, nowMs)
			if record.operationStartedAtMs != nil {
				child.QueueWaitMs = elapsedMs(record.demandAtMs, *record.operationStartedAtMs)
			}
			if record.candidateStartedAtMs != nil {
				child.CandidateStartMs = elapsedMs(record.demandAtMs, *record.candidateStartedAtMs)
			}
			if record.firstDecodedFrameAtMs != nil {
				child.FirstDecodedFrameMs = elapsedMs(record.demandAtMs, *record.firstDecodedFrameAtMs)
			}
			if record.finalAtMs != nil {
				child.FinalMs = elapsedMs(record.demandAtMs, *record.finalAtMs)
			}
			child.RejectionBucket = string(record.rejectionBucket)
		}
		if finalRoute == FinalRouteWaiting {
			child.FinalRoute = string(FinalRouteWaiting)
			if record != nil && record.finalRoute == FinalRouteFailed {
				child.FinalRoute = string(FinalRouteFailed)
			}
		}
		children = append(children, child)
	}
	var diagnosticOperation *protocol.RouteDiagnosticOperation
	if op := c.operation; op != nil {
		if childOrdinal, ok := ordinals[op.demandPeerID]; ok {
			stage := "admission"
			if op.current != nil {
				stage = "first-frame"
				if op.current.mediaReady {
					stage = "quality-proof"
				}
			}
			diagnosticOperation = &protocol.RouteDiagnosticOperation{
				ChildOrdinal:   protocol.Int(childOrdinal),
				Reason:         string(op.reason),
				Stage:          stage,
				Cursor:         protocol.Int(op.cursor),
				CandidateCount: protocol.Int(len(op.candidates)),
			}
		}
	}
	return protocol.RouteDiagnosticSnapshot{Children: children, Operation: diagnosticOperation}
}

// UpsertParticipant adds or updates a participant, aborting an operation
// that used a replaced session; a viewer without a usable route records a
// "join" demand when nowMs is non-nil. Panics on a Host/role inconsistency.
func (c *Controller) UpsertParticipant(input ParticipantInput, nowMs *int64) []*Resource {
	if (input.PeerID == c.hostPeerID) != (input.Role == protocol.RoleHost) {
		panic(errors.New("Route Host identity is inconsistent"))
	}
	current, _ := c.participants.Get(input.PeerID)
	capacity := c.effectiveCapacity(input.EffectiveDownstreamCapacity,
		current != nil && current.sessionID == input.SessionID && current.relayVolunteer)
	released := []*Resource{}
	if current != nil && current.role != input.Role {
		panic(errors.New("Route role cannot change"))
	}
	if current != nil {
		changed := false
		previousSessionID := current.sessionID
		if previousSessionID != input.SessionID {
			current.relayVolunteer = false
			c.clearOpportunitiesForSessionChange(input.PeerID, input.Role)
			c.clearQualityForParticipant(input.PeerID)
			if c.operationUsesParticipantSession(input.PeerID) {
				released = append(released, c.abortOperation(nowMs, RejectionStale)...)
			}
			c.directContinuations.Delete(input.PeerID)
			c.clearSfuBootstrapForDemand(input.PeerID)
			current.sessionID = input.SessionID
			c.rebindCommittedSession(input.PeerID, input.SessionID)
			changed = true
		}
		if current.departureConfirmed {
			current.departureConfirmed = false
			changed = true
		}
		current.reportedDownstreamCapacity = input.EffectiveDownstreamCapacity
		if current.effectiveDownstreamCapacity != capacity {
			current.effectiveDownstreamCapacity = capacity
			c.recordCapacityReduction(input.PeerID, nowMs)
			changed = true
		}
		if changed {
			c.touchFacts()
			c.debug("participant-updated",
				"participant", c.debugPeer(input.PeerID),
				"capacity", capacity,
				"sessionChanged", previousSessionID != input.SessionID)
		}
		if input.Role == protocol.RoleViewer && nowMs != nil && !c.usableRoute(input.PeerID) {
			c.recordDemand(input.PeerID, *nowMs, DemandJoin)
		}
		if input.Role == protocol.RoleViewer {
			released = append(released, c.SetViewerRoutePreference(input.PeerID, input.SessionID, input.RoutePreference, nowMs)...)
		}
		return released
	}
	// New participants append to the scheduling order.
	c.participants.Set(input.PeerID, &participant{
		peerID:                      input.PeerID,
		role:                        input.Role,
		sessionID:                   input.SessionID,
		effectiveDownstreamCapacity: capacity,
		reportedDownstreamCapacity:  input.EffectiveDownstreamCapacity,
		routePreference:             input.RoutePreference,
		joinOrder:                   c.nextJoinOrder,
	})
	c.nextJoinOrder++
	c.debug("participant-joined",
		"participant", c.debugPeer(input.PeerID),
		"role", input.Role,
		"capacity", capacity)
	if input.Role == protocol.RoleViewer && nowMs != nil {
		c.recordDemand(input.PeerID, *nowMs, DemandJoin)
	}
	c.touchFacts()
	return released
}

// SetViewerRoutePreference changes eligibility, not physical edge health. The
// ordinary serial handoff keeps current media until commit or strict-policy
// exhaustion; selecting Auto again reopens only this Viewer's opportunities.
func (c *Controller) SetViewerRoutePreference(peerID, sessionID string, preference protocol.ViewerRoutePreference, nowMs *int64) []*Resource {
	current, _ := c.participants.Get(peerID)
	if current == nil || current.role != protocol.RoleViewer || !current.sessionIs(sessionID) || current.routePreference == preference {
		return nil
	}
	var released []*Resource
	if op := c.operation; op != nil && (op.childPeerID == peerID || op.demandPeerID == peerID) {
		released = c.abortOperation(nowMs, RejectionAborted)
	}
	current.routePreference = preference
	current.consumedCandidateOpportunities.Clear()
	current.availabilityExhausted = false
	current.bootstrapFailureReported = false
	c.directContinuations.Delete(peerID)
	c.clearSfuBootstrapForDemand(peerID)
	c.touchFacts()
	c.debug("viewer-route-preference", "participant", c.debugPeer(peerID), "preference", preference)
	if nowMs != nil {
		c.recordDemand(peerID, *nowMs, c.routeDemandReason(peerID))
	}
	return released
}

// RebindHostIdentity moves the Host to a new peer ID (same ID delegates to
// UpsertParticipant), tearing down the whole graph and returning every SFU
// subscription, the publication and the aborted reservation, deduplicated.
func (c *Controller) RebindHostIdentity(peerID, sessionID string, nowMs *int64) []*Resource {
	previousPeerID := c.hostPeerID
	if peerID == previousPeerID {
		return c.UpsertParticipant(ParticipantInput{
			PeerID:                      peerID,
			Role:                        protocol.RoleHost,
			SessionID:                   sessionID,
			EffectiveDownstreamCapacity: c.endpointMediaCopyCapacity,
		}, nowMs)
	}
	if c.participants.Has(peerID) {
		panic(errors.New("Route Host identity collides with another participant"))
	}
	host, _ := c.participants.Get(previousPeerID)
	if host == nil || host.role != protocol.RoleHost {
		panic(errors.New("Route Host identity is unavailable"))
	}

	// Aborted reservation, then SFU edges in map
	// order, then the publication, deduplicated.
	released := &resourceSet{}
	if c.operation != nil {
		released.add(c.abortOperation(nowMs, RejectionStale)...)
	}
	for _, edge := range c.upstreamByViewer.Values() {
		if edge.Kind == UpstreamSfu && edge.PhysicalActive {
			released.add(edge.Resource)
		}
	}
	if c.hostPublication != nil && c.hostPublication.PhysicalActive {
		released.add(c.hostPublication.Resource)
	}
	c.upstreamByViewer.Clear()
	c.hostPublication = nil
	clear(c.routeTimings)
	clear(c.qualityObservations)
	clear(c.senderQualityObservations)
	clear(c.senderQualityBaselines)
	clear(c.senderQualityRegenerationBlocks)
	clear(c.qualityBaselinesPending)
	c.sfuPublisherQualityObservation = nil
	c.directContinuations.Clear()
	c.retiringPublicationGenerations.Clear()
	c.sfuBootstrapIntent = nil
	c.consumedSfuBootstrapOpportunities.Clear()
	c.rootConvergenceRootPeerID = ""
	// Demand is re-recorded in participants order.
	for _, current := range c.participants.Values() {
		current.availabilityExhausted = false
		current.bootstrapFailureReported = false
		current.sfuFirstAtNextRoute = false
		current.consumedCandidateOpportunities.Clear()
		if current.role == protocol.RoleViewer && current.sessionID != "" && nowMs != nil {
			c.recordDemand(current.peerID, *nowMs, DemandEdgeUnavailable)
		}
	}

	// Delete + set moves the Host to the tail of the
	// insertion order while it keeps its joinOrder.
	c.participants.Delete(previousPeerID)
	host.peerID = peerID
	host.sessionID = sessionID
	host.relayVolunteer = false
	host.effectiveDownstreamCapacity = c.effectiveCapacity(host.reportedDownstreamCapacity, false)
	host.departureConfirmed = false
	c.participants.Set(peerID, host)
	c.hostPeerID = peerID
	c.revision = c.allocateRevision()
	c.touchFacts()
	c.assertGraph()
	return released.resources()
}

// DisconnectSession marks the participant's exact session as gone (grace
// state, no revision change); false when the session does not match.
func (c *Controller) DisconnectSession(peerID, sessionID string) bool {
	current, _ := c.participants.Get(peerID)
	if current == nil || !current.sessionIs(sessionID) {
		return false
	}
	c.clearOpportunitiesForSessionChange(peerID, current.role)
	current.sessionID = ""
	c.clearQualityForParticipant(peerID)
	c.directContinuations.Delete(peerID)
	c.clearSfuBootstrapForDemand(peerID)
	c.touchFacts()
	c.debug("participant-disconnected", "participant", c.debugPeer(peerID))
	return true
}

// ConfirmDeparture finalises a viewer's departure (capacity 0, demand
// recorded for its children when nowMs is non-nil); false for the Host or
// an unknown peer; idempotent.
func (c *Controller) ConfirmDeparture(peerID string, nowMs *int64) bool {
	current, _ := c.participants.Get(peerID)
	if current == nil || current.role == protocol.RoleHost {
		return false
	}
	delete(c.routeTimings, peerID)
	if current.departureConfirmed && current.sessionID == "" && current.effectiveDownstreamCapacity == 0 {
		return true
	}
	c.clearOpportunitiesForSessionChange(peerID, current.role)
	current.sessionID = ""
	c.clearQualityForParticipant(peerID)
	current.departureConfirmed = true
	current.effectiveDownstreamCapacity = 0
	c.directContinuations.Delete(peerID)
	c.clearSfuBootstrapForDemand(peerID)
	if nowMs != nil {
		for _, childPeerID := range c.childrenOf(peerID) {
			c.recordDemand(childPeerID, *nowMs, DemandParentDeparted)
		}
	}
	c.touchFacts()
	c.debug("participant-departed", "participant", c.debugPeer(peerID))
	return true
}

// SetEffectiveCapacity clamps and stores the participant's downstream
// capacity for the matching session; true even when unchanged (facts are
// touched only on change).
func (c *Controller) SetEffectiveCapacity(peerID, sessionID string, value int, nowMs *int64) bool {
	current, _ := c.participants.Get(peerID)
	if current == nil || !current.sessionIs(sessionID) {
		return false
	}
	capacity := c.effectiveCapacity(value, current.relayVolunteer)
	current.reportedDownstreamCapacity = value
	if current.effectiveDownstreamCapacity == capacity {
		return true
	}
	current.effectiveDownstreamCapacity = capacity
	c.recordCapacityReduction(peerID, nowMs)
	c.touchFacts()
	c.debug("capacity-updated", "participant", c.debugPeer(peerID), "capacity", capacity)
	return true
}

// TouchExternalFacts reopens every SFU opportunity after an external fact
// change (for example a share generation) and bumps the fact version.
func (c *Controller) TouchExternalFacts() {
	c.clearSfuCandidateOpportunities()
	c.sfuBootstrapIntent = nil
	c.touchFacts()
}

// InvalidateEdge marks the exactly identified edge unusable and records an
// "edge-unavailable" demand; true when the guard matched (idempotent).
func (c *Controller) InvalidateEdge(guard EdgeGuard, nowMs *int64) bool {
	child, _ := c.participants.Get(guard.ChildPeerID)
	edge, _ := c.upstreamByViewer.Get(guard.ChildPeerID)
	if child == nil || !child.sessionIs(guard.ChildSessionID) || c.revision != guard.RouteRevision ||
		edge == nil || edge.ConnectionID != guard.ConnectionID ||
		edge.ChildSessionID != guard.ChildSessionID ||
		(edge.Kind == UpstreamPeer && edge.ParentSessionID != guard.ParentSessionID) {
		return false
	}
	if edge.Usable {
		c.consumeActiveEdgeOpportunity(child, edge)
		c.clearQualityForParticipant(guard.ChildPeerID)
		edge.Usable = false
		c.directContinuations.Delete(guard.ChildPeerID)
		child.availabilityExhausted = false
		child.bootstrapFailureReported = false
		c.touchFacts()
		if nowMs != nil {
			c.recordDemand(guard.ChildPeerID, *nowMs, DemandEdgeUnavailable)
		}
	}
	return true
}

// InvalidateDirectEdgeFromParent invalidates the first committed direct edge
// (insertion order) matching the parent-side guard.
func (c *Controller) InvalidateDirectEdgeFromParent(input ParentEdgeGuard, nowMs *int64) bool {
	// First match in insertion order wins.
	for childPeerID, edge := range c.upstreamByViewer.All() {
		if edge.Kind == UpstreamPeer &&
			edge.ParentPeerID == input.ParentPeerID &&
			edge.ParentSessionID == input.ParentSessionID &&
			edge.ConnectionID == input.ConnectionID {
			return c.InvalidateEdge(EdgeGuard{
				ChildPeerID:     childPeerID,
				ChildSessionID:  edge.ChildSessionID,
				ParentSessionID: input.ParentSessionID,
				RouteRevision:   input.RouteRevision,
				ConnectionID:    input.ConnectionID,
			}, nowMs)
		}
	}
	return false
}

// InvalidateHostPublication marks the identified publication unusable and
// records demand for every SFU child; true when the guard matched (idempotent).
func (c *Controller) InvalidateHostPublication(guard PublicationGuard, nowMs *int64) bool {
	publication := c.hostPublication
	if publication == nil || c.revision != guard.RouteRevision ||
		publication.HostSessionID != guard.HostSessionID ||
		publication.Generation != guard.Generation ||
		publication.ConnectionID != guard.ConnectionID {
		return false
	}
	if publication.Usable {
		c.clearSfuQuality()
		publication.Usable = false
		c.directContinuations.Clear()
		c.sfuBootstrapIntent = nil
		if nowMs != nil {
			for childPeerID, edge := range c.upstreamByViewer.All() {
				if edge.Kind == UpstreamSfu {
					c.recordDemand(childPeerID, *nowMs, DemandEdgeUnavailable)
				}
			}
		}
		c.touchFacts()
	}
	return true
}

// AdoptDirectConnection accepts a replacement for the exact active edge.
// Recovery supersedes optional preparation for that child when the replacement
// arrives. Required availability work, including capacity reduction, keeps priority.
func (c *Controller) AdoptDirectConnection(input AdoptDirectConnectionInput, nowMs int64) SettleResult {
	result := SettleResult{ActiveRevision: c.revision}
	edge, _ := c.upstreamByViewer.Get(input.ChildPeerID)
	if c.revision != input.RouteRevision ||
		edge == nil ||
		edge.Kind != UpstreamPeer ||
		edge.Transport != TransportDirect ||
		!edge.Usable ||
		!edge.PhysicalActive ||
		edge.ChildSessionID != input.ChildSessionID ||
		edge.ParentSessionID != input.ParentSessionID ||
		edge.ConnectionID != input.ConnectionID ||
		input.NewConnectionID == "" {
		return result
	}
	activeConnectionID := edge.ConnectionID
	if c.roomMedia {
		if !edge.VideoReady || edge.VideoGeneration != c.videoGeneration || c.videoGeneration == "" {
			return result
		}
		activeConnectionID = edge.VideoConnectionID
	}
	if input.NewConnectionID == activeConnectionID {
		result.Accepted = true
		return result
	}
	if op := c.operation; op != nil && op.childPeerID == input.ChildPeerID {
		if isAvailabilityOperation(op.reason) {
			return result
		}
		result.Released = c.abortOperation(&nowMs, RejectionAborted)
	}
	c.clearQualityForParticipant(input.ChildPeerID)
	if c.roomMedia {
		edge.VideoConnectionID = input.NewConnectionID
	} else {
		edge.ConnectionID = input.NewConnectionID
		edge.opportunityKey = c.candidateOpportunityBase(input.ChildPeerID, CandidatePlan{
			Tuple: CandidateTuple{Kind: edge.Kind, ParentPeerID: edge.ParentPeerID},
		})
	}
	if child, ok := c.participants.Get(input.ChildPeerID); ok {
		child.availabilityExhausted = false
	}
	c.touchFacts()
	result.Accepted = true
	result.ActiveRevision = c.revision
	return result
}

// RetireHostPublication retires the physically active publication and its
// subscriptions when no attempt is live and the guard matches, returning the
// subscriptions then the publication resource; empty otherwise.
func (c *Controller) RetireHostPublication(guard PublicationGuard) []*Resource {
	publication := c.hostPublication
	if (c.operation != nil && c.operation.current != nil) || publication == nil || !publication.PhysicalActive ||
		c.revision != guard.RouteRevision ||
		publication.HostSessionID != guard.HostSessionID ||
		publication.Generation != guard.Generation ||
		publication.ConnectionID != guard.ConnectionID {
		return []*Resource{}
	}
	// Subscriptions in map order, then the publication.
	released := []*Resource{}
	for viewerPeerID, edge := range c.upstreamByViewer.All() {
		if edge.Kind == UpstreamSfu && edge.PublicationGeneration == publication.Generation {
			c.retireSfuEdge(viewerPeerID, edge, &released, c.retainsAnchor(viewerPeerID))
		}
	}
	publication.PhysicalActive = false
	publication.Usable = false
	c.hostPublication = nil
	c.clearSfuQuality()
	c.revision = c.allocateRevision()
	if c.operation != nil {
		c.operation.baseRevision = c.revision
	}
	c.touchFacts()
	released = append(released, publication.Resource)
	c.pruneRetiringSfuAnchors()
	return released
}

// SetPaused pauses (aborting the operation and clearing quality state) or
// resumes; returns the aborted reservation's resources.
func (c *Controller) SetPaused(paused bool, nowMs *int64) []*Resource {
	if c.roomMedia {
		now := int64(0)
		if nowMs != nil {
			now = *nowMs
		}
		return c.SetVideoPublication(c.videoGeneration, paused, now)
	}
	if c.paused == paused {
		return []*Resource{}
	}
	c.paused = paused
	if paused {
		clear(c.qualityObservations)
		clear(c.qualityBaselinesPending)
		clear(c.senderQualityObservations)
		clear(c.senderQualityBaselines)
		clear(c.senderQualityRegenerationBlocks)
		c.sfuPublisherQualityObservation = nil
	}
	c.touchFacts()
	if paused {
		return c.abortOperation(nowMs, RejectionAborted)
	}
	return []*Resource{}
}

// Dispose clears all state, pauses the controller and returns the live
// reservation's resources then every committed resource, deduplicated.
func (c *Controller) Dispose() []*Resource {
	// Reservation first, then committed resources.
	resources := &resourceSet{}
	if c.operation != nil && c.operation.current != nil {
		resources.add(reservationResources(c.operation.current.reservation)...)
	}
	resources.add(c.committedResources()...)
	c.operation = nil
	c.upstreamByViewer.Clear()
	clear(c.qualityObservations)
	clear(c.qualityBaselinesPending)
	clear(c.senderQualityObservations)
	clear(c.senderQualityBaselines)
	clear(c.senderQualityRegenerationBlocks)
	c.sfuPublisherQualityObservation = nil
	c.hostPublication = nil
	c.participants.Clear()
	clear(c.routeTimings)
	c.directContinuations.Clear()
	c.retiringPublicationGenerations.Clear()
	c.sfuBootstrapIntent = nil
	c.consumedSfuBootstrapOpportunities.Clear()
	c.rootConvergenceRootPeerID = ""
	// nextJoinOrder, revision, the room's revision sequence and factVersion survive.
	c.paused = true
	return resources.resources()
}

// abortOperation finishes demand timing when nowMs is given, releases the live
// reservation and clears the operation.
func (c *Controller) abortOperation(nowMs *int64, bucket RejectionBucket) []*Resource {
	if c.operation == nil {
		return []*Resource{}
	}
	if nowMs != nil {
		c.finishTiming(c.operation.demandPeerID, *nowMs, c.currentFinalRoute(c.operation.demandPeerID), bucket, false)
	}
	op := c.operation
	released := []*Resource{}
	if op.current != nil {
		released = reservationResources(op.current.reservation)
		c.advanceActiveRevision(op)
	}
	c.operation = nil
	return released
}

func (c *Controller) operationUsesParticipantSession(peerID string) bool {
	op := c.operation
	if op == nil {
		return false
	}
	if op.childPeerID == peerID || op.demandPeerID == peerID {
		return true
	}
	tuple := op.currentTuple()
	if tuple != nil && tuple.Kind == UpstreamPeer {
		return tuple.ParentPeerID == peerID
	}
	return peerID == c.hostPeerID
}

// effectiveCapacity panics "Effective capacity is invalid" for
// a negative or unsafe value and clamps to the endpoint capacity.
func (c *Controller) effectiveCapacity(value int, volunteer bool) int {
	if !isSafeInteger(int64(value)) || value < 0 {
		panic(errors.New("Effective capacity is invalid"))
	}
	limit := c.endpointMediaCopyCapacity
	if volunteer {
		limit = MaxRelayVolunteerChildren
	}
	return min(value, limit)
}

func (c *Controller) touchFacts() { c.factVersion++ }

// allocateRevision bounds revisions by MAX_SAFE_INTEGER.
func (c *Controller) allocateRevision() int64 {
	if c.revisions.latest >= protocol.MaxMediaRouteRevision {
		panic(errors.New("Media route revision space exhausted"))
	}
	c.revisions.latest++
	return c.revisions.latest
}

// isSafeInteger keeps values exactly representable by the Browser's number type.
func isSafeInteger(value int64) bool {
	return value >= -maxSafeInteger && value <= maxSafeInteger
}

// compareParticipant preserves join order, including across Host rebinding.
// Live participants have unique orders; peer ID breaks ties in synthetic inputs.
func compareParticipant(left, right *participant) int {
	if left.joinOrder != right.joinOrder {
		if left.joinOrder < right.joinOrder {
			return -1
		}
		return 1
	}
	return strings.Compare(left.peerID, right.peerID)
}

// stablePairRank returns the first 6 bytes, big-endian, of
// sha256(child + "\0" + parent). Byte-exact: it breaks parent ties.
func stablePairRank(childPeerID, parentPeerID string) int64 {
	sum := sha256.Sum256([]byte(childPeerID + "\x00" + parentPeerID))
	var rank int64
	for _, b := range sum[:6] {
		rank = rank<<8 | int64(b)
	}
	return rank
}

// safeAdd ignores invalid rounded deltas and saturates at the wire integer bound.
func safeAdd(total int64, delta float64) int64 {
	rounded := math.Round(delta)
	if math.IsNaN(rounded) || math.IsInf(rounded, 0) || rounded < 0 || rounded > float64(maxSafeInteger) {
		return total
	}
	value := int64(rounded)
	if value > maxSafeInteger-total {
		return maxSafeInteger
	}
	return total + value
}
