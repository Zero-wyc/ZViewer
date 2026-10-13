/**
 * 播放记忆服务：管理 PlaybackState 实体的读写与时间推算。
 *
 * 核心职责：
 * 1. 持久化播放状态到 DB（房主每次更新状态时调用）
 * 2. 基于时间推算当前实际播放进度（观众请求状态时调用）
 * 3. 房主断开/重连时更新 hostSocketId
 *
 * 时间推算公式：
 *   elapsed = (Date.now() - lastUpdatedAt) / 1000
 *   actualCurrentTime = currentTime + elapsed * playbackRate * (isPlaying ? 1 : 0)
 *   若 actualCurrentTime > duration，则视频已结束
 *
 * 性能策略：
 * - 读取时优先用内存缓存，未命中则读 DB
 * - 写入时同步更新内存与 DB（DB 写入异步执行，不阻塞响应）
 * - 房主高频更新（500ms）时，DB 写入采用节流（每 2s 写一次）
 *   内存始终是最新的，DB 仅用于持久化与服务器重启恢复
 */
import { AppDataSource } from '../../data-source';
import { PlaybackState } from '../../entities/PlaybackState';
import type { PlaybackStateDto, SyncStateDto } from '../shared/dto/sync-state.dto';
import type { QualityOptionDto } from '../shared/dto/sync-state.dto';
import type { StorageAdapter } from '../../services/storage';
import { compensateTransportDelay } from './transport-delay';

/** DB 写入节流间隔（毫秒）。房主高频更新时避免每次都写 DB。 */
const DB_WRITE_THROTTLE_MS = 2000;

/** 房主心跳落盘节流间隔（毫秒）。心跳每 5s 一次，10s 节流保证外推基线新鲜。 */
const HEARTBEAT_PERSIST_THROTTLE_MS = 10000;

/** 缓存清理间隔（毫秒）。每隔 30s 清理一次房主离线且无观众的陈旧缓存。 */
const CACHE_CLEANUP_INTERVAL_MS = 30000;

/** 房主离线且无在线观众后，缓存保留时间（毫秒）。超过即清理。 */
const CACHE_STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 分钟

/** 内存缓存条目 */
interface CachedPlayback {
  /** 完整状态（已序列化前的对象形式） */
  state: PlaybackStateDto;
  /** 最近一次 DB 写入时间戳 */
  lastDbWriteAt: number;
  /** 脏标记：内存已变更但未写入 DB */
  dirty: boolean;
}

export class PlaybackMemoryService {
  private readonly cache = new Map<string, CachedPlayback>();
  /** 可选的存储适配器（#16）：写穿透到 Redis，用于多实例状态共享 */
  private storageAdapter: StorageAdapter<PlaybackStateDto> | null = null;
  /** Socket.IO 实例（可选）：用于校验 hostSocketId 对应的 socket 是否实际在线 */
  private io: import('socket.io').Server | null = null;

  /**
   * 设置存储适配器（#16 Redis 多实例支持）。
   */
  setStorageAdapter(adapter: StorageAdapter<PlaybackStateDto>): void {
    this.storageAdapter = adapter;
  }

  /**
   * 注入 Socket.IO 实例：isHostOnline 据此校验 hostSocketId 的 socket
   * 是否实际在线（后端重启后从 DB 恢复的 hostSocketId 是失效的旧值）。
   */
  setIo(io: import('socket.io').Server): void {
    this.io = io;
  }

  /**
   * 更新播放状态（房主调用）。
   *
   * @param roomId 房间 ID
   * @param state 房主广播的完整状态
   * @param hostSocketId 房主 socket ID
   * @param clientTs 客户端发送时刻（Unix 毫秒）。提供时补偿传输延迟
   *   （clamp 0~1.5s × playbackRate，仅播放中），使基线锚定服务器时间轴。
   *   已在调用侧做过显式补偿（如 applyControlToPlayback）时不要传。
   */
  async setPlayback(
    roomId: string,
    state: SyncStateDto,
    hostSocketId: string,
    clientTs?: number,
  ): Promise<void> {
    const now = Date.now();
    const currentMovieId = await this.getCurrentMovieId(roomId);
    // 写侧传输延迟补偿：房主上报的 currentTime 是发出时刻的值，
    // 播放中到达服务器时已推进 delay × rate，补回后再入基线（Step 1）。
    const compensatedCurrentTime = compensateTransportDelay({
      currentTime: state.currentTime,
      clientTs,
      playbackRate: state.playbackRate,
      isPlaying: state.isPlaying,
      now,
    });
    const playbackState: PlaybackStateDto = {
      ...state,
      currentTime: compensatedCurrentTime,
      currentMovieId,
      updatedAt: now,
    };

    const cached = this.cache.get(roomId);
    if (cached) {
      cached.state = playbackState;
      // 保留 hostSocketId：setPlayback 覆盖整个 state 会丢失 updateHostSocket 设置的
      // hostSocketId，导致 isHostOnline 在房主在线时也返回 false，
      // 进而 playbackBroadcasterService 在房主在线时也广播 server-heartbeat，
      // 与房主的 watch-together-state 冲突。
      (cached.state as PlaybackStateDto & { hostSocketId?: string | null }).hostSocketId = hostSocketId;
      cached.dirty = true;
    } else {
      (playbackState as PlaybackStateDto & { hostSocketId?: string | null }).hostSocketId = hostSocketId;
      this.cache.set(roomId, {
        state: playbackState,
        lastDbWriteAt: 0,
        dirty: true,
      });
    }

    // 节流写 DB：距上次写入超过 DB_WRITE_THROTTLE_MS 才写
    if (now - (cached?.lastDbWriteAt ?? 0) > DB_WRITE_THROTTLE_MS) {
      await this.flushToDb(roomId);
    }

    // 写穿透到存储适配器（#16）：同步最新播放状态到 Redis 供多实例共享
    this.storageAdapter?.set(roomId, playbackState);
  }

