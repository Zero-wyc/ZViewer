/**
 * OpenList 路由层
 *
 * OpenList 通过 WebDAV 协议访问（端点默认 `/dav`），复用 `services/webdav.ts` 的客户端能力。
 * 路由结构与 `routes/webdav.ts` 对齐，仅 type 区分为 'openlist'。
 */
import { Router, Request, Response } from 'express';
import { AppDataSource } from '../data-source';
import { UserMount } from '../entities/UserMount';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import {
  statWebDAVFile,
  createWebDAVReadStreamWithRange,
  listWebDAVDirectoryCached,
  listWebDAVDirectory,
  WebDAVError,
  type WebDAVConnectionParams,
} from '../services/webdav';
import {
  OpenListError,
  normalizeOpenListServerUrl,
  mountToOpenListParams,
} from '../services/openlist';
import { detectMediaFormat, getContentType } from '../services/mediaFormat';

const router = Router();

const userMountRepository = () => AppDataSource.getRepository(UserMount);

function stripPassword(mount: UserMount): Omit<UserMount, 'password'> {
  const { password: _password, ...rest } = mount;
  return rest;
}

// 从异常中提取错误码
function extractErrorCode(err: unknown): string {
  if (err instanceof WebDAVError || err instanceof OpenListError) return err.code;
  return 'UNREACHABLE';
}

function extractErrorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

router.use(authenticateToken);

// 2.1 挂载 CRUD - GET /mounts
router.get('/mounts', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const mounts = await userMountRepository().find({
      where: { userId, type: 'openlist' },
      order: { createdAt: 'DESC' },
    });

    res.json({
      success: true,
      mounts: mounts.map(stripPassword),
    });
  } catch (err) {
    console.error('[openlist] list mounts error:', err);
    res.status(500).json({ success: false, message: '获取 OpenList 挂载列表失败' });
  }
});

// 2.2 测试连接 - POST /mounts/test（必须在 /:id 之前注册）
router.post('/mounts/test', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { serverUrl, path, username, password } = req.body ?? {};
    if (typeof serverUrl !== 'string' || !serverUrl.trim()) {
      res.status(400).json({ success: false, message: '服务器地址不能为空', code: 'INVALID_URL' });
      return;
    }

    const params: WebDAVConnectionParams = {
      serverUrl: normalizeOpenListServerUrl(serverUrl),
      path: typeof path === 'string' && path.trim() ? path.trim() : '/',
      username: typeof username === 'string' && username ? username : undefined,
      password: typeof password === 'string' && password ? password : undefined,
    };

    try {
      // 尝试列出根目录以验证连通性与凭证
      const entries = await listWebDAVDirectory(params, '/');
      res.json({
        success: true,
        itemCount: entries.length,
      });
    } catch (err) {
      res.status(400).json({
        success: false,
        message: extractErrorMessage(err, 'OpenList 不可访问'),
        code: extractErrorCode(err),
      });
    }
  } catch (err) {
    console.error('[openlist] test mount error:', err);
    res.status(500).json({ success: false, message: '测试 OpenList 连接失败' });
  }
});

// 2.1 挂载 CRUD - POST /mounts
router.post('/mounts', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { name, serverUrl, path, username, password } = req.body ?? {};

    if (typeof name !== 'string' || !name.trim()) {
      res.status(400).json({ success: false, message: '挂载名称不能为空' });
      return;
    }
    if (typeof serverUrl !== 'string' || !serverUrl.trim()) {
      res.status(400).json({ success: false, message: '服务器地址不能为空', code: 'INVALID_URL' });
      return;
    }

    const params: WebDAVConnectionParams = {
      serverUrl: normalizeOpenListServerUrl(serverUrl),
      path: typeof path === 'string' && path.trim() ? path.trim() : '/',
      username: typeof username === 'string' && username ? username : undefined,
      password: typeof password === 'string' && password ? password : undefined,
    };

    // 测试连通性
    try {
      await listWebDAVDirectory(params, '/');
    } catch (err) {
      res.status(400).json({
        success: false,
        message: extractErrorMessage(err, 'OpenList 不可访问'),
        code: extractErrorCode(err),
      });
      return;
    }

    const repo = userMountRepository();
    const mount = repo.create({
      type: 'openlist',
      name: name.trim(),
      serverUrl: params.serverUrl,
      path: params.path,
      username: params.username || null,
      password: params.password || null,
      userId: req.user!.userId,
    } as UserMount);
    await repo.save(mount);

    res.status(201).json({
      success: true,
      mount: stripPassword(mount),
    });
  } catch (err) {
    console.error('[openlist] create mount error:', err);
    res.status(500).json({ success: false, message: '创建 OpenList 挂载失败' });
  }
});

