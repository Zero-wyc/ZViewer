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

  /**
   * 添加/更新影片时锚定的挂载 ID（运行时 /stream 凭证解析优先按此取挂载）。
   *
   * 旧数据为 null：/stream 回退按 serverUrl + source 匹配挂载——同服务器
   * 被多个用户挂载（凭证不同）时匹配结果不确定，此列消除该歧义。
   * 挂载删除后回退 serverUrl 匹配兜底。
   */
  @Column({ type: 'integer', nullable: true })
  sourceMountId!: number | null;

  @Column({ type: 'varchar', nullable: true })
  path!: string | null;

  @Column({ type: 'varchar', nullable: true })
  username!: string | null;

  @Column({ type: 'varchar', nullable: true, transformer: secretTransformer })
  password!: string | null;

  @Column({ type: 'boolean', default: false })
  directLink!: boolean;

  /**
   * 直链模式的媒体传输方式（仅 directLink=true 时有意义）。
   *
   * - false（默认）：强制直链直连——浏览器直连源站，服务器零媒体流量；
   *   直连失败（CORS/防盗链/签名过期）直接向用户报错，不回退服务器中转
   * - true：媒体流一律经服务器中转——非清单类格式（m3u8/mpd）解析层
   *   预包装为服务器代理 URL，不做直连尝试；m3u8 清单/分片由 hls-engine
   *   ProxyLoader 全量代理
   */
  @Column({ type: 'boolean', default: false })
  directLinkProxy!: boolean;

  /**
   * 数据源影片（ani-subs / Kazumi / CMS 采集源）的服务器中转模式。
   *
   * - false（默认）：一律直连源站，不自动兜底服务器代理（带防盗链的源
   *   需开启本开关才能播放，服务器零媒体流量）
   * - true：媒体流一律经服务器中转——解析结果统一包装为服务器代理 URL，
   *   房间内所有成员的媒体流量都走服务器（ani/cms 播放时实时重解析消费
   *   本字段；kazumi 在添加时物化为代理 URL）
   */
  @Column({ type: 'boolean', default: false })
  serverProxy!: boolean;

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
   * 影片级浏览器播放引擎（playsvideo）开关。
   * - true：允许该影片走浏览器端 playsvideo 重封装/转码管线（默认）
   * - false：强制原生直连播放，不兼容编码将无声或无法播放
   * 需与系统级 playsvideoEnabled 开关同时开启才启用（两级任一关闭即直推）。
   */
  @Column({ type: 'boolean', default: true })
  playsvideoEnabled!: boolean;

  /**
   * 仅允许 CLI 模式（B站 番剧/影视 PGC 专属配置）。
   *
   * - true：全房间成员（含房主）必须各自连接 ZViewer CLI 才能观看，
   *   媒体流一律经成员本机 CLI 代理，服务器零媒体流量（仅承载信令与
   *   playurl 解析）；未连接 CLI 的成员无法播放，不回退服务器转发
   * - false（默认）：按常规解析偏好（服务器转发 / MP4 直链 / CLI）
   */
  @Column({ type: 'boolean', default: false })
  cliOnly!: boolean;

  /**
   * Emby/Jellyfin 专属：是否存在多版本（多个 MediaSource）。
   * 添加影片时由 resolve 的 multiVersion 物化；false 时前端
   * 不渲染清晰度版本选择框（单版本影片无需选择）。
   */
  @Column({ type: 'boolean', default: false })
  multiVersion!: boolean;

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
