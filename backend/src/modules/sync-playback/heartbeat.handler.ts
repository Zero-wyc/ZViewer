/**
 * 心跳事件处理器。
 *
 * 处理 host-heartbeat：房主定时广播的轻量心跳（currentTime + isPlaying + playbackRate + suppressed），
 * 后端转发给房间内其他成员，观众端据此重置"房主离线"计时器、同步倍速与存活检测。
 *
 * 修复说明：前端 useHostHeartbeat 每 2s emit 'host-heartbeat'，观众端
 * useViewerHeartbeat 监听该事件重置离线计时器。若后端不转发，观众 6s 内
 * 必然收不到心跳而误报"房主已离线"并暂停播放。
 *
 * 心跳为轻量事件，不校验 room.mode（screen-share 模式下房主同样需要广播心跳
 * 给观众端做存活检测）；仅校验发送者为活跃 sharer。
 */
import type { Server as SocketIOServer, Socket } from 'socket.io';
import type { AckCallback, SocketEventHandler } from '../socket';
import { safeAck } from '../socket';
import { roomPermissionService } from '../room/room-permission.service';
import { playbackMemoryService } from '../playback-memory';
import type { HeartbeatPayload } from '../shared/dto';

export class HeartbeatHandler implements SocketEventHandler {
  readonly name = 'HeartbeatHandler';

  register(socket: Socket, io: SocketIOServer): void {
    socket.on(
      'host-heartbeat',
      async (payload: HeartbeatPayload, callback?: AckCallback) => {
        try {
          // 校验是否为指定房间的活跃 sharer
          if (
            !(await roomPermissionService.isRoomHost(socket, payload.roomId))
          ) {
            return safeAck(callback, {
              success: false,
              message: '无权限发送心跳',
            });
          }

          // 心跳落盘（10s 节流，service 内部控制）：房主连续播放期间没有
          // 离散 state 事件，外推基线会逐渐陈旧；心跳携带真实 currentTime，
          // 合并进播放记忆后房主断线的服务器外推与恢复进度不再超前。
          // clientTs：服务端补偿传输延迟后再合并（仅播放中，clamp 0~1.5s × rate）。
          // 不 await：落盘失败不应阻塞心跳转发。
          void playbackMemoryService
            .applyHostHeartbeat(
              payload.roomId,
              {
                currentTime: payload.currentTime,
                isPlaying: payload.isPlaying,
                playbackRate: payload.playbackRate,
              },
              payload.clientTs,
            )
            .catch((err) => {
              console.error('[host-heartbeat] applyHostHeartbeat error:', err);
            });

          // 转发心跳给房间内其他成员（不含发送者、不含 roomId）
          // 保留旧事件兼容已连接客户端
          socket.to(payload.roomId).emit('host-heartbeat', {
            currentTime: payload.currentTime,
            isPlaying: payload.isPlaying,
            playbackRate: payload.playbackRate,
            suppressed: payload.suppressed,
          });
          // 统一心跳协议（#14）：新增 sync-heartbeat 事件，viewer 端按 source 字段区分
          socket.to(payload.roomId).emit('sync-heartbeat', {
            source: 'host',
            currentTime: payload.currentTime,
            isPlaying: payload.isPlaying,
            playbackRate: payload.playbackRate,
            suppressed: payload.suppressed,
          });
          safeAck(callback, { success: true });
        } catch (err) {
          console.error('[host-heartbeat] error:', err);
          safeAck(callback, { success: false, message: '心跳转发失败' });
        }
      },
    );
  }
}