// 2.1 挂载 CRUD - PUT /mounts/:id
router.put('/mounts/:id', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) {
      res.status(400).json({ success: false, message: '挂载 ID 不正确' });
      return;
    }

    const repo = userMountRepository();
    const mount = await repo.findOneBy({
      id,
      userId: req.user!.userId,
      type: 'openlist',
    });
    if (!mount) {
      res.status(404).json({ success: false, message: '挂载不存在或无权限' });
      return;
    }

    const { name, serverUrl, path, username, password } = req.body ?? {};

    if (typeof name !== 'string' || !name.trim()) {
      res.status(400).json({ success: false, message: '挂载名称不能为空' });
      return;
    }
    if (typeof serverUrl !== 'string' || !serverUrl.trim()) {
      res.status(400).json({ success: false, message: '服务器地址不能为空', code: 'INVALID_URL' });
      return;
    }

    const params: WebDAVConnectionParams = {
      serverUrl: normalizeOpenListServerUrl(serverUrl),
      path: typeof path === 'string' && path.trim() ? path.trim() : '/',
      username: typeof username === 'string' && username ? username : undefined,
      password: (typeof password === 'string' && password) || mount.password || undefined,
    };

    // 测试连通性
    try {
      await listWebDAVDirectory(params, '/');
    } catch (err) {
      res.status(400).json({
        success: false,
        message: extractErrorMessage(err, 'OpenList 不可访问'),
        code: extractErrorCode(err),
      });
      return;
    }

    mount.name = name.trim();
    mount.serverUrl = params.serverUrl;
    mount.path = params.path;
    mount.username = params.username || null;
    if (typeof password === 'string') {
      mount.password = password || null;
    }
    await repo.save(mount);

    res.json({
      success: true,
      mount: stripPassword(mount),
    });
  } catch (err) {
    console.error('[openlist] update mount error:', err);
    res.status(500).json({ success: false, message: '更新 OpenList 挂载失败' });
  }
});

// 2.1 挂载 CRUD - DELETE /mounts/:id
router.delete('/mounts/:id', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) {
      res.status(400).json({ success: false, message: '挂载 ID 不正确' });
      return;
    }

    const repo = userMountRepository();
    const mount = await repo.findOneBy({
      id,
      userId: req.user!.userId,
      type: 'openlist',
    });
    if (!mount) {
      res.status(404).json({ success: false, message: '挂载不存在或无权限' });
      return;
    }

    await repo.remove(mount);
    res.json({ success: true });
  } catch (err) {
    console.error('[openlist] delete mount error:', err);
    res.status(500).json({ success: false, message: '删除 OpenList 挂载失败' });
  }
});

// 2.3 浏览 - GET /mounts/:id/browse?path=
router.get('/mounts/:id/browse', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) {
      res.status(400).json({ success: false, message: '挂载 ID 不正确' });
      return;
    }

    const repo = userMountRepository();
    const mount = await repo.findOneBy({
      id,
      userId: req.user!.userId,
      type: 'openlist',
    });
    if (!mount) {
      res.status(404).json({ success: false, message: '挂载不存在或无权限' });
      return;
    }
    if (!mount.serverUrl) {
      res.status(400).json({ success: false, message: '该挂载未配置服务器地址' });
      return;
    }

    const browsePath = typeof req.query.path === 'string' ? req.query.path : undefined;
    const params = mountToOpenListParams(mount);

    try {
      const entries = await listWebDAVDirectoryCached(params, mount.id, browsePath);
      res.json({ success: true, entries });
    } catch (err) {
      res.status(400).json({
        success: false,
        message: extractErrorMessage(err, '浏览 OpenList 失败'),
        code: extractErrorCode(err),
      });
    }
  } catch (err) {
    console.error('[openlist] browse mount error:', err);
    res.status(500).json({ success: false, message: '浏览 OpenList 挂载失败' });
  }
});

