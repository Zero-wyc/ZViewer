package room

import (
	"context"
)

// DeleteRoomAndRelations 物理删除房间及其全部关联数据，并通知房间内所有人。
//
// 对应 Node 的 `modules/room/room-removal.service.ts#deleteRoomAndRelations`，
// 由管理端 REST（DELETE /api/admin/rooms/:roomId）调用。
//
// 与 CloseAndNotify（软关闭，status='closed'）的分界：
//   - 软关闭保留房间行与影片/评论/队列，只是置为 closed 并踢人；
//   - 物理删除把 movie / comment / 播放记忆 / 音乐队列 / 弹幕轨道 / 弹幕 meta
//     一并清掉，房间号之后可以被复用。
//
// 顺序不能乱：
//  1. 先清内存（运行时状态、播放记忆、音乐基线、权限缓存）——不先清的话，
//     级联删除完成后若还有心跳定时器在跑，会对着已删房间重新写回 DB 行；
//  2. 再落库级联（事务，含结束未结束会话）；
//  3. 最后广播 room-closed 并断开连接。
//
// 第 3 步必须在删除**之后**：客户端收到 room-closed 会立刻停止拉流，
// 而如果先广播后删除，删除失败时客户端已经退房、房间却还在库里，
// 变成「看不见但删不掉」的半截状态。
func (s *Service) DeleteRoomAndRelations(ctx context.Context, roomID string) error {
	s.Delete(roomID)
	s.CancelReconnectTimer(roomID)
	s.perm.invalidate("", roomID)

	// 播放记忆与音乐基线都带 DB 行，这里先清一次是幂等的：
	// 级联删除随后会把同样的行删掉，但内存里的脏标记必须现在就消失，
	// 否则下一次 FlushAllDirty 会把已删房间的基线重新写回去。
	if s.Playback != nil {
		if err := s.Playback.Clear(ctx, roomID); err != nil && s.Logger != nil {
			s.Logger.Printf("[room] 清理播放记忆失败 %s: %v", roomID, err)
		}
	}
	if s.Music != nil {
		s.Music.Clear(ctx, roomID)
	}

	if err := s.Rooms.DeleteCascade(ctx, roomID); err != nil {
		return err
	}

	if s.Hub == nil {
		return nil
	}
	// 先广播再断开：只断连不广播的话客户端会自动重连并继续播，
	// 浏览器持续请求媒体分片、服务端持续代理上游流量（房间已删但流量还在跑）。
	s.Hub.EmitRoom(roomID, "room-closed", map[string]any{"roomId": roomID})
	for _, id := range s.Hub.SocketIDs(roomID) {
		s.Hub.Leave(id, roomID)
		s.Hub.Disconnect(id)
	}
	return nil
}

// InvalidateRoomPermissions 立刻失效某房间的权限判定缓存。
//
// 管理端「重新开启房间」后调用：缓存里有 5s 的 isInRoom=false，
// 不失效的话重开后的头 5 秒内观众发言仍会被拒（表现为"重开了但进不去"）。
func (s *Service) InvalidateRoomPermissions(roomID string) {
	s.perm.invalidate("", roomID)
}
