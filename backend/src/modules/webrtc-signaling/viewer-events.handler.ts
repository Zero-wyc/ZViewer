/**
 * 观众就绪事件处理器。
 *
 * 职责：
 * - viewer-ready：观众就绪通知房主 + 推送影片列表
 * - sharer-ready：房主开始共享时广播通知观众重发 viewer-ready
 *
 * 设计：实现 SocketEventHandler 接口，由 SocketRegistry 统一注册。
 * 迁移自 services/screen-sharing/viewer-events.ts。
 */
import type { Server as SocketIOServer, Socket } from 'socket.io';
import { IsNull } from 'typeorm';
import { AppDataSource } from '../../data-source';
import { Session } from '../../entities/Session';
import { roomStateService } from '../room/room-state.service';
import { roomPermissionService } from '../room/room-permission.service';
import type { SocketEventHandler } from '../socket';

export class ViewerEventsHandler implements SocketEventHandler {
  readonly name = 'webrtc-viewer-events';

  register(socket: Socket, io: SocketIOServer): void {
    // --- 观众就绪：通知房主可以开始推送流 ---
    socket.on(
      'viewer-ready',
      async (
        payload: { roomId: string },
        callback?: (response: { success: boolean; message?: string }) => void,
      ) => {
        try {
          if (!socket.rooms.has(payload.roomId)) {
            return callback?.({ success: false, message: '不在该房间中' });
          }

          const sessionRepo = AppDataSource.getRepository(Session);
          const sharer = await sessionRepo.findOneBy({
            roomId: payload.roomId,
            role: 'sharer',
            endedAt: IsNull(),
          });
          if (!sharer) {
            return callback?.({ success: false, message: '分享端不在线' });
          }

          console.log(
            `[viewer-ready] forward from viewer=${socket.id} to sharer=${sharer.socketId} room=${payload.roomId}`,
          );
          io.to(sharer.socketId).emit('viewer-ready', {
            from: socket.id,
          });

          // 推送影片列表与当前影片
          io.to(socket.id).emit('movie-list', {
            movies: roomStateService.getMovies(payload.roomId),
          });
          io.to(socket.id).emit('current-movie', {
            movieId: roomStateService.getCurrentMovieId(payload.roomId),
          });

          callback?.({ success: true });
        } catch (err) {
          console.error('[viewer-ready] error:', err);
          callback?.({ success: false, message: '处理失败' });
        }
      },
    );

    // --- 房主共享就绪：通知房间内所有观众重新发送 viewer-ready ---
    socket.on(
      'sharer-ready',
      async (
        payload: { roomId: string },
        callback?: (response: { success: boolean; message?: string }) => void,
      ) => {
        try {
          if (!(await roomPermissionService.isRoomHost(socket, payload.roomId))) {
            return callback?.({ success: false, message: '无权限' });
          }

          console.log(
            `[sharer-ready] broadcast from sharer=${socket.id} to room=${payload.roomId}`,
          );
          socket.to(payload.roomId).emit('sharer-ready', {
            roomId: payload.roomId,
          });

          callback?.({ success: true });
        } catch (err) {
          console.error('[sharer-ready] error:', err);
          callback?.({ success: false, message: '处理失败' });
        }
      },
    );
    // --- 房主共享启动失败：广播给房间内观众，避免观众在等待页无限挂起 ---
    // （借鉴 mirotalk handleToggleScreenException：启动失败也要保证观众端
    // 状态一致，给出明确提示而不是一直黑屏等待）
    socket.on(
      'sharer-error',
      async (
        payload: { roomId: string; message?: string },
        callback?: (response: { success: boolean; message?: string }) => void,
      ) => {
        try {
          if (!(await roomPermissionService.isRoomHost(socket, payload.roomId))) {
            return callback?.({ success: false, message: '无权限' });
          }

          console.log(
            `[sharer-error] broadcast from sharer=${socket.id} to room=${payload.roomId}`,
          );
          socket.to(payload.roomId).emit('sharer-error', {
            roomId: payload.roomId,
            message:
              typeof payload.message === 'string' && payload.message.length > 0 && payload.message.length <= 200
                ? payload.message
                : '房主屏幕共享启动失败，等待房主重试',
          });

          callback?.({ success: true });
        } catch (err) {
          console.error('[sharer-error] error:', err);
          callback?.({ success: false, message: '处理失败' });
        }
      },
    );
  }
}
