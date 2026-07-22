/**
 * 影片列表 Socket 事件处理器。
 *
 * 处理与房间播放列表相关的事件：添加/移除/切换影片、请求列表与当前影片。
 *
 * 设计目的：
 * - 消除旧架构中 routes/room.ts 内联的 add-movie / remove-movie / play-movie /
 *   request-movie-list / request-current-movie 5 个事件处理器
 * - 所有影片操作统一通过 movieService（DB）+ movieBroadcasterService（同步+广播）
 * - 权限校验统一通过 roomPermissionService
 */
import type { Server as SocketIOServer, Socket } from 'socket.io';
import type { SocketEventHandler, AckCallback } from '../../socket';
import { safeAck } from '../../socket';
import { roomPermissionService } from '../../room/room-permission.service';
import { roomStateService } from '../../room/room-state.service';
import { movieService } from '../movie.service';
import { movieBroadcasterService } from '../movie-broadcaster.service';
import type { MovieDto } from '../../shared';

/**
 * 影片列表事件处理器。
 *
 * 注册以下事件：
 * - add-movie { roomId, movie }：房主添加影片到列表
 * - remove-movie { roomId, movieId }：房主从列表移除影片
 * - play-movie { roomId, movieId }：房主切换当前播放影片
 * - request-movie-list { roomId }：请求房间影片列表
 * - request-current-movie { roomId }：请求当前正在播放的影片 ID
 */
export class MovieListHandler implements SocketEventHandler {
  readonly name = 'MovieListHandler';

  register(socket: Socket, io: SocketIOServer): void {
    // 添加影片到房间播放列表
    socket.on(
      'add-movie',
      async (
        payload: { roomId: string; movie: Partial<MovieDto> },
        callback?: AckCallback,
      ) => {
        try {
          // 权限校验：仅房主可添加影片
          if (!(await roomPermissionService.isRoomHost(socket, payload.roomId))) {
            return safeAck(callback, { success: false, message: '无权限添加影片' });
          }

          await movieService.createMovie(payload.roomId, payload.movie ?? {});
          await movieBroadcasterService.broadcastMovieList(io, payload.roomId);
          safeAck(callback, { success: true });
        } catch (err) {
          console.error('[add-movie] error:', err);
          safeAck(callback, { success: false, message: '添加影片失败' });
        }
      },
    );

    // 从房间播放列表移除影片
    socket.on(
      'remove-movie',
      async (
        payload: { roomId: string; movieId: number },
        callback?: AckCallback,
      ) => {
        try {
          if (!(await roomPermissionService.isRoomHost(socket, payload.roomId))) {
            return safeAck(callback, { success: false, message: '无权限移除影片' });
          }

          const removed = await movieService.deleteMovie(payload.roomId, payload.movieId);
          if (!removed) {
            return safeAck(callback, { success: false, message: '影片不存在' });
          }

          await movieBroadcasterService.broadcastMovieList(io, payload.roomId);

          // 若删除的是当前正在播放的影片，清空 currentMovieId 并广播
          const currentMovieId = roomStateService.getCurrentMovieId(payload.roomId);
          if (
            currentMovieId != null &&
            (currentMovieId === payload.movieId ||
              String(currentMovieId) === String(payload.movieId))
          ) {
            roomStateService.setCurrentMovie(payload.roomId, null);
            io.to(payload.roomId).emit('current-movie', { movieId: null });
          }

          safeAck(callback, { success: true });
        } catch (err) {
          console.error('[remove-movie] error:', err);
          safeAck(callback, { success: false, message: '移除影片失败' });
        }
      },
    );

    // 切换当前播放的影片
    socket.on(
      'play-movie',
      async (
        payload: { roomId: string; movieId: number },
        callback?: AckCallback,
      ) => {
        try {
          if (!(await roomPermissionService.isRoomHost(socket, payload.roomId))) {
            return safeAck(callback, { success: false, message: '无权限播放影片' });
          }

          // 校验影片是否在列表中
          const movies = roomStateService.getMovies(payload.roomId);
          const exists = movies.some(
            (m) => m.id === payload.movieId || String(m.id) === String(payload.movieId),
          );
          if (!exists) {
            return safeAck(callback, { success: false, message: '影片不存在' });
          }

          roomStateService.setCurrentMovie(payload.roomId, payload.movieId);
          io.to(payload.roomId).emit('current-movie', { movieId: payload.movieId });
          safeAck(callback, { success: true });
        } catch (err) {
          console.error('[play-movie] error:', err);
          safeAck(callback, { success: false, message: '播放影片失败' });
        }
      },
    );

    // 请求房间播放列表
    socket.on(
      'request-movie-list',
      async (
        payload: { roomId: string },
        callback?: AckCallback,
      ) => {
        try {
          if (!(await roomPermissionService.isInRoom(socket, payload.roomId))) {
            return safeAck(callback, { success: false, message: '不在该房间中' });
          }

          const movies = roomStateService.getMovies(payload.roomId);
          socket.emit('movie-list', { movies });
          safeAck(callback, { success: true });
        } catch (err) {
          console.error('[request-movie-list] error:', err);
          safeAck(callback, { success: false, message: '获取影片列表失败' });
        }
      },
    );

    // 请求当前正在播放的影片 ID
    socket.on(
      'request-current-movie',
      async (
        payload: { roomId: string },
        callback?: AckCallback,
      ) => {
        try {
          if (!(await roomPermissionService.isInRoom(socket, payload.roomId))) {
            return safeAck(callback, { success: false, message: '不在该房间中' });
          }

          const movieId = roomStateService.getCurrentMovieId(payload.roomId);
          socket.emit('current-movie', { movieId });
          safeAck(callback, { success: true });
        } catch (err) {
          console.error('[request-current-movie] error:', err);
          safeAck(callback, { success: false, message: '获取当前影片失败' });
        }
      },
    );
  }
}