// 2.4 解析 - GET /resolve?mountId=&path=
router.get('/resolve', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const mountIdRaw = req.query.mountId;
    const pathRaw = req.query.path;
    if (mountIdRaw === undefined || pathRaw === undefined) {
      res.status(400).json({ success: false, message: '缺少 mountId 或 path 参数', code: 'INVALID_PARAMS' });
      return;
    }

    const mountId = Number(mountIdRaw);
    if (Number.isNaN(mountId)) {
      res.status(400).json({ success: false, message: 'mountId 不正确', code: 'INVALID_PARAMS' });
      return;
    }
    const targetPath = typeof pathRaw === 'string' ? pathRaw : '';
    if (!targetPath.trim()) {
      res.status(400).json({ success: false, message: 'path 不能为空', code: 'INVALID_PARAMS' });
      return;
    }

    const repo = userMountRepository();
    const mount = await repo.findOneBy({
      id: mountId,
      userId: req.user!.userId,
      type: 'openlist',
    });
    if (!mount) {
      res.status(404).json({ success: false, message: '挂载不存在或无权限' });
      return;
    }
    if (!mount.serverUrl) {
      res.status(400).json({ success: false, message: '该挂载未配置服务器地址' });
      return;
    }

    const params: WebDAVConnectionParams = {
      serverUrl: normalizeOpenListServerUrl(mount.serverUrl),
      path: targetPath,
      username: mount.username || undefined,
      password: mount.password || undefined,
    };

    try {
      const info = await statWebDAVFile(params);
      const proxyUrl = `${req.protocol}://${req.get('host')}/api/openlist/proxy?mountId=${mountId}&path=${encodeURIComponent(targetPath)}`;
      const format = detectMediaFormat(info.name || targetPath);
      res.json({
        success: true,
        title: info.name,
        videoUrl: proxyUrl,
        format,
        duration: 0,
        size: info.size,
      });
    } catch (err) {
      res.status(400).json({
        success: false,
        message: extractErrorMessage(err, '解析 OpenList 文件失败'),
        code: extractErrorCode(err),
      });
    }
  } catch (err) {
    console.error('[openlist] resolve error:', err);
    res.status(500).json({ success: false, message: '解析 OpenList 文件失败' });
  }
});

// 2.5 代理 - GET /proxy?mountId=&path=
router.get('/proxy', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const mountIdRaw = req.query.mountId;
  const pathRaw = req.query.path;
  if (mountIdRaw === undefined || pathRaw === undefined) {
    res.status(400).json({ success: false, message: '缺少 mountId 或 path 参数' });
    return;
  }

  const mountId = Number(mountIdRaw);
  if (Number.isNaN(mountId)) {
    res.status(400).json({ success: false, message: 'mountId 不正确' });
    return;
  }
  const targetPath = typeof pathRaw === 'string' ? pathRaw : '';
  if (!targetPath.trim()) {
    res.status(400).json({ success: false, message: 'path 不能为空' });
    return;
  }

  try {
    const repo = userMountRepository();
    const mount = await repo.findOneBy({
      id: mountId,
      userId: req.user!.userId,
      type: 'openlist',
    });
    if (!mount) {
      res.status(404).json({ success: false, message: '挂载不存在或无权限' });
      return;
    }
    if (!mount.serverUrl) {
      res.status(400).json({ success: false, message: '该挂载未配置服务器地址' });
      return;
    }

    const params: WebDAVConnectionParams = {
      serverUrl: normalizeOpenListServerUrl(mount.serverUrl),
      path: targetPath,
      username: mount.username || undefined,
      password: mount.password || undefined,
    };

    const rangeHeader = req.headers.range;

    let stream: import('node:stream').Readable;
    let fileSize: number;
    let start: number;
    let end: number;
    try {
      const result = await createWebDAVReadStreamWithRange(params, rangeHeader);
      stream = result.stream;
      fileSize = result.fileSize;
      start = result.start;
      end = result.end;
    } catch (err) {
      const code = extractErrorCode(err);
      const status = code === 'AUTH_FAILED' ? 401 : code === 'NOT_FOUND' ? 404 : 400;
      res.status(status).json({
        success: false,
        message: extractErrorMessage(err, '打开 OpenList 流失败'),
        code,
      });
      return;
    }

    // CORS 头
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Range');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length');

    res.setHeader('Content-Type', getContentType(detectMediaFormat(targetPath)));
    res.setHeader('Accept-Ranges', 'bytes');
    const contentLength = end - start + 1;
    res.setHeader('Content-Length', contentLength.toString());

    if (rangeHeader) {
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
    } else {
      res.status(200);
    }

    stream.on('error', (err) => {
      console.error('[openlist] proxy stream error:', err);
      if (!res.headersSent) {
        res.status(502).json({
          success: false,
          message: 'OpenList 代理流错误',
          code: 'UNREACHABLE',
        });
      } else {
        res.destroy();
      }
    });
    stream.pipe(res);
  } catch (err) {
    console.error('[openlist] proxy error:', err);
    if (!res.headersSent) {
      res.status(502).json({
        success: false,
        message: extractErrorMessage(err, '代理 OpenList 媒体失败'),
        code: extractErrorCode(err),
      });
    } else {
      res.destroy();
    }
  }
});

export default router;
