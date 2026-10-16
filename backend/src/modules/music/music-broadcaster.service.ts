/**
 * 一起听音乐状态定时广播服务（服务器心跳，架构对齐一起看 playback-broadcaster）。
 *
 * 当前（服务器权威化）：服务器每 2s 恒定广播 music:sync-heartbeat
 * (source='server')，房主在线/离线同一条进度路径——观众进度统一以
 * 服务器推算值（getAdvancedState，基线已经写侧传输延迟补偿）为权威，
 * 房主侧 music:sync-state / host-heartbeat 降级为「服务器基线更新通道」
 * （旧转发保留作旧前端兼容 + 新前端 fallback）。
 *
 * 核心逻辑：
 * - 每 2s 遍历所有有播放基线的房间
 * - 推算当前 positionSec（基于 lastUpdatedAt + isPlaying，恒 1x）
 * - 广播 music:sync-heartbeat(source='server') 给房间所有成员
 * - 房间无在线 socket 时跳过广播
 */
import type { Server as SocketIOServer } from 'socket.io';
import { musicPlaybackMemoryService } from './music-playback-memory.service';
import { roomSessionService } from '../room/room-session.service';

/** 服务器心跳广播间隔（毫秒） */
const SERVER_HEARTBEAT_INTERVAL_MS = 2000;

/** 缓存清理间隔（毫秒） */
const CACHE_CLEANUP_INTERVAL_MS = 30000;

/** hostOnline 查询缓存 TTL（毫秒）：避免每 2s × 每房间都打一次 Session 表 */
const HOST_ONLINE_CACHE_TTL_MS = 5000;

/** 房主在线状态缓存：roomId → { online, ts } */
const hostOnlineCache = new Map<
  string,
  { online: boolean; ts: number }
>();

/** 查询房间房主在线状态（5s TTL 缓存，心跳广播高频调用用） */
async function isHostOnlineCached(roomId: string): Promise<boolean> {
  const cached = hostOnlineCache.get(roomId);
  if (cached && Date.now() - cached.ts < HOST_ONLINE_CACHE_TTL_MS) {
    return cached.online;
  }
  let online = false;
  try {
    online = await roomSessionService.isSharerOnline(roomId);
  } catch {
    // 查询失败按离线处理：观众端进入自主控制模式比误判在线更安全
    online = false;
  }
  hostOnlineCache.set(roomId, { online, ts: Date.now() });
  return online;
}

export class MusicBroadcasterService {
  private intervalId: NodeJS.Timeout | null = null;
  private cleanupIntervalId: NodeJS.Timeout | null = null;
  private io: SocketIOServer | null = null;

  /** 启动定时广播与缓存清理 */
  start(io: SocketIOServer): void {
    if (this.intervalId) {
      return; // 已启动
    }
    this.io = io;
    musicPlaybackMemoryService.setIo(io);
    this.intervalId = setInterval(() => {
      void this.broadcastAll();
    }, SERVER_HEARTBEAT_INTERVAL_MS);

    // 每 30s 清理一次陈旧内存缓存（房主长时间离线的房间）
    this.cleanupIntervalId = setInterval(() => {
      musicPlaybackMemoryService.cleanupStaleCache();
    }, CACHE_CLEANUP_INTERVAL_MS);
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
   * 遍历所有有播放基线的房间，广播推算后的状态。
   */
  private async broadcastAll(): Promise<void> {
    if (!this.io) return;

    const roomIds = musicPlaybackMemoryService.getActiveRoomIds();
    for (const roomId of roomIds) {
      try {
        // 检查房间是否有在线成员（socket），无人时跳过广播。
        // 注意：不按 isHostOnline 跳过——服务器心跳是观众进度的唯一权威
        // 来源，房主在线时同样恒定广播。
        const roomSockets = this.io.sockets.adapter.rooms.get(roomId);
        if (!roomSockets || roomSockets.size === 0) {
          continue;
        }

        const state = await musicPlaybackMemoryService.getAdvancedState(roomId);
        if (!state) continue;

        // hostOnline：随心跳持续下发给观众端，驱动「房主离线 → 观众自主控制
        // 模式」（canControl）的持续校正——覆盖观众在房主离线后才加入/刷新
        // 页面/socket 重连而错过 host-disconnected 事件的场景（get-state 的
        // hostOnline 仅在加入时查询一次，无法覆盖加入后房主状态变化错过
        // 事件的情况）。
        const hostOnline = await isHostOnlineCached(roomId);

        this.io.to(roomId).emit('music:sync-heartbeat', {
          roomId,
          source: 'server' as const,
          state,
          hostOnline,
        });
      } catch (err) {
        console.error(`[MusicBroadcaster] 广播房间 ${roomId} 失败:`, err);
      }
    }
  }
}

/** 全局单例 */
export const musicBroadcasterService = new MusicBroadcasterService();
