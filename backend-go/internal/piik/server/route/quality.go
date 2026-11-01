package route

import (
	"sort"

	"zviewer/backend/internal/piik/server/ordered"
)

// ObserveQualityEvidence aggregates one receiver-side window onto the
// child's committed edge: rejected on any mismatch, accepted when consumed
// without aggregation, observed when aggregated.
func (c *Controller) ObserveQualityEvidence(input RouteQualityEvidenceInput) RouteQualityEvidenceResult {
	if c.paused || !c.videoWorkEnabled() ||
		input.RouteRevision != c.revision ||
		!isSafeInteger(input.PresentationEpoch) ||
		input.PresentationEpoch < 0 ||
		!isSafeInteger(input.WindowMs) ||
		input.WindowMs <= 0 ||
		!isSafeInteger(input.AcceptedAtMs) ||
		input.AcceptedAtMs < 0 {
		return QualityEvidenceRejected
	}
	child, _ := c.participants.Get(input.ChildPeerID)
	edge, _ := c.upstreamByViewer.Get(input.ChildPeerID)
	if child == nil ||
		!child.sessionIs(input.ChildSessionID) ||
		edge == nil ||
		!edge.Usable ||
		!edge.PhysicalActive ||
		edge.ChildSessionID != input.ChildSessionID ||
		c.qualityConnectionID(edge) != input.ConnectionID ||
		!qualityUpstreamMatches(edge, input.Upstream) ||
		!c.sourceUsableForQuality(edge) {
		return QualityEvidenceRejected
	}

	upstreamPeerID := ""
	if input.Upstream.Kind == UpstreamPeer {
		upstreamPeerID = input.Upstream.PeerID
	}
	observation := c.qualityObservations[input.ChildPeerID]
	sameEdgeObservation := observation != nil &&
		observation.childSessionID == input.ChildSessionID &&
		observation.upstreamKind == input.Upstream.Kind &&
		observation.upstreamPeerID == upstreamPeerID &&
		observation.connectionID == input.ConnectionID
	if sameEdgeObservation && input.PresentationEpoch < observation.presentationEpoch {
		return QualityEvidenceRejected
	}
	if !sameEdgeObservation || observation.presentationEpoch != input.PresentationEpoch {
		observation = &routeQualityObservation{
			childSessionID:    input.ChildSessionID,
			upstreamKind:      input.Upstream.Kind,
			upstreamPeerID:    upstreamPeerID,
			connectionID:      input.ConnectionID,
			presentationEpoch: input.PresentationEpoch,
			lastAcceptedAtMs:  input.AcceptedAtMs,
		}
		c.qualityObservations[input.ChildPeerID] = observation
	}

	metrics := input.Metrics
	if metrics.FramesDecodedDelta == nil || *metrics.FramesDecodedDelta <= 0 {
		return QualityEvidenceAccepted
	}
	hadFreshDecodedProgress := observation.lastDecodedProgressAtMs != nil &&
		input.AcceptedAtMs < *observation.lastDecodedProgressAtMs+qualityEvidenceExpiryMs
	decodedAt := input.AcceptedAtMs
	observation.lastDecodedProgressAtMs = &decodedAt
	if !hadFreshDecodedProgress && edge.Kind == UpstreamSfu {
		c.touchFacts()
	}
	if metrics.FreezeCountDelta == nil ||
		metrics.FreezeDurationMsDelta == nil ||
		metrics.PauseCountDelta == nil ||
		metrics.PauseDurationMsDelta == nil {
		return QualityEvidenceAccepted
	}
	observation.lastAcceptedAtMs = input.AcceptedAtMs
	if _, pending := c.qualityBaselinesPending[input.ChildPeerID]; pending {
		delete(c.qualityBaselinesPending, input.ChildPeerID)
		return QualityEvidenceAccepted
	}

	observation.eligibleWindows = safeAdd(observation.eligibleWindows, 1)
	observation.eligibleDurationMs = safeAdd(observation.eligibleDurationMs, float64(input.WindowMs))
	if *metrics.FreezeCountDelta > 0 {
		observation.freezeWindows = safeAdd(observation.freezeWindows, 1)
	}
	observation.freezeCount = safeAdd(observation.freezeCount, float64(*metrics.FreezeCountDelta))
	observation.freezeDurationMs = safeAdd(observation.freezeDurationMs, float64(*metrics.FreezeDurationMsDelta))
	observation.pauseCount = safeAdd(observation.pauseCount, float64(*metrics.PauseCountDelta))
	observation.pauseDurationMs = safeAdd(observation.pauseDurationMs, float64(*metrics.PauseDurationMsDelta))
	return QualityEvidenceObserved
}

// senderAccepted is the `accepted: true, committed: false` literal.
func (c *Controller) senderAccepted(released []*Resource) SenderQualityEvidenceResult {
	return SettleResult{
		Accepted:       true,
		Committed:      false,
		FailedPeerIDs:  []string{},
		ActiveRevision: c.revision,
		Released:       released,
	}
}

