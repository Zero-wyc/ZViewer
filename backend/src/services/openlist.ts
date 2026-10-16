/**
 * OpenList 服务层（v2 重构）
 *
 * 基于 AList HTTP API 实现的完整 OpenList 服务层，参考 synctv/vendors/alist 的设计。
 * 不再复用 WebDAV 协议，直接调用 AList 的 /api/auth/login、/api/fs/get、/api/fs/list 等
 * HTTP API，配合 token 缓存层实现高性能访问。
 *
 * 关键改进：
 * 1. token 缓存：避免每次请求重新登录（原实现每次 /stream 都重新登录）
 * 2. raw_url 直链代理：通过 AList /api/fs/get 获取带签名的真实直链，再用 HTTP 代理透传
 * 3. 密码哈希：支持 /api/auth/login/hash 端点，避免明文密码传输
 * 4. 字幕自动发现：通过 FsGet 的 related 字段识别同目录字幕文件
 *
 * 对外提供：
 * - 高层 API：getOpenListToken / statOpenListFile / listOpenListDirectory / searchOpenListFiles
 * - 直链获取：fetchOpenListDirectUrl（保留旧接口，内部改用新实现）
 * - 浏览目录：listOpenListDirectory（替换原 listWebDAVDirectoryCached）
 * - 兼容层：mountToOpenListParams（已废弃，仅保留以避免破坏外部导入）
 */
import {
  alistFsGet,
  alistFsList,
  alistFsSearch,
  alistMe,
  isAlistHashedPassword,
  toApiBaseUrl,
  type AlistFsGetData,
  type AlistFsListData,
  type AlistFsSearchData,
  type AlistMeData,
} from './openlist-client';
import { OpenListError, normalizeOpenListServerUrl } from './openlist-errors';
import { getOpenListToken, invalidateOpenListToken } from './openlist-token-cache';
import { TtlCache } from '../utils/ttl-cache';

// 导出错误类型和工具函数供路由使用
export { OpenListError, normalizeOpenListServerUrl, isInternalOpenListServer, isInternalNetworkHost } from './openlist-errors';
export type { OpenListErrorCode } from './openlist-errors';

/**
 * AList 直链响应数据（包含 raw_url、provider、related 字幕列表）。
 */
export interface OpenListDirectUrlResult {
  /** 带签名的真实下载直链（可直接在浏览器播放或经服务器代理） */
  rawUrl: string;
  /** 文件名 */
  name: string;
  /** 文件大小（字节） */
  size: number;
  /** 存储后端类型（如 AliyundriveOpen、115 Cloud、WebDAV 等） */
  provider: string;
  /** 同目录相关的字幕文件（type === 4 的 related 项） */
  subtitles: Array<{ name: string; rawUrl: string }>;
}

/**
 * 浏览目录条目（统一格式）。
 */
export interface OpenListBrowseEntry {
  name: string;
  size: number;
  isDir: boolean;
  type: number;
  modified: string;
  sign: string;
  thumb: string;
}

export interface OpenListBrowseResult {
  entries: OpenListBrowseEntry[];
  total: number;
  provider: string;
  readme: string;
}

/**
 * 解析 OpenList 登录方式。
 *
 * 密码存储约定：
 * - 新数据（v2 重构后）：路由层在创建/更新时通过 hashAlistPassword 哈希，
 *   password 字段始终存储 64 位十六进制的 SHA-256 哈希值，走 /api/auth/login/hash。
 * - 旧数据（v2 重构前）：password 字段存储明文，走 /api/auth/login。
 *
 * 区分方式：通过 isAlistHashedPassword 判断是否为 64 位十六进制格式。
 * 新数据必然命中哈希分支；旧明文密码通常不会恰好是 64 位十六进制（极罕见误判）。
 *
 * 参考：synctv/server/handlers/vendors/vendorAlist/login.go
 * synctv 在后端将明文密码哈希后存储，始终使用 /api/auth/login/hash 端点。
 */
function detectLoginMode(password: string | undefined): 'plain' | 'hash' {
  return isAlistHashedPassword(password) ? 'hash' : 'plain';
}

/**
 * 获取 OpenList 文件的直链与元信息。
 *
 * 流程：
 * 1. 通过 token 缓存层获取 token（匿名场景跳过）
 * 2. 调用 /api/fs/get 获取 raw_url、provider、related（同目录字幕）
 * 3. 解析 related 中的字幕文件（type === 4）并返回
 *
 * @param serverUrl  OpenList 服务器地址（可含 /dav 后缀）
 * @param username   用户名（空表示匿名）
 * @param password   密码（明文或哈希值，自动识别）
 * @param path       文件在 OpenList 中的绝对路径
 * @returns 直链与元信息
 */
export async function fetchOpenListDirectUrl(
  serverUrl: string,
  username: string | undefined,
  password: string | undefined,
  path: string,
): Promise<string> {
  const result = await fetchOpenListFileInfo(serverUrl, username, password, path);
  return result.rawUrl;
}

