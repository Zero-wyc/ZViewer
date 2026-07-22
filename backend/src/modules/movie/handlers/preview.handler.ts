/**
 * 预览源 Socket 事件处理器。
 *
 * 处理房主播放预览源（不写入影片列表）的事件。
 *
 * 设计目的：
 * - 从旧架构 routes/room.ts 的 play-preview-source 事件中拆出
 * - 预览源不持久化，仅广播播放状态给房间内所有成员
 * - 预览时清空 currentMovieId，避免与正式影片切换冲突
 */
import type { Server as SocketIOServer, Socket } from 'socket.io';
import type { SocketEventHandler, AckCallback } from '../../socket';
import { safeAck } from '../../socket';
import { roomPermissionService } from '../../room/room-permission.service';
import { roomStateService } from '../../room/room-state.service';

/** 预览源 payload */
export interface PreviewSourcePayload {
  roomId: string;
  source: {
    url: string;
    title?: string;
    sourceType?: string;
    format?: string;
    audioUrl?: string;
    videoCodec?: string;
    audioCodec?: string;
    headers?: Record<string, string>;
    duration?: number;
  };
}

/**
 * 预览源事件处理器。
 *
 * 注册以下事件：
 * - play-preview-source { roomId, source }：房主播放预览源，广播给房间所有成员
 */
export class PreviewHandler implements SocketEventHandler {
  readonly name = 'PreviewHandler';

  register(socket: Socket, io: SocketIOServer): void {
    socket.on(
      'play-preview-source',
      async (payload: PreviewSourcePayload, callback?: AckCallback) => {
        try {
          if (!(await roomPermissionService.isRoomHost(socket, payload.roomId))) {
            return safeAck(callback, { success: false, message: '无权限播放影片' });
          }

          // 预览源清除当前影片标记，仅广播播放状态
          roomStateService.setCurrentMovie(payload.roomId, null);
          io.to(payload.roomId).emit('preview-source', {
            source: payload.source,
          });
          safeAck(callback, { success: true });
        } catch (err) {
          console.error('[play-preview-source] error:', err);
          safeAck(callback, { success: false, message: '播放预览源失败' });
        }
      },
    );
  }
}
