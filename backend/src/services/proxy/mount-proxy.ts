/**
 * 挂载点（WebDAV / FTP / OpenList）代理的公共参数解析与挂载查询。
 *
 * 历史问题：webdav.ts / openlist.ts / ftp.ts 三个路由各自复制
 * 「mountId+path 参数校验 → 按 userId+type 查挂载 → 校验 serverUrl」逻辑。
 */

import { Response } from 'express';
import { AppDataSource } from '../../data-source';
import { UserMount } from '../../entities/UserMount';
import { AuthenticatedRequest } from '../../middleware/auth';
import { TtlCache } from '../../utils/ttl-cache';

export type MountType = 'webdav' | 'openlist' | 'ftp' | 'emby' | 'jellyfin';

export interface ResolvedMount {
  mount: UserMount;
  /** 请求的目标文件路径（已 trim，非空） */
  targetPath: string;
}

// ── 挂载解析缓存 ─────────────────────────────────────
// 视频播放/seek 期间每个 Range 请求都会 resolveUserMount 查一次库；
// 挂载记录变更频率极低，30s TTL 缓存即可显著削减 DB 压力。
// key 必须含 userId+type（绝不能按裸 mountId 命中——否则可越权读取
// 他人挂载凭证），挂载增删改由各路由调用 invalidateUserMountCache 失效。
const MOUNT_CACHE_TTL_MS = 30_000;
const mountCache = new TtlCache<UserMount>({
  ttlMs: MOUNT_CACHE_TTL_MS,
  maxSize: 500,
});
/** mountId → 该挂载的全部缓存 key（失效时按挂载维度清理） */
const mountCacheIndex = new Map<number, Set<string>>();

function mountCacheKey(userId: number, type: MountType, mountId: number): string {
  return `${type}|${userId}|${mountId}`;
}

/** 挂载增删改后调用：失效该挂载在所有用户/类型维度的缓存条目 */
export function invalidateUserMountCache(mountId: number): void {
  const keys = mountCacheIndex.get(mountId);
  if (!keys) return;
  for (const key of keys) mountCache.delete(key);
  mountCacheIndex.delete(mountId);
}

/**
 * 解析代理请求的 mountId + path，并查询当前用户对应类型的挂载。
 * 校验失败时直接写出错误响应并返回 null；成功返回挂载与目标路径。
 * 查询结果带 30s TTL 缓存（挂载 CRUD 处主动失效）。
 */
export async function resolveUserMount(
  req: AuthenticatedRequest,
  res: Response,
  type: MountType,
): Promise<ResolvedMount | null> {
  const mountIdRaw = req.query.mountId;
  const pathRaw = req.query.path;

  if (mountIdRaw === undefined) {
    res.status(400).json({ success: false, message: '缺少 mountId 参数' });
    return null;
  }
  const mountId = Number(mountIdRaw);
  if (Number.isNaN(mountId)) {
    res.status(400).json({ success: false, message: 'mountId 不正确' });
    return null;
  }
  const targetPath = typeof pathRaw === 'string' ? pathRaw.trim() : '';
  if (!targetPath) {
    res.status(400).json({ success: false, message: '缺少 path 参数' });
    return null;
  }

  const cacheKey = mountCacheKey(req.user!.userId, type, mountId);
  const cached = mountCache.get(cacheKey);
  if (cached) {
    if (!cached.serverUrl) {
      res.status(400).json({ success: false, message: '该挂载未配置服务器地址' });
      return null;
    }
    return { mount: cached, targetPath };
  }

  const mount = await AppDataSource.getRepository(UserMount).findOneBy({
    id: mountId,
    userId: req.user!.userId,
    type,
  });
  if (!mount) {
    res.status(404).json({ success: false, message: '挂载不存在或无权限' });
    return null;
  }
  if (!mount.serverUrl) {
    res.status(400).json({ success: false, message: '该挂载未配置服务器地址' });
    return null;
  }

  mountCache.set(cacheKey, mount);
  const index = mountCacheIndex.get(mountId) ?? new Set<string>();
  index.add(cacheKey);
  mountCacheIndex.set(mountId, index);

  return { mount, targetPath };
}