// senderRejected is the `rejected()` literal.
func (c *Controller) senderRejected() SenderQualityEvidenceResult {
	return SettleResult{
		Accepted:       false,
		Committed:      false,
		FailedPeerIDs:  []string{},
		ActiveRevision: c.revision,
		Released:       []*Resource{},
	}
}

// ObserveSenderQualityEvidence records a parent's health sample for a child,
// settling the live quality/root candidate when the sample names it; a nil
// commitReservation always commits. Requires QualityConvergenceEnabled.
func (c *Controller) ObserveSenderQualityEvidence(input SenderQualityEvidenceInput, commitReservation func(CandidateReservation) bool) SenderQualityEvidenceResult {
	if commitReservation == nil {
		commitReservation = func(CandidateReservation) bool { return true }
	}
	if !c.qualityConvergenceEnabled ||
		(c.paused || !c.videoWorkEnabled()) ||
		!isSafeInteger(input.AcceptedAtMs) ||
		input.AcceptedAtMs < 0 {
		return c.senderRejected()
	}
	parent, _ := c.participants.Get(input.ParentPeerID)
	child, _ := c.participants.Get(input.ChildPeerID)
	if parent == nil || parent.sessionID == "" ||
		!parent.sessionIs(input.ParentSessionID) ||
		child == nil || child.sessionID == "" ||
		child.departureConfirmed ||
		parent.departureConfirmed {
		return c.senderRejected()
	}

	op := c.operation
	var att *attempt
	if op != nil {
		att = op.current
	}
	if op != nil &&
		(op.reason == DemandRootConvergence || op.reason == DemandQualityConvergence) &&
		att != nil && att.tuple.Kind == UpstreamPeer &&
		op.childPeerID == input.ChildPeerID &&
		op.childSessionID == child.sessionID &&
		att.tuple.ParentPeerID == input.ParentPeerID &&
		att.parentSessionID == input.ParentSessionID &&
		att.connectionID == input.ConnectionID &&
		att.revision == input.RouteRevision {
		senderIdentity := ""
		if input.SenderIdentity != nil {
			senderIdentity = *input.SenderIdentity
		}
		return c.settleCandidateQuality(op, att, input.State, input.AcceptedAtMs, senderIdentity, input.SampleTimestampMs, commitReservation)
	}

	edge, _ := c.upstreamByViewer.Get(input.ChildPeerID)
	if input.RouteRevision != c.revision ||
		edge == nil || edge.Kind != UpstreamPeer ||
		!edge.Usable ||
		!edge.PhysicalActive ||
		edge.ParentPeerID != input.ParentPeerID ||
		edge.ParentSessionID != input.ParentSessionID ||
		edge.ChildSessionID != child.sessionID ||
		c.qualityConnectionID(edge) != input.ConnectionID {
		return c.senderRejected()
	}
	previous := c.senderQualityObservations[input.ChildPeerID]
	sameConnectionIdentity := previous != nil &&
		previous.childSessionID == child.sessionID &&
		previous.parentPeerID == input.ParentPeerID &&
		previous.parentSessionID == input.ParentSessionID &&
		previous.connectionID == input.ConnectionID
	if input.State == SenderQualityUnknown {
		if previous != nil && previous.state != SenderQualityUnknown {
			c.debug("sender-quality-reset",
				"parent", c.debugPeer(input.ParentPeerID),
				"child", c.debugPeer(input.ChildPeerID))
		}
		if previous != nil && sameConnectionIdentity {
			// `{...previous}` keeps the same consumed ledger pointer.
			reset := *previous
			reset.state = SenderQualityUnknown
			reset.consecutiveDegradedWindows = 0
			reset.lastAcceptedAtMs = input.AcceptedAtMs
			c.senderQualityObservations[input.ChildPeerID] = &reset
		} else {
			delete(c.senderQualityObservations, input.ChildPeerID)
		}
		return c.senderAccepted([]*Resource{})
	}
	if input.SenderIdentity == nil || *input.SenderIdentity == "" || input.SampleTimestampMs == nil {
		return c.senderRejected()
	}
	senderIdentity := *input.SenderIdentity
	sampleTimestampMs := *input.SampleTimestampMs
	sameSenderIdentity := sameConnectionIdentity && previous.senderIdentity == senderIdentity
	if sameSenderIdentity && sampleTimestampMs <= previous.lastSampleTimestampMs {
		return c.senderAccepted([]*Resource{})
	}
	if block, ok := c.senderQualityRegenerationBlocks[input.ChildPeerID]; ok &&
		!senderQualityRegenerationBlockMatches(block, child.sessionID, input, senderIdentity) {
		// A new connection or sender identity is a new generation. Do not carry
		// a same-edge regeneration latch across that identity fence.
		delete(c.senderQualityRegenerationBlocks, input.ChildPeerID)
	}
	if input.State == SenderQualityHealthy {
		delete(c.senderQualityRegenerationBlocks, input.ChildPeerID)
	}
	sameFreshSenderIdentity := sameSenderIdentity &&
		input.AcceptedAtMs < previous.lastAcceptedAtMs+qualityEvidenceExpiryMs
	if input.State == SenderQualityHealthy {
		delete(c.senderQualityBaselines, input.ChildPeerID)
	}
	var consecutiveDegradedWindows int64
	if input.State == SenderQualityDegraded {
		consecutiveDegradedWindows = 1
		if sameFreshSenderIdentity && previous.state == SenderQualityDegraded {
			consecutiveDegradedWindows = safeAdd(previous.consecutiveDegradedWindows, 1)
		}
	}
	consumed := &ordered.Map[string, int]{}
	if sameSenderIdentity && input.State != SenderQualityHealthy {
		consumed = previous.consumedQualityCandidates
	}
	c.senderQualityObservations[input.ChildPeerID] = &senderQualityObservation{
		childSessionID:             child.sessionID,
		parentPeerID:               input.ParentPeerID,
		parentSessionID:            input.ParentSessionID,
		connectionID:               input.ConnectionID,
		senderIdentity:             senderIdentity,
		state:                      input.State,
		consecutiveDegradedWindows: consecutiveDegradedWindows,
		lastSampleTimestampMs:      sampleTimestampMs,
		lastAcceptedAtMs:           input.AcceptedAtMs,
		consumedQualityCandidates:  consumed,
	}
	if !sameFreshSenderIdentity ||
		previous.state != input.State ||
		consecutiveDegradedWindows == persistentDegradedWindows {
		c.debug("sender-quality-observed",
			"parent", c.debugPeer(input.ParentPeerID),
			"child", c.debugPeer(input.ChildPeerID),
			"state", input.State,
			"consecutiveDegradedWindows", consecutiveDegradedWindows)
	}
	if input.State == SenderQualityHealthy &&
		op != nil && op.reason == DemandQualityConvergence &&
		op.childPeerID == input.ChildPeerID {
		released := c.abortOperation(&input.AcceptedAtMs, RejectionAborted)
		return c.senderAccepted(released)
	}
	return c.senderAccepted([]*Resource{})
}

