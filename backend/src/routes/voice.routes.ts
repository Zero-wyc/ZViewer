/**
 * 语音聊天路由（LiveKit 版）。
 *
 * 后端不再承担 SFU/媒体转发：实时音频由独立 LiveKit 服务处理。
 * 本路由只做三件事：
 * - POST /token        鉴权后签发 LiveKit AccessToken（客户端连 LiveKit 的唯一凭证）
 * - POST /mute         管理员禁言：服务器侧静音对方麦克风 + 写参与者 metadata
 * - POST /kick         管理员踢出：removeParticipant
 *
 * 权限：mute/kick 复用旧语义——root / admin-房主 / 房主 / 房管。
 *
 * 环境变量（未配置时 /token 返回 503，前端提示语音未就绪）：
 * - LIVEKIT_URL       客户端连接地址（可选；缺省按请求头推导 wss/ws://页面域名）
 * - LIVEKIT_API_HOST  服务端 API 地址（默认 http://127.0.0.1:3336）
 * - LIVEKIT_API_KEY / LIVEKIT_API_SECRET
 */
import { Router, Response } from 'express';
import { AccessToken, RoomServiceClient, TrackType } from 'livekit-server-sdk';
import { AppDataSource } from '../data-source';
import { Room } from '../entities/Room';
import {
  authenticateToken,
  AuthenticatedRequest,
} from '../middleware/auth';

const router = Router();
const roomRepository = () => AppDataSource.getRepository(Room);

const livekitConfigured = () =>
  !!(
    process.env.LIVEKIT_API_KEY &&
    process.env.LIVEKIT_API_SECRET
  );

/**
 * 解析「客户端连接 LiveKit」的信令地址（按次请求推导）。
 *
 * 优先级：
 * 1. LIVEKIT_URL 环境变量（显式配置，如外置 LiveKit 或特殊域名）
 * 2. 从请求头推导：跟随页面协议与域名——HTTPS 页面自动 wss（避免混合
 *    内容拦截），反代/CDN 场景取 x-forwarded-host/proto
 *
 * 注意：不能在服务端「探测本机 IP」生成默认地址——容器/多网卡环境下
 * 探测到的是内部地址（如 Docker bridge 172.24.x.x），浏览器不可达。
 */
function resolveClientUrl(req: AuthenticatedRequest): string {
  const explicit = process.env.LIVEKIT_URL?.trim();
  if (explicit) return explicit;
  const host =
    (req.headers['x-forwarded-host'] as string | undefined) ||
    req.headers.host ||
    '';
  const proto =
    (req.headers['x-forwarded-proto'] as string | undefined) ||
    (req.secure ? 'https' : 'http');
  const scheme = proto.startsWith('https') ? 'wss' : 'ws';
  return `${scheme}://${host}`;
}

const roomService = () =>
  new RoomServiceClient(
    process.env.LIVEKIT_API_HOST || 'http://127.0.0.1:3336',
    process.env.LIVEKIT_API_KEY,
    process.env.LIVEKIT_API_SECRET
  );

const voiceRoomName = (roomId: string) => `voice:${roomId}`;

/** 语音管理权限：root / admin-房主 / 房主 / 房管（与旧版语义一致） */
async function isVoiceAdmin(
  req: AuthenticatedRequest,
  roomId: string
): Promise<boolean> {
  const user = req.user;
  if (!user) return false;
  const room = await roomRepository().findOneBy({ roomId });
  if (!room) return false;
  if (user.role === 'root') return true;
  if (user.role === 'admin' && room.ownerUserId === user.userId) return true;
  if (room.ownerUserId === user.userId) return true;
  try {
    return JSON.parse(room.moderators || '[]').includes(user.userId);
  } catch {
    return false;
  }
}

// POST /api/voice/token - 签发 LiveKit 接入凭证
router.post(
  '/token',
  authenticateToken,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const roomId = String(req.body?.roomId ?? '');
      if (!roomId) {
        res.status(400).json({ success: false, message: 'roomId 为必填项' });
        return;
      }
      if (!livekitConfigured()) {
        res.status(503).json({
          success: false,
          message: '语音服务未配置（需要 LIVEKIT_API_KEY/API_SECRET）',
        });
        return;
      }
      const user = req.user!;
      // 登录用户身份稳定（重连顶替同轨）；游客每次加入生成一次性身份
      const identity =
        user.userId > 0
          ? `user:${user.userId}`
          : `guest:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const token = new AccessToken(
        process.env.LIVEKIT_API_KEY,
        process.env.LIVEKIT_API_SECRET,
        { identity, name: String(req.body?.username ?? user.username ?? '成员') }
      );
      token.addGrant({
        room: voiceRoomName(roomId),
        roomJoin: true,
        canPublish: true,
        canSubscribe: true,
        canPublishData: true,
      });
      // toJwt() 新版返回 Promise（thenable），必须 await——否则序列化成
      // "[object Object]" 发给前端，LiveKit 401 拒绝连接
      const jwt = await token.toJwt();
      res.json({ success: true, url: resolveClientUrl(req), token: jwt });
    } catch (err) {
      console.error('[voice] token error:', err);
      res.status(500).json({ success: false, message: '签发语音凭证失败' });
    }
  },
);

// POST /api/voice/mute - 管理员禁言/解禁（服务器侧静音麦克风 + metadata 同步 UI）
router.post(
  '/mute',
  authenticateToken,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { roomId, identity, muted } = req.body as {
        roomId?: string;
        identity?: string;
        muted?: boolean;
      };
      if (!roomId || !identity || typeof muted !== 'boolean') {
        res.status(400).json({ success: false, message: 'roomId/identity/muted 为必填项' });
        return;
      }
      if (!(await isVoiceAdmin(req, roomId))) {
        res.status(403).json({ success: false, message: '无权限：仅房主或房管可操作' });
        return;
      }
      const svc = roomService();
      const participants = await svc.listParticipants(voiceRoomName(roomId));
      const target = participants.find((p) => p.identity === identity);
      if (!target) {
        res.status(404).json({ success: false, message: '目标不在语音中' });
        return;
      }
      // 禁言：静音其全部麦克风轨（服务器侧强制，客户端无法绕过）
      if (muted) {
        for (const track of target.tracks) {
          if (track.type === TrackType.AUDIO) {
            await svc.mutePublishedTrack(
              voiceRoomName(roomId),
              identity,
              track.sid,
              true
            );
          }
        }
      }
      // metadata 驱动两端 UI：被禁言者据此锁定麦克风，解禁后自动恢复
      const meta = JSON.stringify({ adminMuted: muted });
      await svc.updateParticipant(voiceRoomName(roomId), identity, { metadata: meta });
      res.json({ success: true });
    } catch (err) {
      console.error('[voice] mute error:', err);
      res.status(500).json({ success: false, message: '操作失败' });
    }
  },
);

// POST /api/voice/kick - 管理员踢出语音
router.post(
  '/kick',
  authenticateToken,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { roomId, identity } = req.body as {
        roomId?: string;
        identity?: string;
      };
      if (!roomId || !identity) {
        res.status(400).json({ success: false, message: 'roomId/identity 为必填项' });
        return;
      }
      if (!(await isVoiceAdmin(req, roomId))) {
        res.status(403).json({ success: false, message: '无权限：仅房主或房管可操作' });
        return;
      }
      await roomService().removeParticipant(voiceRoomName(roomId), identity);
      res.json({ success: true });
    } catch (err) {
      console.error('[voice] kick error:', err);
      res.status(500).json({ success: false, message: '操作失败' });
    }
  },
);

export default router;
