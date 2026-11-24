package route

import (
	"strings"

	"zviewer/backend/internal/piik/server/ordered"
	"zviewer/backend/internal/piik/server/protocol"
)

// candidateOpportunityBase returns the NUL-joined ledger key. A session
// change erases the key because the session is part of it.
func (c *Controller) candidateOpportunityBase(childPeerID string, plan CandidatePlan) string {
	childSessionID := ""
	if child, ok := c.participants.Get(childPeerID); ok {
		childSessionID = child.sessionID
	}
	if plan.Tuple.Kind == UpstreamPeer {
		parentSessionID := ""
		if parent, ok := c.participants.Get(plan.Tuple.ParentPeerID); ok {
			parentSessionID = parent.sessionID
		}
		return peerOpportunityKey(plan.Tuple, childSessionID, parentSessionID)
	}
	hostSessionID := ""
	if host, ok := c.participants.Get(c.hostPeerID); ok {
		hostSessionID = host.sessionID
	}
	return sfuOpportunityPrefix + childSessionID + "\x00" + hostSessionID
}

func peerOpportunityKey(tuple CandidateTuple, childSessionID, parentSessionID string) string {
	return tupleKey(tuple) + "\x00" + childSessionID + "\x00" + parentSessionID
}

func (c *Controller) candidateOpportunityAvailable(childPeerID string, plan CandidatePlan) bool {
	child, _ := c.participants.Get(childPeerID)
	if child == nil {
		return true
	}
	consumed, ok := child.consumedCandidateOpportunities.Get(c.candidateOpportunityBase(childPeerID, plan))
	return !ok ||
		endpointTransitionRank(plan.EndpointTransition) < consumed.rank ||
		(c.natPredictionEnabled &&
			plan.Tuple.Kind == UpstreamPeer &&
			!consumed.exhausted &&
			consumed.chargedAttempts < maxNatConnectionAttempts)
}

// startCandidateOpportunity numbers the in-flight NAT attempt without charging
// it. Authority cancellation preserves the previous opportunity unchanged.
func (c *Controller) startCandidateOpportunity(op *operation, plan CandidatePlan) *ConnectionAttemptProgress {
	if !c.natPredictionEnabled ||
		plan.Tuple.Kind != UpstreamPeer ||
		(!isAvailabilityOperation(op.reason) && op.reason != DemandDirectConvergence) {
		return nil
	}
	child, _ := c.participants.Get(op.childPeerID)
	opportunities := &child.consumedCandidateOpportunities
	key := c.candidateOpportunityBase(op.childPeerID, plan)
	rank := endpointTransitionRank(plan.EndpointTransition)
	previous, ok := opportunities.Get(key)
	startedAttempts := 1
	if ok && previous.rank <= rank {
		startedAttempts = previous.chargedAttempts + 1
	}
	op.peerAttemptStarted = true
	return &ConnectionAttemptProgress{Current: startedAttempts, Total: maxNatConnectionAttempts}
}

// settleCandidateOpportunity charges only success, failure or timeout, before
// retirement/continuation selection. Stale facts and aborts never call it.
func (c *Controller) settleCandidateOpportunity(op *operation) {
	att := op.current
	if att == nil || att.connectionAttempt == nil {
		return
	}
	child, _ := c.participants.Get(op.childPeerID)
	plan := op.planAt(op.cursor)
	key := peerOpportunityKey(att.tuple, att.childSessionID, att.parentSessionID)
	previous, ok := child.consumedCandidateOpportunities.Get(key)
	rank := endpointTransitionRank(plan.EndpointTransition)
	if ok {
		rank = min(previous.rank, rank)
	}
	child.consumedCandidateOpportunities.Set(key, candidateOpportunity{
		rank: rank, chargedAttempts: att.connectionAttempt.Current,
	})
}

