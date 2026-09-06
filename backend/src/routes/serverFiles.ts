/**
 * 服务器文件管理路由。
 *
 * 仅超级管理员（root）可用。提供：
 * - GET  /roots         列出所有可用根（uploads + 自定义）
 * - POST /roots         添加自定义根目录
 * - DELETE /roots/:id   删除自定义根目录
 * - GET  /browse        浏览目录
 * - GET  /browse-system 浏览服务器全盘目录（仅目录，用于添加根目录时选取）
 * - POST /upload        上传文件（multipart/form-data）
 * - POST /folder        新建文件夹
 * - POST /rename        重命名文件/文件夹
 * - DELETE /file        删除文件或文件夹
 * - GET  /resolve       解析文件 → 返回代理播放 URL + 格式
 * - GET  /proxy         流式代理播放（支持 Range）
 *
 * 路径参数采用前缀式：'uploads:/path' 或 'custom:<id>:/path'。
 * 旧式 '/path' 默认归属 uploads 根（向后兼容）。
 */
import { Router, Request, Response } from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createWriteStream } from 'node:fs';
import multer from 'multer';
import { AppDataSource } from '../data-source';
import { ServerFolder } from '../entities/ServerFolder';
import { authenticateToken, requireRoot, AuthenticatedRequest } from '../middleware/auth';
import { detectMediaFormat, getContentType } from '../services/mediaFormat';
import { parseRangeHeader, pipeRangeStream, setWildcardCors } from '../services/proxy';
import {
  UPLOADS_ROOT,
  resolveSafePath,
  toPrefixedPath,
  loadRootRegistry,
  basename,
  type RootRegistry,
} from '../services/server-files/pathResolver';
import {
  resolveBilibiliVideo,
  extractBvid,
  expandBilibiliShortLink,
  normalizeResolveError,
  type ResolveProgress,
} from '../services/bilibili/resolver';
import { VIP_ONLY_QNS } from '../services/bilibili/permission';
import { getUserCookie } from '../routes/stream/helpers';

const router = Router();

// 全局校验：所有端点需登录
router.use(authenticateToken);
// 管理类端点仅 root 可访问；
// 播放代理相关端点（/resolve、/proxy）允许任意已登录用户访问，
// 否则观众（guest）无法加载房主推送的服务器本地视频。
router.use(
  [
    '/roots',
    '/browse',
    '/browse-system',
    '/upload',
    '/folder',
    '/rename',
    '/file',
    '/bilibili-download',
  ],
  requireRoot,
);

// 上传文件大小上限：10GB
const MAX_UPLOAD_SIZE = 10 * 1024 * 1024 * 1024;

/** ServerFolder 仓库。 */
const folderRepo = () => AppDataSource.getRepository(ServerFolder);

/** multer 存储：写到目标目录（运行时按 root 解析）。 */
const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const targetDir = typeof req.body.targetDir === 'string' ? req.body.targetDir : '/';
    loadRootRegistry()
      .then((roots) => {
        try {
          const { abs, root } = resolveSafePath(targetDir, roots);
          if (root.readonly) {
            cb(new Error('该根目录为只读'), '');
            return;
          }
          if (!fs.existsSync(abs)) {
            fs.mkdirSync(abs, { recursive: true });
          }
          // 把目标目录绝对路径暂存到 req 上，filename 阶段读取以处理重名。
          // multer 保证 filename 在 destination 之后调用。
          (req as Request & { __targetDirAbs?: string }).__targetDirAbs = abs;
          cb(null, abs);
        } catch (err) {
          cb(err as Error, '');
        }
      })
      .catch((err) => cb(err as Error, ''));
  },
  filename: (req, file, cb) => {
    const dirAbs = (req as Request & { __targetDirAbs?: string }).__targetDirAbs;
    const original = Buffer.from(file.originalname, 'latin1').toString('utf8');
    if (!dirAbs) {
      cb(null, original);
      return;
    }
    // 重名时追加序号，避免覆盖已有文件
    cb(null, uniqueFilename(dirAbs, original));
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_SIZE },
});

