import { Router } from 'express';
import { IsNull } from 'typeorm';
import { AppDataSource } from '../data-source';
import { User, type UserRole } from '../entities/User';
import { Room } from '../entities/Room';
import { Session } from '../entities/Session';
import { SystemSettings } from '../entities/SystemSettings';
import { getSystemSettings, deleteRoomAndRelations } from '../index';
import { clearAnimeProvidersCache } from '../services/anime';
import { clearCache as clearKazumiCache } from '../services/kazumi';
import { clearCache as clearAniSubsCache } from '../services/anisubs';
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
  if (req.user?.role !== 'root' && req.user?.role !== 'admin') {
    res.status(403).json({ success: false, message: '无权限：仅管理员可操作' });
    return;
  }
  next();
}

function rootOnly(
  req: AuthenticatedRequest,
  res: import('express').Response,
  next: import('express').NextFunction,
) {
  if (req.user?.role !== 'root') {
    res.status(403).json({ success: false, message: '无权限：仅 root 可操作' });
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
        select: ['id', 'username', 'role', 'status', 'createdAt', 'updatedAt'],
      });
      res.json({
        success: true,
        users: users.map((u) => ({
          id: u.id,
          username: u.username,
          role: u.role,
          status: u.status,
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

/** 修改用户角色（root 可操作，禁止修改 root 本身） */
router.patch(
  '/users/:id/role',
  rootOnly,
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
      const allowedRoles: UserRole[] = ['admin', 'user'];
      if (!allowedRoles.includes(role)) {
        res.status(400).json({ success: false, message: '角色必须是 admin / user' });
        return;
      }

      const userRepo = userRepository();
      const user = await userRepo.findOneBy({ id });
      if (!user) {
        res.status(404).json({ success: false, message: '用户不存在' });
        return;
      }

      // root 身份只能属于用户名 root，且不能被修改
      if (user.role === 'root' || user.username === 'root') {
        res.status(400).json({ success: false, message: '不能修改 root 账户' });
        return;
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

/** 审核通过用户（将 pending guest 提升为 user） */
router.post(
  '/users/:id/approve',
  rootOnly,
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
      if (user.role === 'root' || user.username === 'root') {
        res.status(400).json({ success: false, message: '不能修改 root 账户' });
        return;
      }
      user.status = 'active';
      if (user.role === 'guest') {
        user.role = 'user';
      }
      await userRepo.save(user);
      res.json({ success: true, user: { id: user.id, username: user.username, role: user.role, status: user.status } });
    } catch (err) {
      console.error('admin approve user error:', err);
      res.status(500).json({ success: false, message: '审核用户失败' });
    }
  },
);

/** 删除用户 */
router.delete(
  '/users/:id',
  rootOnly,
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

      if (user.role === 'root' || user.username === 'root') {
        res.status(400).json({ success: false, message: '不能删除 root 账户' });
        return;
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
            ownerUserId: room.ownerUserId,
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

/** 强制关闭房间（root 可删除任意房间；admin 只能删除自己创建的房间） */
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

      if (
        req.user?.role !== 'root' &&
        !(req.user?.role === 'admin' && room.ownerUserId === req.user?.userId)
      ) {
        res.status(403).json({ success: false, message: '无权限：仅 root 或房间创建者可关闭该房间' });
        return;
      }

      await deleteRoomAndRelations(roomId);
      res.json({ success: true });
    } catch (err) {
      console.error('admin close room error:', err);
      res.status(500).json({ success: false, message: '关闭房间失败' });
    }
  },
);

/** 批量删除房间（仅 root） */
router.post(
  '/rooms/batch-delete',
  rootOnly,
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

/** 删除所有房间（仅 root） */
router.post(
  '/rooms/delete-all',
  rootOnly,
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

/** 一键清理当前无人使用的房间（root 可全部清理；admin 只能清理自己创建的房间） */
router.post(
  '/rooms/cleanup-unused',
  async (
    req: AuthenticatedRequest,
    res: import('express').Response,
  ): Promise<void> => {
    try {
      const roomRepo = roomRepository();
      const sessionRepo = sessionRepository();
      const rooms = await roomRepo.find({ where: { status: 'active' } });

      let count = 0;
      for (const room of rooms) {
        const isOwner = room.ownerUserId === req.user?.userId;
        if (req.user?.role !== 'root' && !(req.user?.role === 'admin' && isOwner)) {
          continue;
        }
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
        clearKazumiCache();
        clearAniSubsCache();
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