func (c *Controller) currentPeerOpportunity(childPeerID string) (string, *attempt) {
	op := c.operation
	if op == nil || op.childPeerID != childPeerID || op.current == nil || op.current.connectionAttempt == nil {
		return "", nil
	}
	att := op.current
	return peerOpportunityKey(att.tuple, att.childSessionID, att.parentSessionID), att
}

func (c *Controller) peerAttemptsStarted(childPeerID, parentPeerID string) int {
	if !c.natPredictionEnabled {
		return 0
	}
	plan := c.planCandidate(childPeerID, CandidateTuple{Kind: UpstreamPeer, ParentPeerID: parentPeerID, Transport: TransportDirect})
	if plan == nil {
		return 0
	}
	child, _ := c.participants.Get(childPeerID)
	if child == nil {
		return 0
	}
	key := c.candidateOpportunityBase(childPeerID, *plan)
	if currentKey, att := c.currentPeerOpportunity(childPeerID); att != nil && currentKey == key {
		return att.connectionAttempt.Current
	}
	opportunity, ok := child.consumedCandidateOpportunities.Get(key)
	if ok && opportunity.rank <= endpointTransitionRank(plan.EndpointTransition) {
		return opportunity.chargedAttempts
	}
	return 0
}

// viewerAttemptsStarted sums the attempts over every peer key.
func (c *Controller) viewerAttemptsStarted(peerID string) int {
	if !c.natPredictionEnabled {
		return 0
	}
	current, _ := c.participants.Get(peerID)
	if current == nil {
		return 0
	}
	currentKey, att := c.currentPeerOpportunity(peerID)
	started := 0
	for key, opportunity := range current.consumedCandidateOpportunities.All() {
		if strings.HasPrefix(key, "peer:") {
			if att != nil && key == currentKey {
				started += att.connectionAttempt.Current
			} else {
				started += opportunity.chargedAttempts
			}
		}
	}
	if att != nil && !current.consumedCandidateOpportunities.Has(currentKey) {
		started += att.connectionAttempt.Current
	}
	return started
}

func (c *Controller) hasRemainingAvailabilityOpportunity(op *operation) bool {
	return isAvailabilityOperation(op.reason) && len(c.buildCandidates(op.childPeerID, false)) > 0
}

// consumeCandidateOpportunity exhausts the key at its best rank.
func (c *Controller) consumeCandidateOpportunity(childPeerID string, plan CandidatePlan) {
	child, _ := c.participants.Get(childPeerID)
	if child == nil {
		return
	}
	key := c.candidateOpportunityBase(childPeerID, plan)
	rank := endpointTransitionRank(plan.EndpointTransition)
	previous, ok := child.consumedCandidateOpportunities.Get(key)
	entry := candidateOpportunity{rank: rank, exhausted: true}
	if ok {
		entry.rank = min(previous.rank, rank)
		entry.chargedAttempts = previous.chargedAttempts
	}
	child.consumedCandidateOpportunities.Set(key, entry)
}

func (c *Controller) qualityCandidateOpportunityAvailable(childPeerID string, plan CandidatePlan) bool {
	observation := c.senderQualityObservations[childPeerID]
	if observation == nil {
		return true
	}
	consumed, ok := observation.consumedQualityCandidates.Get(c.candidateOpportunityBase(childPeerID, plan))
	return !ok || endpointTransitionRank(plan.EndpointTransition) < consumed
}

func (c *Controller) consumeQualityCandidateOpportunity(op *operation, plan *CandidatePlan) {
	if op.reason != DemandQualityConvergence || plan == nil {
		return
	}
	observation := c.currentQualityOperationObservation(op)
	if observation == nil {
		return
	}
	consumeOpportunity(observation.consumedQualityCandidates,
		c.candidateOpportunityBase(op.childPeerID, *plan),
		endpointTransitionRank(plan.EndpointTransition))
}

func (c *Controller) consumeQualityOperationCandidates(op *operation) {
	for index := range op.candidates {
		candidate := op.candidates[index]
		c.consumeQualityCandidateOpportunity(op, &candidate)
	}
}

