/**
 * WebDAV 挂载路由工厂
 *
 * WebDAV 与 OpenList 共享同一套 WebDAV 协议逻辑（OpenList/AList 兼容 WebDAV），
 * 因此二者共用一个路由工厂，OpenList 仅通过 options 注入差异：
 * - normalizeServerUrl：OpenList 自动补 http:// 前缀与 /dav 路径
 * - directUrlFallback：WebDAV 在 AList API 失败时回退拼接直链，OpenList 不回退
 * - includeSize：OpenList resolve 返回文件大小
 */
import {
  stripPassword,
  extractErrorMessage,
  ensureHttpsProbe,
  maybeUpgradeDirectUrl,
  probeHttpsCapability,
} from '../modules/shared/mount-utils';
import { Router, Request, Response } from 'express';
import { AppDataSource } from '../data-source';
import { UserMount } from '../entities/UserMount';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import {
  statWebDAVFile,
  createWebDAVReadStreamWithRange,
  buildWebDAVDirectUrl,
  listWebDAVDirectoryCached,
  listWebDAVDirectory,
  WebDAVError,
  type WebDAVConnectionParams,
} from '../services/webdav';
import {
  fetchOpenListDirectUrl,
  OpenListError,
} from '../services/openlist';
import { isInternalOpenListServer } from '../services/openlist-errors';
import { detectMediaFormat, getContentType } from '../services/mediaFormat';
import { resolveUserMount, resolveMovieStream, pipeRangeStream } from '../services/proxy';

export interface MountRouterOptions {
  /** 挂载类型（'webdav' | 'openlist'） */
  type: 'webdav' | 'openlist';
  /** 规范化用户输入的 serverUrl（OpenList 自动补 http:// 与 /dav） */
  normalizeServerUrl?: (url: string) => string;
  /** 将 UserMount 转为 WebDAVConnectionParams（OpenList 有特殊路径处理） */
  mountToParams?: (mount: UserMount) => WebDAVConnectionParams;
  /** resolve 是否返回 size 字段（OpenList 有） */
  includeSize?: boolean;
  /** direct-url 在 AList API 失败时是否回退到 WebDAV 拼接（WebDAV 回退，OpenList 不回退） */
  directUrlFallback?: boolean;
  /** 代理 URL 前缀，如 /api/webdav */
  proxyPrefix: string;
  /** 日志标签 */
  logTag: string;
  /** 展示名（错误文案用） */
  displayName: string;
  /** /stream 端点是否对 movie.serverUrl 做 normalize（OpenList 需要） */
  normalizeMovieServerUrl?: boolean;
}

const userMountRepository = () => AppDataSource.getRepository(UserMount);

// 默认的 UserMount → WebDAVConnectionParams
function defaultMountToParams(mount: UserMount): WebDAVConnectionParams {
  return {
    serverUrl: mount.serverUrl!,
    path: mount.path || '/',
    username: mount.username || undefined,
    password: mount.password || undefined,
  };
}

// 从异常中提取错误码
function extractErrorCode(err: unknown): string {
  if (err instanceof WebDAVError) return err.code;
  if (err instanceof OpenListError) return err.code;
  return 'UNREACHABLE';
}