func senderQualityRegenerationBlockMatches(block senderQualityIdentity, childSessionID string, input SenderQualityEvidenceInput, senderIdentity string) bool {
	return block.childSessionID == childSessionID &&
		block.parentPeerID == input.ParentPeerID &&
		block.parentSessionID == input.ParentSessionID &&
		block.connectionID == input.ConnectionID &&
		block.senderIdentity == senderIdentity
}

// ObserveSfuPublisherQualityEvidence records a Host->SFU ingress sample,
// settling a live sfu/reuse quality candidate; a nil commitReservation
// always commits. Requires QualityConvergenceEnabled. Unlike the other two
// observers it validates no numbers.
func (c *Controller) ObserveSfuPublisherQualityEvidence(input SfuPublisherQualityEvidenceInput, commitReservation func(CandidateReservation) bool) SenderQualityEvidenceResult {
	if commitReservation == nil {
		commitReservation = func(CandidateReservation) bool { return true }
	}
	host, _ := c.participants.Get(c.hostPeerID)
	if !c.qualityConvergenceEnabled ||
		(c.paused || !c.videoWorkEnabled()) ||
		input.HostPeerID != c.hostPeerID ||
		host == nil || host.sessionID == "" ||
		!host.sessionIs(input.HostSessionID) {
		return c.senderRejected()
	}
	op := c.operation
	var att *attempt
	if op != nil {
		att = op.current
	}
	if op != nil && op.reason == DemandQualityConvergence &&
		att != nil && att.tuple.Kind == UpstreamSfu &&
		att.hostSessionID == input.HostSessionID &&
		att.publicationGeneration == input.PublicationGeneration &&
		att.revision == input.RouteRevision {
		return c.settleCandidateQuality(op, att, input.State, input.AcceptedAtMs, input.PublicationGeneration, input.SampleTimestampMs, commitReservation)
	}
	if input.RouteRevision != c.revision ||
		c.hostPublication == nil || !c.hostPublication.Usable ||
		!c.hostPublication.PhysicalActive ||
		c.hostPublication.HostSessionID != input.HostSessionID ||
		c.hostPublication.Generation != input.PublicationGeneration {
		return c.senderRejected()
	}
	if input.State == SenderQualityUnknown {
		if c.sfuPublisherQualityObservation != nil {
			c.debug("sfu-publisher-quality-reset")
		}
		c.sfuPublisherQualityObservation = nil
		return c.senderAccepted([]*Resource{})
	}
	if input.SampleTimestampMs == nil {
		return c.senderRejected()
	}
	sampleTimestampMs := *input.SampleTimestampMs
	previous := c.sfuPublisherQualityObservation
	samePublication := previous != nil &&
		previous.hostSessionID == input.HostSessionID &&
		previous.publicationGeneration == input.PublicationGeneration
	if samePublication && sampleTimestampMs <= previous.lastSampleTimestampMs {
		return c.senderAccepted([]*Resource{})
	}
	sameFreshPublication := samePublication &&
		input.AcceptedAtMs < previous.lastAcceptedAtMs+qualityEvidenceExpiryMs
	var consecutiveHealthyWindows int64
	if input.State == SenderQualityHealthy {
		consecutiveHealthyWindows = 1
		if sameFreshPublication && previous.state == SenderQualityHealthy {
			consecutiveHealthyWindows = safeAdd(previous.consecutiveHealthyWindows, 1)
		}
	}
	wasPersistentlyHealthy := sameFreshPublication &&
		previous.state == SenderQualityHealthy &&
		previous.consecutiveHealthyWindows >= persistentDegradedWindows
	c.sfuPublisherQualityObservation = &sfuPublisherQualityObservation{
		hostSessionID:             input.HostSessionID,
		publicationGeneration:     input.PublicationGeneration,
		state:                     input.State,
		consecutiveHealthyWindows: consecutiveHealthyWindows,
		lastSampleTimestampMs:     sampleTimestampMs,
		lastAcceptedAtMs:          input.AcceptedAtMs,
	}
	if !samePublication ||
		previous.state != input.State ||
		consecutiveHealthyWindows == persistentDegradedWindows {
		c.debug("sfu-publisher-quality-observed",
			"state", input.State,
			"consecutiveHealthyWindows", consecutiveHealthyWindows)
	}
	if input.State == SenderQualityHealthy &&
		consecutiveHealthyWindows >= persistentDegradedWindows &&
		!wasPersistentlyHealthy {
		c.touchFacts()
	}
	if op != nil && op.reason == DemandQualityConvergence &&
		att != nil && att.tuple.Kind == UpstreamSfu &&
		att.tuple.Publication == PublicationReuse &&
		att.hostSessionID == input.HostSessionID &&
		att.publicationGeneration == input.PublicationGeneration &&
		att.mediaReady {
		guard := CandidateGuard{
			ChildPeerID:    op.childPeerID,
			ChildSessionID: op.childSessionID,
			Revision:       att.revision,
			ConnectionID:   att.connectionID,
		}
		var settled *SettleResult
		if input.State == SenderQualityDegraded {
			result := c.CandidateFailed(guard, input.AcceptedAtMs)
			settled = &result
		} else if consecutiveHealthyWindows >= persistentDegradedWindows {
			result := c.CandidateReady(guard, input.AcceptedAtMs, commitReservation, CandidateProof{VideoGeneration: op.videoGeneration})
			settled = &result
		}
		if settled != nil {
			return SettleResult{
				Accepted:       settled.Accepted,
				Committed:      settled.Committed,
				FailedPeerIDs:  settled.FailedPeerIDs,
				ActiveRevision: settled.ActiveRevision,
				Released:       settled.Released,
			}
		}
	}
	return c.senderAccepted([]*Resource{})
}

