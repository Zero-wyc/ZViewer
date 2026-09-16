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
import type { MountType } from '../../services/proxy/mount-proxy';

export class StreamMovieError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
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

/**
 * 解析影片流所需的 Movie 与凭证。
 * @param movieId 影片 ID
 * @param source  挂载源类型（webdav/ftp/emby/jellyfin）
 */
export async function resolveMovieStream(
  movieId: number,
  source: MountType,
): Promise<ResolvedMovieStream> {
  const now = Date.now();
  // 熔断：窗口内已知不存在的 movieId 直接失败（不打库、不打日志）
  const cachedAt = notFoundCache.get(movieId);
  if (cachedAt != null && now - cachedAt < NOT_FOUND_TTL_MS) {
    throw new StreamMovieError('影片不存在', 'NOT_FOUND', 404);
  }
  pruneNotFoundCache(now);
  const movie = await AppDataSource.getRepository(Movie).findOneBy({ id: movieId });
  if (!movie) {
    notFoundCache.set(movieId, now);
    throw new StreamMovieError('影片不存在', 'NOT_FOUND', 404);
  }
  if (!movie.serverUrl || !movie.path) {
    throw new StreamMovieError('该影片未挂载服务器信息', 'NO_SERVER', 400);
  }

  let username = movie.username || undefined;
  let password = movie.password || undefined;
  const mount = await AppDataSource.getRepository(UserMount).findOneBy({
    serverUrl: movie.serverUrl,
    type: source,
  });
  if (mount) {
    username = username || mount.username || undefined;
    password = password || mount.password || undefined;
  }

  return { movie, username, password, mount: mount ?? undefined };
}
