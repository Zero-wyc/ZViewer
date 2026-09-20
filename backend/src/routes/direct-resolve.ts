/**
 * 直链实时解析路由。
 *
 * GET /movie?movieId= — 按影片记录实时解析 openlist/webdav 直链。
 *
 * 背景：直链影片的 movie.url 是添加影片那一刻的快照（AList 签名直链会过期、
 * 源站地址/协议可能变化），前端在播放解析时改从本端点获取新鲜直链，
 * 固化的 movie.url 仅作为解析失败时的兜底。
 *
 * 信任模型与 /stream?movieId= 一致：解析输入只接受已存在的影片记录
 * （不接受任意 serverUrl，防止遍历探测他人挂载），能拿到 movieId 的
 * 都是已认证用户，影片列表本身已对其可见。
 */
import { Router, Response } from 'express';
import { AppDataSource } from '../data-source';
import { Movie } from '../entities/Movie';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import {
  resolveMovieDirectUrl,
  MovieDirectResolveError,
} from '../services/movie-direct-resolver';

const router = Router();

const movieRepository = () => AppDataSource.getRepository(Movie);

router.use(authenticateToken);

// GET /movie?movieId= - 实时解析影片直链（后端 5 分钟 TTL 缓存 + 单飞去重）
router.get('/movie', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const movieIdRaw = req.query.movieId;
    if (movieIdRaw === undefined) {
      res.status(400).json({ success: false, message: '缺少 movieId 参数' });
      return;
    }
    const movieId = Number(movieIdRaw);
    if (Number.isNaN(movieId)) {
      res.status(400).json({ success: false, message: 'movieId 不正确' });
      return;
    }

    const movie = await movieRepository().findOneBy({ id: movieId });
    if (!movie) {
      res.status(404).json({ success: false, message: '影片不存在' });
      return;
    }

    try {
      const directUrl = await resolveMovieDirectUrl(movie);
      res.json({ success: true, directUrl });
    } catch (err) {
      if (err instanceof MovieDirectResolveError) {
        const status =
          err.code === 'NOT_FOUND' || err.code === 'MOUNT_NOT_FOUND'
            ? 404
            : err.code === 'AUTH_FAILED'
              ? 401
              : 400;
        res.status(status).json({ success: false, message: err.message, code: err.code });
        return;
      }
      throw err;
    }
  } catch (err) {
    console.error('[direct-resolve] movie error:', err);
    res.status(500).json({ success: false, message: '实时解析影片直链失败' });
  }
});

export default router;
