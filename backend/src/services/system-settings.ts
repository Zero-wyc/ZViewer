/**
 * 系统设置服务。
 *
 * 独立模块，避免在 room-lifecycle.handler / anime / kazumi / anisubs 等子模块中
 * 重复实现 getSystemSettings 默认初始化逻辑，同时打破从根 index.ts 导入会引入的
 * 循环依赖（index.ts 导入子模块，子模块又需要 getSystemSettings）。
 *
 * index.ts 通过 re-export 保持向后兼容（`import { getSystemSettings } from './index'`）。
 */
import { AppDataSource } from '../data-source';
import { SystemSettings } from '../entities/SystemSettings';

const DEFAULT_SETTINGS: Partial<SystemSettings> = {
  autoDeleteInactiveRooms: true,
  autoDeleteAfterHours: 24,
  registrationMode: 'approval',
  roomCreationMode: 'admin-only',
  betaFeaturesEnabled: false,
  dashDisabled: true,
  cdnAccelerate: false,
  cdnProxyUrl: 'https://gh-proxy.com',
  embeddedSubtitleEnabled: true,
};

/**
 * 获取系统设置单例。不存在时按默认值创建并持久化。
 *
 * 注意：新增 SystemSettings 字段时，DEFAULT_SETTINGS 与 entities/SystemSettings.ts 的
 * @Column default 需同步更新，否则旧库升级后字段可能为 null。
 */
export async function getSystemSettings(): Promise<SystemSettings> {
  const settingsRepo = AppDataSource.getRepository(SystemSettings);
  let settings = await settingsRepo.findOne({ where: {} });
  if (!settings) {
    settings = settingsRepo.create(DEFAULT_SETTINGS);
    await settingsRepo.save(settings);
  }
  return settings;
}
