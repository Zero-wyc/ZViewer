import { Router, Response } from 'express';
import { Server as SocketIOServer } from 'socket.io';
import { AppDataSource } from '../data-source';
import { Movie } from '../entities/Movie';
import { Room } from '../entities/Room';
import { Session } from '../entities/Session';
import { IsNull } from 'typeorm';
import {
  authenticateToken,
  AuthenticatedRequest,
} from '../middleware/auth';

const movieRepository = () => AppDataSource.getRepository(Movie);
const roomRepository = () => AppDataSource.getRepository(Room);
const sessionRepository = () => AppDataSource.getRepository(Session);

interface QualityOption {
  id: number;
  label: string;
  resolution?: string;
}

interface MovieDto {
  id: number;
  roomId: string;
  url: string;
  title: string;
  cover: string | null;
  source: string | null;
  audioUrl: string | null;
  format: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  duration: number | null;
  cid: number | null;
  currentQn: number | null;
  acceptQuality: QualityOption[] | null;
  serverUrl: string | null;
  path: string | null;
  username: string | null;
  directLink: boolean;
  order: number;
  createdAt: string;
  updatedAt: string;
}

function normalizeAcceptQuality(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value.trim() || null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function parseAcceptQuality(value: string | null): QualityOption[] | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed as QualityOption[];
    return null;
  } catch {
    return null;
  }
}

function serializeMovie(movie: Movie): MovieDto {
  return {
    id: movie.id,
    roomId: movie.roomId,
    url: movie.url,
    title: movie.title,
    cover: movie.cover,
    source: movie.source,
    audioUrl: movie.audioUrl,
    format: movie.format,
    videoCodec: movie.videoCodec,
    audioCodec: movie.audioCodec,
    duration: movie.duration,
    cid: movie.cid,
    currentQn: movie.currentQn,
    acceptQuality: parseAcceptQuality(movie.acceptQuality),
    serverUrl: movie.serverUrl,
    path: movie.path,
    username: movie.username,
    directLink: movie.directLink,
    order: movie.order,
    createdAt: movie.createdAt.toISOString(),
    updatedAt: movie.updatedAt.toISOString(),
  };
}

async function broadcastMovieList(
  io: SocketIOServer,
  roomId: string,
): Promise<void> {
  const movies = await movieRepository().find({
    where: { roomId },
    order: { order: 'ASC', id: 'ASC' },
  });
  io.to(roomId).emit('movie-list', {
    movies: movies.map(serializeMovie),
  });
}

