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
    playback?: ReturnType<typeof roomStateService.getPlayback>;
  } | null> {
    const roomRepo = AppDataSource.getRepository(Room);
    const sessionRepo = AppDataSource.getRepository(Session);

    const room = await roomRepo.findOneBy({ roomId, status: 'active' });
    if (!room) return null;

    // 校验房主身份
    if (room.ownerUserId !== userId) return null;

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
      await sessionRepo.save(existingSharer);
    } else {
      // 创建新 session
      const session = sessionRepo.create({
        roomId,
        socketId: socket.id,
        role: 'sharer',
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
   * 结束指定 viewer 的 session（踢出）。
   */
  async endViewerSession(socketId: string): Promise<Session | null> {
    return this.endSession(socketId);
  }

  /**
   * 转交房主：将原 sharer 降级为 viewer，将指定 viewer 升级为 sharer。
   *
   * 使用事务保证原子性（修复旧架构无事务包裹的问题）。
   */
  async transferHost(
    roomId: string,
    newSharerSocketId: string,
    oldSharerSocketId: string,
    newOwnerUserId: number,
  ): Promise<void> {
    const sessionRepo = AppDataSource.getRepository(Session);
    const roomRepo = AppDataSource.getRepository(Room);

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
      // 更新房间 owner
      await manager.update(Room, { roomId }, { ownerUserId: newOwnerUserId });
    });
  }
}

/** 全局单例 */
export const roomSessionService = new RoomSessionService();
