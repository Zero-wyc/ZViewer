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
import type { RoomMode } from '../../../entities/Room';
import type { UserRole } from '../../../entities/User';
import {
  type AckCallback,
  type SocketEventHandler,
  safeAck,
} from '../../socket';
import { roomSessionService } from '../../room/room-session.service';
import { roomStateService } from '../../room/room-state.service';
import { movieBroadcasterService } from '../../movie';
import type { ViewerJoinedPayload } from '../../shared';
import { viewerListService } from '../viewer-list.service';

/** request-join 事件 payload */
interface RequestJoinPayload {
  roomId: string;
  password?: string;
}

/** 房主离线后观众仍可加入的宽限时间（毫秒）。5 分钟内房主不回来则无法加入。 */
const HOST_JOIN_GRACE_MS = 5 * 60 * 1000; // 5 分钟

/**
 * 给新观众补发房主当前的字幕状态（外挂/内嵌字幕轨道数据）。
 *
 * subtitle-update 仅在房主变更字幕时实时转发；观众中途加入或刷新页面时
 * 无法收到加入前已加载的字幕，导致观众端无字幕。此处从 roomStateService
 * 读取房主最近一次广播的缓存，单独下发给新观众 socket。
 */
function sendCachedSubtitle(io: SocketIOServer, roomId: string, socketId: string): void {
  const subtitle = roomStateService.getSubtitle(roomId);
  if (subtitle != null) {
    io.to(socketId).emit('subtitle-update', subtitle);
  }
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

          // 重复加入检测：同一账户（非 guest）不能在多个标签页同时进入同一房间。
          // guest 用户共享 userId=0 且允许无限多端进入（游客不受登录数限制），跳过检测。
          // 如果发现旧 session 但其 socket 已断开（session 未清理），先结束旧 session 再放行。
          const currentUserId: number | null = socket.data.userId ?? null;
          if (currentUserId != null && role !== 'guest') {
            const existingSession = await roomSessionService.findActiveSessionByUser(
              payload.roomId,
              currentUserId,
            );
            if (existingSession && existingSession.socketId !== socket.id) {
              // 检查旧 socket 是否仍连接
              const oldSocket = io.sockets.sockets.get(existingSession.socketId);
              if (oldSocket && oldSocket.connected) {
                return safeAck(callback, {
                  success: false,
                  code: 'ALREADY_IN_ROOM',
                  message: '该账户已在此房间内，不能同时打开多个标签页',
                });
              }
              // 旧 socket 已断开但 session 未清理：结束旧 session，放行
              await roomSessionService.endSession(existingSession.socketId);
            }
          }

          // 房主身份恢复：如果当前用户是房间 owner 或房间无 owner 记录，
          // 说明房主关闭标签页/浏览器后重新进入，sessionStorage 标记已丢失，
          // 走了观众流程。此时应自动恢复房主身份，而非创建 viewer session。
          const userId: number = socket.data.userId;
          const isRoomOwner = room.ownerUserId === userId;
          const isOrphanRoom = room.ownerUserId === null && role !== 'guest';
          if (
            userId != null &&
            role !== 'guest' &&
            (isRoomOwner || isOrphanRoom)
          ) {
            // 调用 registerHost 恢复 sharer session（复用旧 session 或创建新的）
            const hostResult = await roomSessionService.registerHost(
              socket,
              payload.roomId,
              userId,
            );
            if (hostResult) {
              // 同步 DB 影片到 roomStateService 并广播 movie-list
              await movieBroadcasterService.broadcastMovieList(io, payload.roomId);
              // 通知房间内其他成员房主已就绪
              socket.to(payload.roomId).emit('sharer-ready', { roomId: payload.roomId });

              return safeAck(callback, {
                success: true,
                message: '已恢复房主身份',
                data: {
                  mode: hostResult.mode as RoomMode,
                  shareMethod: hostResult.shareMethod as 'webrtc' | 'stream-push',
                  streamKey: hostResult.streamKey,
                  isHost: true,
                },
              });
            }
            // registerHost 失败（房间状态异常等），继续走观众流程
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

          // 校验房主在线：
          // - 需审批房间：房主必须在线（审批须由房主进行），离线时拒绝加入
          // - 免审批房间：房主离线但未超过 5 分钟宽限期时仍允许加入
          let sharer = null;
          if (room.requireApproval) {
            sharer = await roomSessionService.getSharer(payload.roomId);
          } else {
            sharer = await roomSessionService.getRecentSharer(
              payload.roomId,
              HOST_JOIN_GRACE_MS,
            );
          }
          if (!sharer) {
            return safeAck(callback, { success: false, message: '分享端不在线' });
          }

          // 免审批：直接加入房间
          if (room.requireApproval === false) {
            await roomSessionService.admitViewer(socket, payload.roomId, currentUserId);

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
            // 补发房主当前字幕状态（观众加入前已加载的字幕）
            sendCachedSubtitle(io, payload.roomId, socket.id);

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
              await roomSessionService.admitViewer(socket, payload.roomId, currentUserId);

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
              // 补发房主当前字幕状态（观众加入前已加载的字幕）
              sendCachedSubtitle(io, payload.roomId, socket.id);

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
              // 推送房管列表（权限 UI 初始化）
              await viewerListService.sendModerators(io, payload.roomId, socket.id);

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
