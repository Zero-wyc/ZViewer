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

/** DB 写入节流间隔（毫秒）。房主高频更新时避免每次都写 DB。 */
const DB_WRITE_THROTTLE_MS = 2000;

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

  /**
   * 更新播放状态（房主调用）。
   *
   * @param roomId 房间 ID
   * @param state 房主广播的完整状态
   * @param hostSocketId 房主 socket ID
   */
  async setPlayback(
    roomId: string,
    state: SyncStateDto,
    hostSocketId: string,
  ): Promise<void> {
    const now = Date.now();
    const currentMovieId = await this.getCurrentMovieId(roomId);
    const playbackState: PlaybackStateDto = {
      ...state,
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
   * 检查房主是否在线（hostSocketId 不为 null）。
   */
  isHostOnline(roomId: string): boolean {
    const cached = this.cache.get(roomId);
    if (!cached) return false;
    const hostSocketId = (cached.state as PlaybackStateDto & { hostSocketId?: string | null }).hostSocketId;
    return !!hostSocketId;
  }

  /**
   * 获取所有有播放状态的房间 ID（用于定时广播遍历）。
   */
  getActiveRoomIds(): string[] {
    return Array.from(this.cache.keys());
  }

  /**
   * 清除播放状态（房间关闭时调用）。
   */
  async clearPlayback(roomId: string): Promise<void> {
    this.cache.delete(roomId);
    try {
      const repo = AppDataSource.getRepository(PlaybackState);
      await repo.delete({ roomId });
    } catch (err) {
      console.error('[PlaybackMemoryService] clearPlayback error:', err);
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
        currentMovieId: state.currentMovieId ?? null,
        lastUpdatedAt: state.updatedAt,
        hostSocketId,
      };

      await repo.save(entity);
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
      currentMovieId: entity.currentMovieId ?? undefined,
      updatedAt: entity.lastUpdatedAt,
      hostSocketId: entity.hostSocketId,
    };
  }
}

/** 全局单例 */
export const playbackMemoryService = new PlaybackMemoryService();
