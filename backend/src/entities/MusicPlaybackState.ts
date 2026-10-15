/**
 * 一起听（Listen Together）音乐播放状态持久化实体。
 *
 * 设计目标：与一起看的 PlaybackState 对齐——服务器持有权威播放基线
 * （写侧传输延迟补偿后锚定服务器时间轴），后端重启后 get-state 可恢复续播。
 *
 * 核心字段：
 * - roomId: 关联房间（一对一）
 * - trackKey/trackSongId: 当前曲目（与前端 MusicSyncState 契约对齐）
 * - isPlaying/positionSec/playMode: 播放状态
 * - lastUpdatedAt: 最近一次状态更新的 Unix 时间戳（毫秒，服务器物化）
 *   服务器基于此字段 + isPlaying 推算当前实际播放进度（音乐恒 1x 倍速）
 * - hostSocketId: 当前房主 socket ID（房主断开时置空，重连时恢复）
 *
 * 推算公式：
 *   actualPositionSec = positionSec + (Date.now() - lastUpdatedAt) / 1000 * (isPlaying ? 1 : 0)
 *   若推算值超过歌曲时长（由队列 MusicQueueItem.durationMs 解析），则置为时长且 isPlaying = false
 */
import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToOne,
  JoinColumn,
} from 'typeorm';
import { Room } from './Room';

@Entity('music_playback_states')
export class MusicPlaybackState {
  /** 关联房间 ID（主键，与 Room.roomId 一致） */
  @PrimaryColumn({ type: 'varchar', length: 50 })
  roomId!: string;

  /** 当前曲目 songId（null 表示未在播放；B站 曲目恒为 null） */
  @Column({ type: 'int', nullable: true })
  trackSongId!: number | null;

  /** 当前曲目完整 key（`ncm:<songId>` / `bili:<bvid>:<cid>`；null 表示未播放） */
  @Column({ type: 'text', nullable: true })
  trackKey!: string | null;

  /** 是否正在播放 */
  @Column({ type: 'boolean', default: false })
  isPlaying!: boolean;

  /** 播放进度（秒，最后一次更新时的值） */
  @Column({ type: 'double', default: 0 })
  positionSec!: number;

  /** 播放模式 */
  @Column({ type: 'varchar', length: 20, default: 'sequence' })
  playMode!: string;

  /**
   * 最近一次状态更新的 Unix 时间戳（毫秒，服务器写入时物化）。
   * 服务器基于此字段推算当前实际播放进度。
   */
  @Column({ type: 'bigint' })
  lastUpdatedAt!: number;

  /**
   * 当前房主 socket ID。
   * - 房主在线时：房主的 socket.id
   * - 房主断开后：null（但状态仍保留，服务器继续推算）
   * - 房主重连后：更新为新 socket.id
   */
  @Column({ type: 'varchar', length: 50, nullable: true })
  hostSocketId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @OneToOne(() => Room, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'roomId', referencedColumnName: 'roomId' })
  room!: Room;
}
