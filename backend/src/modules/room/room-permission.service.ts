/**
 * 房间权限校验服务。
 *
 * 消除旧架构中 12+ 处重复的 sharer 查询逻辑。
 * 所有权限校验统一通过此服务，禁止在 handler 中直接查询 Session 表。
 */
import type { Socket } from 'socket.io';
import { IsNull } from 'typeorm';
import { AppDataSource } from '../../data-source';
import { Session } from '../../entities/Session';
import { Room } from '../../entities/Room';
import type { UserRole } from '../../entities/User';

/**
 * 房间权限服务。
 *
 * 封装所有基于 Session 表的权限校验逻辑。
 */
export class RoomPermissionService {
  /**
   * 检查 socket 是否为指定房间的活跃房主（sharer）。
   *
   * @param socket 客户端 socket
   * @param roomId 房间 ID
   */
  async isRoomHost(socket: Socket, roomId: string): Promise<boolean> {
    const sessionRepo = AppDataSource.getRepository(Session);
    const sharer = await sessionRepo.findOneBy({
      socketId: socket.id,
      roomId,
      role: 'sharer',
      endedAt: IsNull(),
    });
    return !!sharer;
  }

  /**
   * 检查 socket 是否为指定房间的活跃房主，返回 sharer session（含完整信息）。
   *
   * 用于需要 sharer session 信息的场景（如获取 roomId）。
   */
  async getActiveSharer(
    socket: Socket,
    roomId: string,
  ): Promise<Session | null> {
    const sessionRepo = AppDataSource.getRepository(Session);
    return sessionRepo.findOneBy({
      socketId: socket.id,
      roomId,
      role: 'sharer',
      endedAt: IsNull(),
    });
  }

  /**
   * 根据 socketId 获取该 socket 对应的活跃 sharer session（跨房间查询）。
   *
   * 用于需要知道房主所在房间的场景（如 approve-join、update-room-mode）。
   */
  async getSharerBySocketId(socketId: string): Promise<Session | null> {
    const sessionRepo = AppDataSource.getRepository(Session);
    return sessionRepo.findOneBy({
      socketId,
      role: 'sharer',
      endedAt: IsNull(),
    });
  }

  /**
   * 获取或重新激活 sharer session（带 socket 重连自愈）。
   *
   * socket 重连后 register-host 可能未及时更新 sharer session 的 socketId，
   * 导致按 socketId 查不到 sharer。此时检查用户是否为房间 owner，
   * 若是则重新激活最新的 sharer session。
   *
   * 用于 update-room-mode 等需要兼容 socket 重连场景的事件。
   */
  async getOrReactivateSharer(
    socket: Socket,
    roomId: string,
  ): Promise<Session | null> {
    const sessionRepo = AppDataSource.getRepository(Session);
    const roomRepo = AppDataSource.getRepository(Room);

    // 先按 socketId 查找活跃 sharer
    const sharer = await sessionRepo.findOneBy({
      socketId: socket.id,
      role: 'sharer',
      endedAt: IsNull(),
    });
    if (sharer) return sharer;

    // 自愈：socket 重连后 sharer session 的 socketId 可能未更新
    const room = await roomRepo.findOneBy({ roomId });
    if (!room || room.status !== 'active') return null;

    const userId: number = socket.data.userId;
    const role: UserRole = socket.data.role;
    const isOwner =
      role === 'root' ||
      room.ownerUserId === null ||
      room.ownerUserId === userId;
    if (!isOwner) return null;

    const latestSharer = await sessionRepo.findOne({
      where: { roomId, role: 'sharer' },
      order: { startedAt: 'DESC' },
    });
    if (!latestSharer) return null;

    latestSharer.socketId = socket.id;
    latestSharer.endedAt = null;
    await sessionRepo.save(latestSharer);
    return latestSharer;
  }

  /**
   * 检查 socket 是否在指定房间内（任意角色）。
   */
  async isInRoom(socket: Socket, roomId: string): Promise<boolean> {
    const sessionRepo = AppDataSource.getRepository(Session);
    const session = await sessionRepo.findOneBy({
      socketId: socket.id,
      roomId,
      endedAt: IsNull(),
    });
    return !!session;
  }

  /**
   * 获取 socket 所在的活跃 session。
   */
  async getActiveSession(socket: Socket): Promise<Session | null> {
    const sessionRepo = AppDataSource.getRepository(Session);
    return sessionRepo.findOneBy({
      socketId: socket.id,
      endedAt: IsNull(),
    });
  }

  /**
   * 检查房间是否存在且为活跃状态，且为 watch-together 模式。
   *
   * 修复旧架构中同步播放事件不校验 room.mode 的问题。
   */
  async isWatchTogetherRoom(roomId: string): Promise<boolean> {
    const roomRepo = AppDataSource.getRepository(Room);
    const room = await roomRepo.findOneBy({ roomId, status: 'active' });
    return !!room && room.mode === 'watch-together';
  }

  /**
   * 检查房间是否存在且为活跃状态，且为 screen-share 模式。
   */
  async isScreenShareRoom(roomId: string): Promise<boolean> {
    const roomRepo = AppDataSource.getRepository(Room);
    const room = await roomRepo.findOneBy({ roomId, status: 'active' });
    return !!room && room.mode === 'screen-share';
  }

  /**
   * 检查用户是否被禁言。
   */
  async isMuted(roomId: string, userId: number): Promise<boolean> {
    const roomRepo = AppDataSource.getRepository(Room);
    const room = await roomRepo.findOneBy({ roomId });
    if (!room) return false;
    try {
      const muted: string[] = JSON.parse(room.mutedViewers || '[]');
      return muted.includes(String(userId));
    } catch {
      return false;
    }
  }
}

/** 全局单例 */
export const roomPermissionService = new RoomPermissionService();
