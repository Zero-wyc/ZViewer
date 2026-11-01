package route

import (
	"maps"

	"zviewer/backend/internal/piik/server/protocol"
)

// SetVoiceListeners supplies current room permission, not a second topology.
// A permission change opens the existing bounded availability opportunities
// only for listeners whose route needs repair. Healthy video stays committed
// while the ordinary serial operation proves a permitted replacement.
func (c *Controller) SetVoiceListeners(peerIDs []string, nowMs int64) bool {
	if !c.roomMedia {
		return false
	}
	next := make(map[string]bool, len(peerIDs))
	for _, peerID := range peerIDs {
		next[peerID] = true
	}
	if maps.Equal(c.voiceListeners, next) {
		return false
	}
	previous := c.voiceListeners
	c.voiceListeners = next
	for _, current := range c.participants.Values() {
		if current.role != protocol.RoleViewer ||
			previous[current.peerID] == next[current.peerID] && !c.voiceRouteMissing(current.peerID) {
			continue
		}
		current.consumedCandidateOpportunities.Clear()
		current.availabilityExhausted = false
		current.bootstrapFailureReported = false
		c.directContinuations.Delete(current.peerID)
		c.clearSfuBootstrapForDemand(current.peerID)
		if c.voiceRouteMissing(current.peerID) {
			c.recordDemand(current.peerID, nowMs, DemandEdgeUnavailable)
		}
	}
	c.touchFacts()
	return true
}

func (c *Controller) voiceParentAllowed(childPeerID, parentPeerID string) bool {
	return !c.voiceListeners[childPeerID] || c.voiceSourceUsable(parentPeerID)
}

func (c *Controller) voiceRouteMissing(peerID string) bool {
	return c.voiceListeners[peerID] && !c.voiceSourceUsable(peerID)
}

// The permitted path ends at the listening Host or the admitted SFU junction.
// Checking every hop prevents an approved relay with unapproved upstream from
// becoming a candidate that can never receive the room's voice publications.
func (c *Controller) voiceSourceUsable(peerID string) bool {
	seen := make(map[string]bool)
	for {
		if !c.voiceListeners[peerID] || seen[peerID] {
			return false
		}
		seen[peerID] = true
		participant, _ := c.participants.Get(peerID)
		if participant == nil || participant.sessionID == "" || participant.departureConfirmed {
			return false
		}
		if peerID == c.hostPeerID {
			return true
		}
		edge, _ := c.upstreamByViewer.Get(peerID)
		if edge == nil || !edge.Usable || !edge.PhysicalActive {
			return false
		}
		if edge.Kind == UpstreamSfu {
			return c.hostPublication != nil && c.hostPublication.Usable &&
				c.hostPublication.PhysicalActive && c.hostPublication.Generation == edge.PublicationGeneration
		}
		peerID = edge.ParentPeerID
	}
}
