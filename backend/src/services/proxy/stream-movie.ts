/**
 * 影片流统一凭证解析
 *
 * 将各挂载源 /stream 端点重复的"读取 Movie + 按 serverUrl 补凭证"逻辑收敛于此，
 * 保证 webdav / ftp / emby / jellyfin 的影片流代理行为一致：
 * - Movie 不存在 / 未挂载服务器信息 → 统一错误
 * - 旧影片可能未存储 username/password，从 UserMount 表按 serverUrl + source 补全
 * - 同时返回挂载记录（ftp 需要 port，emby/jellyfin 需要建 session）
 */
import { AppDataSource } from '../../data-source';
import { Movie } from '../../entities/Movie';
import { UserMount } from '../../entities/UserMount';
import { TtlCache } from '../../utils/ttl-cache';
import type { MountType } from '../../services/proxy/mount-proxy';

export class StreamMovieError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
    /** 熔断缓存命中（非首次判定）：调用方可据此静默日志，避免重试风暴刷屏 */
    public readonly fromCache = false,
  ) {
    super(message);
    this.name = 'StreamMovieError';
  }
}

export interface ResolvedMovieStream {
  movie: Movie;
  /** 凭证回退后的凭据（webdav/ftp 流使用） */
  username?: string;
  password?: string;
  /** 按 serverUrl + source 查到的挂载（ftp 补 port，emby/jellyfin 建 session） */
  mount?: UserMount;
}

/**
 * 「影片不存在」短期熔断缓存。
 *
 * 实测日志：房间内某个影片被删除后，客户端（含观众端自动重试）在 3 天内
 * 请求了该 movieId 的流 3717 次，每次都打库 + 打印完整错误堆栈（日志膨胀到
 * 2MB+）。此处在 TTL 窗口内直接快速失败，既不查库也不重复打日志。
 */
const NOT_FOUND_TTL_MS = 30_000;
/** movieId → 上次判定不存在的时间戳 */
const notFoundCache = new Map<number, number>();

/** 清理过期条目（写入时顺带执行，避免定时器常驻） */
function pruneNotFoundCache(now: number): void {
  for (const [id, at] of notFoundCache) {
    if (now - at >= NOT_FOUND_TTL_MS) notFoundCache.delete(id);
  }
}

// ── 影片流解析缓存 ─────────────────────────────────────
// /stream 每个 Range 请求都查一次 Movie + UserMount；影片/挂载记录变更
// 频率极低，30s TTL 缓存即可显著削减 DB 压力。movie.service 的
// updateMovie/deleteMovie/clearMovies 调用 invalidateMovieStreamCache
// 主动失效，保证切源/改路径后 30s 内立即生效。
const MOVIE_STREAM_CACHE_TTL_MS = 30_000;
const movieStreamCache = new TtlCache<ResolvedMovieStream>({
  ttlMs: MOVIE_STREAM_CACHE_TTL_MS,
  maxSize: 500,
});

/** 影片更新/删除后调用：失效该影片的流解析缓存 */
export function invalidateMovieStreamCache(movieId: number): void {
  movieStreamCache.delete(String(movieId));
}

/** 批量删除影片后调用：清空全部流解析缓存 */
export function clearMovieStreamCache(): void {
  movieStreamCache.clear();
}

export interface ResolveMovieStreamOptions {
  /**
   * 挂载回退匹配前对 movie.serverUrl 做规范化（openlist 存原始输入地址，
   * 挂载表存 normalize 后地址，不 normalize 会因 /dav 后缀差异匹配落空）。
   */
  normalizeServerUrl?: (url: string) => string;
}

/**
 * 解析影片流所需的 Movie 与凭证。
 *
 * 挂载解析优先级：
 * 1. movie.sourceMountId（添加/更新影片时锚定的挂载，消除多挂载歧义）；
 * 2. 按 serverUrl + source 匹配（旧数据兜底，挂载删除后也走此路径）。
 *
 * @param movieId 影片 ID
 * @param source  挂载源类型（webdav/ftp/emby/jellyfin/openlist）
 */
export async function resolveMovieStream(
  movieId: number,
  source: MountType,
  options?: ResolveMovieStreamOptions,
): Promise<ResolvedMovieStream> {
  const now = Date.now();
  // 熔断：窗口内已知不存在的 movieId 直接失败（不打库、不打日志）
  const cachedAt = notFoundCache.get(movieId);
  if (cachedAt != null && now - cachedAt < NOT_FOUND_TTL_MS) {
    throw new StreamMovieError('影片不存在', 'NOT_FOUND', 404, true);
  }
  pruneNotFoundCache(now);

  const streamCacheKey = String(movieId);
  const cached = movieStreamCache.get(streamCacheKey);
  if (cached) {
    return cached;
  }

  const movie = await AppDataSource.getRepository(Movie).findOneBy({ id: movieId });
  if (!movie) {
    notFoundCache.set(movieId, now);
    throw new StreamMovieError('影片不存在', 'NOT_FOUND', 404);
  }
  if (!movie.serverUrl || !movie.path) {
    throw new StreamMovieError('该影片未挂载服务器信息', 'NO_SERVER', 400);
  }

  const mountRepo = AppDataSource.getRepository(UserMount);
  // 优先按锚定的挂载 ID 取（同服务器多用户挂载时凭证确定）
  let mount: UserMount | null = null;
  if (movie.sourceMountId) {
    mount = await mountRepo.findOneBy({ id: movie.sourceMountId, type: source });
  }
  // 旧数据兜底：按 serverUrl 匹配（openlist 需先 normalize）
  if (!mount) {
    const targetUrl = options?.normalizeServerUrl
      ? options.normalizeServerUrl(movie.serverUrl)
      : movie.serverUrl;
    mount = await mountRepo.findOneBy({ serverUrl: targetUrl, type: source });
  }

  let username = movie.username || undefined;
  let password = movie.password || undefined;
  if (mount) {
    username = username || mount.username || undefined;
    password = password || mount.password || undefined;
  }

  const resolved: ResolvedMovieStream = {
    movie,
    username,
    password,
    mount: mount ?? undefined,
  };
  movieStreamCache.set(streamCacheKey, resolved);
  return resolved;
}
