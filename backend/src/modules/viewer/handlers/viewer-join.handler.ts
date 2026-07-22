/**
 * 观众加入事件处理器。
 *
 * 处理 request-join 事件，根据房间 requireApproval 设置决定：
 * - 免审批：直接 admitViewer，推送影片列表与当前影片，广播 viewer-joined，补发其他在线 viewer
 * - 需审批：向房主发送 join-request，由房主通过 approve-join / reject-join 决定
 *
 * 消除旧架构中 routes/room.ts 内联的 request-join 逻辑。
 *
 * 修复点：
 * - 密码校验改用 bcrypt.compare（密码现在以 bcrypt 加密存储）
 * - viewer-joined / viewer-left 统一使用 viewerSocketId 字段
 */
import type { Server as SocketIOServer, Socket } from 'socket.io';
import bcrypt from 'bcryptjs';
import { AppDataSource } from '../../../data-source';
import { Room } from '../../../entities/Room';
import type { UserRole } from '../../../entities/User';
import {
  type AckCallback,
  type SocketEventHandler,
  safeAck,
} from '../../socket';
import { roomSessionService } from '../../room/room-session.service';
import { roomStateService } from '../../room/room-state.service';
import type { ViewerJoinedPayload } from '../../shared';
import { viewerListService } from '../viewer-list.service';

/** request-join 事件 payload */
interface RequestJoinPayload {
  roomId: string;
  password?: string;
}

/**
 * 观众加入事件处理器。
 */
export class ViewerJoinHandler implements SocketEventHandler {
  readonly name = 'viewer-join';

  register(socket: Socket, io: SocketIOServer): void {
    socket.on(
      'request-join',
      async (payload: RequestJoinPayload, callback: AckCallback) => {
        try {
          const role: UserRole = socket.data.role;
          const roomRepo = AppDataSource.getRepository(Room);
          const room = await roomRepo.findOneBy({ roomId: payload.roomId });

          // 校验房间存在且活跃
          if (!room) {
            return safeAck(callback, { success: false, message: '房间不存在' });
          }
          if (room.status !== 'active') {
            return safeAck(callback, { success: false, message: '房间已关闭' });
          }

          // 密码校验：root 跳过；其他角色使用 bcrypt.compare
          if (role !== 'root' && room.password) {
            const provided = payload.password ?? '';
            const ok = await bcrypt.compare(provided, room.password);
            if (!ok) {
              return safeAck(callback, { success: false, message: '密码错误' });
            }
          }

          // 人数上限校验
          const viewerCount = await roomSessionService.getViewerCount(
            payload.roomId,
          );
          if (viewerCount >= room.maxViewers) {
            return safeAck(callback, {
              success: false,
              message: '房间观看人数已达上限',
            });
          }

          // 校验房主在线
          const sharer = await roomSessionService.getSharer(payload.roomId);
          if (!sharer) {
            return safeAck(callback, { success: false, message: '分享端不在线' });
          }

          // 免审批：直接加入房间
          if (room.requireApproval === false) {
            await roomSessionService.admitViewer(socket, payload.roomId);

            // 推送房间信息给新观众
            io.to(socket.id).emit('join-approved', {
              roomId: payload.roomId,
              mode: room.mode,
              shareMethod: room.shareMethod,
              name: room.name,
            });

            // 推送影片列表与当前播放影片
            io.to(socket.id).emit('movie-list', {
              movies: roomStateService.getMovies(payload.roomId),
            });
            io.to(socket.id).emit('current-movie', {
              movieId: roomStateService.getCurrentMovieId(payload.roomId),
            });

            // 广播 viewer-joined 给房间内所有成员
            const joinedPayload: ViewerJoinedPayload = {
              viewerSocketId: socket.id,
              userId: socket.data.userId ?? null,
              username: socket.data.username ?? '未知用户',
              role: 'viewer',
            };
            viewerListService.broadcastViewerJoined(
              io,
              payload.roomId,
              joinedPayload,
            );

            // 给新观众补发其他在线 viewer
            await viewerListService.sendExistingViewers(
              io,
              payload.roomId,
              socket.id,
            );

            return safeAck(callback, {
              success: true,
              message: '已加入房间',
              data: {
                mode: room.mode,
                shareMethod: room.shareMethod,
                streamKey: room.streamKey,
              },
            });
          }

          // 需审批：检查是否已被房主批准过（持久化白名单）
          const viewerUserId: number | null = socket.data.userId ?? null;
          if (viewerUserId != null) {
            let approvedList: number[] = [];
            try {
              approvedList = JSON.parse(room.approvedViewers || '[]');
            } catch { /* ignore */ }
            if (approvedList.includes(viewerUserId)) {
              // 已批准用户直接加入，无需再次审批
              await roomSessionService.admitViewer(socket, payload.roomId);

              io.to(socket.id).emit('join-approved', {
                roomId: payload.roomId,
                mode: room.mode,
                shareMethod: room.shareMethod,
                streamKey: room.streamKey,
                name: room.name,
              });

              io.to(socket.id).emit('movie-list', {
                movies: roomStateService.getMovies(payload.roomId),
              });
              io.to(socket.id).emit('current-movie', {
                movieId: roomStateService.getCurrentMovieId(payload.roomId),
              });

              const joinedPayload: ViewerJoinedPayload = {
                viewerSocketId: socket.id,
                userId: socket.data.userId ?? null,
                username: socket.data.username ?? '未知用户',
                role: 'viewer',
              };
              viewerListService.broadcastViewerJoined(
                io,
                payload.roomId,
                joinedPayload,
              );

              await viewerListService.sendExistingViewers(
                io,
                payload.roomId,
                socket.id,
              );

              return safeAck(callback, {
                success: true,
                message: '已加入房间',
                data: {
                  mode: room.mode,
                  shareMethod: room.shareMethod,
                  streamKey: room.streamKey,
                },
              });
            }
          }

          // 未批准：向房主发送 join-request
          io.to(sharer.socketId).emit('join-request', {
            viewerSocketId: socket.id,
          });
          return safeAck(callback, {
            success: true,
            message: '等待分享端确认',
            data: {
              mode: room.mode,
              shareMethod: room.shareMethod,
              streamKey: room.streamKey,
            },
          });
        } catch (err) {
          console.error('[request-join] error:', err);
          return safeAck(callback, { success: false, message: '加入房间失败' });
        }
      },
    );
  }
}
