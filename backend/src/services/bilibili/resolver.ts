/**
 * B站 视频解析独立编排模块。
 *
 * 分离架构核心：
 * - 路由层（stream.ts）只负责 HTTP 参数解析与 NDJSON 输出，不感知解析细节。
 * - 本模块对外暴露 resolveBilibiliVideo，封装完整解析流程：VIP 校验、视频信息、播放地址、清晰度匹配、CDN 选择、MP4 降级。
 * - 信号源层（video/playurl/vip）保持单一职责；本模块负责编排与错误归一。
 *
 * 效率优化：
 * - VIP 校验与视频信息获取并行（无依赖），节省 1 个 RTT。
 * - 视频信息短期缓存，重复解析同一 BV 号时跳过 nav/view 调用。
 * - CDN 健康检查使用 race 模式，先返回的可达 URL 立即采用。
 */

import { getVideoInfo, type BilibiliVideoInfo } from './video';
import {
  getPlayUrl,
  NoPermissionError,
  type BilibiliPlayUrlResult,
} from './playurl';
import {
  getVipStatus,
  filterQualitiesByVip,
  computeFnval,
  getDefaultQn,
  VIP_ONLY_QNS,
  QN_QUALITY_MAP,
} from './permission';
import { findReachableMediaUrl, upgradeBilibiliUrlToHttps } from './cdn';
import {
  getCachedVideoInfo,
  setCachedVideoInfo,
} from './cache';

export interface ResolveProgress {
  status: 'parsing' | 'done' | 'error';
  step?: string;
  message?: string;
}

/**
 * B站 MP4 直链（fnval=1 + platform=html5 + high_quality=1）实际最高清晰度。
 *
 * 实测：B站 对 MP4 格式有硬性限制，无论是否会员，html5 接口最高仅返回 720P(qn=64)。
 * 1080P / 1080P+ / 4K / HDR / 杜比视界 / 8K 仅 DASH 格式支持，MP4 无法获取。
 */
const MP4_MAX_QN = 64; // 720P

/** B站 请求 UA（与 client.ts / cdn.ts 一致，短链展开请求也使用） */
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * 收窄清晰度列表到 MP4 支持的范围（qn ≤ MP4_MAX_QN）。
 *
 * 收窄后为空时回退到 [480P, 360P] 兜底，保证前端至少有可选项展示。
 */
function narrowAcceptQualityForMp4(
  list: { id: number; label: string; resolution?: string }[],
): { id: number; label: string; resolution?: string }[] {
  const filtered = list.filter((q) => q.id <= MP4_MAX_QN);
  if (filtered.length > 0) return filtered;
  // 兜底：B站 MP4 至少支持 480P/360P
  return [
    { id: 32, label: QN_QUALITY_MAP[32]?.label ?? '480P', resolution: '854x480' },
    { id: 16, label: QN_QUALITY_MAP[16]?.label ?? '360P', resolution: '640x360' },
  ];
}

