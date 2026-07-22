/**
 * 心跳事件处理器。
 *
 * 处理 host-heartbeat：房主定时广播的轻量心跳（仅 currentTime + isPlaying），
 * 后端转发给房间内其他成员，观众端据此重置"房主离线"计时器。
 *
 * 修复说明：前端 useHostHeartbeat 每 2s emit 'host-heartbeat'，观众端
 * useViewerHeartbeat 监听该事件重置离线计时器。若后端不转发，观众 6s 内
 * 必然收不到心跳而误报"房主已离线"并暂停播放。
 *
 * 心跳为轻量事件，不校验 room.mode（screen-share 模式下房主同样需要广播心跳
 * 给观众端做存活检测）；仅校验发送者为活跃 sharer。
 */
import type { Server as SocketIOServer, Socket } from 'socket.io';
import type { AckCallback, SocketEventHandler } from '../socket';
import { safeAck } from '../socket';
import { roomPermissionService } from '../room/room-permission.service';
import type { HeartbeatPayload } from '../shared/dto';

export class HeartbeatHandler implements SocketEventHandler {
  readonly name = 'HeartbeatHandler';

  register(socket: Socket, io: SocketIOServer): void {
    socket.on(
      'host-heartbeat',
      async (payload: HeartbeatPayload, callback?: AckCallback) => {
        try {
          // 校验是否为指定房间的活跃 sharer
          if (
            !(await roomPermissionService.isRoomHost(socket, payload.roomId))
          ) {
            return safeAck(callback, {
              success: false,
              message: '无权限发送心跳',
            });
          }

          // 转发心跳给房间内其他成员（不含发送者、不含 roomId）
          socket.to(payload.roomId).emit('host-heartbeat', {
            currentTime: payload.currentTime,
            isPlaying: payload.isPlaying,
          });
          safeAck(callback, { success: true });
        } catch (err) {
          console.error('[host-heartbeat] error:', err);
          safeAck(callback, { success: false, message: '心跳转发失败' });
        }
      },
    );
  }
}