// settleCandidateQuality folds a sender sample into the live
// candidate and fails or commits it. An empty senderIdentity means unknown.
func (c *Controller) settleCandidateQuality(op *operation, att *attempt, state SenderQualityState, acceptedAtMs int64, senderIdentity string, sampleTimestampMs *int64, commitReservation func(CandidateReservation) bool) SenderQualityEvidenceResult {
	if att.senderQualityState != state {
		c.debug("candidate-quality-observed",
			"child", c.debugPeer(op.childPeerID),
			"candidate", c.debugTuple(att.tuple),
			"state", state)
	}
	if state == SenderQualityUnknown {
		att.senderQualityState = ""
		att.senderQualityAcceptedAtMs = nil
		att.senderQualityConsecutiveHealthyWindows = 0
		att.senderQualityConsecutiveDegradedWindows = 0
		att.senderQualitySampleTimestampMs = nil
		return c.senderAccepted([]*Resource{})
	}
	if senderIdentity == "" || sampleTimestampMs == nil {
		return c.senderRejected()
	}
	guard := CandidateGuard{
		ChildPeerID:    op.childPeerID,
		ChildSessionID: op.childSessionID,
		Revision:       att.revision,
		ConnectionID:   att.connectionID,
	}
	if att.senderQualityIdentity != "" && att.senderQualityIdentity != senderIdentity {
		failed := c.CandidateFailed(guard, acceptedAtMs)
		return SettleResult{
			Accepted:       failed.Accepted,
			Committed:      failed.Committed,
			FailedPeerIDs:  failed.FailedPeerIDs,
			ActiveRevision: failed.ActiveRevision,
			Released:       failed.Released,
		}
	}
	if att.senderQualitySampleTimestampMs != nil && *sampleTimestampMs <= *att.senderQualitySampleTimestampMs {
		return c.senderAccepted([]*Resource{})
	}
	sameFreshState := att.senderQualityAcceptedAtMs != nil &&
		acceptedAtMs < *att.senderQualityAcceptedAtMs+qualityEvidenceExpiryMs
	var consecutiveHealthyWindows int64
	if att.tuple.Kind == UpstreamSfu && state == SenderQualityHealthy {
		consecutiveHealthyWindows = 1
		if att.senderQualityState == SenderQualityHealthy && sameFreshState {
			consecutiveHealthyWindows = safeAdd(att.senderQualityConsecutiveHealthyWindows, 1)
		}
	} else if state == SenderQualityHealthy {
		consecutiveHealthyWindows = 1
	}
	var consecutiveDegradedWindows int64
	if state == SenderQualityDegraded {
		consecutiveDegradedWindows = 1
		if att.senderQualityState == SenderQualityDegraded && sameFreshState {
			consecutiveDegradedWindows = safeAdd(att.senderQualityConsecutiveDegradedWindows, 1)
		}
	}
	acceptedAt := acceptedAtMs
	sampleAt := *sampleTimestampMs
	att.senderQualityState = state
	att.senderQualityAcceptedAtMs = &acceptedAt
	att.senderQualityConsecutiveHealthyWindows = consecutiveHealthyWindows
	att.senderQualityConsecutiveDegradedWindows = consecutiveDegradedWindows
	att.senderQualitySampleTimestampMs = &sampleAt
	att.senderQualityIdentity = senderIdentity
	persistentQualityPeerDegradation := op.reason == DemandQualityConvergence &&
		att.tuple.Kind == UpstreamPeer &&
		consecutiveDegradedWindows >= persistentDegradedWindows
	var settled *SettleResult
	if state == SenderQualityDegraded &&
		(att.tuple.Kind != UpstreamPeer ||
			op.reason != DemandQualityConvergence ||
			persistentQualityPeerDegradation) {
		result := c.CandidateFailed(guard, acceptedAtMs)
		settled = &result
	} else if att.mediaReady &&
		(att.tuple.Kind != UpstreamSfu || consecutiveHealthyWindows >= persistentDegradedWindows) {
		result := c.CandidateReady(guard, acceptedAtMs, commitReservation, CandidateProof{VideoGeneration: op.videoGeneration})
		settled = &result
	}
	if settled == nil {
		return c.senderAccepted([]*Resource{})
	}
	return SettleResult{
		Accepted:       true,
		Committed:      settled.Committed,
		FailedPeerIDs:  settled.FailedPeerIDs,
		ActiveRevision: settled.ActiveRevision,
		Released:       settled.Released,
	}
}

