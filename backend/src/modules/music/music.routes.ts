/**
 * 一起听（Listen Together）音乐模块 REST 路由。
 *
 * 挂载在 /api/music 下，提供以下端点：
 * - ANY  /api/music/ncm/*       通用转发：注入当前用户持久化的网易云 cookie，
 *                               转发到内部 NCM API 服务（127.0.0.1），浏览器不直连网易云
 * - GET  /api/music/ncm-cookie  返回当前用户持久化的网易云 Cookie（迁移/备份）
 * - POST /api/music/ncm-cookie-login Cookie 登录网易云
 * - GET  /api/music/login/status 查询当前用户的网易云登录状态
 * - POST /api/music/logout       删除当前用户持久化的网易云凭证
 * - POST /api/music/cloud/upload 云盘上传（multipart 流转发）
 * - GET  /api/music/album/full   专辑详情（含全量歌曲补齐）
 * - GET  /api/music/stream       音频流代理：先调 /song/url/v1 解析直链
 *                               （含音质降级链），校验直链域名后流式转发（支持 Range/206）
 * - GET  /api/music/song-quality 当前歌曲实际解析音质元数据
 *
 * 鉴权模型：可选鉴权——携带有效 token 时注入 req.user（登录态转发用），
 * 未登录 / 游客（userId=0）也放行，以匿名（无 cookie）方式调用 NCM API。
 * 游客不持久化凭证（userId 唯一索引，避免全部游客共享同一份 cookie）。
 *
 * 业务实现全部在 modules/music 的服务层，本文件只做路由注册与参数校验。
 */
import { Router, type Response } from 'express';
import { AppDataSource } from '../../data-source';
import { NcmCredential } from '../../entities/NcmCredential';
import {
  optionalAuthenticate,
  type AuthenticatedRequest,
} from '../../middleware/auth';
import { getAlbumWithFullSongs, getNcmLoginStatus } from './ncm-account.service';
import { callNcmApi } from './ncm-api-client';
import { getNcmApiBase } from './ncm-api.service';
import {
  extractProfile,
  loadCredential,
  mergeCookies,
  parseStoredCookies,
  persistCookies,
  toCookieHeader,
} from './ncm-cookie.service';
import { forwardCloudUpload, forwardNcmRequest } from './ncm-forward.service';
import { handleNcmSongQuality, handleNcmStream } from './ncm-stream.handlers';

