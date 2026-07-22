import {
  DanmakuSourceProvider,
  DanmakuSearchResult,
  DanmakuEpisode,
  DanmakuItem,
  DanmakuProviderContext,
} from '../types';
import crypto from 'node:crypto';

const API_BASE = 'https://api.dandanplay.net';
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.0 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** fetch 请求统一超时时间（毫秒）。 */
const FETCH_TIMEOUT_MS = 10_000;

/** 统一弹幕 mode：0=滚动, 1=顶部, 2=底部。 */
const UNIFIED_MODE_SCROLL = 0;
const UNIFIED_MODE_TOP = 1;
const UNIFIED_MODE_BOTTOM = 2;

/**
 * 弹弹play 开放平台凭证。
 * 2026-06-25 起配额管理机制正式上线，所有接口均需签名认证。
 * 凭证通过 DevCenter（https://devcenter.dandanplay.net）申请。
 * 未配置时 provider 将在调用时抛出明确错误，引导用户补齐配置。
 */
const DANDANPLAY_APP_ID = process.env.DANDANPLAY_APP_ID || '';
const DANDANPLAY_APP_SECRET = process.env.DANDANPLAY_APP_SECRET || '';

interface DandanplaySearchResult {
  animeId: number;
  animeTitle: string;
  imageUrl?: string;
  type?: string;
  typeDescription?: string;
  episodes?: number;
  started?: string;
}

interface DandanplayEpisode {
  episodeId: number;
  episodeTitle: string;
  episodeNumber?: number | string;
}

interface DandanplayBangumiDetail {
  animeId?: number;
  animeTitle?: string;
  imageUrl?: string;
  episodes?: DandanplayEpisode[];
}

interface DandanplayComment {
  cid?: number | string;
  p?: string;
  m?: string;
}

/**
 * 创建一个带超时的 AbortController，超时后会自动 abort。
 * 返回 signal 与清理函数，调用方需在请求结束后调用 clear 清理定时器。
 */
function createTimeoutSignal(timeoutMs: number = FETCH_TIMEOUT_MS): {
  signal: AbortSignal;
  clear: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
  };
}

/** 将可能是网络错误/超时的异常转换为带语义的错误消息。 */
function wrapNetworkError(stage: string, url: string, err: unknown): Error {
  if (err instanceof Error) {
    if (err.name === 'AbortError') {
      return new Error(`弹弹play${stage}超时（${FETCH_TIMEOUT_MS / 1000}s）：${url}`);
    }
    return new Error(`弹弹play${stage}网络错误：${err.message}`);
  }
  return new Error(`弹弹play${stage}发生未知错误`);
}

/**
 * 计算弹弹play 签名验证模式的签名。
 * 算法：base64(sha256(AppId + Timestamp + Path + AppSecret))
 * - Path 为请求路径（含 /api/v2 前缀，不含 query string），区分大小写
 * - Timestamp 为秒级 Unix 时间戳字符串
 * 参考：https://doc.dandanplay.com/open/#_5-签名验证模式指南
 */
function buildSignature(
  appId: string,
  appSecret: string,
  timestamp: string,
  path: string
): string {
  const raw = `${appId}${timestamp}${path}${appSecret}`;
  return crypto.createHash('sha256').update(raw, 'utf8').digest('base64');
}

/** 校验是否已配置弹弹play 开放平台凭证。 */
function assertCredentialsConfigured(stage: string): void {
  if (!DANDANPLAY_APP_ID || !DANDANPLAY_APP_SECRET) {
    throw new Error(
      `弹弹play${stage}失败：未配置开放平台凭证。` +
        '请在弹弹play DevCenter (https://devcenter.dandanplay.net) 申请 AppId 和 AppSecret，' +
        '并通过环境变量 DANDANPLAY_APP_ID / DANDANPLAY_APP_SECRET 配置。'
    );
  }
}

