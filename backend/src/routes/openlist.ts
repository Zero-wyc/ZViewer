/**
 * OpenList 独立路由（v2 重构）
 *
 * 不再复用 createMountRouter（WebDAV 协议），直接基于 AList HTTP API 实现。
 * 参考 synctv/server/handlers/vendors/vendorAlist 的设计。
 *
 * 端点列表：
 * - GET    /mounts              列出当前用户的 OpenList 挂载
 * - POST   /mounts              创建挂载
 * - PUT    /mounts/:id           更新挂载
 * - DELETE /mounts/:id           删除挂载
 * - POST   /mounts/test          测试连接
 * - GET    /mounts/:id/browse   浏览目录
 * - GET    /resolve             解析文件（返回 proxy URL）
 * - GET    /proxy               代理流（mountId + path）
 * - GET    /stream              代理流（movieId）
 * - GET    /direct-url          获取直链
 * - GET    /me                   获取当前用户在指定挂载上的 AList 账号信息
 *
 * 关键改进：
 * 1. /stream 不再每次重新登录 AList（token 缓存）
 * 2. /stream 通过 raw_url 代理（HTTP GET + Range 透传），不走 WebDAV
 * 3. raw_url 短期缓存（5 分钟），避免每次 /stream 都调用 /api/fs/get
 */
import { Router, Response } from 'express';
import { AppDataSource } from '../data-source';
import { UserMount } from '../entities/UserMount';
import { Movie } from '../entities/Movie';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import {
  stripPassword,
  extractErrorMessage,
  ensureHttpsProbe,
  maybeUpgradeDirectUrl,
  probeForMountSave,
} from '../modules/shared/mount-utils';
import {
  normalizeOpenListServerUrl,
  isInternalOpenListServer,
  OpenListError,
  fetchOpenListFileInfo,
  fetchOpenListDirectUrl,
  listOpenListDirectory,
  searchOpenListFiles,
  testOpenListConnection,
  getOpenListUserMe,
} from '../services/openlist';
import { hashAlistPassword, isAlistHashedPassword } from '../services/openlist-client';
import { detectMediaFormat, getContentType } from '../services/mediaFormat';
import { proxyHttpUpstream } from '../services/proxy/http-proxy';
import { TtlCache } from '../utils/ttl-cache';

const router = Router();
const userMountRepository = () => AppDataSource.getRepository(UserMount);
const movieRepository = () => AppDataSource.getRepository(Movie);

/** raw_url 缓存条目：避免每次 /stream 都调用 /api/fs/get */
interface RawUrlCacheEntry {
  rawUrl: string;
  name: string;
  size: number;
  /** 过期时间戳（毫秒） */
  expireAt: number;
}

/**
 * raw_url 缓存（按 movieId|path 维度，5 分钟 TTL）。
 * 使用 TtlCache（LRU 上限）替代无界 Map：过期惰性清理 + 容量超限按最久未使用淘汰，
 * 避免长期运行（多房间多影片）下缓存条目只增不减。
 */
const rawUrlCache = new TtlCache<RawUrlCacheEntry>({
  ttlMs: 5 * 60 * 1000,
  maxSize: 500,
});
const RAW_URL_TTL_MS = 5 * 60 * 1000;

/**
 * 获取 raw_url（带缓存）。
 * 优先从缓存读取；未命中或过期时调用 fetchOpenListFileInfo 获取新直链。
 * AList 的 raw_url 通常带签名（sign 参数），签名有效期取决于存储后端配置，
 * 5 分钟 TTL 在绝大多数场景下足够。
 */
async function getCachedRawUrl(
  serverUrl: string,
  username: string | undefined,
  password: string | undefined,
  path: string,
  cacheKey: string,
): Promise<RawUrlCacheEntry> {
  const cached = rawUrlCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const info = await fetchOpenListFileInfo(serverUrl, username, password, path);
  const entry: RawUrlCacheEntry = {
    rawUrl: info.rawUrl,
    name: info.name,
    size: info.size,
    expireAt: Date.now() + RAW_URL_TTL_MS,
  };
  rawUrlCache.set(cacheKey, entry);
  return entry;
}