/** 重名文件追加序号（a.mp4 → a (1).mp4）。 */
function uniqueFilename(dirAbs: string, filename: string): string {
  const target = path.join(dirAbs, filename);
  if (!fs.existsSync(target)) return filename;
  const ext = path.extname(filename);
  const stem = path.basename(filename, ext);
  for (let i = 1; i < 10000; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (!fs.existsSync(path.join(dirAbs, candidate))) return candidate;
  }
  return `${stem}-${Date.now()}${ext}`;
}

// ============ 1. 根目录管理 ============

/** GET /roots — 列出所有根。 */
router.get('/roots', async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const roots = await loadRootRegistry();
    const list = Array.from(roots.values()).map((r) => ({
      key: r.key,
      name: r.name,
      absPath: r.absPath,
      readonly: r.readonly,
      exists: fs.existsSync(r.absPath),
    }));
    res.json({ success: true, roots: list });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err instanceof Error ? err.message : '加载根目录失败',
    });
  }
});

/** POST /roots — 添加自定义根目录。 */
router.post('/roots', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    const absPath = typeof req.body.absPath === 'string' ? req.body.absPath.trim() : '';
    const readonly = req.body.readonly === true;
    if (!name) {
      res.status(400).json({ success: false, message: '名称不能为空' });
      return;
    }
    if (!absPath) {
      res.status(400).json({ success: false, message: '目录路径不能为空' });
      return;
    }
    // 规范化并禁止相对路径（避免误把工作目录拼进去）
    const resolved = path.resolve(absPath);
    // 禁止将 uploads 根自身重复添加
    if (resolved === UPLOADS_ROOT) {
      res.status(400).json({ success: false, message: '该目录已是默认空间' });
      return;
    }
    // 必须存在且为目录
    try {
      const stat = fs.statSync(resolved);
      if (!stat.isDirectory()) {
        res.status(400).json({ success: false, message: '路径不是目录' });
        return;
      }
    } catch {
      res.status(400).json({ success: false, message: '目录不存在或无访问权限' });
      return;
    }
    // 防止重复添加同一路径
    const existing = await folderRepo().findOne({ where: { absPath: resolved } });
    if (existing) {
      res.status(400).json({ success: false, message: '该目录已添加' });
      return;
    }
    const entity = folderRepo().create({ name, absPath: resolved, readonly });
    const saved = await folderRepo().save(entity);
    res.json({
      success: true,
      root: {
        key: `custom:${saved.id}`,
        name: saved.name,
        absPath: saved.absPath,
        readonly: saved.readonly,
        exists: true,
      },
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err instanceof Error ? err.message : '添加根目录失败',
    });
  }
});

/** DELETE /roots/:id — 删除自定义根目录（仅删除挂载，不删真实文件）。 */
router.delete('/roots/:id', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ success: false, message: '无效的 ID' });
      return;
    }
    const entity = await folderRepo().findOne({ where: { id } });
    if (!entity) {
      res.status(404).json({ success: false, message: '根目录不存在' });
      return;
    }
    await folderRepo().remove(entity);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err instanceof Error ? err.message : '删除根目录失败',
    });
  }
});

// ============ 2. 浏览目录 ============

router.get('/browse', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const roots = await loadRootRegistry();
    const { abs, root } = resolveSafePath(req.query.path as string | undefined, roots);
    let stat;
    try {
      stat = await fsp.stat(abs);
    } catch {
      res.json({
        success: true,
        entries: [],
        currentPath: toPrefixedPath(root, abs),
        readonly: root.readonly,
      });
      return;
    }
    if (!stat.isDirectory()) {
      res.json({
        success: true,
        entries: [],
        currentPath: toPrefixedPath(root, abs),
        readonly: root.readonly,
      });
      return;
    }
    const items = await fsp.readdir(abs, { withFileTypes: true });
    const filtered = items.filter((item) => !item.name.startsWith('.'));
    const entries = await Promise.all(
      filtered.map(async (item) => {
        const childAbs = path.join(abs, item.name);
        let childStat;
        try {
          childStat = await fsp.stat(childAbs);
        } catch {
          return null;
        }
        return {
          name: item.name,
          path: toPrefixedPath(root, childAbs),
          type: item.isDirectory() ? 'directory' : 'file',
          size: item.isFile() ? childStat.size : undefined,
          modifiedAt: childStat.mtime.toISOString(),
        };
      }),
    );
    const sortedEntries = entries
      .filter((e): e is NonNullable<typeof e> => e !== null)
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name, 'zh-Hans-CN');
      });
    res.json({
      success: true,
      entries: sortedEntries,
      currentPath: toPrefixedPath(root, abs),
      readonly: root.readonly,
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      message: err instanceof Error ? err.message : '浏览目录失败',
    });
  }
});

