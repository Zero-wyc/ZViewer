/**
 * 观众申请跳转/暂停/继续播放事件处理器。
 *
 * 处理观众向房主发起的"申请跳转"、"申请暂停"和"申请继续播放"事件，以及房主的回应。
 *
 * 流程：
 * 1. 观众发起 seek-request / pause-request / play-request → 后端转发给房主（附加 viewer 信息）
 * 2. 房主端弹确认框，决定接受/拒绝
 * 3. 房主发 seek-response / pause-response / play-response → 后端转发回申请者
 * 4. 若接受，房主端自行 seek/pause/play 并通过 watch-together-control 广播给所有观众
 *
 * 修复旧架构问题：
 * 1. 旧版 routes/room.ts 直接查 Session 表做权限校验，此版本统一走
 *    roomPermissionService 和 roomSessionService。
 * 2. 旧版 seek-response / pause-response 用 isRoomHost 校验，此版本保持一致
 *    但抽离到 SeekApprovalHandler 统一管理。
 */
import type { Server as SocketIOServer, Socket } from 'socket.io';
import type { AckCallback, SocketEventHandler } from '../socket';
import { safeAck } from '../socket';
import { roomPermissionService } from '../room/room-permission.service';
import { roomSessionService } from '../room/room-session.service';
import type {
  PauseRequestPayload,
  PauseResponsePayload,
  PlayRequestPayload,
  PlayResponsePayload,
  SeekRequestPayload,
  SeekResponsePayload,
} from '../shared/dto';

export class SeekApprovalHandler implements SocketEventHandler {
  readonly name = 'SeekApprovalHandler';

  register(socket: Socket, io: SocketIOServer): void {
    // --- 观众申请跳转进度 ---
    // 校验在房间内 + sharer 在线，转发给房主（附加 viewerSocketId + viewerUsername）
    socket.on(
      'seek-request',
      async (payload: SeekRequestPayload, callback?: AckCallback) => {
        try {
          // 校验在房间内
          if (
            !(await roomPermissionService.isInRoom(socket, payload.roomId))
          ) {
            return safeAck(callback, {
              success: false,
              message: '不在该房间中',
            });
          }
          // 获取房间活跃 sharer（校验 sharer 在线）
          const sharer = await roomSessionService.getSharer(payload.roomId);
          if (!sharer) {
            return safeAck(callback, { success: false, message: '房主不在线' });
          }

          // 向房主转发，附加申请者信息便于房主端弹框显示
          io.to(sharer.socketId).emit('seek-request', {
            roomId: payload.roomId,
            viewerSocketId: socket.id,
            viewerUsername: socket.data.username,
            time: payload.time,
          });
          safeAck(callback, { success: true });
        } catch (err) {
          console.error('[seek-request] error:', err);
          safeAck(callback, { success: false, message: '申请跳转失败' });
        }
      },
    );

    // --- 房主回应观众的跳转申请 ---
    // accept=true 时房主端已自行 seek 并广播 state，这里仅把结果转发给申请者
    socket.on(
      'seek-response',
      async (payload: SeekResponsePayload, callback?: AckCallback) => {
        try {
          // 仅活跃 sharer 可回应
          if (
            !(await roomPermissionService.isRoomHost(socket, payload.roomId))
          ) {
            return safeAck(callback, { success: false, message: '无权限' });
          }
          // 向指定申请者转发回应（不含 roomId，接收端按自身上下文处理）
          io.to(payload.viewerSocketId).emit('seek-response', {
            accept: payload.accept,
            time: payload.time,
          });
          safeAck(callback, { success: true });
        } catch (err) {
          console.error('[seek-response] error:', err);
          safeAck(callback, { success: false, message: '回应失败' });
        }
      },
    );

    // --- 观众申请暂停 ---
    // 校验在房间内 + sharer 在线，转发给房主（附加 viewerSocketId + viewerUsername）
    socket.on(
      'pause-request',
      async (payload: PauseRequestPayload, callback?: AckCallback) => {
        try {
          // 校验在房间内
          if (
            !(await roomPermissionService.isInRoom(socket, payload.roomId))
          ) {
            return safeAck(callback, {
              success: false,
              message: '不在该房间中',
            });
          }
          // 获取房间活跃 sharer（校验 sharer 在线）
          const sharer = await roomSessionService.getSharer(payload.roomId);
          if (!sharer) {
            return safeAck(callback, { success: false, message: '房主不在线' });
          }

          // 向房主转发，附加申请者信息
          io.to(sharer.socketId).emit('pause-request', {
            roomId: payload.roomId,
            viewerSocketId: socket.id,
            viewerUsername: socket.data.username,
          });
          safeAck(callback, { success: true });
        } catch (err) {
          console.error('[pause-request] error:', err);
          safeAck(callback, { success: false, message: '申请暂停失败' });
        }
      },
    );

    // --- 房主回应观众的暂停申请 ---
    // accept=true 时房主端已自行 pause 并广播 state，这里仅把结果转发给申请者
    socket.on(
      'pause-response',
      async (payload: PauseResponsePayload, callback?: AckCallback) => {
        try {
          // 仅活跃 sharer 可回应
          if (
            !(await roomPermissionService.isRoomHost(socket, payload.roomId))
          ) {
            return safeAck(callback, { success: false, message: '无权限' });
          }
          // 向指定申请者转发回应
          io.to(payload.viewerSocketId).emit('pause-response', {
            accept: payload.accept,
          });
          safeAck(callback, { success: true });
        } catch (err) {
          console.error('[pause-response] error:', err);
          safeAck(callback, { success: false, message: '回应失败' });
        }
      },
    );

    // --- 观众申请继续播放 ---
    // 校验在房间内 + sharer 在线，转发给房主（附加 viewerSocketId + viewerUsername）
    socket.on(
      'play-request',
      async (payload: PlayRequestPayload, callback?: AckCallback) => {
        try {
          // 校验在房间内
          if (
            !(await roomPermissionService.isInRoom(socket, payload.roomId))
          ) {
            return safeAck(callback, {
              success: false,
              message: '不在该房间中',
            });
          }
          // 获取房间活跃 sharer（校验 sharer 在线）
          const sharer = await roomSessionService.getSharer(payload.roomId);
          if (!sharer) {
            return safeAck(callback, { success: false, message: '房主不在线' });
          }

          // 向房主转发，附加申请者信息
          io.to(sharer.socketId).emit('play-request', {
            roomId: payload.roomId,
            viewerSocketId: socket.id,
            viewerUsername: socket.data.username,
          });
          safeAck(callback, { success: true });
        } catch (err) {
          console.error('[play-request] error:', err);
          safeAck(callback, { success: false, message: '申请继续播放失败' });
        }
      },
    );

    // --- 房主回应观众的继续播放申请 ---
    // accept=true 时房主端已自行 play 并广播 state，这里仅把结果转发给申请者
    socket.on(
      'play-response',
      async (payload: PlayResponsePayload, callback?: AckCallback) => {
        try {
          // 仅活跃 sharer 可回应
          if (
            !(await roomPermissionService.isRoomHost(socket, payload.roomId))
          ) {
            return safeAck(callback, { success: false, message: '无权限' });
          }
          // 向指定申请者转发回应
          io.to(payload.viewerSocketId).emit('play-response', {
            accept: payload.accept,
          });
          safeAck(callback, { success: true });
        } catch (err) {
          console.error('[play-response] error:', err);
          safeAck(callback, { success: false, message: '回应失败' });
        }
      },
    );
  }
}