/** 失效指定 movieId 的 raw_url 缓存 */
function invalidateRawUrlCache(cacheKey: string): void {
  rawUrlCache.delete(cacheKey);
}

router.use(authenticateToken);

// ==================== 挂载 CRUD ====================

/**
 * 规范化密码：明文 → AList 哈希格式。
 *
 * 参考 synctv/server/handlers/vendors/vendorAlist/login.go：
 * 后端在保存/使用密码前，将明文密码通过 SHA-256(password + salt) 转为哈希，
 * 与 AList /api/auth/login/hash 端点约定一致。
 *
 * - 若传入空值：原样返回（不哈希）
 * - 若传入已是哈希格式（64 位十六进制）：原样返回（幂等）
 * - 若传入明文：哈希后返回
 *
 * 这样存储层始终保存哈希密码，明文密码不会落盘；
 * 服务层 detectLoginMode 检测到哈希格式后自动走 /api/auth/login/hash 端点。
 */
function normalizePasswordForStorage(password: string | null | undefined): string | null {
  if (!password) return null;
  // 已是哈希格式（兼容前端可能预先哈希的场景），直接返回
  if (isAlistHashedPassword(password)) return password;
  // 明文密码 → 哈希
  return hashAlistPassword(password);
}

/**
 * 解析 directLink，内网地址强制使用服务器中转。
 *
 * 当 OpenList 服务器为内网/回环地址（127.0.0.1、10.x、172.16-31.x、192.168.x、localhost、::1 等）时，
 * 浏览器无法直接访问其 raw_url 直链，必须强制通过后端 /stream 端点中转。
 *
 * @param serverUrl  规范化后的 OpenList 服务器地址
 * @param directLink 用户请求的 directLink 值
 * @returns 实际生效的 directLink（内网时强制为 false）
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

// GET /mounts - 列出挂载
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

// POST /mounts/test - 测试连接（必须在 /:id 之前注册）
router.post('/mounts/test', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { serverUrl, username, password } = req.body ?? {};
    if (typeof serverUrl !== 'string' || !serverUrl.trim()) {
      res.status(400).json({ success: false, message: '服务器地址不能为空', code: 'INVALID_URL' });
      return;
    }

    // 规范化密码：明文 → AList 哈希格式（参考 synctv 后端哈希逻辑）
    const normalizedPassword = normalizePasswordForStorage(
      typeof password === 'string' ? password : undefined,
    );

    const result = await testOpenListConnection(serverUrl.trim(), username, normalizedPassword || undefined);
    if (result.ok) {
      res.json({ success: true });
    } else {
      res.status(400).json({ success: false, message: result.message, code: result.code });
    }
  } catch (err) {
    console.error('[openlist] test mount error:', err);
    res.status(500).json({ success: false, message: '测试 OpenList 连接失败' });
  }
});

// POST /mounts - 创建挂载
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

    const normalizedUrl = normalizeOpenListServerUrl(serverUrl.trim());
    // 规范化密码：明文 → AList 哈希格式，存储层始终保存哈希
    const normalizedPassword = normalizePasswordForStorage(
      typeof password === 'string' ? password : undefined,
    );
    // 内网地址强制使用服务器中转（浏览器无法直连内网 raw_url）
    const effectiveDirectLink = resolveDirectLinkWithInternalCheck(normalizedUrl, directLink === true);

    // 测试连通性（使用哈希密码，走 /api/auth/login/hash 端点）
    const result = await testOpenListConnection(normalizedUrl, username, normalizedPassword || undefined);
    if (!result.ok) {
      res.status(400).json({ success: false, message: result.message, code: result.code });
      return;
    }

    const repo = userMountRepository();
    const mount = repo.create({
      type: 'openlist',
      name: name.trim(),
      serverUrl: normalizedUrl,
      path: typeof path === 'string' && path.trim() ? path.trim() : '/',
      username: typeof username === 'string' && username ? username : null,
      password: normalizedPassword,
      directLink: effectiveDirectLink,
      userId: req.user!.userId,
    } as UserMount);
    await repo.save(mount);
    // 直链模式 + http 源：同步探测并返回 warning（源站不支持 TLS 时提示
    // 配置 HTTPS 或改为服务器中转）；其余组合异步探测持久化
    const httpsWarning = await probeForMountSave(mount);

    res.status(201).json({
      success: true,
      mount: stripPassword(mount),
      // 告知前端：内网挂载被强制中转
      ...(effectiveDirectLink !== (directLink === true)
        ? { warning: '检测到内网地址，已强制使用服务器中转模式' }
        : httpsWarning
          ? { warning: httpsWarning }
          : {}),
    });
  } catch (err) {
    console.error('[openlist] create mount error:', err);
    res.status(500).json({ success: false, message: '创建 OpenList 挂载失败' });
  }
});

// PUT /mounts/:id - 更新挂载
router.put('/mounts/:id', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) {
      res.status(400).json({ success: false, message: '挂载 ID 不正确' });
      return;
    }

    const repo = userMountRepository();
    const mount = await repo.findOneBy({ id, userId: req.user!.userId, type: 'openlist' });
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

    const normalizedUrl = normalizeOpenListServerUrl(serverUrl.trim());

    // 计算更新后的密码：
    // - 前端传入非空字符串：明文或哈希，统一规范化为哈希
    // - 前端传入空字符串：清空密码（null）
    // - 前端未传 password 字段：保持原密码不变
    let nextPassword: string | null | undefined;
    if (typeof password === 'string') {
      nextPassword = normalizePasswordForStorage(password);
    } else {
      nextPassword = mount.password;
    }

    // 内网地址强制使用服务器中转（浏览器无法直连内网 raw_url）
    const requestedDirectLink = directLink === true;
    const effectiveDirectLink = resolveDirectLinkWithInternalCheck(normalizedUrl, requestedDirectLink);

    // 若服务器地址或凭证变更，需要重新测试连通性
    const serverChanged = mount.serverUrl !== normalizedUrl;
    const credChanged =
      (username || null) !== (mount.username || null) ||
      (nextPassword || null) !== (mount.password || null);
    if (serverChanged || credChanged) {
      const result = await testOpenListConnection(
        normalizedUrl,
        username || mount.username || undefined,
        nextPassword || undefined,
      );
      if (!result.ok) {
        res.status(400).json({ success: false, message: result.message, code: result.code });
        return;
      }
    }

    mount.name = name.trim();
    mount.serverUrl = normalizedUrl;
    mount.path = typeof path === 'string' && path.trim() ? path.trim() : '/';
    mount.username = typeof username === 'string' && username ? username : null;
    if (typeof password === 'string') {
      mount.password = nextPassword;
    }
    mount.directLink = effectiveDirectLink;
    // serverUrl 变更时重置探测结果（旧值对应旧地址）
    if (serverChanged) mount.httpsDirect = null;
    await repo.save(mount);
    const httpsWarning = await probeForMountSave(mount);

    res.json({
      success: true,
      mount: stripPassword(mount),
      // 告知前端：内网挂载被强制中转
      ...(effectiveDirectLink !== requestedDirectLink
        ? { warning: '检测到内网地址，已强制使用服务器中转模式' }
        : httpsWarning
          ? { warning: httpsWarning }
          : {}),
    });
  } catch (err) {
    console.error('[openlist] update mount error:', err);
    res.status(500).json({ success: false, message: '更新 OpenList 挂载失败' });
  }
});

// DELETE /mounts/:id - 删除挂载
router.delete('/mounts/:id', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) {
      res.status(400).json({ success: false, message: '挂载 ID 不正确' });
      return;
    }

    const repo = userMountRepository();
    const mount = await repo.findOneBy({ id, userId: req.user!.userId, type: 'openlist' });
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

// GET /mounts/:id/browse - 浏览目录
router.get('/mounts/:id/browse', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) {
      res.status(400).json({ success: false, message: '挂载 ID 不正确' });
      return;
    }

    const repo = userMountRepository();
    const mount = await repo.findOneBy({ id, userId: req.user!.userId, type: 'openlist' });
    if (!mount) {
      res.status(404).json({ success: false, message: '挂载不存在或无权限' });
      return;
    }
    if (!mount.serverUrl) {
      res.status(400).json({ success: false, message: '该挂载未配置服务器地址' });
      return;
    }

    const browsePath = typeof req.query.path === 'string' ? req.query.path : '/';
    const page = Number(req.query.page) || 1;
    const perPage = Number(req.query.perPage) || 100;

    try {
      const result = await listOpenListDirectory(
        mount.serverUrl,
        mount.username || undefined,
        mount.password || undefined,
        browsePath,
        page,
        perPage,
      );
      // 转换为前端 MountBrowserBase 期望的统一格式：
      // - 补全 path 字段（完整路径，供点击目录时进入下一层）
      // - 将 isDir 转换为 type: 'file' | 'directory'
      // - 保留 name/size/lastModified
      const entries = result.entries.map((e) => {
        const fullPath = browsePath.endsWith('/')
          ? `${browsePath}${e.name}`
          : `${browsePath}/${e.name}`;
        return {
          name: e.name,
          path: fullPath,
          type: e.isDir ? ('directory' as const) : ('file' as const),
          size: e.size,
          lastModified: e.modified,
        };
      });
      res.json({ success: true, entries, total: result.total, provider: result.provider });
    } catch (err) {
      const code = err instanceof OpenListError ? err.code : 'UNREACHABLE';
      const status = code === 'AUTH_FAILED' ? 401 : code === 'NOT_FOUND' ? 404 : 400;
      res.status(status).json({
        success: false,
        message: extractErrorMessage(err, '浏览 OpenList 失败'),
        code,
      });
    }
  } catch (err) {
    console.error('[openlist] browse mount error:', err);
    res.status(500).json({ success: false, message: '浏览 OpenList 挂载失败' });
  }
});

// ==================== 文件解析与直链 ====================

// GET /resolve?mountId=&path= - 解析文件，返回 proxy URL
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
    const targetPath = typeof pathRaw === 'string' ? pathRaw.trim() : '';
    if (!targetPath) {
      res.status(400).json({ success: false, message: 'path 不能为空', code: 'INVALID_PARAMS' });
      return;
    }

    const repo = userMountRepository();
    const mount = await repo.findOneBy({ id: mountId, userId: req.user!.userId, type: 'openlist' });
    if (!mount) {
      res.status(404).json({ success: false, message: '挂载不存在或无权限' });
      return;
    }
    if (!mount.serverUrl) {
      res.status(400).json({ success: false, message: '该挂载未配置服务器地址' });
      return;
    }

    // 调用 /api/fs/get 获取文件信息（验证文件存在且不是目录）
    try {
      const info = await fetchOpenListFileInfo(
        mount.serverUrl,
        mount.username || undefined,
        mount.password || undefined,
        targetPath,
      );
      const proxyUrl = `/api/openlist/proxy?mountId=${mountId}&path=${encodeURIComponent(targetPath)}`;
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
      const code = err instanceof OpenListError ? err.code : 'UNREACHABLE';
      const status = code === 'AUTH_FAILED' ? 401 : code === 'NOT_FOUND' ? 404 : 400;
      res.status(status).json({
        success: false,
        message: extractErrorMessage(err, '解析 OpenList 文件失败'),
        code,
      });
    }
  } catch (err) {
    console.error('[openlist] resolve error:', err);
    res.status(500).json({ success: false, message: '解析 OpenList 文件失败' });
  }
});

// GET /direct-url?mountId=&path= - 获取直链
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
    const mount = await repo.findOneBy({ id: mountId, userId: req.user!.userId, type: 'openlist' });
    if (!mount) {
      res.status(404).json({ success: false, message: '挂载不存在或无权限' });
      return;
    }
    if (!mount.serverUrl) {
      res.status(400).json({ success: false, message: '该挂载未配置服务器地址' });
      return;
    }

    // 内网地址拒绝返回直链（浏览器无法访问内网 raw_url）
    // 作为双重保险，即使挂载层 directLink 被绕过，直链接口仍会拦截
    if (isInternalOpenListServer(mount.serverUrl)) {
      res.status(400).json({
        success: false,
        message: '该挂载为内网地址，无法使用直链模式，请使用服务器转发',
        code: 'INTERNAL_NETWORK_FORBIDDEN',
      });
      return;
    }

    try {
      const directUrl = await fetchOpenListDirectUrl(
        mount.serverUrl,
        mount.username || undefined,
        mount.password || undefined,
        targetPath,
      );
      // 配置期探测的 HTTPS 能力：源站支持 TLS（http/https 双栈）时将 http
      // 直链升级为 https——浏览器直连不受混合内容限制，零服务器带宽；
      // 不支持或未探测（旧数据，此处惰性补探测并写回）时保持 http 直链，
      // HTTPS 页面下由前端 url-proxy 统一决策走服务器代理。
      const httpsDirect = await ensureHttpsProbe(mount);
      res.json({
        success: true,
        directUrl: maybeUpgradeDirectUrl(directUrl, httpsDirect),
      });
    } catch (err) {
      const code = err instanceof OpenListError ? err.code : 'UNREACHABLE';
      const status = code === 'AUTH_FAILED' ? 401 : code === 'NOT_FOUND' ? 404 : 400;
      res.status(status).json({
        success: false,
        message: extractErrorMessage(err, '获取 OpenList 直链失败'),
        code,
      });
    }
  } catch (err) {
    console.error('[openlist] direct-url error:', err);
    res.status(500).json({ success: false, message: '获取 OpenList 直链失败' });
  }
});

// GET /me?mountId= - 获取当前用户在指定挂载上的 AList 账号信息
router.get('/me', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const mountIdRaw = req.query.mountId;
    if (mountIdRaw === undefined) {
      res.status(400).json({ success: false, message: '缺少 mountId 参数' });
      return;
    }
    const mountId = Number(mountIdRaw);
    if (Number.isNaN(mountId)) {
      res.status(400).json({ success: false, message: 'mountId 不正确' });
      return;
    }

    const repo = userMountRepository();
    const mount = await repo.findOneBy({ id: mountId, userId: req.user!.userId, type: 'openlist' });
    if (!mount) {
      res.status(404).json({ success: false, message: '挂载不存在或无权限' });
      return;
    }
    if (!mount.serverUrl) {
      res.status(400).json({ success: false, message: '该挂载未配置服务器地址' });
      return;
    }

    try {
      const me = await getOpenListUserMe(
        mount.serverUrl,
        mount.username || undefined,
        mount.password || undefined,
      );
      res.json({ success: true, info: me });
    } catch (err) {
      const code = err instanceof OpenListError ? err.code : 'UNREACHABLE';
      const status = code === 'AUTH_FAILED' ? 401 : 400;
      res.status(status).json({
        success: false,
        message: extractErrorMessage(err, '获取 OpenList 账号信息失败'),
        code,
      });
    }
  } catch (err) {
    console.error('[openlist] me error:', err);
    res.status(500).json({ success: false, message: '获取 OpenList 账号信息失败' });
  }
});

// ==================== 流代理 ====================

// GET /proxy?mountId=&path= - 基于 mountId + path 的流代理
// 房主添加影片时使用，凭证从挂载记录读取
router.get('/proxy', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const mountIdRaw = req.query.mountId;
    const pathRaw = req.query.path;
    if (mountIdRaw === undefined) {
      res.status(400).json({ success: false, message: '缺少 mountId 参数' });
      return;
    }
    const mountId = Number(mountIdRaw);
    if (Number.isNaN(mountId)) {
      res.status(400).json({ success: false, message: 'mountId 不正确' });
      return;
    }
    const targetPath = typeof pathRaw === 'string' ? pathRaw.trim() : '';
    if (!targetPath) {
      res.status(400).json({ success: false, message: '缺少 path 参数' });
      return;
    }

    const repo = userMountRepository();
    const mount = await repo.findOneBy({ id: mountId, userId: req.user!.userId, type: 'openlist' });
    if (!mount) {
      res.status(404).json({ success: false, message: '挂载不存在或无权限' });
      return;
    }
    if (!mount.serverUrl) {
      res.status(400).json({ success: false, message: '该挂载未配置服务器地址' });
      return;
    }

    // 获取 raw_url（带缓存）
    const cacheKey = `mount:${mountId}|${targetPath}`;
    let entry: RawUrlCacheEntry;
    try {
      entry = await getCachedRawUrl(
        mount.serverUrl,
        mount.username || undefined,
        mount.password || undefined,
        targetPath,
        cacheKey,
      );
    } catch (err) {
      // 缓存可能已失效（raw_url 签名过期），清理后重试一次（与 /stream 行为对齐）
      invalidateRawUrlCache(cacheKey);
      try {
        entry = await getCachedRawUrl(
          mount.serverUrl,
          mount.username || undefined,
          mount.password || undefined,
          targetPath,
          cacheKey,
        );
      } catch (err2) {
        const code = err2 instanceof OpenListError ? err2.code : 'UNREACHABLE';
        const status = code === 'AUTH_FAILED' ? 401 : code === 'NOT_FOUND' ? 404 : 400;
        res.status(status).json({
          success: false,
          message: extractErrorMessage(err2, '打开 OpenList 流失败'),
          code,
        });
        return;
      }
    }

    // 透传 raw_url（HTTP GET + Range 透传）
    const contentType = getContentType(detectMediaFormat(entry.name || targetPath));
    await proxyHttpUpstream(req, res, {
      url: entry.rawUrl,
      cors: 'wildcard',
      defaultContentType: contentType,
      logTag: 'openlist-proxy',
      errorMessage: 'OpenList 代理流错误',
    });
  } catch (err) {
    console.error('[openlist] proxy error:', err);
    if (!res.headersSent) {
      res.status(502).json({ success: false, message: '代理 OpenList 媒体失败' });
    } else {
      res.destroy();
    }
  }
});

// GET /stream?movieId= - 基于 movieId 的流代理
// 房间内任何成员（含观众）都通过此端点访问影片流，凭证从 Movie 表读取
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

    const movie = await movieRepository().findOneBy({ id: movieId });
    if (!movie) {
      res.status(404).json({ success: false, message: '影片不存在' });
      return;
    }
    if (!movie.serverUrl || !movie.path) {
      res.status(400).json({ success: false, message: '该影片未挂载服务器信息' });
      return;
    }

    // 规范化服务器地址（OpenList 自动补 /dav / 补 scheme）
    // 必须在凭证回退查询之前：挂载表存的 serverUrl 是 normalize 后的地址，
    // 若用未 normalize 的 movie.serverUrl 匹配会因 /dav 后缀差异而落空。
    const normalizedServerUrl = normalizeOpenListServerUrl(movie.serverUrl);

    // 凭证回退：Movie 表可能未存储 username/password（旧数据），从 UserMount 表补全
    let username = movie.username || undefined;
    let password = movie.password || undefined;
    if (!username || !password) {
      const mount = await userMountRepository().findOneBy({
        serverUrl: normalizedServerUrl,
        type: 'openlist',
      });
      if (mount) {
        username = username || mount.username || undefined;
        password = password || mount.password || undefined;
      }
    }

    // 获取 raw_url（带缓存）
    const cacheKey = `movie:${movieId}`;
    let entry: RawUrlCacheEntry;
    try {
      entry = await getCachedRawUrl(
        normalizedServerUrl,
        username,
        password,
        movie.path,
        cacheKey,
      );
    } catch (err) {
      // 缓存可能已失效（raw_url 签名过期），清理后重试一次
      invalidateRawUrlCache(cacheKey);
      try {
        entry = await getCachedRawUrl(
          normalizedServerUrl,
          username,
          password,
          movie.path,
          cacheKey,
        );
      } catch (err2) {
        const code = err2 instanceof OpenListError ? err2.code : 'UNREACHABLE';
        const status = code === 'AUTH_FAILED' ? 401 : code === 'NOT_FOUND' ? 404 : 400;
        res.status(status).json({
          success: false,
          message: extractErrorMessage(err2, '打开 OpenList 流失败'),
          code,
        });
        return;
      }
    }

    // 透传 raw_url
    const contentType = getContentType(detectMediaFormat(entry.name || movie.path));
    await proxyHttpUpstream(req, res, {
      url: entry.rawUrl,
      cors: 'wildcard',
      defaultContentType: contentType,
      logTag: 'openlist-stream',
      errorMessage: 'OpenList 影片流错误',
    });
  } catch (err) {
    console.error('[openlist] stream error:', err);
    if (!res.headersSent) {
      res.status(502).json({ success: false, message: '代理 OpenList 影片失败' });
    } else {
      res.destroy();
    }
  }
});

// ==================== 搜索（可选端点） ====================

// GET /search?mountId=&parent=&keywords= - 搜索文件
router.get('/search', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const mountIdRaw = req.query.mountId;
    const parentRaw = req.query.parent;
    const keywordsRaw = req.query.keywords;
    if (mountIdRaw === undefined || keywordsRaw === undefined) {
      res.status(400).json({ success: false, message: '缺少 mountId 或 keywords 参数' });
      return;
    }
    const mountId = Number(mountIdRaw);
    if (Number.isNaN(mountId)) {
      res.status(400).json({ success: false, message: 'mountId 不正确' });
      return;
    }
    const keywords = typeof keywordsRaw === 'string' ? keywordsRaw.trim() : '';
    if (!keywords) {
      res.status(400).json({ success: false, message: 'keywords 不能为空' });
      return;
    }
    const parent = typeof parentRaw === 'string' ? parentRaw : '/';

    const repo = userMountRepository();
    const mount = await repo.findOneBy({ id: mountId, userId: req.user!.userId, type: 'openlist' });
    if (!mount) {
      res.status(404).json({ success: false, message: '挂载不存在或无权限' });
      return;
    }
    if (!mount.serverUrl) {
      res.status(400).json({ success: false, message: '该挂载未配置服务器地址' });
      return;
    }

    try {
      const result = await searchOpenListFiles(
        mount.serverUrl,
        mount.username || undefined,
        mount.password || undefined,
        parent,
        keywords,
      );
      res.json({ success: true, entries: result.entries, total: result.total });
    } catch (err) {
      const code = err instanceof OpenListError ? err.code : 'UNREACHABLE';
      const status = code === 'AUTH_FAILED' ? 401 : 400;
      res.status(status).json({
        success: false,
        message: extractErrorMessage(err, '搜索 OpenList 文件失败'),
        code,
      });
    }
  } catch (err) {
    console.error('[openlist] search error:', err);
    res.status(500).json({ success: false, message: '搜索 OpenList 文件失败' });
  }
});

export default router;
