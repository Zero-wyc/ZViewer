/**
 * 房主注册/重连事件处理器。
 *
 * 处理 register-host 事件，用于房主首次注册或断线重连后恢复房主身份。
 * 消除旧架构中 routes/room.ts 内联的 register-host 逻辑。
 *
 * 设计要点：
 * - 通过 roomSessionService.registerHost 统一处理首次注册与重连
 * - 返回房间信息与持久化的 playback 状态（用于房主刷新/重连恢复）
 * - 同步 DB 影片到 roomStateService（修复后端重启后 roomStateService.getMovies 为空
 *   导致 play-movie 校验失败、currentMovieId 永远为 null 的问题）
 * - 广播 sharer-ready 通知房间内所有成员房主已就绪
 */
import type { Server as SocketIOServer, Socket } from 'socket.io';
import {
  type AckCallback,
  type SocketEventHandler,
  safeAck,
} from '../../socket';
import { roomSessionService } from '../room-session.service';
import { movieBroadcasterService } from '../../movie';

/** register-host 事件 payload */
interface RegisterHostPayload {
  roomId: string;
}

/**
 * 房主注册/重连事件处理器。
 */
export class RegisterHostHandler implements SocketEventHandler {
  readonly name = 'register-host';

  register(socket: Socket, io: SocketIOServer): void {
    socket.on(
      'register-host',
      async (payload: RegisterHostPayload, callback: AckCallback) => {
        try {
          const userId: number = socket.data.userId;
          const result = await roomSessionService.registerHost(
            socket,
            payload.roomId,
            userId,
          );
          if (!result) {
            return safeAck(callback, {
              success: false,
              message: '房间不存在或无权限',
            });
          }

          // 同步 DB 影片到 roomStateService 并广播 movie-list。
          // 必要性：后端重启后 roomStateService 内存状态丢失，getMovies 返回空数组，
          // 导致 play-movie 事件校验失败（"影片不存在"），currentMovieId 永远为 null，
          // 进而 watch-together-state 保存的 playback.currentMovieId 为 undefined，
          // 房主刷新后无法恢复播放进度。此处确保房主注册时内存状态与 DB 一致。
          await movieBroadcasterService.broadcastMovieList(io, payload.roomId);

          // 广播 sharer-ready 给房间内其他成员（排除发送者，避免房主自身重复触发 viewer-events 的监听器）
          socket.to(payload.roomId).emit('sharer-ready', { roomId: payload.roomId });

          return safeAck(callback, {
            success: true,
            data: {
              mode: result.mode,
              shareMethod: result.shareMethod,
              name: result.name,
              streamKey: result.streamKey,
              playback: result.playback,
            },
          });
        } catch (err) {
          console.error('[register-host] error:', err);
          return safeAck(callback, { success: false, message: '恢复房主身份失败' });
        }
      },
    );
  }
}
