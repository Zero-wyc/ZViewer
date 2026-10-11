/**
 * Emby 路由层
 *
 * 将 Emby 作为独立的媒体源挂载（分离式架构：REST 客户端在 services/emby-client.ts）。
 * 路由结构与 webdav/openlist 对齐，type 为 'emby'：
 * - 挂载 CRUD（serverUrl + apiKey 或 账号密码）
 * - 目录浏览（媒体库 / 剧集 / 季 / 单集）
 * - 解析播放地址（直连 URL 或本服务代理 URL）
 * - 代理播放流（复用 services/proxy/http-proxy.ts）
 */
import {
  stripPassword,
  extractErrorMessage,
  probeForMountSave,
} from '../modules/shared/mount-utils';
import { Router, Request, Response } from 'express';
import { AppDataSource } from '../data-source';
import { UserMount } from '../entities/UserMount';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import {
  EmbyClient,
  EmbyError,
  type EmbyItem,
} from '../services/emby-client';
import { resolveUserMount, resolveMovieStream, proxyHttpUpstream, StreamMovieError } from '../services/proxy';
import { buildEmbyResolvePayload } from '../services/emby-versions';
import { normalizeServerUrlWithScheme } from '../services/network-utils';

const router = Router();

const userMountRepository = () => AppDataSource.getRepository(UserMount);

function extractErrorCode(err: unknown): string {
  return err instanceof EmbyError ? err.code ?? 'EMBY_ERROR' : 'UNREACHABLE';
}

/**
 * 解析挂载的 Emby 会话（token + userId）。
 * - 优先使用 apiKey；userId 缺失时通过 /emby/Users/Me 获取并回写缓存。
 * - 账号密码模式：创建/测试时已登录并缓存 token；若 token 失效（401）则重新登录。
 */
async function resolveEmbySession(mount: UserMount): Promise<{
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
      throw new EmbyError('Emby 挂载缺少 API Key 或账号密码', undefined, 'MISSING_CREDENTIALS');
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
      // userId 获取失败时按挂载路径解析（部分 Emby 不需要 userId）
    }
  }
  return { client, userId, token };
}

/** 转换 Emby item 为前端可识别的条目（isFile 标记可播放性） */
function mapEmbyEntry(item: EmbyItem) {
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
  };
}

