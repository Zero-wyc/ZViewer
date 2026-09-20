/**
 * 影片直链实时解析服务（play-time direct-link resolution）。
 *
 * 设计对齐 synctv（F:\Code\synctv）的语义：直链 URL 不应固化在影片记录里，
 * 而是在播放解析时实时向源站获取——AList/OpenList 的签名直链会过期，
 * 源站地址 / 协议（http↔https）也可能随时间变化。固化 URL 只能作为
 * 解析失败时的兜底，不能作为唯一播放依据。
 *
 * 解析流程（openlist / webdav 直链影片）：
 * 1. 按影片记录的 serverUrl + source 反查挂载（与 /stream 凭证回退同一模式：
 *    直链影片的观影者是房间成员而非挂载所有者，不能按 userId 过滤）；
 * 2. 用挂载凭证调 AList API 获取 raw_url（webdav 类型失败时回退拼接直链，
 *    与 /api/webdav/direct-url 行为一致）；
 * 3. 经 upgradeDirectUrlValidated 做 https 升级 + 活性校验（防陈旧
 *    httpsDirect 缓存产出不可达直链）；
 * 4. 结果带 5 分钟 TTL 缓存 + 单飞（single-flight）去重：
 *    同一部影片多人同时加入房间只触发一次上游解析。
 *
 * 安全边界：本服务只接受 Movie 记录作为解析输入（不接受任意 serverUrl），
 * 与 /stream?movieId= 同一信任模型——能拿到 movieId 的都是已认证的
 * 房间成员，影片列表本身已对其可见。
 */
import { AppDataSource } from '../data-source';
import { UserMount } from '../entities/UserMount';
import { Movie } from '../entities/Movie';
import { TtlCache } from '../utils/ttl-cache';
import { upgradeDirectUrlValidated, extractErrorMessage } from '../modules/shared/mount-utils';
import {
  fetchOpenListDirectUrl,
  normalizeOpenListServerUrl,
  OpenListError,
} from './openlist';
import { isInternalOpenListServer } from './openlist-errors';
import { buildWebDAVDirectUrl } from './webdav';

export type MovieDirectResolveErrorCode =
  | 'INVALID_MOVIE'
  | 'MOUNT_NOT_FOUND'
  | 'INTERNAL_NETWORK_FORBIDDEN'
  | 'AUTH_FAILED'
  | 'NOT_FOUND'
  | 'UNREACHABLE';

/** 带错误码的解析失败（路由层据此映射 HTTP 状态码） */
export class MovieDirectResolveError extends Error {
  readonly code: MovieDirectResolveErrorCode;

