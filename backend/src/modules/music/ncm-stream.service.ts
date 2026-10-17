/**
 * 网易云音频流解析与转发服务。
 *
 * 职责：
 * - 音质降级链（lossless → exhigh → higher → standard）解析歌曲直链；
 * - 直链缓存（直链模式）与音质元数据缓存；
 * - 直链域名白名单校验（防 SSRF）；
 * - 音频流 Range 转发（含客户端断连时中断上游）；
 * - FLAC STREAMINFO 采样率兜底探测。
 *
 * 路由层只负责参数校验与响应拼装。
 */
import type { Response } from 'express';
import { Readable } from 'node:stream';
import type { AuthenticatedRequest } from '../../middleware/auth';
import { DEFAULT_PROXY_UA } from '../../services/proxy/http-proxy';
import { TtlCache } from '../../utils/ttl-cache';
import { callNcmApi } from './ncm-api-client';

// ==================== 音质降级链 ====================

/**
 * 音质降级链（从高到低）：请求音质起依次降级直至解析出可用直链。
 * 与 spec 一致：后端默认 exhigh，VIP 可播时向上尝试 lossless。
 */
const QUALITY_CHAIN = ['lossless', 'exhigh', 'higher', 'standard'] as const;

/** 按请求档位取降级链切片（未知名质从链头开始） */
export function resolveQualityLevels(requestedLevel: string): string[] {
  const chainStart = (QUALITY_CHAIN as readonly string[]).indexOf(
    requestedLevel,
  );
  return (QUALITY_CHAIN as readonly string[]).slice(
    chainStart >= 0 ? chainStart : 0,
  );
}

/** 提取 /song/url/v1 响应中 data[0]（失败返回 null） */
function extractSongUrlData(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== 'object') return null;
  const data = (body as Record<string, unknown>).data;
  if (!Array.isArray(data) || data.length === 0) return null;
  const first = data[0];
  return first && typeof first === 'object'
    ? (first as Record<string, unknown>)
    : null;
}

/** /song/url/v1 不可用时回退老接口 /song/url 的音质映射（br 参数制） */
const LEVEL_TO_BR: Record<string, number> = {
  lossless: 999000,
  exhigh: 320000,
  higher: 192000,
  standard: 128000,
};

/**
 * 老接口 /song/url 回退：与 /song/url/v1 同源（/api/song/enhance/player/url），
 * 以 br 代替 level 区分音质（br=999000 表示取账号可用最高音质）。
 *
 * 场景：内部 NCM 服务依赖残缺时，song_url_v1 模块顶层 require
 * (@neteasecloudmusicapienhanced/unblockmusic-utils) 会抛 MODULE_NOT_FOUND，
 * 路由返回 {code:404,msg:'Not Found'}（依赖完整时该包随 dependencies 安装）；
 * 而 song_url 模块无此依赖、始终可用，作解析兜底。响应无 level 字段，按
 * 请求档位补写，使调用方的降级链/缓存逻辑与 v1 响应同构。
 */
async function resolveSongUrlLegacy(
  songId: number,
  level: string,
  cookieHeader: string,
): Promise<Record<string, unknown> | null> {
  try {
    const br = LEVEL_TO_BR[level] ?? 320000;
    const result = await callNcmApi(
      `/song/url?id=${songId}&br=${br}`,
      cookieHeader,
    );
    const data = extractSongUrlData(result.body);
    return data ? { level, ...data } : null;
  } catch {
    return null;
  }
}

/**
 * 沿降级链解析歌曲直链数据（/stream 与 /song-quality 共用）。
 * v1 路由失败（依赖残缺 404 / 网络抛错）时回退老接口 /song/url；
 * freeTrialInfo 非空（试听片段）与不可用同等对待，继续降级。
 */
