import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
} from 'typeorm';
import { Session } from './Session';
import { Movie } from './Movie';

export type RoomStatus = 'active' | 'closed';
export type RoomMode = 'screen-share' | 'watch-together';
export type ShareMethod = 'webrtc' | 'stream-push';

@Entity()
export class Room {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ unique: true })
  roomId!: string;

  @Column({ type: 'varchar', nullable: true })
  name!: string | null;

  @Column({ type: 'varchar', nullable: true })
  password!: string | null;

  @Column({ type: 'integer', default: 10 })
  maxViewers!: number;

  @Column({ type: 'simple-enum', enum: ['active', 'closed'], default: 'active' })
  status!: RoomStatus;

  @Column({ type: 'simple-enum', enum: ['screen-share', 'watch-together'], default: 'screen-share' })
  mode!: RoomMode;

  /**
   * 投屏模式（mode === 'screen-share'）下的子模式：
   * - webrtc：基于 WebRTC 的浏览器屏幕共享（默认）
   * - stream-push：基于 OBS RTMP 推流 + HTTP-FLV 拉流的流媒体模式
   * watch-together 模式下此字段被忽略。
   */
  @Column({ type: 'simple-enum', enum: ['webrtc', 'stream-push'], default: 'webrtc' })
  shareMethod!: ShareMethod;

  /**
   * OBS 推流子模式（stream-push）的推流密钥。
   * 与 roomId 分离，提高安全性；生成后保持不变，除非手动重置。
   * webrtc 模式下此字段为 null。
   */
  @Column({ type: 'varchar', nullable: true })
  streamKey!: string | null;

  @Column({ type: 'boolean', default: true })
  requireApproval!: boolean;

  @Column({ type: 'integer', nullable: true })
  ownerUserId!: number | null;

  /**
   * 被房主禁言的用户 ID 列表（JSON 字符串持久化）。
   * 被禁言的用户不能发送评论与弹幕，但仍可观看与接收同步状态。
   * 空数组或 null 表示无禁言。
   */
  @Column({ type: 'text', default: '[]' })
  mutedViewers!: string;

  /**
   * 已被房主批准进入的观众 user ID 列表（JSON 数组持久化）。
   * 一旦被批准，观众刷新页面或切换模式后无需再次审批即可直接进入房间。
   * 仅对已登录用户有效（guest 无 userId，每次仍需审批）。
   */
  @Column({ type: 'text', default: '[]' })
  approvedViewers!: string;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @Column({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  lastAccessedAt!: Date;

  @OneToMany(() => Session, (session) => session.room)
  sessions!: Session[];

  @OneToMany(() => Movie, (movie) => movie.room, { cascade: true })
  movies_relation!: Movie[];
}