export interface ResolveOptions {
  /** 原始输入：BV 号 / av 号 / 完整 URL。 */
  url: string;
  /** 当前用户 ID，用于读取 B站 Cookie。 */
  userId?: string;
  /** B站 Cookie（由上层从 credential 取出后传入，避免本模块直接访问 DB）。 */
  cookie?: string;
  /** 指定清晰度 qn。 */
  qn?: number;
  /** 编码偏好：auto / avc / hevc / av1。 */
  codec?: string;
  /** 解析进度回调，用于 NDJSON 流式输出。 */
  onProgress?: (msg: ResolveProgress) => void;
  /**
   * 优先 MP4 单流格式（fnval=1 + platform=html5）。
   * - true：先请求 MP4 直链，浏览器原生 video.src 播放，无需 MSE，seek 流畅
   * - false/undefined：默认 DASH 路径（分离 m4s，需 MSE 双轨合并）
   * MP4 模式最高支持 1080P(qn=80),1080P+/4K/HDR 等高画质仍需 DASH。
   * 失败时自动回退 DASH。
   */
  preferMp4?: boolean;
  /**
   * 指定播放分集（P），从 1 开始。
   * - 未传或 <=0：使用视频默认 cid（第一 P）
   * - 有效值：使用 info.pages[page-1].cid 获取对应分集的播放地址
   * 多 P 视频每个分集有独立的 cid 和 m4s 文件，必须用对应 cid 请求 playurl。
   */
  page?: number;
  /**
   * 直接指定分集 cid（优先级低于 page）。
   * - 当 page 未指定但 cid 已提供时，从 info.pages 中查找匹配的 page
   * - 用于 CLI 代理场景：前端已知目标分集的 cid，直接传入而无需先查 page 序号
   */
  cid?: number;
  /**
   * 跳过 CDN 健康检查（HEAD 探测）。
   * - false/undefined（默认）：播放场景需要选择可达 URL，做 HEAD 探测
   * - true：下载场景直接返回 baseUrl，下载失败时由调用方重试 backupUrl
   *
   * 下载场景无需 HEAD 探测，因为 downloadToFile 本身就是连接验证；
   * 跳过可省去 3.5s 超时等待，显著提升解析速度。
   */
  skipCdnCheck?: boolean;
  /**
   * 强制使用 DASH 格式并禁用 MP4 降级。
   * - 用于 CLI 高画质代理场景：用户明确选择 DASH 后，即使 CDN 不可达
   *   也不应自动降级为 MP4，避免画质/格式与用户预期不符。
   */
  forceDash?: boolean;
}

/** 分集信息（前端用于展示分P列表和切换） */
export interface ResolvePageInfo {
  /** 分集序号，从 1 开始 */
  page: number;
  /** 分集 cid */
  cid: number;
  /** 分集标题（part） */
  part: string;
  /** 分集时长（秒） */
  duration: number;
}

export interface ResolveResult {
  title: string;
  duration: number;
  cid: number;
  videoUrl: string;
  audioUrl?: string;
  videoCodec?: string;
  audioCodec?: string;
  format: 'dash' | 'mp4';
  loggedIn: boolean;
  vipStatus: number;
  currentQn?: number;
  acceptQuality?: { id: number; label: string; resolution?: string }[];
  /**
   * 视频所有分集列表（多 P 视频才有，单 P 视频为单元素数组）。
   * 前端用于在影片列表中显示分P选择器，切换分P时使用对应 cid 重新解析。
   */
  pages?: ResolvePageInfo[];
  /** 当前播放的分集序号（从 1 开始，默认 1） */
  currentPage?: number;
  /**
   * 展开短链后的完整视频地址（非短链输入时与入参 url 一致）。
   * 前端存影片时用它替换原始短链（如 b23.tv/xxx），
   * 下游 BV 号提取 / 分 P 解析 / 弹幕匹配不再依赖短链可达性。
   */
  resolvedUrl: string;
}

export class ResolveError extends Error {
  code: string;
  constructor(message: string, code: string = 'RESOLVE_FAILED') {
    super(message);
    this.name = 'ResolveError';
    this.code = code;
  }
}

/** 从任意输入提取 BV 号或 av 号。 */
export function extractBvid(input: string): string | null {
  const bvMatch = input.match(/BV[0-9A-Za-z]{10}/);
  if (bvMatch) return bvMatch[0];
  const avMatch = input.match(/av(\d+)/i);
  if (avMatch) return avMatch[1];
  return null;
}

/** B站 短链域名（host 精确匹配，小写） */
const BILIBILI_SHORT_LINK_HOSTS = new Set(['b23.tv', 'bili2233.cn']);

/**
 * 展开 B站 短链（如 https://b23.tv/RGkO5sW）为完整视频地址。
 *
 * 短链对分享链接返回 302 重定向到 www.bilibili.com/video/BVxxx?p=N
 * （可能附带分 P 与分享来源参数）。通过跟随重定向读取最终 URL 展开，
 * 使 extractBvid 与分 P 参数解析能继续工作。
 *
 * 展开失败（网络 / 超时 / 非法重定向）时原样返回输入，
 * 由后续解析流程按原始地址报错，不因短链服务抖动放大失败。
 */
