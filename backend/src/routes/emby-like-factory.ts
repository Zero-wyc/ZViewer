/**
 * Emby 系路由工厂
 *
 * Emby 与 Jellyfin 的路由结构 ~80% 相同（Jellyfin 是 Emby 开源分支，API 完全兼容，
 * REST 客户端同为 services/emby-client.ts），此前为两份逐行平行的拷贝。
 * 本工厂参数化两者仅有的差异：挂载类型、显示名文案、API 前缀、日志前缀与错误码兜底。
 *
 * 行为对齐说明：/mounts/test 与 /mounts(创建) 采用 emby.ts 的实现——
 * 账号密码模式登录结果已含 userId 时跳过 /Users/Me 调用（对 Jellyfin 同样成立，
 * 两端共用同一客户端类）。
 */
import { Router, Request, Response } from 'express';
import { AppDataSource } from '../data-source';
import { UserMount } from '../entities/UserMount';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import {
  stripPassword,
  extractErrorMessage,
  probeForMountSave,
} from '../modules/shared/mount-utils';
import { EmbyClient, EmbyError, type EmbyItem } from '../services/emby-client';
import {
  resolveUserMount,
  resolveMovieStream,
  invalidateUserMountCache,
  proxyHttpUpstream,
  StreamMovieError,
} from '../services/proxy';
import { buildEmbyResolvePayload } from '../services/emby-versions';
import { normalizeServerUrlWithScheme } from '../services/network-utils';

export interface EmbyLikeRouterOptions {
  /** UserMount.type 挂载类型 */
  mountType: 'emby' | 'jellyfin';
  /** 错误文案中的显示名（如 'Emby' / 'Jellyfin'） */
  label: string;
  /** 播放地址的 API 前缀（/api/emby | /api/jellyfin） */
  apiPrefix: 'emby' | 'jellyfin';
  /** console 日志前缀（如 '[emby]'） */
  logTag: string;
  /** 非客户端错误的错误码兜底（'EMBY_ERROR' / 'JELLYFIN_ERROR'） */
  fallbackErrorCode: string;
}

