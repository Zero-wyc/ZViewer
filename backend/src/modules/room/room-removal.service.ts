/**
 * 房间级联删除服务。
 *
 * 从根 index.ts 迁入（原位置导致 routes/admin.ts 反向 import 根 index.ts，
 * 形成唯一的真循环依赖）。职责：删除房间及其全部关联数据，
 * 并可选地广播 room-closed 后强制断开房间内 socket。
 */
import type { Server as SocketIOServer } from 'socket.io';
import { IsNull } from 'typeorm';
import { AppDataSource } from '../../data-source';
import { Room } from '../../entities/Room';
import { Session } from '../../entities/Session';
import { Comment } from '../../entities/Comment';
import { Movie as MovieEntity } from '../../entities/Movie';
import { PlaybackState } from '../../entities/PlaybackState';
import { MusicPlaybackState } from '../../entities/MusicPlaybackState';
import { MusicQueueItem } from '../../entities/MusicQueueItem';
import { roomStateService } from './room-state.service';
import { clearMusicSyncState } from '../music/MusicSyncHandler';

export async function deleteRoomAndRelations(
  roomId: string,
  io?: SocketIOServer,
): Promise<void> {
  const roomRepo = AppDataSource.getRepository(Room);
  const sessionRepo = AppDataSource.getRepository(Session);
  const movieRepo = AppDataSource.getRepository(MovieEntity);
  const commentRepo = AppDataSource.getRepository(Comment);
  const playbackStateRepo = AppDataSource.getRepository(PlaybackState);
  const musicPlaybackStateRepo = AppDataSource.getRepository(MusicPlaybackState);
  const musicQueueRepo = AppDataSource.getRepository(MusicQueueItem);

  // 清理运行时状态（通过 RoomStateService 而非直接操作全局 Map）
  roomStateService.delete(roomId);
  // 清理一起听的音乐同步内存状态（队列条目随下方关联数据删除）
  clearMusicSyncState(roomId);

  // 结束所有未结束会话
  await sessionRepo.update(
    { roomId, endedAt: IsNull() },
    { endedAt: new Date() },
  );

  // 删除关联数据
  // 注意删除顺序：PlaybackState / MusicPlaybackState 通过外键引用 Room，
  // 必须在删除 Room 之前清除，
  // 否则 SQLite 会抛 FOREIGN KEY constraint failed（Movie/Comment 无外键约束不敏感）
  await movieRepo.delete({ roomId });
  await commentRepo.delete({ roomId });
  await playbackStateRepo.delete({ roomId });
  await musicPlaybackStateRepo.delete({ roomId });
  await musicQueueRepo.delete({ roomId });

  // 删除房间
  await roomRepo.delete({ roomId });

  // 可选：断开仍在房间内的 socket
  if (io) {
    // 先广播 room-closed：客户端（RoomPage）收到后立即停止本机媒体拉流
    //（视频/音乐），再强制断开 socket。若只断连不广播，客户端会自动重连并
    // 继续播放，浏览器持续向后端请求媒体分片，服务端相应持续代理上游流量
    //（房间已删但流量仍在跑）。
    io.to(roomId).emit('room-closed', { roomId });
    const sockets = await io.in(roomId).fetchSockets();
    for (const sock of sockets) {
      sock.leave(roomId);
      sock.disconnect(true);
    }
  }
}
