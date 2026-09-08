/**
 * 房间生命周期事件处理器。
 *
 * 处理房间的创建、关闭、管理员强制关闭事件。
 * 消除旧架构中 index.ts 内联的 create-room / close-room / admin-close-room 逻辑。
 *
 * 设计要点：
 * - 创建房间权限由 roomPermissionService.canCreateRoom 统一判断（依据系统设置 roomCreationMode）
 * - 使用 8 位 nanoid 作为 roomId
 * - 密码使用 bcrypt 加密后持久化
 * - 关闭房间统一走 roomStateService.closeRoomAndNotify
 */
import type { Server as SocketIOServer, Socket } from 'socket.io';
import { customAlphabet } from 'nanoid';
import bcrypt from 'bcryptjs';
import { AppDataSource } from '../../../data-source';
import { Room } from '../../../entities/Room';
import { Session } from '../../../entities/Session';
import type { UserRole } from '../../../entities/User';
import { getSystemSettings } from '../../../services/system-settings';
import {
  type AckCallback,
  type SocketEventHandler,
  safeAck,
} from '../../socket';
import { roomPermissionService } from '../room-permission.service';
import { roomSessionService } from '../room-session.service';
import { roomStateService } from '../room-state.service';
import { playbackMemoryService } from '../../playback-memory';

/** 8 位 roomId 生成器（数字 + 大小写字母） */
const generateRoomId = customAlphabet(
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
  8,
);

/** create-room 事件 payload */
interface CreateRoomPayload {
  name?: string;
  password?: string;
  maxViewers?: number;
  requireApproval?: boolean;
  mode?: 'screen-share' | 'watch-together' | 'listen-together';
}

/** admin-close-room 事件 payload */
interface AdminCloseRoomPayload {
  roomId: string;
}

/**
 * 房间生命周期事件处理器。
 */
export class RoomLifecycleHandler implements SocketEventHandler {
  readonly name = 'room-lifecycle';