// ============ 2.5 系统级目录浏览（用于添加根目录时选取路径） ============

/**
 * GET /browse-system — 浏览服务器文件系统任意目录（仅返回子目录）。
 *
 * 不受已注册根目录限制，可浏览服务器全盘，用于"添加自定义根目录"时选取路径。
 * 仅返回目录（隐藏文件除外），不返回文件。
 *
 * 查询参数：
 * - absPath: 要浏览的绝对路径。不提供时返回系统根（Windows 盘符列表 / Unix 根目录）。
 */
router.get('/browse-system', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const rawPath = typeof req.query.absPath === 'string' ? req.query.absPath.trim() : '';
    const isWindows = process.platform === 'win32';

    // 无路径参数：返回系统根
    if (!rawPath) {
      if (isWindows) {
        // Windows: 枚举可用盘符
        const drives: Array<{ name: string; absPath: string }> = [];
        for (let code = 65; code <= 90; code++) {
          const letter = String.fromCharCode(code);
          const drivePath = `${letter}:\\`;
          try {
            if (fs.statSync(drivePath).isDirectory()) {
              drives.push({ name: `${letter}:`, absPath: drivePath });
            }
          } catch {
            // 盘符不存在或无权限，跳过
          }
        }
        res.json({ success: true, entries: drives, currentPath: '', isRoot: true });
        return;
      }
      // Unix: 返回 / 下的目录
      const items = fs.readdirSync('/', { withFileTypes: true });
      const entries = items
        .filter((item) => item.isDirectory() && !item.name.startsWith('.'))
        .map((item) => ({ name: item.name, absPath: path.join('/', item.name) }))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
      res.json({ success: true, entries, currentPath: '/', isRoot: true });
      return;
    }

    // 有路径参数：列出该路径下的子目录
    const resolved = path.resolve(rawPath);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved);
    } catch {
      res.status(400).json({ success: false, message: '路径不存在或无访问权限' });
      return;
    }
    if (!stat.isDirectory()) {
      res.status(400).json({ success: false, message: '路径不是目录' });
      return;
    }

    const items = fs.readdirSync(resolved, { withFileTypes: true });
    const entries = items
      .filter((item) => item.isDirectory() && !item.name.startsWith('.'))
      .map((item) => ({ name: item.name, absPath: path.join(resolved, item.name) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));

    // 计算父目录路径（用于返回上一级），系统根时父目录为空
    let parentPath = '';
    if (isWindows) {
      // Windows: 如 D:\folder 的父级是 D:\，D:\ 的父级为空（系统根）
      const parsed = path.parse(resolved);
      if (parsed.dir && parsed.dir !== resolved) {
        parentPath = parsed.dir;
      }
    } else {
      if (resolved !== '/') {
        parentPath = path.dirname(resolved);
      }
    }

    res.json({
      success: true,
      entries,
      currentPath: resolved,
      parentPath,
      isRoot: false,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err instanceof Error ? err.message : '浏览系统目录失败',
    });
  }
});

// ============ 3. 上传文件 ============

