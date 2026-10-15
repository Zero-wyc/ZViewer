/**
 * 一起听音乐播放基线服务（服务器权威，架构对齐一起看 playback-memory）。
 *
 * 三步架构（与 sync-playback 的 Step1/Step2/Step3 一致）：
 * - Step1 写侧传输延迟补偿：房主上行（sync-state / host-heartbeat）附 clientTs
 *   （发出时刻毫秒），服务器按 clamp((now - clientTs)/1000, 0, 1.5) × 1 补偿
 *   （音乐恒 1x 倍速，仅播放中补偿），使基线锚定服务器时间轴。
 * - Step2 服务器心跳权威路径：MusicBroadcasterService 每 2s 调 getAdvancedState
 *   外推（positionSec + elapsed，恒 1x），恒定广播 music:sync-heartbeat
 *   (source='server')——观众进度唯一权威来源。
 * - Step3 观众自检：MusicSyncHandler 的 music:check-status 用 needsProgressSync
 *   （复用 playback-memory 纯函数，容差 10s）判定并下发权威状态。
 *
 * 持久化：MusicPlaybackState 实体（TypeORM synchronize 自动建表），写侧节流
 * （全量写 2s / 心跳落盘 10s），后端重启后 get-state 经 loadFromDb 恢复续播。
 *
 * 差异说明（相对 playback-memory.service）：
 * - 音乐心跳携带完整 MusicSyncState，无既有缓存时也可自建条目；
 * - 音乐无倍速概念（恒 1x），无 duration 字段——歌曲时长按 trackKey 从
 *   MusicQueueItem.durationMs 解析缓存，外推到时长即凝固（isPlaying=false）；
 *   本地插播条目不在队列/时长缺失时不截断。
 */
import { AppDataSource } from '../../data-source';
import { MusicPlaybackState } from '../../entities/MusicPlaybackState';
import { MusicQueueItem } from '../../entities/MusicQueueItem';
import { compensateTransportDelay } from '../playback-memory';
import type { MusicSyncStatePayload } from './music-sync.types';

/** DB 全量写入节流间隔（毫秒）。房主操作离散触发，避免每次都写 DB。 */
const DB_WRITE_THROTTLE_MS = 2000;

/** 房主心跳落盘节流间隔（毫秒）。心跳每 2s 一次，10s 节流保证基线新鲜。 */
const HEARTBEAT_PERSIST_THROTTLE_MS = 10000;

/** 房主离线且无在线观众后，缓存保留时间（毫秒）。超过即清理。 */
const CACHE_STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 分钟

/** 内存缓存条目 */
interface CachedMusicState {
  /** 最新状态（updatedAt 已被服务器物化） */
  state: MusicSyncStatePayload;
  /** 当前曲目时长（秒；null = 未知/不在队列，不截断） */
  durationSec: number | null;
  /** 时长解析过的 trackKey（避免同曲反复查队列表） */
  durationResolvedForKey: string | null;
  /** 房主 socket ID（状态本体不含，单独存元数据） */
  hostSocketId: string | null;
  /** 最近一次 DB 写入时间戳 */
  lastDbWriteAt: number;
  /** 脏标记：内存已变更但未写入 DB */
  dirty: boolean;
}

export class MusicPlaybackMemoryService {
  private readonly cache = new Map<string, CachedMusicState>();
  /** Socket.IO 实例（可选）：用于校验 hostSocketId 对应的 socket 是否实际在线 */
  private io: import('socket.io').Server | null = null;

  /** 注入 Socket.IO 实例（isHostOnline 据此校验 socket 实际在线） */
  setIo(io: import('socket.io').Server): void {
    this.io = io;
  }

  /**
   * 写入完整播放状态（房主 music:sync-state 离散事件时调用）。
   *
   * @param clientTs 客户端发送时刻（Unix 毫秒）。提供时补偿传输延迟
   *   （clamp 0~1.5s × 1，仅播放中），使基线锚定服务器时间轴。
   */
  async setPlayback(
    roomId: string,
    state: MusicSyncStatePayload,
    hostSocketId: string,
    clientTs?: number,
  ): Promise<void> {
    const now = Date.now();
    const compensated = compensateTransportDelay({
      currentTime: state.positionSec,
      clientTs,
      playbackRate: 1,
      isPlaying: state.isPlaying,
      now,
    });

    const cached = this.cache.get(roomId);
    if (cached) {
      cached.state = { ...state, positionSec: compensated, updatedAt: now };
      cached.hostSocketId = hostSocketId;
      cached.dirty = true;
      this.maybeRefreshDuration(cached, roomId);
    } else {
      this.cache.set(roomId, {
        state: { ...state, positionSec: compensated, updatedAt: now },
        durationSec: null,
        durationResolvedForKey: null,
        hostSocketId,
        lastDbWriteAt: 0,
        dirty: true,
      });
    }

    if (now - (cached?.lastDbWriteAt ?? 0) > DB_WRITE_THROTTLE_MS) {
      await this.flushToDb(roomId);
    }
  }

