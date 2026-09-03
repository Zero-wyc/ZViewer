import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
  ValueTransformer,
} from 'typeorm';
import crypto from 'crypto';
import { Room } from './Room';

const CRYPTO_KEY = process.env.MOVIE_SECRET_KEY || 'zcontrol-movie-secret-key-32b';

function getKeyBuffer(): Buffer {
  return Buffer.from(CRYPTO_KEY.padEnd(32, '0').slice(0, 32));
}

export function encryptMovieField(plain: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', getKeyBuffer(), iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

export function decryptMovieField(encrypted: string): string {
  const [ivHex, dataHex] = encrypted.split(':');
  if (!ivHex || !dataHex) return '';
  const iv = Buffer.from(ivHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', getKeyBuffer(), iv);
  const decrypted = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
  return decrypted.toString('utf8');
}

const secretTransformer: ValueTransformer = {
  to: (value: unknown) => {
    if (typeof value !== 'string' || !value) return value;
    return encryptMovieField(value);
  },
  from: (value: unknown) => {
    if (typeof value !== 'string' || !value) return value;
    return decryptMovieField(value);
  },
};

@Entity()
export class Movie {
  @PrimaryGeneratedColumn()
  id!: number;

  @Index()
  @Column()
  roomId!: string;

  @Column()
  url!: string;

  @Column()
  title!: string;

  @Column({ type: 'varchar', nullable: true })
  cover!: string | null;

  @Column({ type: 'varchar', nullable: true })
  source!: string | null;

  @Column({ type: 'varchar', nullable: true })
  audioUrl!: string | null;

  @Column({ type: 'varchar', nullable: true })
  format!: string | null;

  @Column({ type: 'varchar', nullable: true })
  videoCodec!: string | null;

  @Column({ type: 'varchar', nullable: true })
  audioCodec!: string | null;

  @Column({ type: 'float', nullable: true })
  duration!: number | null;

  @Column({ type: 'integer', nullable: true })
  cid!: number | null;

  @Column({ type: 'integer', nullable: true })
  currentQn!: number | null;

  @Column({ type: 'text', nullable: true })
  acceptQuality!: string | null;

  /**
   * 多 P 视频的分集列表（JSON 字符串）。
   * 单 P 视频为 null；多 P 视频为 [{ page, cid, part, duration }, ...]。
   * 前端用于在影片列表中显示分P选择器，切换分P时使用对应 cid 重新解析。
   */
  @Column({ type: 'text', nullable: true })
  pages!: string | null;

  /**
   * 当前播放的分集序号（从 1 开始）。
   * 默认 1（第一 P），用户切换分P后更新。
   */
  @Column({ type: 'integer', nullable: true })
  currentPage!: number | null;

  @Column({ type: 'varchar', nullable: true })
  serverUrl!: string | null;

  @Column({ type: 'varchar', nullable: true })
  path!: string | null;

  @Column({ type: 'varchar', nullable: true })
  username!: string | null;

  @Column({ type: 'varchar', nullable: true, transformer: secretTransformer })
  password!: string | null;

  @Column({ type: 'boolean', default: false })
  directLink!: boolean;

  /**
   * 影片级转码引擎标记（已废弃，仅保留数据库列避免迁移）。
   *
   * 原为「添加影片时勾选且检测到需要（DTS 等不兼容音轨）」的触发条件。
   * 自研 wasm 引擎移除后，playsvideo 的启用改由前端 `shouldUsePlaysVideo`
   * 依据容器与音轨编码自行判定，不再读取本字段。
   */
  @Column({ type: 'boolean', default: false })
  wasmEngine!: boolean;

  /**
   * ani-subs 番剧源元数据（JSON 字符串）。
   *
   * 存储 sourceId 和 episode 信息，用于播放时重新解析播放地址。
   * ani-subs 的视频地址通常带 token/signature，短期有效，
   * 刷新后需要通过 sourceMeta 重新解析，而非使用过期的 URL。
   *
   * 结构：{ sourceId: string, episode: AniSubsEpisode, originalTitle: string }
   * 仅 source='anime' 时有值，其他源类型为 null。
   */
  @Column({ type: 'text', nullable: true })
  sourceMeta!: string | null;

  @Column({ type: 'integer', default: 0 })
  order!: number;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @ManyToOne(() => Room, (room) => room.movies_relation, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'roomId', referencedColumnName: 'roomId' })
  room!: Room;
}
