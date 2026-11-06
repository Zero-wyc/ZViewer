package signal

import "zviewer/backend/internal/piik/server/protocol"

// Room authority remains in the authenticated session/store. Interaction state
// ends with that connection; no message history, routing state or retry worker
// lives on the server. Server.mu serializes membership checks and broadcast.
func (s *Server) handleRoomInteraction(sess *session, actor *authenticatedSession, message protocol.SendRoomInteractionMessage) {
	reject := func(reason string) {
		s.send(sess, protocol.RoomInteractionRejectedMessage{
			Type: "room-interaction-rejected", RequestID: message.RequestID, Reason: reason,
		})
	}
	if !sess.roomInteractions || actor.displayName == nil {
		reject("not-subscribed")
		return
	}
	now := s.now()
	if now < sess.nextInteractionAtMs {
		reject("rate-limited")
		return
	}
	sess.nextInteractionAtMs = now + protocol.InteractionIntervalMs
	if targetID := message.Payload.TargetPeerID; targetID != "" {
		target, exists := s.connectedPeer(actor.roomID, targetID)
		targetSession := s.sessionsByID[target.SessionID]
		if !exists || targetSession == nil || targetSession.revoked || !targetSession.open() || !s.isCurrentSession(targetSession) {
			reject("target-unavailable")
			return
		}
	}
	// Reserve the existing signaling queue for media/authority work when a
	// reader stalls. Room data must not fill it and terminate a healthy share.
	const maxInteractionQueueBytes = 16 * 1024
	if sess.queuedBytes >= maxInteractionQueueBytes {
		reject("busy")
		return
	}
	event := protocol.RoomInteractionMessage{
		Type: "room-interaction", ID: opaqueID(), RequestID: message.RequestID,
		OccurredAt: protocol.Int(now),
		Sender:     protocol.InteractionSender{PeerID: actor.peerID, Role: actor.role, DisplayName: protocol.DisplayName(*actor.displayName)},
		Payload:    message.Payload,
	}
	encoded, err := protocol.EncodeServerMessage(event)
	if err != nil {
		panic(err)
	}
	deliver := func(sessionID string) {
		target := s.sessionsByID[sessionID]
		if target != nil && target.roomInteractions && !target.revoked && target.open() &&
			s.isCurrentSession(target) && target.queuedBytes < maxInteractionQueueBytes {
			s.sendEncoded(target, encoded)
		}
	}
	if host, ok := s.store.GetConnectedHost(actor.roomID); ok {
		deliver(host.SessionID)
	}
	for _, viewer := range s.store.GetConnectedViewers(actor.roomID) {
		deliver(viewer.SessionID)
	}
}
