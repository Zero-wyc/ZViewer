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
import type { MovieDto, PlaybackStateDto } from '../shared';
import { playbackMemoryService } from '../playback-memory';

/** 房间运行时状态 */
export interface RoomRuntimeState {
  /** 当前影片列表（运行时缓存，与 DB 同步） */
  movies: MovieDto[];
  /** 当前播放的影片 ID */
  currentMovieId: number | string | null;
  /** 房主最近一次广播的播放状态（用于房主刷新/重连恢复） */
  playback?: PlaybackStateDto;
}

/** 房主重连宽限期（毫秒） */
export const HOST_RECONNECT_GRACE_MS = 5 * 60 * 1000; // 5 分钟

/**
 * 房间运行时状态服务。
 *
 * 单例服务，管理所有房间的运行时状态。
 */
export class RoomStateService {
  private readonly states = new Map<string, RoomRuntimeState>();
  private readonly reconnectTimers = new Map<string, NodeJS.Timeout>();

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

  /** 删除房间运行时状态 */
  delete(roomId: string): void {
    this.states.delete(roomId);
  }

  /** 设置当前播放影片 */
  setCurrentMovie(roomId: string, movieId: number | string | null): void {
    const state = this.get(roomId);
    state.currentMovieId = movieId;
  }

  /** 获取当前播放影片 ID */
  getCurrentMovieId(roomId: string): number | string | null {
    return this.get(roomId).currentMovieId;
  }

  /** 设置影片列表 */
  setMovies(roomId: string, movies: MovieDto[]): void {
    this.get(roomId).movies = movies;
  }

  /** 获取影片列表 */
  getMovies(roomId: string): MovieDto[] {
    return this.get(roomId).movies;
  }

  /** 持久化房主播放状态（自动写入 updatedAt） */
  setPlayback(roomId: string, playback: Omit<PlaybackStateDto, 'updatedAt'>): void {
    const state = this.get(roomId);
    state.playback = { ...playback, updatedAt: Date.now() };
  }

  /** 获取房主播放状态 */
  getPlayback(roomId: string): PlaybackStateDto | undefined {
    return this.get(roomId).playback;
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
}

/** 全局单例 */
export const roomStateService = new RoomStateService();