/** 统一的 GET 请求封装，带超时、签名认证与错误归一化。 */
async function dandanFetch<T>(
  path: string,
  params?: Record<string, string>
): Promise<T> {
  assertCredentialsConfigured('请求');

  const query = params
    ? `?${new URLSearchParams(params).toString()}`
    : '';
  const url = `${API_BASE}${path}${query}`;
  // 签名中的 Path 仅含路径部分，不含 query string
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = buildSignature(
    DANDANPLAY_APP_ID,
    DANDANPLAY_APP_SECRET,
    timestamp,
    path
  );

  const { signal, clear } = createTimeoutSignal();
  let res: Response;
  try {
    res = await fetch(url, {
      signal,
      headers: {
        'User-Agent': DEFAULT_USER_AGENT,
        Accept: 'application/json',
        'X-AppId': DANDANPLAY_APP_ID,
        'X-Timestamp': timestamp,
        'X-Signature': signature,
      },
    });
  } catch (err) {
    throw wrapNetworkError('请求', url, err);
  } finally {
    clear();
  }

  if (res.status === 401 || res.status === 403) {
    // 凭证错误或权限不足，给出明确提示
    let detail = '';
    try {
      const body = (await res.json()) as { errorMessage?: string; message?: string };
      detail = body?.errorMessage || body?.message || '';
    } catch {
      /* 忽略 body 解析失败 */
    }
    throw new Error(
      `弹弹play 认证失败 [HTTP ${res.status}]：` +
        (detail || '请检查 DANDANPLAY_APP_ID / DANDANPLAY_APP_SECRET 是否正确') +
        `（path=${path}）`
    );
  }

  if (!res.ok) {
    let detail = '';
    try {
      const body = (await res.json()) as { errorMessage?: string; message?: string };
      detail = body?.errorMessage || body?.message || '';
    } catch {
      /* 忽略 */
    }
    throw new Error(
      `弹弹play API 请求失败 [HTTP ${res.status}]${detail ? `：${detail}` : ''}（${url}）`
    );
  }

  try {
    return (await res.json()) as T;
  } catch (err) {
    throw new Error(`弹弹play API 响应解析失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * 解析弹弹play 弹幕的 p 字段（格式：time,mode,size,color,...）。
 * 对缺失或格式错误的字段进行容错处理，保证始终返回有效数值。
 */
function parseCommentParams(p: string | undefined): {
  time: number;
  mode: number;
  size: number;
  color: number;
} {
  // p 字段缺失或非字符串时回退到默认值
  if (typeof p !== 'string' || !p.trim()) {
    return {
      time: 0,
      mode: UNIFIED_MODE_SCROLL,
      size: 25,
      color: 0xffffff,
    };
  }

  const parts = p.split(',');

  // 时间：单位秒（float），解析失败回退为 0
  const timeRaw = parseFloat(parts[0] || '');
  const time = Number.isFinite(timeRaw) ? timeRaw : 0;

  // 弹弹play 原始 mode：0=滚动, 1=底部, 2=顶部, 3=特殊
  const rawMode = parseInt(parts[1] || '', 10);
  const mode = mapDandanplayMode(Number.isFinite(rawMode) ? rawMode : 0);

  // 字号：解析失败回退为 25
  const sizeRaw = parseInt(parts[2] || '', 10);
  const size = Number.isFinite(sizeRaw) && sizeRaw > 0 ? sizeRaw : 25;

  // 颜色：十进制数字，解析失败回退为白色
  const colorRaw = parseInt(parts[3] || '', 10);
  const color = Number.isFinite(colorRaw) ? colorRaw : 0xffffff;

  return { time, mode, size, color };
}

/**
 * 将弹弹play 的 mode 映射到统一格式。
 * 弹弹play：0=滚动, 1=底部, 2=顶部, 3=特殊
 * 统一格式：0=滚动, 1=顶部, 2=底部
 */
function mapDandanplayMode(rawMode: number): number {
  switch (rawMode) {
    case 0: // 滚动
      return UNIFIED_MODE_SCROLL;
    case 1: // 弹弹play 底部 → 统一底部
      return UNIFIED_MODE_BOTTOM;
    case 2: // 弹弹play 顶部 → 统一顶部
      return UNIFIED_MODE_TOP;
    case 3: // 特殊，统一格式中没有对应值，回退为滚动
      return UNIFIED_MODE_SCROLL;
    default:
      return UNIFIED_MODE_SCROLL;
  }
}

export const dandanplayDanmakuProvider: DanmakuSourceProvider = {
  name: '弹弹 play',

  async search(keyword: string, _ctx?: DanmakuProviderContext): Promise<DanmakuSearchResult[]> {
    interface SearchResponse {
      success?: boolean;
      errorMessage?: string;
      animes?: DandanplaySearchResult[];
    }

    const data = await dandanFetch<SearchResponse>('/api/v2/search/anime', {
      keyword,
    });

    if (!data.success) {
      throw new Error(data.errorMessage || '弹弹play 搜索失败');
    }

    const list = Array.isArray(data.animes) ? data.animes : [];
    return list.slice(0, 20).map((item) => ({
      id: String(item.animeId),
      title: item.animeTitle,
      cover: item.imageUrl,
      description: [item.typeDescription, item.started]
        .filter(Boolean)
        .join(' / '),
      source: 'dandanplay',
      extra: { animeId: item.animeId },
    }));
  },

  async getEpisodes(identifier: string, _ctx?: DanmakuProviderContext): Promise<DanmakuEpisode[]> {
    const animeId = Number(identifier.replace(/\D/g, ''));
    if (!Number.isFinite(animeId) || animeId <= 0) {
      throw new Error('无法解析弹弹play animeId');
    }

    interface BangumiResponse {
      success?: boolean;
      errorMessage?: string;
      bangumi?: DandanplayBangumiDetail;
    }

    const data = await dandanFetch<BangumiResponse>(`/api/v2/bangumi/${animeId}`);
    if (!data.success) {
      throw new Error(data.errorMessage || '弹弹play 获取番剧详情失败');
    }

    const episodes = data.bangumi?.episodes || [];
    if (!episodes.length) {
      return [
        {
          id: `${animeId}-1`,
          title: data.bangumi?.animeTitle || '第 1 集',
          episodeNumber: 1,
          playbackParams: { animeId },
        },
      ];
    }

    return episodes.map((ep, idx) => ({
      id: `${animeId}-${ep.episodeId}`,
      title: [data.bangumi?.animeTitle, ep.episodeTitle]
        .filter(Boolean)
        .join(' - '),
      episodeNumber:
        typeof ep.episodeNumber === 'number'
          ? ep.episodeNumber
          : Number(ep.episodeNumber) || idx + 1,
      playbackParams: { animeId, episodeId: ep.episodeId },
    }));
  },

  async getDanmaku(episode: DanmakuEpisode, _ctx?: DanmakuProviderContext): Promise<DanmakuItem[]> {
    const episodeId = episode.playbackParams.episodeId;
    if (typeof episodeId !== 'number' || episodeId <= 0) {
      throw new Error('缺少有效的弹弹play episodeId');
    }

    interface CommentResponse {
      count?: number;
      comments?: DandanplayComment[];
    }

    const data = await dandanFetch<CommentResponse>(
      `/api/v2/comment/${episodeId}`,
      { withRelated: 'false', chConvert: '0' }
    );

    const comments = Array.isArray(data.comments) ? data.comments : [];
    return comments
      .filter((c) => typeof c.m === 'string' && c.m.trim())
      .map((c) => {
        const params = parseCommentParams(c.p);
        return {
          id: String(c.cid ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
          content: c.m as string,
          time: params.time,
          mode: params.mode,
          color: params.color,
          size: params.size,
        };
      });
  },
};
