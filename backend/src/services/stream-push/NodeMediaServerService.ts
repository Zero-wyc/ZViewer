import { Server as SocketIOServer } from 'socket.io';
import NodeMediaServer from 'node-media-server';
import { AppDataSource } from '../../data-source';
import { Room } from '../../entities/Room';

// NMS 服务状态：是否成功启动
let nmsAvailable = false;
let nmsInstance: NodeMediaServer | null = null;

/**
 * 校验推流流名是否为有效房间且为 stream-push 子模式。
 * 流名格式：/live/<roomId>
 */
async function validatePublishStream(streamPath: string | undefined): Promise<string | null> {
  if (!streamPath) return null;
  const match = streamPath.match(/^\/live\/(.+)$/);
  if (!match) return null;
  const roomId = match[1];
  const roomRepo = AppDataSource.getRepository(Room);
  const room = await roomRepo.findOneBy({ roomId });
  if (!room) return null;
  if (room.status !== 'active') return null;
  if (room.mode !== 'screen-share') return null;
  if (room.shareMethod !== 'stream-push') return null;
  return roomId;
}

/**
 * 启动 Node-Media-Server（RTMP + HTTP-FLV）。
 * - 端口通过 RTMP_PORT / HTTP_FLV_PORT 环境变量可配置（默认 1935 / 8000）
 * - 启动失败仅 console.error，不影响主进程
 * - onPostPublish 校验流名合法性，失败调用 node.reject()，成功广播 stream-status: live
 * - onDonePublish / onPublishClose 广播 stream-status: offline
 *
 * @returns stop 函数，用于主进程退出时停止 NMS
 */
export function startNodeMediaServer(io: SocketIOServer): () => void {
  const rtmpPort = process.env.RTMP_PORT ? parseInt(process.env.RTMP_PORT, 10) : 1935;
  const httpFlvPort = process.env.HTTP_FLV_PORT ? parseInt(process.env.HTTP_FLV_PORT, 10) : 8000;

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
      publish: true,
      secret: 'zcontrol-stream-push',
    },
  };

  try {
    nmsInstance = new NodeMediaServer(config);

    nmsInstance.on('prePublish', (id, streamPath, _args) => {
      // prePublish 同步阶段拒绝非法推流（node 的 reject API 在 onPostPublish 中）
      console.log(`[NMS] prePublish id=${id} streamPath=${streamPath}`);
    });

    nmsInstance.on('postPublish', async (id, streamPath, _args) => {
      console.log(`[NMS] postPublish id=${id} streamPath=${streamPath}`);
      const roomId = await validatePublishStream(streamPath);
      if (!roomId) {
        console.warn(
          `[NMS] reject publish: invalid streamPath=${streamPath} id=${id}`,
        );
        // NMS 类型定义未声明 reject，但运行时 session 上存在 reject 方法
        try {
          const session = nmsInstance?.getSession(id) as unknown as {
            reject?: () => void;
          } | undefined;
          session?.reject?.();
        } catch (err) {
          console.error('[NMS] reject error:', err);
        }
        return;
      }
      console.log(`[NMS] publish accepted room=${roomId}`);
      io.to(roomId).emit('stream-status', { roomId, status: 'live' });
    });

    nmsInstance.on('donePublish', async (id, streamPath, _args) => {
      console.log(`[NMS] donePublish id=${id} streamPath=${streamPath}`);
      const roomId = await validatePublishStream(streamPath);
      if (roomId) {
        io.to(roomId).emit('stream-status', { roomId, status: 'offline' });
      }
    });

    nmsInstance.on('postClose', (id, _streamPath) => {
      console.log(`[NMS] postClose id=${id}`);
    });

    nmsInstance.run();
    nmsAvailable = true;
    console.log(
      `[NMS] Node-Media-Server started: RTMP=:${rtmpPort} HTTP-FLV=:${httpFlvPort}`,
    );
  } catch (err) {
    console.error('[NMS] failed to start Node-Media-Server:', err);
    nmsAvailable = false;
  }

  return () => {
    if (nmsInstance) {
      try {
        nmsInstance.stop();
        console.log('[NMS] Node-Media-Server stopped');
      } catch (err) {
        console.error('[NMS] stop error:', err);
      }
    }
    nmsAvailable = false;
    nmsInstance = null;
  };
}

/**
 * 返回 NMS 是否成功启动（用于前端通过 socket 查询流媒体服务可用性）。
 */
export function isStreamPushAvailable(): boolean {
  return nmsAvailable;
}
