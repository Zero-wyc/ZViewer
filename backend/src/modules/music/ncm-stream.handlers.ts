/**
 * 网易云音频流端点处理器。
 *
 * - GET /api/music/stream       音频流代理（解析直链 → Range 转发 / 直链模式 302）
 * - GET /api/music/song-quality 当前歌曲实际解析音质元数据
 *
 * 两者共用同一套凭证回退链与音质降级链（见 ncm-stream.service.ts）。
 */
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../../middleware/auth';
import { callNcmApi } from './ncm-api-client';
import { getNcmApiBase } from './ncm-api.service';
import {
  resolveNcmCredentialForRequest,
  toCookieHeader,
} from './ncm-cookie.service';
import {
  directUrlCache,
  isNcmAudioHost,
  proxyAudioStream,
  qualityMetaCache,
  resolveFlacSampleRate,
  resolveQualityLevels,
  resolveSongUrlAlongChain,
  type SongQualityMeta,
} from './ncm-stream.service';

/**
 * GET /api/music/stream?songId=&level=&roomId= - 音频流代理。
 *
 * 1. 凭证回退链（spec「房主登录后全房间可播 VIP」）：
 *    当前用户有 NcmCredential 用之；否则请求带 roomId 时查 Room 表
 *    ownerUserId，房主有凭证则借用其凭证解析。stream 请求来自 <audio>
 *    标签无法携带 Authorization 头，token 从 query 读取（optionalAuth），
 *    观众未登录/无凭证时经 roomId 仍可播 VIP 曲目。
 * 2. 以解析到的 cookie（或匿名）调内部服务 /song/url/v1 解析直链，
 *    url 为 null 时沿降级链 lossless→exhigh→higher→standard 依次重试
 *    （从请求 level 开始；带 freeTrialInfo 的试听直链视为不可用）
 * 3. 全链失败时错误分类：freeTrialInfo → VIP_REQUIRED；
 *    /check/music 判定无版权 → NO_COPYRIGHT；其余 → RESOLVE_FAILED
 * 4. 直链 hostname 必须匹配 *.music.126.net（防 SSRF），否则 RESOLVE_FAILED
 * 5. 流式转发（Range/206 透传）
 */
