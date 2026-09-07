/**
 * 服务器文件路径安全解析（多根目录支持）。
 *
 * 路径格式约定（前缀式）：
 * - `uploads:/movies/a.mp4`       uploads 默认根目录
 * - `custom:3:/videos/b.mp4`      id=3 的自定义目录
 * - `/movies/a.mp4`               旧格式（无前缀），默认归属 uploads 根
 * - `/` 或空字符串                  表示 uploads 根目录
 *
 * 安全保证：解析后的绝对路径必须位于所选根目录之内（含根目录本身），
 * 否则抛出 '路径越权' 错误。
 */
import path from 'node:path';
import fs from 'node:fs';
import { UPLOADS_DIR } from '../paths';
import { AppDataSource } from '../../data-source';
import { ServerFolder } from '../../entities/ServerFolder';

/** 服务器文件默认存储根目录（config/uploads）。 */
export const UPLOADS_ROOT = UPLOADS_DIR;

/** uploads 根的固定 key。 */
export const UPLOADS_ROOT_KEY = 'uploads';

/** 根目录描述。 */
export interface RootInfo {
  /** 唯一标识：'uploads' 或 'custom:<id>'。 */
  key: string;
  /** 显示名称。 */
  name: string;
  /** 真实绝对路径。 */
  absPath: string;
  /** 是否只读。 */
  readonly: boolean;
}

/** 已注册根目录集合（按 key 索引）。 */
export type RootRegistry = Map<string, RootInfo>;

/** 确保 uploads 根目录存在。启动时调用一次。 */
export function ensureUploadsRoot(): void {
  if (!fs.existsSync(UPLOADS_ROOT)) {
    fs.mkdirSync(UPLOADS_ROOT, { recursive: true });
  }
}

/** 构造 uploads 根描述。 */
export function getUploadsRoot(): RootInfo {
  return {
    key: UPLOADS_ROOT_KEY,
    name: '默认空间',
    absPath: UPLOADS_ROOT,
    readonly: false,
  };
}

/**
 * 根目录注册表缓存（TTL + 主动失效）。
 *
 * 流式代理（GET /proxy）在浏览器 seek / 预取时会被高频调用，
 * 每次都查 ServerFolder 全表（sqljs 同步执行）会阻塞事件循环、
 * 拖慢所有进行中的媒体流。目录配置极少变化，短 TTL 缓存 +
 * 增删改端点主动失效即可同时满足读取性能与配置即时生效。
 */
const REGISTRY_TTL_MS = 30_000;
let registryCache: { at: number; registry: RootRegistry } | null = null;

/** 失效根目录注册表缓存（新增/修改/删除自定义目录后调用）。 */
export function invalidateRootRegistry(): void {
  registryCache = null;
}

/**
 * 加载所有根目录到注册表（uploads 根 + 数据库中的自定义根）。
 * 供 serverFiles 路由与音轨探测等需要解析服务器文件路径的模块共用。
 */
export async function loadRootRegistry(): Promise<RootRegistry> {
  if (registryCache && Date.now() - registryCache.at < REGISTRY_TTL_MS) {
    return registryCache.registry;
  }
  const map: RootRegistry = new Map();
  map.set(UPLOADS_ROOT_KEY, getUploadsRoot());
  const folders = await AppDataSource.getRepository(ServerFolder).find({
    order: { id: 'ASC' },
  });
  for (const f of folders) {
    const key = `custom:${f.id}`;
    map.set(key, {
      key,
      name: f.name,
      absPath: path.resolve(f.absPath),
      readonly: !!f.readonly,
    });
  }
  registryCache = { at: Date.now(), registry: map };
  return map;
}

/**
 * 解析用户传入的前缀式路径，返回根 key 与相对路径。
 * 无前缀时默认 uploads 根。
 */
export function parsePrefixedPath(input: string | undefined): {
  rootKey: string;
  relPath: string;
} {
  const raw = (input || '').trim();
  // 匹配 'uploads:' 或 'custom:数字:'
  const match = raw.match(/^(uploads|custom:\d+):(.*)$/);
  if (match) {
    return { rootKey: match[1], relPath: match[2] || '/' };
  }
  return { rootKey: UPLOADS_ROOT_KEY, relPath: raw };
}

/**
 * 将用户路径安全解析为指定根目录内的绝对路径。
 *
 * @param input 用户传入的前缀式或旧式路径
 * @param roots 已注册根集合
 * @returns 解析结果（含绝对路径、根信息）
 * @throws Error 路径越权或根不存在时抛出
 */
export function resolveSafePath(
  input: string | undefined,
  roots: RootRegistry
): { abs: string; root: RootInfo } {
  const { rootKey, relPath } = parsePrefixedPath(input);
  const root = roots.get(rootKey);
  if (!root) {
    throw new Error('未知的根目录');
  }
  const normalized = relPath.replace(/^\/+/, '');
  const absolute = path.resolve(root.absPath, normalized);
  // 越权判断：path.relative 在 Windows 盘符根目录（如 D:\）下也能正确计算，
  // 避免 startsWith(root + path.sep) 在根路径末尾已带分隔符时拼接出双斜杠而误判。
  const rel = path.relative(root.absPath, absolute);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('路径越权');
  }
  return { abs: absolute, root };
}

/**
 * 将绝对路径转换为相对于指定根的前缀式 POSIX 路径。
 */
export function toPrefixedPath(root: RootInfo, absolutePath: string): string {
  if (absolutePath === root.absPath) {
    return `${root.key}:/`;
  }
  const rel = path.relative(root.absPath, absolutePath);
  return `${root.key}:/${rel.split(path.sep).join('/')}`;
}

/**
 * 旧版 toRelativePath：仅用于 uploads 根，保持向后兼容。
 * @deprecated 使用 toPrefixedPath 替代。
 */
export function toRelativePath(absolutePath: string): string {
  if (absolutePath === UPLOADS_ROOT) return '/';
  const rel = path.relative(UPLOADS_ROOT, absolutePath);
  return '/' + rel.split(path.sep).join('/');
}

/**
 * 旧版 resolveSafePath：仅用于 uploads 根，保持向后兼容。
 * @deprecated 使用新版 resolveSafePath(input, roots) 替代。
 */
export function resolveSafePathLegacy(userPath: string | undefined): string {
  const normalized = (userPath || '').trim().replace(/^\/+/, '');
  const absolute = path.resolve(UPLOADS_ROOT, normalized);
  const rel = path.relative(UPLOADS_ROOT, absolute);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('路径越权');
  }
  return absolute;
}

/** 从路径中提取文件名（含扩展名）。 */
export function basename(p: string): string {
  return path.basename(p);
}
