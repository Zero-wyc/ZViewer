import type { Socket } from 'socket.io';
import { IsNull } from 'typeorm';
import { AppDataSource } from '../../data-source';
import { Session } from '../../entities/Session';

// 检查 socket 是否为指定房间的房主（即活跃的 sharer 会话）
export async function isRoomHost(
  socket: Socket,
  roomId: string,
): Promise<boolean> {
  const sessionRepo = AppDataSource.getRepository(Session);
  const sharer = await sessionRepo.findOneBy({
    socketId: socket.id,
    roomId,
    role: 'sharer',
    endedAt: IsNull(),
  });
  return !!sharer;
}

// 检查 socket 是否为指定房间的分享端（语义与 isRoomHost 等价）
export async function isSharer(
  socket: Socket,
  roomId: string,
): Promise<boolean> {
  return isRoomHost(socket, roomId);
}

// 根据 socketId 获取该 socket 对应的活跃 sharer 会话（跨房间查询）
// 用于需要知道房主所在房间的场景（如 approve-join、update-room-mode 等）
export async function getSharerBySocketId(
  socketId: string,
): Promise<Session | null> {
  const sessionRepo = AppDataSource.getRepository(Session);
  return sessionRepo.findOneBy({
    socketId,
    role: 'sharer',
    endedAt: IsNull(),
  });
}
