/**
 * 影片 CRUD 服务。v2
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
 * 将 DB 中的 acceptQuality JSON 字符串解析为数组。
 *
 * DB 中存储为 JSON 字符串（如 '[{"id":80,"label":"1080P","resolution":"1920x1080"}]'），
 * 前端期望数组形式。解析失败或非数组时返回 null。
 */
function parseAcceptQualityArray(
  value: string | null | undefined,
): { id: number; label: string; resolution?: string }[] | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed as { id: number; label: string; resolution?: string }[];
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 将 ani-subs 番剧源元数据规范化为 JSON 字符串存储。
 *
 * 前端传入 sourceMeta 对象（{ sourceId, episode, originalTitle }），
 * 序列化为 JSON 字符串存入 DB。
 * - 对象：JSON.stringify 后返回
 * - string：视为已序列化的 JSON，trim 后返回
 * - null/undefined/空对象：返回 null
 */
function normalizeSourceMeta(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'object') {
    try {
      const json = JSON.stringify(value);
      // 空对象或 "{}" 视为无值
      return json === '{}' ? null : json;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * 将 DB 中的 sourceMeta JSON 字符串解析为对象。
 *
 * DB 中存储为 JSON 字符串（如 '{"sourceId":"xxx","episode":{...},"originalTitle":"..."}'），
 * 前端期望对象形式。解析失败时返回 null。
 */
function parseSourceMeta(
  value: string | null | undefined,
): MovieDto['sourceMeta'] {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && 'sourceId' in parsed) {
      return parsed as NonNullable<MovieDto['sourceMeta']>;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 将任意值规范化为 pages 字符串（JSON 序列化）。
 *
 * - string：trim 后返回（空字符串返回 null，视为已序列化的 JSON）
 * - 数组：JSON.stringify 后返回
 * - 其他类型：null
 */
function normalizePages(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value.trim() || null;
  if (Array.isArray(value)) {
    try {
      return JSON.stringify(value);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * 将 DB 中的 pages JSON 字符串解析为数组。
 *
 * DB 中存储为 JSON 字符串（如 '[{"page":1,"cid":123,"part":"P1","duration":176}]'），
 * 前端期望数组形式。解析失败或非数组时返回 null。
 */
function parsePagesArray(
  value: string | null | undefined,
): { page: number; cid: number; part: string; duration: number }[] | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed as { page: number; cid: number; part: string; duration: number }[];
    }
    return null;
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

    // 调试日志：检查 pages 字段是否被正确接收
    console.log('[movie.service] createMovie input data:', {
      hasPages: data.pages !== undefined,
      pagesType: typeof data.pages,
      pagesValue: data.pages,
      currentPage: data.currentPage,
      title: data.title,
    });

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
      pages: normalizePages(data.pages),
      currentPage:
        typeof data.currentPage === 'number' && Number.isFinite(data.currentPage)
          ? data.currentPage
          : null,
      serverUrl: typeof data.serverUrl === 'string' ? data.serverUrl : null,
      path: typeof data.path === 'string' ? data.path : null,
      username: typeof data.username === 'string' ? data.username : null,
      password: typeof data.password === 'string' ? data.password : null,
      directLink: data.directLink === true,
      wasmEngine: data.wasmEngine === true,
      playsvideoEnabled: data.playsvideoEnabled !== false,
      sourceMeta: normalizeSourceMeta(data.sourceMeta),
      order: nextOrder,
    });

    await repo.save(movie);

    // 代理模式下，用新生成的 movieId 重写 url 为基于影片 ID 的 stream URL，
    // 这样房间内任何成员（含观众）都能访问该影片流，不依赖 userId 查询挂载表。
    // 直链模式下 url 已是真实下载 URL（OpenList 由后端 /direct-url 接口获取，
    // WebDAV 由后端 /direct-url 接口拼接），无需重写。
    const sourceType = typeof data.source === 'string' ? data.source : '';
    const isProxyMode = data.directLink !== true && ['webdav', 'openlist', 'ftp', 'emby', 'jellyfin'].includes(sourceType);
    if (isProxyMode && movie.id) {
      const streamUrl = `/api/${sourceType}/stream?movieId=${movie.id}`;
      await repo.update({ id: movie.id }, { url: streamUrl });
      movie.url = streamUrl;
    }

    // 音轨编码由前端 MKV demux 探测回填（添加影片时），后端不再探测

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
    if (data.pages !== undefined) update.pages = normalizePages(data.pages);
    if (typeof data.currentPage === 'number' && Number.isFinite(data.currentPage)) update.currentPage = data.currentPage;
    if (typeof data.serverUrl === 'string') update.serverUrl = data.serverUrl;
    if (typeof data.path === 'string') update.path = data.path;
    if (typeof data.username === 'string') update.username = data.username;
    if (typeof data.password === 'string') update.password = data.password;
    if (typeof data.directLink === 'boolean') update.directLink = data.directLink;
    if (typeof data.wasmEngine === 'boolean') update.wasmEngine = data.wasmEngine;
    if (typeof data.playsvideoEnabled === 'boolean') update.playsvideoEnabled = data.playsvideoEnabled;
    if (data.sourceMeta !== undefined) update.sourceMeta = normalizeSourceMeta(data.sourceMeta);

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
   * - acceptQuality JSON 字符串解析为数组返回（前端期望数组形式）
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
      acceptQuality: parseAcceptQualityArray(movie.acceptQuality),
      pages: parsePagesArray(movie.pages),
      currentPage: movie.currentPage,
      serverUrl: movie.serverUrl,
      path: movie.path,
      username: movie.username,
      password: movie.password,
      directLink: movie.directLink,
      wasmEngine: movie.wasmEngine,
      playsvideoEnabled: movie.playsvideoEnabled !== false,
      sourceMeta: parseSourceMeta(movie.sourceMeta),
      order: movie.order,
      createdAt: movie.createdAt.toISOString(),
      updatedAt: movie.updatedAt.toISOString(),
    };
  }
}

/** 全局单例 */
export const movieService = new MovieService();
