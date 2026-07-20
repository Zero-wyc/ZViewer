import { Connection, BasicAuthenticator } from 'webdav-client';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';

const DEFAULT_TIMEOUT = 10000; // 10 秒

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new WebDAVError(`${label} 超时`, 'TIMEOUT')), DEFAULT_TIMEOUT),
    ),
  ]);
}

// 错误类型：携带错误码便于上层路由处理
export class WebDAVError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'WebDAVError';
    this.code = code;
  }
}

// 将底层抛出的异常包装为 WebDAVError，便于路由层根据 code 返回对应 HTTP 状态
function wrapWebDAVError(err: unknown): WebDAVError {
  if (err instanceof WebDAVError) return err;
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();

  if (lower.includes('timeout') || lower.includes('超时')) {
    return new WebDAVError(message, 'TIMEOUT');
  }
  if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('auth')) {
    return new WebDAVError(message, 'AUTH_FAILED');
  }
  if (lower.includes('404') || lower.includes('not found') || lower.includes('不存在')) {
    return new WebDAVError(message, 'NOT_FOUND');
  }
  return new WebDAVError(message, 'UNREACHABLE');
}

export interface WebDAVConnectionParams {
  serverUrl: string;
  path: string;
  username?: string;
  password?: string;
}

export interface WebDAVFileInfo {
  name: string;
  path: string;
  size: number;
  lastModified?: Date;
}

function normalizePath(path: string): string {
  let normalized = path.trim();
  if (!normalized.startsWith('/')) normalized = '/' + normalized;
  // webdav-client 的 readdir/stat 等方法会把 path 直接拼到 URL，
  // 包含中文/空格等非 ASCII 字符时底层 http 库会抛
  // "Request path contains unescaped characters" 错误。
  // 对每段单独 encodeURIComponent，保留 / 分隔符。
  // 先 tryDecode 避免前端已编码过的路径被二次编码。
  return normalized
    .split('/')
    .map((seg) => {
      if (!seg) return seg;
      try {
        const decoded = decodeURIComponent(seg);
        return encodeURIComponent(decoded);
      } catch {
        return encodeURIComponent(seg);
      }
    })
    .join('/');
}

function normalizeServerUrl(url: string): string {
  let normalized = url.trim();
  while (normalized.endsWith('/')) normalized = normalized.slice(0, -1);
  return normalized;
}

// 计算 serverUrl 的 path 前缀，用于从 DAV 服务器返回的 href 中剥离
// 例如 serverUrl = "http://host/dav"，则前缀为 "/dav"
function getServerPathPrefix(serverUrl: string): string {
  try {
    const parsed = new URL(normalizeServerUrl(serverUrl));
    let pathname = parsed.pathname;
    while (pathname.endsWith('/')) pathname = pathname.slice(0, -1);
    return pathname;
  } catch {
    return '';
  }
}

// 将 DAV 服务器返回的 href 转换为相对 webdav 根的路径
// 例如 href="/dav/folder1"，serverUrl="http://host/dav"，返回 "/folder1"
// 这样转换后的路径可以直接传给 connection.readdir/stat/get
function hrefToWebDAVPath(href: string, serverUrl: string): string {
  if (!href) return '/';
  let pathname = href;
  // 若 href 是完整 URL（含协议），先取 pathname
  try {
    const parsed = new URL(href);
    pathname = parsed.pathname;
  } catch {
    // 不是完整 URL，保持原样
  }
  // 剥离 serverUrl 的 path 前缀（如 /dav）
  const prefix = getServerPathPrefix(serverUrl);
  if (prefix && prefix !== '/' && pathname.startsWith(prefix)) {
    pathname = pathname.slice(prefix.length);
  }
  if (!pathname.startsWith('/')) pathname = '/' + pathname;
  // 去除末尾斜杠（根路径除外）
  while (pathname.length > 1 && pathname.endsWith('/')) {
    pathname = pathname.slice(0, -1);
  }
  return pathname;
}

function createConnection(params: WebDAVConnectionParams): Connection {
  // webdav-client 库不会自动根据 username/password 发送 Basic Auth 头，
  // 必须显式传入 authenticator 才会在请求中添加 Authorization 头。
  const hasCredentials = !!(params.username || params.password);
  return new Connection({
    url: normalizeServerUrl(params.serverUrl),
    username: params.username || undefined,
    password: params.password || undefined,
    authenticator: hasCredentials ? new BasicAuthenticator() : undefined,
  });
}

export async function statWebDAVFile(
  params: WebDAVConnectionParams,
): Promise<WebDAVFileInfo> {
  try {
    return await withTimeout(
      (async () => {
        const connection = createConnection(params);
        const getProperties = promisify(connection.getProperties.bind(connection));
        // webdav-client getProperties 返回的属性名带 DAV: 命名空间前缀
        const props = (await getProperties(normalizePath(params.path))) as Record<
          string,
          { content?: string | unknown[] }
        >;

        const lenProp = props['DAV:getcontentlength'];
        const lenRaw = Array.isArray(lenProp?.content)
          ? undefined
          : lenProp?.content;
        const size = lenRaw !== undefined ? Number(lenRaw) || 0 : 0;

        const nameProp = props['DAV:displayname'];
        const nameRaw = Array.isArray(nameProp?.content)
          ? undefined
          : nameProp?.content;
        const name =
          (typeof nameRaw === 'string' && nameRaw) ||
          params.path.split('/').filter(Boolean).pop() ||
          '';

        const mtimeProp = props['DAV:getlastmodified'];
        const mtimeRaw = Array.isArray(mtimeProp?.content)
          ? undefined
          : mtimeProp?.content;
        const lastModified =
          typeof mtimeRaw === 'string' ? new Date(mtimeRaw) : undefined;

        return {
          name,
          path: params.path,
          size,
          lastModified,
        };
      })(),
      'WebDAV 连接',
    );
  } catch (err) {
    throw wrapWebDAVError(err);
  }
}

