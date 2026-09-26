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

  /**
   * 房间可执行动作权限矩阵（管理员在设置页勾选配置）。
   * - key：动作（addMovie 添加影片 / manageMovie 移除与切换影片 /
   *   musicQueue 音乐队列管理 / kickViewer 踢出成员 / muteViewer 禁言成员）
   * - value：观众角色层是否允许（moderator 房管 / admin 系统管理员 /
   *   user 普通用户）。房主（owner）始终允许，root 始终允许。
   * - null / 字段缺省：按兼容默认值（房管+管理员允许、普通用户不允许）
   */
  @Column({ type: 'json', nullable: true })
  roomPermissionMatrix!: Record<
    string,
    { moderator?: boolean; admin?: boolean; user?: boolean }
  > | null;

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

  /**
   * 允许单用户在多个页面同时登录同一房间（仅供测试）。
   * - false（默认）：登录用户重复进入同一房间被拒绝（ALREADY_IN_ROOM），
   *   语音重复加入被新页面顶替
   * - true：同一账号的每个页面作为独立会话进入房间与语音
   *   （语音成员键退化为 user:{userId}#{instanceId}，互不顶替）
   * 仅供测试使用，正式环境不建议开启
   */
  @Column({ type: 'boolean', default: false })
  roomMultiInstanceLogin!: boolean;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
