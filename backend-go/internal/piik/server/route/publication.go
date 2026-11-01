package route

// SetHostVideoConnectionID replaces only the physical video facet. The logical
// publication generation/resource continue to own room reachability and voice.
func (c *Controller) SetHostVideoConnectionID(id string) bool {
	if !c.roomMedia || c.hostPublication == nil || id == "" {
		return false
	}
	if c.hostPublication.ConnectionID != id {
		c.hostPublication.ConnectionID = id
		c.touchFacts()
	}
	return true
}

// SetVideoPublication opts this controller into room media. Room edges survive
// publication replacement, stop and pause. The returned resources belong only
// to the canceled operation; the caller retires video facets on stop/replacement.
// Calling it with an empty generation establishes an audio-only room.
func (c *Controller) SetVideoPublication(generation string, paused bool, nowMs int64) []*Resource {
	if generation == "" {
		paused = false
	}
	if c.roomMedia && c.videoGeneration == generation && c.videoPaused == paused {
		return nil
	}
	released := c.abortOperation(&nowMs, RejectionAborted)
	first := !c.roomMedia
	changed := first || c.videoGeneration != generation
	c.roomMedia, c.videoGeneration, c.videoPaused, c.paused = true, generation, paused, false
	if changed {
		for _, edge := range c.upstreamByViewer.Values() {
			edge.VideoGeneration, edge.VideoConnectionID, edge.VideoReady = "", "", false
			// Enabling voice during an accepted share must not reconstruct its
			// already-proven video transports.
			if first && generation != "" && edge.Usable && edge.PhysicalActive {
				edge.VideoGeneration, edge.VideoConnectionID, edge.VideoReady = generation, edge.ConnectionID, true
			}
		}
	}
	clear(c.qualityObservations)
	clear(c.qualityBaselinesPending)
	clear(c.senderQualityObservations)
	clear(c.senderQualityBaselines)
	clear(c.senderQualityRegenerationBlocks)
	c.sfuPublisherQualityObservation = nil
	c.rootConvergenceRootPeerID = ""
	c.touchFacts()
	return released
}

func (c *Controller) videoWorkEnabled() bool {
	return !c.roomMedia || c.videoGeneration != "" && !c.videoPaused
}

func (c *Controller) requiredVideoGeneration() string {
	if c.roomMedia && c.videoWorkEnabled() {
		return c.videoGeneration
	}
	return ""
}

func (c *Controller) qualityConnectionID(edge *CommittedEdge) string {
	if c.roomMedia {
		if edge.VideoReady && edge.VideoGeneration == c.videoGeneration {
			return edge.VideoConnectionID
		}
		return ""
	}
	return edge.ConnectionID
}

// sourceVideoReady is additional publication evidence, never room reachability.
func (c *Controller) sourceVideoReady(peerID string) bool {
	if c.requiredVideoGeneration() == "" || peerID == c.hostPeerID {
		return true
	}
	edge, ok := c.upstreamByViewer.Get(peerID)
	return ok && edge.VideoGeneration == c.videoGeneration && edge.VideoReady
}

func (c *Controller) startPublicationAttach(nowMs int64) bool {
	if !c.roomMedia || !c.videoWorkEnabled() {
		return false
	}
	for childID, edge := range c.upstreamByViewer.All() {
		child, _ := c.participants.Get(childID)
		if child == nil || !child.sessionIs(edge.ChildSessionID) || child.departureConfirmed ||
			!edge.Usable || !edge.PhysicalActive || !c.allowsIncoming(childID, edge.Kind) ||
			edge.VideoGeneration == c.videoGeneration {
			continue
		}
		tuple := CandidateTuple{Kind: edge.Kind, Transport: edge.Transport}
		if edge.Kind == UpstreamPeer {
			if !c.sourceUsable(edge.ParentPeerID) || !c.sourceVideoReady(edge.ParentPeerID) {
				continue
			}
			tuple.ParentPeerID = edge.ParentPeerID
		} else {
			if c.hostPublication == nil || !c.hostPublication.Usable || !c.hostPublication.PhysicalActive ||
				c.hostPublication.Generation != edge.PublicationGeneration {
				continue
			}
			tuple.Publication = PublicationReuse
		}
		c.operation = &operation{
			childPeerID: childID, childSessionID: child.sessionID,
			demandPeerID: childID, demandSessionID: child.sessionID,
			reason: DemandPublicationAttach, baseRevision: c.revision,
			builtAtFactVersion: c.factVersion, deadlineAtMs: nowMs + c.operationTimeoutMs,
			videoGeneration: c.videoGeneration, attachConnectionID: edge.ConnectionID,
			candidates: []CandidatePlan{{Tuple: tuple, EndpointTransition: EndpointTransition{Kind: TransitionNone}}},
		}
		return true
	}
	return false
}