  register(socket: Socket, io: SocketIOServer): void {
    // --- 创建房间：根据系统设置 roomCreationMode 校验 ---
    // 权限规则集中在 roomPermissionService.canCreateRoom，禁止在此硬编码角色判断。
    socket.on(
      'create-room',
      async (payload: CreateRoomPayload, callback: AckCallback) => {
        try {
          const userId: number = socket.data.userId;
          const role: UserRole = socket.data.role;
          const settings = await getSystemSettings();
          if (!roomPermissionService.canCreateRoom(role, settings)) {
            const hint =
              role === 'guest'
                ? '请先登录后再创建房间'
                : settings.roomCreationMode === 'admin-only'
                  ? '无权限：当前仅管理员可创建房间（请联系管理员开启「所有用户」权限）'
                  : '无权限：当前账号无法创建房间';
            return safeAck(callback, {
              success: false,
              message: hint,
            });
          }

          // 创建新房间前，查找并离开用户当前活跃的旧房间（sharer session）。
          // 否则 socket 会同时存在于新旧两个房间，收到旧房间的 movie-list 等
          // 广播事件，导致新房间显示旧房间的影片列表。
          const oldSharer = await roomPermissionService.getSharerBySocketId(socket.id);
          if (oldSharer && oldSharer.roomId) {
            socket.leave(oldSharer.roomId);
            // 结束旧 session，避免旧房间的状态残留
            oldSharer.endedAt = new Date();
            await AppDataSource.getRepository(Session).save(oldSharer);
            // 失效权限缓存：旧 socket 的 isRoomHost 缓存应立即清除
            roomPermissionService.invalidatePermissionCache(oldSharer.socketId, oldSharer.roomId);
            // 通知旧房间（如有观众）房主已离开
            roomStateService.cancelReconnectTimer(oldSharer.roomId);
          }

          const roomRepo = AppDataSource.getRepository(Room);

          // 生成唯一的 8 位 roomId
          let roomId = generateRoomId();
          while (await roomRepo.existsBy({ roomId })) {
            roomId = generateRoomId();
          }

          // 密码使用 bcrypt 加密
          const rawPassword = payload.password?.trim() || '';
          const passwordHash = rawPassword ? await bcrypt.hash(rawPassword, 10) : null;

          const room = roomRepo.create({
            roomId,
            name: payload.name?.trim() || `房间 ${roomId}`,
            password: passwordHash,
            maxViewers: payload.maxViewers ?? 10,
            status: 'active',
            mode: payload.mode ?? 'screen-share',
            requireApproval: payload.requireApproval ?? false,
            ownerUserId: userId || null,
          });
          await roomRepo.save(room);
          await roomRepo.update({ roomId }, { lastAccessedAt: new Date() });

          // 创建 sharer session（房主注册）
          await roomSessionService.registerHost(socket, roomId, userId);

          return safeAck(callback, {
            success: true,
            data: { roomId, mode: room.mode },
          });
        } catch (err) {
          console.error('[create-room] error:', err);
          return safeAck(callback, { success: false, message: '创建房间失败' });
        }
      },
    );

    // --- 房主主动离开房间（不关闭房间）：仅当前 socket 为活跃 sharer ---
    // 与 close-room 区别：
    // - close-room：销毁房间（DB status='closed'、踢出观众、清播放记忆）
    // - host-leave：保留房间，复用断线（disconnect）的处理逻辑
    //   清空 hostSocketId、广播 host-disconnected、启动 10 分钟重连定时器
    //   观众进入自主控制模式，房主可在宽限期内通过 register-host 恢复
    socket.on('host-leave', async (callback: AckCallback) => {
      try {
        const sharer = await roomPermissionService.getSharerBySocketId(socket.id);
        if (!sharer) {
          return safeAck(callback, { success: false, message: '无权限离开房间' });
        }

        const roomId = sharer.roomId;

        // 结束当前 sharer session（与 disconnect handler 一致）
        // 让 register-host 重连时可以复用或重建 session
        await roomSessionService.endSession(socket.id);

        // 清空 hostSocketId，但保留播放状态（playback 仍在内存/DB）
        // 服务器将继续推算播放进度并广播给观众，观众可继续观看
        await playbackMemoryService.updateHostSocket(roomId, null);

        // 广播 host-disconnected 给房间内所有成员
        // 观众端据此进入"自主控制模式"
        io.to(roomId).emit('host-disconnected', { roomId });

        // 启动重连定时器：超时（10 分钟）则关闭房间
        roomStateService.startReconnectTimer(roomId, () => {
          void roomStateService.closeRoomAndNotify(io, roomId, socket.id);
        });

        // 房主 socket 主动离开房间（保持 socket 连接，允许房主浏览其他页面）
        await socket.leave(roomId);

        return safeAck(callback, { success: true });
      } catch (err) {
        console.error('[host-leave] error:', err);
        return safeAck(callback, { success: false, message: '离开房间失败' });
      }
    });

    // --- 关闭自己的房间：仅当前 socket 为活跃 sharer ---
    socket.on('close-room', async (callback: AckCallback) => {
      try {
        // 查询当前 socket 的活跃 sharer session（跨房间查询）
        const sharer = await roomPermissionService.getSharerBySocketId(socket.id);
        if (!sharer) {
          return safeAck(callback, { success: false, message: '无权限关闭房间' });
        }

        // 取消可能的重连定时器，避免重复触发关闭
        roomStateService.cancelReconnectTimer(sharer.roomId);

        await roomStateService.closeRoomAndNotify(io, sharer.roomId, socket.id);
        socket.leave(sharer.roomId);
        return safeAck(callback, { success: true });
      } catch (err) {
        console.error('[close-room] error:', err);
        return safeAck(callback, { success: false, message: '关闭房间失败' });
      }
    });

    // --- 管理员强制关闭房间：仅 admin/root ---
    socket.on(
      'admin-close-room',
      async (payload: AdminCloseRoomPayload, callback: AckCallback) => {
        try {
          const role: UserRole = socket.data.role;
          if (role !== 'admin' && role !== 'root') {
            return safeAck(callback, {
              success: false,
              message: '无权限：仅管理员可关闭房间',
            });
          }

          const roomRepo = AppDataSource.getRepository(Room);
          const room = await roomRepo.findOneBy({ roomId: payload.roomId });
          if (!room) {
            return safeAck(callback, { success: false, message: '房间不存在' });
          }

          // 查询房间内活跃 sharer，作为「不被踢出」的 socketId
          const sharer = await roomSessionService.getSharer(payload.roomId);
          if (!sharer) {
            return safeAck(callback, {
              success: false,
              message: '分享端不在线',
            });
          }

          // 取消可能的重连定时器
          roomStateService.cancelReconnectTimer(payload.roomId);

          await roomStateService.closeRoomAndNotify(
            io,
            payload.roomId,
            sharer.socketId,
          );
          return safeAck(callback, { success: true });
        } catch (err) {
          console.error('[admin-close-room] error:', err);
          return safeAck(callback, { success: false, message: '关闭房间失败' });
        }
      },
    );
  }
}
