/**
 * 房间权限校验服务。
 *
 * 消除旧架构中 12+ 处重复的 sharer 查询逻辑。
 * 所有权限校验统一通过此服务，禁止在 handler 中直接查询 Session 表。
 *
 * 性能优化（P1-Opt#5）：
 * - isRoomHost / isInRoom 结果缓存 5s，避免高频事件（心跳 2s）重复查 DB
 * - 缓存 key = socketId:roomId:method，TTL 5s；socket 重连时 socketId 变更缓存自动失效
 */
import type { Socket } from 'socket.io';
import { IsNull } from 'typeorm';
import { AppDataSource } from '../../data-source';
import { Session } from '../../entities/Session';
import { Room } from '../../entities/Room';
import { SystemSettings } from '../../entities/SystemSettings';
import type { UserRole } from '../../entities/User';

/** 权限校验缓存条目 */
interface PermissionCacheEntry {
  result: boolean;
  expiresAt: number;
}

/** 权限校验缓存 TTL（毫秒） */
const PERMISSION_CACHE_TTL_MS = 5000;

/** 权限缓存容量上限：key 含 socketId（每次重连都是新 key，断连后旧条目
 * 永不再被读取，惰性过期清理对它们无效），超限顺带清理过期 + 兜底全清。 */
const PERMISSION_CACHE_MAX_ENTRIES = 1000;

/**
 * 房间权限服务。
 *
 * 封装所有基于 Session 表的权限校验逻辑。
 */
export class RoomPermissionService {
  /** 权限校验缓存（P1-Opt#5）：key = socketId:roomId:method，TTL 5s */
  private readonly permissionCache = new Map<string, PermissionCacheEntry>();

  private cacheKey(socketId: string, roomId: string, method: string): string {
    return `${socketId}:${roomId}:${method}`;
  }

