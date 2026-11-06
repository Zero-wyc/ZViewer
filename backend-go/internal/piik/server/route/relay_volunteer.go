package route

import "zviewer/backend/internal/piik/server/protocol"

// MaxRelayVolunteerChildren is the steady fanout of a willing ordinary peer.
// The existing single operation may reserve one additional physical copy.
const MaxRelayVolunteerChildren = protocol.MaxViewersPerRoomLimit

// SetRelayVolunteer changes policy for this exact authenticated session. The
// endpoint's reported capacity remains the physical capability ceiling.
func (c *Controller) SetRelayVolunteer(peerID, sessionID string, enabled bool, nowMs *int64) bool {
	current, _ := c.participants.Get(peerID)
	if current == nil || !current.sessionIs(sessionID) {
		return false
	}
	if current.relayVolunteer == enabled {
		return true
	}
	current.relayVolunteer = enabled
	current.effectiveDownstreamCapacity = c.effectiveCapacity(current.reportedDownstreamCapacity, enabled)
	c.recordCapacityReduction(peerID, nowMs)
	c.touchFacts()
	return true
}

func (c *Controller) recordCapacityReduction(peerID string, nowMs *int64) {
	if nowMs != nil {
		for _, childPeerID := range c.overflowPeerChildren(peerID) {
			c.recordDemand(childPeerID, *nowMs, DemandCapacityReduction)
		}
	}
}

func (c *Controller) transitionCopyLimit(producer *participant) int {
	if producer.relayVolunteer && producer.effectiveDownstreamCapacity > c.endpointMediaCopyCapacity {
		if producer.effectiveDownstreamCapacity > 3 {
			return producer.effectiveDownstreamCapacity + 1
		}
		return 3
	}
	return protocol.EndpointMediaCopyLimit(c.endpointMediaCopyCapacity, protocol.EndpointMediaCopyTransition)
}