/**
 * 获取 OpenList 文件完整信息（含直链、provider、字幕）。
 * 保留 401 自动重试一次（token 失效场景）。
 */
export async function fetchOpenListFileInfo(
  serverUrl: string,
  username: string | undefined,
  password: string | undefined,
  path: string,
): Promise<OpenListDirectUrlResult> {
  const mode = detectLoginMode(password);
  const normalizedUrl = normalizeOpenListServerUrl(serverUrl);
  const apiBaseUrl = toApiBaseUrl(normalizedUrl);

  // 解码 path（前端可能传入 URL 编码的路径）
  let targetPath: string;
  try {
    targetPath = decodeURIComponent(path);
  } catch {
    targetPath = path;
  }
  if (!targetPath.startsWith('/')) {
    targetPath = '/' + targetPath;
  }

  // 内部 FsGet，带 401 自动重试
  const fsGetWithRetry = async (): Promise<AlistFsGetData> => {
    const token = await getOpenListToken(serverUrl, username, password, mode);
    try {
      return await alistFsGet(apiBaseUrl, token, targetPath, undefined);
    } catch (err) {
      // token 过期：失效缓存并重试一次
      if (err instanceof OpenListError && err.code === 'AUTH_FAILED' && token) {
        invalidateOpenListToken(serverUrl, username);
        const newToken = await getOpenListToken(serverUrl, username, password, mode);
        return await alistFsGet(apiBaseUrl, newToken, targetPath, undefined);
      }
      throw err;
    }
  };

  let fsData: AlistFsGetData;
  try {
    fsData = await fsGetWithRetry();
  } catch (err) {
    // 提供更友好的错误消息
    if (err instanceof OpenListError) {
      if (err.code === 'AUTH_FAILED') {
        throw new OpenListError(
          'OpenList 认证失败，请检查挂载的用户名和密码',
          'AUTH_FAILED',
        );
      }
      if (err.code === 'NOT_FOUND') {
        throw new OpenListError(`文件不存在或路径错误: ${targetPath}`, 'NOT_FOUND');
      }
    }
    throw err;
  }

  // 处理相对路径的 raw_url（AList 未配置 site_url 时）
  let rawUrl = fsData.raw_url;
  if (rawUrl && !rawUrl.startsWith('http://') && !rawUrl.startsWith('https://')) {
    rawUrl = `${apiBaseUrl}${rawUrl.startsWith('/') ? rawUrl : '/' + rawUrl}`;
  }
  if (!rawUrl) {
    throw new OpenListError('OpenList 未返回 raw_url', 'UNREACHABLE');
  }

  // 解析同目录字幕文件（related 中 type === 4 的项）
  const subtitles: Array<{ name: string; rawUrl: string }> = [];
  if (fsData.related && fsData.related.length > 0) {
    const prefix = targetPath.replace(/\/[^/]*$/, '/');
    for (const related of fsData.related) {
      // type === 4 表示字幕文件（AList 约定）
      if (related.type !== 4) continue;
      // 跳过 XML 字幕（通常是弹幕元数据，非文本字幕）
      if (related.name.toLowerCase().endsWith('.xml')) continue;
      try {
        const subtitlePath = prefix + related.name;
        const subToken = await getOpenListToken(serverUrl, username, password, mode);
        const subFs = await alistFsGet(apiBaseUrl, subToken, subtitlePath, undefined);
        let subRawUrl = subFs.raw_url;
        if (subRawUrl && !subRawUrl.startsWith('http://') && !subRawUrl.startsWith('https://')) {
          subRawUrl = `${apiBaseUrl}${subRawUrl.startsWith('/') ? subRawUrl : '/' + subRawUrl}`;
        }
        if (subRawUrl) {
          subtitles.push({ name: related.name, rawUrl: subRawUrl });
        }
      } catch {
        // 字幕获取失败不影响主流程
      }
    }
  }

  return {
    rawUrl,
    name: fsData.name,
    size: fsData.size,
    provider: fsData.provider,
    subtitles,
  };
}

/**
 * 浏览 OpenList 目录（用于挂载点浏览界面）。
 */
export async function listOpenListDirectory(
  serverUrl: string,
  username: string | undefined,
  password: string | undefined,
  path: string,
  page: number = 1,
  perPage: number = 100,
): Promise<OpenListBrowseResult> {
  const mode = detectLoginMode(password);
  const normalizedUrl = normalizeOpenListServerUrl(serverUrl);
  const apiBaseUrl = toApiBaseUrl(normalizedUrl);

  let targetPath: string;
  try {
    targetPath = decodeURIComponent(path);
  } catch {
    targetPath = path;
  }
  if (!targetPath.startsWith('/')) {
    targetPath = '/' + targetPath;
  }

  const listWithRetry = async (): Promise<AlistFsListData> => {
    const token = await getOpenListToken(serverUrl, username, password, mode);
    try {
      return await alistFsList(apiBaseUrl, token, targetPath, undefined, page, perPage, false);
    } catch (err) {
      if (err instanceof OpenListError && err.code === 'AUTH_FAILED' && token) {
        invalidateOpenListToken(serverUrl, username);
        const newToken = await getOpenListToken(serverUrl, username, password, mode);
        return await alistFsList(apiBaseUrl, newToken, targetPath, undefined, page, perPage, false);
      }
      throw err;
    }
  };

  const data = await listWithRetry();
  return {
    entries: (data.content || []).map((e) => ({
      name: e.name,
      size: e.size,
      isDir: e.is_dir,
      type: e.type,
      modified: e.modified,
      sign: e.sign,
      thumb: e.thumb,
    })),
    total: data.total,
    provider: data.provider,
    readme: data.readme,
  };
}