export async function expandBilibiliShortLink(input: string): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return input;
  }
  if (!BILIBILI_SHORT_LINK_HOSTS.has(parsed.hostname.toLowerCase())) {
    return input;
  }
  try {
    // GET + redirect: 'follow'：Response.url 即重定向后的最终地址。
    // 取到最终 URL 后立即释放响应体（无需内容，避免下载整页 HTML）。
    const res = await fetch(parsed.toString(), {
      method: 'GET',
      redirect: 'follow',
      headers: { 'user-agent': DEFAULT_USER_AGENT },
      signal: AbortSignal.timeout(8000),
    });
    try {
      await res.body?.cancel();
    } catch {
      /* ignore */
    }
    if (res.url && /^https?:\/\//.test(res.url)) {
      console.log('[bilibili-resolver] 短链已展开:', input, '->', res.url);
      return res.url;
    }
  } catch (err) {
    console.warn('[bilibili-resolver] 短链展开失败，使用原地址继续:', err);
  }
  return input;
}

async function fetchVideoInfo(bvid: string, cookie?: string) {
  const cached = getCachedVideoInfo(bvid);
  if (cached) {
    console.log('[bilibili-resolver] video info served from cache:', bvid);
    return cached;
  }
  let info: import('./video').BilibiliVideoInfo | null = null;
  try {
    info = await getVideoInfo(bvid, cookie);
  } catch (err) {
    // 将 B站 API 业务错误转换为对用户更友好的 ResolveError
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('[-404]')) {
      throw new ResolveError(
        `视频不存在或已被删除（${bvid}），请检查 BV 号是否正确`,
        'VIDEO_NOT_FOUND',
      );
    }
    if (msg.includes('[-101]')) {
      throw new ResolveError(
        'B站账号未登录或登录已过期，请重新扫码登录',
        'NOT_LOGGED_IN',
      );
    }
    if (msg.includes('[-403]') || msg.includes('[-514]')) {
      throw new ResolveError(
        '无权限访问该视频，可能为会员专享或地区限制',
        'NO_PERMISSION',
      );
    }
    // 其他未知错误保留原始消息
    throw new ResolveError(
      `获取视频信息失败: ${msg}`,
      'INFO_FAILED',
    );
  }
  if (!info) {
    throw new ResolveError('获取视频信息失败', 'INFO_FAILED');
  }
  setCachedVideoInfo(bvid, info);
  return info;
}

/**
 * 获取当前播放分集（P）的时长。
 *
 * B站多 P 视频的 data.duration 是所有 P 的总时长，
 * 但实际播放的是某个分集（cid 对应的 m4s 文件），时长只是该分集的时长。
 * 如果用 info.duration 作为播放时长，会导致：
 * - DASH 模式下 MPD mediaPresentationDuration 远超实际文件时长
 * - dash.js 认为 video.duration = 1133s，但 m4s 文件只有 176s
 * - seek 到超出实际文件范围的位置时无法下载对应 segment
 *
 * 因此必须使用与当前播放 cid 对应的分集时长。
 *
 * @param info 视频信息（包含 pages 数组）
 * @param cid 当前播放分集的 cid（可能是 info.cid 或 page 参数指定的 cid）
 */
function getCurrentPageDuration(info: BilibiliVideoInfo, cid?: number): number {
  if (info.pages && info.pages.length > 0) {
    const targetCid = cid ?? info.cid;
    const currentPage = info.pages.find((p) => p.cid === targetCid);
    if (currentPage) {
      return currentPage.duration;
    }
    // 找不到对应 cid 时回退到第一 P 的时长
    return info.pages[0].duration;
  }
  // 单 P 视频直接使用 info.duration
  return info.duration;
}

