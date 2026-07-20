import { Router, Request, Response } from 'express';
import { AppDataSource } from '../data-source';
import { UserMount } from '../entities/UserMount';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import {
  listFTPDirectory,
  statFTPFile,
  createFTPReadStream,
  type FTPConnectionParams,
} from '../services/ftp';
import { detectMediaFormat, getContentType } from '../services/mediaFormat';

const router = Router();

const userMountRepository = () => AppDataSource.getRepository(UserMount);

function stripPassword(mount: UserMount): Omit<UserMount, 'password'> {
  const { password: _password, ...rest } = mount;
  return rest;
}

function mountToParams(mount: UserMount): FTPConnectionParams {
  return {
    serverUrl: mount.serverUrl!,
    path: mount.path || '/',
    port: mount.port || undefined,
    username: mount.username || undefined,
    password: mount.password || undefined,
  };
}

function extractErrorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

router.use(authenticateToken);

// 挂载 CRUD - GET /mounts
router.get('/mounts', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const mounts = await userMountRepository().find({
      where: { userId, type: 'ftp' },
      order: { createdAt: 'DESC' },
    });

    res.json({
      success: true,
      mounts: mounts.map(stripPassword),
    });
  } catch (err) {
    console.error('[ftp] list mounts error:', err);
    res.status(500).json({ success: false, message: '获取 FTP 挂载列表失败' });
  }
});

// 测试连接 - POST /mounts/test（必须在 /:id 之前注册）
router.post('/mounts/test', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { serverUrl, port, path, username, password } = req.body ?? {};
    if (typeof serverUrl !== 'string' || !serverUrl.trim()) {
      res.status(400).json({ success: false, message: '服务器地址不能为空' });
      return;
    }

    const portNum = typeof port === 'number' ? port : typeof port === 'string' && port.trim() ? Number(port) : undefined;
    if (portNum !== undefined && (Number.isNaN(portNum) || portNum < 1 || portNum > 65535)) {
      res.status(400).json({ success: false, message: '端口必须在 1-65535 范围内' });
      return;
    }

    const params: FTPConnectionParams = {
      serverUrl: serverUrl.trim(),
      path: typeof path === 'string' && path.trim() ? path.trim() : '/',
      port: portNum,
      username: typeof username === 'string' && username ? username : undefined,
      password: typeof password === 'string' && password ? password : undefined,
    };

    try {
      const entries = await listFTPDirectory(params);
      res.json({
        success: true,
        itemCount: entries.length,
      });
    } catch (err) {
      res.status(400).json({
        success: false,
        message: extractErrorMessage(err, 'FTP 不可访问'),
      });
    }
  } catch (err) {
    console.error('[ftp] test mount error:', err);
    res.status(500).json({ success: false, message: '测试 FTP 连接失败' });
  }
});

// 挂载 CRUD - POST /mounts
router.post('/mounts', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { name, serverUrl, port, path, username, password } = req.body ?? {};

    if (typeof name !== 'string' || !name.trim()) {
      res.status(400).json({ success: false, message: '挂载名称不能为空' });
      return;
    }
    if (typeof serverUrl !== 'string' || !serverUrl.trim()) {
      res.status(400).json({ success: false, message: '服务器地址不能为空' });
      return;
    }

    const portNum = typeof port === 'number' ? port : typeof port === 'string' && port.trim() ? Number(port) : null;
    if (portNum !== null && (Number.isNaN(portNum) || portNum < 1 || portNum > 65535)) {
      res.status(400).json({ success: false, message: '端口必须在 1-65535 范围内' });
      return;
    }

    const params: FTPConnectionParams = {
      serverUrl: serverUrl.trim(),
      path: typeof path === 'string' && path.trim() ? path.trim() : '/',
      port: portNum || undefined,
      username: typeof username === 'string' && username ? username : undefined,
      password: typeof password === 'string' && password ? password : undefined,
    };

    // 测试连通性
    try {
      await listFTPDirectory(params);
    } catch (err) {
      res.status(400).json({
        success: false,
        message: extractErrorMessage(err, 'FTP 不可访问'),
      });
      return;
    }

    const repo = userMountRepository();
    const mount = repo.create({
      type: 'ftp',
      name: name.trim(),
      serverUrl: params.serverUrl,
      port: portNum,
      path: params.path,
      username: params.username || null,
      password: params.password || null,
      directLink: false,
      userId: req.user!.userId,
    } as UserMount);
    await repo.save(mount);

    res.status(201).json({
      success: true,
      mount: stripPassword(mount),
    });
  } catch (err) {
    console.error('[ftp] create mount error:', err);
    res.status(500).json({ success: false, message: '创建 FTP 挂载失败' });
  }
});

