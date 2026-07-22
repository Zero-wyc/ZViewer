/**
 * 播放状态定时广播服务（服务器心跳）。
 *
 * 旧架构：房主每 2s 广播 host-heartbeat，房主断开后观众 6s 超时暂停。
 * 新架构：服务器每 2s 广播 server-heartbeat + 推算后的播放状态，
 *         房主断开后服务器继续广播，观众可继续观看。
 *
 * 核心逻辑：
 * - 每 2s 遍历所有有播放状态的房间
 * - 推算当前 currentTime（基于 lastUpdatedAt + isPlaying + playbackRate）
 * - 广播 server-heartbeat 事件给房间所有成员
 * - 若房主在线，则跳过广播（房主自己会广播 watch-together-state）
 *   仅在房主断开期间接管广播
 *
 * 性能：
 * - 单个 setInterval，遍历内存缓存中的房间
 * - 每个房间仅一次 DB 读取（缓存命中时纯内存操作）
 */
import type { Server as SocketIOServer } from 'socket.io';
import { playbackMemoryService } from './playback-memory.service';

/** 服务器心跳广播间隔（毫秒） */
const SERVER_HEARTBEAT_INTERVAL_MS = 2000;

export class PlaybackBroadcasterService {
  private intervalId: NodeJS.Timeout | null = null;
  private io: SocketIOServer | null = null;

  /** 启动定时广播 */
  start(io: SocketIOServer): void {
    if (this.intervalId) {
      return; // 已启动
    }
    this.io = io;
    this.intervalId = setInterval(() => {
      void this.broadcastAll();
    }, SERVER_HEARTBEAT_INTERVAL_MS);
  }

  /** 停止定时广播 */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
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
        // 仅在房主离线时由服务器接管广播
        // 房主在线时由房主的 watch-together-state 事件驱动
        if (playbackMemoryService.isHostOnline(roomId)) {
          continue;
        }

        const state = await playbackMemoryService.getAdvancedPlayback(roomId);
        if (!state) continue;

        this.io.to(roomId).emit('server-heartbeat', {
          roomId,
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
