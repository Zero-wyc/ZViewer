/**
 * 观众管理事件处理器。
 *
 * 处理房主对观众的管理操作：批准加入、拒绝加入、踢出、禁言、解禁、转交房主。
 * 消除旧架构中 routes/room.ts 内联的 approve-join / reject-join / kick-viewer /
 * mute-viewer / unmute-viewer / transfer-host 逻辑。
 *
 * 权限规则：所有事件均要求调用方为当前房间的活跃 sharer（房主）。
 *
 * 修复点：
 * - viewer-left 事件统一使用 viewerSocketId 字段
 * - approve-join 复用 roomSessionService.admitViewer，消除与 request-join 的代码重复
 */
import type { Server as SocketIOServer, Socket } from 'socket.io';
import { IsNull } from 'typeorm';
import { AppDataSource } from '../../../data-source';
import { Room } from '../../../entities/Room';
import { Session } from '../../../entities/Session';
import type { UserRole } from '../../../entities/User';
import {
  type AckCallback,
  type SocketEventHandler,
  safeAck,
} from '../../socket';
import { roomPermissionService } from '../../room/room-permission.service';
import { roomSessionService } from '../../room/room-session.service';
import { roomStateService } from '../../room/room-state.service';
import type { ViewerJoinedPayload } from '../../shared';
import { viewerListService } from '../viewer-list.service';
import { viewerService } from '../viewer.service';

/** approve-join / reject-join 事件 payload */
interface ViewerSocketPayload {
  viewerSocketId: string;
}

/** kick-viewer 事件 payload */
interface KickViewerPayload {
  roomId: string;
  viewerSocketId: string;
}

/** mute-viewer / unmute-viewer 事件 payload */
interface MuteViewerPayload {
  roomId: string;
  userId: number;
}

/** appoint-moderator / dismiss-moderator 事件 payload */
interface ModeratorPayload {
  roomId: string;
  userId: number;
}

/** transfer-host 事件 payload */
interface TransferHostPayload {
  roomId: string;
  viewerSocketId: string;
}

/**
 * 观众管理事件处理器。
 */
export class ViewerManagementHandler implements SocketEventHandler {
  readonly name = 'viewer-management';