// ResetSenderQuality drops the parent's sender observations, baselines and
// regeneration latches and aborts an operation whose live candidate that
// parent owns; empty unless the parent's session matches.
func (c *Controller) ResetSenderQuality(parentPeerID, parentSessionID string, nowMs int64) []*Resource {
	parent, _ := c.participants.Get(parentPeerID)
	if parent == nil || !parent.sessionIs(parentSessionID) {
		return []*Resource{}
	}
	// Membership only: every affected child is deleted.
	children := make(map[string]struct{})
	for _, childPeerID := range c.childrenOf(parentPeerID) {
		children[childPeerID] = struct{}{}
	}
	for childPeerID, observation := range c.senderQualityObservations {
		if observation.parentPeerID == parentPeerID && observation.parentSessionID == parentSessionID {
			children[childPeerID] = struct{}{}
		}
	}
	for childPeerID := range children {
		delete(c.senderQualityObservations, childPeerID)
		// Reset means the next exact sender sequence is a new observation
		// window. A quality/root commit still installs the explicit rearm latch
		// below; a visibility or source reset must not deadlock a persistently
		// limited edge waiting for a healthy sample.
		delete(c.senderQualityBaselines, childPeerID)
		delete(c.senderQualityRegenerationBlocks, childPeerID)
	}
	if parentPeerID == c.hostPeerID {
		c.sfuPublisherQualityObservation = nil
	}
	op := c.operation
	var att *attempt
	if op != nil {
		att = op.current
	}
	ownsCandidate := false
	if att != nil {
		if att.tuple.Kind == UpstreamPeer {
			ownsCandidate = (op.reason == DemandRootConvergence || op.reason == DemandQualityConvergence) &&
				att.tuple.ParentPeerID == parentPeerID &&
				att.parentSessionID == parentSessionID
		} else {
			ownsCandidate = operationRequiresNativeCandidateProof(op) &&
				parentPeerID == c.hostPeerID &&
				att.hostSessionID == parentSessionID
		}
	}
	if ownsCandidate {
		return c.abortOperation(&nowMs, RejectionAborted)
	}
	return []*Resource{}
}

