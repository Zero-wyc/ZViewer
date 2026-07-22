/**
 * 影片列表广播服务。
 *
 * 统一封装「DB 查询 → 内存同步 → socket 广播」流程，消除旧架构中
 * routes/rooms.ts 内联的 broadcastMovieList 函数。
 *
 * 设计目的：
 * - 任何修改影片的操作（CRUD、重排序）后只需调用此服务即可完成全房间广播
 * - 同步 DB 影片到 roomState.movies，保证内存与 DB 一致
 * - 若当前播放的影片已不在列表中，自动清空 currentMovieId
 */
import type { Server as SocketIOServer } from 'socket.io';
import { MovieService, movieService } from './movie.service';
import { roomStateService } from '../room/room-state.service';

/**
 * 影片列表广播服务。
 *
 * 通过依赖注入 MovieService，便于测试时替换。
 */
export class MovieBroadcasterService {
  constructor(private readonly movieService: MovieService) {}

  /**
   * 广播影片列表到指定房间的所有成员。
   *
   * 流程：
   * 1. 调用 movieService.listMovies 获取 DB 中的影片列表
   * 2. 调用 roomStateService.setMovies 同步到内存运行时状态
   * 3. 若当前播放的影片已不在列表中，清空 currentMovieId
   * 4. 通过 io.to(roomId).emit('movie-list', ...) 广播
   */
  async broadcastMovieList(io: SocketIOServer, roomId: string): Promise<void> {
    const movies = await this.movieService.listMovies(roomId);

    // 同步 DB 影片到内存运行时状态
    roomStateService.setMovies(roomId, movies);

    // 若当前播放的影片已不在列表中，清空 currentMovieId
    const currentMovieId = roomStateService.getCurrentMovieId(roomId);
    if (
      currentMovieId != null &&
      !movies.some((m) => m.id === currentMovieId || String(m.id) === String(currentMovieId))
    ) {
      roomStateService.setCurrentMovie(roomId, null);
    }

    // 广播给房间内所有成员
    io.to(roomId).emit('movie-list', { movies });
  }
}

/** 全局单例（注入默认 movieService） */
export const movieBroadcasterService = new MovieBroadcasterService(movieService);
