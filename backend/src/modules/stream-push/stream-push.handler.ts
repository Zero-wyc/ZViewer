/**
 * OBS 推流模式 socket 事件处理器。
 *
 * 职责：
 * - 处理 update-share-method 事件（房主切换 webrtc ↔ stream-push）
 * - 查询 NMS 可用性（通过 query-stream-push-availability 事件）
 *
 * 设计：
 * - 实现 SocketEventHandler 接口，由 SocketRegistry 统一注册
 * - 使用 roomPermissionService 统一权限校验
 * - 使用 safeAck 标准化 ack 响应
 */

import type { Server as SocketIOServer, Socket } from 'socket.io';
import { AppDataSource } from '../../data-source';
import { Room, type ShareMethod } from '../../entities/Room';
import {
  type AckCallback,
  type SocketEventHandler,
  safeAck,
} from '../socket';
import { roomPermissionService } from '../room/room-permission.service';
import { nmsService } from './nms.service';
import { generateStreamKey } from './stream-key.util';
import type { UpdateShareMethodPayload } from './dto/stream-push.dto';

/**
 * 推流模式事件处理器。
 */
export class StreamPushHandler implements SocketEventHandler {
  readonly name = 'stream-push';

  register(socket: Socket, io: SocketIOServer): void {
    // --- 房主切换投屏子模式（webrtc ↔ stream-push） ---
    socket.on(
      'update-share-method',
      async (
        payload: UpdateShareMethodPayload,
        callback: AckCallback,
      ) => {
        try {
          // 通过统一权限服务校验房主身份
          if (
            !(await roomPermissionService.isRoomHost(socket, payload.roomId))
          ) {
            return safeAck(callback, {
              success: false,
              message: '无权限：仅房主可切换子模式',
            });
          }

          const roomRepo = AppDataSource.getRepository(Room);
          const room = await roomRepo.findOneBy({ roomId: payload.roomId });
          if (!room) {
            return safeAck(callback, { success: false, message: '房间不存在' });
          }
          if (room.mode !== 'screen-share') {
            return safeAck(callback, {
              success: false,
              message: '仅投屏模式支持子模式切换',
            });
          }

          // 切换到 stream-push 前校验 NMS 是否可用
          if (
            payload.shareMethod === 'stream-push' &&
            !nmsService.isAvailable()
          ) {
            return safeAck(callback, {
              success: false,
              message: '推流服务不可用，请联系管理员检查 NMS 配置',
            });
          }

          room.shareMethod = payload.shareMethod;

          // 切换到 stream-push 时生成 streamKey（如不存在），用于 OBS 推流码
          if (payload.shareMethod === 'stream-push' && !room.streamKey) {
            room.streamKey = generateStreamKey();
          }

          await roomRepo.save(room);

          console.log(
            `[update-share-method] room=${payload.roomId} shareMethod=${payload.shareMethod} streamKey=${room.streamKey}`,
          );

          // 广播给房间内所有成员（包含 streamKey，观众端据此拉流）
          io.to(payload.roomId).emit('share-method-changed', {
            roomId: payload.roomId,
            shareMethod: payload.shareMethod,
            streamKey: room.streamKey,
          });

          return safeAck(callback, {
            success: true,
            data: { shareMethod: payload.shareMethod, streamKey: room.streamKey },
          });
        } catch (err) {
          console.error('[update-share-method] error:', err);
          return safeAck(callback, { success: false, message: '切换子模式失败' });
        }
      },
    );

    // --- 查询推流服务可用性 ---
    // 前端切换到 stream-push 前可通过此事件检查 NMS 是否已启动
    socket.on(
      'query-stream-push-availability',
      (_payload: void,
       callback: AckCallback) => {
        return safeAck(callback, {
          success: true,
          data: { available: nmsService.isAvailable() },
        });
      },
    );
  }
}

/** 导出 ShareMethod 类型供其他模块使用 */
export type { ShareMethod };
