/**
 * 同步控制事件处理器。
 *
 * 处理 watch-together-control：房主下发播放控制指令（play/pause/seek/rate），
 * 后端转发给房间内其他成员，观众端据此同步执行对应动作。
 *
 * 修复旧架构 bug：
 * 1. 旧版 services/room/sync.ts 不校验 room.mode，screen-share 模式下也会处理控制事件。
 *    此版本通过 roomPermissionService.isWatchTogetherRoom 强制校验模式。
 * 2. 旧版直接查 Session 表做权限校验，此版本统一走 roomPermissionService。
 */
import type { Server as SocketIOServer, Socket } from 'socket.io';
import type { AckCallback, SocketEventHandler } from '../socket';
import { safeAck } from '../socket';
import { roomPermissionService } from '../room/room-permission.service';
import type { SyncControlPayload } from '../shared/dto';

export class SyncControlHandler implements SocketEventHandler {
  readonly name = 'SyncControlHandler';

  register(socket: Socket, io: SocketIOServer): void {
    socket.on(
      'watch-together-control',
      async (payload: SyncControlPayload, callback?: AckCallback) => {
        try {
          // 校验是否为指定房间的活跃 sharer
          if (
            !(await roomPermissionService.isRoomHost(socket, payload.roomId))
          ) {
            return safeAck(callback, { success: false, message: '无权限控制' });
          }
          // 校验房间为 watch-together 模式（修复旧架构不校验模式的 bug）
          if (
            !(await roomPermissionService.isWatchTogetherRoom(payload.roomId))
          ) {
            return safeAck(callback, {
              success: false,
              message: '当前房间模式不支持同步播放',
            });
          }

          // 广播给房间内其他成员（不含发送者、不含 roomId）
          socket.to(payload.roomId).emit('watch-together-control', {
            action: payload.action,
            value: payload.value,
          });
          safeAck(callback, { success: true });
        } catch (err) {
          console.error('[watch-together-control] error:', err);
          safeAck(callback, { success: false, message: '控制失败' });
        }
      },
    );
  }
}