export function createRoomsRouter(io: SocketIOServer): Router {
  const router = Router();

  router.use(authenticateToken);

  // GET /api/rooms - 获取房间列表
  router.get(
    '/',
    async (_req: AuthenticatedRequest, res: Response) => {
      try {
        const roomRepo = roomRepository();
        const sessionRepo = sessionRepository();
        const rooms = await roomRepo.find({
          where: { status: 'active' },
          order: { lastAccessedAt: 'DESC' },
        });

        const result = await Promise.all(
          rooms.map(async (room) => {
            const viewerCount = await sessionRepo.count({
              where: { roomId: room.roomId, role: 'viewer', endedAt: IsNull() },
            });
            const sharer = await sessionRepo.findOneBy({
              roomId: room.roomId,
              role: 'sharer',
              endedAt: IsNull(),
            });
            return {
              id: room.id,
              roomId: room.roomId,
              name: room.name,
              status: room.status,
              requireApproval: room.requireApproval,
              maxViewers: room.maxViewers,
              hasPassword: !!room.password,
              viewerCount,
              sharerOnline: !!sharer,
              mode: room.mode,
              lastAccessedAt: room.lastAccessedAt.toISOString(),
              createdAt: room.createdAt.toISOString(),
            };
          }),
        );

        res.json({ success: true, rooms: result });
      } catch (err) {
        console.error('get rooms error:', err);
        res.status(500).json({ success: false, message: '获取房间列表失败' });
      }
    },
  );

  // PUT /api/rooms/:roomId/name - 修改房间名称（管理员）
  router.put(
    '/:roomId/name',
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        if (req.user?.role !== 'admin') {
          res.status(403).json({ success: false, message: '无权限：仅管理员可修改房间名称' });
          return;
        }

        const roomId = req.params.roomId as string;
        const { name } = req.body as { name?: unknown };
        const trimmed = typeof name === 'string' ? name.trim() : '';
        if (!trimmed) {
          res.status(400).json({ success: false, message: '房间名称不能为空' });
          return;
        }

        const roomRepo = roomRepository();
        const room = await roomRepo.findOneBy({ roomId });
        if (!room) {
          res.status(404).json({ success: false, message: '房间不存在' });
          return;
        }

        room.name = trimmed;
        await roomRepo.save(room);

        io.to(roomId).emit('room-name-updated', { roomId, name: trimmed });
        res.json({ success: true, room: { roomId, name: trimmed } });
      } catch (err) {
        console.error('update room name error:', err);
        res.status(500).json({ success: false, message: '修改房间名称失败' });
      }
    },
  );

  // GET /api/rooms/:roomId/movies - 获取影片列表
  router.get(
    '/:roomId/movies',
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const roomId = req.params.roomId as string;
        const movies = await movieRepository().find({
          where: { roomId },
          order: { order: 'ASC', id: 'ASC' },
        });
        res.json({ success: true, movies: movies.map(serializeMovie) });
      } catch (err) {
        console.error('get movies error:', err);
        res.status(500).json({ success: false, message: '获取影片列表失败' });
      }
    },
  );

  // POST /api/rooms/:roomId/movies - 新增影片
  router.post(
    '/:roomId/movies',
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const roomId = req.params.roomId as string;
        const {
          url,
          title,
          cover,
          source,
          audioUrl,
          format,
          videoCodec,
          audioCodec,
          duration,
          cid,
          currentQn,
          acceptQuality,
          serverUrl,
          path,
          username,
          password,
          directLink,
        } = req.body as {
          url?: unknown;
          title?: unknown;
          cover?: unknown;
          source?: unknown;
          audioUrl?: unknown;
          format?: unknown;
          videoCodec?: unknown;
          audioCodec?: unknown;
          duration?: unknown;
          cid?: unknown;
          currentQn?: unknown;
          acceptQuality?: unknown;
          serverUrl?: unknown;
          path?: unknown;
          username?: unknown;
          password?: unknown;
          directLink?: unknown;
        };

        if (
          typeof url !== 'string' ||
          !url.trim() ||
          typeof title !== 'string' ||
          !title.trim()
        ) {
          res
            .status(400)
            .json({ success: false, message: 'url 和 title 为必填项' });
          return;
        }

        const room = await roomRepository().findOneBy({ roomId });
        if (!room) {
          res.status(404).json({ success: false, message: '房间不存在' });
          return;
        }

        const existing = await movieRepository().find({
          where: { roomId },
          order: { order: 'DESC' },
        });
        const nextOrder = existing.length > 0 ? existing[0].order + 1 : 0;

        const movie = movieRepository().create({
          roomId,
          url: url.trim(),
          title: title.trim(),
          cover: typeof cover === 'string' ? cover : null,
          source: typeof source === 'string' ? source : null,
          audioUrl: typeof audioUrl === 'string' ? audioUrl : null,
          format: typeof format === 'string' ? format : null,
          videoCodec: typeof videoCodec === 'string' ? videoCodec : null,
          audioCodec: typeof audioCodec === 'string' ? audioCodec : null,
          duration:
            typeof duration === 'number' && Number.isFinite(duration)
              ? duration
              : null,
          cid:
            typeof cid === 'number' && Number.isFinite(cid) ? cid : null,
          currentQn:
            typeof currentQn === 'number' && Number.isFinite(currentQn)
              ? currentQn
              : null,
          acceptQuality: normalizeAcceptQuality(acceptQuality),
          serverUrl: typeof serverUrl === 'string' ? serverUrl : null,
          path: typeof path === 'string' ? path : null,
          username: typeof username === 'string' ? username : null,
          password: typeof password === 'string' ? password : null,
          directLink: directLink === true,
          order: nextOrder,
        });
        await movieRepository().save(movie);

        await broadcastMovieList(io, roomId);
        res.status(201).json({ success: true, movie: serializeMovie(movie) });
      } catch (err) {
        console.error('create movie error:', err);
        res.status(500).json({ success: false, message: '新增影片失败' });
      }
    },
  );

  // POST /api/rooms/:roomId/movies/reorder - 批量重排序
  router.post(
    '/:roomId/movies/reorder',
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const roomId = req.params.roomId as string;
        const { orderedIds } = req.body as { orderedIds?: unknown };

        if (!Array.isArray(orderedIds)) {
          res
            .status(400)
            .json({ success: false, message: 'orderedIds 必须是数组' });
          return;
        }

        const room = await roomRepository().findOneBy({ roomId });
        if (!room) {
          res.status(404).json({ success: false, message: '房间不存在' });
          return;
        }

        await AppDataSource.transaction(async (manager) => {
          for (let i = 0; i < orderedIds.length; i++) {
            const id = Number(orderedIds[i]);
            if (!Number.isFinite(id)) continue;
            await manager.update(Movie, { id, roomId }, { order: i });
          }
        });

        await broadcastMovieList(io, roomId);
        res.json({ success: true });
      } catch (err) {
        console.error('reorder movies error:', err);
        res.status(500).json({ success: false, message: '重排序失败' });
      }
    },
  );

  // PUT /api/rooms/:roomId/movies/:movieId - 更新影片
  router.put(
    '/:roomId/movies/:movieId',
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const roomId = req.params.roomId as string;
        const movieId = Number(req.params.movieId);
        const {
          url,
          title,
          cover,
          order,
          audioUrl,
          format,
          videoCodec,
          audioCodec,
          duration,
          cid,
          currentQn,
          acceptQuality,
          serverUrl,
          path,
          username,
          password,
          directLink,
        } = req.body as {
          url?: unknown;
          title?: unknown;
          cover?: unknown;
          order?: unknown;
          audioUrl?: unknown;
          format?: unknown;
          videoCodec?: unknown;
          audioCodec?: unknown;
          duration?: unknown;
          cid?: unknown;
          currentQn?: unknown;
          acceptQuality?: unknown;
          serverUrl?: unknown;
          path?: unknown;
          username?: unknown;
          password?: unknown;
          directLink?: unknown;
        };

        const movie = await movieRepository().findOneBy({
          id: movieId,
          roomId,
        });
        if (!movie) {
          res.status(404).json({ success: false, message: '影片不存在' });
          return;
        }

        const update: {
          url?: string;
          title?: string;
          cover?: string | null;
          order?: number;
          audioUrl?: string | null;
          format?: string | null;
          videoCodec?: string | null;
          audioCodec?: string | null;
          duration?: number | null;
          cid?: number | null;
          currentQn?: number | null;
          acceptQuality?: string | null;
          serverUrl?: string | null;
          path?: string | null;
          username?: string | null;
          password?: string | null;
          directLink?: boolean;
        } = {};
        if (typeof url === 'string' && url.trim()) update.url = url.trim();
        if (typeof title === 'string' && title.trim())
          update.title = title.trim();
        if (typeof cover === 'string') update.cover = cover;
        if (typeof order === 'number' && Number.isFinite(order))
          update.order = order;
        if (typeof audioUrl === 'string') update.audioUrl = audioUrl;
        if (typeof format === 'string') update.format = format;
        if (typeof videoCodec === 'string') update.videoCodec = videoCodec;
        if (typeof audioCodec === 'string') update.audioCodec = audioCodec;
        if (typeof duration === 'number' && Number.isFinite(duration))
          update.duration = duration;
        if (typeof cid === 'number' && Number.isFinite(cid))
          update.cid = cid;
        if (typeof currentQn === 'number' && Number.isFinite(currentQn))
          update.currentQn = currentQn;
        if (acceptQuality !== undefined)
          update.acceptQuality = normalizeAcceptQuality(acceptQuality);
        if (typeof serverUrl === 'string') update.serverUrl = serverUrl;
        if (typeof path === 'string') update.path = path;
        if (typeof username === 'string') update.username = username;
        if (typeof password === 'string') update.password = password;
        if (typeof directLink === 'boolean') update.directLink = directLink;

        await movieRepository().update({ id: movie.id }, update);
        await broadcastMovieList(io, roomId);
        res.json({ success: true });
      } catch (err) {
        console.error('update movie error:', err);
        res.status(500).json({ success: false, message: '更新影片失败' });
      }
    },
  );

  // DELETE /api/rooms/:roomId/movies/:movieId - 删除影片
  router.delete(
    '/:roomId/movies/:movieId',
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const roomId = req.params.roomId as string;
        const movieId = Number(req.params.movieId);
        const movie = await movieRepository().findOneBy({
          id: movieId,
          roomId,
        });
        if (!movie) {
          res.status(404).json({ success: false, message: '影片不存在' });
          return;
        }

        await movieRepository().remove(movie);
        await broadcastMovieList(io, roomId);
        res.json({ success: true });
      } catch (err) {
        console.error('delete movie error:', err);
        res.status(500).json({ success: false, message: '删除影片失败' });
      }
    },
  );

  return router;
}
