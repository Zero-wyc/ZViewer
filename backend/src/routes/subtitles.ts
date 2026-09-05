/**
 * 字幕自动搜索 & 目录浏览路由
 *
 * 挂载路径：/api/subtitles
 *
 * 功能：
 *   GET /search?movieId=           搜索影片同目录下的同名字幕文件
 *   GET /browse?movieId=&path=     浏览影片所在目录（或指定子目录），返回文件列表
 *   GET /load?movieId=&path=       读取指定字幕文件内容
 *
 * 设计要点：
 * - 通过 movieId 从 Movie 表获取 source/path/serverUrl/username/password
 * - 支持 webdav / openlist（AList HTTP API）/ ftp / server-files 四种源
 * - browse 返回统一格式的文件列表（name/path/type/isSubtitle）
 * - load 返回字幕文件内容（非 URL），前端解析后转为 data URL 供 socket 同步
 *
 * v2 重构：OpenList 不再复用 WebDAV 协议，改用 AList HTTP API
 * （listOpenListDirectory / fetchOpenListFileInfo），密码使用 SHA-256 哈希。
 */
import { Router, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { AppDataSource } from '../data-source';
import { Movie } from '../entities/Movie';
import { UserMount } from '../entities/UserMount';
import { ServerFolder } from '../entities/ServerFolder';
import { authenticateToken, type AuthenticatedRequest } from '../middleware/auth';

// WebDAV 服务（仅用于 webdav 源）
import {
  listWebDAVDirectory,
  createWebDAVReadStream,
  buildWebDAVDirectUrl,
  type WebDAVConnectionParams,
} from '../services/webdav';

// OpenList 服务（AList HTTP API，用于 openlist 源）
import {
  listOpenListDirectory,
  fetchOpenListFileInfo,
  type OpenListBrowseEntry,
} from '../services/openlist';

// FTP 服务
import {
  listFTPDirectory,
  createFTPReadStream,
  type FTPConnectionParams,
} from '../services/ftp';

// 服务器文件服务
import {
  UPLOADS_ROOT_KEY,
  getUploadsRoot,
  resolveSafePath,
  type RootRegistry,
} from '../services/server-files/pathResolver';

// Emby 字幕（直接调用 Emby 自带的字幕接口）
import { EmbyClient, createEmbyClientFromMount } from '../services/emby-client';

const router = Router();

// 所有字幕搜索接口需要认证
router.use(authenticateToken);

/** ServerFolder 仓库。 */
const folderRepo = () => AppDataSource.getRepository(ServerFolder);

/**
 * 加载所有根目录到注册表。
 * uploads 根始终存在；自定义根按数据库记录注册。
 */
async function loadRootRegistry(): Promise<RootRegistry> {
  const map: RootRegistry = new Map();
  map.set(UPLOADS_ROOT_KEY, getUploadsRoot());
  const folders = await folderRepo().find({ order: { id: 'ASC' } });
  for (const f of folders) {
    const key = `custom:${f.id}`;
    map.set(key, {
      key,
      name: f.name,
      absPath: path.resolve(f.absPath),
      readonly: !!f.readonly,
    });
  }
  return map;
}

/**
 * 从 UserMount 表补全 WebDAV/OpenList/FTP 凭证。
 *
 * 已有电影可能在创建时未存储 username/password（旧版本前端不传凭证），
 * 此函数按 serverUrl 跨所有用户查找匹配的挂载记录，回填缺失的凭证。
 */
async function fillCredentialsFromMount(
  movie: Movie,
): Promise<{ username?: string; password?: string }> {
  if (!movie.serverUrl) return {};
  // 电影本身已有完整凭证，无需回退
  if (movie.username && movie.password) {
    return { username: movie.username, password: movie.password };
  }
  const source = (movie.source || '').toLowerCase();
  const mountType = source === 'openlist' ? 'openlist' : source === 'ftp' ? 'ftp' : 'webdav';
  const mount = await AppDataSource.getRepository(UserMount).findOneBy({
    serverUrl: movie.serverUrl,
    type: mountType as 'webdav' | 'openlist' | 'ftp',
  });
  if (mount) {
    return {
      username: movie.username || mount.username || undefined,
      password: movie.password || mount.password || undefined,
    };
  }
  return {
    username: movie.username || undefined,
    password: movie.password || undefined,
  };
}

/** 支持的字幕扩展名 */
const SUBTITLE_EXTS = ['.vtt', '.srt', '.ass', '.ssa', '.smi', '.sami', '.sub'];

/** 从文件名提取扩展名（小写） */
function getExt(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot >= 0 ? filename.slice(dot).toLowerCase() : '';
}

/** 从路径中提取文件名 */
function basename(filePath: string): string {
  const parts = filePath.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || '';
}

/** 从路径中提取所在目录路径 */
function dirname(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/');
  return idx >= 0 ? normalized.slice(0, idx) : '/';
}

/** 从文件名中去除扩展名 */
function stripExt(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(0, dot) : filename;
}

/** 将流读取为字符串 */
function streamToString(
  stream: import('node:stream').Readable,
  maxBytes = 2 * 1024 * 1024, // 2MB 上限
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    stream.on('data', (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > maxBytes) {
        stream.destroy();
        reject(new Error('字幕文件过大（超过 2MB）'));
        return;
      }
      chunks.push(chunk);
    });
    stream.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf-8'));
    });
    stream.on('error', reject);
  });
}