router.post('/upload', upload.array('files', 50), async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const files = req.files as Express.Multer.File[] | undefined;
  if (!files || files.length === 0) {
    res.status(400).json({ success: false, message: '未接收到文件' });
    return;
  }
  // multer storage 已在 destination 阶段校验只读、创建目录，
  // 并在 filename 阶段应用 uniqueFilename 避免覆盖。
  // 这里重新解析 targetDir 以构造前缀式返回路径。
  const targetDir = typeof req.body.targetDir === 'string' ? req.body.targetDir : '/';
  try {
    const roots = await loadRootRegistry();
    const { abs: dirAbs, root } = resolveSafePath(targetDir, roots);
    const uploaded = files.map((f) => {
      const name = path.basename(f.path);
      const childAbs = path.join(dirAbs, name);
      return {
        name,
        path: toPrefixedPath(root, childAbs),
        size: f.size,
      };
    });
    res.json({ success: true, files: uploaded });
  } catch (err) {
    // 解析失败时清理已写入文件
    for (const f of files) {
      try { fs.unlinkSync(f.path); } catch { /* ignore */ }
    }
    res.status(400).json({
      success: false,
      message: err instanceof Error ? err.message : '上传失败',
    });
  }
});

// ============ 4. 新建文件夹 ============

router.post('/folder', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const parent = typeof req.body.parent === 'string' ? req.body.parent : '/';
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    if (!name) {
      res.status(400).json({ success: false, message: '文件夹名称不能为空' });
      return;
    }
    if (/[\\/:*?"<>|]/.test(name)) {
      res.status(400).json({ success: false, message: '文件夹名称包含非法字符' });
      return;
    }
    const roots = await loadRootRegistry();
    const { abs: parentAbs, root } = resolveSafePath(parent, roots);
    if (root.readonly) {
      res.status(400).json({ success: false, message: '该根目录为只读' });
      return;
    }
    const targetAbs = path.join(parentAbs, name);
    {
      const rel = path.relative(root.absPath, targetAbs);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        res.status(400).json({ success: false, message: '路径越权' });
        return;
      }
    }
    if (fs.existsSync(targetAbs)) {
      res.status(400).json({ success: false, message: '同名项目已存在' });
      return;
    }
    fs.mkdirSync(targetAbs, { recursive: true });
    res.json({ success: true, path: toPrefixedPath(root, targetAbs) });
  } catch (err) {
    res.status(400).json({
      success: false,
      message: err instanceof Error ? err.message : '新建文件夹失败',
    });
  }
});

// ============ 5. 重命名 ============

router.post('/rename', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const oldPath = typeof req.body.path === 'string' ? req.body.path : '';
    const newName = typeof req.body.newName === 'string' ? req.body.newName.trim() : '';
    if (!oldPath || !newName) {
      res.status(400).json({ success: false, message: '缺少 path 或 newName 参数' });
      return;
    }
    if (/[\\/:*?"<>|]/.test(newName)) {
      res.status(400).json({ success: false, message: '名称包含非法字符' });
      return;
    }
    const roots = await loadRootRegistry();
    const { abs: oldAbs, root } = resolveSafePath(oldPath, roots);
    if (root.readonly) {
      res.status(400).json({ success: false, message: '该根目录为只读' });
      return;
    }
    if (!fs.existsSync(oldAbs)) {
      res.status(404).json({ success: false, message: '原文件不存在' });
      return;
    }
    const parentDir = path.dirname(oldAbs);
    const newAbs = path.join(parentDir, newName);
    {
      const rel = path.relative(root.absPath, newAbs);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        res.status(400).json({ success: false, message: '路径越权' });
        return;
      }
    }
    if (fs.existsSync(newAbs) && oldAbs !== newAbs) {
      res.status(400).json({ success: false, message: '同名项目已存在' });
      return;
    }
    fs.renameSync(oldAbs, newAbs);
    res.json({ success: true, path: toPrefixedPath(root, newAbs) });
  } catch (err) {
    res.status(400).json({
      success: false,
      message: err instanceof Error ? err.message : '重命名失败',
    });
  }
});

// ============ 6. 删除文件/文件夹 ============

