package route

import (
	"slices"
	"sort"
)

func (c *Controller) peekSfuBootstrapCarrier() *sfuBootstrapCarrier {
	intent := c.currentSfuBootstrapIntent()
	if intent == nil {
		return nil
	}
	carriers := c.safeSfuBootstrapCarriers(intent.demandPeerID)
	if len(carriers) == 0 {
		return nil
	}
	return &sfuBootstrapCarrier{
		demandPeerID:    intent.demandPeerID,
		demandSessionID: intent.demandSessionID,
		carrierPeerID:   carriers[0],
	}
}

func (c *Controller) hasSfuBootstrapWork() bool {
	if c.currentSfuBootstrapIntent() != nil {
		return true
	}
	for _, viewer := range c.availableViewers(true) {
		if viewer.availabilityExhausted &&
			c.sfuBootstrapNeeded(viewer.peerID) &&
			(len(c.safeSfuBootstrapCarriers(viewer.peerID)) > 0 || !viewer.bootstrapFailureReported) {
			return true
		}
	}
	return false
}

func (c *Controller) takeSfuBootstrapCarrier(nowMs int64, failedPeerIDs *[]string) *sfuBootstrapCarrier {
	if !c.sfuBootstrapGloballyNeeded() {
		return nil
	}
	if carrier := c.peekSfuBootstrapCarrier(); carrier != nil {
		return carrier
	}
	c.sfuBootstrapIntent = nil
	c.reportSfuBootstrapFailures(nowMs, failedPeerIDs)
	return nil
}

// currentSfuBootstrapIntent revalidates the sticky intent on
// every access and otherwise re-derives it from the first exhausted viewer in
// availableViewers order.
func (c *Controller) currentSfuBootstrapIntent() *sfuBootstrapIntent {
	if current := c.sfuBootstrapIntent; current != nil {
		demand, _ := c.participants.Get(current.demandPeerID)
		if c.sfuBootstrapNeeded(current.demandPeerID) &&
			demand != nil && demand.sessionIs(current.demandSessionID) &&
			len(c.safeSfuBootstrapCarriers(current.demandPeerID)) > 0 {
			return current
		}
		c.sfuBootstrapIntent = nil
	}
	for _, viewer := range c.availableViewers(true) {
		if viewer.availabilityExhausted &&
			c.sfuBootstrapNeeded(viewer.peerID) &&
			len(c.safeSfuBootstrapCarriers(viewer.peerID)) > 0 {
			if viewer.sessionID == "" {
				return nil
			}
			created := &sfuBootstrapIntent{demandPeerID: viewer.peerID, demandSessionID: viewer.sessionID}
			c.sfuBootstrapIntent = created
			return created
		}
	}
	return nil
}

// bootstrapOperationOwned is checked first in validateOrAdvance
// so a bootstrap operation evaporates with its intent.
func (c *Controller) bootstrapOperationOwned(op *operation) bool {
	if op.reason != DemandSfuBootstrap {
		return true
	}
	intent := c.sfuBootstrapIntent
	if intent == nil ||
		intent.demandPeerID != op.demandPeerID ||
		intent.demandSessionID != op.demandSessionID ||
		!c.sfuBootstrapNeeded(op.demandPeerID) {
		return false
	}
	return slices.Contains(c.safeSfuBootstrapCarriers(op.demandPeerID), op.childPeerID)
}

func (c *Controller) sfuBootstrapNeeded(demandPeerID string) bool {
	if !c.sfuBootstrapGloballyNeeded() || !c.allowsIncoming(demandPeerID, UpstreamSfu) {
		return false
	}
	demand, _ := c.participants.Get(demandPeerID)
	return demand != nil && demand.sessionID != "" &&
		(!c.usableRoute(demandPeerID) || c.voiceRouteMissing(demandPeerID)) &&
		c.sfuOpportunityAvailable(demandPeerID)
}

func (c *Controller) sfuOpportunityAvailable(demandPeerID string) bool {
	return c.candidateOpportunityAvailable(demandPeerID, CandidatePlan{
		Tuple:              CandidateTuple{Kind: UpstreamSfu, Publication: PublicationReuse},
		EndpointTransition: EndpointTransition{Kind: TransitionNone},
	})
}

func (c *Controller) sfuBootstrapGloballyNeeded() bool {
	return c.sfuEnabled && c.hostPublication == nil && !c.hostHasPublicationSlot()
}

func (c *Controller) safeSfuBootstrapCarriers(demandPeerID string) []string {
	if !c.sfuBootstrapNeeded(demandPeerID) {
		return []string{}
	}
	return c.sfuBootstrapCarriers()
}