// 条目海报图代理 - GET /mounts/:id/image?itemId=&tag=&maxWidth=
// ⚠️ 注册在 authenticateToken 之前（免认证）：<img> 标签无法携带 Authorization
// header，且本项目 HTTP 部署场景 httpOnly cookie 不可用（与 /proxy-image 同理）。
// 弱保护：tag 必填——ImageTags.Primary 是不可枚举 hash，须先通过认证的
// browse 才能获得；仅凭 mountId/itemId 无法拉取。
router.get('/mounts/:id/image', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const mountId = Number(req.params.id);
    const itemId = typeof req.query.itemId === 'string' ? req.query.itemId : '';
    const tag = typeof req.query.tag === 'string' ? req.query.tag : '';
    if (Number.isNaN(mountId) || !itemId.trim() || !tag) {
      res.status(400).json({ success: false, message: '缺少 mountId、itemId 或 tag', code: 'INVALID_PARAMS' });
      return;
    }
    const repo = userMountRepository();
    // 免认证端点：不按 userId 过滤（无认证身份），tag 作为访问凭证
    const mount = await repo.findOneBy({ id: mountId, type: 'emby' });
    if (!mount) {
      res.status(404).json({ success: false, message: '挂载不存在' });
      return;
    }
    const session = await resolveEmbySession(mount);
    const maxWidth = Number(req.query.maxWidth) || 300;
    const { buffer, contentType } = await session.client.itemImage(itemId, { tag, maxWidth });
    res.set('Content-Type', contentType);
    // 海报基本不变：浏览器缓存 1 小时，减少重复代理流量
    res.set('Cache-Control', 'private, max-age=3600');
    res.send(buffer);
  } catch (err) {
    console.error('[emby] mount image error:', err);
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
      where: { userId, type: 'emby' },
      order: { createdAt: 'DESC' },
    });
    res.json({ success: true, mounts: mounts.map(stripPassword) });
  } catch (err) {
    console.error('[emby] list mounts error:', err);
    res.status(500).json({ success: false, message: '获取 Emby 挂载列表失败' });
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
        message: extractErrorMessage(err, '连接 Emby 失败'),
        code,
      });
    }
  } catch (err) {
    console.error('[emby] test mount error:', err);
    res.status(500).json({ success: false, message: '测试 Emby 连接失败' });
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
        message: extractErrorMessage(err, '连接 Emby 失败'),
        code: extractErrorCode(err),
      });
      return;
    }

    const repo = userMountRepository();
    const mount = repo.create({
      userId: req.user!.userId,
      type: 'emby',
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
    const httpsWarning = await probeForMountSave(mount);
    res.status(201).json({
      success: true,
      mount: stripPassword(mount),
      ...(httpsWarning ? { warning: httpsWarning } : {}),
    });
  } catch (err) {
    console.error('[emby] create mount error:', err);
    res.status(500).json({ success: false, message: '创建 Emby 挂载失败' });
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
      type: 'emby',
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
      const session = await resolveEmbySession(mount);
      mount.embyUserId = session.userId || null;
    } catch {
      /* 保持原样，运行时再处理 */
    }

    await repo.save(mount);
    const httpsWarning = await probeForMountSave(mount);
    res.json({
      success: true,
      mount: stripPassword(mount),
      ...(httpsWarning ? { warning: httpsWarning } : {}),
    });
  } catch (err) {
    console.error('[emby] update mount error:', err);
    res.status(500).json({ success: false, message: '更新 Emby 挂载失败' });
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
      type: 'emby',
    });
    if (!mount) {
      res.status(404).json({ success: false, message: '挂载不存在或无权限' });
      return;
    }
    await repo.remove(mount);
    res.json({ success: true });
  } catch (err) {
    console.error('[emby] delete mount error:', err);
    res.status(500).json({ success: false, message: '删除 Emby 挂载失败' });
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
      type: 'emby',
    });
    if (!mount) {
      res.status(404).json({ success: false, message: '挂载不存在或无权限' });
      return;
    }

    const browsePath = typeof req.query.path === 'string' ? req.query.path : '';
    const session = await resolveEmbySession(mount);

    let items: EmbyItem[] = [];
    if (!browsePath || browsePath === 'views' || browsePath === '/') {
      items = await session.client.userViews(session.userId);
    } else {
      items = await session.client.items(session.userId, browsePath);
    }

    res.json({ success: true, entries: items.map(mapEmbyEntry) });
  } catch (err) {
    console.error('[emby] browse mount error:', err);
    const code = extractErrorCode(err);
    const status = code === 'AUTH_FAILED' ? 401 : code === 'TIMEOUT' ? 504 : 400;
    res.status(status).json({
      success: false,
      message: extractErrorMessage(err, '浏览 Emby 失败'),
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
      type: 'emby',
    });
    if (!mount) {
      res.status(404).json({ success: false, message: '挂载不存在或无权限' });
      return;
    }

    const session = await resolveEmbySession(mount);
    const items = await session.client.search(session.userId, term);
    res.json({ success: true, entries: items.map(mapEmbyEntry) });
  } catch (err) {
    console.error('[emby] search mount error:', err);
    const code = extractErrorCode(err);
    const status = code === 'AUTH_FAILED' ? 401 : code === 'TIMEOUT' ? 504 : 400;
    res.status(status).json({
      success: false,
      message: extractErrorMessage(err, '搜索 Emby 失败'),
      code,
    });
  }
});