router.delete('/file', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const target = typeof req.query.path === 'string' ? req.query.path : '';
    if (!target || target === '/' || target.endsWith(':/') || target.endsWith(':')) {
      res.status(400).json({ success: false, message: '不能删除根目录' });
      return;
    }
    const roots = await loadRootRegistry();
    const { abs: targetAbs, root } = resolveSafePath(target, roots);
    if (root.readonly) {
      res.status(400).json({ success: false, message: '该根目录为只读' });
      return;
    }
    if (targetAbs === root.absPath) {
      res.status(400).json({ success: false, message: '不能删除根目录' });
      return;
    }
    if (!fs.existsSync(targetAbs)) {
      res.status(404).json({ success: false, message: '文件不存在' });
      return;
    }
    fs.rmSync(targetAbs, { recursive: true, force: true });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({
      success: false,
      message: err instanceof Error ? err.message : '删除失败',
    });
  }
});

// ============ 7. 解析文件 → 返回代理播放 URL ============

router.get('/resolve', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const target = typeof req.query.path === 'string' ? req.query.path : '';
    if (!target.trim()) {
      res.status(400).json({ success: false, message: '缺少 path 参数' });
      return;
    }
    const roots = await loadRootRegistry();
    const { abs: targetAbs } = resolveSafePath(target, roots);
    if (!fs.existsSync(targetAbs) || fs.statSync(targetAbs).isDirectory()) {
      res.status(404).json({ success: false, message: '文件不存在' });
      return;
    }
    const name = basename(targetAbs);
    const format = detectMediaFormat(name);
    // 使用相对路径，由前端根据当前页面 origin 自动解析，避免反向代理后协议错误（http vs https）
    const proxyUrl = `/api/server-files/proxy?path=${encodeURIComponent(target)}`;

    // 音轨编码探测已前端化（浏览器端 MKV demux），此处不再返回
    res.json({
      success: true,
      title: name,
      videoUrl: proxyUrl,
      format,
      audioCodec: null,
      duration: null,
      size: fs.statSync(targetAbs).size,
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      message: err instanceof Error ? err.message : '解析文件失败',
    });
  }
});

// ============ 8. 流式代理播放（支持 Range） ============

/**
 * HEAD /proxy — 轻量级元数据响应。
 *
 * 前端 direct-engine 在 attach 时发送 HEAD 请求获取元信息。
 * 仅探测文件信息并返回 header，不执行转码或流式传输。
 */
router.head('/proxy', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const target = typeof req.query.path === 'string' ? req.query.path : '';
    if (!target.trim()) {
      res.status(400).end();
      return;
    }
    const roots = await loadRootRegistry();
    const { abs: targetAbs } = resolveSafePath(target, roots);
    if (!fs.existsSync(targetAbs) || fs.statSync(targetAbs).isDirectory()) {
      res.status(404).end();
      return;
    }

    const format = detectMediaFormat(target);
    const stat = fs.statSync(targetAbs);
    setWildcardCors(res);
    res.setHeader('Content-Type', getContentType(format));
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Length', stat.size.toString());

    res.status(200).end();
  } catch {
    if (!res.headersSent) {
      res.status(400).end();
    }
  }
});

