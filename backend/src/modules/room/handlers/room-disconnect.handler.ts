/**
 * 房间断线事件处理器。
 *
 * 处理 socket 断开连接事件，区分房主与观众两种角色分别处理：
 * - 房主断开：清空 hostSocketId（但保留播放状态），广播 host-disconnected，
 *   启动重连宽限定时器（5 分钟），超时则关闭房间
 *   期间服务器继续推算播放进度并广播给观众，观众可继续观看
 * - 观众断开：广播 viewer-left（统一使用 viewerSocketId 字段）
 *
 * 消除旧架构中 routes/room.ts 内联的 disconnect 处理逻辑。
 */
import type { Server as SocketIOServer, Socket } from 'socket.io';
import type { SocketEventHandler } from '../../socket';
import { roomSessionService } from '../room-session.service';
import { roomStateService } from '../room-state.service';
import { playbackMemoryService } from '../../playback-memory';

/**
 * 房间断线事件处理器。
 */
export class RoomDisconnectHandler implements SocketEventHandler {
  readonly name = 'room-disconnect';

  register(socket: Socket, io: SocketIOServer): void {
    socket.on('disconnect', async () => {
      try {
        // 结束当前 socket 的活跃 session（可能是 sharer 或 viewer）
        const session = await roomSessionService.endSession(socket.id);
        if (!session) return;

        if (session.role === 'sharer') {
          // 房主断开：清空 hostSocketId，但保留播放状态
          // 服务器将继续推算播放进度并广播给观众，观众可继续观看
          await playbackMemoryService.updateHostSocket(session.roomId, null);

          // 广播 host-disconnected 给房间内所有成员
          // 观众端据此显示"房主已离开"提示，但不会暂停播放
          io.to(session.roomId).emit('host-disconnected', {
            roomId: session.roomId,
          });

          // 启动重连定时器：超时（5 分钟）则关闭房间
          roomStateService.startReconnectTimer(session.roomId, () => {
            void roomStateService.closeRoomAndNotify(
              io,
              session.roomId,
              socket.id,
            );
          });
        } else {
          // 观众断开：广播 viewer-left（统一使用 viewerSocketId 字段，修复旧架构不一致问题）
          io.to(session.roomId).emit('viewer-left', {
            viewerSocketId: socket.id,
          });
        }
      } catch (err) {
        console.error('[disconnect] handler error:', err);
      }
    });
  }
}
