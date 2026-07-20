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
