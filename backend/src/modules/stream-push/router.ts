/**
 * OBS 推流模式 REST 路由。
 *
 * 职责：
 * - GET /api/stream-push/obs-config/:roomId — 下载 OBS 场景集合配置文件
 *
 * 设计：
 * - RTMP 地址生成逻辑统一在此处，前端通过 API 获取避免前后端不一致
 * - 使用 authenticateToken 中间件确保已登录
 */

import { Router, Response } from 'express';
import { AppDataSource } from '../../data-source';
import { Room } from '../../entities/Room';
import {
  authenticateToken,
  type AuthenticatedRequest,
} from '../../middleware/auth';
import { generateStreamKey } from './stream-key.util';

const router = Router();

/**
 * 构建 RTMP 推流地址（不含流密钥）。
 * 优先使用 SERVER_HOST 环境变量，否则使用请求 Host header 去端口号。
 */
function buildRtmpServerUrl(req: AuthenticatedRequest): string {
  const rtmpPort = process.env.RTMP_PORT
    ? parseInt(process.env.RTMP_PORT, 10)
    : 3334;
  const serverHost =
    process.env.SERVER_HOST ||
    (() => {
      const host = req.headers.host || 'localhost';
      return host.split(':')[0];
    })();
  return `rtmp://${serverHost}:${rtmpPort}/live`;
}

/**
 * GET /api/stream-push/obs-config/:roomId
 * 下载 OBS 场景集合配置文件（JSON）。
 * 文件包含推流服务（rtmp_custom）、服务器地址、流密钥。
 */
router.get(
  '/obs-config/:roomId',
  authenticateToken,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const roomId = String(req.params.roomId);
      const roomRepo = AppDataSource.getRepository(Room);
      const room = await roomRepo.findOneBy({ roomId });
      if (!room) {
        return res
          .status(404)
          .json({ success: false, message: '房间不存在' });
      }
      if (room.mode !== 'screen-share') {
        return res
          .status(400)
          .json({ success: false, message: '该房间不是投屏模式' });
      }

      // 确保 streamKey 已生成（兼容旧房间或中途切换）
      if (!room.streamKey) {
        room.streamKey = generateStreamKey();
        await roomRepo.save(room);
      }

      const serverUrl = buildRtmpServerUrl(req);
      const streamKey = room.streamKey;

      const obsConfig = {
        current_scene: 'ZControl 推流',
        current_program_scene: 'ZControl 推流',
        name: 'ZControl 推流',
        scene_order: [
          {
            name: 'ZControl 推流',
          },
        ],
        sources: [
          {
            name: 'ZControl 推流',
            id: 'scene',
            versioned_id: 'scene',
            settings: {
              id_counter: 1,
              items: [
                {
                  name: 'ZControl RTMP 推流',
                  source_uuid: 'zcontrol-rtmp-push',
                  visible: true,
                  locked: false,
                  rot: 0.0,
                  pos: {
                    x: 0.0,
                    y: 0.0,
                  },
                  scale: {
                    x: 1.0,
                    y: 1.0,
                  },
                  alignment: 5,
                  bounds_type: 0,
                  bounds_alignment: 0,
                  bounds: {
                    x: 0.0,
                    y: 0.0,
                  },
                  crop_left: 0,
                  crop_top: 0,
                  crop_right: 0,
                  crop_bottom: 0,
                  group_item_backup: false,
                  scale_filter: 'disable',
                  blend_method: 'default',
                  blend_type: 'normal',
                  private_settings: {},
                },
              ],
            },
            mixers: 0,
            sync: 0,
            flags: 0,
          },
          {
            name: 'ZControl RTMP 推流',
            id: 'rtmp_output',
            versioned_id: 'rtmp_output',
            settings: {
              server: serverUrl,
              key: streamKey,
              use_auth: false,
            },
            private_settings: {},
          },
        ],
        service: {
          type: 'rtmp_custom',
          settings: {
            server: serverUrl,
            key: streamKey,
          },
        },
      };

      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        'attachment; filename="zcontrol-obs-config.json"',
      );
      return res.json(obsConfig);
    } catch (err) {
      console.error('GET /api/stream-push/obs-config error:', err);
      return res
        .status(500)
        .json({ success: false, message: '生成 OBS 配置文件失败' });
    }
  },
);

export default router;
