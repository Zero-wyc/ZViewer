import { Router } from 'express';
import { AppDataSource } from '../data-source';
import { UserMount, MountType } from '../entities/UserMount';
import {
  authenticateToken,
  AuthenticatedRequest,
} from '../middleware/auth';

const router = Router();

const userMountRepository = () => AppDataSource.getRepository(UserMount);

const VALID_TYPES: MountType[] = ['webdav', 'ftp', 'openlist'];

function isValidType(value: unknown): value is MountType {
  return typeof value === 'string' && (VALID_TYPES as string[]).includes(value);
}

function stripPassword(mount: UserMount): Omit<UserMount, 'password'> {
  const { password: _password, ...rest } = mount;
  return rest;
}

function validateMountPayload(body: Record<string, unknown>): {
  valid: false;
  message: string;
} | {
  valid: true;
  data: Partial<UserMount>;
} {
  const { type, name, serverUrl, port, path, username, password, indexUrl, directLink } = body;

  if (!isValidType(type)) {
    return { valid: false, message: '挂载类型必须是 webdav、ftp 或 openlist' };
  }

  if (typeof name !== 'string' || !name.trim()) {
    return { valid: false, message: '挂载名称不能为空' };
  }

  const payload: Partial<UserMount> = {
    type,
    name: name.trim(),
    serverUrl: typeof serverUrl === 'string' && serverUrl.trim() ? serverUrl.trim() : null,
    port: typeof port === 'number' ? port : null,
    path: typeof path === 'string' && path.trim() ? path.trim() : null,
    username: typeof username === 'string' && username.trim() ? username.trim() : null,
    password: typeof password === 'string' && password ? password : null,
    indexUrl: typeof indexUrl === 'string' && indexUrl.trim() ? indexUrl.trim() : null,
    directLink: typeof directLink === 'boolean' ? directLink : false,
  };

  if (type === 'webdav' || type === 'ftp') {
    if (!payload.serverUrl) {
      return { valid: false, message: `${type} 挂载需要服务器地址` };
    }
  }

  if (type === 'openlist') {
    if (!payload.indexUrl) {
      return { valid: false, message: 'OpenList 挂载需要索引 URL' };
    }
  }

  return { valid: true, data: payload };
}

router.use(authenticateToken);

router.get(
  '/',
  async (
    req: AuthenticatedRequest,
    res: import('express').Response,
  ): Promise<void> => {
    try {
      const userId = req.user!.userId;
      const mounts = await userMountRepository().find({
        where: { userId },
        order: { createdAt: 'DESC' },
      });

      res.json({
        success: true,
        mounts: mounts.map((m) => stripPassword(m)),
      });
    } catch (err) {
      console.error('get user mounts error:', err);
      res.status(500).json({ success: false, message: '获取挂载列表失败' });
    }
  },
);

router.post(
  '/',
  async (
    req: AuthenticatedRequest,
    res: import('express').Response,
  ): Promise<void> => {
    try {
      const validation = validateMountPayload(req.body);
      if (!validation.valid) {
        res.status(400).json({ success: false, message: validation.message });
        return;
      }

      const repo = userMountRepository();
      const mount = repo.create({
        ...validation.data,
        userId: req.user!.userId,
      } as UserMount);
      await repo.save(mount);

      res.status(201).json({
        success: true,
        mount: stripPassword(mount),
      });
    } catch (err) {
      console.error('create user mount error:', err);
      res.status(500).json({ success: false, message: '创建挂载失败' });
    }
  },
);

router.put(
  '/:id',
  async (
    req: AuthenticatedRequest,
    res: import('express').Response,
  ): Promise<void> => {
    try {
      const id = Number(req.params.id);
      if (Number.isNaN(id)) {
        res.status(400).json({ success: false, message: '挂载 ID 不正确' });
        return;
      }

      const repo = userMountRepository();
      const mount = await repo.findOneBy({ id, userId: req.user!.userId });
      if (!mount) {
        res.status(404).json({ success: false, message: '挂载不存在或无权限' });
        return;
      }

      const validation = validateMountPayload(req.body);
      if (!validation.valid) {
        res.status(400).json({ success: false, message: validation.message });
        return;
      }

      repo.merge(mount, validation.data);
      await repo.save(mount);

      res.json({
        success: true,
        mount: stripPassword(mount),
      });
    } catch (err) {
      console.error('update user mount error:', err);
      res.status(500).json({ success: false, message: '更新挂载失败' });
    }
  },
);

router.delete(
  '/:id',
  async (
    req: AuthenticatedRequest,
    res: import('express').Response,
  ): Promise<void> => {
    try {
      const id = Number(req.params.id);
      if (Number.isNaN(id)) {
        res.status(400).json({ success: false, message: '挂载 ID 不正确' });
        return;
      }

      const repo = userMountRepository();
      const mount = await repo.findOneBy({ id, userId: req.user!.userId });
      if (!mount) {
        res.status(404).json({ success: false, message: '挂载不存在或无权限' });
        return;
      }

      await repo.remove(mount);
      res.json({ success: true });
    } catch (err) {
      console.error('delete user mount error:', err);
      res.status(500).json({ success: false, message: '删除挂载失败' });
    }
  },
);

export default router;
