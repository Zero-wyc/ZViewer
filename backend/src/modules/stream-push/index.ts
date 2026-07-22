/**
 * OBS 推流模式模块（stream-push）。
 *
 * 分离式架构：
 * - nms.service.ts — NMS 生命周期管理（启动/停止/推流校验/状态广播）
 * - stream-push.handler.ts — socket 事件处理（update-share-method / 查询可用性）
 * - router.ts — REST 路由（OBS 配置下载）
 * - dto/stream-push.dto.ts — 类型定义
 *
 * 取代旧架构 services/stream-push/ 目录下 handlers.ts + NodeMediaServerService.ts + index.ts。
 */

export { nmsService } from './nms.service';
export { StreamPushHandler } from './stream-push.handler';
export { default as streamPushRouter } from './router';
export { generateStreamKey } from './stream-key.util';