func (c *Controller) senderQualityState(childPeerID string, edge *CommittedEdge, nowMs int64) SenderQualityState {
	if edge.Kind != UpstreamPeer {
		if c.sourceUsableForQuality(edge) {
			return SenderQualityHealthy
		}
		return SenderQualityUnknown
	}
	observation := c.senderQualityObservations[childPeerID]
	child, _ := c.participants.Get(childPeerID)
	if observation != nil &&
		nowMs < observation.lastAcceptedAtMs+qualityEvidenceExpiryMs &&
		child != nil && child.sessionIs(observation.childSessionID) &&
		edge.ChildSessionID == observation.childSessionID &&
		edge.ParentPeerID == observation.parentPeerID &&
		edge.ParentSessionID == observation.parentSessionID &&
		c.qualityConnectionID(edge) == observation.connectionID &&
		c.sourceUsableForQuality(edge) {
		return observation.state
	}
	return SenderQualityUnknown
}

func (c *Controller) currentQualityOperationSource(childPeerID string) *senderQualityIdentity {
	child, _ := c.participants.Get(childPeerID)
	edge, _ := c.upstreamByViewer.Get(childPeerID)
	observation := c.senderQualityObservations[childPeerID]
	if child == nil || child.sessionID == "" ||
		edge == nil || edge.Kind != UpstreamPeer ||
		observation == nil ||
		observation.childSessionID != child.sessionID ||
		observation.childSessionID != edge.ChildSessionID ||
		observation.parentPeerID != edge.ParentPeerID ||
		observation.parentSessionID != edge.ParentSessionID ||
		observation.connectionID != c.qualityConnectionID(edge) {
		return nil
	}
	return &senderQualityIdentity{
		childSessionID:  observation.childSessionID,
		parentPeerID:    observation.parentPeerID,
		parentSessionID: observation.parentSessionID,
		connectionID:    observation.connectionID,
		senderIdentity:  observation.senderIdentity,
	}
}

func (c *Controller) currentQualityOperationObservation(op *operation) *senderQualityObservation {
	source := op.qualitySource
	current := c.currentQualityOperationSource(op.childPeerID)
	if source == nil || current == nil || *source != *current {
		return nil
	}
	return c.senderQualityObservations[op.childPeerID]
}

func (c *Controller) senderQualityRegenerationBlocked(childPeerID string, edge *CommittedEdge) bool {
	block, ok := c.senderQualityRegenerationBlocks[childPeerID]
	if !ok {
		return false
	}
	observation := c.senderQualityObservations[childPeerID]
	if observation != nil && observation.senderIdentity != block.senderIdentity {
		delete(c.senderQualityRegenerationBlocks, childPeerID)
		return false
	}
	if block.childSessionID != edge.ChildSessionID ||
		block.parentPeerID != edge.ParentPeerID ||
		block.parentSessionID != edge.ParentSessionID ||
		block.connectionID != c.qualityConnectionID(edge) {
		delete(c.senderQualityRegenerationBlocks, childPeerID)
		return false
	}
	return true
}

func (c *Controller) candidateSenderPersistentlyDegraded(att *attempt, nowMs int64) bool {
	return att.senderQualityState == SenderQualityDegraded &&
		att.senderQualityAcceptedAtMs != nil &&
		nowMs < *att.senderQualityAcceptedAtMs+qualityEvidenceExpiryMs &&
		att.senderQualityConsecutiveDegradedWindows >= persistentDegradedWindows
}

func (c *Controller) sfuPublisherQualityState(publicationGeneration string, nowMs int64) SenderQualityState {
	observation := c.sfuPublisherQualityObservation
	if observation != nil &&
		observation.publicationGeneration == publicationGeneration &&
		c.hostPublication != nil && observation.hostSessionID == c.hostPublication.HostSessionID &&
		nowMs < observation.lastAcceptedAtMs+qualityEvidenceExpiryMs {
		if observation.state == SenderQualityHealthy && observation.consecutiveHealthyWindows < persistentDegradedWindows {
			return SenderQualityUnknown
		}
		return observation.state
	}
	return SenderQualityUnknown
}

func (c *Controller) qualitySourcePathHealthy(peerID string, nowMs int64) bool {
	if peerID == c.hostPeerID {
		return true
	}
	seen := make(map[string]struct{})
	for {
		if _, visited := seen[peerID]; visited {
			return false
		}
		seen[peerID] = struct{}{}
		edge, _ := c.upstreamByViewer.Get(peerID)
		if edge == nil || !edge.Usable || !edge.PhysicalActive {
			return false
		}
		if edge.Kind == UpstreamSfu {
			return c.sourceUsableForQuality(edge) &&
				c.decodedProgressFresh(peerID, edge, nowMs) &&
				c.sfuPublisherQualityState(edge.PublicationGeneration, nowMs) == SenderQualityHealthy
		}
		if c.senderQualityState(peerID, edge, nowMs) != SenderQualityHealthy {
			return false
		}
		if edge.ParentPeerID == c.hostPeerID {
			return true
		}
		peerID = edge.ParentPeerID
	}
}

