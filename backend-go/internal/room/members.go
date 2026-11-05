package room

import (
	"context"
	"encoding/json"

	"zviewer/backend/internal/sio"
)

type roomViewer struct {
	SocketID string `json:"socketId"`
	UserID   *int64 `json:"userId"`
	Username string `json:"username"`
	Role     string `json:"role"`
}

type roomMembers struct {
	RoomID         string       `json:"roomId"`
	Viewers        []roomViewer `json:"viewers"`
	Moderators     []int64      `json:"moderators"`
	MutedViewerIDs []int64      `json:"mutedViewerIds"`
}

// A full snapshot repairs missed join/leave events and stale socket identities.
func (s *Service) memberSnapshot(ctx context.Context, roomID string) (*roomMembers, error) {
	room, err := s.Rooms.FindByRoomID(ctx, roomID)
	if err != nil {
		return nil, err
	}
	viewers, err := s.Viewers(ctx, roomID)
	if err != nil {
		return nil, err
	}
	snapshot := &roomMembers{
		RoomID:         roomID,
		Viewers:        []roomViewer{},
		Moderators:     parseIDList(room.Moderators),
		MutedViewerIDs: parseIDList(room.MutedViewers),
	}
	for _, viewer := range viewers {
		if s.Hub == nil || !s.Hub.Connected(viewer.SocketID) {
			continue
		}
		data := s.Hub.SocketData(viewer.SocketID)
		role, _ := data["role"].(string)
		if role == "" {
			role = RoleGuest
		}
		snapshot.Viewers = append(snapshot.Viewers, roomViewer{
			SocketID: viewer.SocketID, UserID: viewer.UserID,
			Username: usernameFromData(data), Role: role,
		})
	}
	return snapshot, nil
}

func (s *Service) sendMemberSnapshot(ctx context.Context, socketID, roomID string) {
	if s.Hub == nil {
		return
	}
	snapshot, err := s.memberSnapshot(ctx, roomID)
	if err != nil {
		s.Logger.Printf("[room-members] snapshot failed: %v", err)
		return
	}
	s.Hub.EmitTo(socketID, "room-members", snapshot)
}

func (s *Service) handleGetRoomMembers(sc *sio.Socket, args []json.RawMessage, ack func(...any)) {
	ctx, cancel := handlerCtx()
	defer cancel()
	payload, ok := decodePayload[registerHostPayload](args)
	if !ok || payload.RoomID == "" {
		ackFail(ack, "缺少房间号")
		return
	}
	// Use an admitted session, rather than a public room or comment-panel grant.
	session, err := s.Sessions.FindActiveByRoomSocket(ctx, payload.RoomID, sc.ID)
	if err != nil || session == nil {
		ackFail(ack, "无权限")
		return
	}
	snapshot, err := s.memberSnapshot(ctx, payload.RoomID)
	if err != nil {
		ackFail(ack, "读取房间成员失败")
		return
	}
	ackOK(ack, snapshot)
}