  private getCached(key: string): boolean | null {
    const entry = this.permissionCache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.permissionCache.delete(key);
      return null;
    }
    return entry.result;
  }

  private setCache(key: string, result: boolean): void {
    const now = Date.now();
    // 容量控制：socketId 维度的旧条目断连后永不再被 get，无法靠惰性清理回收。
    // 超限时先清理全部过期条目，仍超限则全清（5s TTL 下缓存重建成本可忽略）。
    if (this.permissionCache.size >= PERMISSION_CACHE_MAX_ENTRIES) {
      for (const [k, v] of this.permissionCache) {
        if (now > v.expiresAt) this.permissionCache.delete(k);
      }
      if (this.permissionCache.size >= PERMISSION_CACHE_MAX_ENTRIES) {
        this.permissionCache.clear();
      }
    }
    this.permissionCache.set(key, {
      result,
      expiresAt: now + PERMISSION_CACHE_TTL_MS,
    });
  }

  /**
   * 失效权限缓存（安全加固）。
   *
   * 当 sharer 权限因踢出、房主替换、session 结束等被吊销时调用，
   * 主动清除对应 socketId:roomId 的缓存，避免旧 socket 在 TTL 窗口内继续广播/控制。
   *
   * @param socketId socket ID（可选，缺省时按 roomId 清除该房间全部缓存）
   * @param roomId 房间 ID（可选，缺省时清除该 socket 全部缓存）
   */
  invalidatePermissionCache(socketId?: string, roomId?: string): void {
    if (socketId && roomId) {
      this.permissionCache.delete(this.cacheKey(socketId, roomId, 'isRoomHost'));
      this.permissionCache.delete(this.cacheKey(socketId, roomId, 'isInRoom'));
      this.permissionCache.delete(this.cacheKey(socketId, roomId, 'isRoomModerator'));
      return;
    }
    for (const key of this.permissionCache.keys()) {
      const [sid, rid] = key.split(':');
      if (socketId && sid === socketId) this.permissionCache.delete(key);
      else if (roomId && rid === roomId) this.permissionCache.delete(key);
    }
  }

  /**
   * 判断给定角色是否可以创建房间。
   *
   * 权限规则（基于系统设置 `roomCreationMode`）：
   * - `guest` 始终禁止创建房间（未登录用户不允许）
   * - `admin-only` 模式：仅 `root` / `admin` 可创建
   * - `all-users` 模式：`root` / `admin` / `user` 均可创建
   *
   * 将此逻辑集中到权限服务，消除在 handler/路由中硬编码角色判断的反复出现。
   */
  canCreateRoom(role: UserRole, settings: SystemSettings): boolean {
    if (role === 'guest') return false;
    if (role === 'root' || role === 'admin') return true;
    // role === 'user'
    return settings.roomCreationMode === 'all-users';
  }

  /**
   * 检查 socket 是否为指定房间的活跃房主（sharer）。
   *
   * @param socket 客户端 socket
   * @param roomId 房间 ID
   */
  async isRoomHost(socket: Socket, roomId: string): Promise<boolean> {
    const key = this.cacheKey(socket.id, roomId, 'isRoomHost');
    const cached = this.getCached(key);
    if (cached !== null) return cached;

    const sessionRepo = AppDataSource.getRepository(Session);
    const sharer = await sessionRepo.findOneBy({
      socketId: socket.id,
      roomId,
      role: 'sharer',
      endedAt: IsNull(),
    });
    const result = !!sharer;
    this.setCache(key, result);
    return result;
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

    // 先按 socketId + roomId 查找当前房间的活跃 sharer
    const sharer = await sessionRepo.findOneBy({
      socketId: socket.id,
      roomId,
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
    const key = this.cacheKey(socket.id, roomId, 'isInRoom');
    const cached = this.getCached(key);
    if (cached !== null) return cached;

    const sessionRepo = AppDataSource.getRepository(Session);
    const session = await sessionRepo.findOneBy({
      socketId: socket.id,
      roomId,
      endedAt: IsNull(),
    });
    const result = !!session;
    this.setCache(key, result);
    return result;
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

  /**
   * 检查 socket 是否为指定房间的房管（协管员）。
   *
   * 房管由房主任命（Room.moderators，userId JSON 数组），
   * 可执行影片管理、成员管理（禁言/踢出，含语音）。
   * 房主不在 moderators 列表中（房主身份由 ownerUserId/session 判定）。
   */
  async isRoomModerator(socket: Socket, roomId: string): Promise<boolean> {
    const key = this.cacheKey(socket.id, roomId, 'isRoomModerator');
    const cached = this.getCached(key);
    if (cached !== null) return cached;

    const userId: number | undefined = socket.data?.userId;
    if (!userId || userId <= 0) {
      this.setCache(key, false);
      return false;
    }

    const roomRepo = AppDataSource.getRepository(Room);
    const room = await roomRepo.findOneBy({ roomId });
    let result = false;
    if (room) {
      try {
        const moderators: number[] = JSON.parse(room.moderators || '[]');
        result = moderators.includes(userId);
      } catch {
        result = false;
      }
    }
    this.setCache(key, result);
    return result;
  }

  /**
   * 检查 socket 是否为指定房间的房主或房管。
   *
   * 用于管理类权限点（禁言/踢出/影片管理等）：
   * 房主与房管均可执行；播放控制广播链路仍为房主专属。
   */
  async isRoomHostOrModerator(socket: Socket, roomId: string): Promise<boolean> {
    if (await this.isRoomHost(socket, roomId)) return true;
    return this.isRoomModerator(socket, roomId);
  }

  /**
   * 房管防篡权校验：房管是否可对目标用户执行管理操作。
   *
   * 规则：房管不可操作房主（room.ownerUserId）与其他房管（moderators），
   * 也不可操作 root 用户（系统管理员）。房主本人不受此限制。
   *
   * @returns null 表示可操作；否则为拒绝原因（用于 ack message）
   */
  async canModeratorActOn(
    roomId: string,
    targetUserId: number | undefined,
    targetRole?: UserRole,
  ): Promise<string | null> {
    if (targetRole === 'root') return '不能对管理员操作';
    if (!targetUserId || targetUserId <= 0) return null; // 游客可被操作
    const [room, moderators] = await Promise.all([
      AppDataSource.getRepository(Room).findOneBy({ roomId }),
      this.getModerators(roomId),
    ]);
    if (room && room.ownerUserId === targetUserId) return '不能对房主操作';
    if (moderators.includes(targetUserId)) return '不能对房管操作';
    return null;
  }

  /**
   * 获取房间房管 userId 列表。
   */
  async getModerators(roomId: string): Promise<number[]> {
    const roomRepo = AppDataSource.getRepository(Room);
    const room = await roomRepo.findOneBy({ roomId });
    if (!room) return [];
    try {
      return JSON.parse(room.moderators || '[]');
    } catch {
      return [];
    }
  }

  /**
   * 设置房间房管列表（仅房主操作端点调用）。
   * 同步失效该房间的权限缓存，确保房管变更立即生效。
   */
  async setModerators(roomId: string, moderators: number[]): Promise<void> {
    const roomRepo = AppDataSource.getRepository(Room);
    const room = await roomRepo.findOneBy({ roomId });
    if (!room) return;
    room.moderators = JSON.stringify(moderators);
    await roomRepo.save(room);
    this.invalidatePermissionCache(undefined, roomId);
  }

  /**
   * 失效房管缓存（appoint/dismiss 后由调用方触发广播前调用）。
   */
  invalidateModeratorCache(roomId: string): void {
    this.invalidatePermissionCache(undefined, roomId);
  }
}

/** 全局单例 */
export const roomPermissionService = new RoomPermissionService();
