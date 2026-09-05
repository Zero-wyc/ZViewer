import { Router } from 'express';
import { IsNull, In } from 'typeorm';
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
  invalidateUserTokens,
  AuthenticatedRequest,
} from '../middleware/auth';
import { writeAuditLog } from '../services/audit';

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
        select: ['id', 'username', 'role', 'status', 'avatar', 'createdAt', 'updatedAt'],
      });
      res.json({
        success: true,
        users: users.map((u) => ({
          id: u.id,
          username: u.username,
          role: u.role,
          status: u.status,
          avatar: u.avatar,
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
      writeAuditLog({
        actorUserId: req.user!.userId,
        actorUsername: req.user!.username,
        actorRole: req.user!.role,
        action: 'role_changed',
        target: `user:${user.id} (${user.username})`,
        ip: req.ip,
        detail: `new role: ${role}`,
      });
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
      writeAuditLog({
        actorUserId: req.user!.userId,
        actorUsername: req.user!.username,
        actorRole: req.user!.role,
        action: 'user_approved',
        target: `user:${user.id} (${user.username})`,
        ip: req.ip,
      });
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
      // V4：删除用户后立即使其所有 token 失效——JWT 无状态，不主动吊销的话
      // 被删用户的 access token 在过期前（最长 1h）仍可访问认证 API。
      // User 行已删除，invalidateUserTokens 的 update 不影响任何行，
      // 但内存缓存会被污染为当前时间 → 认证中间件按 iat < invalidBefore 拒绝。
      // 这里直接写缓存（userId → now）确保拒绝生效。
      await invalidateUserTokens(user.id);
      writeAuditLog({
        actorUserId: req.user!.userId,
        actorUsername: req.user!.username,
        actorRole: req.user!.role,
        action: 'user_deleted',
        target: `user:${user.id} (${user.username})`,
        ip: req.ip,
      });
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

      // 批量查询观众数和 sharer 在线状态（消除 N+1）
      const roomIds = rooms.map((r) => r.roomId);
      const [allViewers, allSharers] = await Promise.all([
        sessionRepo.find({
          where: { roomId: In(roomIds), role: 'viewer', endedAt: IsNull() },
          select: ['roomId'],
        }),
        sessionRepo.find({
          where: { roomId: In(roomIds), role: 'sharer', endedAt: IsNull() },
          select: ['roomId'],
        }),
      ]);
      const viewerCountMap = new Map<string, number>();
      for (const v of allViewers) {
        viewerCountMap.set(v.roomId, (viewerCountMap.get(v.roomId) || 0) + 1);
      }
      const sharerSet = new Set(allSharers.map((s) => s.roomId));

      const result = rooms.map((room) => ({
              id: room.id,
              roomId: room.roomId,
              name: room.name,
              status: room.status,
              requireApproval: room.requireApproval,
              maxViewers: room.maxViewers,
              hasPassword: !!room.password,
              viewerCount: viewerCountMap.get(room.roomId) ?? 0,
              sharerOnline: sharerSet.has(room.roomId),
              ownerUserId: room.ownerUserId,
              lastAccessedAt: room.lastAccessedAt.toISOString(),
              createdAt: room.createdAt.toISOString(),
              updatedAt: room.updatedAt.toISOString(),
            }));

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
          writeAuditLog({
            actorUserId: req.user!.userId,
            actorUsername: req.user!.username,
            actorRole: req.user!.role,
            action: 'room_deleted',
            target: `room:${roomId}`,
            ip: req.ip,
          });
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
          registrationMode: settings.registrationMode,
          roomCreationMode: settings.roomCreationMode,
          betaFeaturesEnabled: settings.betaFeaturesEnabled,
          dashDisabled: settings.dashDisabled,
          cdnAccelerate: settings.cdnAccelerate,
          cdnProxyUrl: settings.cdnProxyUrl,
          playsvideoEnabled: settings.playsvideoEnabled,
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
      const { autoDeleteInactiveRooms, autoDeleteAfterHours, dataSourceConfig, registrationMode, roomCreationMode, betaFeaturesEnabled, dashDisabled, cdnAccelerate, cdnProxyUrl, playsvideoEnabled } = req.body;

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
        dataSourceConfig !== null &&
        (typeof dataSourceConfig !== 'object' || Array.isArray(dataSourceConfig))
      ) {
        res.status(400).json({
          success: false,
          message: 'dataSourceConfig 必须是对象或 null',
        });
        return;
      }
      const allowedModes = ['open', 'approval', 'closed'];
      if (registrationMode !== undefined && !allowedModes.includes(registrationMode)) {
        res.status(400).json({
          success: false,
          message: 'registrationMode 必须是 open / approval / closed 之一',
        });
        return;
      }
      const allowedCreationModes = ['admin-only', 'all-users'];
      if (roomCreationMode !== undefined && !allowedCreationModes.includes(roomCreationMode)) {
        res.status(400).json({
          success: false,
          message: 'roomCreationMode 必须是 admin-only / all-users 之一',
        });
        return;
      }
      if (betaFeaturesEnabled !== undefined && typeof betaFeaturesEnabled !== 'boolean') {
        res.status(400).json({
          success: false,
          message: 'betaFeaturesEnabled 必须是布尔值',
        });
        return;
      }
      if (dashDisabled !== undefined && typeof dashDisabled !== 'boolean') {
        res.status(400).json({
          success: false,
          message: 'dashDisabled 必须是布尔值',
        });
        return;
      }
      if (cdnAccelerate !== undefined && typeof cdnAccelerate !== 'boolean') {
        res.status(400).json({
          success: false,
          message: 'cdnAccelerate 必须是布尔值',
        });
        return;
      }
      if (playsvideoEnabled !== undefined && typeof playsvideoEnabled !== 'boolean') {
        res.status(400).json({
          success: false,
          message: 'playsvideoEnabled 必须是布尔值',
        });
        return;
      }
      if (cdnProxyUrl !== undefined && typeof cdnProxyUrl !== 'string') {
        res.status(400).json({
          success: false,
          message: 'cdnProxyUrl 必须是字符串',
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
      if (registrationMode !== undefined) {
        settings.registrationMode = registrationMode as 'open' | 'approval' | 'closed';
      }
      if (roomCreationMode !== undefined) {
        settings.roomCreationMode = roomCreationMode as 'admin-only' | 'all-users';
      }
      if (betaFeaturesEnabled !== undefined) {
        settings.betaFeaturesEnabled = betaFeaturesEnabled;
      }
      if (dashDisabled !== undefined) {
        settings.dashDisabled = dashDisabled;
      }
      if (cdnAccelerate !== undefined) {
        settings.cdnAccelerate = cdnAccelerate;
      }
      if (playsvideoEnabled !== undefined) {
        settings.playsvideoEnabled = playsvideoEnabled;
      }
      if (cdnProxyUrl !== undefined) {
        settings.cdnProxyUrl = cdnProxyUrl.trim();
      }
      await settingsRepo.save(settings);

      res.json({
        success: true,
        settings: {
          autoDeleteInactiveRooms: settings.autoDeleteInactiveRooms,
          autoDeleteAfterHours: settings.autoDeleteAfterHours,
          dataSourceConfig: settings.dataSourceConfig,
          registrationMode: settings.registrationMode,
          roomCreationMode: settings.roomCreationMode,
          betaFeaturesEnabled: settings.betaFeaturesEnabled,
          dashDisabled: settings.dashDisabled,
          cdnAccelerate: settings.cdnAccelerate,
          cdnProxyUrl: settings.cdnProxyUrl,
          playsvideoEnabled: settings.playsvideoEnabled,
        },
      });
    } catch (err) {
      console.error('admin update settings error:', err);
      res.status(500).json({ success: false, message: '保存设置失败' });
    }
  },
);

export default router;
