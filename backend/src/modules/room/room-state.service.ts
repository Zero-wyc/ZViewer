/**
 * 房间运行时状态管理服务。
 *
 * 封装旧架构中 services/room/state.ts 的全局 roomStates Map 和 hostReconnectTimers Map，
 * 提供类型安全的访问接口，消除模块边界泄漏问题。
 *
 * 设计：
 * - 内部使用 Map 存储，未来可替换为 Redis 实现支持多实例部署
 * - 所有状态变更通过此服务，禁止外部直接操作 Map
 */
import type { Server as SocketIOServer } from 'socket.io';
import { IsNull } from 'typeorm';
import { AppDataSource } from '../../data-source';
import { Room } from '../../entities/Room';
import { Session } from '../../entities/Session';
import { Movie } from '../../entities/Movie';
import { PlaybackState } from '../../entities/PlaybackState';
import { getSystemSettings } from '../../services/system-settings';
import type { MovieDto, PlaybackStateDto } from '../shared';
import { playbackMemoryService } from '../playback-memory';
import { roomPermissionService } from './room-permission.service';
import type { StorageAdapter } from '../../services/storage';

/** 房间运行时状态 */
export interface RoomRuntimeState {
  /** 当前影片列表（运行时缓存，与 DB 同步） */
  movies: MovieDto[];
  /** 当前播放的影片 ID */
  currentMovieId: number | string | null;
  /** 房主最近一次广播的播放状态（用于房主刷新/重连恢复） */
  playback?: PlaybackStateDto;
  /**
   * 房主最近一次广播的字幕状态（subtitle-update payload 原样缓存）。
   * 观众中途加入/刷新时下发，解决「观众加入前房主已加载字幕但无人重播」
   * 导致观众无字幕的问题。房间关闭时随 delete 一并清理。
   */
  subtitle?: unknown;
}

/** 房主重连宽限期（毫秒） */
export const HOST_RECONNECT_GRACE_MS = 10 * 60 * 1000; // 10 分钟

/**
 * 房间运行时状态服务。
 *
 * 单例服务，管理所有房间的运行时状态。
 */
export class RoomStateService {
  private readonly states = new Map<string, RoomRuntimeState>();
  private readonly reconnectTimers = new Map<string, NodeJS.Timeout>();
  /** 可选的存储适配器（#16）：设置后写入操作同步写内存 + 异步写 Redis */
  private storageAdapter: StorageAdapter<RoomRuntimeState> | null = null;

  /**
   * 设置存储适配器（#16 Redis 多实例支持）。
   * 调用后 `setMovies`/`setCurrentMovie`/`setPlayback`/`delete` 等
   * 写入操作将以写穿透模式同步到 Redis。
   */
  setStorageAdapter(adapter: StorageAdapter<RoomRuntimeState>): void {
    this.storageAdapter = adapter;
  }

  /** 获取或创建房间运行时状态 */
  get(roomId: string): RoomRuntimeState {
    if (!this.states.has(roomId)) {
      this.states.set(roomId, {
        movies: [],
        currentMovieId: null,
      });
    }
    return this.states.get(roomId)!;
  }

  /**
   * 服务器启动时从 DB 恢复所有活跃房间的运行时状态。
   *
   * P3-Opt#13：解决服务器重启后 roomStateService 运行时状态（movies、currentMovieId）
   * 丢失的问题。从 DB 恢复：
   * - movies：从 Movie 表按 roomId 查询
   * - currentMovieId：从 PlaybackState 表读取
   * - 播放记忆：playbackMemoryService.refreshCache(roomId)
   *
   * 这样即使房主未重连，服务器心跳也能正确推算并广播播放进度。
   */
  async initFromDb(): Promise<void> {
    // 若配置了存储适配器，优先从适配器恢复运行时状态（#16）
    if (this.storageAdapter) {
      if (this.storageAdapter.init) {
        await this.storageAdapter.init();
      }
      const restored = Array.from(this.storageAdapter.entries());
      for (const [roomId, state] of restored) {
        this.states.set(roomId, state);
      }
      if (restored.length > 0) {
        console.log(`[RoomStateService] 已从存储适配器恢复 ${restored.length} 个房间的运行时状态`);
      }
      return;
    }

    const roomRepo = AppDataSource.getRepository(Room);
    const movieRepo = AppDataSource.getRepository(Movie);
    const playbackRepo = AppDataSource.getRepository(PlaybackState);

    const activeRooms = await roomRepo.find({ where: { status: 'active' } });
    for (const room of activeRooms) {
      try {
        const movies = await movieRepo.find({
          where: { roomId: room.roomId },
          order: { createdAt: 'ASC' } as never,
        });
        const state = this.get(room.roomId);
        state.movies = movies as unknown as MovieDto[];
        state.currentMovieId = null;

        // 从 PlaybackState 恢复 currentMovieId 与播放记忆
        const playback = await playbackRepo.findOneBy({ roomId: room.roomId });
        if (playback) {
          state.currentMovieId = playback.currentMovieId ?? null;
          await playbackMemoryService.refreshCache(room.roomId);
        }
      } catch (err) {
        console.error(`[RoomStateService] 恢复房间 ${room.roomId} 状态失败:`, err);
      }
    }
    if (activeRooms.length > 0) {
      console.log(`[RoomStateService] 已恢复 ${activeRooms.length} 个活跃房间的运行时状态`);
    }
  }

  /** 删除房间运行时状态 */
  delete(roomId: string): void {
    this.states.delete(roomId);
    // 删除适配器中的对应状态（#16）
    this.storageAdapter?.delete(roomId);
  }