  constructor(code: MovieDirectResolveErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** 直链缓存 TTL：与 openlist /proxy 的 raw_url 缓存一致（签名直链短期有效） */
const DIRECT_URL_TTL_MS = 5 * 60 * 1000;

/**
 * 解析结果缓存：key = type|serverUrl|path（同一源文件跨影片/跨房间共享条目）。
 * TtlCache（LRU 上限）替代无界 Map：过期惰性清理 + 容量超限按最久未使用淘汰。
 */
const directUrlCache = new TtlCache<string>({
  ttlMs: DIRECT_URL_TTL_MS,
  maxSize: 500,
});

/** 单飞去重：并发解析同一 key 时共享同一个上游请求 Promise */
const inFlight = new Map<string, Promise<string>>();

/** 解析输入（从 Movie 记录提取并规范化） */
interface ResolveTarget {
  type: 'openlist' | 'webdav';
  serverUrl: string;
  path: string;
}

/**
 * 从影片记录提取解析输入；不是 openlist/webdav 直链影片时返回 null。
 * openlist 的 movie.serverUrl 存的是添加时的原始输入（未 normalize），
 * 必须先 normalize 再匹配挂载表（与 /stream 端点同一处理）。
 */
function extractResolveTarget(movie: Movie): ResolveTarget | null {
  const type = movie.source;
  if (movie.directLink !== true || (type !== 'openlist' && type !== 'webdav')) {
    return null;
  }
  const serverUrlRaw = movie.serverUrl?.trim();
  const path = movie.path?.trim();
  if (!serverUrlRaw || !path) return null;
  const serverUrl =
    type === 'openlist' ? normalizeOpenListServerUrl(serverUrlRaw) : serverUrlRaw;
  return { type, serverUrl, path };
}

function buildCacheKey(target: ResolveTarget): string {
  return `${target.type}|${target.serverUrl}|${target.path}`;
}

/** 上游错误 → 带码解析错误（webdav 回退拼接路径之外的失败统一收口） */
function mapUpstreamError(err: unknown): MovieDirectResolveError {
  if (err instanceof OpenListError) {
    if (err.code === 'AUTH_FAILED') {
      return new MovieDirectResolveError('AUTH_FAILED', err.message);
    }
    if (err.code === 'NOT_FOUND') {
      return new MovieDirectResolveError('NOT_FOUND', err.message);
    }
  }
  return new MovieDirectResolveError(
    'UNREACHABLE',
    extractErrorMessage(err, '获取直链失败'),
  );
}

/** 不带缓存的实时解析（调用方已保证 target 有效） */
async function resolveUncached(movie: Movie, target: ResolveTarget): Promise<string> {
  // 内网地址拒绝返回直链（浏览器无法访问内网 raw_url），与现有 direct-url 端点一致
  if (isInternalOpenListServer(target.serverUrl)) {
    throw new MovieDirectResolveError(
      'INTERNAL_NETWORK_FORBIDDEN',
      '该挂载为内网地址，无法使用直链模式，请使用服务器转发',
    );
  }

  // 反查挂载：直链影片的请求者是房间成员而非挂载所有者（Movie 不存 userId），
  // 与 /stream 凭证回退同一模式，按 serverUrl + type 匹配
  const mount = await AppDataSource.getRepository(UserMount).findOneBy({
    serverUrl: target.serverUrl,
    type: target.type,
  });
  // 凭证回退：挂载已删除时用影片记录自身凭证（可能为空）
  const username = mount?.username || movie.username || undefined;
  const password = mount?.password || movie.password || undefined;

  let rawDirectUrl: string;
  try {
    // 两种类型都优先走 AList API（很多用户把 AList 以 WebDAV 类型挂载，
    // API 返回带签名的真实直链，比拼接 URL 更可靠）
    rawDirectUrl = await fetchOpenListDirectUrl(
      target.serverUrl,
      username,
      password,
      target.path,
    );
  } catch (err) {
    if (target.type === 'openlist') {
      // openlist 不回退拼接（与 /api/openlist/direct-url 行为一致）
      throw mapUpstreamError(err);
    }
    // webdav：明确是 AList 服务器但路径/凭证有问题 → 直接报错不回退；
    // 其他错误（可能根本不是 AList 服务器）→ 回退 WebDAV 拼接直链
    if (err instanceof OpenListError) {
      if (err.code === 'NOT_FOUND' || err.code === 'AUTH_FAILED') {
        throw mapUpstreamError(err);
      }
    }
    rawDirectUrl = buildWebDAVDirectUrl(target.serverUrl, target.path, username, password);
  }

  if (mount) {
    // https 升级 + 现场活性校验（源站 TLS 被移除时缓存自愈为 false）
    return upgradeDirectUrlValidated(mount, rawDirectUrl);
  }
  // 无挂载记录：无法做 httpsDirect 探测，原样返回（保持旧行为）
  return rawDirectUrl;
}

/**
 * 按影片记录实时解析直链（带 TTL 缓存与单飞去重）。
 *
 * @throws MovieDirectResolveError 影片不是 openlist/webdav 直链影片、
 *         挂载缺失、上游认证/路径错误或源站不可达
 */
export async function resolveMovieDirectUrl(movie: Movie): Promise<string> {
  const target = extractResolveTarget(movie);
  if (!target) {
    throw new MovieDirectResolveError(
      'INVALID_MOVIE',
      '该影片不是 openlist/webdav 直链影片，或缺少挂载服务器信息',
    );
  }

  const cacheKey = buildCacheKey(target);
  const cached = directUrlCache.get(cacheKey);
  if (cached) return cached;

  const pending = inFlight.get(cacheKey);
  if (pending) return pending;

  const promise = resolveUncached(movie, target)
    .then((directUrl) => {
      directUrlCache.set(cacheKey, directUrl);
      return directUrl;
    })
    .finally(() => {
      inFlight.delete(cacheKey);
    });
  inFlight.set(cacheKey, promise);
  return promise;
}
