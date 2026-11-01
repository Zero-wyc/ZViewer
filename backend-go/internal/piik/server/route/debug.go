package route

import (
	"strconv"

	"zviewer/backend/internal/piik/server/protocol"
)

// debugCandidate is the `{route, transition}` item of "operation-started".
type debugCandidate struct {
	Route      string
	Transition TransitionKind
}

func (c *Controller) debugEnabled() bool {
	return c.debugLog != nil && c.debugRoomID != ""
}

// debug emits one sanitized event with a diagnostic room ID and current facts.
// Never pass raw peer IDs, session IDs or connection IDs; use debugPeer and
// debugTuple. The effect layer injects the sink and owns its enabling policy.
func (c *Controller) debug(event string, details ...any) {
	if !c.debugEnabled() {
		return
	}
	args := make([]any, 0, 8+len(details))
	args = append(args,
		"event", event,
		"roomId", c.debugRoomID,
		"revision", c.revision,
		"factVersion", c.factVersion)
	args = append(args, details...)
	c.debugLog("piik-route", args...)
}

// debugPeer returns "host", "viewer-<joinOrder>" or "viewer-unknown".
func (c *Controller) debugPeer(peerID string) string {
	current, _ := c.participants.Get(peerID)
	if peerID == c.hostPeerID || (current != nil && current.role == protocol.RoleHost) {
		return "host"
	}
	if current == nil {
		return "viewer-unknown"
	}
	return "viewer-" + strconv.FormatInt(current.joinOrder, 10)
}

// debugTuple returns "p2p:<label>[:regenerate]" or "sfu:<publication>".
func (c *Controller) debugTuple(tuple CandidateTuple) string {
	if tuple.Kind == UpstreamPeer {
		label := "p2p:" + c.debugPeer(tuple.ParentPeerID)
		if tuple.Regenerate {
			label += ":regenerate"
		}
		return label
	}
	return "sfu:" + string(tuple.Publication)
}
