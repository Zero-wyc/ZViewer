/**
 * 同步播放模块入口。
 *
 * 导出所有同步播放相关的 socket 事件处理器，供 SocketRegistry 统一注册。
 */
export { SyncStateHandler } from './sync-state.handler';
export { SyncControlHandler } from './sync-control.handler';
export { HeartbeatHandler } from './heartbeat.handler';
export { TrackSyncHandler } from './track-sync.handler';
export { SeekApprovalHandler } from './seek-approval.handler';
