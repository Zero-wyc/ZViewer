import { Server as SocketIOServer } from 'socket.io';
import { IsNull } from 'typeorm';
import { AppDataSource } from '../../data-source';
import { Session } from '../../entities/Session';
import { roomStateService } from '../../modules/room/room-state.service';
import { roomPermissionService } from '../../modules/room/room-permission.service';

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

        // 查找房间的 sharer session 用于转发信令（非权限校验，故直接查表）
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

        // 推送影片列表与当前影片（使用新架构 roomStateService）
        io.to(socket.id).emit('movie-list', {
          movies: roomStateService.getMovies(payload.roomId),
        });
        io.to(socket.id).emit('current-movie', {
          movieId: roomStateService.getCurrentMovieId(payload.roomId),
        });

        callback?.({ success: true });
      },
    );

    // --- 房主共享就绪：通知房间内所有观众重新发送 viewer-ready ---
    // 用于房主开始屏幕共享时通知观众重新触发信令流程。
    // 注意：register-host.handler.ts 在房主注册时也会广播 sharer-ready（socket.to 排除发送者），
    // 此处仅处理房主主动开始共享（非注册）的场景。
    socket.on(
      'sharer-ready',
      async (
        payload: { roomId: string },
        callback?: (response: { success: boolean; message?: string }) => void,
      ) => {
        // 通过统一权限服务校验房主身份
        if (!(await roomPermissionService.isRoomHost(socket, payload.roomId))) {
          return callback?.({ success: false, message: '无权限' });
        }

        console.log(
          `[sharer-ready] broadcast from sharer=${socket.id} to room=${payload.roomId}`,
        );
        // 仅广播给房间内其他成员（排除发送者），避免房主自身重复触发
        socket.to(payload.roomId).emit('sharer-ready', {
          roomId: payload.roomId,
        });

        callback?.({ success: true });
      },
    );
  });
}
