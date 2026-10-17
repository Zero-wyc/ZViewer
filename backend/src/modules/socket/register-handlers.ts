import { SocketRegistry } from './event-handler.interface';
import {
  RoomLifecycleHandler,
  RoomSettingsHandler,
  RoomDisconnectHandler,
  RegisterHostHandler,
} from '../room';
import { ViewerJoinHandler, ViewerManagementHandler } from '../viewer';
import { MovieListHandler, PreviewHandler } from '../movie';
import {
  HeartbeatHandler,
  TrackSyncHandler,
  SeekApprovalHandler,
  SubtitleSyncHandler,
} from '../sync-playback';
import { PlaybackMemoryHandler } from '../playback-memory';
import { CommentHandler } from '../comment';
import { CliHandler } from '../cli';
import { StreamPushHandler } from '../stream-push';
import { SignalingHandler, ViewerEventsHandler } from '../webrtc-signaling';
import { MusicSyncHandler } from '../music/MusicSyncHandler';

/**
 * 构建全部 socket 事件处理器注册表（从根 index.ts 抽出）。
 *
 * 统一注册点，消除旧架构中 index.ts 与 room.ts 两个 io.on('connection') 的分裂。
 * 处理器顺序即同一事件被多处理器认领时的优先级，改动需谨慎。
 */
export function createSocketRegistry(): SocketRegistry {
  return new SocketRegistry()
    .add(new RoomLifecycleHandler())
    .add(new RoomSettingsHandler())
    .add(new RoomDisconnectHandler())
    .add(new RegisterHostHandler())
    .add(new ViewerJoinHandler())
    .add(new ViewerManagementHandler())
    .add(new MovieListHandler())
    .add(new PreviewHandler())
    // PlaybackMemoryHandler 取代旧 SyncStateHandler + SyncControlHandler
    // 统一处理 watch-together-state / watch-together-request-state / watch-together-control
    // 并将状态持久化到 DB，支持房主断开后观众继续观看
    .add(new PlaybackMemoryHandler())
    .add(new HeartbeatHandler())
    .add(new TrackSyncHandler())
    .add(new SubtitleSyncHandler())
    .add(new SeekApprovalHandler())
    .add(new CommentHandler())
    .add(new CliHandler())
    .add(new StreamPushHandler())
    // WebRTC 信令 + 观众就绪事件（迁移自 services/screen-sharing/）
    .add(new SignalingHandler())
    .add(new ViewerEventsHandler())
    // 一起听音乐同步（队列 CRUD / 播放状态与心跳转发 / 观众申请制）
    .add(new MusicSyncHandler());
}
