import { Server as SocketIOServer } from 'socket.io';
import { IsNull } from 'typeorm';
import { AppDataSource } from '../../data-source';
import { Session } from '../../entities/Session';
import { getRoomState } from '../room/state';

// 注册观众就绪相关的事件处理器
// 内部注册 io.on('connection', ...)，所有事件均在该处理器内注册
export function registerViewerEventHandlers(io: SocketIOServer): void {
  io.on('connection', (socket) => {
    // --- 观众就绪：通知房主可以开始推送流 ---
    socket.on(
      'viewer-ready',
      async (
        payload: { roomId: string },
        callback?: (response: { success: boolean; message?: string }) => void,
      ) => {
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

        const roomState = getRoomState(payload.roomId);
        io.to(socket.id).emit('movie-list', {
          movies: roomState.movies,
        });
        io.to(socket.id).emit('current-movie', {
          movieId: roomState.currentMovieId,
        });

        callback?.({ success: true });
      },
    );

    // --- 房主共享就绪：通知房间内所有观众重新发送 viewer-ready
    // 用于处理观众先加入、房主后开始共享的场景，确保观众端重新触发信令流程
    socket.on(
      'sharer-ready',
      async (
        payload: { roomId: string },
        callback?: (response: { success: boolean; message?: string }) => void,
      ) => {
        const sessionRepo = AppDataSource.getRepository(Session);
        const sharer = await sessionRepo.findOneBy({
          socketId: socket.id,
          role: 'sharer',
          endedAt: IsNull(),
        });
        if (!sharer || sharer.roomId !== payload.roomId) {
          return callback?.({ success: false, message: '无权限' });
        }

        console.log(
          `[sharer-ready] broadcast from sharer=${socket.id} to room=${payload.roomId}`,
        );
        io.to(payload.roomId).emit('sharer-ready', {
          roomId: payload.roomId,
        });

        callback?.({ success: true });
      },
    );
  });
}
