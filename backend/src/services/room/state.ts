import { Server as SocketIOServer } from 'socket.io';
import { IsNull } from 'typeorm';
import { AppDataSource } from '../../data-source';
import { Room } from '../../entities/Room';
import { Session } from '../../entities/Session';

// 房间内运行时的影片信息（非持久化，仅存在于内存中）
export interface Movie {
  // id 可以是 number（REST API 添加的数据库主键）或 string（socket add-movie 生成的临时 id）
  id: number | string;
  sourceType: 'bilibili' | 'mp4' | 'webdav' | 'ftp' | 'openlist' | 'smb';
  title: string;
  url: string;
  cid?: number;
  duration?: number;
  videoUrl?: string;
  audioUrl?: string;
  videoCodec?: string;
  audioCodec?: string;
  // 与 services/mediaFormat.ts 的 MediaFormat 对齐，允许 mkv/avi/webm 等容器格式
  format?: string;
  quality?: string;
  createdAt: number;
}

// 房间运行时状态
export interface RoomState {
  movies: Movie[];
  currentMovieId: number | string | null;
  // 房主最近一次广播的播放状态，用于房主刷新/重连后恢复进度（强制暂停）
  playback?: {
    currentTime: number;
    isPlaying: boolean;
    playbackRate: number;
    duration?: number;
    sourceUrl?: string;
    sourceType?: string;
    audioUrl?: string;
    // 与 services/mediaFormat.ts 的 MediaFormat 对齐
    format?: string;
    videoCodec?: string;
    audioCodec?: string;
    cid?: number;
    currentQn?: number;
    // 当前播放的影片 ID，用于房主刷新后匹配是否还是同一部影片
    currentMovieId?: number;
    // 最近一次更新的时间戳，用于计算恢复时的偏移
    updatedAt: number;
  };
}

// 房间运行时状态存储
const roomStates = new Map<string, RoomState>();

// 房主断线后允许的恢复窗口，避免刷新页面直接关闭房间
export const HOST_RECONNECT_GRACE_MS = 10_000;

// 房主重连定时器，key 为 roomId
export const hostReconnectTimers = new Map<string, NodeJS.Timeout>();

// 获取或创建房间运行时状态
export function getRoomState(roomId: string): RoomState {
  if (!roomStates.has(roomId)) {
    roomStates.set(roomId, { movies: [], currentMovieId: null });
  }
  return roomStates.get(roomId)!;
}

// 删除房间运行时状态（用于房间清理）
export function deleteRoomState(roomId: string): void {
  roomStates.delete(roomId);
}

// 更新房主最近一次广播的播放状态（用于房主刷新后恢复进度）
// updatedAt 由本函数自动写入，调用方无需提供
export function setRoomPlayback(
  roomId: string,
  playback: Omit<NonNullable<RoomState['playback']>, 'updatedAt'>,
): void {
  const state = getRoomState(roomId);
  state.playback = { ...playback, updatedAt: Date.now() };
}

// 获取房主播放状态（用于房主重连恢复）
export function getRoomPlayback(roomId: string): RoomState['playback'] {
  return getRoomState(roomId).playback;
}

// 关闭房间并通知房间内所有成员
// - 将房间状态置为 closed
// - 结束所有未结束的 sharer 会话
// - 向房间广播 room-closed 事件
// - 清理房间运行时状态
// - 踢出除房主外的其他 socket
export async function closeRoomAndNotify(
  io: SocketIOServer,
  roomId: string,
  sharerSocketId: string,
): Promise<void> {
  const roomRepo = AppDataSource.getRepository(Room);
  const sessionRepo = AppDataSource.getRepository(Session);

  await roomRepo.update({ roomId }, { status: 'closed' });
  await sessionRepo.update(
    { roomId, role: 'sharer', endedAt: IsNull() },
    { endedAt: new Date() },
  );

  io.to(roomId).emit('room-closed', { roomId });
  deleteRoomState(roomId);

  const sockets = await io.in(roomId).fetchSockets();
  for (const sock of sockets) {
    if (sock.id !== sharerSocketId) {
      sock.leave(roomId);
      sock.disconnect(true);
    }
  }
}