  /**
   * 获取推算后的当前播放状态。
   *
   * 基于 lastUpdatedAt + isPlaying + playbackRate 推算实际 currentTime。
   * 用于观众请求状态、服务器定时广播。
   *
   * @param roomId 房间 ID
   * @returns 推算后的状态，若房间无播放状态则返回 null
   */
  async getAdvancedPlayback(roomId: string): Promise<PlaybackStateDto | null> {
    const cached = this.cache.get(roomId);
    let state: PlaybackStateDto | null = cached?.state ?? null;

    // 内存未命中，读 DB
    if (!state) {
      state = await this.loadFromDb(roomId);
      if (!state) return null;
      this.cache.set(roomId, {
        state,
        lastDbWriteAt: Date.now(),
        dirty: false,
      });
    }

    return this.advanceState(state);
  }

  /**
   * 获取原始播放状态（不推算时间）。
   * 用于房主重连恢复时获取最后已知状态。
   */
  async getRawPlayback(roomId: string): Promise<PlaybackStateDto | null> {
    const cached = this.cache.get(roomId);
    if (cached) return cached.state;

    const state = await this.loadFromDb(roomId);
    if (state) {
      this.cache.set(roomId, {
        state,
        lastDbWriteAt: Date.now(),
        dirty: false,
      });
    }
    return state;
  }

  /**
   * 更新房主 socket ID（房主重连时调用）。
   */
  async updateHostSocket(
    roomId: string,
    hostSocketId: string | null,
  ): Promise<void> {
    const cached = this.cache.get(roomId);
    if (cached) {
      // hostSocketId 不在 SyncStateDto 中，单独存到内存元数据
      (cached.state as PlaybackStateDto & { hostSocketId?: string | null }).hostSocketId = hostSocketId;
    }

    // 同步到 DB
    try {
      const repo = AppDataSource.getRepository(PlaybackState);
      await repo.update({ roomId }, { hostSocketId });
    } catch (err) {
      console.error('[PlaybackMemoryService] updateHostSocket error:', err);
    }
  }

  /**
   * 检查房主是否在线。
   *
   * hostSocketId 非空仅代表"曾经注册过"：后端重启后从 DB 恢复的状态携带的是
   * 已失效的旧 socket id，仅判非空会让 playbackBroadcaster 永远跳过接力广播、
   * cleanupStaleCache 永远跳过清理。因此注入 io 后进一步校验 socket 实际在线。
   */
  isHostOnline(roomId: string): boolean {
    const cached = this.cache.get(roomId);
    if (!cached) return false;
    const hostSocketId = (cached.state as PlaybackStateDto & { hostSocketId?: string | null }).hostSocketId;
    if (!hostSocketId) return false;
    if (this.io) {
      return this.io.sockets.sockets.has(hostSocketId);
    }
    return true;
  }