// consumeActiveEdgeOpportunity exhausts the invalidated edge's exact tuple at rank 0.
func (c *Controller) consumeActiveEdgeOpportunity(child *participant, edge *CommittedEdge) {
	key := c.candidateOpportunityBase(child.peerID, CandidatePlan{
		Tuple: CandidateTuple{Kind: edge.Kind, ParentPeerID: edge.ParentPeerID},
	})
	// A retained connection can fail after reauthentication. Its old acquisition
	// must not exhaust the replacement session's still-untried opportunity.
	if edge.opportunityKey != key {
		return
	}
	previous, _ := child.consumedCandidateOpportunities.Get(key)
	child.consumedCandidateOpportunities.Set(key, candidateOpportunity{
		rank:            0,
		chargedAttempts: previous.chargedAttempts,
		exhausted:       true,
	})
}

func (c *Controller) consumeAvailabilityOperation(op *operation) {
	if !isAvailabilityOperation(op.reason) {
		return
	}
	// A deadline can expire on a connected Peer before the suffix is reached.
	// Consume only the visited prefix; an untried fallback remains eligible after
	// rollback, under a new operation with its own unchanged deadline.
	for _, plan := range op.candidates[:min(op.cursor+1, len(op.candidates))] {
		if op.peerAttemptStarted && plan.Tuple.Kind == UpstreamPeer {
			continue
		}
		c.consumeCandidateOpportunity(op.childPeerID, plan)
	}
}

func (c *Controller) consumeCurrentCandidateOpportunity(op *operation) {
	if !isAvailabilityOperation(op.reason) && op.reason != DemandDirectConvergence {
		return
	}
	plan := op.planAt(op.cursor)
	if op.current != nil && op.current.connectionAttempt != nil && plan != nil && plan.Tuple.Kind == UpstreamPeer {
		return
	}
	if plan != nil {
		c.consumeCandidateOpportunity(op.childPeerID, *plan)
	}
}

// clearOpportunitiesForSessionChange snapshots keys before deletion,
// preserving JavaScript's safe deletion during iteration.
func (c *Controller) clearOpportunitiesForSessionChange(peerID string, role protocol.Role) {
	if current, ok := c.participants.Get(peerID); ok {
		current.consumedCandidateOpportunities.Clear()
		current.availabilityExhausted = false
		current.bootstrapFailureReported = false
	}
	parentPrefix := "peer:" + peerID + "\x00"
	for _, child := range c.participants.Values() {
		for _, key := range child.consumedCandidateOpportunities.Keys() {
			if strings.HasPrefix(key, parentPrefix) ||
				(role == protocol.RoleHost && strings.HasPrefix(key, sfuOpportunityPrefix)) {
				child.consumedCandidateOpportunities.Delete(key)
			}
		}
		if role == protocol.RoleHost {
			child.bootstrapFailureReported = false
		}
	}
	if role == protocol.RoleHost {
		c.consumedSfuBootstrapOpportunities.Clear()
		return
	}
	carrierPrefix := peerID + "\x00"
	for _, key := range c.consumedSfuBootstrapOpportunities.Keys() {
		if strings.HasPrefix(key, carrierPrefix) {
			c.consumedSfuBootstrapOpportunities.Delete(key)
		}
	}
}

func (c *Controller) clearSfuCandidateOpportunities() {
	for _, current := range c.participants.Values() {
		for _, key := range current.consumedCandidateOpportunities.Keys() {
			if strings.HasPrefix(key, sfuOpportunityPrefix) {
				current.consumedCandidateOpportunities.Delete(key)
			}
		}
		current.bootstrapFailureReported = false
	}
	c.consumedSfuBootstrapOpportunities.Clear()
}

// consumeOpportunity keeps the best (lowest) rank.
func consumeOpportunity(consumed *ordered.Map[string, int], base string, rank int) {
	previous, ok := consumed.Get(base)
	if !ok || rank < previous {
		consumed.Set(base, rank)
	}
}