router.get('/proxy', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const target = typeof req.query.path === 'string' ? req.query.path : '';
    if (!target.trim()) {
      res.status(400).json({ success: false, message: '缺少 path 参数' });
      return;
    }
    const roots = await loadRootRegistry();
    const { abs: targetAbs } = resolveSafePath(target, roots);
    if (!fs.existsSync(targetAbs) || fs.statSync(targetAbs).isDirectory()) {
      res.status(404).json({ success: false, message: '文件不存在' });
      return;
    }

    const stat = fs.statSync(targetAbs);
    const fileSize = stat.size;
    const rangeHeader = req.headers.range;
    const format = detectMediaFormat(target);

    // ── 直接流式传输路径 ──
    // 音频转码已迁移至浏览器端（ffmpeg.wasm）：无论服务器中转还是直链，
    // 前端根据影片 audioCodec 自行决定是否在浏览器内将不支持的音轨
    // （DTS/AC3 等）实时转为 AAC，服务端始终纯字节中转（保留 Range）。
    if (rangeHeader) {
      const parsed = parseRangeHeader(rangeHeader, fileSize);
      if (parsed === 'invalid') {
        res.status(416).setHeader('Content-Range', `bytes */${fileSize}`);
        res.end();
        return;
      }
      const start = parsed?.start ?? 0;
      const end = parsed?.end ?? fileSize - 1;
      const stream = fs.createReadStream(targetAbs, { start, end });
      pipeRangeStream(res, {
        stream,
        contentType: getContentType(format),
        fileSize,
        start,
        end,
        ranged: true,
        logTag: 'server-files',
        errorMessage: '文件读取失败',
      });
    } else {
      const stream = fs.createReadStream(targetAbs);
      pipeRangeStream(res, {
        stream,
        contentType: getContentType(format),
        fileSize,
        ranged: false,
        logTag: 'server-files',
        errorMessage: '文件读取失败',
      });
    }
  } catch (err) {
    if (!res.headersSent) {
      res.status(400).json({
        success: false,
        message: err instanceof Error ? err.message : '代理播放失败',
      });
    }
  }
});

// ============ 9. 下载 B站 视频到服务器 ============

/**
 * 流式下载文件到本地路径。
 *
 * 优化点：
 * - 下载失败时自动清理不完整的文件
 * - 进度回调节流：每 2% 或 512KB 触发一次，避免过度回调
 *
 * @returns 文件大小（字节）
 */
async function downloadToFile(
  url: string,
  filePath: string,
  headers?: Record<string, string>,
  onProgress?: (received: number, total: number, percent: number) => void
): Promise<number> {
  const res = await fetch(url, { headers, redirect: 'follow' });
  if (!res.ok || !res.body) {
    throw new Error(`下载失败：HTTP ${res.status} ${res.statusText}`);
  }

  const total = Number(res.headers.get('content-length') || '0');
  let received = 0;
  let lastPercent = 0;

  const fileStream = createWriteStream(filePath);
  const reader = res.body.getReader();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        fileStream.write(Buffer.from(value));
        received += value.length;
        const percent = total > 0 ? Math.floor((received / total) * 100) : 0;
        if (percent >= lastPercent + 2 || (total === 0 && received % (512 * 1024) === 0)) {
          lastPercent = percent;
          onProgress?.(received, total, percent);
        }
      }
    }

    await new Promise<void>((resolve, reject) => {
      fileStream.end((err?: Error) => (err ? reject(err) : resolve()));
    });
  } catch (err) {
    // 下载失败时清理不完整的文件
    try { fs.unlinkSync(filePath); } catch { /* ignore */ }
    throw err;
  }

  return received;
}

/**
 * POST /bilibili-download — 解析 B站 视频并下载到服务器指定目录。
 *
 * 采用 NDJSON 流式响应，实时推送解析、下载进度：
 *   { status: 'parsing', step, message }
 *   { status: 'downloading', phase: 'video', received, total, percent }
 *   { status: 'done', file: { name, path, size } }
 *   { status: 'error', message, code }
 *
 * 仅 MP4 单文件直链模式（最高 720P）。高画质（DASH 分离流需服务器
 * FFmpeg 合并）已随服务器端 FFmpeg 一并移除，请使用 CLI 模式下载高画质。
 */
