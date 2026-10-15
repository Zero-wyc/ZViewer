/**
 * 一起听音乐同步的共享类型（服务器侧单一权威定义）。
 *
 * 从 MusicSyncHandler.ts 抽出：music-playback-memory.service（基线服务）与
 * MusicSyncHandler（信令入口）共同依赖，避免相互 import 成环。
 */

/** 播放模式（与前端 music/types.ts 的 PlayMode 对齐；
 *  order = 按顺序播放，不循环，B站 推荐连播仅此模式启用） */
export type MusicPlayMode = 'sequence' | 'order' | 'repeat-one' | 'shuffle';

/**
 * 房间音乐同步状态快照（房主 sync-state / 心跳携带，
 * 与前端 MusicSyncState 对齐）。
 */
export interface MusicSyncStatePayload {
  /** 当前曲目 songId（null 表示未在播放；B站 曲目恒为 null，兼容旧客户端） */
  trackSongId: number | null;
  /**
   * 当前曲目完整 key（`ncm:<songId>` / `bili:<bvid>:<cid>`；null 表示未播放）。
   * B站 曲目全房间同步广播用（B站 播放列表已并入房间队列）；保留
   * trackSongId 供旧客户端兼容。前端 > 此版本以 trackKey 为权威
   */
  trackKey: string | null;
  /** 是否正在播放 */
  isPlaying: boolean;
  /** 播放进度（秒） */
  positionSec: number;
  /** 播放模式 */
  playMode: MusicPlayMode;
  /** 状态生成时间戳（毫秒）。服务器侧写入时一律以服务器 Date.now() 物化，
   *  不信任房主上报值（写侧传输延迟补偿后锚定服务器时间轴） */
  updatedAt: number;
}
