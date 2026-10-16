import { Client } from 'basic-ftp';
import { Readable, PassThrough } from 'node:stream';
import { TtlCache } from '../utils/ttl-cache';

const DEFAULT_TIMEOUT = 10000; // 10 秒

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} 超时`)), DEFAULT_TIMEOUT),
    ),
  ]);
}

export interface FTPConnectionParams {
  serverUrl: string;
  path: string;
  username?: string;
  password?: string;
  port?: number;
}

export interface FTPFileInfo {
  name: string;
  path: string;
  size: number;
  lastModified?: Date;
}

function parseServerUrl(serverUrl: string): { host: string; protocol?: string } {
  const trimmed = serverUrl.trim();
  if (trimmed.startsWith('ftp://') || trimmed.startsWith('ftps://')) {
    const url = new URL(trimmed);
    return { host: url.hostname, protocol: url.protocol };
  }
  return { host: trimmed.replace(/^ftp/i, '').replace(/^:\/\//, '').split('/')[0] };
}

export async function statFTPFile(
  params: FTPConnectionParams,
): Promise<FTPFileInfo> {
  return withTimeout(
    (async () => {
      const client = new Client();
      client.ftp.verbose = false;
      const { host, protocol } = parseServerUrl(params.serverUrl);
      const port = params.port || 21;
      const secure = protocol === 'ftps:';

      try {
        await client.access({
          host,
          port,
          user: params.username || 'anonymous',
          password: params.password || 'anonymous@',
          secure,
        });

        const filename = params.path.split('/').pop() || '';

        // 优先 SIZE/MDTM 单文件命令（各 1 次往返），替代 cd + LIST 全目录扫描：
        // stat 经 statFTPFileCached 服务于每次 Range 请求，高延迟 FTP 下
        // 全目录 LIST 是 seek 延迟的主要来源。SIZE/MDTM 并非所有服务器支持
        // （部分还用 550 同时表示「文件不存在」），失败时回退 cd + LIST 旧
        // 路径，错误语义保持不变（LIST 会对不存在的文件抛「FTP 文件不存在」）。
        try {
          const size = await client.size(params.path);
          let lastModified: Date | undefined;
          try {
            // MDTM 为可选命令，失败不阻塞（仅丢失时间戳）
            lastModified = await client.lastMod(params.path);
          } catch {
            lastModified = undefined;
          }
          return {
            name: filename,
            path: params.path,
            size,
            lastModified,
          };
        } catch {
          // 回退 LIST：服务器不支持 SIZE 或文件不存在
        }

        const dir = params.path.split('/').slice(0, -1).join('/') || '/';
        await client.cd(dir);
        const list = await client.list();
        const file = list.find((item) => item.name === filename && item.type === 1);
        if (!file) {
          throw new Error('FTP 文件不存在');
        }

        return {
          name: file.name,
          path: params.path,
          size: file.size,
          lastModified: file.modifiedAt,
        };
      } finally {
        client.close();
      }
    })(),
    'FTP 连接',
  );
}

// ── 文件 stat 缓存 ─────────────────────────────────────
// 视频 seek 时每个 Range 请求都要 stat 一次（一次完整 FTP 登录 + LIST），
// 叠加下载流本身的第二次连接，高延迟 FTP 下 seek 响应被显著拖慢。
// 文件大小在播放期间不会变化，短 TTL 缓存即可；文件被替换时最多 30s 后自愈。
const statCache = new Map<string, { info: FTPFileInfo; cachedAt: number }>();
const STAT_CACHE_TTL_MS = 30 * 1000; // 30 秒
const STAT_CACHE_MAX_ENTRIES = 200;

function statCacheKey(params: FTPConnectionParams): string {
  return `${params.serverUrl}|${params.port || 21}|${params.username || ''}|${params.path}`;
}

/** statFTPFile 的缓存版本：Range 流请求专用，每次 seek 少一次 FTP 登录往返。 */
export async function statFTPFileCached(
  params: FTPConnectionParams,
): Promise<FTPFileInfo> {
  const key = statCacheKey(params);
  const now = Date.now();
  const cached = statCache.get(key);
  if (cached && now - cached.cachedAt < STAT_CACHE_TTL_MS) {
    return cached.info;
  }
  const info = await statFTPFile(params);
  if (statCache.size >= STAT_CACHE_MAX_ENTRIES) {
    for (const [k, v] of statCache) {
      if (now - v.cachedAt >= STAT_CACHE_TTL_MS) statCache.delete(k);
    }
    if (statCache.size >= STAT_CACHE_MAX_ENTRIES) statCache.clear();
  }
  statCache.set(key, { info, cachedAt: now });
  return info;
}

export function createFTPReadStream(
  params: FTPConnectionParams,
  startAt = 0,
): Readable {
  const passThrough = new PassThrough();
  const client = new Client();
  client.ftp.verbose = false;
  const { host, protocol } = parseServerUrl(params.serverUrl);
  const port = params.port || 21;
  const secure = protocol === 'ftps:';

  client
    .access({
      host,
      port,
      user: params.username || 'anonymous',
      password: params.password || 'anonymous@',
      secure,
    })
    .then(async () => {
      // basic-ftp 的 downloadTo 第三参数 startAt 支持 Range 起始偏移，
      // 内部使用 REST 命令，video 元素 seek 时可按需拉取片段
      await client.downloadTo(passThrough, params.path, startAt);
    })
    .catch((err) => {
      passThrough.destroy(err);
    })
    .finally(() => {
      client.close();
    });

  return passThrough;
}

export interface FTPDirectoryEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  lastModified?: Date;
}

export async function listFTPDirectory(
  params: FTPConnectionParams,
  targetPath?: string,
): Promise<FTPDirectoryEntry[]> {
  return withTimeout(
    (async () => {
      const client = new Client();
      client.ftp.verbose = false;
      const { host, protocol } = parseServerUrl(params.serverUrl);
      const port = params.port || 21;
      const secure = protocol === 'ftps:';

      try {
        await client.access({
          host,
          port,
          user: params.username || 'anonymous',
          password: params.password || 'anonymous@',
          secure,
        });

        // 计算要列出的目录：
        // - 若 targetPath 提供，直接使用（前端传回的绝对路径，如 /folder1/subfolder）
        // - 否则使用 mount.path（默认 /）
        // 注意：原逻辑在 params.path 不以 / 结尾时会取父目录，这会导致
        // mount.path='/videos' 时实际列出根目录而非 /videos，属于 bug，此处修正。
        const dir = targetPath
          ? targetPath
          : params.path && params.path.trim()
            ? params.path
            : '/';
        // 先 cd 到目标目录，再 list 不带参数（某些 FTP 服务器不支持 LIST 绝对路径，
        // 但都支持 CWD + LIST 组合）
        await client.cd(dir);
        const list = await client.list();
        return list
          .filter((item) => item.name !== '.' && item.name !== '..')
          .map((item) => ({
            name: item.name,
            path: (dir.endsWith('/') ? dir : dir + '/') + item.name,
            type: item.type === 1 ? 'file' : 'directory',
            size: item.size,
            lastModified: item.modifiedAt,
          }));
      } finally {
        client.close();
      }
    })(),
    'FTP 连接',
  );
}

/**
 * 目录缓存（60s TTL，对齐 WebDAV webdavDirCache）：浏览界面反复进出目录
 * 免重复 FTP 登录+LIST（每次列目录都是一次完整连接生命周期）。
 * 仅 browse 路由使用，mounts/test 保持直连不缓存（防陈旧缓存误报连通）。
 */
const ftpDirCache = new TtlCache<FTPDirectoryEntry[]>({
  ttlMs: 60 * 1000,
  maxSize: 300,
});

/** listFTPDirectory 的缓存版本：浏览界面专用。 */
export async function listFTPDirectoryCached(
  params: FTPConnectionParams,
  targetPath?: string,
): Promise<FTPDirectoryEntry[]> {
  const dir = targetPath ?? params.path ?? '/';
  const key = `${params.serverUrl}|${params.port || 21}|${params.username || ''}|${dir}`;
  const cached = ftpDirCache.get(key);
  if (cached) {
    return cached;
  }
  const data = await listFTPDirectory(params, targetPath);
  ftpDirCache.set(key, data);
  return data;
}
