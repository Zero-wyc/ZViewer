/**
 * 评论 / 弹幕 / 批注 Socket 事件处理器。
 *
 * 处理房间内的实时通讯事件：
 * - send-comment：发送评论（持久化 + 广播）
 * - comment-history：查询评论历史
 * - send-danmaku：发送弹幕（不持久化，仅广播）
 * - annotation-stroke：同步批注笔画
 * - clear-annotations：清空批注（仅房主）
 *
 * 设计目的：
 * - 从旧架构 index.ts 拆出评论相关 5 个事件处理器
 * - 统一通过 roomPermissionService 做权限校验（在房间内、未被禁言）
 * - 评论持久化通过 commentService，避免直接操作 DB
 */
import type { Server as SocketIOServer, Socket } from 'socket.io';
import { AppDataSource } from '../../../data-source';
import { User } from '../../../entities/User';
import type { SocketEventHandler, AckCallback } from '../../socket';
import { safeAck } from '../../socket';
import { roomPermissionService } from '../../room/room-permission.service';
import { commentService } from '../comment.service';

/** 批注笔画类型 */
export interface AnnotationStroke {
  id: string;
  type: 'pen' | 'text' | 'erase';
  points?: { x: number; y: number }[];
  text?: string;
  color?: string;
  width?: number;
  x?: number;
  y?: number;
}

/** 评论 DTO（用于广播与历史返回） */
export interface CommentDto {
  id: number;
  roomId: string;
  username: string;
  content: string;
  isDanmaku: boolean;
  createdAt: string;
}

/**
 * 评论 / 弹幕 / 批注事件处理器。
 */
export class CommentHandler implements SocketEventHandler {
  readonly name = 'CommentHandler';

  register(socket: Socket, io: SocketIOServer): void {
    // 发送评论：持久化 + 广播
    socket.on(
      'send-comment',
      async (
        payload: { roomId: string; content: string; isDanmaku?: boolean },
        callback: AckCallback,
      ) => {
        try {
          // 校验在房间内
          if (!(await roomPermissionService.isInRoom(socket, payload.roomId))) {
            return safeAck(callback, { success: false, message: '不在该房间中' });
          }

          const content =
            typeof payload.content === 'string' ? payload.content.trim() : '';
          if (!content) {
            return safeAck(callback, { success: false, message: '评论内容不能为空' });
          }

          // 禁言校验：被房主禁言的观众不能发送评论
          const userId = socket.data.userId as number | undefined;
          if (userId != null && (await roomPermissionService.isMuted(payload.roomId, userId))) {
            return safeAck(callback, { success: false, message: '您已被房主禁言' });
          }

          const username = await this.getUsername(socket);
          const comment = await commentService.createComment(
            payload.roomId,
            userId ?? 0,
            username,
            content,
            payload.isDanmaku ?? false,
          );

          const commentDto: CommentDto = {
            id: comment.id,
            roomId: comment.roomId,
            username: comment.username,
            content: comment.content,
            isDanmaku: comment.isDanmaku,
            createdAt: comment.createdAt.toISOString(),
          };

          io.to(payload.roomId).emit('new-comment', commentDto);
          safeAck(callback, { success: true });
        } catch (err) {
          console.error('[send-comment] error:', err);
          safeAck(callback, { success: false, message: '发送评论失败' });
        }
      },
    );

    // 查询评论历史
    socket.on(
      'comment-history',
      async (
        payload: { roomId: string },
        callback: (response: {
          success: boolean;
          message?: string;
          comments?: CommentDto[];
        }) => void,
      ) => {
        try {
          if (!(await roomPermissionService.isInRoom(socket, payload.roomId))) {
            return callback({ success: false, message: '不在该房间中' });
          }

          const comments = await commentService.listComments(payload.roomId);
          const commentDtos: CommentDto[] = comments.map((c) => ({
            id: c.id,
            roomId: c.roomId,
            username: c.username,
            content: c.content,
            isDanmaku: c.isDanmaku,
            createdAt: c.createdAt.toISOString(),
          }));

          callback({ success: true, comments: commentDtos });
        } catch (err) {
          console.error('[comment-history] error:', err);
          callback({ success: false, message: '获取评论历史失败' });
        }
      },
    );

    // 发送弹幕：不持久化，仅广播
    socket.on(
      'send-danmaku',
      async (
        payload: { roomId: string; content: string },
        callback?: AckCallback,
      ) => {
        try {
          if (!(await roomPermissionService.isInRoom(socket, payload.roomId))) {
            return safeAck(callback, { success: false, message: '不在该房间中' });
          }

          const content =
            typeof payload.content === 'string' ? payload.content.trim() : '';
          if (!content) {
            return safeAck(callback, { success: false, message: '弹幕内容不能为空' });
          }

          // 禁言校验：被房主禁言的观众不能发送弹幕
          const userId = socket.data.userId as number | undefined;
          if (userId != null && (await roomPermissionService.isMuted(payload.roomId, userId))) {
            return safeAck(callback, { success: false, message: '您已被房主禁言' });
          }

          const username = await this.getUsername(socket);
          io.to(payload.roomId).emit('danmaku', {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            text: content,
            sender: username,
          });
          safeAck(callback, { success: true });
        } catch (err) {
          console.error('[send-danmaku] error:', err);
          safeAck(callback, { success: false, message: '发送弹幕失败' });
        }
      },
    );

    // 同步批注笔画：广播给房间内所有成员
    socket.on(
      'annotation-stroke',
      async (
        payload: { roomId: string; stroke: AnnotationStroke },
        callback?: AckCallback,
      ) => {
        try {
          if (!(await roomPermissionService.isInRoom(socket, payload.roomId))) {
            return safeAck(callback, { success: false, message: '不在该房间中' });
          }

          io.to(payload.roomId).emit('annotation-stroke', {
            stroke: payload.stroke,
            senderId: socket.id,
          });
          safeAck(callback, { success: true });
        } catch (err) {
          console.error('[annotation-stroke] error:', err);
          safeAck(callback, { success: false, message: '同步批注失败' });
        }
      },
    );

    // 清空批注：仅房主
    socket.on(
      'clear-annotations',
      async (payload: { roomId: string }, callback: AckCallback) => {
        try {
          if (!(await roomPermissionService.isRoomHost(socket, payload.roomId))) {
            return safeAck(callback, { success: false, message: '无权限清空批注' });
          }

          io.to(payload.roomId).emit('clear-annotations');
          safeAck(callback, { success: true });
        } catch (err) {
          console.error('[clear-annotations] error:', err);
          safeAck(callback, { success: false, message: '清空批注失败' });
        }
      },
    );
  }

  /**
   * 获取 socket 对应用户名。
   *
   * 优先使用 socket.data.username（JWT 中携带），未携带则查询 DB。
   * 查询结果缓存到 socket.data.username 避免重复查询。
   */
  private async getUsername(socket: Socket): Promise<string> {
    if (socket.data.username) {
      return socket.data.username as string;
    }
    const userRepo = AppDataSource.getRepository(User);
    const user = await userRepo.findOneBy({ id: socket.data.userId as number });
    const username = user?.username ?? '未知用户';
    socket.data.username = username;
    return username;
  }
}
