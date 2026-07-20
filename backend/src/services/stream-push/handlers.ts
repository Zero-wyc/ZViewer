import { Server as SocketIOServer } from 'socket.io';
import { IsNull } from 'typeorm';
import { AppDataSource } from '../../data-source';
import { Room, type ShareMethod } from '../../entities/Room';
import { Session } from '../../entities/Session';

// 注册推流模式相关 socket 事件
// 内部注册 io.on('connection', ...)，所有事件均在该处理器内注册
export function registerStreamPushHandlers(io: SocketIOServer): void {
  io.on('connection', (socket) => {
    // --- 房主切换投屏子模式（webrtc <-> stream-push） ---
    socket.on(
      'update-share-method',
      async (
        payload: { roomId: string; shareMethod: ShareMethod },
        callback?: (response: {
          success: boolean;
          message?: string;
          shareMethod?: ShareMethod;
        }) => void,
      ) => {
        try {
          if (!socket.rooms.has(payload.roomId)) {
            return callback?.({ success: false, message: '不在该房间中' });
          }

          // 仅房主（sharer session）可切换
          const sessionRepo = AppDataSource.getRepository(Session);
          const sharer = await sessionRepo.findOneBy({
            socketId: socket.id,
            role: 'sharer',
            endedAt: IsNull(),
          });
          if (!sharer || sharer.roomId !== payload.roomId) {
            return callback?.({ success: false, message: '无权限：仅房主可切换子模式' });
          }

          const roomRepo = AppDataSource.getRepository(Room);
          const room = await roomRepo.findOneBy({ roomId: payload.roomId });
          if (!room) {
            return callback?.({ success: false, message: '房间不存在' });
          }
          if (room.mode !== 'screen-share') {
            return callback?.({
              success: false,
              message: '仅投屏模式支持子模式切换',
            });
          }

          room.shareMethod = payload.shareMethod;
          await roomRepo.save(room);

          console.log(
            `[update-share-method] room=${payload.roomId} shareMethod=${payload.shareMethod}`,
          );

          io.to(payload.roomId).emit('share-method-changed', {
            roomId: payload.roomId,
            shareMethod: payload.shareMethod,
          });

          callback?.({
            success: true,
            shareMethod: payload.shareMethod,
          });
        } catch (err) {
          console.error('update-share-method error:', err);
          callback?.({ success: false, message: '切换子模式失败' });
        }
      },
    );
  });
}
