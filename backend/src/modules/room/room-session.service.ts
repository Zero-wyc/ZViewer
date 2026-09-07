/**
 * 房间 Session 管理服务。
 *
 * 封装 Session 表的 CRUD 操作，包括房主注册、观众加入、断线处理、重连恢复。
 *
 * 设计目的：
 * - 消除旧架构中 request-join 与 approve-join 的大段代码重复
 * - 封装房主断线重连的定时器逻辑
 * - 修复旧架构中 socket.data.role !== 'sharer' 死代码问题
 */
import type { Server as SocketIOServer, Socket } from 'socket.io';
import { IsNull } from 'typeorm';
import { AppDataSource } from '../../data-source';
import { Session } from '../../entities/Session';
import { roomPermissionService } from './room-permission.service';
import { Room } from '../../entities/Room';
import { roomStateService } from './room-state.service';
import { playbackMemoryService } from '../playback-memory';

/**
 * 房间 Session 服务。
 */
export class RoomSessionService {
  /**
   * 注册房主（首次或重连）。
   *
   * - 若存在同 ownerUserId 的旧 sharer session，复用并更新 socketId
   * - 否则创建新的 sharer session
   * - 取消重连定时器
   *
   * @returns 房间信息和 playback 状态（用于恢复）
   */
  async registerHost(
    socket: Socket,
    roomId: string,
    userId: number,
  ): Promise<{
    mode: string;
    shareMethod: string;
    name: string | null;
    streamKey: string | null;
    requireApproval: boolean;
    playback?: ReturnType<typeof roomStateService.getPlayback>;
  } | null> {
    const roomRepo = AppDataSource.getRepository(Room);
    const sessionRepo = AppDataSource.getRepository(Session);

    const room = await roomRepo.findOneBy({ roomId, status: 'active' });
    if (!room) return null;

    // 校验房主身份：ownerUserId 为 null 时（guest 创建的房间），允许任何非 guest 用户接管
    if (room.ownerUserId !== null && room.ownerUserId !== userId) return null;

    // 无 owner 的房间：设置当前用户为 owner
    if (room.ownerUserId === null) {
      await roomRepo.update({ roomId }, { ownerUserId: userId });
    }

    // 取消重连定时器
    roomStateService.cancelReconnectTimer(roomId);

    // 复用旧 session 或创建新的
    const existingSharer = await sessionRepo.findOneBy({
      roomId,
      role: 'sharer',
      endedAt: IsNull(),
    });

    if (existingSharer) {
      // 更新 socketId（重连场景）
      existingSharer.socketId = socket.id;
      existingSharer.userId = userId;
      await sessionRepo.save(existingSharer);
    } else {
      // 创建新 session
      const session = sessionRepo.create({
        roomId,
        socketId: socket.id,
        role: 'sharer',
        userId,
      });
      await sessionRepo.save(session);
    }

    // 加入 socket.io 房间
    await socket.join(roomId);

    // 更新最后访问时间
    await roomRepo.update({ roomId }, { lastAccessedAt: new Date() });

    // 更新播放记忆中的 hostSocketId（房主重连）
    await playbackMemoryService.updateHostSocket(roomId, socket.id);

    // 从播放记忆服务获取推算后的状态（房主重连后从服务器进度恢复）
    const advancedPlayback = await playbackMemoryService.getAdvancedPlayback(roomId);

    return {
      mode: room.mode,
      shareMethod: room.shareMethod,
      name: room.name,
      streamKey: room.streamKey,
      requireApproval: room.requireApproval,
      playback: advancedPlayback ?? roomStateService.getPlayback(roomId),
    };
  }

  /**
   * 观众加入房间（创建 viewer session + join socket.io room）。
   *
   * 统一 request-join（直接加入）和 approve-join（审批后加入）的逻辑。
   */
  async admitViewer(
    socket: Socket,
    roomId: string,
    userId?: number | null,
  ): Promise<Session | null> {
    const sessionRepo = AppDataSource.getRepository(Session);
    const roomRepo = AppDataSource.getRepository(Room);

    // 更新房间最后访问时间
    await roomRepo.update({ roomId }, { lastAccessedAt: new Date() });

    // 创建 viewer session
    const session = sessionRepo.create({
      roomId,
      socketId: socket.id,
      role: 'viewer',
      userId: userId ?? null,
    });
    await sessionRepo.save(session);

    // 加入 socket.io 房间
    await socket.join(roomId);

    return session;
  }

  /**
   * 结束 socket 的活跃 session（断线处理）。
   *
   * @returns 结束的 session 信息（用于判断是房主还是观众断线）
   */
  async endSession(socketId: string): Promise<Session | null> {
    const sessionRepo = AppDataSource.getRepository(Session);
    const session = await sessionRepo.findOneBy({
      socketId,
      endedAt: IsNull(),
    });
    if (!session) return null;

    session.endedAt = new Date();
    await sessionRepo.save(session);
    // 失效权限缓存：session 结束后该 socket 的权限应即时清除
    roomPermissionService.invalidatePermissionCache(socketId, session.roomId);
    return session;
  }

