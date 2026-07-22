/**
 * 播放状态持久化实体。
 *
 * 设计目标：当房主刷新/退出网页后，服务器仍可基于此实体继续推算播放进度，
 * 并广播给观众，使观众能继续观看。
 *
 * 核心字段：
 * - roomId: 关联房间（一对一）
 * - sourceUrl/audioUrl/format/...: 视频源信息（房主解析后写入）
 * - isPlaying/currentTime/playbackRate/duration: 播放状态
 * - lastUpdatedAt: 最近一次状态更新的 Unix 时间戳（毫秒）
 *   服务器基于此字段 + isPlaying + playbackRate 推算当前实际播放进度
 * - hostSocketId: 当前房主 socket ID（房主断开时置空，重连时恢复）
 *
 * 推算公式（观众请求状态时）：
 *   actualCurrentTime = currentTime + (Date.now() - lastUpdatedAt) / 1000 * playbackRate * (isPlaying ? 1 : 0)
 *   若 actualCurrentTime > duration，则视频已结束，置为 duration 且 isPlaying = false
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

@Entity('playback_states')
export class PlaybackState {
  /** 关联房间 ID（主键，与 Room.roomId 一致） */
  @PrimaryColumn({ type: 'varchar', length: 50 })
  roomId!: string;

  /** 视频源 URL（B站 DASH 为视频流 m4s 地址） */
  @Column({ type: 'text' })
  sourceUrl!: string;

  /** 源类型 */
  @Column({ type: 'varchar', length: 50 })
  sourceType!: string;

  /** DASH 音频流地址（独立于视频流） */
  @Column({ type: 'text', nullable: true })
  audioUrl!: string | null;

  /** 媒体容器格式 */
  @Column({ type: 'varchar', length: 20, nullable: true })
  format!: string | null;

  /** 视频编码（如 avc1.64001E），用于 MSE addSourceBuffer mime */
  @Column({ type: 'varchar', length: 50, nullable: true })
  videoCodec!: string | null;

  /** 音频编码（如 mp4a.40.2） */
  @Column({ type: 'varchar', length: 50, nullable: true })
  audioCodec!: string | null;

  /** B站视频 cid，用于加载官方弹幕 */
  @Column({ type: 'bigint', nullable: true })
  cid!: number | null;

  /** 是否正在播放 */
  @Column({ type: 'boolean', default: false })
  isPlaying!: boolean;

  /** 当前播放进度（秒，最后一次更新时的值） */
  @Column({ type: 'double' })
  currentTime!: number;

  /** 播放倍速 */
  @Column({ type: 'double', default: 1 })
  playbackRate!: number;

  /** 视频总时长（秒） */
  @Column({ type: 'double', default: 0 })
  duration!: number;

  /** B站当前清晰度 qn（如 80=1080P、120=4K） */
  @Column({ type: 'int', nullable: true })
  currentQn!: number | null;

  /** B站可用清晰度列表（JSON 字符串） */
  @Column({ type: 'text', nullable: true })
  acceptQuality!: string | null;

  /** 源指定的防盗链 headers（JSON 字符串） */
  @Column({ type: 'text', nullable: true })
  headers!: string | null;

  /** 是否为预览源（不入影片列表） */
  @Column({ type: 'boolean', default: false })
  isPreview!: boolean;

  /** 预览源显示标题 */
  @Column({ type: 'varchar', length: 200, nullable: true })
  previewTitle!: string | null;

  /** 当前播放的影片 ID（用于房主刷新后匹配是否同一部影片） */
  @Column({ type: 'int', nullable: true })
  currentMovieId!: number | null;

  /**
   * 最近一次状态更新的 Unix 时间戳（毫秒）。
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

  @OneToOne(() => Room)
  @JoinColumn({ name: 'roomId', referencedColumnName: 'roomId' })
  room!: Room;
}
