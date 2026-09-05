import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity()
export class SystemSettings {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'boolean', default: true })
  autoDeleteInactiveRooms!: boolean;

  @Column({ type: 'integer', default: 24 })
  autoDeleteAfterHours!: number;

  @Column({ type: 'json', nullable: true })
  dataSourceConfig!: Record<string, unknown> | null;

  @Column({ type: 'text', default: 'approval' })
  registrationMode!: 'open' | 'approval' | 'closed';

  /**
   * 房间创建权限模式。
   * - `admin-only`：仅 root/admin 可创建房间（向后兼容旧行为）
   * - `all-users`：所有已登录的 user/admin/root 均可创建房间（guest 始终禁止）
   */
  @Column({ type: 'text', default: 'admin-only' })
  roomCreationMode!: 'admin-only' | 'all-users';

  @Column({ type: 'boolean', default: false })
  betaFeaturesEnabled!: boolean;

  /**
   * 禁用服务器端 DASH 流模式。
   * - true：服务器端 B站 解析强制使用 MP4 模式（preferMp4），不再返回 DASH 流
   * - false：正常 DASH/MP4 自动选择
   * 注意：仅影响服务器端解析，不影响 CLI 代理的 DASH 模式
   */
  @Column({ type: 'boolean', default: true })
  dashDisabled!: boolean;

  /**
   * CDN 加速开关。
   * - true：更新检测和下载走 CDN 代理
   * - false：直连 GitHub
   */
  @Column({ type: 'boolean', default: false })
  cdnAccelerate!: boolean;

  /**
   * 内嵌字幕功能开关（已废弃，仅保留数据库列避免迁移）。
   * 内嵌字幕提取已全部前端化（浏览器端 MKV demux 流式提取），
   * 中转与直链均可用，不再需要服务器开关控制。
   */
  @Column({ type: 'boolean', default: true })
  embeddedSubtitleEnabled!: boolean;

  /**
   * 浏览器播放引擎（playsvideo）全局开关。
   * - true：MKV/AVI/TS 等容器或 DTS/AC3/FLAC 等音轨由浏览器端
   *   playsvideo 引擎重封装/转码播放（默认，兼容性最佳）
   * - false：全部走原生直连播放，不兼容的编码将无声或无法播放
   * （需影片级开关同时开启才启用，两级任一关闭即直推）
   */
  @Column({ type: 'boolean', default: true })
  playsvideoEnabled!: boolean;

  /**
   * CDN 代理地址（含协议前缀），如 https://gh-proxy.com。
   * 仅在 cdnAccelerate 为 true 时生效，对所有 GitHub 请求（api.github.com、
   * github.com、objects.githubusercontent.com）统一使用前缀代理方式。
   */
  @Column({ type: 'text', default: 'https://gh-proxy.com' })
  cdnProxyUrl!: string;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
