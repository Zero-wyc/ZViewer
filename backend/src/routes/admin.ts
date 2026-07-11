import { Router } from 'express';
import { IsNull } from 'typeorm';
import { AppDataSource } from '../data-source';
import { User } from '../entities/User';
import { Room } from '../entities/Room';
import { Session } from '../entities/Session';
import { SystemSettings } from '../entities/SystemSettings';
import { getSystemSettings, deleteRoomAndRelations } from '../index';
import { clearAnimeProvidersCache } from '../services/anime';
import {
  authenticateToken,
  AuthenticatedRequest,
} from '../middleware/auth';

const router = Router();

function adminOnly(
  req: AuthenticatedRequest,
  res: import('express').Response,
  next: import('express').NextFunction,
) {
  if (req.user?.role !== 'admin') {
    res.status(403).json({ success: false, message: '无权限：仅管理员可操作' });
    return;
  }
  next();
}

router.use(authenticateToken, adminOnly);

const userRepository = () => AppDataSource.getRepository(User);
const roomRepository = () => AppDataSource.getRepository(Room);
const sessionRepository = () => AppDataSource.getRepository(Session);

/** 获取用户列表 */
router.get(
  '/users',
  async (
    _req: AuthenticatedRequest,
    res: import('express').Response,
  ): Promise<void> => {
    try {
      const users = await userRepository().find({
        order: { createdAt: 'DESC' },
        select: ['id', 'username', 'role', 'createdAt', 'updatedAt'],
      });
      res.json({
        success: true,
        users: users.map((u) => ({
          id: u.id,
          username: u.username,
          role: u.role,
          createdAt: u.createdAt.toISOString(),
          updatedAt: u.updatedAt.toISOString(),
        })),
      });
    } catch (err) {
      console.error('admin users error:', err);
      res.status(500).json({ success: false, message: '获取用户列表失败' });
    }
  },
);

/** 修改用户角色 */
router.patch(
  '/users/:id/role',
  async (
    req: AuthenticatedRequest,
    res: import('express').Response,
  ): Promise<void> => {
    try {
      const id = Number(req.params.id);
      const { role } = req.body;
      if (Number.isNaN(id)) {
        res.status(400).json({ success: false, message: '用户 ID 不正确' });
        return;
      }
      if (role !== 'admin' && role !== 'user') {
        res.status(400).json({ success: false, message: '角色必须是 admin 或 user' });
        return;
      }

      const userRepo = userRepository();
      const user = await userRepo.findOneBy({ id });
      if (!user) {
        res.status(404).json({ success: false, message: '用户不存在' });
        return;
      }

      // 禁止修改最后一个管理员为普通用户
      if (user.role === 'admin' && role === 'user') {
        const adminCount = await userRepo.count({ where: { role: 'admin' } });
        if (adminCount <= 1) {
          res.status(400).json({ success: false, message: '不能降级唯一的管理员' });
          return;
        }
      }

      user.role = role;
      await userRepo.save(user);
      res.json({ success: true, user: { id: user.id, username: user.username, role: user.role } });
    } catch (err) {
      console.error('admin update role error:', err);
      res.status(500).json({ success: false, message: '修改用户角色失败' });
    }
  },
);

/** 删除用户 */
router.delete(
  '/users/:id',
  async (
    req: AuthenticatedRequest,
    res: import('express').Response,
  ): Promise<void> => {
    try {
      const id = Number(req.params.id);
      if (Number.isNaN(id)) {
        res.status(400).json({ success: false, message: '用户 ID 不正确' });
        return;
      }

      const userRepo = userRepository();
      const user = await userRepo.findOneBy({ id });
      if (!user) {
        res.status(404).json({ success: false, message: '用户不存在' });
        return;
      }

      if (user.role === 'admin') {
        const adminCount = await userRepo.count({ where: { role: 'admin' } });
        if (adminCount <= 1) {
          res.status(400).json({ success: false, message: '不能删除唯一的管理员' });
          return;
        }
      }

      await userRepo.remove(user);
      res.json({ success: true });
    } catch (err) {
      console.error('admin delete user error:', err);
      res.status(500).json({ success: false, message: '删除用户失败' });
    }
  },
);

