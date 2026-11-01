package route

import "zviewer/backend/internal/piik/server/protocol"

// SetRoutePolicy applies the server-validated policy for a new share to the
// retained room controller. Existing routes stay physical while the ordinary
// operation proves their replacement; disallowed routes cannot attach video.
func (c *Controller) SetRoutePolicy(policy protocol.RoutePolicy, nowMs int64) []*Resource {
	sfuEnabled := !policy.PeerOnly
	if c.sfuEnabled == sfuEnabled && c.qualityConvergenceEnabled == policy.TopologyOptimization &&
		c.natPredictionEnabled == policy.NatPrediction {
		return nil
	}
	released := c.abortOperation(&nowMs, RejectionAborted)
	c.sfuEnabled, c.qualityConvergenceEnabled, c.natPredictionEnabled =
		sfuEnabled, policy.TopologyOptimization, policy.NatPrediction
	for _, current := range c.participants.Values() {
		if current.role != protocol.RoleViewer {
			continue
		}
		if !c.AllowsViewerRoutePreference(current.routePreference) {
			current.routePreference = protocol.ViewerRouteAuto
		}
		current.consumedCandidateOpportunities.Clear()
		current.availabilityExhausted = false
		current.bootstrapFailureReported = false
		current.sfuFirstAtNextRoute = false
	}
	c.directContinuations.Clear()
	c.sfuBootstrapIntent = nil
	c.consumedSfuBootstrapOpportunities.Clear()
	c.rootConvergenceRootPeerID = ""
	clear(c.qualityObservations)
	clear(c.qualityBaselinesPending)
	clear(c.senderQualityObservations)
	clear(c.senderQualityBaselines)
	clear(c.senderQualityRegenerationBlocks)
	c.sfuPublisherQualityObservation = nil
	c.touchFacts()
	return released
}
