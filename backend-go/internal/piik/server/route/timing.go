package route

import "zviewer/backend/internal/piik/server/protocol"

// recordDemand replaces the peer's timing record wholesale.
func (c *Controller) recordDemand(childPeerID string, nowMs int64, reason DemandReason) {
	c.routeTimings[childPeerID] = &routeTimingRecord{
		demandAtMs:      nowMs,
		reason:          reason,
		finalRoute:      FinalRouteWaiting,
		rejectionBucket: RejectionNone,
	}
}

func (c *Controller) ensureDemand(childPeerID string, nowMs int64, reason DemandReason) {
	if _, ok := c.routeTimings[childPeerID]; !ok {
		c.recordDemand(childPeerID, nowMs, reason)
	}
}

func (c *Controller) startOperationTiming(childPeerID string, nowMs int64) {
	record := c.routeTimings[childPeerID]
	if record == nil {
		return
	}
	startedAt := nowMs
	record.operationStartedAtMs = &startedAt
	record.candidateStartedAtMs = nil
	record.firstDecodedFrameAtMs = nil
	record.finalAtMs = nil
	record.finalRoute = FinalRouteWaiting
	record.rejectionBucket = RejectionNone
}

func (c *Controller) startCandidateTiming(childPeerID string, nowMs int64) {
	record := c.routeTimings[childPeerID]
	if record == nil {
		return
	}
	startedAt := nowMs
	record.candidateStartedAtMs = &startedAt
	record.firstDecodedFrameAtMs = nil
	record.finalAtMs = nil
	record.finalRoute = FinalRouteWaiting
	record.rejectionBucket = RejectionNone
}

func (c *Controller) noteRejection(childPeerID string, bucket RejectionBucket) {
	if record := c.routeTimings[childPeerID]; record != nil {
		record.rejectionBucket = bucket
	}
}

func (c *Controller) clearCandidateTiming(childPeerID string) {
	record := c.routeTimings[childPeerID]
	if record == nil {
		return
	}
	record.candidateStartedAtMs = nil
	record.firstDecodedFrameAtMs = nil
	record.finalAtMs = nil
	record.finalRoute = FinalRouteWaiting
}

func (c *Controller) finishTiming(childPeerID string, nowMs int64, finalRoute FinalRoute, rejectionBucket RejectionBucket, firstDecodedFrame bool) {
	record := c.routeTimings[childPeerID]
	if record == nil {
		return
	}
	if firstDecodedFrame {
		decodedAt := nowMs
		record.firstDecodedFrameAtMs = &decodedAt
	}
	finalAt := nowMs
	record.finalAtMs = &finalAt
	record.finalRoute = finalRoute
	record.rejectionBucket = rejectionBucket
}

func (c *Controller) usableRoute(childPeerID string) bool {
	return c.currentFinalRoute(childPeerID) != FinalRouteWaiting
}

func (c *Controller) currentFinalRoute(childPeerID string) FinalRoute {
	edge, _ := c.upstreamByViewer.Get(childPeerID)
	if edge == nil || !edge.Usable || !edge.PhysicalActive {
		return FinalRouteWaiting
	}
	if edge.Kind == UpstreamPeer {
		if c.sourceUsable(edge.ParentPeerID) {
			return FinalRouteDirect
		}
		return FinalRouteWaiting
	}
	if c.hostPublication != nil && c.hostPublication.Usable &&
		c.hostPublication.PhysicalActive &&
		c.hostPublication.Generation == edge.PublicationGeneration {
		return FinalRouteSfu
	}
	return FinalRouteWaiting
}

func (c *Controller) routeDemandReason(childPeerID string) DemandReason {
	edge, _ := c.upstreamByViewer.Get(childPeerID)
	if edge == nil {
		return DemandJoin
	}
	if edge.Kind == UpstreamPeer {
		if parent, ok := c.participants.Get(edge.ParentPeerID); ok && parent.departureConfirmed {
			return DemandParentDeparted
		}
		for _, overflowing := range c.overflowPeerChildren(edge.ParentPeerID) {
			if overflowing == childPeerID {
				return DemandCapacityReduction
			}
		}
	}
	return DemandEdgeUnavailable
}

func (c *Controller) diagnosticParent(edge *CommittedEdge, ordinals map[string]int) protocol.RouteDiagnosticParent {
	if edge == nil || !edge.Usable || !edge.PhysicalActive {
		return protocol.RouteDiagnosticParent{Kind: "none"}
	}
	if edge.Kind == UpstreamSfu {
		if c.hostPublication != nil && c.hostPublication.Usable &&
			c.hostPublication.PhysicalActive &&
			c.hostPublication.Generation == edge.PublicationGeneration {
			return protocol.RouteDiagnosticParent{Kind: "sfu"}
		}
		return protocol.RouteDiagnosticParent{Kind: "none"}
	}
	if edge.ParentPeerID == c.hostPeerID {
		return protocol.RouteDiagnosticParent{Kind: "host"}
	}
	ordinal, ok := ordinals[edge.ParentPeerID]
	if !ok {
		return protocol.RouteDiagnosticParent{Kind: "none"}
	}
	return protocol.RouteDiagnosticParent{Kind: "viewer", Ordinal: protocol.Int(ordinal)}
}

// diagnosticQuality returns nil unless the observation is
// fresh, non-empty and still describes the current edge.
func (c *Controller) diagnosticQuality(childPeerID string, edge *CommittedEdge, nowMs int64) *protocol.RouteDiagnosticQuality {
	observation := c.qualityObservations[childPeerID]
	current, _ := c.participants.Get(childPeerID)
	if c.paused || !c.videoWorkEnabled() ||
		observation == nil ||
		observation.eligibleWindows == 0 ||
		nowMs >= observation.lastAcceptedAtMs+qualityEvidenceExpiryMs ||
		current == nil || current.sessionID == "" ||
		!current.sessionIs(observation.childSessionID) ||
		edge == nil ||
		!edge.Usable ||
		!edge.PhysicalActive ||
		c.qualityConnectionID(edge) != observation.connectionID ||
		!qualityObservationMatchesEdge(observation, edge) ||
		!c.sourceUsableForQuality(edge) {
		return nil
	}
	return &protocol.RouteDiagnosticQuality{
		EligibleWindows:    protocol.Int(observation.eligibleWindows),
		EligibleDurationMs: protocol.Int(observation.eligibleDurationMs),
		FreezeWindows:      protocol.Int(observation.freezeWindows),
		FreezeCount:        protocol.Int(observation.freezeCount),
		FreezeDurationMs:   protocol.Int(observation.freezeDurationMs),
		PauseCount:         protocol.Int(observation.pauseCount),
		PauseDurationMs:    protocol.Int(observation.pauseDurationMs),
	}
}

// elapsedMs returns nil when the end precedes the start or the difference
// exceeds the wire integer bound.
func elapsedMs(startedAtMs, endedAtMs int64) *protocol.Int {
	elapsed := endedAtMs - startedAtMs
	if !isSafeInteger(elapsed) || elapsed < 0 {
		return nil
	}
	value := protocol.Int(elapsed)
	return &value
}