  /**
   * 获取房间内所有活跃 viewer session。
   */
  async getViewers(roomId: string): Promise<Session[]> {
    const sessionRepo = AppDataSource.getRepository(Session);
    return sessionRepo.findBy({
      roomId,
      role: 'viewer',
      endedAt: IsNull(),
    });
  }

  /**
   * 获取房间内活跃 sharer session。
   */
  async getSharer(roomId: string): Promise<Session | null> {
    const sessionRepo = AppDataSource.getRepository(Session);
    return sessionRepo.findOneBy({
      roomId,
      role: 'sharer',
      endedAt: IsNull(),
    });
  }

  /**
   * 获取房间内最近的 sharer session（包括已结束的）。
   *
   * 用于房主短时间离线时允许观众加入：如果上一个 sharer session 结束时间在 maxAgeMs 内，
   * 视为房主"暂离"，允许观众加入房间。
   */
  async getRecentSharer(roomId: string, maxAgeMs: number): Promise<Session | null> {
    const sessionRepo = AppDataSource.getRepository(Session);
    const session = await sessionRepo.findOne({
      where: { roomId, role: 'sharer' },
      order: { startedAt: 'DESC' },
    });
    if (!session) return null;
    // 如果房主在线（endedAt 为 null），直接返回
    if (!session.endedAt) return session;
    // 如果房主离线但未超过宽限期，仍视为"有效"
    const elapsed = Date.now() - session.endedAt.getTime();
    if (elapsed <= maxAgeMs) return session;
    return null;
  }

  /**
   * 检查房间是否在线（有活跃 sharer）。
   */
  async isSharerOnline(roomId: string): Promise<boolean> {
    const sharer = await this.getSharer(roomId);
    return !!sharer;
  }

  /**
   * 获取房间内活跃观众数量（不含 sharer）。
   */
  async getViewerCount(roomId: string): Promise<number> {
    const viewers = await this.getViewers(roomId);
    return viewers.length;
  }

  /**
   * 查找同一用户在同一房间的活跃 session。
   *
   * 用于检测同一账户是否已通过另一个标签页/设备进入同一房间。
   * guest 用户（userId 为 null）不检测，直接返回 null。
   *
   * @returns 活跃 session（endedAt 为 null）或 null
   */
  async findActiveSessionByUser(
    roomId: string,
    userId: number | null,
  ): Promise<Session | null> {
    if (userId == null) return null;
    const sessionRepo = AppDataSource.getRepository(Session);
    return sessionRepo.findOneBy({
      roomId,
      userId,
      endedAt: IsNull(),
    });
  }

  /**
   * 结束指定 viewer 的 session（踢出）。
   */
  async endViewerSession(socketId: string): Promise<Session | null> {
    return this.endSession(socketId);
  }

  /**
   * 转交房主：将原 sharer 降级为 viewer，将指定 viewer 升级为 sharer。
   *
   * 使用事务保证原子性（修复旧架构无事务包裹的问题）。
   * 若新房主原为房管，同步从 moderators 移除（房主天然拥有全部权限，
   * 保留条目会让前端给新房主显示"房管"徽标并残留脏数据）。
   *
   * @returns 清理后的 moderators 列表（无变化时返回 null，调用方无需广播）
   */
  async transferHost(
    roomId: string,
    newSharerSocketId: string,
    oldSharerSocketId: string,
    newOwnerUserId: number,
  ): Promise<number[] | null> {
    const sessionRepo = AppDataSource.getRepository(Session);
    const roomRepo = AppDataSource.getRepository(Room);

    let nextModerators: number[] | null = null;
    await AppDataSource.transaction(async (manager) => {
      // 原房主降级为 viewer
      await manager.update(
        Session,
        { socketId: oldSharerSocketId, role: 'sharer' },
        { role: 'viewer' },
      );
      // 新房主升级为 sharer
      await manager.update(
        Session,
        { socketId: newSharerSocketId, role: 'viewer' },
        { role: 'sharer' },
      );
      // 更新房间 owner；若新房主原为房管则从 moderators 移除
      const room = await manager.findOne(Room, { where: { roomId } });
      if (room) {
        if (newOwnerUserId != null) {
          let moderators: number[] = [];
          try {
            moderators = JSON.parse(room.moderators || '[]');
          } catch {
            moderators = [];
          }
          if (moderators.includes(newOwnerUserId)) {
            moderators = moderators.filter((id) => id !== newOwnerUserId);
            room.moderators = JSON.stringify(moderators);
            nextModerators = moderators;
          }
        }
        room.ownerUserId = newOwnerUserId;
        await manager.save(Room, room);
      }
    });
    // 失效权限缓存：新旧房主的权限缓存应即时清除
    roomPermissionService.invalidatePermissionCache(oldSharerSocketId, roomId);
    roomPermissionService.invalidatePermissionCache(newSharerSocketId, roomId);
    return nextModerators;
  }
}

/** 全局单例 */
export const roomSessionService = new RoomSessionService();