// sfuBootstrapCarriers returns the Host's usable direct children that
// can create a publication, newest first.
func (c *Controller) sfuBootstrapCarriers() []string {
	tuple := CandidateTuple{Kind: UpstreamSfu, Publication: PublicationCreate}
	carriers := []string{}
	for _, peerID := range c.childrenOf(c.hostPeerID) {
		current, _ := c.participants.Get(peerID)
		edge, _ := c.upstreamByViewer.Get(peerID)
		plan := c.planCandidate(peerID, tuple)
		if current != nil && current.sessionID != "" &&
			edge != nil && edge.Kind == UpstreamPeer &&
			edge.Transport == TransportDirect &&
			edge.Usable &&
			edge.PhysicalActive &&
			plan != nil &&
			c.candidateValid(peerID, *plan, nil) &&
			plan.EndpointTransition.Kind != TransitionBoundedGap &&
			c.sfuBootstrapOpportunityAvailable(peerID, *plan) {
			carriers = append(carriers, peerID)
		}
	}
	sort.SliceStable(carriers, func(i, j int) bool {
		left, _ := c.participants.Get(carriers[i])
		right, _ := c.participants.Get(carriers[j])
		return compareParticipant(right, left) < 0
	})
	return carriers
}

func (c *Controller) sfuBootstrapOpportunityAvailable(carrierPeerID string, plan CandidatePlan) bool {
	consumed, ok := c.consumedSfuBootstrapOpportunities.Get(c.sfuBootstrapOpportunityBase(carrierPeerID, plan))
	return !ok || endpointTransitionRank(plan.EndpointTransition) < consumed
}

func (c *Controller) sfuBootstrapOpportunityBase(carrierPeerID string, plan CandidatePlan) string {
	return carrierPeerID + "\x00" + c.candidateOpportunityBase(carrierPeerID, plan)
}

func (c *Controller) consumeSfuBootstrapOpportunity(carrierPeerID string, plan CandidatePlan) {
	consumeOpportunity(&c.consumedSfuBootstrapOpportunities,
		c.sfuBootstrapOpportunityBase(carrierPeerID, plan),
		endpointTransitionRank(plan.EndpointTransition))
}

// completeSfuBootstrapCarrier consumes the carrier's attempt
// and returns the failed demand peer only once no carrier is left.
func (c *Controller) completeSfuBootstrapCarrier(carrierPeerID string, nowMs int64, bucket RejectionBucket, attemptedPlan *CandidatePlan) string {
	intent := c.sfuBootstrapIntent
	if intent == nil {
		return ""
	}
	plan := attemptedPlan
	if plan == nil {
		plan = c.planCandidate(carrierPeerID, CandidateTuple{Kind: UpstreamSfu, Publication: PublicationCreate})
	}
	if plan != nil {
		c.consumeSfuBootstrapOpportunity(carrierPeerID, *plan)
		c.consumeCandidateOpportunity(carrierPeerID, *plan)
	}
	if len(c.safeSfuBootstrapCarriers(intent.demandPeerID)) > 0 {
		return ""
	}
	demand, _ := c.participants.Get(intent.demandPeerID)
	if demand != nil {
		demand.availabilityExhausted = true
	}
	c.finishTiming(intent.demandPeerID, nowMs, FinalRouteFailed, bucket, false)
	if demand != nil {
		demand.bootstrapFailureReported = true
	}
	c.sfuBootstrapIntent = nil
	return intent.demandPeerID
}

// reportSfuBootstrapFailures follows availableViewers order.
func (c *Controller) reportSfuBootstrapFailures(nowMs int64, failedPeerIDs *[]string) {
	for _, demand := range c.availableViewers(true) {
		if !demand.availabilityExhausted ||
			!c.sfuBootstrapNeeded(demand.peerID) ||
			c.usableRoute(demand.peerID) ||
			demand.bootstrapFailureReported {
			continue
		}
		demand.bootstrapFailureReported = true
		c.finishTiming(demand.peerID, nowMs, FinalRouteFailed, RejectionCandidateFailed, false)
		*failedPeerIDs = append(*failedPeerIDs, demand.peerID)
	}
}

func (c *Controller) rememberUnavailableSfuBootstrap(demandPeerID string) {
	if !c.sfuBootstrapNeeded(demandPeerID) {
		return
	}
	demand, _ := c.participants.Get(demandPeerID)
	if demand == nil || demand.sessionID == "" {
		return
	}
	demand.bootstrapFailureReported = true
	c.sfuBootstrapIntent = nil
}

func (c *Controller) stageSfuBootstrap(op *operation) {
	demand, _ := c.participants.Get(op.demandPeerID)
	if demand == nil || demand.sessionID == "" || !c.sfuBootstrapNeeded(demand.peerID) {
		return
	}
	if len(c.safeSfuBootstrapCarriers(demand.peerID)) == 0 {
		return
	}
	if current := c.sfuBootstrapIntent; current != nil &&
		current.demandPeerID == demand.peerID &&
		current.demandSessionID == demand.sessionID {
		return
	}
	c.sfuBootstrapIntent = &sfuBootstrapIntent{demandPeerID: demand.peerID, demandSessionID: demand.sessionID}
}

func (c *Controller) clearSfuBootstrapForDemand(demandPeerID string) {
	if demand, ok := c.participants.Get(demandPeerID); ok {
		demand.sfuFirstAtNextRoute = false
	}
	if c.sfuBootstrapIntent != nil && c.sfuBootstrapIntent.demandPeerID == demandPeerID {
		c.sfuBootstrapIntent = nil
	}
}

func (c *Controller) bootstrapCandidateAvailable(demandPeerID string) bool {
	return len(c.safeSfuBootstrapCarriers(demandPeerID)) > 0
}