/**
 * 在 DASH 所有 CDN 均不可达时降级为 MP4 直链。
 *
 * 使用 B站 HTML5 播放器接口（platform=html5）获取无防盗链 MP4 直链，
 * 浏览器可直接播放无需代理（SYNCTV 默认方案，服务器零流量）。
 * 参考：synctv/vendors/vendors/bilibili/movie.go GetVideoURL
 *
 * B站对 MP4 格式的清晰度限制：
 * - 非会员/会员账号请求 MP4(fnval=1) 时,B站服务端统一限制为 720P(qn=64)
 * - 1080P+/4K/HDR 等高画质仅 DASH 格式支持,MP4 无法获取
 * - 这是 B站服务端硬性限制,无法通过参数绕过
 *
 * 返回 MP4 实际使用的 currentQn（B站 可能降级到比请求更低的清晰度），
 * 便于上层收窄 acceptQuality 并准确展示当前清晰度。
 */
async function fallbackToMp4(
  bvid: string,
  cid: number,
  cookie: string | undefined,
  qn: number | undefined,
  isVip: boolean,
  skipCdnCheck: boolean = false,
): Promise<{ videoUrl: string; currentQn?: number; acceptQuality?: { id: number; label: string; resolution?: string }[] } | null> {
  const mp4PlayUrl = await getPlayUrl(bvid, cid, cookie, {
    qn,
    fnval: 1,
    isVip,
    // platform=html5：返回无防盗链 MP4 直链，浏览器可直接播放（SYNCTV 默认方案）
    platform: 'html5',
  });
  if (mp4PlayUrl?.format === 'mp4' && mp4PlayUrl.durl?.[0]?.url) {
    const rawUrl = mp4PlayUrl.durl[0].url;
    const httpsUrl = upgradeBilibiliUrlToHttps(rawUrl);
    // skipCdnCheck=true 时直接使用 baseUrl，避免 HEAD 探测延迟（下载场景）
    if (skipCdnCheck) {
      return {
        videoUrl: httpsUrl,
        currentQn: mp4PlayUrl.currentQn,
        acceptQuality: mp4PlayUrl.acceptQuality,
      };
    }
    const mp4Url = await findReachableMediaUrl({
      baseUrl: rawUrl,
    });
    if (mp4Url) {
      return { videoUrl: mp4Url, currentQn: mp4PlayUrl.currentQn, acceptQuality: mp4PlayUrl.acceptQuality };
    }
    // HEAD 检测全部失败时回退到原始 URL（升级 HTTPS）。
    // 原因：B站 platform=html5 返回的 MP4 直链设计上是无防盗链的，浏览器可直接播放。
    // 某些 B站 CDN 对 HEAD 方法返回 403（但对 GET 请求正常），
    // 此时不应拒绝解析，而应让浏览器直接尝试播放原始 URL。
    // 若 URL 真的不可达，浏览器播放时会显示错误，但这比直接拒绝解析更合理。
    console.warn(
      '[bilibili-mp4] HEAD 检测全部失败，回退到原始 URL:',
      httpsUrl,
    );
    return {
      videoUrl: httpsUrl,
      currentQn: mp4PlayUrl.currentQn,
      acceptQuality: mp4PlayUrl.acceptQuality,
    };
  }
  return null;
}

/**
 * 编排完整解析流程。失败时抛出 ResolveError，调用方负责捕获并转成 NDJSON 错误消息。
 */