export async function handleNcmStream(
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> {
  const songId = Number(req.query.songId);
  if (!Number.isInteger(songId) || songId <= 0) {
    res
      .status(400)
      .json({ code: 'INVALID_PARAMS', message: 'songId 参数无效' });
    return;
  }

  const base = getNcmApiBase();
  if (!base) {
    res
      .status(503)
      .json({ code: 'NCM_UNAVAILABLE', message: 'NCM 服务未启动' });
    return;
  }

  try {
    // 请求音质（默认 exhigh）；未知名质从降级链头部开始
    const requestedLevel =
      typeof req.query.level === 'string' && req.query.level
        ? req.query.level
        : 'exhigh';
    const levels = resolveQualityLevels(requestedLevel);

    const roomId =
      typeof req.query.roomId === 'string' ? req.query.roomId : '';
    const credential = await resolveNcmCredentialForRequest(
      req.user?.userId,
      roomId,
    );
    const cookieHeader = credential ? toCookieHeader(credential.cookies) : '';

    // 直链模式（direct=1）：设置开关开启时 <audio> 直连网易云 CDN，
    // 服务器仅承担「解析直链」的轻量请求，不再转发音频流。
    const directMode = req.query.direct === '1';

    // 凭证回退链：当前用户凭证 → 房主凭证（请求带 roomId 时）。
    // 实现 spec「房主登录网易云后全房间可播 VIP」：观众自己未登录/
    // 无凭证时，借用房主的持久化凭证解析直链。
    const directCredKey = String(credential?.userId ?? req.user?.userId ?? 0);
    if (directMode) {
      // 先查缓存（key 含凭证归属：VIP 直链只发给经同一凭证链解析的请求）
      const cached = directUrlCache.get(
        `${directCredKey}:${requestedLevel}:${songId}`,
      );
      if (cached) {
        res.json({
          success: true,
          url: cached,
          level: requestedLevel,
          cached: true,
        });
        return;
      }
    }

    // 沿降级链解析直链；记录最后一次响应的 data 供错误分类
    const { resolved, lastData } = await resolveSongUrlAlongChain(
      songId,
      levels,
      cookieHeader,
    );

    if (!resolved) {
      // 错误分类：试听标记 → VIP；无版权 → NO_COPYRIGHT；其余 → 解析失败
      if (lastData && lastData.freeTrialInfo != null) {
        res.status(403).json({
          code: 'VIP_REQUIRED',
          message: '需要登录网易云 VIP 账号',
        });
        return;
      }
      const check = await callNcmApi(`/check/music?id=${songId}`, cookieHeader);
      const checkBody =
        check.body && typeof check.body === 'object'
          ? (check.body as Record<string, unknown>)
          : null;
      if (checkBody && checkBody.success === false) {
        res
          .status(404)
          .json({ code: 'NO_COPYRIGHT', message: '该歌曲暂无版权' });
        return;
      }
      res.status(502).json({
        code: 'RESOLVE_FAILED',
        message: '歌曲播放地址解析失败',
      });
      return;
    }

    // 直链域名校验（防 SSRF）：仅允许 *.music.126.net
    const audioUrl = resolved.url as string;
    let parsed: URL;
    try {
      parsed = new URL(audioUrl);
    } catch {
      res.status(502).json({
        code: 'RESOLVE_FAILED',
        message: '歌曲播放地址解析失败',
      });
      return;
    }
    if (!isNcmAudioHost(parsed.hostname)) {
      console.warn(`[music] 拒绝非网易云域名的音频直链: ${parsed.hostname}`);
      res.status(502).json({
        code: 'RESOLVE_FAILED',
        message: '歌曲播放地址解析失败',
      });
      return;
    }

    // 直链模式：返回解析到的 CDN 直链（<audio> 直连）；同时落缓存。
    // http 直链在 https 页面下会被 mixed content 拦截，统一改写为
    // https 后再返回与缓存（网易云 CDN 对 https 请求同样有效）
    if (directMode) {
      const safeUrl = audioUrl.replace(/^http:\/\//i, 'https://');
      // 实际解析档位可能与请求档位不同（降级链），按实际档位缓存
      const resolvedLevel =
        typeof resolved.level === 'string' ? resolved.level : requestedLevel;
      directUrlCache.set(
        `${directCredKey}:${resolvedLevel}:${songId}`,
        safeUrl,
      );
      // 以 302 重定向把 CDN 直链交给 <audio> 直连（媒体元素自动跟随，
      // Range/206 请求头原样带到 CDN）；直链过期/失效时客户端
      // error 回退到 direct=0 的代理流
      res.redirect(302, safeUrl);
      return;
    }

    await proxyAudioStream(req, res, audioUrl);
  } catch (err) {
    console.error('[music] stream error:', err);
    if (!res.headersSent) {
      res
        .status(502)
        .json({ code: 'UPSTREAM_ERROR', message: '音频流代理失败' });
    }
  }
}

/**
 * GET /api/music/song-quality：当前歌曲实际解析音质元数据。
 *
 * 复用 /stream 的解析链（凭证回退 + QUALITY_CHAIN 降级），
 * 返回 /song/url/v1 data[0] 透传的 sr（采样率 Hz）/br（比特率 bps）/
 * type（文件格式）/level（实际生效档位）。全部结果缓存 15 分钟。
 * 响应：{ success, songId, level, sr, br, type }
 */
export async function handleNcmSongQuality(
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> {
  const songId = Number(req.query.songId);
  if (!Number.isInteger(songId) || songId <= 0) {
    res
      .status(400)
      .json({ code: 'INVALID_PARAMS', message: 'songId 参数无效' });
    return;
  }
  const base = getNcmApiBase();
  if (!base) {
    res
      .status(503)
      .json({ code: 'NCM_UNAVAILABLE', message: 'NCM 服务未启动' });
    return;
  }
  try {
    const requestedLevel =
      typeof req.query.level === 'string' && req.query.level
        ? req.query.level
        : 'exhigh';
    const levels = resolveQualityLevels(requestedLevel);

    // 凭证回退链与 /stream 一致：当前用户 → 房主（请求带 roomId 时）
    const roomId =
      typeof req.query.roomId === 'string' ? req.query.roomId : '';
    const credential = await resolveNcmCredentialForRequest(
      req.user?.userId,
      roomId,
    );
    const cookieHeader = credential ? toCookieHeader(credential.cookies) : '';
    const credKey = String(credential?.userId ?? req.user?.userId ?? 0);

    const cacheKey = `${credKey}:${requestedLevel}:${songId}`;
    const cached = qualityMetaCache.get(cacheKey);
    if (cached) {
      res.json({ success: true, songId, cached: true, ...cached });
      return;
    }

    // 与 /stream 共用的降级链解析（仅取元数据，不获取音频）
    const { resolved, lastData } = await resolveSongUrlAlongChain(
      songId,
      levels,
      cookieHeader,
    );
    if (!resolved) {
      if (lastData && lastData.freeTrialInfo != null) {
        res
          .status(403)
          .json({ code: 'VIP_REQUIRED', message: '需要登录网易云 VIP 账号' });
        return;
      }
      res
        .status(502)
        .json({ code: 'RESOLVE_FAILED', message: '音质信息解析失败' });
      return;
    }

    const readPositiveInt = (obj: Record<string, unknown>, key: string) => {
      const v = obj[key];
      return typeof v === 'number' && Number.isFinite(v) && v > 0
        ? Math.round(v)
        : 0;
    };
    const type = typeof resolved.type === 'string' ? resolved.type : '';
    const levelStr =
      typeof resolved.level === 'string' ? resolved.level : requestedLevel;
    let sr = readPositiveInt(resolved, 'sr');
    const br = readPositiveInt(resolved, 'br');
    // 上游缺 sr 时对 flac 走 STREAMINFO 探测兜底
    if (sr === 0 && type.toLowerCase() === 'flac') {
      sr = await resolveFlacSampleRate((resolved as { url: string }).url);
    }
    const meta: SongQualityMeta = {
      sr,
      br,
      type,
      level: levelStr,
    };
    qualityMetaCache.set(cacheKey, meta);
    res.json({ success: true, songId, ...meta });
  } catch (err) {
    console.error('[music] song-quality error:', err);
    if (!res.headersSent) {
      res
        .status(502)
        .json({ code: 'UPSTREAM_ERROR', message: '音质信息获取失败' });
    }
  }
}
