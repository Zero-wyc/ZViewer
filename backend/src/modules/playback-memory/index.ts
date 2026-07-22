/**
 * 播放记忆模块公共 API。
 *
 * 模块结构（分离式架构）：
 * ```
 * playback-memory/
 * ├── playback-memory.service.ts       状态管理 + 时间推算（内存缓存 + DB 持久化）
 * ├── playback-broadcaster.service.ts  服务器定时广播（房主断开期间接管）
 * ├── playback-memory.handler.ts       Socket 事件处理器
 * └── index.ts                          barrel export
 * ```
 *
 * 设计目标：
 * - 播放进度由服务器端持久化存储
 * - 房主刷新/退出后视频继续播放（服务器推算进度并广播）
 * - 观众可继续观看，不受房主断开影响
 */
export { playbackMemoryService, PlaybackMemoryService } from './playback-memory.service';
export {
  playbackBroadcasterService,
  PlaybackBroadcasterService,
} from './playback-broadcaster.service';
export { PlaybackMemoryHandler } from './playback-memory.handler';
