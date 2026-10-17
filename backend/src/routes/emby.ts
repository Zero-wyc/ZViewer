/**
 * Emby 路由层
 *
 * 将 Emby 作为独立的媒体源挂载（分离式架构：REST 客户端在 services/emby-client.ts）。
 * 完整路由实现见 emby-like-factory.ts（与 jellyfin.ts 共用工厂），本文件仅传入 Emby 侧参数。
 */
import { createEmbyLikeRouter } from './emby-like-factory';

export default createEmbyLikeRouter({
  mountType: 'emby',
  label: 'Emby',
  apiPrefix: 'emby',
  logTag: 'emby',
  fallbackErrorCode: 'EMBY_ERROR',
});
