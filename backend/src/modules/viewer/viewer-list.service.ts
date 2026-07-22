/**
 * 观众列表广播服务。
 *
 * 封装 viewer-joined / viewer-left 事件的广播逻辑，
 * 修复旧架构中 viewer-left 事件字段名不一致问题（统一使用 viewerSocketId）。
 *
 * 设计目的：
 * - 统一 viewer-joined / viewer-left 广播字段名
 * - 给新观众补发其他在线 viewer 列表，让其能正确显示在线人数
 */
import type { Server as SocketIOServer } from 'socket.io';
import type {
  ViewerDto,
  ViewerJoinedPayload,
} from '../shared';
import { viewerService } from './viewer.service';

/**
 * 观众列表广播服务（单例）。
 */
export class ViewerListService {
  /**
   * 广播 viewer-joined 给房间内所有成员（含新观众自己）。
   *
   * 携带 userId / username / role 供房主端识别身份、执行踢人/禁言/转交房主等管理操作。
   */
  broadcastViewerJoined(
    io: SocketIOServer,
    roomId: string,
    payload: ViewerJoinedPayload,
  ): void {
    io.to(roomId).emit('viewer-joined', payload);
  }

  /**
   * 广播 viewer-left 给房间内所有成员。
   *
   * 统一使用 viewerSocketId 字段，修复旧架构中 socketId vs viewerSocketId 不一致问题。
   */
  broadcastViewerLeft(
    io: SocketIOServer,
    roomId: string,
    socketId: string,
  ): void {
    io.to(roomId).emit('viewer-left', { viewerSocketId: socketId });
  }

  /**
   * 给新加入的观众补发当前已在线的其他 viewer 列表。
   *
   * 新观众只能通过他人广播的 viewer-joined 感知后续加入者，但看不到已有的其他观众。
   * 此方法在新观众加入后立即向其推送其他在线 viewer 的 viewer-joined 事件。
   *
   * @param io Socket.IO 服务实例
   * @param roomId 房间 ID
   * @param toSocketId 新观众的 socketId
   */
  async sendExistingViewers(
    io: SocketIOServer,
    roomId: string,
    toSocketId: string,
  ): Promise<void> {
    const viewers: ViewerDto[] = await viewerService.getOnlineViewers(
      io,
      roomId,
    );
    for (const v of viewers) {
      // 跳过新观众自己
      if (v.socketId === toSocketId) continue;
      io.to(toSocketId).emit('viewer-joined', {
        viewerSocketId: v.socketId,
        userId: v.userId,
        username: v.username,
        role: v.role,
      });
    }
  }
}

/** 全局单例 */
export const viewerListService = new ViewerListService();