// 解析 - GET /resolve?mountId=&path=[&ms=]（path 为 Emby itemId）
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
      type: 'emby',
    });
    if (!mount) {
      res.status(404).json({ success: false, message: '挂载不存在或无权限' });
      return;
    }

    const session = await resolveEmbySession(mount);
    const mediaSourceId = typeof req.query.ms === 'string' ? req.query.ms : undefined;
    const payload = await buildEmbyResolvePayload({
      session,
      mount,
      itemId,
      mountId,
      apiPrefix: 'emby',
      mediaSourceId,
    });
    res.json({ success: true, ...payload });
  } catch (err) {
    console.error('[emby] resolve error:', err);
    res.status(400).json({
      success: false,
      message: extractErrorMessage(err, '解析 Emby 条目失败'),
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

    const { movie, mount } = await resolveMovieStream(movieId, 'emby');
    if (!mount) {
      res.status(404).json({ success: false, message: '未找到对应的 Emby 挂载配置' });
      return;
    }
    if (!movie.path) {
      res.status(400).json({ success: false, message: '该影片缺少 itemId 信息' });
      return;
    }

    const session = await resolveEmbySession(mount);
    const mediaSourceId = typeof req.query.ms === 'string' ? req.query.ms : undefined;
    const payload = await buildEmbyResolvePayload({
      session,
      mount,
      itemId: movie.path,
      mountId: mount.id,
      apiPrefix: 'emby',
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
    console.error('[emby] movie-source error:', err);
    res.status(400).json({
      success: false,
      message: extractErrorMessage(err, '解析 Emby 影片版本失败'),
      code: extractErrorCode(err),
    });
  }
});

// 代理 - GET /proxy?mountId=&path=（path 为 Emby itemId）
// at=1 时转发到 Emby 服务端转码播放列表（main.m3u8，音频强制 AAC），
// 用于片源音轨编码浏览器不支持（DTS/EAC3 等）导致的无声场景。
router.get('/proxy', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const resolved = await resolveUserMount(req, res, 'emby');
  if (!resolved) return;
  const { mount, targetPath } = resolved;

  try {
    const session = await resolveEmbySession(mount);
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
      // 转码冷启动：Emby 需先启动 ffmpeg 转码才吐出首个分片，30s 默认超时会误杀
      timeoutMs: audioTranscode ? 90_000 : undefined,
      logTag: audioTranscode ? 'emby-proxy-transcode' : 'emby-proxy',
      errorMessage: 'Emby 视频流代理失败',
    });
  } catch (err) {
    console.error('[emby] proxy error:', err);
    const status = extractErrorCode(err) === 'AUTH_FAILED' ? 401 : 502;
    res.status(status).json({
      success: false,
      message: extractErrorMessage(err, '代理 Emby 视频流失败'),
      code: extractErrorCode(err),
    });
  }
});

// 基于影片 ID 的流代理 - GET /stream?movieId=
// 与 /proxy 的区别：/stream 不依赖 userId 查挂载，而是直接从 Movie 表读取 serverUrl，
// 再通过 serverUrl + type='emby' 在 UserMount 表中查找挂载凭证，
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

    const { movie, mount } = await resolveMovieStream(movieId, 'emby');
    if (!mount) {
      res.status(404).json({ success: false, message: '未找到对应的 Emby 挂载配置' });
      return;
    }

    const session = await resolveEmbySession(mount);
    const itemId = movie.path!;
    // 转码判定：
    // - resolve 阶段检测到音轨编码不兼容时，format 会持久化为 'hls'（Movie.format），
    //   中转模式据此转发到 Emby 转码播放列表（main.m3u8），与前端 hls-engine 匹配；
    // - 不能依赖 movie.url 是否带 at=1：代理模式下 createMovie 会把 url 重写为
    //   /api/emby/stream?movieId=N，at=1 标记在重写时丢失。
    const audioTranscode =
      req.query.at === '1' ||
      (movie.format ?? '').toLowerCase() === 'hls';
    // 多版本选档：movie.url 可能形如 /api/emby/stream?movieId=N&ms=X（版本切换
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
      // 转码冷启动：Emby 需先启动 ffmpeg 转码才吐出首个分片，30s 默认超时会误杀
      timeoutMs: audioTranscode ? 90_000 : undefined,
      logTag: audioTranscode ? 'emby-stream-transcode' : 'emby-stream',
      errorMessage: 'Emby 视频流代理失败',
    });
  } catch (err) {
    // 业务错误（影片不存在/未挂载）：单行 warn + 精确状态码，避免客户端
    // 重试风暴把完整堆栈刷进日志
    if (err instanceof StreamMovieError) {
      // 熔断缓存命中（非首次判定）完全静默：客户端重试风暴不应刷日志
      if (!err.fromCache)
      console.warn(`[emby] stream ${err.code} ${err.status}: ${err.message}`);
      if (!res.headersSent) {
        res.status(err.status).json({ success: false, message: err.message, code: err.code });
      } else {
        res.destroy();
      }
      return;
    }
    console.error('[emby] stream error:', err);
    if (!res.headersSent) {
      const status = extractErrorCode(err) === 'AUTH_FAILED' ? 401 : 502;
      res.status(status).json({
        success: false,
        message: extractErrorMessage(err, 'Emby 视频流代理失败'),
        code: extractErrorCode(err),
      });
    } else {
      res.destroy();
    }
  }
});

export default router;
