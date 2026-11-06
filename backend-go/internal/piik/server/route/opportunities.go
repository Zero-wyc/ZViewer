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
		return tupleKey(plan.Tuple) + "\x00" + childSessionID + "\x00" + parentSessionID
	}
	hostSessionID := ""
	if host, ok := c.participants.Get(c.hostPeerID); ok {
		hostSessionID = host.sessionID
	}
	return sfuOpportunityPrefix + childSessionID + "\x00" + hostSessionID
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
			consumed.startedAttempts < maxNatConnectionAttempts)
}

// startCandidateOpportunity counts one NAT attempt for a peer
// candidate of an availability or direct-convergence operation.
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
		startedAttempts = previous.startedAttempts + 1
	}
	newRank := rank
	if ok {
		newRank = min(previous.rank, rank)
	}
	opportunities.Set(key, candidateOpportunity{rank: newRank, startedAttempts: startedAttempts})
	op.peerAttemptStarted = true
	return &ConnectionAttemptProgress{Current: startedAttempts, Total: maxNatConnectionAttempts}
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
	opportunity, ok := child.consumedCandidateOpportunities.Get(c.candidateOpportunityBase(childPeerID, *plan))
	if ok && opportunity.rank <= endpointTransitionRank(plan.EndpointTransition) {
		return opportunity.startedAttempts
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
	started := 0
	for key, opportunity := range current.consumedCandidateOpportunities.All() {
		if strings.HasPrefix(key, "peer:") {
			started += opportunity.startedAttempts
		}
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
		entry.startedAttempts = previous.startedAttempts
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
		startedAttempts: previous.startedAttempts,
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

func (c *Controller) consumeCurrentAvailabilityOpportunity(op *operation) {
	if !isAvailabilityOperation(op.reason) {
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
