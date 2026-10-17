/**
 * Jellyfin 路由层
 *
 * Jellyfin 是 Emby 开源分支，API 完全兼容（REST 客户端在 services/jellyfin-client.ts，
 * 重导出 emby-client）。完整路由实现见 emby-like-factory.ts（与 emby.ts 共用工厂）。
 */
import { createEmbyLikeRouter } from './emby-like-factory';

export default createEmbyLikeRouter({
  mountType: 'jellyfin',
  label: 'Jellyfin',
  apiPrefix: 'jellyfin',
  logTag: 'jellyfin',
  fallbackErrorCode: 'JELLYFIN_ERROR',
});