/** 获取房间列表 */
router.get(
  '/rooms',
  async (
    _req: AuthenticatedRequest,
    res: import('express').Response,
  ): Promise<void> => {
    try {
      const roomRepo = roomRepository();
      const sessionRepo = sessionRepository();
      const rooms = await roomRepo.find({
        order: { createdAt: 'DESC' },
      });

      const result = await Promise.all(
        rooms.map(async (room) => {
          const viewerCount = await sessionRepo.count({
            where: { roomId: room.roomId, role: 'viewer', endedAt: IsNull() },
          });
          const sharer = await sessionRepo.findOneBy({
            roomId: room.roomId,
            role: 'sharer',
            endedAt: IsNull(),
          });
          return {
            id: room.id,
            roomId: room.roomId,
            name: room.name,
            status: room.status,
            requireApproval: room.requireApproval,
            maxViewers: room.maxViewers,
            hasPassword: !!room.password,
            viewerCount,
            sharerOnline: !!sharer,
            lastAccessedAt: room.lastAccessedAt.toISOString(),
            createdAt: room.createdAt.toISOString(),
            updatedAt: room.updatedAt.toISOString(),
          };
        }),
      );

      res.json({ success: true, rooms: result });
    } catch (err) {
      console.error('admin rooms error:', err);
      res.status(500).json({ success: false, message: '获取房间列表失败' });
    }
  },
);

/** 强制关闭房间 */
router.delete(
  '/rooms/:roomId',
  async (
    req: AuthenticatedRequest,
    res: import('express').Response,
  ): Promise<void> => {
    try {
      const rawRoomId = req.params.roomId;
      const roomId = Array.isArray(rawRoomId) ? rawRoomId[0] : rawRoomId;
      if (!roomId) {
        res.status(400).json({ success: false, message: '房间号不正确' });
        return;
      }

      const roomRepo = roomRepository();
      const room = await roomRepo.findOneBy({ roomId });
      if (!room) {
        res.status(404).json({ success: false, message: '房间不存在' });
        return;
      }

      await roomRepo.update({ roomId }, { status: 'closed' });
      await sessionRepository().update(
        { roomId, endedAt: IsNull() },
        { endedAt: new Date() },
      );

      res.json({ success: true });
    } catch (err) {
      console.error('admin close room error:', err);
      res.status(500).json({ success: false, message: '关闭房间失败' });
    }
  },
);

/** 批量删除房间 */
router.post(
  '/rooms/batch-delete',
  async (
    req: AuthenticatedRequest,
    res: import('express').Response,
  ): Promise<void> => {
    try {
      const { roomIds } = req.body;
      if (!Array.isArray(roomIds) || roomIds.length === 0) {
        res.status(400).json({
          success: false,
          message: 'roomIds 必须是非空数组',
        });
        return;
      }

      let count = 0;
      for (const roomId of roomIds) {
        if (typeof roomId !== 'string' || !roomId) continue;
        try {
          await deleteRoomAndRelations(roomId);
          count++;
        } catch (err) {
          console.error(`admin batch delete room error: ${roomId}`, err);
        }
      }

      res.json({ success: true, count });
    } catch (err) {
      console.error('admin batch delete rooms error:', err);
      res.status(500).json({ success: false, message: '批量删除房间失败' });
    }
  },
);

/** 删除所有房间 */
router.post(
  '/rooms/delete-all',
  async (
    _req: AuthenticatedRequest,
    res: import('express').Response,
  ): Promise<void> => {
    try {
      const roomRepo = roomRepository();
      const rooms = await roomRepo.find();

      let count = 0;
      for (const room of rooms) {
        try {
          await deleteRoomAndRelations(room.roomId);
          count++;
        } catch (err) {
          console.error(`admin delete all rooms error: ${room.roomId}`, err);
        }
      }

      res.json({ success: true, count });
    } catch (err) {
      console.error('admin delete all rooms error:', err);
      res.status(500).json({ success: false, message: '删除所有房间失败' });
    }
  },
);