func (c *Controller) publicationAttachOwned(op *operation) bool {
	if !c.roomMedia || !c.videoWorkEnabled() || op.videoGeneration != c.videoGeneration {
		return false
	}
	child, _ := c.participants.Get(op.childPeerID)
	edge, _ := c.upstreamByViewer.Get(op.childPeerID)
	if child == nil || !child.sessionIs(op.childSessionID) || child.departureConfirmed ||
		edge == nil || edge.ChildSessionID != op.childSessionID || edge.ConnectionID != op.attachConnectionID ||
		!edge.Usable || !edge.PhysicalActive || !c.allowsIncoming(op.childPeerID, edge.Kind) {
		return false
	}
	tuple := op.candidates[0].Tuple
	if tuple.Kind == UpstreamPeer {
		parent, _ := c.participants.Get(tuple.ParentPeerID)
		return edge.Kind == UpstreamPeer && edge.ParentPeerID == tuple.ParentPeerID &&
			parent != nil && parent.sessionIs(edge.ParentSessionID) &&
			c.sourceUsable(tuple.ParentPeerID) && c.sourceVideoReady(tuple.ParentPeerID)
	}
	return edge.Kind == UpstreamSfu && c.hostPublication != nil &&
		c.hostPublication.Generation == edge.PublicationGeneration &&
		c.hostPublication.PhysicalActive && c.hostPublication.Usable
}

func (c *Controller) beginPublicationAttach(input BeginInput, op *operation, checked validation) BeginResult {
	if input.ConnectionID == "" || input.Reservation.Kind != "" ||
		input.Reservation.Edge != nil || input.Reservation.Publication != nil ||
		input.Reservation.Overlap != nil || !c.publicationAttachOwned(op) {
		return BeginResult{Released: concatResources(checked.released, reservationResources(input.Reservation))}
	}
	edge, _ := c.upstreamByViewer.Get(op.childPeerID)
	op.current = &attempt{
		tuple: op.candidates[0].Tuple, revision: c.allocateRevision(),
		connectionID: input.ConnectionID, childSessionID: op.childSessionID,
		parentSessionID: edge.ParentSessionID, publicationGeneration: edge.PublicationGeneration,
		startedAtMs: input.NowMs, reservation: CandidateReservation{Kind: ReservationDirect},
	}
	return BeginResult{Accepted: true, Operation: c.operationSnapshot(), Released: checked.released}
}

// Optional attachment gets one attempt per edge, publication and endpoint sessions.
// Failure records an unavailable publication, without consuming or resetting
// the healthy room transport's NAT opportunity. A new edge or publication gets
// its own attempt, as do new endpoint sessions; unrelated reconciles never retry it.
func (c *Controller) finishPublicationAttach(op *operation, ready bool) []string {
	edge, _ := c.upstreamByViewer.Get(op.childPeerID)
	edge.VideoGeneration, edge.VideoConnectionID, edge.VideoReady = op.videoGeneration, "", ready
	if ready {
		edge.VideoConnectionID = op.current.connectionID
	}
	if ready {
		c.revision = op.current.revision
	} else {
		c.advanceActiveRevision(op)
	}
	c.operation = nil
	c.touchFacts()
	if ready {
		return nil
	}
	// Dependents cannot attach this picture until their upstream recovers.
	// Report that terminal result without retiring voice or spending their own
	// untried attachment. A proven picture ends the affected branch.
	failed := []string{op.childPeerID}
	for index := 0; index < len(failed); index++ {
		for _, peerID := range c.childrenOf(failed[index]) {
			child, _ := c.participants.Get(peerID)
			edge, _ := c.upstreamByViewer.Get(peerID)
			if child != nil && child.sessionIs(edge.ChildSessionID) && !child.departureConfirmed &&
				edge.Usable && edge.PhysicalActive && !c.sourceVideoReady(peerID) {
				failed = append(failed, peerID)
			}
		}
	}
	return failed
}

func (c *Controller) validatePublicationAttach(op *operation, nowMs int64, failed *CandidateGuard) validation {
	result := validation{}
	if !c.publicationAttachOwned(op) {
		c.advanceActiveRevision(op)
		c.operation = nil
		return result
	}
	result.consumedGuard = failed != nil && op.current != nil && c.guardMatches(*failed, op, op.current)
	result.expired = nowMs >= op.deadlineAtMs
	if result.expired || result.consumedGuard {
		result.exhaustedPeerIDs = c.finishPublicationAttach(op, false)
	}
	return result
}
