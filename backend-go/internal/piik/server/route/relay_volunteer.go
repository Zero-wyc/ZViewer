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
	limit := c.endpointMediaCopyCapacity + 1
	if producer.relayVolunteer {
		limit = max(limit, producer.effectiveDownstreamCapacity+1)
	}
	// Published backends reporting at most three copies cannot reserve a fourth.
	physicalLimit := protocol.MaxEndpointMediaCopyCapacity
	if producer.reportedDownstreamCapacity > physicalLimit {
		physicalLimit = producer.reportedDownstreamCapacity + 1
	}
	return min(limit, physicalLimit)
}

// SetDefaultCapacity applies room policy without replacing endpoint capability
// or an explicit personal override. Existing overflow uses the serial handoff.
func (c *Controller) SetDefaultCapacity(capacity int, nowMs *int64) {
	if capacity < 1 || capacity > protocol.MaxViewersPerRoomLimit {
		panic("Room capacity is invalid")
	}
	if capacity == c.endpointMediaCopyCapacity {
		return
	}
	c.endpointMediaCopyCapacity = capacity
	for _, current := range c.participants.Values() {
		if current.departureConfirmed {
			continue
		}
		current.effectiveDownstreamCapacity = c.effectiveCapacity(current.reportedDownstreamCapacity, current.relayVolunteer)
		c.recordCapacityReduction(current.peerID, nowMs)
	}
	c.touchFacts()
}
