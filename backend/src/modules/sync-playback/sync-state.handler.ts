/**
 * 同步状态事件处理器。
 *
 * 处理：
 * - watch-together-state：房主向房间内其他成员同步完整播放状态，并持久化到运行时状态
 * - watch-together-request-state：房间内任意成员请求其他成员同步当前播放状态
 *
 * 修复旧架构 bug：
 * 1. 旧版 services/room/sync.ts 不校验 room.mode，screen-share 模式下也会处理同步事件。
 *    此版本通过 roomPermissionService.isWatchTogetherRoom 强制校验模式。
 * 2. 旧版直接查 Session 表做权限校验，此版本统一走 roomPermissionService。
 */
import type { Server as SocketIOServer, Socket } from 'socket.io';
import type { AckCallback, SocketEventHandler } from '../socket';
import { safeAck } from '../socket';
import { roomPermissionService } from '../room/room-permission.service';
import { roomStateService } from '../room/room-state.service';
import type {
  PlaybackStateDto,
  SyncStatePayload,
} from '../shared/dto';

export class SyncStateHandler implements SocketEventHandler {
  readonly name = 'SyncStateHandler';

  register(socket: Socket, io: SocketIOServer): void {
    // --- 房主同步播放状态 ---
    // 仅活跃 sharer 可调用，持久化后广播给房间内其他成员（不含发送者、不含 roomId）
    socket.on(
      'watch-together-state',
      async (payload: SyncStatePayload, callback?: AckCallback) => {
        try {
          // 校验是否为指定房间的活跃 sharer
          if (
            !(await roomPermissionService.isRoomHost(socket, payload.roomId))
          ) {
            return safeAck(callback, { success: false, message: '无权限同步' });
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

          // 持久化房主最近一次广播的播放状态，用于房主刷新/重连后恢复进度。
          // currentMovieId 从 roomStateService 取：B站 URL 每次解析会变，
          // 房主刷新后通过影片 ID 匹配恢复，因此与播放状态一并持久化。
          const currentMovieId = roomStateService.getCurrentMovieId(
            payload.roomId,
          );
          const playback: Omit<PlaybackStateDto, 'updatedAt'> = {
            ...payload.state,
            currentMovieId:
              currentMovieId != null ? Number(currentMovieId) : undefined,
          };
          roomStateService.setPlayback(payload.roomId, playback);

          // 广播给房间内其他成员（不含 roomId，接收端按 socket 所在房间处理）
          socket.to(payload.roomId).emit('watch-together-state', {
            state: payload.state,
          });
          safeAck(callback, { success: true });
        } catch (err) {
          console.error('[watch-together-state] error:', err);
          safeAck(callback, { success: false, message: '同步失败' });
        }
      },
    );

    // --- 请求房间内同步状态 ---
    // 房间内任意成员可触发，广播给其他成员，让房主主动同步当前状态
    socket.on(
      'watch-together-request-state',
      async (payload: { roomId: string }, callback?: AckCallback) => {
        try {
          // 校验在房间内
          if (
            !(await roomPermissionService.isInRoom(socket, payload.roomId))
          ) {
            return safeAck(callback, {
              success: false,
              message: '不在该房间中',
            });
          }
          // 广播给房间内其他成员，让房主主动同步状态
          socket.to(payload.roomId).emit('watch-together-request-state');
          safeAck(callback, { success: true });
        } catch (err) {
          console.error('[watch-together-request-state] error:', err);
          safeAck(callback, { success: false, message: '请求失败' });
        }
      },
    );
  }
}
