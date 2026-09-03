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
import { stripPassword, extractErrorMessage } from '../modules/shared/mount-utils';
import { Router, Request, Response } from 'express';
import { AppDataSource } from '../data-source';
import { UserMount } from '../entities/UserMount';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import {
  EmbyClient,
  EmbyError,
  type EmbyItem,
} from '../services/emby-client';
import { detectMediaFormat, getContentType } from '../services/mediaFormat';
import { resolveUserMount, resolveMovieStream, proxyHttpUpstream } from '../services/proxy';
import { upgradeToHttpsIfNeeded } from '../services/url-utils';

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
  };
}

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
      serverUrl: serverUrl.trim(),
      apiKey: typeof apiKey === 'string' && apiKey.trim() ? apiKey.trim() : null,
      username: typeof username === 'string' && username.trim() ? username.trim() : null,
      password: typeof password === 'string' && password ? password : null,
      embyUserId,
      directLink: directLink === true,
    });
    await repo.save(mount);
    res.status(201).json({ success: true, mount: stripPassword(mount) });
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
      mount.serverUrl = serverUrl.trim();
      mount.embyUserId = null; // 服务器变更后 userId 需重新获取
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
    res.json({ success: true, mount: stripPassword(mount) });
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

// 解析 - GET /resolve?mountId=&path=（path 为 Emby itemId）
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
    const info = await session.client.playbackInfo(itemId, session.userId);
    const source = info.MediaSources[0];
    if (!source) {
      res.status(400).json({ success: false, message: '该条目无可用媒体源', code: 'NO_MEDIA_SOURCE' });
      return;
    }

    // ── 音频编码兼容性检测 ──────────────────────────────
    // static=true 直推原始容器时，若音轨是 DTS/EAC3/TrueHD 等浏览器
    // <video> 不支持的编码，画面正常但完全无声（取决于片源音轨，因此"有概率"）。
    // 检测到不兼容音轨时自动切换为 Emby 服务端转码的 HLS 流（音频强制 AAC），
    // 由前端 hls-engine 接管播放，代价是 Emby 服务器承担实时转码开销。
    const BROWSER_SUPPORTED_AUDIO = new Set(['aac', 'mp3', 'flac', 'opus', 'vorbis']);
    const audioStream = source.MediaStreams?.find((s) => s.Type === 'Audio');
    const audioCodec = audioStream?.Codec ?? null;
    const audioIncompatible =
      !!audioStream &&
      !!audioStream.Codec &&
      !BROWSER_SUPPORTED_AUDIO.has(audioStream.Codec.toLowerCase());
    // 不兼容即转码：直推会让浏览器完全无声，Emby 服务端转码的代价远小于
    // 无声播放，故不再设全局开关门控。
    const needsAudioTranscode = audioIncompatible;

    // 标题：从 source.Path 取文件名，或回退 itemId
    const title =
      source.Path?.split(/[\\/]/).pop() || `item-${itemId}`;
    const format = needsAudioTranscode ? 'hls' : detectMediaFormat(source.Path ?? title);

    // 代理 URL（本服务中转，带 token 转发，前端无需知道 Emby 地址）
    // at=1：audio-transcode，代理层转发到 Emby 转码端点而非 static 直推
    const transcodeQuery = needsAudioTranscode ? '&at=1' : '';
    const proxyUrl = `/api/emby/proxy?mountId=${mountId}&path=${encodeURIComponent(itemId)}${transcodeQuery}`;

    // 直连 URL（浏览器直连 Emby，要求前端可访问 Emby 服务器）
    // 需要音频转码时改为 Emby 官方转码播放列表（HLS，服务端强制音频 AAC）
    const directUrl = upgradeToHttpsIfNeeded(
      req,
      needsAudioTranscode
        ? `${session.client.baseUrl}/emby/Videos/${encodeURIComponent(itemId)}/main.m3u8?api_key=${session.token}&AudioCodec=aac&TranscodingMaxAudioChannels=2&VideoBitrate=8000000&AudioBitrate=192000`
        : `${session.client.baseUrl}/emby/Videos/${encodeURIComponent(itemId)}/stream?static=true&api_key=${session.token}`,
    );

    res.json({
      success: true,
      title,
      videoUrl: proxyUrl,
      directUrl,
      format,
      duration: 0,
      audioCodec,
      needsAudioTranscode,
      emby: {
        itemId,
        container: source.Container ?? '',
      },
    });
  } catch (err) {
    console.error('[emby] resolve error:', err);
    res.status(400).json({
      success: false,
      message: extractErrorMessage(err, '解析 Emby 条目失败'),
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
    const upstreamUrl = audioTranscode
      ? `${session.client.baseUrl}/emby/Videos/${encodeURIComponent(targetPath)}/main.m3u8?api_key=${session.token}&AudioCodec=aac&TranscodingMaxAudioChannels=2&VideoBitrate=8000000&AudioBitrate=192000`
      : `${session.client.baseUrl}/emby/Videos/${encodeURIComponent(targetPath)}/stream?static=true&api_key=${session.token}`;

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
    const upstreamUrl = audioTranscode
      ? `${session.client.baseUrl}/emby/Videos/${encodeURIComponent(itemId)}/main.m3u8?api_key=${session.token}&AudioCodec=aac&TranscodingMaxAudioChannels=2&VideoBitrate=8000000&AudioBitrate=192000`
      : `${session.client.baseUrl}/emby/Videos/${encodeURIComponent(itemId)}/stream?static=true&api_key=${session.token}`;

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
      logTag: audioTranscode ? 'emby-stream-transcode' : 'emby-stream',
      errorMessage: 'Emby 视频流代理失败',
    });
  } catch (err) {
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