  /**
   * 应用房主心跳到基线（music:host-heartbeat，每 2s，携带完整状态）。
   *
   * 与一起看的部分心跳不同：音乐心跳是完整状态，无既有缓存时也可自建
   * （观众仅靠服务器心跳推进，基线缺失会让广播停摆）。
   */
  async applyHostHeartbeat(
    roomId: string,
    state: MusicSyncStatePayload,
    hostSocketId: string,
    clientTs?: number,
  ): Promise<void> {
    const now = Date.now();
    const compensated = compensateTransportDelay({
      currentTime: state.positionSec,
      clientTs,
      playbackRate: 1,
      isPlaying: state.isPlaying,
      now,
    });

    const cached = this.cache.get(roomId);
    if (cached) {
      cached.state = { ...state, positionSec: compensated, updatedAt: now };
      cached.hostSocketId = hostSocketId;
      this.maybeRefreshDuration(cached, roomId);
      if (now - cached.lastDbWriteAt > HEARTBEAT_PERSIST_THROTTLE_MS) {
        cached.dirty = true;
        await this.flushToDb(roomId);
      }
    } else {
      this.cache.set(roomId, {
        state: { ...state, positionSec: compensated, updatedAt: now },
        durationSec: null,
        durationResolvedForKey: null,
        hostSocketId,
        lastDbWriteAt: 0,
        dirty: true,
      });
    }
  }

  /**
   * 获取推算后的当前状态（服务器心跳广播 / get-state / check-status 的数据源）。
   *
   * 外推：isPlaying=false 原样返回；否则 positionSec + (now - updatedAt)/1000
   * （恒 1x），到达歌曲时长即凝固（isPlaying=false, positionSec=durationSec）。
   */
  async getAdvancedState(roomId: string): Promise<MusicSyncStatePayload | null> {
    let cached = this.cache.get(roomId);

    if (!cached) {
      const state = await this.loadFromDb(roomId);
      if (!state) return null;
      cached = {
        state,
        durationSec: null,
        durationResolvedForKey: null,
        hostSocketId: null,
        lastDbWriteAt: Date.now(),
        dirty: false,
      };
      this.cache.set(roomId, cached);
    }

    return this.advanceState(roomId, cached);
  }

  /** 获取原始基线（不推算时间）。queue-upsert afterCurrent 定位用。 */
  async getRawState(roomId: string): Promise<MusicSyncStatePayload | null> {
    const cached = this.cache.get(roomId);
    if (cached) return cached.state;

    const state = await this.loadFromDb(roomId);
    if (state) {
      this.cache.set(roomId, {
        state,
        durationSec: null,
        durationResolvedForKey: null,
        hostSocketId: null,
        lastDbWriteAt: Date.now(),
        dirty: false,
      });
    }
    return state;
  }

  /** 更新房主 socket ID（房主重连/断开时调用；null = 断开） */
  async updateHostSocket(
    roomId: string,
    hostSocketId: string | null,
  ): Promise<void> {
    const cached = this.cache.get(roomId);
    if (cached) {
      cached.hostSocketId = hostSocketId;
    }
    try {
      const repo = AppDataSource.getRepository(MusicPlaybackState);
      await repo.update({ roomId }, { hostSocketId });
    } catch (err) {
      console.error('[MusicPlaybackMemory] updateHostSocket error:', err);
    }
  }

  /**
   * 检查房主是否在线。hostSocketId 非空仅代表"曾经注册过"：
   * 后端重启后从 DB 恢复的是失效旧值，注入 io 后校验 socket 实际在线。
   */
  isHostOnline(roomId: string): boolean {
    const cached = this.cache.get(roomId);
    if (!cached?.hostSocketId) return false;
    if (this.io) {
      return this.io.sockets.sockets.has(cached.hostSocketId);
    }
    return true;
  }

  /** 所有有基线的房间 ID（定时广播遍历用） */
  getActiveRoomIds(): string[] {
    return Array.from(this.cache.keys());
  }

  /** 清除房间基线（房间关闭/删除时调用）。 */
  async clear(roomId: string): Promise<void> {
    this.cache.delete(roomId);
    try {
      const repo = AppDataSource.getRepository(MusicPlaybackState);
      await repo.delete({ roomId });
    } catch (err) {
      console.error('[MusicPlaybackMemory] clear error:', err);
    }
  }

  /**
   * 强制刷新所有脏数据到 DB（优雅关闭时调用，最多丢 2s 脏数据）。
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
   * 清理陈旧缓存：房主离线且最后更新超过 10 分钟的房间。
   * 由 MusicBroadcasterService 的定时任务驱动。DB 中的播放状态保留
   * （供后端重启后 get-state 续播），仅清内存。
   */
  cleanupStaleCache(): void {
    const now = Date.now();
    for (const [roomId, cached] of this.cache.entries()) {
      if (this.isHostOnline(roomId)) continue;
      const age = now - cached.state.updatedAt;
      if (age > CACHE_STALE_THRESHOLD_MS && !cached.dirty) {
        this.cache.delete(roomId);
      }
    }
  }

