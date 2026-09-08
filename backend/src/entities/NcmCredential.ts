import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  UpdateDateColumn,
} from 'typeorm';

/**
 * 网易云音乐账号凭证（按用户持久化，与 BilibiliCredential 同构）。
 *
 * 存储扫码登录成功后内部 NCM API 服务返回的 Set-Cookie 原始字符串数组
 * （JSON 序列化），REST 层 /api/music/ncm/* 转发时注入 Cookie 头实现登录态。
 * 未登录用户无对应记录，以匿名（无 cookie）方式调用 NCM API。
 */
@Entity()
export class NcmCredential {
  @PrimaryGeneratedColumn()
  id!: number;

  /** 绑定的 ZViewer 用户 ID（游客 userId=0 不持久化凭证） */
  @Column({ type: 'integer', unique: true })
  userId!: number;

  /** Set-Cookie 原始字符串数组（JSON 序列化），如 ["MUSIC_U=xxx; ...", "__csrf=yyy; ..."] */
  @Column({ type: 'text' })
  cookies!: string;

  /** 网易云昵称（从登录响应的 profile 字段提取） */
  @Column({ type: 'text', nullable: true })
  nickname!: string | null;

  /** 网易云头像（从登录响应的 profile 字段提取） */
  @Column({ type: 'text', nullable: true })
  avatarUrl!: string | null;

  @UpdateDateColumn()
  updatedAt!: Date;
}
