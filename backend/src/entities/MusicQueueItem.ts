import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

/**
 * 一起听（Listen Together）房间播放队列条目。
 *
 * 每个房间一份队列（roomId 关联），order 为队列内排序序号，
 * 删除/重排后由后端压实为 1..n 连续。播放模式（顺序循环/单曲循环/随机）
 * 由前端按队列与模式自行计算下一首，后端只维护队列与顺序。
 *
 * addedBy 存添加者用户 ID（游客为 0），广播队列时由后端解析为用户名
 * （前端契约 MusicQueueItem.addedBy 为 string 用户名）。
 */
@Entity()
@Index(['roomId'])
export class MusicQueueItem {
  @PrimaryGeneratedColumn()
  id!: number;

  /** 所属房间 ID（索引由实体级 @Index(['roomId']) 定义，列级不再重复声明，
   *  否则 synchronize 生成两条同名 CREATE INDEX 导致建表失败） */
  @Column()
  roomId!: string;

  /** 音频来源：ncm=网易云（默认，经 /song/url/v1 解析）；siren=塞壬唱片
   *  （明日方舟 Monster Siren，经其公开 API 解析直链） */
  @Column({ type: 'text', default: 'ncm' })
  source!: string;

  /** 网易云歌曲 ID（ncm 来源使用；siren 来源为 0） */
  @Column({ type: 'integer' })
  songId!: number;

  /** 来源方歌曲标识（siren 的 cid 为字符串如 "018f7efdc4"，integer 存不下；
   *  ncm 来源为 null，用 songId） */
  @Column({ type: 'text', nullable: true })
  sourceId!: string | null;

  /** 歌曲名 */
  @Column({ type: 'text' })
  name!: string;

  /** 艺术家（多人拼接字符串，如「周杰伦 / 费玉清」） */
  @Column({ type: 'text' })
  artist!: string;

  /** 专辑名 */
  @Column({ type: 'text' })
  album!: string;

  /** 封面图 URL */
  @Column({ type: 'text', nullable: true })
  cover!: string | null;

  /** 时长（毫秒） */
  @Column({ type: 'integer' })
  durationMs!: number;

  /** 是否 VIP 歌曲（未登录时不可播放） */
  @Column({ type: 'boolean', default: false })
  vip!: boolean;

  /** 队列内排序序号（小在前；删除/重排后由后端压实为 1..n 连续） */
  @Column({ type: 'integer' })
  order!: number;

  /** 添加者用户 ID（游客为 0；广播时解析为用户名） */
  @Column({ type: 'integer', default: 0 })
  addedBy!: number;

  @CreateDateColumn()
  createdAt!: Date;
}
