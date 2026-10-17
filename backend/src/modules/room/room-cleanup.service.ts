import { LessThan } from 'typeorm';
import type { Server as SocketIOServer } from 'socket.io';
import { AppDataSource } from '../../data-source';
import { Room } from '../../entities/Room';
import { getSystemSettings } from '../../services/system-settings';
import { deleteRoomAndRelations } from './room-removal.service';

/**
 * 房间清理定时任务（从根 index.ts 抽出）。
 *
 * 职责：按系统设置 `autoDeleteInactiveRooms` 周期性删除长期无人访问的房间。
 * 与 HTTP / socket 装配无关，因此从入口文件移出，避免启动文件承载业务逻辑。
 */

/** 清理超过阈值未访问的活跃房间；设置关闭或失败时静默跳过 */
export async function cleanupInactiveRooms(
  io: SocketIOServer,
): Promise<void> {
  try {
    const settings = await getSystemSettings();
    if (!settings.autoDeleteInactiveRooms) {
      console.log('Auto-delete inactive rooms is disabled, skipping cleanup');
      return;
    }

    const threshold = new Date(
      Date.now() - settings.autoDeleteAfterHours * 60 * 60 * 1000,
    );
    const roomRepo = AppDataSource.getRepository(Room);
    const rooms = await roomRepo.find({
      where: { status: 'active', lastAccessedAt: LessThan(threshold) },
    });

    for (const room of rooms) {
      await deleteRoomAndRelations(room.roomId, io);
    }

    console.log(`Cleaned up ${rooms.length} inactive rooms`);
  } catch (err) {
    console.error('cleanupInactiveRooms error:', err);
  }
}

/** 启动周期性清理（每小时一次 + 启动即跑一轮） */
export function startRoomCleanupScheduler(io: SocketIOServer): void {
  setInterval(() => {
    void cleanupInactiveRooms(io);
  }, 60 * 60 * 1000);
  void cleanupInactiveRooms(io);
}