  /**
   * 应用房主心跳到播放记忆（仅更新进度字段，不覆盖源信息）。
   *
   * 房主在线期间离散 state/control 事件之外的连续播放不产生持久化更新，
   * 外推基线（updatedAt + currentTime）会逐渐偏离真实进度；房主断线时
   * 服务器外推与房主恢复进度均超前。心跳每 5s 携带真实 currentTime，
   * 在此以 10s 节流合并进内存缓存并落盘，保证基线新鲜且 DB 写入频率可控。
   */
  async applyHostHeartbeat(
    roomId: string,
    heartbeat: { currentTime: number; isPlaying: boolean; playbackRate: number },
    clientTs?: number,
  ): Promise<void> {
    const cached = this.cache.get(roomId);
    // 无既有状态（房主尚未广播过完整 state）时不创建：
    // 心跳缺少 sourceUrl 等字段，无法构成完整播放状态。
    if (!cached) return;

    const now = Date.now();
    cached.state.currentTime = compensateTransportDelay({
      currentTime: heartbeat.currentTime,
      clientTs,
      playbackRate: heartbeat.playbackRate,
      isPlaying: heartbeat.isPlaying,
      now,
    });
    cached.state.isPlaying = heartbeat.isPlaying;
    if (heartbeat.playbackRate > 0) {
      cached.state.playbackRate = heartbeat.playbackRate;
    }
    cached.state.updatedAt = now;

    if (now - cached.lastDbWriteAt > HEARTBEAT_PERSIST_THROTTLE_MS) {
      cached.dirty = true;
      await this.flushToDb(roomId);
    }
  }

  /**
   * 获取所有有播放状态的房间 ID（用于定时广播遍历）。
   */
  getActiveRoomIds(): string[] {
    return Array.from(this.cache.keys());
  }

  /**
   * 检查指定房间是否有内存缓存条目。
   * 用于 room-state 清理时判断是否仍有关联的播放记忆。
   */
  hasCache(roomId: string): boolean {
    return this.cache.has(roomId);
  }

  /**
   * 清除播放状态（房间关闭时调用）。
   */
  async clearPlayback(roomId: string): Promise<void> {
    this.cache.delete(roomId);
    this.storageAdapter?.delete(roomId);
    try {
      const repo = AppDataSource.getRepository(PlaybackState);
      await repo.delete({ roomId });
    } catch (err) {
      console.error('[PlaybackMemoryService] clearPlayback error:', err);
    }
  }

  /**
   * 从存储适配器初始化播放记忆缓存（#16）。
   * 在配置了 RedisStorageAdapter 后，启动时调用此方法从 Redis 恢复所有房间的播放状态。
   */
  async initFromAdapter(): Promise<void> {
    if (!this.storageAdapter) return;
    if (this.storageAdapter.init) {
      await this.storageAdapter.init();
    }
    const entries = Array.from(this.storageAdapter.entries());
    for (const [roomId, state] of entries) {
      this.cache.set(roomId, {
        state,
        lastDbWriteAt: Date.now(),
        dirty: false,
      });
    }
    if (entries.length > 0) {
      console.log(`[PlaybackMemoryService] 已从存储适配器恢复 ${entries.length} 个房间的播放状态`);
    }
  }

  /**
   * 强制刷新内存缓存（从 DB 重新加载）。
   * 用于服务器重启后首次访问。
   */
  async refreshCache(roomId: string): Promise<void> {
    const state = await this.loadFromDb(roomId);
    if (state) {
      this.cache.set(roomId, {
        state,
        lastDbWriteAt: Date.now(),
        dirty: false,
      });
    } else {
      this.cache.delete(roomId);
    }
  }

  /**
   * 将内存状态写入 DB。
   */
  private async flushToDb(roomId: string): Promise<void> {
    const cached = this.cache.get(roomId);
    if (!cached || !cached.dirty) return;

    try {
      const repo = AppDataSource.getRepository(PlaybackState);
      const state = cached.state;
      const hostSocketId = (state as PlaybackStateDto & { hostSocketId?: string | null }).hostSocketId ?? null;

      const entity: Partial<PlaybackState> = {
        roomId,
        sourceUrl: state.sourceUrl,
        sourceType: state.sourceType,
        audioUrl: state.audioUrl ?? null,
        format: state.format ?? null,
        videoCodec: state.videoCodec ?? null,
        audioCodec: state.audioCodec ?? null,
        cid: state.cid ?? null,
        isPlaying: state.isPlaying,
        currentTime: state.currentTime,
        playbackRate: state.playbackRate,
        duration: state.duration ?? 0,
        currentQn: state.currentQn ?? null,
        acceptQuality: state.acceptQuality ? JSON.stringify(state.acceptQuality) : null,
        headers: state.headers ? JSON.stringify(state.headers) : null,
        isPreview: state.isPreview ?? false,
        previewTitle: state.previewTitle ?? null,
        bufferMode: state.bufferMode ?? false,
        currentMovieId: state.currentMovieId ?? null,
        lastUpdatedAt: state.updatedAt,
        hostSocketId,
      };

      // 使用 upsert 避免并发或部分实体对象导致的 UNIQUE constraint 冲突。
      // roomId 是主键，冲突时更新全部字段。
      await repo.upsert(entity, ['roomId']);
      cached.lastDbWriteAt = Date.now();
      cached.dirty = false;
    } catch (err) {
      console.error('[PlaybackMemoryService] flushToDb error:', err);
    }
  }

