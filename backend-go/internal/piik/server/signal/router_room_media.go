package signal

import (
	"zviewer/backend/internal/piik/server/protocol"
	"zviewer/backend/internal/piik/server/route"
)

func videoConnectionID(snapshot route.RouteSnapshot, edge route.CommittedEdge) string {
	if snapshot.RoomMedia {
		return edge.VideoConnectionID
	}
	return edge.ConnectionID
}

func (r *router) videoGeneration(roomID string) string {
	if r.hooks.videoGeneration != nil {
		return r.hooks.videoGeneration(roomID)
	}
	return r.hooks.shareGeneration(roomID)
}

func (r *router) setVideoPublication(roomID, generation string, paused bool) {
	rm, _ := r.rooms.Get(roomID)
	if rm == nil || !rm.roomMedia || rm.controller == nil {
		return
	}
	previous := rm.controller.Snapshot().VideoGeneration
	if previous != generation {
		r.retireRoomVideo(roomID, rm)
	}
	r.releaseResources(rm.controller.SetVideoPublication(generation, paused, r.now()))
	if previous != generation && generation != "" {
		rm.controller.SetHostVideoConnectionID(opaqueID())
	}
	if generation != "" {
		for _, viewer := range r.store.GetConnectedViewers(roomID) {
			r.connectParticipant(authenticatedRouteParticipant{roomID: roomID, peerID: viewer.PeerID,
				sessionID: viewer.SessionID, role: protocol.RoleViewer})
		}
	}
	if generation == "" && r.hooks.voiceDemandChanged != nil {
		r.hooks.voiceDemandChanged(roomID)
	}
	if rm.controller == nil {
		if r.hooks.routesChanged != nil {
			r.hooks.routesChanged(roomID)
		}
		return
	}
	r.broadcastActive(roomID, rm)
	r.requestPump(roomID)
}
