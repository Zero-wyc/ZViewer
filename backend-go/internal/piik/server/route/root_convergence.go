package route

import "sort"

// rootConvergencePick is the takeRootConvergenceIntent result.
type rootConvergencePick struct {
	childPeerID string
	plan        CandidatePlan
}

// stageRootConvergence is called from commitAttempt whenever a
// child newly became a direct child of the Host.
func (c *Controller) stageRootConvergence(rootPeerID string) {
	if !c.qualityConvergenceEnabled {
		return
	}
	convergence := c.rootConvergencePlan(rootPeerID)
	if convergence == nil {
		return
	}
	c.rootConvergenceRootPeerID = rootPeerID
	c.debug("root-convergence-staged",
		"root", c.debugPeer(rootPeerID),
		"donor", c.debugPeer(convergence.donorPeerID),
		"child", c.debugPeer(convergence.childPeerID))
}

// takeRootConvergenceIntent consumes the intent by clearing it.
func (c *Controller) takeRootConvergenceIntent() *rootConvergencePick {
	rootPeerID := c.rootConvergenceRootPeerID
	c.rootConvergenceRootPeerID = ""
	if rootPeerID == "" || !c.qualityConvergenceEnabled {
		return nil
	}
	convergence := c.rootConvergencePlan(rootPeerID)
	if convergence == nil {
		return nil
	}
	return &rootConvergencePick{childPeerID: convergence.childPeerID, plan: convergence.plan}
}

type rootConvergence struct {
	donorPeerID string
	childPeerID string
	plan        CandidatePlan
}

// rootConvergencePlan makes the busiest other Host root donate its
// newest active direct child to the fresh root.
func (c *Controller) rootConvergencePlan(rootPeerID string) *rootConvergence {
	root, _ := c.participants.Get(rootPeerID)
	if root == nil || root.sessionID == "" ||
		root.departureConfirmed ||
		!c.isActiveHostRoot(rootPeerID) ||
		len(c.activeDirectChildren(rootPeerID)) != 0 {
		return nil
	}
	donors := []string{}
	for _, peerID := range c.childrenOf(c.hostPeerID) {
		if peerID != rootPeerID && c.isActiveHostRoot(peerID) && len(c.activeDirectChildren(peerID)) >= 2 {
			donors = append(donors, peerID)
		}
	}
	sort.SliceStable(donors, func(i, j int) bool {
		if d := len(c.activeDirectChildren(donors[j])) - len(c.activeDirectChildren(donors[i])); d != 0 {
			return d < 0
		}
		left, _ := c.participants.Get(donors[i])
		right, _ := c.participants.Get(donors[j])
		return compareParticipant(left, right) < 0
	})
	if len(donors) == 0 {
		return nil
	}
	donorPeerID := donors[0]
	children := c.activeDirectChildren(donorPeerID)
	sort.SliceStable(children, func(i, j int) bool {
		left, _ := c.participants.Get(children[i])
		right, _ := c.participants.Get(children[j])
		return compareParticipant(right, left) < 0
	})
	if len(children) == 0 {
		return nil
	}
	childPeerID := children[0]
	plan := c.planCandidate(childPeerID, CandidateTuple{Kind: UpstreamPeer, ParentPeerID: rootPeerID, Transport: TransportDirect})
	if plan != nil &&
		plan.EndpointTransition.Kind != TransitionBoundedGap &&
		c.candidateValid(childPeerID, *plan, nil) {
		return &rootConvergence{donorPeerID: donorPeerID, childPeerID: childPeerID, plan: *plan}
	}
	return nil
}

func (c *Controller) rootConvergenceOperationStillEligible(op *operation) bool {
	if op.reason != DemandRootConvergence {
		return true
	}
	tuple := op.currentTuple()
	current, _ := c.upstreamByViewer.Get(op.childPeerID)
	return tuple != nil && tuple.Kind == UpstreamPeer &&
		current != nil && current.Kind == UpstreamPeer &&
		current.Usable &&
		current.PhysicalActive &&
		current.ParentPeerID != tuple.ParentPeerID &&
		c.isActiveHostRoot(tuple.ParentPeerID) &&
		c.isActiveHostRoot(current.ParentPeerID) &&
		len(c.activeDirectChildren(tuple.ParentPeerID)) == 0 &&
		len(c.activeDirectChildren(current.ParentPeerID)) >= 2
}

func (c *Controller) isActiveHostRoot(peerID string) bool {
	edge, _ := c.upstreamByViewer.Get(peerID)
	return edge != nil && edge.Kind == UpstreamPeer &&
		edge.ParentPeerID == c.hostPeerID &&
		edge.Usable &&
		edge.PhysicalActive
}

func (c *Controller) activeDirectChildren(parentPeerID string) []string {
	children := []string{}
	for _, childPeerID := range c.childrenOf(parentPeerID) {
		if edge, ok := c.upstreamByViewer.Get(childPeerID); ok && edge.Kind == UpstreamPeer && edge.Usable && edge.PhysicalActive {
			children = append(children, childPeerID)
		}
	}
	return children
}