/**
 * 目录浏览缓存（60s TTL，对齐 WebDAV webdavDirCache）。
 * 浏览界面反复进出/翻页时免重复登录上游 AList API；
 * 仅 browse 路由使用，mounts/test 保持直连不缓存（防陈旧缓存误报连通）。
 */
const openListDirCache = new TtlCache<OpenListBrowseResult>({
  ttlMs: 60 * 1000,
  maxSize: 300,
});

/** listOpenListDirectory 的缓存版本：浏览界面专用。 */
export async function listOpenListDirectoryCached(
  serverUrl: string,
  username: string | undefined,
  password: string | undefined,
  path: string,
  page: number = 1,
  perPage: number = 100,
): Promise<OpenListBrowseResult> {
  const key = `${serverUrl}|${username || ''}|${path}|${page}|${perPage}`;
  const cached = openListDirCache.get(key);
  if (cached) {
    return cached;
  }
  const data = await listOpenListDirectory(serverUrl, username, password, path, page, perPage);
  openListDirCache.set(key, data);
  return data;
}

/**
 * 搜索 OpenList 文件。
 */
export async function searchOpenListFiles(
  serverUrl: string,
  username: string | undefined,
  password: string | undefined,
  parent: string,
  keywords: string,
  page: number = 1,
  perPage: number = 100,
): Promise<OpenListBrowseResult> {
  const mode = detectLoginMode(password);
  const normalizedUrl = normalizeOpenListServerUrl(serverUrl);
  const apiBaseUrl = toApiBaseUrl(normalizedUrl);

  const searchWithRetry = async (): Promise<AlistFsSearchData> => {
    const token = await getOpenListToken(serverUrl, username, password, mode);
    try {
      return await alistFsSearch(apiBaseUrl, token, parent, keywords, undefined, page, perPage);
    } catch (err) {
      if (err instanceof OpenListError && err.code === 'AUTH_FAILED' && token) {
        invalidateOpenListToken(serverUrl, username);
        const newToken = await getOpenListToken(serverUrl, username, password, mode);
        return await alistFsSearch(apiBaseUrl, newToken, parent, keywords, undefined, page, perPage);
      }
      throw err;
    }
  };

  const data = await searchWithRetry();
  return {
    entries: (data.content || []).map((e) => ({
      name: e.name,
      size: e.size,
      isDir: e.is_dir,
      type: e.type,
      modified: '',
      sign: '',
      thumb: '',
    })),
    total: data.total,
    provider: '',
    readme: '',
  };
}

/**
 * 测试 OpenList 服务器连通性（挂载添加/编辑时调用）。
 */
export async function testOpenListConnection(
  serverUrl: string,
  username: string | undefined,
  password: string | undefined,
): Promise<{ ok: true; username?: string } | { ok: false; message: string; code: string }> {
  try {
    const mode = detectLoginMode(password);
    const token = await getOpenListToken(serverUrl, username, password, mode);
    // 尝试列出根目录验证访问权限
    const normalizedUrl = normalizeOpenListServerUrl(serverUrl);
    const apiBaseUrl = toApiBaseUrl(normalizedUrl);
    await alistFsList(apiBaseUrl, token, '/', undefined, 1, 1, false);
    return { ok: true, username: username || undefined };
  } catch (err) {
    const message =
      err instanceof OpenListError
        ? err.message
        : err instanceof Error
          ? err.message
          : 'OpenList 不可访问';
    const code = err instanceof OpenListError ? err.code : 'UNREACHABLE';
    return { ok: false, message, code };
  }
}

/**
 * 获取 AList 当前用户信息（用户中心页面展示用）。
 */
export async function getOpenListUserMe(
  serverUrl: string,
  username: string | undefined,
  password: string | undefined,
): Promise<AlistMeData | null> {
  const mode = detectLoginMode(password);
  const token = await getOpenListToken(serverUrl, username, password, mode);
  if (!token) return null;
  const normalizedUrl = normalizeOpenListServerUrl(serverUrl);
  const apiBaseUrl = toApiBaseUrl(normalizedUrl);
  try {
    return await alistMe(apiBaseUrl, token);
  } catch (err) {
    if (err instanceof OpenListError && err.code === 'AUTH_FAILED') {
      invalidateOpenListToken(serverUrl, username);
    }
    throw err;
  }
}
