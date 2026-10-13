/**
 * 播放状态定时广播服务（服务器心跳）。
 *
 * 旧架构：房主每 2s 广播 host-heartbeat，房主断开后观众 6s 超时暂停。
 * 中间态：服务器仅在房主离线时广播 server-heartbeat 接管。
 * 当前（Step 2，服务器权威化）：服务器每 2s 恒定广播 sync-heartbeat
 * (source='server')，房主在线/离线同一条进度路径——观众进度统一以
 * 服务器推算值（advanceState，基线已经 Step 1 传输延迟补偿）为权威，
 * 房主侧 watch-together-state/control 降级为「源信息 + 即时操作事件」通道。
 *
 * 核心逻辑：
 * - 每 2s 遍历所有有播放状态的房间
 * - 推算当前 currentTime（基于 lastUpdatedAt + isPlaying + playbackRate）
 * - 广播 server-heartbeat + sync-heartbeat(source='server') 给房间所有成员
 * - 房间无在线 socket 时跳过广播
 *
 * 性能：
 * - 单个 setInterval，遍历内存缓存中的房间
 * - 每个房间仅一次读取（缓存命中时纯内存操作）
 */
import type { Server as SocketIOServer } from 'socket.io';
import { playbackMemoryService } from './playback-memory.service';

/** 服务器心跳广播间隔（毫秒） */
const SERVER_HEARTBEAT_INTERVAL_MS = 2000;

export class PlaybackBroadcasterService {
  private intervalId: NodeJS.Timeout | null = null;
  private cleanupIntervalId: NodeJS.Timeout | null = null;
  private io: SocketIOServer | null = null;

  /** 启动定时广播与缓存清理 */
  start(io: SocketIOServer): void {
    if (this.intervalId) {
      return; // 已启动
    }
    this.io = io;
    this.intervalId = setInterval(() => {
      void this.broadcastAll();
    }, SERVER_HEARTBEAT_INTERVAL_MS);

    // 每 30s 清理一次陈旧缓存（playback-memory + room-state）
    this.cleanupIntervalId = setInterval(() => {
      void playbackMemoryService.cleanupStaleCache();
      void import('../room/room-state.service').then(({ roomStateService }) => {
        roomStateService.cleanupStaleStates();
      }).catch((err) => {
        console.error('[cleanup] room-state 动态导入失败:', err);
      });
    }, 30000);
  }

  /** 停止定时广播与缓存清理 */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.cleanupIntervalId) {
      clearInterval(this.cleanupIntervalId);
      this.cleanupIntervalId = null;
    }
    this.io = null;
  }

  /**
   * 遍历所有有播放状态的房间，广播推算后的状态。
   */
  private async broadcastAll(): Promise<void> {
    if (!this.io) return;

    const roomIds = playbackMemoryService.getActiveRoomIds();
    for (const roomId of roomIds) {
      try {
        // 检查房间是否有在线成员（socket），无观众时跳过广播。
        // 注意：不再按 isHostOnline 跳过——服务器心跳是观众进度的唯一权威
        // 来源（Step 2），房主在线时同样恒定广播。
        const roomSockets = this.io.sockets.adapter.rooms.get(roomId);
        if (!roomSockets || roomSockets.size === 0) {
          continue;
        }

        const state = await playbackMemoryService.getAdvancedPlayback(roomId);
        if (!state) continue;

        this.io.to(roomId).emit('server-heartbeat', {
          roomId,
          state,
        });
        // 统一心跳协议（#14）：新增 sync-heartbeat 事件（source: 'server'）
        this.io.to(roomId).emit('sync-heartbeat', {
          source: 'server',
          state,
        });
      } catch (err) {
        console.error(`[PlaybackBroadcaster] 广播房间 ${roomId} 失败:`, err);
      }
    }
  }
}

/** 全局单例 */
export const playbackBroadcasterService = new PlaybackBroadcasterService();
