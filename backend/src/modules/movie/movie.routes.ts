/**
 * 影片 REST API 路由。
 *
 * 挂载在 /api/rooms/:roomId/movies 下，提供影片 CRUD 与重排序接口。
 *
 * 设计目的：
 * - 消除旧架构中 routes/rooms.ts 内联的影片 REST 路由
 * - 所有写操作完成后统一调用 movieBroadcasterService.broadcastMovieList 广播
 * - 权限校验：root 或房间 owner（通过 Room.ownerUserId 判断）
 *
 * 路由列表：
 * - GET    /api/rooms/:roomId/movies           获取影片列表
 * - POST   /api/rooms/:roomId/movies           新增影片
 * - POST   /api/rooms/:roomId/movies/reorder   批量重排序
 * - PUT    /api/rooms/:roomId/movies/:movieId   更新影片
 * - DELETE /api/rooms/:roomId/movies/:movieId   删除影片
 */
import { Router, type Response } from 'express';
import type { Server as SocketIOServer } from 'socket.io';
import { AppDataSource } from '../../data-source';
import { Room } from '../../entities/Room';
import {
  authenticateToken,
  type AuthenticatedRequest,
} from '../../middleware/auth';
import { movieService } from './movie.service';
import { movieBroadcasterService } from './movie-broadcaster.service';
import type { MovieDto } from '../shared';

/**
 * 校验请求方是否有权限操作房间影片（root 或房间 owner）。
 *
 * 与旧架构 routes/rooms.ts 的 canControlRoom 保持一致：
 * - root 角色：允许
 * - admin 角色 + room.ownerUserId === userId：允许
 * - 其他：拒绝
 */
function canControlRoom(req: AuthenticatedRequest, room: Room): boolean {
  const role = req.user?.role;
  if (role === 'root') return true;
  if (role === 'admin' && room.ownerUserId === req.user?.userId) return true;
  return false;
}

/**
 * 创建影片 REST 路由。
 *
 * @param io Socket.IO 服务实例，用于广播影片列表变更
 */
export function createMovieRouter(io: SocketIOServer): Router {
  const router = Router();

  // 所有路由都需要登录认证
  router.use(authenticateToken);

  // GET /api/rooms/:roomId/movies - 获取影片列表
  router.get(
    '/:roomId/movies',
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const roomId = req.params.roomId as string;
        const movies = await movieService.listMovies(roomId);
        res.json({ success: true, movies });
      } catch (err) {
        console.error('[GET /movies] error:', err);
        res.status(500).json({ success: false, message: '获取影片列表失败' });
      }
    },
  );

  // POST /api/rooms/:roomId/movies - 新增影片（仅 root 或房间 owner）
  router.post(
    '/:roomId/movies',
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const roomId = req.params.roomId as string;
        const roomRepo = AppDataSource.getRepository(Room);
        const room = await roomRepo.findOneBy({ roomId });
        if (!room) {
          res.status(404).json({ success: false, message: '房间不存在' });
          return;
        }
        if (!canControlRoom(req, room)) {
          res.status(403).json({ success: false, message: '无权限：仅 root 或房间创建者可新增影片' });
          return;
        }

        const data = req.body as Partial<MovieDto>;
        if (typeof data.url !== 'string' || !data.url.trim() || typeof data.title !== 'string' || !data.title.trim()) {
          res.status(400).json({ success: false, message: 'url 和 title 为必填项' });
          return;
        }

        const movie = await movieService.createMovie(roomId, data);
        await movieBroadcasterService.broadcastMovieList(io, roomId);
        res.status(201).json({ success: true, movie });
      } catch (err) {
        console.error('[POST /movies] error:', err);
        res.status(500).json({ success: false, message: '新增影片失败' });
      }
    },
  );

  // POST /api/rooms/:roomId/movies/reorder - 批量重排序（仅 root 或房间 owner）
  router.post(
    '/:roomId/movies/reorder',
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const roomId = req.params.roomId as string;
        const { orders } = req.body as { orders?: { id: number; order: number }[] };

        if (!Array.isArray(orders)) {
          res.status(400).json({ success: false, message: 'orders 必须是数组' });
          return;
        }

        const roomRepo = AppDataSource.getRepository(Room);
        const room = await roomRepo.findOneBy({ roomId });
        if (!room) {
          res.status(404).json({ success: false, message: '房间不存在' });
          return;
        }
        if (!canControlRoom(req, room)) {
          res.status(403).json({ success: false, message: '无权限：仅 root 或房间创建者可重排序影片' });
          return;
        }

        await movieService.reorderMovies(roomId, orders);
        await movieBroadcasterService.broadcastMovieList(io, roomId);
        res.json({ success: true });
      } catch (err) {
        console.error('[POST /movies/reorder] error:', err);
        res.status(500).json({ success: false, message: '重排序失败' });
      }
    },
  );

  // PUT /api/rooms/:roomId/movies/:movieId - 更新影片（仅 root 或房间 owner）
  router.put(
    '/:roomId/movies/:movieId',
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const roomId = req.params.roomId as string;
        const movieId = Number(req.params.movieId);
        if (!Number.isFinite(movieId)) {
          res.status(400).json({ success: false, message: 'movieId 无效' });
          return;
        }

        const roomRepo = AppDataSource.getRepository(Room);
        const room = await roomRepo.findOneBy({ roomId });
        if (!room) {
          res.status(404).json({ success: false, message: '房间不存在' });
          return;
        }
        if (!canControlRoom(req, room)) {
          res.status(403).json({ success: false, message: '无权限：仅 root 或房间创建者可更新影片' });
          return;
        }

        const data = req.body as Partial<MovieDto>;
        const updated = await movieService.updateMovie(roomId, movieId, data);
        if (!updated) {
          res.status(404).json({ success: false, message: '影片不存在' });
          return;
        }

        await movieBroadcasterService.broadcastMovieList(io, roomId);
        res.json({ success: true, movie: updated });
      } catch (err) {
        console.error('[PUT /movies/:movieId] error:', err);
        res.status(500).json({ success: false, message: '更新影片失败' });
      }
    },
  );

  // DELETE /api/rooms/:roomId/movies/:movieId - 删除影片（仅 root 或房间 owner）
  router.delete(
    '/:roomId/movies/:movieId',
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const roomId = req.params.roomId as string;
        const movieId = Number(req.params.movieId);
        if (!Number.isFinite(movieId)) {
          res.status(400).json({ success: false, message: 'movieId 无效' });
          return;
        }

        const roomRepo = AppDataSource.getRepository(Room);
        const room = await roomRepo.findOneBy({ roomId });
        if (!room) {
          res.status(404).json({ success: false, message: '房间不存在' });
          return;
        }
        if (!canControlRoom(req, room)) {
          res.status(403).json({ success: false, message: '无权限：仅 root 或房间创建者可删除影片' });
          return;
        }

        const deleted = await movieService.deleteMovie(roomId, movieId);
        if (!deleted) {
          res.status(404).json({ success: false, message: '影片不存在' });
          return;
        }

        await movieBroadcasterService.broadcastMovieList(io, roomId);
        res.json({ success: true });
      } catch (err) {
        console.error('[DELETE /movies/:movieId] error:', err);
        res.status(500).json({ success: false, message: '删除影片失败' });
      }
    },
  );

  return router;
}
