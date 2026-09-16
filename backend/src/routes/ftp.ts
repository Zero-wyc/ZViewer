import { stripPassword, extractErrorMessage } from '../modules/shared/mount-utils';
import { Router, Request, Response } from 'express';
import { AppDataSource } from '../data-source';
import { UserMount } from '../entities/UserMount';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import {
  listFTPDirectory,
  statFTPFile,
  statFTPFileCached,
  createFTPReadStream,
  type FTPConnectionParams,
} from '../services/ftp';
import { detectMediaFormat, getContentType } from '../services/mediaFormat';
import {
  resolveUserMount,
  resolveMovieStream,
  parseRangeHeader,
  pipeRangeStream, StreamMovieError } from '../services/proxy';

const router = Router();

const userMountRepository = () => AppDataSource.getRepository(UserMount);

function mountToParams(mount: UserMount): FTPConnectionParams {
  return {
    serverUrl: mount.serverUrl!,
    path: mount.path || '/',
    port: mount.port || undefined,
    username: mount.username || undefined,
    password: mount.password || undefined,
  };
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
      const proxyUrl = `/api/ftp/proxy?mountId=${mountId}&path=${encodeURIComponent(targetPath)}`;
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
    const resolved = await resolveUserMount(req, res, 'ftp');
    if (!resolved) return;
    const { mount, targetPath } = resolved;

    const params: FTPConnectionParams = {
      serverUrl: mount.serverUrl!,
      path: targetPath,
      port: mount.port || undefined,
      username: mount.username || undefined,
      password: mount.password || undefined,
    };

    try {
      const info = await statFTPFileCached(params);
      const fileSize = info.size;

      // 解析 Range 请求（video 元素会发 Range 请求按需拉取片段）
      const rangeHeader = req.headers.range;
      const parsed = parseRangeHeader(rangeHeader, fileSize);
      const start = parsed && parsed !== 'invalid' ? parsed.start : 0;
      const endByte =
        parsed && parsed !== 'invalid' ? parsed.end : fileSize - 1;

      const stream = createFTPReadStream(params, start);
      pipeRangeStream(res, {
        stream,
        contentType: getContentType(detectMediaFormat(targetPath)),
        fileSize,
        start,
        end: endByte,
        ranged: !!rangeHeader,
        logTag: 'ftp',
        errorMessage: '流传输失败',
        softDestroy: true,
      });
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

// 基于影片 ID 的流代理 - GET /stream?movieId=
// 与 /proxy 的区别：/stream 不依赖 userId 查挂载，而是直接从 Movie 表读取凭证，
// 这样房间内任何成员（含观众）都能通过 movieId 访问影片流。
router.get('/stream', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const movieIdRaw = req.query.movieId;
    if (movieIdRaw === undefined) {
      res.status(400).json({ success: false, message: '缺少 movieId 参数' });
      return;
    }
    const movieId = Number(movieIdRaw);
    if (Number.isNaN(movieId)) {
      res.status(400).json({ success: false, message: 'movieId 不正确' });
      return;
    }

    const { movie, username, password, mount } = await resolveMovieStream(movieId, 'ftp');

    const params: FTPConnectionParams = {
      serverUrl: movie.serverUrl!,
      path: movie.path!,
      port: mount?.port || undefined,
      username,
      password,
    };

    try {
      const info = await statFTPFileCached(params);
      const fileSize = info.size;

      const rangeHeader = req.headers.range;
      const parsed = parseRangeHeader(rangeHeader, fileSize);
      const start = parsed && parsed !== 'invalid' ? parsed.start : 0;
      const endByte =
        parsed && parsed !== 'invalid' ? parsed.end : fileSize - 1;

      const stream = createFTPReadStream(params, start);
      pipeRangeStream(res, {
        stream,
        contentType: getContentType(detectMediaFormat(movie.path!)),
        fileSize,
        start,
        end: endByte,
        ranged: !!rangeHeader,
        logTag: 'ftp-stream',
        errorMessage: 'FTP 影片流错误',
        softDestroy: true,
      });
    } catch (err) {
      res.status(400).json({
        success: false,
        message: extractErrorMessage(err, '代理 FTP 影片流失败'),
      });
    }
  } catch (err) {
    // 业务错误（影片不存在/未挂载）：单行 warn + 精确状态码，避免客户端
    // 重试风暴把完整堆栈刷进日志
    if (err instanceof StreamMovieError) {
      console.warn(`[ftp] stream ${err.code} ${err.status}: ${err.message}`);
      if (!res.headersSent) {
        res.status(err.status).json({ success: false, message: err.message, code: err.code });
      } else {
        res.destroy();
      }
      return;
    }
    console.error('[ftp] stream error:', err);
    if (!res.headersSent) {
      res.status(502).json({
        success: false,
        message: extractErrorMessage(err, '代理 FTP 影片失败'),
      });
    } else {
      res.destroy();
    }
  }
});

export default router;