export function createWebDAVReadStream(
  params: WebDAVConnectionParams,
): Readable {
  const connection = createConnection(params);
  return connection.get(normalizePath(params.path)) as Readable;
}

export interface WebDAVDirectoryEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  lastModified?: Date;
}

export async function listWebDAVDirectory(
  params: WebDAVConnectionParams,
  targetPath?: string,
): Promise<WebDAVDirectoryEntry[]> {
  try {
    return await withTimeout(
      (async () => {
        try {
          const connection = createConnection(params);
          const listPath = targetPath
            ? normalizePath(targetPath)
            : params.path.endsWith('/')
              ? normalizePath(params.path)
              : normalizePath(params.path.split('/').slice(0, -1).join('/') || '/');
          const readdir = promisify(
            connection.readdir.bind(connection) as (
              path: string,
              options: { properties?: boolean; extraProperties?: unknown[] },
              callback: (error: Error, files?: unknown[]) => void,
            ) => void,
          );
          const entries = (await readdir(listPath, {
            properties: true,
            extraProperties: [],
          })) as Array<{
            name?: string;
            href?: string;
            isDirectory?: boolean;
            size?: number;
            lastModified?: Date;
          }>;
          return entries.map((entry) => ({
            name: entry.name || '',
            // 将 DAV 服务器返回的 href（如 /dav/folder1）转换为相对 webdav 根的路径（/folder1）
            // 避免前端把带前缀的路径回传给后端时造成路径重复（/dav/dav/folder1）导致 404
            path: entry.href
              ? hrefToWebDAVPath(entry.href, params.serverUrl)
              : '',
            type: entry.isDirectory ? 'directory' : 'file',
            size: typeof entry.size === 'number' ? entry.size : undefined,
            lastModified: entry.lastModified,
          }));
        } catch (err) {
          throw wrapWebDAVError(err);
        }
      })(),
      'WebDAV 连接',
    );
  } catch (err) {
    throw wrapWebDAVError(err);
  }
}

// 解析 HTTP Range 头，返回 start/end（end 为包含的闭区间边界）
function parseRangeHeader(rangeHeader: string, fileSize: number): { start: number; end: number } {
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) {
    return { start: 0, end: fileSize - 1 };
  }
  const startStr = match[1];
  const endStr = match[2];
  let start: number;
  let end: number;
  if (startStr === '' && endStr === '') {
    start = 0;
    end = fileSize - 1;
  } else if (startStr === '') {
    // 后缀范围：取最后 N 字节
    const suffix = parseInt(endStr, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) {
      return { start: 0, end: fileSize - 1 };
    }
    start = Math.max(0, fileSize - suffix);
    end = fileSize - 1;
  } else {
    start = parseInt(startStr, 10);
    end = endStr === '' ? fileSize - 1 : parseInt(endStr, 10);
  }
  if (!Number.isFinite(start) || start < 0) start = 0;
  if (!Number.isFinite(end) || end >= fileSize) end = fileSize - 1;
  if (start > end) start = end;
  return { start, end };
}

// 创建带 Range 的 WebDAV 读取流；未提供 rangeHeader 时返回完整流
export async function createWebDAVReadStreamWithRange(
  params: WebDAVConnectionParams,
  rangeHeader?: string,
): Promise<{ stream: Readable; fileSize: number; start: number; end: number }> {
  const info = await statWebDAVFile(params);
  const fileSize = info.size;

  if (!rangeHeader || !rangeHeader.trim()) {
    const stream = createWebDAVReadStream(params);
    return { stream, fileSize, start: 0, end: fileSize - 1 };
  }

  const { start, end } = parseRangeHeader(rangeHeader, fileSize);
  const connection = createConnection(params);
  // webdav-client 的 connection.get 不支持 range 选项，需直接构造 stream 请求
  // 通过 connection.stream({ url, method, headers }) 发送带 Range 头的 GET 请求
  const streamFn = connection.stream.bind(connection) as unknown as (
    options: {
      url: string;
      method: string;
      headers?: Record<string, string>;
    },
  ) => Readable;
  const stream = streamFn({
    url: normalizePath(params.path),
    method: 'GET',
    headers: {
      Range: `bytes=${start}-${end}`,
    },
  });
  return { stream, fileSize, start, end };
}

// 目录缓存：key=`${mountId}:${targetPath || params.path}`
const webdavDirCache = new Map<string, { data: WebDAVDirectoryEntry[]; cachedAt: number }>();
const WEBDAV_CACHE_TTL_MS = 60 * 1000; // 60 秒

// 优先读缓存，缓存过期或不存在时调用 listWebDAVDirectory
export async function listWebDAVDirectoryCached(
  params: WebDAVConnectionParams,
  mountId: number,
  targetPath?: string,
): Promise<WebDAVDirectoryEntry[]> {
  const cacheKey = `${mountId}:${targetPath || params.path}`;
  const now = Date.now();
  const cached = webdavDirCache.get(cacheKey);
  if (cached && now - cached.cachedAt < WEBDAV_CACHE_TTL_MS) {
    return cached.data;
  }

  const data = await listWebDAVDirectory(params, targetPath);
  webdavDirCache.set(cacheKey, { data, cachedAt: now });
  return data;
}