export async function resolveSongUrlAlongChain(
  songId: number,
  levels: string[],
  cookieHeader: string,
): Promise<{
  resolved: Record<string, unknown> | null;
  lastData: Record<string, unknown> | null;
}> {
  let resolved: Record<string, unknown> | null = null;
  let lastData: Record<string, unknown> | null = null;
  for (const level of levels) {
    const result = await callNcmApi(
      `/song/url/v1?id=${songId}&level=${level}`,
      cookieHeader,
    ).catch(() => null);
    let data = result ? extractSongUrlData(result.body) : null;
    if (!data) {
      data = await resolveSongUrlLegacy(songId, level, cookieHeader);
    }
    if (!data) continue;
    lastData = data;
    const url = data.url;
    if (typeof url === 'string' && url && data.freeTrialInfo == null) {
      resolved = data;
      break;
    }
  }
  return { resolved, lastData };
}

// ==================== 直链 / 音质元数据缓存 ====================

/**
 * 直链模式解析结果缓存（songId+level+凭证归属 → CDN 直链）。
 * 直链模式（/stream?direct=1）下把解析到的 CDN 直链以 JSON 返回给客户端，
 * 由 <audio> 直连网易云 CDN，服务器不承担音频流量；多条观众的同一首歌
 * 共享同一份解析结果（解析接口自身有频控）。直链签名有效期约 20-30 分钟，
 * 按 15 分钟 TTL 过期后重新解析；客户端加载失败时自动回退代理流。
 */
const DIRECT_URL_TTL_MS = 15 * 60 * 1000;
const DIRECT_URL_CACHE_MAX = 500;
export const directUrlCache = new TtlCache<string>({
  ttlMs: DIRECT_URL_TTL_MS,
  maxSize: DIRECT_URL_CACHE_MAX,
});

/** 歌曲音质元数据缓存（song-quality 端点）：上游 sr/br/type/level，
 *  sr 缺失时对 flac 兜底探测（见 resolveFlacSampleRate），TTL 与直链一致 */
const QUALITY_META_TTL_MS = 15 * 60 * 1000;
const QUALITY_META_CACHE_MAX = 500;
export interface SongQualityMeta {
  sr: number;
  br: number;
  type: string;
  level: string;
}
export const qualityMetaCache = new TtlCache<SongQualityMeta>({
  ttlMs: QUALITY_META_TTL_MS,
  maxSize: QUALITY_META_CACHE_MAX,
});

/**
 * FLAC SAMPLE_RATE 兜底探测：NCM 上游 /song/url/v1 的 data[0] 未必带 sr
 * 字段，对 flac 解析首部 STREAMINFO 块（采样率 20 bit）读取真实采样率。
 * 仅请求 CDN 首部 64KB（Range），失败静默返回 0。
 */
export async function resolveFlacSampleRate(audioUrl: string): Promise<number> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(audioUrl.replace(/^http:\/\//i, 'https://'), {
      headers: { Range: 'bytes=0-65535', 'User-Agent': DEFAULT_PROXY_UA },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const buf = Buffer.from(await res.arrayBuffer());
    // 行头：'fLaC'(4B) + 块头(4B，块类型 0=STREAMINFO) + 数据
    if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'fLaC') return 0;
    if ((buf[4] & 0x7f) !== 0) return 0;
    // STREAMINFO 数据相对数据起始：前 10 字节为块/帧尺寸字段，
    // 第 10-12 字节为 20-bit 采样率（大端）
    const off = 8 + 10;
    const sr = (buf[off] << 12) | (buf[off + 1] << 4) | (buf[off + 2] >> 4);
    return Number.isFinite(sr) && sr > 0 ? sr : 0;
  } catch {
    return 0;
  }
}

// ==================== 域名校验 ====================

/** 网易云音频 CDN 域名白名单（防 SSRF：直链必须位于 *.music.126.net） */
export function isNcmAudioHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'music.126.net' || host.endsWith('.music.126.net');
}

// ==================== 音频流转发 ====================