/** 创建 /api/music 路由。 */
export function createMusicRouter(): Router {
  const router = Router();

  router.use(optionalAuthenticate);

  router.use('/ncm', forwardNcmRequest);

  // ==================== 网易云 Cookie 登录 / 复制 ====================

  /**
   * GET /api/music/ncm-cookie - 返回当前用户持久化的网易云 Cookie。
   *
   * 用途：个人中心「复制 Cookie」——把登录态迁移到其他设备或备份。
   * 返回 toCookieHeader 格式（"MUSIC_U=xxx; __csrf=yyy"）。
   */
  router.get(
    '/ncm-cookie',
    async (req: AuthenticatedRequest, res: Response) => {
      const userId = req.user?.userId ?? 0;
      if (userId <= 0) {
        res.status(401).json({
          success: false,
          message: '请先登录 ZViewer 账号（游客不持有凭证）',
        });
        return;
      }
      const cred = await loadCredential(userId);
      res.json({ success: true, cookie: cred ? toCookieHeader(cred.cookies) : '' });
    },
  );

  /**
   * POST /api/music/ncm-cookie-login - Cookie 登录网易云。
   *
   * body: { cookie: string }——支持两种输入：
   * - 请求头格式："MUSIC_U=xxx; __csrf=yyy; ..."
   * - Set-Cookie JSON 数组：'["MUSIC_U=xxx; ...", "__csrf=yyy"]'
   *
   * 必须包含 MUSIC_U（网易云登录态关键 cookie）。解析后与既有 cookie
   * 合并持久化，并调用内部 NCM /nuser/account/get 校验登录态有效性、
   * 同步昵称/头像缓存；MUSIC_U 过期或错误时返回 400。
   */
  router.post(
    '/ncm-cookie-login',
    async (req: AuthenticatedRequest, res: Response) => {
      const userId = req.user?.userId ?? 0;
      if (userId <= 0) {
        res.status(401).json({
          success: false,
          message: '请先登录 ZViewer 账号（游客不持有凭证）',
        });
        return;
      }
      const raw = String(req.body?.cookie ?? '').trim();
      if (!raw) {
        res.status(400).json({ success: false, message: '请输入 Cookie' });
        return;
      }

      let incoming: string[] = [];
      if (raw.startsWith('[')) {
        try {
          const arr = JSON.parse(raw) as unknown;
          if (Array.isArray(arr)) {
            incoming = arr.filter(
              (c): c is string => typeof c === 'string' && c.includes('='),
            );
          }
        } catch {
          /* 非 JSON 数组按空处理，走下方 MUSIC_U 校验报错 */
        }
      } else {
        incoming = raw
          .split(';')
          .map((s) => s.trim())
          .filter((s) => s.includes('='));
      }

      if (!incoming.some((c) => c.toLowerCase().startsWith('music_u='))) {
        res.status(400).json({
          success: false,
          message: 'Cookie 中缺少 MUSIC_U（请从已登录网易云音乐的浏览器复制）',
        });
        return;
      }

      try {
        const cred = await loadCredential(userId);
        const existing = cred ? parseStoredCookies(cred.cookies) : [];
        let merged = mergeCookies(existing, incoming);

        // 用新 cookie 校验登录态并拉取账号资料（昵称/头像缓存同步）
        const result = await callNcmApi(
          '/nuser/account/get',
          toCookieHeader(JSON.stringify(merged)),
        );
        if (result.setCookies.length > 0) {
          merged = mergeCookies(merged, result.setCookies);
        }
        const profile = extractProfile(result.body);
        if (!profile) {
          res.status(400).json({
            success: false,
            message: 'Cookie 无效或已过期（未能取到网易云账号资料）',
          });
          return;
        }

        await persistCookies(userId, merged, result.body);
        res.json({
          success: true,
          profile: { nickname: profile.nickname, avatarUrl: profile.avatarUrl },
        });
      } catch (err) {
        console.error('[music] ncm cookie-login error:', err);
        res.status(500).json({ success: false, message: 'Cookie 登录失败' });
      }
    },
  );

  // ==================== 云盘上传 ====================

  router.post('/cloud/upload', forwardCloudUpload);

  // ==================== 专辑全量歌曲 ====================

  /**
   * GET /api/music/album/full?id= - 专辑详情（含全量歌曲补齐）。
   * 补齐逻辑见 ncm-account.service 的 getAlbumWithFullSongs。
   */
  router.get(
    '/album/full',
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const id = Number(req.query.id);
      if (!Number.isFinite(id) || id <= 0) {
        res
          .status(400)
          .json({ code: 'BAD_REQUEST', message: '缺少有效的专辑 id' });
        return;
      }
      if (!getNcmApiBase()) {
        res
          .status(503)
          .json({ code: 'NCM_UNAVAILABLE', message: 'NCM 服务未启动' });
        return;
      }
      try {
        const credential = await loadCredential(req.user?.userId);
        const cookieHeader = credential
          ? toCookieHeader(credential.cookies)
          : '';
        const body = await getAlbumWithFullSongs(id, cookieHeader);
        if (!body) {
          res.status(502).json({
            code: 'UPSTREAM_ERROR',
            message: 'NCM 服务返回了无法解析的响应',
          });
          return;
        }
        res.status(200).json(body);
      } catch (err) {
        console.error('[music] 专辑详情获取失败:', err);
        res
          .status(502)
          .json({ code: 'UPSTREAM_ERROR', message: '专辑详情获取失败' });
      }
    },
  );

  // ==================== 登录状态 / 退出 ====================

  /** GET /api/music/login/status - 查询当前用户的网易云登录状态 */
  router.get(
    '/login/status',
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        res.json(await getNcmLoginStatus(req.user?.userId));
      } catch (err) {
        console.error('[music] login/status error:', err);
        res
          .status(500)
          .json({ code: 'INTERNAL_ERROR', message: '查询登录状态失败' });
      }
    },
  );

  /** POST /api/music/logout - 删除当前用户持久化的网易云凭证 */
  router.post(
    '/logout',
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        const userId = req.user?.userId ?? 0;
        if (userId > 0) {
          await AppDataSource.getRepository(NcmCredential).delete({ userId });
        }
        res.json({ success: true });
      } catch (err) {
        console.error('[music] logout error:', err);
        res
          .status(500)
          .json({ code: 'INTERNAL_ERROR', message: '退出登录失败' });
      }
    },
  );

  // ==================== 音频流代理 / 音质元数据 ====================

  router.get('/stream', handleNcmStream);
  router.get('/song-quality', handleNcmSongQuality);

  return router;
}
