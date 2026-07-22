/**
 * Node-Media-Server 生命周期管理服务。
 *
 * 职责：
 * - 启动/停止 NMS（RTMP 接收 + HTTP-FLV 分发）
 * - 校验推流流名合法性（流名格式 /live/<roomId>）
 * - 推流开始/结束时广播 stream-status 事件给房间内成员
 *
 * 不负责：
 * - 子模式切换（由 StreamPushHandler 处理）
 * - OBS 配置生成（由 router 处理）
 */

import type { Server as SocketIOServer } from 'socket.io';
import NodeMediaServer from 'node-media-server';
import { AppDataSource } from '../../data-source';
import { Room } from '../../entities/Room';
import type { PublishValidationResult } from './dto/stream-push.dto';

/**
 * NMS 服务单例。
 *
 * 设计：
 * - nmsInstance 和 nmsAvailable 为模块级状态，通过方法暴露
 * - start() 返回 stop 函数，用于主进程退出时清理
 * - 校验逻辑独立为 validatePublishStream，便于测试
 */
class NmsService {
  private nmsInstance: NodeMediaServer | null = null;
  private nmsAvailable = false;

  /** NMS 是否已成功启动 */
  isAvailable(): boolean {
    return this.nmsAvailable;
  }

  /**
   * 校验推流流名是否为有效房间且为 stream-push 子模式。
   *
   * 流名格式：/live/<streamKey>
   * OBS 配置方式：服务器=rtmp://host:3334/live，推流码=streamKey
   * 通过 streamKey 查询 Room 表，避免暴露 roomId 并支持独立密钥管理。
   */
  async validatePublishStream(
    streamPath: string | undefined,
  ): Promise<PublishValidationResult> {
    if (!streamPath) return { valid: false, roomId: null };
    const match = streamPath.match(/^\/live\/(.+)$/);
    if (!match) return { valid: false, roomId: null };

    const streamKey = match[1];
    const roomRepo = AppDataSource.getRepository(Room);
    const room = await roomRepo.findOneBy({ streamKey });
    if (!room) return { valid: false, roomId: null };
    if (room.status !== 'active') return { valid: false, roomId: null };
    if (room.mode !== 'screen-share') return { valid: false, roomId: null };
    if (room.shareMethod !== 'stream-push') return { valid: false, roomId: null };

    return { valid: true, roomId: room.roomId };
  }

  /**
   * 启动 Node-Media-Server。
   *
   * - 端口通过 RTMP_PORT / HTTP_FLV_PORT 环境变量可配置（默认 3334 / 3335）
   * - 启动失败仅 console.error，不影响主进程
   * - postPublish 校验流名合法性，失败调用 session.reject()，成功广播 stream-status: live
   * - donePublish / postClose 均广播 stream-status: offline（修复旧版 postClose 不广播的缺陷）
   *
   * @returns stop 函数，用于主进程退出时停止 NMS
   */
  start(io: SocketIOServer): () => void {
    const rtmpPort = process.env.RTMP_PORT
      ? parseInt(process.env.RTMP_PORT, 10)
      : 3334;
    const httpFlvPort = process.env.HTTP_FLV_PORT
      ? parseInt(process.env.HTTP_FLV_PORT, 10)
      : 3335;

    const config = {
      rtmp: {
        port: rtmpPort,
        chunk_size: 60000,
        gop_cache: true,
        ping: 30,
        ping_timeout: 60,
      },
      http: {
        port: httpFlvPort,
        mediaroot: './media',
        allow_origin: '*',
      },
      auth: {
        play: false,
        // 关闭 NMS 自带的推流 token 校验，改由 postPublish 中通过 streamKey
        // 查询 Room 表进行业务层校验（房间存在、活跃、screen-share + stream-push）。
        publish: false,
        secret: 'zcontrol-stream-push',
      },
    };

    try {
      this.nmsInstance = new NodeMediaServer(config);

      this.nmsInstance.on('postPublish', async (id, streamPath, _args) => {
        console.log(`[NMS] postPublish id=${id} streamPath=${streamPath}`);
        const result = await this.validatePublishStream(streamPath);
        if (!result.valid) {
          console.warn(
            `[NMS] reject publish: invalid streamPath=${streamPath} id=${id}`,
          );
          try {
            const session = this.nmsInstance?.getSession(id) as unknown as {
              reject?: () => void;
            } | undefined;
            session?.reject?.();
          } catch (err) {
            console.error('[NMS] reject error:', err);
          }
          return;
        }
        const roomId = result.roomId!;
        console.log(`[NMS] publish accepted room=${roomId}`);
        io.to(roomId).emit('stream-status', { roomId, status: 'live' });
      });

      this.nmsInstance.on('donePublish', async (id, streamPath, _args) => {
        console.log(`[NMS] donePublish id=${id} streamPath=${streamPath}`);
        const result = await this.validatePublishStream(streamPath);
        if (result.valid && result.roomId) {
          io.to(result.roomId).emit('stream-status', {
            roomId: result.roomId,
            status: 'offline',
          });
        }
      });

      // postClose 也广播 offline，修复旧版仅打日志的缺陷：
      // NMS 异常关闭连接（未触发 donePublish）时确保客户端收到 offline 通知
      this.nmsInstance.on('postClose', async (id, streamPath) => {
        console.log(`[NMS] postClose id=${id} streamPath=${streamPath}`);
        const result = await this.validatePublishStream(streamPath);
        if (result.valid && result.roomId) {
          io.to(result.roomId).emit('stream-status', {
            roomId: result.roomId,
            status: 'offline',
          });
        }
      });

      this.nmsInstance.run();
      this.nmsAvailable = true;
      console.log(
        `[NMS] Node-Media-Server started: RTMP=:${rtmpPort} HTTP-FLV=:${httpFlvPort}`,
      );
    } catch (err) {
      console.error('[NMS] failed to start Node-Media-Server:', err);
      this.nmsAvailable = false;
    }

    return () => {
      if (this.nmsInstance) {
        try {
          this.nmsInstance.stop();
          console.log('[NMS] Node-Media-Server stopped');
        } catch (err) {
          console.error('[NMS] stop error:', err);
        }
      }
      this.nmsAvailable = false;
      this.nmsInstance = null;
    };
  }
}

/** 全局单例 */
export const nmsService = new NmsService();