func (c *Controller) decodedProgressFresh(childPeerID string, edge *CommittedEdge, nowMs int64) bool {
	observation := c.qualityObservations[childPeerID]
	current, _ := c.participants.Get(childPeerID)
	return observation != nil &&
		observation.lastDecodedProgressAtMs != nil &&
		nowMs < *observation.lastDecodedProgressAtMs+qualityEvidenceExpiryMs &&
		current != nil && current.sessionIs(observation.childSessionID) &&
		edge.ChildSessionID == observation.childSessionID &&
		c.qualityConnectionID(edge) == observation.connectionID &&
		qualityObservationMatchesEdge(observation, edge) &&
		c.sourceUsableForQuality(edge)
}

// buildQualityCandidates orders clear peers, remaining peers, SFU
// (only under Host fanout relief), same-parent regeneration,
// filtered by the per-observation consumed ledger.
func (c *Controller) buildQualityCandidates(childPeerID string, nowMs int64) []CandidatePlan {
	current, _ := c.upstreamByViewer.Get(childPeerID)
	if current == nil || current.Kind != UpstreamPeer {
		return []CandidatePlan{}
	}
	currentKey := edgeTupleKey(current)
	candidates := []CandidatePlan{}
	for _, candidate := range c.buildCandidatePlans(childPeerID, false, false) {
		if candidate.EndpointTransition.Kind == TransitionBoundedGap || tupleKey(candidate.Tuple) == currentKey {
			continue
		}
		if candidate.Tuple.Kind == UpstreamPeer ||
			candidate.Tuple.Publication != PublicationReuse ||
			(c.hostPublication != nil && c.sfuPublisherQualityState(c.hostPublication.Generation, nowMs) == SenderQualityHealthy) {
			candidates = append(candidates, candidate)
		}
	}
	clearPeers := []CandidatePlan{}
	remainingPeers := []CandidatePlan{}
	sfu := []CandidatePlan{}
	for _, candidate := range candidates {
		if candidate.Tuple.Kind != UpstreamPeer {
			sfu = append(sfu, candidate)
			continue
		}
		if c.qualitySourcePathHealthy(candidate.Tuple.ParentPeerID, nowMs) {
			clearPeers = append(clearPeers, candidate)
		} else {
			remainingPeers = append(remainingPeers, candidate)
		}
	}
	if !(current.ParentPeerID == c.hostPeerID && c.hostFanoutNeedsSfuRelief(nowMs)) {
		sfu = nil
	}
	regeneration := []CandidatePlan{}
	if !c.senderQualityRegenerationBlocked(childPeerID, current) {
		regenerationTuple := CandidateTuple{Kind: UpstreamPeer, ParentPeerID: current.ParentPeerID, Transport: TransportDirect, Regenerate: true}
		if plan := c.planCandidate(childPeerID, regenerationTuple); plan != nil &&
			plan.EndpointTransition.Kind != TransitionBoundedGap &&
			c.candidateValid(childPeerID, *plan, nil) {
			regeneration = append(regeneration, *plan)
		}
	}
	prioritized := make([]CandidatePlan, 0, len(candidates)+1)
	prioritized = append(prioritized, clearPeers...)
	prioritized = append(prioritized, remainingPeers...)
	prioritized = append(prioritized, sfu...)
	prioritized = append(prioritized, regeneration...)
	out := make([]CandidatePlan, 0, len(prioritized))
	for _, candidate := range prioritized {
		if c.qualityCandidateOpportunityAvailable(childPeerID, candidate) {
			out = append(out, candidate)
		}
	}
	return out
}

func (c *Controller) selectQualityChild(nowMs int64) string {
	if !c.qualityConvergenceEnabled {
		return ""
	}
	targets := []*participant{}
	for _, viewer := range c.availableViewers(false) {
		edge, _ := c.upstreamByViewer.Get(viewer.peerID)
		if edge != nil && edge.Kind == UpstreamPeer &&
			!c.senderQualityBaselines[viewer.peerID] && // `get(...) !== true`
			c.senderQualityPersistentlyDegraded(viewer.peerID, edge, nowMs) &&
			len(c.buildQualityCandidates(viewer.peerID, nowMs)) > 0 {
			targets = append(targets, viewer)
		}
	}
	sort.SliceStable(targets, func(i, j int) bool {
		if d := c.depth(targets[i].peerID) - c.depth(targets[j].peerID); d != 0 {
			return d < 0
		}
		return compareParticipant(targets[i], targets[j]) < 0
	})
	if len(targets) == 0 {
		return ""
	}
	return targets[0].peerID
}