  /**
   * 外推状态到当前时刻。
   */
  private async advanceState(
    roomId: string,
    cached: CachedMusicState,
  ): Promise<MusicSyncStatePayload> {
    const state = cached.state;
    if (!state.isPlaying) return state;

    const now = Date.now();
    const elapsedSec = (now - state.updatedAt) / 1000;
    let advanced = state.positionSec + elapsedSec;

    // 到达歌曲时长即凝固（服务器只负责凝固进度；歌曲结束推进仍由房主驱动）
    const durationSec = await this.ensureDurationSec(roomId, cached);
    if (durationSec != null && durationSec > 0 && advanced >= durationSec) {
      return { ...state, positionSec: durationSec, isPlaying: false };
    }

    return { ...state, positionSec: advanced };
  }

  /**
   * 换曲时刷新时长缓存（同曲不重复查表）。
   */
  private maybeRefreshDuration(cached: CachedMusicState, roomId: string): void {
    const key = cached.state.trackKey ?? '';
    if (cached.durationResolvedForKey === key) return;
    cached.durationResolvedForKey = key;
    cached.durationSec = null;
    void this.ensureDurationSec(roomId, cached).catch(() => {
      // 解析失败不截断
    });
  }

  /**
   * 确保 cached.durationSec 就绪：按 trackKey 从队列解析歌曲时长并缓存。
   * - ncm:key → MusicQueueItem.songId
   * - bili:key → source='bili' AND sourceId=key.slice(5)（"bvid:cid"）
   * 条目不在队列（本地插播竞态）/durationMs<=0 → null（不截断）。
   */
  private async ensureDurationSec(
    roomId: string,
    cached: CachedMusicState,
  ): Promise<number | null> {
    if (cached.durationResolvedForKey !== (cached.state.trackKey ?? '')) {
      const trackKey = cached.state.trackKey;
      if (!trackKey) {
        cached.durationSec = null;
        cached.durationResolvedForKey = '';
      } else {
        try {
          const repo = AppDataSource.getRepository(MusicQueueItem);
          const where = trackKey.startsWith('bili:')
            ? { roomId, source: 'bili', sourceId: trackKey.slice(5) }
            : {
                roomId,
                songId: Number(trackKey.slice(4)) || -1,
              };
          const item = await repo.findOneBy(where);
          const ms = item?.durationMs ?? 0;
          cached.durationSec = ms > 0 ? ms / 1000 : null;
          cached.durationResolvedForKey = trackKey;
        } catch {
          cached.durationSec = null;
          cached.durationResolvedForKey = trackKey;
        }
      }
    }
    return cached.durationSec;
  }

  /** 将内存状态写入 DB（upsert 防并发 UNIQUE 冲突） */
  private async flushToDb(roomId: string): Promise<void> {
    const cached = this.cache.get(roomId);
    if (!cached || !cached.dirty) return;

    try {
      const repo = AppDataSource.getRepository(MusicPlaybackState);
      const state = cached.state;
      const entity: Partial<MusicPlaybackState> = {
        roomId,
        trackSongId: state.trackSongId,
        trackKey: state.trackKey,
        isPlaying: state.isPlaying,
        positionSec: state.positionSec,
        playMode: state.playMode,
        lastUpdatedAt: state.updatedAt,
        hostSocketId: cached.hostSocketId,
      };
      await repo.upsert(entity, ['roomId']);
      cached.lastDbWriteAt = Date.now();
      cached.dirty = false;
    } catch (err) {
      console.error('[MusicPlaybackMemory] flushToDb error:', err);
    }
  }

  /** 从 DB 加载基线到内存（后端重启后首次访问） */
  private async loadFromDb(roomId: string): Promise<MusicSyncStatePayload | null> {
    try {
      const repo = AppDataSource.getRepository(MusicPlaybackState);
      const entity = await repo.findOneBy({ roomId });
      if (!entity) return null;

      const playModes: MusicSyncStatePayload['playMode'][] = [
        'sequence',
        'order',
        'repeat-one',
        'shuffle',
      ];
      return {
        trackSongId: entity.trackSongId,
        trackKey: entity.trackKey,
        isPlaying: entity.isPlaying,
        positionSec: entity.positionSec,
        playMode: playModes.includes(entity.playMode as MusicSyncStatePayload['playMode'])
          ? (entity.playMode as MusicSyncStatePayload['playMode'])
          : 'sequence',
        updatedAt: Number(entity.lastUpdatedAt),
      };
    } catch (err) {
      console.error('[MusicPlaybackMemory] loadFromDb error:', err);
      return null;
    }
  }
}

/** 全局单例 */
export const musicPlaybackMemoryService = new MusicPlaybackMemoryService();