  register(socket: Socket, io: SocketIOServer): void {
    // --- 批准观众加入：仅 sharer ---
    socket.on(
      'approve-join',
      async (payload: ViewerSocketPayload, callback: AckCallback) => {
        try {
          // 通过 sharer session 校验权限并获取 roomId
          const sharer = await roomPermissionService.getSharerBySocketId(
            socket.id,
          );
          if (!sharer) {
            return safeAck(callback, { success: false, message: '无权限确认' });
          }

          const viewerSocket = io.sockets.sockets.get(payload.viewerSocketId);
          if (!viewerSocket) {
            return safeAck(callback, {
              success: false,
              message: '观看者已断开连接',
            });
          }

          const roomRepo = AppDataSource.getRepository(Room);
          const room = await roomRepo.findOneBy({ roomId: sharer.roomId });

          // 调用 admitViewer 创建 viewer session + join 房间
          await roomSessionService.admitViewer(
            viewerSocket,
            sharer.roomId,
            viewerSocket.data.userId ?? null,
          );

          // 推送房间信息给新观众
          io.to(payload.viewerSocketId).emit('join-approved', {
            roomId: sharer.roomId,
            mode: room?.mode ?? 'screen-share',
            shareMethod: room?.shareMethod ?? 'webrtc',
            streamKey: room?.streamKey ?? null,
            name: room?.name ?? null,
          });

          // 推送房管列表（权限 UI 初始化）
          await viewerListService.sendModerators(
            io,
            sharer.roomId,
            payload.viewerSocketId,
          );

          // 推送影片列表与当前播放影片
          io.to(payload.viewerSocketId).emit('movie-list', {
            movies: roomStateService.getMovies(sharer.roomId),
          });
          io.to(payload.viewerSocketId).emit('current-movie', {
            movieId: roomStateService.getCurrentMovieId(sharer.roomId),
          });
          // 补发房主当前字幕状态（观众加入前已加载的字幕）
          const cachedSubtitle = roomStateService.getSubtitle(sharer.roomId);
          if (cachedSubtitle != null) {
            io.to(payload.viewerSocketId).emit('subtitle-update', cachedSubtitle);
          }

          // 广播 viewer-joined 给房间内所有成员
          const joinedPayload: ViewerJoinedPayload = {
            viewerSocketId: payload.viewerSocketId,
            userId: viewerSocket.data?.userId ?? null,
            username: viewerSocket.data?.username ?? '未知用户',
            role: 'viewer',
          };
          viewerListService.broadcastViewerJoined(
            io,
            sharer.roomId,
            joinedPayload,
          );

          // 将观众 userId 加入持久化批准白名单，后续刷新/切换模式无需再次审批
          const approvedUserId: number | null = viewerSocket.data?.userId ?? null;
          if (approvedUserId != null && room) {
            let approvedList: number[] = [];
            try {
              approvedList = JSON.parse(room.approvedViewers || '[]');
            } catch { /* ignore */ }
            if (!approvedList.includes(approvedUserId)) {
              approvedList.push(approvedUserId);
              room.approvedViewers = JSON.stringify(approvedList);
              await roomRepo.save(room);
            }
          }

          // 给新观众补发其他在线 viewer
          await viewerListService.sendExistingViewers(
            io,
            sharer.roomId,
            payload.viewerSocketId,
          );

          return safeAck(callback, { success: true });
        } catch (err) {
          console.error('[approve-join] error:', err);
          return safeAck(callback, { success: false, message: '确认失败' });
        }
      },
    );

    // --- 拒绝观众加入：仅 sharer ---
    socket.on(
      'reject-join',
      async (payload: ViewerSocketPayload, callback: AckCallback) => {
        try {
          const sharer = await roomPermissionService.getSharerBySocketId(
            socket.id,
          );
          if (!sharer) {
            return safeAck(callback, { success: false, message: '无权限拒绝' });
          }

          io.to(payload.viewerSocketId).emit('join-rejected', {
            roomId: sharer.roomId,
          });
          return safeAck(callback, { success: true });
        } catch (err) {
          console.error('[reject-join] error:', err);
          return safeAck(callback, { success: false, message: '拒绝失败' });
        }
      },
    );

    // --- 踢出观众：房主或房管（防篡权校验统一走 canModeratorActOn） ---
    socket.on(
      'kick-viewer',
      async (payload: KickViewerPayload, callback: AckCallback) => {
        try {
          if (!(await roomPermissionService.isRoomHostOrModerator(socket, payload.roomId))) {
            return safeAck(callback, {
              success: false,
              message: '无权限：仅房主或房管可踢人',
            });
          }
          // 房管防篡权：不可踢房主/其他房管/root（房主不受限）
          if (!(await roomPermissionService.isRoomHost(socket, payload.roomId))) {
            const targetSocket = io.sockets.sockets.get(payload.viewerSocketId);
            const denial = await roomPermissionService.canModeratorActOn(
              payload.roomId,
              targetSocket?.data?.userId,
              targetSocket?.data?.role,
            );
            if (denial) {
              return safeAck(callback, { success: false, message: denial });
            }
          }

          // 调用 viewerService 踢出（含发 viewer-kicked、endViewerSession、disconnect）
          const ok = await viewerService.kickViewer(
            io,
            payload.roomId,
            payload.viewerSocketId,
          );
          if (!ok) {
            return safeAck(callback, { success: false, message: '观众已不在房间' });
          }

          // 广播 viewer-left 给房间内所有成员（统一使用 viewerSocketId 字段）
          viewerListService.broadcastViewerLeft(
            io,
            payload.roomId,
            payload.viewerSocketId,
          );

          return safeAck(callback, { success: true });
        } catch (err) {
          console.error('[kick-viewer] error:', err);
          return safeAck(callback, { success: false, message: '踢人失败' });
        }
      },
    );

    // --- 禁言观众：房主或房管 ---
    socket.on(
      'mute-viewer',
      async (payload: MuteViewerPayload, callback: AckCallback) => {
        try {
          if (!(await roomPermissionService.isRoomHostOrModerator(socket, payload.roomId))) {
            return safeAck(callback, {
              success: false,
              message: '无权限：仅房主或房管可禁言',
            });
          }

          // 禁言按 userId 存储，游客共享 userId=0 会误伤全体游客，
          // 拒绝并引导使用踢出
          if (!payload.userId || payload.userId <= 0) {
            return safeAck(callback, {
              success: false,
              message: '游客无法单独禁言，请使用踢出',
            });
          }

          // 房管防篡权：不可禁言房主/其他房管/root（房主不受限）
          if (!(await roomPermissionService.isRoomHost(socket, payload.roomId))) {
            const denial = await roomPermissionService.canModeratorActOn(
              payload.roomId,
              payload.userId,
            );
            if (denial) {
              return safeAck(callback, { success: false, message: denial });
            }
          }

          await viewerService.setMuted(
            payload.roomId,
            payload.userId,
            true,
          );

          // 通知房间内所有成员，前端立即禁用该用户的评论/弹幕输入
          io.to(payload.roomId).emit('viewer-muted', {
            userId: payload.userId,
            muted: true,
          });

          return safeAck(callback, { success: true });
        } catch (err) {
          console.error('[mute-viewer] error:', err);
          return safeAck(callback, { success: false, message: '禁言失败' });
        }
      },
    );

    // --- 解除禁言：房主或房管 ---
    socket.on(
      'unmute-viewer',
      async (payload: MuteViewerPayload, callback: AckCallback) => {
        try {
          if (
            !(await roomPermissionService.isRoomHostOrModerator(socket, payload.roomId))
          ) {
            return safeAck(callback, {
              success: false,
              message: '无权限：仅房主或房管可解禁',
            });
          }

          await viewerService.setMuted(
            payload.roomId,
            payload.userId,
            false,
          );

          io.to(payload.roomId).emit('viewer-muted', {
            userId: payload.userId,
            muted: false,
          });

          return safeAck(callback, { success: true });
        } catch (err) {
          console.error('[unmute-viewer] error:', err);
          return safeAck(callback, { success: false, message: '解禁失败' });
        }
      },
    );

    // --- 转交房主：仅 sharer ---
    socket.on(
      'transfer-host',
      async (payload: TransferHostPayload, callback: AckCallback) => {
        try {
          if (!(await roomPermissionService.isRoomHost(socket, payload.roomId))) {
            return safeAck(callback, {
              success: false,
              message: '无权限：仅房主可转交',
            });
          }

          const targetSocket = io.sockets.sockets.get(payload.viewerSocketId);
          if (!targetSocket) {
            return safeAck(callback, {
              success: false,
              message: '目标观众已断开',
            });
          }

          // 拒绝转交给 guest 用户（房主必须为 root/admin/user）
          const targetRole: UserRole | undefined = targetSocket.data?.role;
          if (targetRole === 'guest') {
            return safeAck(callback, {
              success: false,
              message: '不能转交给游客账户',
            });
          }

          const newOwnerUserId: number | null = targetSocket.data?.userId ?? null;
          if (newOwnerUserId == null) {
            return safeAck(callback, {
              success: false,
              message: '目标观众身份无效',
            });
          }

          // 调用 transferHost 完成角色与 owner 切换（事务保证原子性；
          // 若新房主原为房管，事务内同步从 moderators 移除）
          const nextModerators = await roomSessionService.transferHost(
            payload.roomId,
            payload.viewerSocketId,
            socket.id,
            newOwnerUserId,
          );

          // 通知房间内所有成员房主已变更
          io.to(payload.roomId).emit('host-transferred', {
            newHostSocketId: payload.viewerSocketId,
            oldHostSocketId: socket.id,
            newOwnerUserId,
          });

          // 房管列表有变化时同步广播（前端更新房管徽标）
          if (nextModerators) {
            io.to(payload.roomId).emit('moderators-changed', {
              roomId: payload.roomId,
              moderators: nextModerators,
            });
          }

          return safeAck(callback, { success: true });
        } catch (err) {
          console.error('[transfer-host] error:', err);
          return safeAck(callback, { success: false, message: '转交房主失败' });
        }
      },
    );

    // --- 任命房管：仅房主 ---
    socket.on(
      'appoint-moderator',
      async (payload: ModeratorPayload, callback: AckCallback) => {
        try {
          if (!(await roomPermissionService.isRoomHost(socket, payload.roomId))) {
            return safeAck(callback, {
              success: false,
              message: '无权限：仅房主可任命房管',
            });
          }

          // 房管必须为登录用户（userId > 0），游客无法被任命
          if (!payload.userId || payload.userId <= 0) {
            return safeAck(callback, {
              success: false,
              message: '不能任命游客为房管',
            });
          }

          // 不能任命房主本人（房主天然拥有全部权限）
          const room = await AppDataSource.getRepository(Room).findOneBy({
            roomId: payload.roomId,
          });
          if (room && room.ownerUserId === payload.userId) {
            return safeAck(callback, {
              success: false,
              message: '房主无需任命',
            });
          }

          const moderators = await roomPermissionService.getModerators(
            payload.roomId,
          );
          if (moderators.includes(payload.userId)) {
            return safeAck(callback, { success: true });
          }

          // 目标必须在房间内（在线观众/sharer session 中存在）
          const isTargetInRoom = await AppDataSource.getRepository(Session)
            .findOneBy({
              roomId: payload.roomId,
              userId: payload.userId,
              endedAt: IsNull(),
            });
          if (!isTargetInRoom) {
            return safeAck(callback, {
              success: false,
              message: '目标用户不在房间内',
            });
          }

          // 房管人数上限（防止滥用，房间人数本身受 maxViewers 约束）
          const MAX_MODERATORS = 10;
          if (moderators.length >= MAX_MODERATORS) {
            return safeAck(callback, {
              success: false,
              message: `房管人数已达上限（${MAX_MODERATORS}）`,
            });
          }

          moderators.push(payload.userId);
          await roomPermissionService.setModerators(payload.roomId, moderators);

          // 广播给房间内所有成员，前端更新房管标记与权限 UI
          io.to(payload.roomId).emit('moderators-changed', {
            roomId: payload.roomId,
            moderators,
          });

          return safeAck(callback, { success: true, data: { moderators } });
        } catch (err) {
          console.error('[appoint-moderator] error:', err);
          return safeAck(callback, { success: false, message: '任命房管失败' });
        }
      },
    );

    // --- 撤销房管：仅房主 ---
    socket.on(
      'dismiss-moderator',
      async (payload: ModeratorPayload, callback: AckCallback) => {
        try {
          if (!(await roomPermissionService.isRoomHost(socket, payload.roomId))) {
            return safeAck(callback, {
              success: false,
              message: '无权限：仅房主可撤销房管',
            });
          }

          const moderators = await roomPermissionService.getModerators(
            payload.roomId,
          );
          if (!moderators.includes(payload.userId)) {
            return safeAck(callback, { success: true });
          }
          const next = moderators.filter((id) => id !== payload.userId);
          await roomPermissionService.setModerators(payload.roomId, next);

          io.to(payload.roomId).emit('moderators-changed', {
            roomId: payload.roomId,
            moderators: next,
          });

          return safeAck(callback, { success: true, data: { moderators: next } });
        } catch (err) {
          console.error('[dismiss-moderator] error:', err);
          return safeAck(callback, { success: false, message: '撤销房管失败' });
        }
      },
    );
  }
}