// 挂载 CRUD - PUT /mounts/:id
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
      type: 'ftp',
    });
    if (!mount) {
      res.status(404).json({ success: false, message: '挂载不存在或无权限' });
      return;
    }

    const { name, serverUrl, port, path, username, password } = req.body ?? {};

    if (typeof name !== 'string' || !name.trim()) {
      res.status(400).json({ success: false, message: '挂载名称不能为空' });
      return;
    }
    if (typeof serverUrl !== 'string' || !serverUrl.trim()) {
      res.status(400).json({ success: false, message: '服务器地址不能为空' });
      return;
    }

    const portNum = typeof port === 'number' ? port : typeof port === 'string' && port.trim() ? Number(port) : null;
    if (portNum !== null && (Number.isNaN(portNum) || portNum < 1 || portNum > 65535)) {
      res.status(400).json({ success: false, message: '端口必须在 1-65535 范围内' });
      return;
    }

    const params: FTPConnectionParams = {
      serverUrl: serverUrl.trim(),
      path: typeof path === 'string' && path.trim() ? path.trim() : '/',
      port: portNum || undefined,
      username: typeof username === 'string' && username ? username : undefined,
      password: (typeof password === 'string' && password) || mount.password || undefined,
    };

    // 测试连通性
    try {
      await listFTPDirectory(params);
    } catch (err) {
      res.status(400).json({
        success: false,
        message: extractErrorMessage(err, 'FTP 不可访问'),
      });
      return;
    }

    mount.name = name.trim();
    mount.serverUrl = params.serverUrl;
    mount.port = portNum;
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
    console.error('[ftp] update mount error:', err);
    res.status(500).json({ success: false, message: '更新 FTP 挂载失败' });
  }
});

// 挂载 CRUD - DELETE /mounts/:id
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
      type: 'ftp',
    });
    if (!mount) {
      res.status(404).json({ success: false, message: '挂载不存在或无权限' });
      return;
    }

    await repo.remove(mount);
    res.json({ success: true });
  } catch (err) {
    console.error('[ftp] delete mount error:', err);
    res.status(500).json({ success: false, message: '删除 FTP 挂载失败' });
  }
});

// 浏览 - GET /mounts/:id/browse?path=
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
      type: 'ftp',
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
    const params = mountToParams(mount);
    if (browsePath) {
      params.path = browsePath;
    }

    try {
      const entries = await listFTPDirectory(params);
      res.json({ success: true, entries });
    } catch (err) {
      res.status(400).json({
        success: false,
        message: extractErrorMessage(err, '浏览 FTP 失败'),
      });
    }
  } catch (err) {
    console.error('[ftp] browse mount error:', err);
    res.status(500).json({ success: false, message: '浏览 FTP 挂载失败' });
  }
});

// 解析 - GET /resolve?mountId=&path=
router.get('/resolve', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
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

    const repo = userMountRepository();
    const mount = await repo.findOneBy({
      id: mountId,
      userId: req.user!.userId,
      type: 'ftp',
    });
    if (!mount) {
      res.status(404).json({ success: false, message: '挂载不存在或无权限' });
      return;
    }
    if (!mount.serverUrl) {
      res.status(400).json({ success: false, message: '该挂载未配置服务器地址' });
      return;
    }

    const params: FTPConnectionParams = {
      serverUrl: mount.serverUrl,
      path: targetPath,
      port: mount.port || undefined,
      username: mount.username || undefined,
      password: mount.password || undefined,
    };

    try {
      const info = await statFTPFile(params);
      const proxyUrl = `${req.protocol}://${req.get('host')}/api/ftp/proxy?mountId=${mountId}&path=${encodeURIComponent(targetPath)}`;
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
        message: extractErrorMessage(err, '解析 FTP 文件失败'),
      });
    }
  } catch (err) {
    console.error('[ftp] resolve error:', err);
    res.status(500).json({ success: false, message: '解析 FTP 文件失败' });
  }
});

// 代理流 - GET /proxy?mountId=&path=
router.get('/proxy', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
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

    const repo = userMountRepository();
    const mount = await repo.findOneBy({
      id: mountId,
      userId: req.user!.userId,
      type: 'ftp',
    });
    if (!mount) {
      res.status(404).json({ success: false, message: '挂载不存在或无权限' });
      return;
    }
    if (!mount.serverUrl) {
      res.status(400).json({ success: false, message: '该挂载未配置服务器地址' });
      return;
    }

    const params: FTPConnectionParams = {
      serverUrl: mount.serverUrl,
      path: targetPath,
      port: mount.port || undefined,
      username: mount.username || undefined,
      password: mount.password || undefined,
    };

    // 解析 Range 请求（video 元素会发 Range 请求按需拉取片段）
    const rangeHeader = req.headers.range;
    let start = 0;
    let end: number | null = null;
    if (rangeHeader) {
      // 格式：bytes=start-end（end 可省略）
      const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader);
      if (match) {
        start = Number(match[1]);
        if (match[2]) end = Number(match[2]);
      }
    }

    try {
      const info = await statFTPFile(params);
      const fileSize = info.size;
      // end 默认为文件末尾
      const endByte = end === null ? fileSize - 1 : Math.min(end, fileSize - 1);
      const contentLength = endByte - start + 1;

      // CORS 头（与 webdav/openlist proxy 一致，避免 video.src 跨源被 ORB 阻止）
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Authorization, Content-Type, Range',
      );
      res.setHeader(
        'Access-Control-Expose-Headers',
        'Content-Range, Accept-Ranges, Content-Length',
      );

      res.setHeader('Content-Type', getContentType(detectMediaFormat(targetPath)));
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Length', contentLength.toString());

      if (rangeHeader) {
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${endByte}/${fileSize}`);
      } else {
        res.status(200);
      }

      const stream = createFTPReadStream(params, start);
      stream.on('error', (err) => {
        console.error('[ftp] proxy stream error:', err);
        if (!res.headersSent) {
          res.status(500).json({ success: false, message: '流传输失败' });
        } else {
          res.end();
        }
      });
      stream.pipe(res);
    } catch (err) {
      res.status(400).json({
        success: false,
        message: extractErrorMessage(err, '代理 FTP 流失败'),
      });
    }
  } catch (err) {
    console.error('[ftp] proxy error:', err);
    res.status(500).json({ success: false, message: '代理 FTP 流失败' });
  }
});

export default router;