  /**
   * 从 DB 加载播放状态到内存。
   */
  private async loadFromDb(roomId: string): Promise<PlaybackStateDto | null> {
    try {
      const repo = AppDataSource.getRepository(PlaybackState);
      const entity = await repo.findOneBy({ roomId });
      if (!entity) return null;

      return this.entityToDto(entity);
    } catch (err) {
      console.error('[PlaybackMemoryService] loadFromDb error:', err);
      return null;
    }
  }

  /**
   * 推算状态：基于 lastUpdatedAt 计算实际 currentTime。
   */
  private advanceState(state: PlaybackStateDto): PlaybackStateDto {
    if (!state.isPlaying) {
      return state;
    }

    const now = Date.now();
    const elapsedSec = (now - state.updatedAt) / 1000;
    const advancedTime = state.currentTime + elapsedSec * state.playbackRate;

    // 视频已结束
    if (state.duration && advancedTime >= state.duration) {
      return {
        ...state,
        currentTime: state.duration,
        isPlaying: false,
      };
    }

    return {
      ...state,
      currentTime: advancedTime,
    };
  }

  /**
   * 从当前影片列表获取 currentMovieId。
   */
  private async getCurrentMovieId(roomId: string): Promise<number | undefined> {
    // 复用 roomStateService 的 currentMovieId
    // 避免循环依赖，使用动态导入
    const { roomStateService } = await import('../room/room-state.service');
    const id = roomStateService.getCurrentMovieId(roomId);
    return id != null ? Number(id) : undefined;
  }

  /**
   * 强制刷新所有脏数据到 DB。
   * 用于优雅关闭、进程退出信号等场景，确保最多 2s 的脏数据不丢失。
   */
  async flushAllDirty(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const roomId of this.cache.keys()) {
      const cached = this.cache.get(roomId);
      if (cached && cached.dirty) {
        promises.push(this.flushToDb(roomId));
      }
    }
    await Promise.allSettled(promises);
  }

  /**
   * 清理陈旧缓存条目：房主离线超过 CACHE_STALE_THRESHOLD_MS 且房间无活跃在线观众。
   * 同时清理 DB 中播放状态。
   * 由 PlaybackBroadcasterService 的定时任务驱动。
   */
  async cleanupStaleCache(): Promise<void> {
    const now = Date.now();
    for (const [roomId, cached] of this.cache.entries()) {
      // 房主在线 → 跳过
      if (this.isHostOnline(roomId)) continue;

      // 检查最后更新时间是否超过阈值
      const age = now - cached.state.updatedAt;
      if (age > CACHE_STALE_THRESHOLD_MS) {
        // 先 flush 脏数据
        if (cached.dirty) {
          await this.flushToDb(roomId);
        }
        // 从 DB 清除播放状态
        this.cache.delete(roomId);
        try {
          const repo = AppDataSource.getRepository(PlaybackState);
          await repo.delete({ roomId });
        } catch {
          // 忽略删除错误
        }
      }
    }
  }

  /**
   * Entity → DTO 转换。
   */
  private entityToDto(entity: PlaybackState): PlaybackStateDto & { hostSocketId: string | null } {
    let acceptQuality: QualityOptionDto[] | undefined;
    if (entity.acceptQuality) {
      try {
        acceptQuality = JSON.parse(entity.acceptQuality);
      } catch {
        // ignore parse error
      }
    }

    let headers: Record<string, string> | undefined;
    if (entity.headers) {
      try {
        headers = JSON.parse(entity.headers);
      } catch {
        // ignore parse error
      }
    }

    return {
      sourceUrl: entity.sourceUrl,
      sourceType: entity.sourceType as SyncStateDto['sourceType'],
      audioUrl: entity.audioUrl ?? undefined,
      format: (entity.format as SyncStateDto['format']) ?? undefined,
      videoCodec: entity.videoCodec ?? undefined,
      audioCodec: entity.audioCodec ?? undefined,
      cid: entity.cid ?? undefined,
      isPlaying: entity.isPlaying,
      currentTime: entity.currentTime,
      playbackRate: entity.playbackRate,
      duration: entity.duration,
      currentQn: entity.currentQn ?? undefined,
      acceptQuality,
      headers,
      isPreview: entity.isPreview,
      previewTitle: entity.previewTitle ?? undefined,
      bufferMode: entity.bufferMode ?? undefined,
      currentMovieId: entity.currentMovieId ?? undefined,
      updatedAt: entity.lastUpdatedAt,
      hostSocketId: entity.hostSocketId,
    };
  }
}

/** 全局单例 */
export const playbackMemoryService = new PlaybackMemoryService();