/**
 * 通过 AList HTTP API 读取 OpenList 文件内容。
 *
 * 流程：
 * 1. 调用 fetchOpenListFileInfo 获取带签名的 raw_url
 * 2. HTTP GET raw_url 读取文件字节流
 * 3. 转为 UTF-8 字符串返回
 *
 * 与 createWebDAVReadStream 不同，此函数走 AList 的 /api/fs/get 端点，
 * 使用 SHA-256 哈希密码（通过 /api/auth/login/hash 登录），不再依赖 WebDAV 协议。
 *
 * @param serverUrl  OpenList 服务器地址（可含 /dav 后缀）
 * @param username   用户名（匿名场景为 undefined）
 * @param password   哈希密码（由路由层 normalizePasswordForStorage 生成）
 * @param filePath   文件在 OpenList 中的绝对路径
 * @returns 文件文本内容
 */
async function readOpenListFileContent(
  serverUrl: string,
  username: string | undefined,
  password: string | undefined,
  filePath: string,
  maxBytes = 2 * 1024 * 1024,
): Promise<string> {
  const info = await fetchOpenListFileInfo(serverUrl, username, password, filePath);
  if (!info.rawUrl) {
    throw new Error('OpenList 未返回文件直链');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(info.rawUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`OpenList 读取字幕失败: HTTP ${res.status}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) {
      throw new Error('字幕文件过大（超过 2MB）');
    }
    return buf.toString('utf-8');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 将 OpenList 目录条目转换为字幕路由统一的 BrowseEntry 格式。
 *
 * OpenList 的 entry.isDir 对应 WebDAV 的 type='directory'，
 * 其他字段（name/size）语义一致。
 */
function openListEntryToBrowseEntry(
  entry: OpenListBrowseEntry,
  dirPath: string,
): { name: string; path: string; type: 'file' | 'directory'; size?: number } {
  const itemPath = dirPath.endsWith('/')
    ? `${dirPath}${entry.name}`
    : `${dirPath}/${entry.name}`;
  return {
    name: entry.name,
    path: itemPath,
    type: entry.isDir ? 'directory' : 'file',
    size: entry.size,
  };
}

interface SubtitleSearchResult {
  filename: string;
  format: string;
  content: string;
}

/**
 * GET /search?movieId=
 *
 * 根据影片 ID 搜索同目录下的字幕文件，返回匹配的字幕内容。
 *
 * 响应：
 *   200 { success: true, subtitles: SubtitleSearchResult[] }
 *   400/404/500 { success: false, message: string }
 */
router.get('/search', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
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

    const movie = await AppDataSource.getRepository(Movie).findOneBy({ id: movieId });
    if (!movie) {
      res.status(404).json({ success: false, message: '影片不存在' });
      return;
    }

    const source = (movie.source || '').toLowerCase();
    if (!['webdav', 'openlist', 'ftp', 'server-files'].includes(source)) {
      // 非文件源类型（如 bilibili），不支持字幕搜索
      res.json({ success: true, subtitles: [] });
      return;
    }

    if (!movie.path) {
      res.json({ success: true, subtitles: [] });
      return;
    }

    const videoFilename = basename(movie.path);
    const videoBasename = stripExt(videoFilename);
    const dirPath = dirname(movie.path);

    if (!videoBasename) {
      res.json({ success: true, subtitles: [] });
      return;
    }

    // 列出目录内容并读取匹配的字幕文件
    const subtitles: SubtitleSearchResult[] = [];

    // 回退查询 UserMount 补全凭证（兼容旧电影未存储凭证的情况）
    const creds = source !== 'server-files' ? await fillCredentialsFromMount(movie) : {};

    if (source === 'server-files') {
      // ── 服务器文件 ──
      const roots = await loadRootRegistry();
      const { abs: dirAbs } = resolveSafePath(dirPath, roots);
      if (!fs.existsSync(dirAbs) || !fs.statSync(dirAbs).isDirectory()) {
        res.json({ success: true, subtitles: [] });
        return;
      }
      const files = fs.readdirSync(dirAbs);
      for (const file of files) {
        const ext = getExt(file);
        if (!SUBTITLE_EXTS.includes(ext)) continue;
        if (!file.toLowerCase().startsWith(videoBasename.toLowerCase())) continue;

        const filePath = dirPath.endsWith('/')
          ? `${dirPath}${file}`
          : `${dirPath}/${file}`;
        const { abs: fileAbs } = resolveSafePath(filePath, roots);
        try {
          const content = fs.readFileSync(fileAbs, 'utf-8');
          subtitles.push({ filename: file, format: ext.slice(1), content });
        } catch (err) {
          console.warn(`[subtitles] 读取字幕文件失败: ${file}`, err);
        }
      }
    } else if (source === 'ftp') {
      // ── FTP ──
      if (!movie.serverUrl) {
        res.json({ success: true, subtitles: [] });
        return;
      }
      const params: FTPConnectionParams = {
        serverUrl: movie.serverUrl,
        path: dirPath,
        port: undefined,
        username: creds.username,
        password: creds.password,
      };
      const entries = await listFTPDirectory(params, dirPath);
      for (const entry of entries) {
        if (entry.type !== 'file') continue;
        const ext = getExt(entry.name);
        if (!SUBTITLE_EXTS.includes(ext)) continue;
        if (!entry.name.toLowerCase().startsWith(videoBasename.toLowerCase())) continue;

        const filePath = dirPath.endsWith('/')
          ? `${dirPath}${entry.name}`
          : `${dirPath}/${entry.name}`;
        try {
          const readParams: FTPConnectionParams = {
            serverUrl: movie.serverUrl,
            path: filePath,
            port: undefined,
            username: creds.username,
            password: creds.password,
          };
          const stream = createFTPReadStream(readParams, 0);
          const content = await streamToString(stream);
          subtitles.push({ filename: entry.name, format: ext.slice(1), content });
        } catch (err) {
          console.warn(`[subtitles] FTP 读取字幕文件失败: ${entry.name}`, err);
        }
      }
    } else if (source === 'openlist') {
      // ── OpenList（AList HTTP API，密码为 SHA-256 哈希）──
      if (!movie.serverUrl) {
        res.json({ success: true, subtitles: [] });
        return;
      }
      const result = await listOpenListDirectory(
        movie.serverUrl,
        creds.username,
        creds.password,
        dirPath,
      );
      for (const entry of result.entries) {
        if (entry.isDir) continue;
        const ext = getExt(entry.name);
        if (!SUBTITLE_EXTS.includes(ext)) continue;
        if (!entry.name.toLowerCase().startsWith(videoBasename.toLowerCase())) continue;

        const filePath = dirPath.endsWith('/')
          ? `${dirPath}${entry.name}`
          : `${dirPath}/${entry.name}`;
        try {
          const content = await readOpenListFileContent(
            movie.serverUrl,
            creds.username,
            creds.password,
            filePath,
          );
          subtitles.push({ filename: entry.name, format: ext.slice(1), content });
        } catch (err) {
          console.warn(`[subtitles] OpenList 读取字幕文件失败: ${entry.name}`, err);
        }
      }
    } else {
      // ── WebDAV（明文密码 + WebDAV 协议）──
      if (!movie.serverUrl) {
        res.json({ success: true, subtitles: [] });
        return;
      }
      const params: WebDAVConnectionParams = {
        serverUrl: movie.serverUrl,
        path: dirPath,
        username: creds.username,
        password: creds.password,
      };
      const entries = await listWebDAVDirectory(params, dirPath);
      for (const entry of entries) {
        if (entry.type !== 'file') continue;
        const ext = getExt(entry.name);
        if (!SUBTITLE_EXTS.includes(ext)) continue;
        if (!entry.name.toLowerCase().startsWith(videoBasename.toLowerCase())) continue;

        const filePath = dirPath.endsWith('/')
          ? `${dirPath}${entry.name}`
          : `${dirPath}/${entry.name}`;
        try {
          const readParams: WebDAVConnectionParams = {
            serverUrl: movie.serverUrl,
            path: filePath,
            username: creds.username,
            password: creds.password,
          };
          const stream = createWebDAVReadStream(readParams);
          const content = await streamToString(stream);
          subtitles.push({ filename: entry.name, format: ext.slice(1), content });
        } catch (err) {
          console.warn(`[subtitles] WebDAV 读取字幕文件失败: ${entry.name}`, err);
        }
      }
    }

    res.json({ success: true, subtitles });
  } catch (err) {
    console.error('[subtitles] search error:', err);
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        message: err instanceof Error ? err.message : '搜索字幕失败',
      });
    }
  }
});

interface BrowseEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  isSubtitle: boolean;
  size?: number;
}

/**
 * GET /browse?movieId=&path=
 *
 * 浏览影片所在目录（或指定子目录），返回文件列表。
 * path 省略时默认浏览影片所在目录。
 *
 * 响应：
 *   200 { success: true, entries: BrowseEntry[], currentPath: string, parentPath: string | null }
 *   400/404/500 { success: false, message: string }
 */
router.get('/browse', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
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

    const movie = await AppDataSource.getRepository(Movie).findOneBy({ id: movieId });
    if (!movie) {
      res.status(404).json({ success: false, message: '影片不存在' });
      return;
    }

    const source = (movie.source || '').toLowerCase();
    if (!['webdav', 'openlist', 'ftp', 'server-files'].includes(source)) {
      res.status(400).json({ success: false, message: '该影片源类型不支持目录浏览' });
      return;
    }

    if (!movie.path) {
      res.status(400).json({ success: false, message: '影片没有路径信息' });
      return;
    }

    // 目标目录：优先使用 query path，否则使用影片所在目录
    const videoDir = dirname(movie.path);
    const targetPath = typeof req.query.path === 'string' && req.query.path.trim()
      ? req.query.path.trim()
      : videoDir;

    const entries: BrowseEntry[] = [];

    // 回退查询 UserMount 补全凭证（兼容旧电影未存储凭证的情况）
    const creds = source !== 'server-files' ? await fillCredentialsFromMount(movie) : {};

    if (source === 'server-files') {
      // ── 服务器文件 ──
      const roots = await loadRootRegistry();
      const { abs: dirAbs } = resolveSafePath(targetPath, roots);
      if (!fs.existsSync(dirAbs) || !fs.statSync(dirAbs).isDirectory()) {
        res.json({ success: true, entries: [], currentPath: targetPath, parentPath: null });
        return;
      }
      const items = fs.readdirSync(dirAbs, { withFileTypes: true });
      for (const item of items) {
        if (item.name.startsWith('.')) continue;
        const itemPath = targetPath.endsWith('/')
          ? `${targetPath}${item.name}`
          : `${targetPath}/${item.name}`;
        const ext = getExt(item.name);
        const isFile = item.isFile();
        entries.push({
          name: item.name,
          path: itemPath,
          type: item.isDirectory() ? 'directory' : 'file',
          isSubtitle: isFile && SUBTITLE_EXTS.includes(ext),
          size: isFile ? fs.statSync(path.join(dirAbs, item.name)).size : undefined,
        });
      }
    } else if (source === 'ftp') {
      // ── FTP ──
      if (!movie.serverUrl) {
        res.status(400).json({ success: false, message: 'FTP 服务器地址缺失' });
        return;
      }
      const params: FTPConnectionParams = {
        serverUrl: movie.serverUrl,
        path: targetPath,
        port: undefined,
        username: creds.username,
        password: creds.password,
      };
      const list = await listFTPDirectory(params, targetPath);
      for (const entry of list) {
        const ext = getExt(entry.name);
        const itemPath = targetPath.endsWith('/')
          ? `${targetPath}${entry.name}`
          : `${targetPath}/${entry.name}`;
        entries.push({
          name: entry.name,
          path: itemPath,
          type: entry.type,
          isSubtitle: entry.type === 'file' && SUBTITLE_EXTS.includes(ext),
          size: entry.size,
        });
      }
    } else if (source === 'openlist') {
      // ── OpenList（AList HTTP API，密码为 SHA-256 哈希）──
      if (!movie.serverUrl) {
        res.status(400).json({ success: false, message: 'OpenList 服务器地址缺失' });
        return;
      }
      const result = await listOpenListDirectory(
        movie.serverUrl,
        creds.username,
        creds.password,
        targetPath,
      );
      for (const entry of result.entries) {
        const ext = getExt(entry.name);
        const converted = openListEntryToBrowseEntry(entry, targetPath);
        entries.push({
          name: converted.name,
          path: converted.path,
          type: converted.type,
          isSubtitle: converted.type === 'file' && SUBTITLE_EXTS.includes(ext),
          size: converted.size,
        });
      }
    } else {
      // ── WebDAV（明文密码 + WebDAV 协议）──
      if (!movie.serverUrl) {
        res.status(400).json({ success: false, message: 'WebDAV 服务器地址缺失' });
        return;
      }
      const params: WebDAVConnectionParams = {
        serverUrl: movie.serverUrl,
        path: targetPath,
        username: creds.username,
        password: creds.password,
      };
      const list = await listWebDAVDirectory(params, targetPath);
      for (const entry of list) {
        const ext = getExt(entry.name);
        const itemPath = targetPath.endsWith('/')
          ? `${targetPath}${entry.name}`
          : `${targetPath}/${entry.name}`;
        entries.push({
          name: entry.name,
          path: itemPath,
          type: entry.type,
          isSubtitle: entry.type === 'file' && SUBTITLE_EXTS.includes(ext),
          size: entry.size,
        });
      }
    }

    // 排序：目录在前，文件在后，各自按名称排序
    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name, 'zh-Hans-CN');
    });

    // 计算父目录路径
    const normalized = targetPath.replace(/\\/g, '/');
    const lastSlash = normalized.lastIndexOf('/');
    const parentPath = lastSlash > 0 ? normalized.slice(0, lastSlash) : null;

    res.json({ success: true, entries, currentPath: targetPath, parentPath });
  } catch (err) {
    console.error('[subtitles] browse error:', err);
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        message: err instanceof Error ? err.message : '浏览目录失败',
      });
    }
  }
});

/**
 * GET /load?movieId=&path=
 *
 * 读取指定路径的字幕文件内容。
 *
 * 响应：
 *   200 { success: true, filename: string, format: string, content: string }
 *   400/404/500 { success: false, message: string }
 */
router.get('/load', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const movieIdRaw = req.query.movieId;
    const filePath = typeof req.query.path === 'string' ? req.query.path.trim() : '';
    if (movieIdRaw === undefined) {
      res.status(400).json({ success: false, message: '缺少 movieId 参数' });
      return;
    }
    if (!filePath) {
      res.status(400).json({ success: false, message: '缺少 path 参数' });
      return;
    }
    const movieId = Number(movieIdRaw);
    if (Number.isNaN(movieId)) {
      res.status(400).json({ success: false, message: 'movieId 不正确' });
      return;
    }

    const movie = await AppDataSource.getRepository(Movie).findOneBy({ id: movieId });
    if (!movie) {
      res.status(404).json({ success: false, message: '影片不存在' });
      return;
    }

    const source = (movie.source || '').toLowerCase();
    if (!['webdav', 'openlist', 'ftp', 'server-files'].includes(source)) {
      res.status(400).json({ success: false, message: '该影片源类型不支持字幕加载' });
      return;
    }

    const filename = basename(filePath);
    const ext = getExt(filename);
    if (!SUBTITLE_EXTS.includes(ext)) {
      res.status(400).json({ success: false, message: '该文件不是支持的字幕格式' });
      return;
    }

    let content: string;

    // 回退查询 UserMount 补全凭证（兼容旧电影未存储凭证的情况）
    const creds = source !== 'server-files' ? await fillCredentialsFromMount(movie) : {};

    if (source === 'server-files') {
      // ── 服务器文件 ──
      const roots = await loadRootRegistry();
      const { abs: fileAbs } = resolveSafePath(filePath, roots);
      if (!fs.existsSync(fileAbs) || fs.statSync(fileAbs).isDirectory()) {
        res.status(404).json({ success: false, message: '字幕文件不存在' });
        return;
      }
      content = fs.readFileSync(fileAbs, 'utf-8');
    } else if (source === 'ftp') {
      // ── FTP ──
      if (!movie.serverUrl) {
        res.status(400).json({ success: false, message: 'FTP 服务器地址缺失' });
        return;
      }
      const params: FTPConnectionParams = {
        serverUrl: movie.serverUrl,
        path: filePath,
        port: undefined,
        username: creds.username,
        password: creds.password,
      };
      const stream = createFTPReadStream(params, 0);
      content = await streamToString(stream);
    } else if (source === 'openlist') {
      // ── OpenList（AList HTTP API，密码为 SHA-256 哈希）──
      if (!movie.serverUrl) {
        res.status(400).json({ success: false, message: 'OpenList 服务器地址缺失' });
        return;
      }
      content = await readOpenListFileContent(
        movie.serverUrl,
        creds.username,
        creds.password,
        filePath,
      );
    } else {
      // ── WebDAV（明文密码 + WebDAV 协议）──
      if (!movie.serverUrl) {
        res.status(400).json({ success: false, message: 'WebDAV 服务器地址缺失' });
        return;
      }
      const params: WebDAVConnectionParams = {
        serverUrl: movie.serverUrl,
        path: filePath,
        username: creds.username,
        password: creds.password,
      };
      const stream = createWebDAVReadStream(params);
      content = await streamToString(stream);
    }

    res.json({ success: true, filename, format: ext.slice(1), content });
  } catch (err) {
    console.error('[subtitles] load error:', err);
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        message: err instanceof Error ? err.message : '加载字幕失败',
      });
    }
  }
});

// ==================== 内嵌字幕 ====================

/**
 * 解析 Emby / Jellyfin 播放所需的客户端与用户（直接调用其自带字幕接口）。
 *
 * Emby / Jellyfin 字幕不依赖"服务器中转"：后端始终持有 serverUrl + API Key/凭证，
 * 无论视频走直链还是服务器中转，都能调 PlaybackInfo / Subtitles Stream。
 */
async function resolveEmbyContext(movie: Movie): Promise<{
  client: EmbyClient;
  itemId: string;
  userId: string;
}> {
  const source = (movie.source || '').toLowerCase();
  if (source !== 'emby' && source !== 'jellyfin') {
    throw new Error('该源暂不支持内嵌字幕');
  }
  if (!movie.serverUrl || !movie.path) {
    throw new Error('该影片未挂载服务器信息');
  }
  const mount = await AppDataSource.getRepository(UserMount).findOneBy({
    serverUrl: movie.serverUrl,
    type: source === 'jellyfin' ? 'jellyfin' : 'emby',
  });
  const client = await createEmbyClientFromMount({
    serverUrl: movie.serverUrl,
    apiKey: mount?.apiKey,
    username: movie.username || mount?.username || undefined,
    password: movie.password || mount?.password || undefined,
  });
  let userId = mount?.embyUserId ?? '';
  if (!userId) {
    const me = await client.me();
    userId = me.Id;
  }
  return { client, itemId: movie.path, userId };
}

/** Emby 字幕 codec → 提取后缀与前端解析格式。
 *  注意：Emby 的 Subtitles Stream 端点按扩展名路由转封装输出，
 *  裸 `/Stream`（无扩展名）会 404——srt 也必须显式带 `.srt` 后缀。 */
function mapEmbySubtitleFormat(
  codec: string,
): { ext: string; format: 'srt' | 'ass' | 'vtt' } {
  switch (codec) {
    case 'ass':
    case 'ssa':
      return { ext: 'ass', format: 'ass' };
    case 'webvtt':
      return { ext: 'vtt', format: 'vtt' };
    case 'srt':
    case 'subrip':
    default:
      return { ext: 'srt', format: 'srt' };
  }
}

/**
 * 列出视频的内嵌字幕轨道：
 * - emby：直接读 Emby PlaybackInfo 的 MediaStreams（Type===Subtitle）
 * - 其余来源：内嵌字幕提取已前端化（浏览器端 MKV demux），后端不再支持
 */
router.get(
  '/embedded-tracks',
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const movieId = Number(req.query.movieId);
      if (!Number.isFinite(movieId)) {
        res.status(400).json({ success: false, message: '缺少或无效的 movieId 参数' });
        return;
      }
      const movie = await AppDataSource.getRepository(Movie).findOneBy({ id: movieId });
      if (!movie) {
        res.status(400).json({ success: false, message: '影片不存在' });
        return;
      }
      const source = (movie.source || '').toLowerCase();

      if (source === 'emby' || source === 'jellyfin') {
        const ctx = await resolveEmbyContext(movie);
        const playback = await ctx.client.playbackInfo(ctx.itemId, ctx.userId);
        const mediaSource = playback.MediaSources[0];
        const subtitleStreams = (mediaSource?.MediaStreams ?? []).filter(
          (s) => s.Type === 'Subtitle',
        );
        const tracks = subtitleStreams.map((t) => ({
          index: t.Index,
          codecName: t.Codec || 'unknown',
          language: t.Language || null,
          title: t.DisplayTitle || null,
          label: t.DisplayTitle || t.Language || `轨道 ${t.Index}`,
        }));
        res.json({ success: true, tracks });
        return;
      }

      res.status(400).json({
        success: false,
        message: '该来源的内嵌字幕提取已前端化，后端不再提供探测',
      });
    } catch (err) {
      console.error('[subtitles] embedded-tracks error:', err);
      res.status(400).json({
        success: false,
        message: err instanceof Error ? err.message : '获取内嵌字幕轨道失败',
      });
    }
  },
);

/**
 * 提取指定内嵌字幕轨道内容：
 * - emby：调 Emby Subtitles Stream 端点（Emby 自动转封装为 SRT/ASS/VTT）
 * - 其余来源：内嵌字幕提取已前端化（浏览器端 MKV demux），后端不再支持
 */
router.get(
  '/embedded-extract',
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const movieId = Number(req.query.movieId);
      const streamIndex = Number(req.query.index);
      if (!Number.isFinite(movieId) || !Number.isFinite(streamIndex)) {
        res.status(400).json({ success: false, message: '缺少或无效的 movieId/index 参数' });
        return;
      }
      const movie = await AppDataSource.getRepository(Movie).findOneBy({ id: movieId });
      if (!movie) {
        res.status(400).json({ success: false, message: '影片不存在' });
        return;
      }
      const source = (movie.source || '').toLowerCase();

      if (source === 'emby' || source === 'jellyfin') {
        const ctx = await resolveEmbyContext(movie);
        const playback = await ctx.client.playbackInfo(ctx.itemId, ctx.userId);
        const mediaSource = playback.MediaSources[0];
        const subStream = (mediaSource?.MediaStreams ?? []).find(
          (s) => s.Type === 'Subtitle' && s.Index === streamIndex,
        );
        if (!subStream || !mediaSource) {
          res.status(400).json({ success: false, message: '未找到指定的字幕轨道' });
          return;
        }
        const { ext, format } = mapEmbySubtitleFormat(subStream.Codec || '');
        const content = await ctx.client.subtitleContent(
          ctx.itemId,
          mediaSource.Id,
          streamIndex,
          ext,
        );
        const label = subStream.DisplayTitle || subStream.Language || `轨道 ${streamIndex}`;
        res.json({
          success: true,
          content,
          format,
          label,
          language: subStream.Language || null,
        });
        return;
      }

      res.status(400).json({
        success: false,
        message: '该来源的内嵌字幕提取已前端化，后端不再提供提取',
      });
    } catch (err) {
      console.error('[subtitles] embedded-extract error:', err);
      res.status(400).json({
        success: false,
        message: err instanceof Error ? err.message : '提取内嵌字幕失败',
      });
    }
  },
);

export default router;