export async function resolveBilibiliVideo(
  opts: ResolveOptions,
): Promise<ResolveResult> {
  const { url: rawUrl, cookie, qn, codec, onProgress, preferMp4, page, cid, skipCdnCheck, forceDash } = opts;

  // 短链展开：b23.tv 等分享短链 302 到完整视频地址（可能带 ?p=N 分集参数）
  const url = await expandBilibiliShortLink(rawUrl);

  const bvid = extractBvid(url);
  if (!bvid) {
    throw new ResolveError('无法解析 B站 BV 号', 'INVALID_INPUT');
  }

  // 短链 / 分享链接常带 ?p=N 分集参数：page 未显式指定时作为默认分集
  let urlPage: number | undefined;
  try {
    const p = Number(new URL(url).searchParams.get('p'));
    if (Number.isFinite(p) && p > 0) urlPage = p;
  } catch {
    /* 非法 URL 忽略分集参数 */
  }
  const effectivePage = page ?? urlPage;

  const emit = (step: string, message: string) => {
    onProgress?.({ status: 'parsing', step, message });
  };

  // 并行：VIP 校验（从缓存或 nav 接口）与视频信息获取（view 接口）
  emit('vip', '正在检查大会员状态...');
  const [isVip, info] = await Promise.all([
    getVipStatus(cookie),
    (async () => {
      emit('info', '正在解析视频信息...');
      return fetchVideoInfo(bvid, cookie);
    })(),
  ]);

  // 确定当前播放的分集 cid：
  // - page 参数指定时使用 info.pages[page-1].cid
  // - cid 参数指定时（page 未指定）从 info.pages 中查找匹配的 page
  // - 均未指定时使用 info.cid（视频默认 cid，通常是第一 P）
  // 多 P 视频每个分集有独立的 cid 和 m4s 文件，必须用对应 cid 请求 playurl
  let effectiveCid = info.cid;
  let currentPage = 1;
  if (effectivePage && effectivePage > 0 && info.pages && info.pages.length > 0) {
    const pageIndex = Math.min(effectivePage - 1, info.pages.length - 1);
    const targetPage = info.pages[pageIndex];
    if (targetPage && targetPage.cid) {
      effectiveCid = targetPage.cid;
      currentPage = targetPage.page;
    }
  } else if (cid && info.pages && info.pages.length > 0) {
    // page 未指定但 cid 已提供：从 pages 中查找匹配的分集
    const matchedPage = info.pages.find((p) => p.cid === cid);
    if (matchedPage) {
      effectiveCid = matchedPage.cid;
      currentPage = matchedPage.page;
    }
  } else if (info.pages && info.pages.length > 0) {
    // 未指定 page 和 cid 时，根据 info.cid 找到对应的 page 序号
    const matchedPage = info.pages.find((p) => p.cid === info.cid);
    if (matchedPage) {
      currentPage = matchedPage.page;
    }
  }

  // 构建返回给前端的分集列表（简化字段，只保留前端需要的）
  const pagesInfo: ResolvePageInfo[] | undefined =
    info.pages && info.pages.length > 0
      ? info.pages.map((p) => ({
          page: p.page,
          cid: p.cid,
          part: p.part,
          duration: p.duration,
        }))
      : undefined;

  // 根据会员状态和登录态确定默认清晰度
  // 未登录 B站 时默认 480P（B站对未登录用户限制为 480P 及以下）
  const hasCookie = !!cookie;
  const defaultQn = getDefaultQn(isVip, hasCookie);
  const requestedQn = qn ?? defaultQn;

  // preferMp4 优先路径：直接请求 MP4 单流（fnval=1 + platform=html5），浏览器原生播放无需 MSE
  // MP4 模式最高支持 720P(qn=64)，失败时不再回退 DASH，避免用户明确选择 MP4 后仍被切换到 DASH
  if (preferMp4) {
    emit('cdn', '正在获取 MP4 直链（直连模式）...');
    const mp4 = await fallbackToMp4(
      info.bvid,
      effectiveCid,
      cookie,
      Math.min(requestedQn, MP4_MAX_QN),
      isVip,
      skipCdnCheck,
    );
    if (mp4) {
      // MP4 模式收窄清晰度列表：B站 MP4 直链最高支持 720P(qn=64)，
      // 不应展示 1080P+/4K/HDR 等 DASH 专属选项，避免前端误导用户
      const mp4AcceptQuality = narrowAcceptQualityForMp4(mp4.acceptQuality ?? []);
      return {
        title: info.title,
        duration: getCurrentPageDuration(info, effectiveCid),
        cid: effectiveCid,
        videoUrl: mp4.videoUrl,
        format: 'mp4',
        loggedIn: !!cookie,
        vipStatus: isVip ? 1 : 0,
        currentQn: Math.min(mp4.currentQn ?? MP4_MAX_QN, MP4_MAX_QN),
        acceptQuality: mp4AcceptQuality,
        pages: pagesInfo,
        currentPage,
        resolvedUrl: url,
      };
    }
    throw new ResolveError(
      '该视频不支持 MP4 直链播放，请切换到 DASH 高清模式',
      'MP4_NOT_AVAILABLE',
    );
  }

  // 播放地址（使用 effectiveCid 对应的分集 cid 请求 playurl）
  emit('playurl', '正在获取播放地址...');
  let playUrl: BilibiliPlayUrlResult | null;
  try {
    playUrl = await getPlayUrl(
      info.bvid,
      effectiveCid,
      cookie,
      { qn: requestedQn, codec, isVip },
    );
  } catch (err) {
    // 权限错误：逐级降级重试
    // 未登录时请求 480P 仍可能失败（部分视频限制），降级到 360P
    // 已登录非会员请求 1080P 失败时，降级到 480P
    // 已登录会员请求 4K 失败时，降级到 1080P
    if (err instanceof NoPermissionError) {
      const fallbackQn = requestedQn > 32 ? 32 : 16;
      if (fallbackQn !== requestedQn) {
        emit('playurl', `当前清晰度无权限，降级到 ${fallbackQn === 32 ? '480P' : '360P'}...`);
        playUrl = await getPlayUrl(
          info.bvid,
          effectiveCid,
          cookie,
          { qn: fallbackQn, codec, isVip },
        );
      } else {
        throw err;
      }
    } else {
      throw err;
    }
  }
  if (!playUrl) {
    throw new ResolveError('无法获取播放地址，可能需要登录或大会员', 'NO_PERMISSION');
  }

  // 清晰度匹配：若请求的 qn 不在 acceptQuality 中，回退到首个可用清晰度
  let acceptQuality = filterQualitiesByVip(playUrl.acceptQuality, isVip, hasCookie);
  let effectiveQn = playUrl.currentQn;
  if (effectiveQn && !acceptQuality.some((q) => q.id === effectiveQn)) {
    effectiveQn = acceptQuality[0]?.id ?? playUrl.currentQn;
  }

  if (effectiveQn && effectiveQn !== playUrl.currentQn) {
    emit('quality', '正在匹配可用清晰度...');
    try {
      const refetched = await getPlayUrl(info.bvid, effectiveCid, cookie, {
        qn: effectiveQn,
        codec,
        isVip,
      });
      if (refetched) {
        playUrl = refetched;
        acceptQuality = filterQualitiesByVip(playUrl.acceptQuality, isVip, hasCookie);
      }
    } catch (err) {
      // 权限错误时保持当前清晰度
      if (err instanceof NoPermissionError) {
        console.warn('[bilibili-resolver] 清晰度匹配权限错误，保持当前清晰度:', effectiveQn);
      } else {
        throw err;
      }
    }
  }

  emit('finish', '解析完成，正在加载播放器...');

  // DASH 路径：选择可达视频/音频 URL
  if (playUrl.format === 'dash' && playUrl.bestVideo) {
    emit('cdn', '正在选择可用 CDN...');

    // skipCdnCheck=true 时直接使用 baseUrl，避免 HEAD 探测延迟（下载场景）
    // 下载失败时由调用方重试 backupUrl
    let videoUrl: string | null;
    let audioUrl: string | null = null;
    if (skipCdnCheck) {
      videoUrl = upgradeBilibiliUrlToHttps(playUrl.bestVideo.baseUrl);
      audioUrl = playUrl.bestAudio
        ? upgradeBilibiliUrlToHttps(playUrl.bestAudio.baseUrl)
        : null;
    } else {
      [videoUrl, audioUrl] = await Promise.all([
        findReachableMediaUrl({
          baseUrl: playUrl.bestVideo.baseUrl,
          backupUrl: playUrl.bestVideo.backupUrl,
        }),
        playUrl.bestAudio
          ? findReachableMediaUrl({
              baseUrl: playUrl.bestAudio.baseUrl,
              backupUrl: playUrl.bestAudio.backupUrl,
            })
          : Promise.resolve(null),
      ]);
    }

    if (!videoUrl) {
      if (forceDash) {
        // 强制 DASH 模式：禁用 MP4 降级，直接报错
        throw new ResolveError(
          '当前网络无法访问 B站 媒体服务器，请稍后重试',
          'CDN_UNREACHABLE',
        );
      }
      emit('fallback', 'DASH 地址不可用，尝试 MP4 直链...');
      const mp4 = await fallbackToMp4(
        info.bvid,
        effectiveCid,
        cookie,
        Math.min(effectiveQn ?? requestedQn, MP4_MAX_QN),
        isVip,
        skipCdnCheck,
      );
      if (mp4) {
        // DASH 降级 MP4 时同样收窄清晰度列表
        const mp4AcceptQuality = narrowAcceptQualityForMp4(
          mp4.acceptQuality ?? acceptQuality,
        );
        return {
          title: info.title,
          duration: getCurrentPageDuration(info, effectiveCid),
          cid: effectiveCid,
          videoUrl: mp4.videoUrl,
          format: 'mp4',
          loggedIn: !!cookie,
          vipStatus: isVip ? 1 : 0,
          currentQn: Math.min(mp4.currentQn ?? MP4_MAX_QN, MP4_MAX_QN),
          acceptQuality: mp4AcceptQuality,
          pages: pagesInfo,
          currentPage,
          resolvedUrl: url,
        };
      }
      throw new ResolveError(
        '当前网络无法访问 B站 媒体服务器，请稍后重试',
        'CDN_UNREACHABLE',
      );
    }

    return {
      title: info.title,
      duration: getCurrentPageDuration(info, effectiveCid),
      cid: effectiveCid,
      videoUrl,
      audioUrl: audioUrl ?? undefined,
      videoCodec: playUrl.bestVideo.codecs,
      audioCodec: playUrl.bestAudio?.codecs,
      format: 'dash',
      loggedIn: !!cookie,
      vipStatus: isVip ? 1 : 0,
      currentQn: playUrl.currentQn,
      acceptQuality,
      pages: pagesInfo,
      currentPage,
      resolvedUrl: url,
    };
  }

  // MP4 直链路径（B站 在请求 DASH 时仍返回 MP4 的边缘场景）
  // 强制 DASH 模式下禁用该回退，避免返回 MP4 格式
  if (playUrl.format === 'mp4' && playUrl.durl?.length) {
    if (forceDash) {
      throw new ResolveError(
        '该视频不支持 DASH 高清播放',
        'DASH_NOT_AVAILABLE',
      );
    }
    emit('cdn', '正在选择可用 CDN...');
    // skipCdnCheck=true 时直接使用 baseUrl（下载场景）
    const mp4Url = skipCdnCheck
      ? upgradeBilibiliUrlToHttps(playUrl.durl[0].url)
      : await findReachableMediaUrl({ baseUrl: playUrl.durl[0].url });
    if (!mp4Url) {
      throw new ResolveError(
        '当前网络无法访问 B站 媒体服务器，请稍后重试',
        'CDN_UNREACHABLE',
      );
    }
    // 收窄清晰度列表到 MP4 支持范围
    const mp4AcceptQuality = narrowAcceptQualityForMp4(acceptQuality);
    return {
      title: info.title,
      duration: getCurrentPageDuration(info, effectiveCid),
      cid: effectiveCid,
      videoUrl: mp4Url,
      format: 'mp4',
      loggedIn: !!cookie,
      vipStatus: isVip ? 1 : 0,
      currentQn: playUrl.currentQn,
      acceptQuality: mp4AcceptQuality,
      pages: pagesInfo,
      currentPage,
      resolvedUrl: url,
    };
  }

  throw new ResolveError('未找到可用播放地址', 'NO_PLAYURL');
}

/**
 * 将底层异常归一化为 ResolveError，便于上层统一处理。
 */
export function normalizeResolveError(err: unknown): ResolveError {
  if (err instanceof ResolveError) return err;
  if (err instanceof NoPermissionError) {
    return new ResolveError(err.message, 'NO_PERMISSION');
  }
  const message = err instanceof Error ? err.message : '解析失败';
  return new ResolveError(message, 'RESOLVE_FAILED');
}