/** 一键清理当前无人使用的房间 */
router.post(
  '/rooms/cleanup-unused',
  async (
    _req: AuthenticatedRequest,
    res: import('express').Response,
  ): Promise<void> => {
    try {
      const roomRepo = roomRepository();
      const sessionRepo = sessionRepository();
      const rooms = await roomRepo.find({ where: { status: 'active' } });

      let count = 0;
      for (const room of rooms) {
        const activeSessions = await sessionRepo.count({
          where: [
            { roomId: room.roomId, role: 'sharer', endedAt: IsNull() },
            { roomId: room.roomId, role: 'viewer', endedAt: IsNull() },
          ],
        });
        if (activeSessions === 0) {
          await deleteRoomAndRelations(room.roomId);
          count++;
        }
      }

      res.json({ success: true, count });
    } catch (err) {
      console.error('admin cleanup unused rooms error:', err);
      res.status(500).json({ success: false, message: '清理房间失败' });
    }
  },
);

/** 获取基础设置 */
router.get(
  '/settings',
  async (
    _req: AuthenticatedRequest,
    res: import('express').Response,
  ): Promise<void> => {
    try {
      const settings = await getSystemSettings();
      res.json({
        success: true,
        settings: {
          autoDeleteInactiveRooms: settings.autoDeleteInactiveRooms,
          autoDeleteAfterHours: settings.autoDeleteAfterHours,
          dataSourceConfig: settings.dataSourceConfig,
        },
      });
    } catch (err) {
      console.error('admin get settings error:', err);
      res.status(500).json({ success: false, message: '获取设置失败' });
    }
  },
);

/** 保存基础设置 */
router.put(
  '/settings',
  async (
    req: AuthenticatedRequest,
    res: import('express').Response,
  ): Promise<void> => {
    try {
      const { autoDeleteInactiveRooms, autoDeleteAfterHours, dataSourceConfig } = req.body;

      if (typeof autoDeleteInactiveRooms !== 'boolean') {
        res.status(400).json({
          success: false,
          message: 'autoDeleteInactiveRooms 必须是布尔值',
        });
        return;
      }
      if (
        !Number.isInteger(autoDeleteAfterHours) ||
        autoDeleteAfterHours < 1
      ) {
        res.status(400).json({
          success: false,
          message: 'autoDeleteAfterHours 必须是大于等于 1 的整数',
        });
        return;
      }
      if (
        dataSourceConfig !== undefined &&
        (typeof dataSourceConfig !== 'object' || dataSourceConfig === null || Array.isArray(dataSourceConfig))
      ) {
        res.status(400).json({
          success: false,
          message: 'dataSourceConfig 必须是对象',
        });
        return;
      }

      const settingsRepo = AppDataSource.getRepository(SystemSettings);
      const settings = await getSystemSettings();
      settings.autoDeleteInactiveRooms = autoDeleteInactiveRooms;
      settings.autoDeleteAfterHours = autoDeleteAfterHours;
      if (dataSourceConfig !== undefined) {
        settings.dataSourceConfig = dataSourceConfig as Record<string, unknown>;
        clearAnimeProvidersCache();
      }
      await settingsRepo.save(settings);

      res.json({
        success: true,
        settings: {
          autoDeleteInactiveRooms: settings.autoDeleteInactiveRooms,
          autoDeleteAfterHours: settings.autoDeleteAfterHours,
          dataSourceConfig: settings.dataSourceConfig,
        },
      });
    } catch (err) {
      console.error('admin update settings error:', err);
      res.status(500).json({ success: false, message: '保存设置失败' });
    }
  },
);

export default router;