export function createMountRouter(opts: MountRouterOptions): Router {
  const router = Router();
  const {
    type,
    normalizeServerUrl = (url: string) => url,
    mountToParams = defaultMountToParams,
    includeSize = false,
    directUrlFallback = true,
    proxyPrefix,
    logTag,
    displayName,
    normalizeMovieServerUrl = false,
  } = opts;

  /**
   * 解析 directLink，内网地址强制使用服务器中转。
   *
   * 当 WebDAV 服务器为内网/回环地址（127.0.0.1、10.x、172.16-31.x、192.168.x、localhost、::1 等）时，
   * 浏览器无法直接访问，必须强制通过后端 /stream 端点中转。
   */
  function resolveDirectLinkWithInternalCheck(
    serverUrl: string,
    directLink: boolean,
  ): boolean {
    if (directLink && isInternalOpenListServer(serverUrl)) {
      return false;
    }
    return directLink;
  }

  router.use(authenticateToken);

  // 2.1 挂载 CRUD - GET /mounts
  router.get('/mounts', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const userId = req.user!.userId;
      const mounts = await userMountRepository().find({
        where: { userId, type },
        order: { createdAt: 'DESC' },
      });

      res.json({
        success: true,
        mounts: mounts.map(stripPassword),
      });
    } catch (err) {
      console.error(`[${logTag}] list mounts error:`, err);
      res.status(500).json({ success: false, message: `获取 ${displayName} 挂载列表失败` });
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
        serverUrl: normalizeServerUrl(serverUrl.trim()),
        path: typeof path === 'string' && path.trim() ? path.trim() : '/',
        username: typeof username === 'string' && username ? username : undefined,
        password: typeof password === 'string' && password ? password : undefined,
      };

      try {
        const entries = await listWebDAVDirectory(params, '/');
        res.json({
          success: true,
          itemCount: entries.length,
        });
      } catch (err) {
        res.status(400).json({
          success: false,
          message: extractErrorMessage(err, `${displayName} 不可访问`),
          code: extractErrorCode(err),
        });
      }
    } catch (err) {
      console.error(`[${logTag}] test mount error:`, err);
      res.status(500).json({ success: false, message: `测试 ${displayName} 连接失败` });
    }
  });

  // 2.1 挂载 CRUD - POST /mounts
  router.post('/mounts', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const { name, serverUrl, path, username, password, directLink } = req.body ?? {};

      if (typeof name !== 'string' || !name.trim()) {
        res.status(400).json({ success: false, message: '挂载名称不能为空' });
        return;
      }
      if (typeof serverUrl !== 'string' || !serverUrl.trim()) {
        res.status(400).json({ success: false, message: '服务器地址不能为空', code: 'INVALID_URL' });
        return;
      }

      const params: WebDAVConnectionParams = {
        serverUrl: normalizeServerUrl(serverUrl.trim()),
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
          message: extractErrorMessage(err, `${displayName} 不可访问`),
          code: extractErrorCode(err),
        });
        return;
      }

      const repo = userMountRepository();
      const mount = repo.create({
        type,
        name: name.trim(),
        serverUrl: params.serverUrl,
        path: params.path,
        username: params.username || null,
        password: params.password || null,
        directLink: resolveDirectLinkWithInternalCheck(params.serverUrl, directLink === true),
        userId: req.user!.userId,
      } as UserMount);
      await repo.save(mount);
      // 配置期 HTTPS 能力探测（异步）：结果随挂载持久化，direct-url 惰性补探兜底
      void probeHttpsCapability(mount.serverUrl || '')
        .then((result) => {
          if (result === null) return;
          mount.httpsDirect = result;
          return repo.save(mount);
        })
        .catch(() => {});

      res.status(201).json({
        success: true,
        mount: stripPassword(mount),
        ...(mount.directLink !== (directLink === true)
          ? { warning: '检测到内网地址，已强制使用服务器中转模式' }
          : {}),
      });
    } catch (err) {
      console.error(`[${logTag}] create mount error:`, err);
      res.status(500).json({ success: false, message: `创建 ${displayName} 挂载失败` });
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
        type,
      });
      if (!mount) {
        res.status(404).json({ success: false, message: '挂载不存在或无权限' });
        return;
      }

      const { name, serverUrl, path, username, password, directLink } = req.body ?? {};

      if (typeof name !== 'string' || !name.trim()) {
        res.status(400).json({ success: false, message: '挂载名称不能为空' });
        return;
      }
      if (typeof serverUrl !== 'string' || !serverUrl.trim()) {
        res.status(400).json({ success: false, message: '服务器地址不能为空', code: 'INVALID_URL' });
        return;
      }

      const params: WebDAVConnectionParams = {
        serverUrl: normalizeServerUrl(serverUrl.trim()),
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
          message: extractErrorMessage(err, `${displayName} 不可访问`),
          code: extractErrorCode(err),
        });
        return;
      }

      mount.name = name.trim();
      // serverUrl 变更时重置探测结果（旧值对应旧地址）
      if (mount.serverUrl !== params.serverUrl) mount.httpsDirect = null;
      mount.serverUrl = params.serverUrl;
      mount.path = params.path;
      mount.username = params.username || null;
      if (typeof password === 'string') {
        mount.password = password || null;
      }
      mount.directLink = resolveDirectLinkWithInternalCheck(params.serverUrl, directLink === true);
      await repo.save(mount);
      // 配置期 HTTPS 能力探测（异步）：结果随挂载持久化，direct-url 惰性补探兜底
      void probeHttpsCapability(mount.serverUrl || '')
        .then((result) => {
          if (result === null) return;
          mount.httpsDirect = result;
          return repo.save(mount);
        })
        .catch(() => {});

      res.json({
        success: true,
        mount: stripPassword(mount),
        ...(mount.directLink !== (directLink === true)
          ? { warning: '检测到内网地址，已强制使用服务器中转模式' }
          : {}),
      });
    } catch (err) {
      console.error(`[${logTag}] update mount error:`, err);
      res.status(500).json({ success: false, message: `更新 ${displayName} 挂载失败` });
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
        type,
      });
      if (!mount) {
        res.status(404).json({ success: false, message: '挂载不存在或无权限' });
        return;
      }

      await repo.remove(mount);
      res.json({ success: true });
    } catch (err) {
      console.error(`[${logTag}] delete mount error:`, err);
      res.status(500).json({ success: false, message: `删除 ${displayName} 挂载失败` });
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
        type,
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

      try {
        const entries = await listWebDAVDirectoryCached(params, mount.id, browsePath);
        res.json({ success: true, entries });
      } catch (err) {
        res.status(400).json({
          success: false,
          message: extractErrorMessage(err, `浏览 ${displayName} 失败`),
          code: extractErrorCode(err),
        });
      }
    } catch (err) {
      console.error(`[${logTag}] browse mount error:`, err);
      res.status(500).json({ success: false, message: `浏览 ${displayName} 挂载失败` });
    }
  });

  // 2.4 解析 - GET /resolve?mountId=&path=
  router.get('/resolve', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const mountIdRaw = req.query.mountId;
      const pathRaw = req.query.path;
      if (mountIdRaw === undefined || (typeof pathRaw !== 'string' && pathRaw === undefined)) {
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
        type,
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
        serverUrl: normalizeServerUrl(mount.serverUrl),
        path: targetPath,
        username: mount.username || undefined,
        password: mount.password || undefined,
      };

      try {
        const info = await statWebDAVFile(params);
        // 使用相对路径，由前端根据当前页面 origin 自动解析，避免反向代理后协议错误（http vs https）
        const proxyUrl = `${proxyPrefix}/proxy?mountId=${mountId}&path=${encodeURIComponent(targetPath)}`;
        const format = detectMediaFormat(info.name || targetPath);
        const body: Record<string, unknown> = {
          success: true,
          title: info.name,
          videoUrl: proxyUrl,
          format,
          duration: 0,
        };
        if (includeSize) {
          body.size = info.size;
        }
        res.json(body);
      } catch (err) {
        res.status(400).json({
          success: false,
          message: extractErrorMessage(err, `解析 ${displayName} 文件失败`),
          code: extractErrorCode(err),
        });
      }
    } catch (err) {
      console.error(`[${logTag}] resolve error:`, err);
      res.status(500).json({ success: false, message: `解析 ${displayName} 文件失败` });
    }
  });

  // 2.5 代理 - GET /proxy?mountId=&path=
  router.get('/proxy', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      // 代理端点通过 query 暴露 mountId+path，但凭证仅从 DB 读取，不会出现在 URL 中
      const resolved = await resolveUserMount(req, res, type);
      if (!resolved) return;
      const { mount, targetPath } = resolved;

      const params: WebDAVConnectionParams = {
        serverUrl: normalizeServerUrl(mount.serverUrl!),
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
          message: extractErrorMessage(err, `打开 ${displayName} 流失败`),
          code,
        });
        return;
      }

      pipeRangeStream(res, {
        stream,
        contentType: getContentType(detectMediaFormat(targetPath)),
        fileSize,
        start,
        end,
        ranged: !!rangeHeader,
        logTag,
        errorMessage: `${displayName} 代理流错误`,
        errorCode: 'UNREACHABLE',
      });
    } catch (err) {
      console.error(`[${logTag}] proxy error:`, err);
      if (!res.headersSent) {
        res.status(502).json({
          success: false,
          message: extractErrorMessage(err, `代理 ${displayName} 媒体失败`),
        });
      } else {
        res.destroy();
      }
    }
  });

  // 2.6 获取直链 - GET /direct-url?mountId=&path=
  // 房主添加影片时调用：后端使用挂载凭证返回直链 URL。
  // 优先尝试 AList API 获取真实直链（带签名的下载 URL），避免 CORS/ORB 跨域问题。
  // directUrlFallback=true（WebDAV）时，AList API 失败回退 serverUrl+path 拼接。
  router.get('/direct-url', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
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
      const targetPath = typeof pathRaw === 'string' ? pathRaw.trim() : '';
      if (!targetPath) {
        res.status(400).json({ success: false, message: 'path 不能为空' });
        return;
      }

      const repo = userMountRepository();
      const mount = await repo.findOneBy({
        id: mountId,
        userId: req.user!.userId,
        type,
      });
      if (!mount) {
        res.status(404).json({ success: false, message: '挂载不存在或无权限' });
        return;
      }
      if (!mount.serverUrl) {
        res.status(400).json({ success: false, message: '该挂载未配置服务器地址' });
        return;
      }

      // 内网地址拒绝返回直链（浏览器无法访问内网服务器）
      if (isInternalOpenListServer(mount.serverUrl)) {
        res.status(400).json({
          success: false,
          message: '该挂载为内网地址，无法使用直链模式，请使用服务器转发',
          code: 'INTERNAL_NETWORK_FORBIDDEN',
        });
        return;
      }

      // 优先尝试 AList API 获取真实直链（带签名的下载 URL）。
      // 很多用户将 AList 服务器以 WebDAV 类型挂载（AList 同时支持 WebDAV 和 HTTP API）。
      try {
        const alistDirectUrl = await fetchOpenListDirectUrl(
          mount.serverUrl,
          mount.username || undefined,
          mount.password || undefined,
          targetPath,
        );
        // 配置期探测的 HTTPS 能力：源站支持 TLS 时升级 http 直链为 https
        // （浏览器直连零带宽）；否则保持 http，播放时走服务器代理
        const httpsDirect = await ensureHttpsProbe(mount);
        res.json({
          success: true,
          directUrl: maybeUpgradeDirectUrl(alistDirectUrl, httpsDirect),
        });
        return;
      } catch (err) {
        // 明确是 AList 服务器但路径/凭证有问题：直接报错，不回退拼接
        if (err instanceof OpenListError) {
          if (err.code === 'NOT_FOUND' || err.code === 'AUTH_FAILED') {
            const status = err.code === 'AUTH_FAILED' ? 401 : 404;
            res.status(status).json({
              success: false,
              message: err.message,
              code: err.code,
            });
            return;
          }
          // UNREACHABLE 等错误：可能不是 AList 服务器
          if (!directUrlFallback) {
            res.status(400).json({
              success: false,
              message: err.message,
              code: err.code,
            });
            return;
          }
        } else if (!directUrlFallback) {
          res.status(400).json({
            success: false,
            message: err instanceof Error ? err.message : '获取直链失败',
            code: 'UNREACHABLE',
          });
          return;
        }
        // directUrlFallback=true：回退到 WebDAV 拼接
      }

      // WebDAV 协议不支持获取真实直链，直接拼接 serverUrl+path
      const directUrl = buildWebDAVDirectUrl(
        mount.serverUrl,
        targetPath,
        mount.username || undefined,
        mount.password || undefined,
      );
      // 配置期探测的 HTTPS 能力：源站支持 TLS 时升级 http 直链为 https
      const httpsDirect = await ensureHttpsProbe(mount);
      res.json({
        success: true,
        directUrl: maybeUpgradeDirectUrl(directUrl, httpsDirect),
      });
    } catch (err) {
      console.error(`[${logTag}] direct-url error:`, err);
      res.status(500).json({ success: false, message: `获取 ${displayName} 直链失败` });
    }
  });

  // 2.7 基于影片 ID 的流代理 - GET /stream?movieId=
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

      const { movie, username, password } = await resolveMovieStream(movieId, type);

      const params: WebDAVConnectionParams = {
        serverUrl: normalizeMovieServerUrl ? normalizeServerUrl(movie.serverUrl!) : movie.serverUrl!,
        path: movie.path!,
        username,
        password,
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
          message: extractErrorMessage(err, `打开 ${displayName} 流失败`),
          code,
        });
        return;
      }

      pipeRangeStream(res, {
        stream,
        contentType: getContentType(detectMediaFormat(movie.path!)),
        fileSize,
        start,
        end,
        ranged: !!rangeHeader,
        logTag: `${logTag}-stream`,
        errorMessage: `${displayName} 影片流错误`,
        errorCode: 'UNREACHABLE',
      });
    } catch (err) {
      console.error(`[${logTag}] stream error:`, err);
      if (!res.headersSent) {
        res.status(502).json({ success: false, message: `代理 ${displayName} 影片失败` });
      } else {
        res.destroy();
      }
    }
  });

  return router;
}

// 兼容默认导出：WebDAV 实例
export default createMountRouter({
  type: 'webdav',
  proxyPrefix: '/api/webdav',
  logTag: 'webdav',
  displayName: 'WebDAV',
});
