package share

// 中继（SFU）相关的控制面接线。
//
// 分工：Service 只做「身份与权限」——这条连接是不是这个房间的房主/这位观众、
// connectionId 是不是它自己的那条边；Relay 只做「已授权物理资源」的取用。
// 媒体层永远不自己判断权限，它拿到的每个 fence 都是上层校验过的。

// handleSFUSignal 处理中继侧信令。
func (s *Service) handleSFUSignal(conn Conn, message SFUSignalMessage) {
	if s.relay == nil {
		// 直连模式下客户端不该发这条消息：明确回报，别让它等到超时。
		s.fail(conn, message.RoomID, CodeNotImplemented, "当前未启用中继")
		return
	}
	if !s.inRoom(conn, message.RoomID) {
		return
	}
	session := s.Session(message.RoomID)
	if session == nil {
		return
	}
	publication, ok := s.relay.Publication(message.RoomID)
	if !ok || publication.PublicationGeneration != message.PublicationGeneration {
		// 发布代际对不上 = 上一代遗留的消息，静默丢弃。
		return
	}
	host, err := s.hostOf(conn, message.RoomID)
	if err != nil {
		return
	}
	if host {
		// 房主的每条消息都必须锚在发布身份上：connectionId 与 publicationGeneration
		// 是同一个值，对不上说明在拿别人的发布试。
		if message.ConnectionID != publication.PublicationGeneration {
			return
		}
		s.relay.HostSignal(message.RoomID, conn.ID, message)
		return
	}
	if !session.IsRelayRoute(conn.ID, message.ConnectionID) {
		// 观众只能碰自己那条边。
		return
	}
	switch message.Kind {
	case "subscribe":
		s.relay.OpenSubscription(message.RoomID, conn.ID, message.ConnectionID)
	case "description", "candidate":
		s.relay.ViewerSignal(message.RoomID, conn.ID, message.ConnectionID, message)
	default:
		// media / layers 只有房主能发。
	}
}

// bindRelayPublication 在房主开始共享时铸一路发布身份并通知房主。
//
// 失败只记日志、不阻断共享：中继起不来时观众会走 route-failed 重试链，
// 比让房主连共享都开不了更好。
func (s *Service) bindRelayPublication(conn Conn, session *Session, roomID, generation string) {
	if s.relay == nil {
		return
	}
	config, err := s.relay.BindPublication(roomID, generation, conn.ID)
	if err != nil {
		s.logger.Printf("[share] 中继发布绑定失败 room=%s err=%v", roomID, err)
		return
	}
	session.SetPublication(config.PublicationGeneration)
	config.Revision = session.Revision()
	s.emitTo(conn, config)
}

// releaseRelay 退役某房间的中继资源。
func (s *Service) releaseRelay(roomID string) {
	if s.relay == nil {
		return
	}
	s.relay.ReleaseRoom(roomID)
}

// releaseRelayFor 在一条连接离开时收拾它的中继资源。
//
// 房主离开要退役整路发布（没人再推流了）；观众离开只关自己那条下行。
func (s *Service) releaseRelayFor(socketID, roomID string) {
	if s.relay == nil {
		return
	}
	if _, ok := s.relay.Publication(roomID); !ok {
		return
	}
	if s.relay.HostSocketID(roomID) == socketID {
		s.relay.ReleaseRoom(roomID)
		return
	}
	s.relay.CloseViewerSubscriptions(roomID, socketID)
}

// OnRelayRouteFailed 是媒体层判定某条边失败时的回调（供装配层注入）。
//
// 换候选（新 connectionId）还是彻底放弃由会话状态决定，媒体层不碰路由。
func (s *Service) OnRelayRouteFailed(roomID, viewerPeerID, connectionID string) {
	session := s.Session(roomID)
	if session == nil {
		return
	}
	if viewerPeerID == "" {
		// 房主上行断了：整路发布作废，观众等房主重新开始共享。
		s.releaseRelay(roomID)
		s.broadcast(roomID, StatusMessage{
			T:        TypeStatus,
			RoomID:   roomID,
			Revision: session.Revision(),
			State:    StatusFailed,
			Reason:   ReasonRelayUnreachable,
		})
		return
	}
	plans, status := session.FailRoute(viewerPeerID, session.Revision(), connectionID)
	s.emitPlans(plans)
	if status != nil {
		s.broadcast(roomID, *status)
	}
}

// RelayAvailable 报告中继是否可用（供系统信息接口与前端提示）。
func (s *Service) RelayAvailable() bool { return s.relay != nil }