router.post('/bilibili-download', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const rawUrl = typeof req.body.url === 'string' ? req.body.url.trim() : '';
  // 短链展开：b23.tv 等分享短链先 302 展开为完整视频地址再校验/解析
  const url = await expandBilibiliShortLink(rawUrl);
  const targetDir = typeof req.body.targetDir === 'string' ? req.body.targetDir.trim() : '';
  const filename = typeof req.body.filename === 'string' ? req.body.filename.trim() : '';
  const qn =
    typeof req.body.qn === 'number' && Number.isFinite(req.body.qn)
      ? req.body.qn
      : undefined;
  const page =
    typeof req.body.page === 'number' && Number.isFinite(req.body.page)
      ? req.body.page
      : undefined;
  const userId = req.user?.userId;

  if (!url) {
    res.status(400).json({ success: false, message: '缺少视频链接或 BV 号' });
    return;
  }
  if (!extractBvid(url)) {
    res.status(400).json({ success: false, message: '无法解析 B站 BV 号' });
    return;
  }
  if (!targetDir) {
    res.status(400).json({ success: false, message: '缺少目标目录' });
    return;
  }

  // NDJSON 流式响应
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'close');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Transfer-Encoding', 'chunked');

  const send = (payload: Record<string, unknown>): void => {
    res.write(JSON.stringify(payload) + '\n');
    const flushable = res as unknown as { flush?: () => void };
    if (typeof flushable.flush === 'function') flushable.flush();
  };
  const fail = (message: string, code?: string): void => {
    send({ success: false, status: 'error', message, code });
    res.end();
  };

  try {
    // 1. 解析目标目录
    const roots = await loadRootRegistry();
    const { abs: dirAbs, root } = resolveSafePath(targetDir, roots);
    if (root.readonly) {
      fail('该根目录为只读');
      return;
    }
    if (!fs.existsSync(dirAbs)) {
      fs.mkdirSync(dirAbs, { recursive: true });
    }

    // 2. 获取用户 B站 Cookie
    const cookie = (await getUserCookie(userId)) || undefined;

    // 3. 解析 B站 视频（按模式选择 preferMp4，下载场景跳过 CDN 健康检查）
    send({ status: 'parsing', step: 'resolve', message: '正在解析视频地址...' });
    const result = await resolveBilibiliVideo({
      url,
      userId: userId !== undefined ? String(userId) : undefined,
      cookie,
      qn,
      preferMp4: true,
      page,
      // 下载场景跳过 CDN HEAD 健康检查（3.5s 超时），
      // 下载本身即连接验证，失败时由 backupUrl 重试
      skipCdnCheck: true,
      onProgress: (msg: ResolveProgress) => {
        send({ status: 'parsing', step: msg.step, message: msg.message });
      },
    });

    if (!result.videoUrl) {
      fail('解析失败：未获取到视频直链');
      return;
    }

    // 3.5 VIP 权限校验：非大会员账号不允许下载 VIP 专属清晰度
    // 后端 filterQualitiesByVip 已经过滤，这里作为强校验防止前端绕过
    if (qn && VIP_ONLY_QNS.includes(qn) && result.vipStatus !== 1) {
      fail(
        '该清晰度需要大会员账号，请先在个人中心绑定大会员账号后重试，或选择 1080P 及以下清晰度',
        'VIP_REQUIRED',
      );
      return;
    }

    // 4. 确定文件名
    const title = (filename || result.title || `bilibili_${Date.now()}`).replace(/[\\/:*?"<>|]/g, '_');
    const finalName = uniqueFilename(dirAbs, `${title}.mp4`);
    const targetPath = path.join(dirAbs, finalName);

    // 通用下载头（防盗链）
    const downloadHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Referer: 'https://www.bilibili.com',
      Origin: 'https://www.bilibili.com',
      ...(cookie ? { Cookie: cookie } : {}),
    };

    // MP4 单文件直接下载
    send({ status: 'downloading', phase: 'video', message: '开始下载...', received: 0, total: 0, percent: 0 });

    try {
      await downloadToFile(result.videoUrl, targetPath, downloadHeaders, (received, total, percent) => {
        send({ status: 'downloading', phase: 'video', received, total, percent });
      });
    } catch (err) {
      try { fs.unlinkSync(targetPath); } catch { /* ignore */ }
      fail(`下载失败：${err instanceof Error ? err.message : '写入文件失败'}`);
      return;
    }

    // 5. 完成
    const size = fs.statSync(targetPath).size;
    send({
      success: true,
      status: 'done',
      file: {
        name: finalName,
        path: toPrefixedPath(root, targetPath),
        size,
      },
    });
    res.end();
  } catch (err) {
    console.error('[server-files] bilibili-download error:', err);
    const normalized = normalizeResolveError(err);
    fail(normalized.message, normalized.code);
  }
});

export default router;