/** 音频流转发缓冲区大小（与 serverFiles 的 STREAM_HIGH_WATER_MARK 一致） */
const AUDIO_STREAM_HIGH_WATER_MARK = 1024 * 1024;

/**
 * 流式转发音频：透传 Range 请求头，返回 206/200，
 * 透传 Content-Range / Content-Length / Content-Type / Accept-Ranges。
 * 参考services/proxy/http-proxy.ts 的管道转发模式（此处为上游 HTTP 流）。
 */
export async function proxyAudioStream(
  req: AuthenticatedRequest,
  res: Response,
  audioUrl: string,
): Promise<void> {
  // 客户端断连时中断上游请求，避免无效带宽消耗
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) controller.abort();
  });

  // Range 头归一：极端场景下 req.headers.range 可能是 string[]（重复头）
  const rangeValue = Array.isArray(req.headers.range)
    ? req.headers.range[0]
    : req.headers.range;

  // fetch 的响应类型（express 的 Response 与全局 Response 同名，此处用推断类型消歧）
  let upstream: Awaited<ReturnType<typeof fetch>>;
  try {
    upstream = await fetch(audioUrl, {
      headers: {
        'User-Agent': DEFAULT_PROXY_UA,
        Accept: '*/*',
        ...(rangeValue ? { Range: rangeValue } : {}),
      },
      signal: controller.signal,
    });
  } catch (err) {
    const isAbort = err instanceof Error && err.name === 'AbortError';
    if (isAbort && res.writableEnded) return;
    console.error('[music] 音频流上游请求失败:', err);
    if (!res.headersSent) {
      res
        .status(502)
        .json({ code: 'UPSTREAM_ERROR', message: '音频源请求失败' });
    } else {
      res.end();
    }
    return;
  }

  // 上游非 2xx：透传状态码（如 416 的 Content-Range 语义）
  if (!upstream.ok) {
    res.status(upstream.status);
    for (const name of [
      'content-range',
      'accept-ranges',
      'content-length',
    ] as const) {
      const value = upstream.headers.get(name);
      if (value) res.setHeader(name, value);
    }
    res.end();
    return;
  }

  // 转发上游状态码：Range 请求上游返回 206 时必须转发 206
  res.status(upstream.status);
  res.setHeader(
    'Content-Type',
    upstream.headers.get('content-type') || 'audio/mpeg',
  );
  for (const name of [
    'content-length',
    'content-range',
    'accept-ranges',
    'etag',
    'last-modified',
  ] as const) {
    const value = upstream.headers.get(name);
    if (value) res.setHeader(name, value);
  }
  // 确保浏览器知道支持 Range 请求（否则会整文件下载而非流式播放）
  if (!res.getHeader('accept-ranges')) {
    res.setHeader('Accept-Ranges', 'bytes');
  }
  // 提示反向代理不要缓冲整个响应体
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Cache-Control', 'no-transform');

  if (!upstream.body) {
    res.end();
    return;
  }

  const stream = Readable.fromWeb(
    upstream.body as unknown as import('node:stream/web').ReadableStream,
    { highWaterMark: AUDIO_STREAM_HIGH_WATER_MARK },
  );
  stream.on('error', (err: Error) => {
    console.error('[music] 音频流上游中断:', err);
    if (!res.headersSent) {
      res
        .status(502)
        .json({ code: 'UPSTREAM_ERROR', message: '音频流转发中断' });
    } else {
      res.destroy();
    }
  });
  // 客户端断连（下线/切歌/关闭页面）时销毁上游流：Node 的 pipe 在目标关闭时
  // 只 unpipe、不会销毁源流，仅 abort fetch 会留下「用户已下线、上游仍在被
  // 读取」的窗口——显式 destroy 才能真正停止流量
  res.on('close', () => {
    if (!res.writableFinished && !stream.destroyed) stream.destroy();
  });
  res.on('error', () => {
    if (!stream.destroyed) stream.destroy();
  });
  stream.pipe(res);
}