func (c *Controller) senderQualityPersistentlyDegraded(childPeerID string, edge *CommittedEdge, nowMs int64) bool {
	observation := c.senderQualityObservations[childPeerID]
	return c.senderQualityState(childPeerID, edge, nowMs) == SenderQualityDegraded &&
		observation != nil &&
		observation.consecutiveDegradedWindows >= persistentDegradedWindows
}

func (c *Controller) qualityOperationStillEligible(op *operation, nowMs int64) bool {
	currentEdge, _ := c.upstreamByViewer.Get(op.childPeerID)
	observation := c.currentQualityOperationObservation(op)
	tuple := op.currentTuple()
	if currentEdge == nil || currentEdge.Kind != UpstreamPeer || tuple == nil || observation == nil {
		return false
	}
	state := c.senderQualityState(op.childPeerID, currentEdge, nowMs)
	if state == SenderQualityHealthy {
		return false
	}
	return tuple.Kind == UpstreamPeer ||
		(state == SenderQualityDegraded && c.hostFanoutNeedsSfuRelief(nowMs))
}

func (c *Controller) hostFanoutNeedsSfuRelief(nowMs int64) bool {
	count := 0
	for childPeerID, edge := range c.upstreamByViewer.All() {
		if edge.Kind != UpstreamPeer || edge.ParentPeerID != c.hostPeerID || !edge.Usable || !edge.PhysicalActive {
			continue
		}
		count++
		if !c.senderQualityPersistentlyDegraded(childPeerID, edge, nowMs) {
			return false
		}
	}
	return count >= 2
}

func qualityUpstreamMatches(edge *CommittedEdge, upstream QualityUpstream) bool {
	if edge.Kind == UpstreamPeer {
		return upstream.Kind == UpstreamPeer && upstream.PeerID == edge.ParentPeerID
	}
	return upstream.Kind == UpstreamSfu
}

// qualityObservationMatchesEdge requires an empty upstreamPeerID for SFU.
func qualityObservationMatchesEdge(observation *routeQualityObservation, edge *CommittedEdge) bool {
	if edge.Kind == UpstreamPeer {
		return observation.upstreamKind == UpstreamPeer && observation.upstreamPeerID == edge.ParentPeerID
	}
	return observation.upstreamKind == UpstreamSfu && observation.upstreamPeerID == ""
}

func (c *Controller) sourceUsableForQuality(edge *CommittedEdge) bool {
	if edge.Kind == UpstreamPeer {
		parent, _ := c.participants.Get(edge.ParentPeerID)
		return parent != nil && parent.sessionIs(edge.ParentSessionID) && c.sourceUsable(edge.ParentPeerID)
	}
	return c.hostPublication != nil && c.hostPublication.Usable &&
		c.hostPublication.PhysicalActive &&
		c.hostPublication.Generation == edge.PublicationGeneration
}

// clearQualityForParticipant clears every child for the Host; a
// viewer clears its subtree plus itself.
func (c *Controller) clearQualityForParticipant(peerID string) {
	var affected []string
	if peerID == c.hostPeerID {
		affected = c.upstreamByViewer.Keys()
	} else {
		affected = withSelf(c.descendantsOf(peerID), peerID)
	}
	for _, childPeerID := range affected {
		delete(c.qualityObservations, childPeerID)
		delete(c.senderQualityObservations, childPeerID)
		delete(c.senderQualityBaselines, childPeerID)
		delete(c.senderQualityRegenerationBlocks, childPeerID)
		if c.upstreamByViewer.Has(childPeerID) {
			c.qualityBaselinesPending[childPeerID] = struct{}{}
			c.senderQualityBaselines[childPeerID] = true
		} else {
			delete(c.qualityBaselinesPending, childPeerID)
			delete(c.senderQualityBaselines, childPeerID)
		}
	}
}

// In requireSenderQualityBaseline, a missing baseline reads as
// false (`get(...) === true`).
func (c *Controller) requireSenderQualityBaseline(peerID string, suppressFact bool) {
	for _, childPeerID := range withSelf(c.descendantsOf(peerID), peerID) {
		if c.upstreamByViewer.Has(childPeerID) {
			delete(c.senderQualityObservations, childPeerID)
			c.senderQualityBaselines[childPeerID] = suppressFact || c.senderQualityBaselines[childPeerID]
		}
	}
}

func (c *Controller) clearSfuQuality() {
	c.sfuPublisherQualityObservation = nil
	for childPeerID, edge := range c.upstreamByViewer.All() {
		if edge.Kind == UpstreamSfu {
			c.clearQualityForParticipant(childPeerID)
		}
	}
}
