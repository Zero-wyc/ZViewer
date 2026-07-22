/**
 * 影片 CRUD 服务。
 *
 * 封装 Movie 实体的所有数据库操作，包括列表查询、创建、更新、删除、重排序。
 *
 * 设计目的：
 * - 消除旧架构中 routes/rooms.ts 内联的 movieRepository 操作
 * - 统一 DB Movie 实体 → MovieDto 的序列化逻辑
 * - 创建时自动计算 order（当前最大 order + 1）
 *
 * 注意：
 * - acceptQuality 在 DB 中是 JSON 字符串，DTO 中保持 string 类型
 * - password 在 DB 中通过 ValueTransformer 自动加密/解密，DTO 中返回解密后的值
 */
import { AppDataSource } from '../../data-source';
import { Movie } from '../../entities/Movie';
import type { MovieDto, MovieSourceType } from '../shared';

/** 影片实体别名，便于类型引用 */
type MovieEntity = Movie;

/**
 * 将任意值规范化为 acceptQuality 字符串。
 *
 * - string：trim 后返回（空字符串返回 null）
 * - 其他类型：JSON.stringify 后返回（失败返回 null）
 * - null/undefined：返回 null
 */
function normalizeAcceptQuality(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value.trim() || null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

/**
 * 影片 CRUD 服务。
 *
 * 单例服务，所有方法均返回 Promise。
 */
export class MovieService {
  /**
   * 查询指定房间的影片列表并序列化为 MovieDto[]。
   *
   * 按 order 升序、id 升序排列。
   */
  async listMovies(roomId: string): Promise<MovieDto[]> {
    const repo = AppDataSource.getRepository(Movie);
    const movies = await repo.find({
      where: { roomId },
      order: { order: 'ASC', id: 'ASC' },
    });
    return movies.map((m) => this.serializeMovie(m));
  }

  /**
   * 创建影片。
   *
   * 自动计算 order（当前最大 order + 1）。
   * 必填字段：url、title。
   *
   * @returns 序列化后的 MovieDto
   */
  async createMovie(roomId: string, data: Partial<MovieDto>): Promise<MovieDto> {
    const repo = AppDataSource.getRepository(Movie);

    // 计算 nextOrder：取当前最大 order + 1
    const existing = await repo.find({
      where: { roomId },
      order: { order: 'DESC' },
    });
    const nextOrder = existing.length > 0 ? existing[0].order + 1 : 0;

    const movie = repo.create({
      roomId,
      url: (data.url ?? '').trim(),
      title: (data.title ?? '').trim(),
      cover: typeof data.cover === 'string' ? data.cover : null,
      source: typeof data.source === 'string' ? (data.source as MovieSourceType | string) : null,
      audioUrl: typeof data.audioUrl === 'string' ? data.audioUrl : null,
      format: typeof data.format === 'string' ? data.format : null,
      videoCodec: typeof data.videoCodec === 'string' ? data.videoCodec : null,
      audioCodec: typeof data.audioCodec === 'string' ? data.audioCodec : null,
      duration:
        typeof data.duration === 'number' && Number.isFinite(data.duration)
          ? data.duration
          : null,
      cid:
        typeof data.cid === 'number' && Number.isFinite(data.cid) ? data.cid : null,
      currentQn:
        typeof data.currentQn === 'number' && Number.isFinite(data.currentQn)
          ? data.currentQn
          : null,
      acceptQuality: normalizeAcceptQuality(data.acceptQuality),
      serverUrl: typeof data.serverUrl === 'string' ? data.serverUrl : null,
      path: typeof data.path === 'string' ? data.path : null,
      username: typeof data.username === 'string' ? data.username : null,
      password: typeof data.password === 'string' ? data.password : null,
      directLink: data.directLink === true,
      order: nextOrder,
    });

    await repo.save(movie);
    return this.serializeMovie(movie);
  }

  /**
   * 更新影片。
   *
   * 仅更新 data 中提供的字段。
   *
   * @returns 序列化后的 MovieDto，若影片不存在返回 null
   */
  async updateMovie(
    roomId: string,
    movieId: number,
    data: Partial<MovieDto>,
  ): Promise<MovieDto | null> {
    const repo = AppDataSource.getRepository(Movie);
    const movie = await repo.findOneBy({ id: movieId, roomId });
    if (!movie) return null;

    const update: Partial<Movie> = {};
    if (typeof data.url === 'string' && data.url.trim()) update.url = data.url.trim();
    if (typeof data.title === 'string' && data.title.trim()) update.title = data.title.trim();
    if (typeof data.cover === 'string') update.cover = data.cover;
    if (typeof data.order === 'number' && Number.isFinite(data.order)) update.order = data.order;
    if (typeof data.source === 'string') update.source = data.source;
    if (typeof data.audioUrl === 'string') update.audioUrl = data.audioUrl;
    if (typeof data.format === 'string') update.format = data.format;
    if (typeof data.videoCodec === 'string') update.videoCodec = data.videoCodec;
    if (typeof data.audioCodec === 'string') update.audioCodec = data.audioCodec;
    if (typeof data.duration === 'number' && Number.isFinite(data.duration)) update.duration = data.duration;
    if (typeof data.cid === 'number' && Number.isFinite(data.cid)) update.cid = data.cid;
    if (typeof data.currentQn === 'number' && Number.isFinite(data.currentQn)) update.currentQn = data.currentQn;
    if (data.acceptQuality !== undefined) update.acceptQuality = normalizeAcceptQuality(data.acceptQuality);
    if (typeof data.serverUrl === 'string') update.serverUrl = data.serverUrl;
    if (typeof data.path === 'string') update.path = data.path;
    if (typeof data.username === 'string') update.username = data.username;
    if (typeof data.password === 'string') update.password = data.password;
    if (typeof data.directLink === 'boolean') update.directLink = data.directLink;

    await repo.update({ id: movie.id }, update);

    // 重新查询以获取更新后的实体（含 ValueTransformer 解密后的 password）
    const refreshed = await repo.findOneBy({ id: movie.id, roomId });
    return refreshed ? this.serializeMovie(refreshed) : null;
  }

  /**
   * 删除影片。
   *
   * @returns 是否删除成功
   */
  async deleteMovie(roomId: string, movieId: number): Promise<boolean> {
    const repo = AppDataSource.getRepository(Movie);
    const movie = await repo.findOneBy({ id: movieId, roomId });
    if (!movie) return false;
    await repo.remove(movie);
    return true;
  }

  /**
   * 批量重排序影片。
   *
   * 在事务中按 orders 数组顺序依次更新 order 字段。
   *
   * @param roomId 房间 ID
   * @param orders 影片 ID 与新 order 的映射数组
   */
  async reorderMovies(
    roomId: string,
    orders: { id: number; order: number }[],
  ): Promise<void> {
    await AppDataSource.transaction(async (manager) => {
      for (const item of orders) {
        if (!Number.isFinite(item.id) || !Number.isFinite(item.order)) continue;
        await manager.update(Movie, { id: item.id, roomId }, { order: item.order });
      }
    });
  }

  /**
   * 序列化 DB Movie 实体为 MovieDto。
   *
   * - password 字段由 ValueTransformer 自动解密
   * - acceptQuality 保持 JSON 字符串形式
   * - createdAt/updatedAt 转 ISO 字符串
   */
  serializeMovie(movie: MovieEntity): MovieDto {
    return {
      id: movie.id,
      roomId: movie.roomId,
      url: movie.url,
      title: movie.title,
      cover: movie.cover,
      source: (movie.source as MovieSourceType | null) ?? null,
      audioUrl: movie.audioUrl,
      format: movie.format,
      videoCodec: movie.videoCodec,
      audioCodec: movie.audioCodec,
      duration: movie.duration,
      cid: movie.cid,
      currentQn: movie.currentQn,
      acceptQuality: movie.acceptQuality,
      serverUrl: movie.serverUrl,
      path: movie.path,
      username: movie.username,
      password: movie.password,
      directLink: movie.directLink,
      order: movie.order,
      createdAt: movie.createdAt.toISOString(),
      updatedAt: movie.updatedAt.toISOString(),
    };
  }
}

/** 全局单例 */
export const movieService = new MovieService();
