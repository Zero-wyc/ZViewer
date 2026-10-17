/**
 * 服务器文件上传中间件。
 *
 * multer 存储配置依赖「运行时根目录注册表」：destination 阶段解析
 * targetDir 的绝对路径并校验只读根，filename 阶段据此处理重名。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Request } from 'express';
import multer from 'multer';
import { loadRootRegistry, resolveSafePath } from './pathResolver';

/** 上传文件大小上限：10GB */
const MAX_UPLOAD_SIZE = 10 * 1024 * 1024 * 1024;

/** 重名文件追加序号（a.mp4 → a (1).mp4）。 */
export function uniqueFilename(dirAbs: string, filename: string): string {
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

/** multer 存储：写到目标目录（运行时按 root 解析）。 */
const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const targetDir =
      typeof req.body.targetDir === 'string' ? req.body.targetDir : '/';
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

/** 上传中间件（multipart/form-data，最多 50 个文件）。 */
export const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_SIZE },
});