export function createEmbyLikeRouter(options: EmbyLikeRouterOptions): Router {
  const { mountType, label, apiPrefix, logTag, fallbackErrorCode } = options;

  const router = Router();

  const userMountRepository = () => AppDataSource.getRepository(UserMount);

  function extractErrorCode(err: unknown): string {
    return err instanceof EmbyError ? err.code ?? fallbackErrorCode : 'UNREACHABLE';
  }

  /**
   * 解析挂载的会话（token + userId）。
   * - 优先使用 apiKey；userId 缺失时通过 /Users/Me 获取并回写缓存。
   * - 账号密码模式：创建/测试时已登录并缓存 token；若 token 失效（401）则重新登录。
   */
  async function resolveSession(mount: UserMount): Promise<{
    client: EmbyClient;
    userId: string;
    token: string;
  }> {
    const serverUrl = mount.serverUrl;
    if (!serverUrl) {
      throw new EmbyError('该挂载未配置服务器地址', undefined, 'INVALID_URL');
    }

    let token = mount.apiKey ?? '';
    if (!token) {
      // 账号密码模式：先尝试已缓存的登录 token（存于 apiKey 字段的临时值不可靠，走重新登录）
      if (!mount.username || !mount.password) {
        throw new EmbyError(`${label} 挂载缺少 API Key 或账号密码`, undefined, 'MISSING_CREDENTIALS');
      }
      const loginClient = new EmbyClient({ serverUrl });
      const loginResult = await loginClient.login(mount.username, mount.password);
      token = loginResult.token;
    }

    const client = new EmbyClient({ serverUrl, token });
    let userId = mount.embyUserId ?? '';
    if (!userId) {
      try {
        const me = await client.me();
        userId = me.Id;
        // 回写缓存的 userId
        mount.embyUserId = userId;
        await userMountRepository().save(mount);
      } catch {
        // userId 获取失败时按挂载路径解析（部分服务器不需要 userId）
      }
    }
    return { client, userId, token };
  }

  /** 转换 item 为前端可识别的条目（isFile 标记可播放性） */
  function mapEntry(item: EmbyItem) {
    const fileTypes = new Set(['Movie', 'Video', 'Episode', 'TvSeries']);
    const isFile = fileTypes.has(item.Type) || item.IsFile === true;
    return {
      name: item.Name,
      path: item.Id,
      type: (isFile ? 'file' : 'directory') as 'file' | 'directory',
      embyType: item.Type,
      childCount: item.ChildCount ?? 0,
      // 刮削元数据（瀑布流海报墙用）：Primary 主海报 tag + 年份
      imageTag: item.ImageTags?.Primary,
      productionYear: item.ProductionYear,
      // 分集序号（剧集卡分集列表标签 SxEy 用）
      indexNumber: item.IndexNumber,
      parentIndexNumber: item.ParentIndexNumber,
      // 时长（秒）：RunTimeTicks / 10^7
      duration:
        typeof item.RunTimeTicks === 'number'
          ? Math.round(item.RunTimeTicks / 10_000_000)
          : undefined,
      // 原始文件路径（非刮削库的分集无 IndexNumber，前端从文件名解析集号兜底）
      filePath: item.Path,
      // 递归后代条目数（Series≈总集数，海报墙角标用）
      recursiveItemCount: item.RecursiveItemCount,
    };
  }

  // 条目海报图代理 - GET /mounts/:id/image?itemId=[&tag=]&maxWidth=
  // ⚠️ 注册在 authenticateToken 之前（免认证）：<img> 标签无法携带 Authorization
  // header，且本项目 HTTP 部署场景 httpOnly cookie 不可用（与 /proxy-image 同理）。
  // 弱保护：tag 可选——有 tag 时直接取该图（ImageTags.Primary 是不可枚举 hash，
  // 须先通过认证的 browse 才能获得）；无 tag 时仅做文件夹海报回退（取第一个带
  // Primary 的后代条目封面，对齐官方前端行为）。
  router.get('/mounts/:id/image', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const mountId = Number(req.params.id);
      const itemId = typeof req.query.itemId === 'string' ? req.query.itemId : '';
      const tag = typeof req.query.tag === 'string' ? req.query.tag : '';
      if (Number.isNaN(mountId) || !itemId.trim()) {
        res.status(400).json({ success: false, message: '缺少 mountId 或 itemId', code: 'INVALID_PARAMS' });
        return;
      }
      const repo = userMountRepository();
      // 免认证端点：不按 userId 过滤（无认证身份），tag 作为访问凭证
      const mount = await repo.findOneBy({ id: mountId, type: mountType });
      if (!mount) {
        res.status(404).json({ success: false, message: '挂载不存在' });
        return;
      }
      const session = await resolveSession(mount);
      const maxWidth = Number(req.query.maxWidth) || 300;
      // 文件夹海报回退（对齐官方前端行为）：文件夹条目自身的
      // ImageTags.Primary 常为空（按目录整理的库），官方 UI 会回退显示
      // 内部子项的封面。tag 缺省或原图 404 时，查找第一个带 Primary
      // 海报的后代条目取其封面。
      const sendImage = (buffer: Buffer, contentType: string) => {
        res.set('Content-Type', contentType);
        // 海报基本不变：浏览器缓存 1 小时，减少重复代理流量
        res.set('Cache-Control', 'private, max-age=3600');
        res.send(buffer);
      };
      try {
        const { buffer, contentType } = await session.client.itemImage(itemId, {
          tag: tag || undefined,
          maxWidth,
        });
        sendImage(buffer, contentType);
      } catch (imgErr) {
        // 回退：逐个尝试带 Primary 海报的后代条目（竖版优先），
        // 单个候选原图 404（ImageTags 与实际图不同步）时继续下一个
        try {
          const candidates = await session.client.findPosterChildren(session.userId, itemId);
          for (const childId of candidates) {
            try {
              const { buffer, contentType } = await session.client.itemImage(childId, { maxWidth });
              sendImage(buffer, contentType);
              return;
            } catch {
              // 尝试下一个候选
            }
          }
          throw imgErr;
        } catch {
          throw imgErr;
        }
      }
    } catch (err) {
      console.error(`[${logTag}] mount image error:`, err);
      const code = extractErrorCode(err);
      const status = code === 'AUTH_FAILED' ? 401 : code === 'TIMEOUT' ? 504 : 404;
      res.status(status).json({
        success: false,
        message: extractErrorMessage(err, '获取海报失败'),
        code,
      });
    }
  });

  router.use(authenticateToken);

  // ==================== 挂载 CRUD ====================

  // 列表 - GET /mounts
  router.get('/mounts', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const userId = req.user!.userId;
      const mounts = await userMountRepository().find({
        where: { userId, type: mountType },
        order: { createdAt: 'DESC' },
      });
      res.json({ success: true, mounts: mounts.map(stripPassword) });
    } catch (err) {
      console.error(`[${logTag}] list mounts error:`, err);
      res.status(500).json({ success: false, message: `获取 ${label} 挂载列表失败` });
    }
  });

  // 测试连接 - POST /mounts/test（必须在 /:id 之前注册）
  router.post('/mounts/test', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const { serverUrl, apiKey, username, password } = req.body ?? {};
      if (typeof serverUrl !== 'string' || !serverUrl.trim()) {
        res.status(400).json({ success: false, message: '服务器地址不能为空', code: 'INVALID_URL' });
        return;
      }
      if (!apiKey && (!username || !password)) {
        res.status(400).json({
          success: false,
          message: '请填写 API Key，或用户名与密码',
          code: 'MISSING_CREDENTIALS',
        });
        return;
      }

      try {
        let token = typeof apiKey === 'string' && apiKey.trim() ? apiKey.trim() : '';
        let userId = '';
        let userName = '';
        let serverId = '';
        if (!token) {
          const loginClient = new EmbyClient({ serverUrl: serverUrl.trim() });
          const result = await loginClient.login(String(username), String(password));
          token = result.token;
          userId = result.userId;
          userName = result.userName;
          serverId = result.serverId;
        }
        // API Key 模式需要通过 /Users/Me 获取用户信息；账号密码模式直接用登录返回值
        if (!userId) {
          const client = new EmbyClient({ serverUrl: serverUrl.trim(), token });
          const me = await client.me();
          userId = me.Id;
          userName = me.Name;
          serverId = me.ServerId;
        }
        res.json({ success: true, userId, userName, serverId });
      } catch (err) {
        const code = extractErrorCode(err);
        res.status(400).json({
          success: false,
          message: extractErrorMessage(err, `连接 ${label} 失败`),
          code,
        });
      }
    } catch (err) {
      console.error(`[${logTag}] test mount error:`, err);
      res.status(500).json({ success: false, message: `测试 ${label} 连接失败` });
    }
  });

  // 创建 - POST /mounts
  router.post('/mounts', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const { name, serverUrl, apiKey, username, password, directLink } = req.body ?? {};
      if (typeof name !== 'string' || !name.trim()) {
        res.status(400).json({ success: false, message: '挂载名称不能为空', code: 'INVALID_PARAMS' });
        return;
      }
      if (typeof serverUrl !== 'string' || !serverUrl.trim()) {
        res.status(400).json({ success: false, message: '服务器地址不能为空', code: 'INVALID_URL' });
        return;
      }
      if (!apiKey && (!username || !password)) {
        res.status(400).json({
          success: false,
          message: '请填写 API Key，或用户名与密码',
          code: 'MISSING_CREDENTIALS',
        });
        return;
      }

      // 先测试连接，拿到 userId 一起保存
      let embyUserId: string | null = null;
      try {
        let token = typeof apiKey === 'string' && apiKey.trim() ? apiKey.trim() : '';
        if (!token) {
          const loginClient = new EmbyClient({ serverUrl: serverUrl.trim() });
          const result = await loginClient.login(String(username), String(password));
          token = result.token;
          embyUserId = result.userId;
        }
        // API Key 模式需要通过 /Users/Me 获取用户信息
        if (!embyUserId) {
          const client = new EmbyClient({ serverUrl: serverUrl.trim(), token });
          const me = await client.me();
          embyUserId = me.Id;
        }
      } catch (err) {
        res.status(400).json({
          success: false,
          message: extractErrorMessage(err, `连接 ${label} 失败`),
          code: extractErrorCode(err),
        });
        return;
      }

      const repo = userMountRepository();
      const mount = repo.create({
        userId: req.user!.userId,
        type: mountType,
        name: name.trim(),
        // 规范化后落库：补 scheme 避免运行时 new URL 抛错
        serverUrl: normalizeServerUrlWithScheme(serverUrl),
        apiKey: typeof apiKey === 'string' && apiKey.trim() ? apiKey.trim() : null,
        username: typeof username === 'string' && username.trim() ? username.trim() : null,
        password: typeof password === 'string' && password ? password : null,
        embyUserId,
        directLink: directLink === true,
      });
      await repo.save(mount);
      invalidateUserMountCache(mount.id);
      const httpsWarning = await probeForMountSave(mount);
      res.status(201).json({
        success: true,
        mount: stripPassword(mount),
        ...(httpsWarning ? { warning: httpsWarning } : {}),
      });
    } catch (err) {
      console.error(`[${logTag}] create mount error:`, err);
      res.status(500).json({ success: false, message: `创建 ${label} 挂载失败` });
    }
  });

  // 更新 - PUT /mounts/:id
  router.put('/mounts/:id', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const mountId = Number(req.params.id);
      if (Number.isNaN(mountId)) {
        res.status(400).json({ success: false, message: '挂载 ID 不正确', code: 'INVALID_PARAMS' });
        return;
      }
      const repo = userMountRepository();
      const mount = await repo.findOneBy({
        id: mountId,
        userId: req.user!.userId,
        type: mountType,
      });
      if (!mount) {
        res.status(404).json({ success: false, message: '挂载不存在或无权限' });
        return;
      }

      const { name, serverUrl, apiKey, username, password, directLink } = req.body ?? {};
      if (typeof name === 'string' && name.trim()) mount.name = name.trim();
      if (typeof serverUrl === 'string' && serverUrl.trim()) {
        mount.serverUrl = normalizeServerUrlWithScheme(serverUrl);
        mount.embyUserId = null; // 服务器变更后 userId 需重新获取
        mount.httpsDirect = null; // 服务器变更后 HTTPS 能力需重新探测
      }
      if (apiKey !== undefined) mount.apiKey = typeof apiKey === 'string' && apiKey.trim() ? apiKey.trim() : null;
      if (username !== undefined) mount.username = typeof username === 'string' && username.trim() ? username.trim() : null;
      if (password !== undefined) mount.password = typeof password === 'string' && password ? password : null;
      if (directLink !== undefined) mount.directLink = directLink === true;

      // 更新后重新获取 userId
      try {
        const session = await resolveSession(mount);
        mount.embyUserId = session.userId || null;
      } catch {
        /* 保持原样，运行时再处理 */
      }

      await repo.save(mount);
      invalidateUserMountCache(mount.id);
      const httpsWarning = await probeForMountSave(mount);
      res.json({
        success: true,
        mount: stripPassword(mount),
        ...(httpsWarning ? { warning: httpsWarning } : {}),
      });
    } catch (err) {
      console.error(`[${logTag}] update mount error:`, err);
      res.status(500).json({ success: false, message: `更新 ${label} 挂载失败` });
    }
  });

  // 删除 - DELETE /mounts/:id
  router.delete('/mounts/:id', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const mountId = Number(req.params.id);
      if (Number.isNaN(mountId)) {
        res.status(400).json({ success: false, message: '挂载 ID 不正确', code: 'INVALID_PARAMS' });
        return;
      }
      const repo = userMountRepository();
      const mount = await repo.findOneBy({
        id: mountId,
        userId: req.user!.userId,
        type: mountType,
      });
      if (!mount) {
        res.status(404).json({ success: false, message: '挂载不存在或无权限' });
        return;
      }
      await repo.remove(mount);
      invalidateUserMountCache(mount.id);
      res.json({ success: true });
    } catch (err) {
      console.error(`[${logTag}] delete mount error:`, err);
      res.status(500).json({ success: false, message: `删除 ${label} 挂载失败` });
    }
  });

  // ==================== 浏览 / 解析 / 代理 ====================

  // 浏览 - GET /mounts/:id/browse?path=（空 = 媒体库）
  router.get('/mounts/:id/browse', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const mountId = Number(req.params.id);
      if (Number.isNaN(mountId)) {
        res.status(400).json({ success: false, message: '挂载 ID 不正确', code: 'INVALID_PARAMS' });
        return;
      }
      const repo = userMountRepository();
      const mount = await repo.findOneBy({
        id: mountId,
        userId: req.user!.userId,
        type: mountType,
      });
      if (!mount) {
        res.status(404).json({ success: false, message: '挂载不存在或无权限' });
        return;
      }

      const browsePath = typeof req.query.path === 'string' ? req.query.path : '';
      const session = await resolveSession(mount);

      let items: EmbyItem[] = [];
      if (!browsePath || browsePath === 'views' || browsePath === '/') {
        items = await session.client.userViews(session.userId);
      } else {
        items = await session.client.items(session.userId, browsePath);
      }

      res.json({ success: true, entries: items.map(mapEntry) });
    } catch (err) {
      console.error(`[${logTag}] browse mount error:`, err);
      const code = extractErrorCode(err);
      const status = code === 'AUTH_FAILED' ? 401 : code === 'TIMEOUT' ? 504 : 400;
      res.status(status).json({
        success: false,
        message: extractErrorMessage(err, `浏览 ${label} 失败`),
        code,
      });
    }
  });

  // 搜索 - GET /mounts/:id/search?term=
  // 官方 API：GET /Users/{userId}/Items?SearchTerm=&Recursive=true
  // 返回条目结构与 browse 一致（path=itemId），可直接选中添加或进入剧集
  router.get('/mounts/:id/search', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const mountId = Number(req.params.id);
      if (Number.isNaN(mountId)) {
        res.status(400).json({ success: false, message: '挂载 ID 不正确', code: 'INVALID_PARAMS' });
        return;
      }
      const term = typeof req.query.term === 'string' ? req.query.term.trim() : '';
      if (!term) {
        res.status(400).json({ success: false, message: '搜索关键词不能为空', code: 'INVALID_PARAMS' });
        return;
      }
      const repo = userMountRepository();
      const mount = await repo.findOneBy({
        id: mountId,
        userId: req.user!.userId,
        type: mountType,
      });
      if (!mount) {
        res.status(404).json({ success: false, message: '挂载不存在或无权限' });
        return;
      }

      const session = await resolveSession(mount);
      const items = await session.client.search(session.userId, term);
      res.json({ success: true, entries: items.map(mapEntry) });
    } catch (err) {
      console.error(`[${logTag}] search mount error:`, err);
      const code = extractErrorCode(err);
      const status = code === 'AUTH_FAILED' ? 401 : code === 'TIMEOUT' ? 504 : 400;
      res.status(status).json({
        success: false,
        message: extractErrorMessage(err, `搜索 ${label} 失败`),
        code,
      });
    }
  });

  // 解析 - GET /resolve?mountId=&path=[&ms=]（path 为 itemId）
  // ms=MediaSourceId：多版本（多清晰度）影片指定版本；缺省取服务器默认（最高码率）
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
      const itemId = typeof pathRaw === 'string' ? pathRaw : '';
      if (!itemId.trim()) {
        res.status(400).json({ success: false, message: 'itemId 不能为空', code: 'INVALID_PARAMS' });
        return;
      }

      const repo = userMountRepository();
      const mount = await repo.findOneBy({
        id: mountId,
        userId: req.user!.userId,
        type: mountType,
      });
      if (!mount) {
        res.status(404).json({ success: false, message: '挂载不存在或无权限' });
        return;
      }

      const session = await resolveSession(mount);
      const mediaSourceId = typeof req.query.ms === 'string' ? req.query.ms : undefined;
      const payload = await buildEmbyResolvePayload({
        session,
        mount,
        itemId,
        mountId,
        apiPrefix,
        mediaSourceId,
      });
      res.json({ success: true, ...payload });
    } catch (err) {
      console.error(`[${logTag}] resolve error:`, err);
      res.status(400).json({
        success: false,
        message: extractErrorMessage(err, `解析 ${label} 条目失败`),
        code: extractErrorCode(err),
      });
    }
  });

  // 按影片 ID 解析 - GET /movie-source?movieId=[&ms=]
  // 房主在影片列表切换多版本影片的清晰度时使用：无需 mountId，
  // 复用 /stream 同款 movieId → 挂载凭证链路，返回版本列表与所选版本的播放地址。
  router.get('/movie-source', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
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

      const { movie, mount } = await resolveMovieStream(movieId, mountType);
      if (!mount) {
        res.status(404).json({ success: false, message: `未找到对应的 ${label} 挂载配置` });
        return;
      }
      if (!movie.path) {
        res.status(400).json({ success: false, message: '该影片缺少 itemId 信息' });
        return;
      }

      const session = await resolveSession(mount);
      const mediaSourceId = typeof req.query.ms === 'string' ? req.query.ms : undefined;
      const payload = await buildEmbyResolvePayload({
        session,
        mount,
        itemId: movie.path,
        mountId: mount.id,
        apiPrefix,
        mediaSourceId,
        movieId,
      });
      res.json({ success: true, ...payload });
    } catch (err) {
      if (err instanceof StreamMovieError) {
        if (!res.headersSent) {
          res.status(err.status).json({ success: false, message: err.message, code: err.code });
        }
        return;
      }
      console.error(`[${logTag}] movie-source error:`, err);
      res.status(400).json({
        success: false,
        message: extractErrorMessage(err, `解析 ${label} 影片版本失败`),
        code: extractErrorCode(err),
      });
    }
  });

  // 代理 - GET /proxy?mountId=&path=（path 为 itemId）
  // at=1 时转发到服务端转码播放列表（main.m3u8，音频强制 AAC），
  // 用于片源音轨编码浏览器不支持（DTS/EAC3 等）导致的无声场景。
  router.get('/proxy', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const resolved = await resolveUserMount(req, res, mountType);
    if (!resolved) return;
    const { mount, targetPath } = resolved;

    try {
      const session = await resolveSession(mount);
      const audioTranscode = req.query.at === '1';
      // 多版本选档：ms=MediaSourceId，透传给 upstream 选定播放版本
      const ms = typeof req.query.ms === 'string' ? req.query.ms : '';
      const msSuffix = ms ? `&MediaSourceId=${encodeURIComponent(ms)}` : '';
      const upstreamUrl = audioTranscode
        ? `${session.client.baseUrl}/emby/Videos/${encodeURIComponent(targetPath)}/main.m3u8?api_key=${session.token}&AudioCodec=aac&TranscodingMaxAudioChannels=2&VideoBitrate=8000000&AudioBitrate=192000${msSuffix}`
        : `${session.client.baseUrl}/emby/Videos/${encodeURIComponent(targetPath)}/stream?static=true&api_key=${session.token}${msSuffix}`;

      await proxyHttpUpstream(req, res, {
        url: upstreamUrl,
        headers: {
          extra: {
            'X-Emby-Token': session.token,
            Referer: session.client.baseUrl,
          },
        },
        cors: 'wildcard',
        defaultContentType: audioTranscode ? 'application/x-mpegURL' : 'video/mp4',
        // 转码冷启动：需先启动 ffmpeg 转码才吐出首个分片，30s 默认超时会误杀
        timeoutMs: audioTranscode ? 90_000 : undefined,
        logTag: audioTranscode ? `${logTag}-proxy-transcode` : `${logTag}-proxy`,
        errorMessage: `${label} 视频流代理失败`,
      });
    } catch (err) {
      console.error(`[${logTag}] proxy error:`, err);
      const status = extractErrorCode(err) === 'AUTH_FAILED' ? 401 : 502;
      res.status(status).json({
        success: false,
        message: extractErrorMessage(err, `代理 ${label} 视频流失败`),
        code: extractErrorCode(err),
      });
    }
  });

  // 基于影片 ID 的流代理 - GET /stream?movieId=
  // 与 /proxy 的区别：/stream 不依赖 userId 查挂载，而是直接从 Movie 表读取 serverUrl，
  // 再通过 serverUrl + type 在 UserMount 表中查找挂载凭证，
  // 这样房间内任何成员（含观众）都能通过 movieId 访问影片流。
  // at=1：音频转码模式（片源音轨编码浏览器不支持时由 resolve 标记并写入 movie.url）
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

      const { movie, mount } = await resolveMovieStream(movieId, mountType);
      if (!mount) {
        res.status(404).json({ success: false, message: `未找到对应的 ${label} 挂载配置` });
        return;
      }

      const session = await resolveSession(mount);
      const itemId = movie.path!;
      // 转码判定：
      // - resolve 阶段检测到音轨编码不兼容时，format 会持久化为 'hls'（Movie.format），
      //   中转模式据此转发到转码播放列表（main.m3u8），与前端 hls-engine 匹配；
      // - 不能依赖 movie.url 是否带 at=1：代理模式下 createMovie 会把 url 重写为
      //   /api/<prefix>/stream?movieId=N，at=1 标记在重写时丢失。
      const audioTranscode =
        req.query.at === '1' ||
        (movie.format ?? '').toLowerCase() === 'hls';
      // 多版本选档：movie.url 可能形如 /api/<prefix>/stream?movieId=N&ms=X（版本切换
      // 由 updateMovie 持久化），此处透传 MediaSourceId 给 upstream
      const ms = typeof req.query.ms === 'string' ? req.query.ms : '';
      const msSuffix = ms ? `&MediaSourceId=${encodeURIComponent(ms)}` : '';
      const upstreamUrl = audioTranscode
        ? `${session.client.baseUrl}/emby/Videos/${encodeURIComponent(itemId)}/main.m3u8?api_key=${session.token}&AudioCodec=aac&TranscodingMaxAudioChannels=2&VideoBitrate=8000000&AudioBitrate=192000${msSuffix}`
        : `${session.client.baseUrl}/emby/Videos/${encodeURIComponent(itemId)}/stream?static=true&api_key=${session.token}${msSuffix}`;

      await proxyHttpUpstream(req, res, {
        url: upstreamUrl,
        headers: {
          extra: {
            'X-Emby-Token': session.token,
            Referer: session.client.baseUrl,
          },
        },
        cors: 'wildcard',
        defaultContentType: audioTranscode ? 'application/x-mpegURL' : 'video/mp4',
        // 转码冷启动：需先启动 ffmpeg 转码才吐出首个分片，30s 默认超时会误杀
        timeoutMs: audioTranscode ? 90_000 : undefined,
        logTag: audioTranscode ? `${logTag}-stream-transcode` : `${logTag}-stream`,
        errorMessage: `${label} 视频流代理失败`,
      });
    } catch (err) {
      // 业务错误（影片不存在/未挂载）：单行 warn + 精确状态码，避免客户端
      // 重试风暴把完整堆栈刷进日志
      if (err instanceof StreamMovieError) {
        // 熔断缓存命中（非首次判定）完全静默：客户端重试风暴不应刷日志
        if (!err.fromCache)
        console.warn(`[${logTag}] stream ${err.code} ${err.status}: ${err.message}`);
        if (!res.headersSent) {
          res.status(err.status).json({ success: false, message: err.message, code: err.code });
        } else {
          res.destroy();
        }
        return;
      }
      console.error(`[${logTag}] stream error:`, err);
      if (!res.headersSent) {
        const status = extractErrorCode(err) === 'AUTH_FAILED' ? 401 : 502;
        res.status(status).json({
          success: false,
          message: extractErrorMessage(err, `${label} 视频流代理失败`),
          code: extractErrorCode(err),
        });
      } else {
        res.destroy();
      }
    }
  });

  return router;
}