  /** 设置当前播放影片 */
  setCurrentMovie(roomId: string, movieId: number | string | null): void {
    const state = this.get(roomId);
    state.currentMovieId = movieId;
    // 写穿透到适配器（#16）
    this.storageAdapter?.set(roomId, state);
  }

  /** 获取当前播放影片 ID */
  getCurrentMovieId(roomId: string): number | string | null {
    return this.get(roomId).currentMovieId;
  }

  /** 设置影片列表 */
  setMovies(roomId: string, movies: MovieDto[]): void {
    const state = this.get(roomId);
    state.movies = movies;
    // 写穿透到适配器（#16）
    this.storageAdapter?.set(roomId, state);
  }

  /** 获取影片列表 */
  getMovies(roomId: string): MovieDto[] {
    return this.get(roomId).movies;
  }

  /** 持久化房主播放状态（自动写入 updatedAt） */
  setPlayback(roomId: string, playback: Omit<PlaybackStateDto, 'updatedAt'>): void {
    const state = this.get(roomId);
    state.playback = { ...playback, updatedAt: Date.now() };
    // 写穿透到适配器（#16）
    this.storageAdapter?.set(roomId, state);
  }

  /** 获取房主播放状态 */
  getPlayback(roomId: string): PlaybackStateDto | undefined {
    return this.get(roomId).playback;
  }

  /** 缓存房主最近一次广播的字幕状态（subtitle-update payload 原样保存） */
  setSubtitle(roomId: string, subtitle: unknown): void {
    this.get(roomId).subtitle = subtitle;
    // 字幕状态不写穿透到存储适配器（体积大且时效性强，重连后由房主重新广播）
  }

  /** 获取缓存的字幕状态（观众加入时补发） */
  getSubtitle(roomId: string): unknown | undefined {
    return this.get(roomId).subtitle;
  }

  /** 启动房主重连定时器 */
  startReconnectTimer(
    roomId: string,
    callback: () => void,
  ): void {
    this.cancelReconnectTimer(roomId);
    const timer = setTimeout(callback, HOST_RECONNECT_GRACE_MS);
    this.reconnectTimers.set(roomId, timer);
  }

  /** 取消房主重连定时器 */
  cancelReconnectTimer(roomId: string): void {
    const timer = this.reconnectTimers.get(roomId);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(roomId);
    }
  }

  /** 检查是否有待重连的定时器 */
  hasReconnectTimer(roomId: string): boolean {
    return this.reconnectTimers.has(roomId);
  }

  /**
   * 房主离开宽限期（10 分钟）超时后的自动关闭：受「自动删除无人房间」
   * 开关（autoDeleteInactiveRooms）门控。
   *
   * - 开关开启（默认）：关闭房间（原行为）
   * - 开关关闭：不关闭——房间保留，观众可继续停留，房主可随时回来恢复；
   *   关闭仍可由房主 close-room / 管理员 admin-close-room 显式触发
   *
   * 读设置失败时按原行为关闭（与旧版本一致，避免异常态下房间泄漏）。
   */
  async closeRoomAfterHostGrace(
    io: SocketIOServer,
    roomId: string,
    sharerSocketId: string,
  ): Promise<void> {
    try {
      const settings = await getSystemSettings();
      if (!settings.autoDeleteInactiveRooms) {
        console.log(
          `[room] auto-delete inactive rooms is disabled, keep room ${roomId} open after host left`,
        );
        return;
      }
    } catch (err) {
      console.error(
        '[room] read settings failed, close room by default:',
        err,
      );
    }
    await this.closeRoomAndNotify(io, roomId, sharerSocketId);
  }

  /**
   * 关闭房间并通知所有成员。
   *
   * - 更新 Room.status = 'closed'
   * - 结束所有未结束的 sharer session
   * - 广播 room-closed 事件
   * - 清理运行时状态
   * - 踢出除房主外的其他 socket
   */
  async closeRoomAndNotify(
    io: SocketIOServer,
    roomId: string,
    sharerSocketId: string,
  ): Promise<void> {
    const roomRepo = AppDataSource.getRepository(Room);
    const sessionRepo = AppDataSource.getRepository(Session);

    await roomRepo.update({ roomId }, { status: 'closed' });
    await sessionRepo.update(
      { roomId, role: 'sharer', endedAt: IsNull() },
      { endedAt: new Date() },
    );
    // 失效权限缓存：房间关闭后所有 sharer session 已结束
    roomPermissionService.invalidatePermissionCache(undefined, roomId);

    io.to(roomId).emit('room-closed', { roomId });
    this.delete(roomId);
    this.cancelReconnectTimer(roomId);

    // 清理播放记忆持久化状态
    await playbackMemoryService.clearPlayback(roomId);

    const sockets = await io.in(roomId).fetchSockets();
    for (const sock of sockets) {
      if (sock.id !== sharerSocketId) {
        sock.leave(roomId);
        sock.disconnect(true);
      }
    }
  }

  /** 获取所有有运行时状态的房间 ID（用于定时清理遍历） */
  getActiveRoomIds(): string[] {
    return Array.from(this.states.keys());
  }

  /**
   * 清理陈旧运行时状态：移除已无播放记忆缓存且无活跃观众的房间状态。
   * 由 PlaybackBroadcasterService 的定时清理任务驱动。
   */
  cleanupStaleStates(): void {
    for (const [roomId] of this.states.entries()) {
      if (
        !playbackMemoryService.isHostOnline(roomId) &&
        !playbackMemoryService.hasCache(roomId)
      ) {
        this.states.delete(roomId);
        this.cancelReconnectTimer(roomId);
      }
    }
  }
}

/** 全局单例 */
export const roomStateService = new RoomStateService();
